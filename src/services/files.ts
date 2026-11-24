// ============================================================================
// Files — file resolution, ASI normalization, offset mapping, and utilities
//
// Plain language: the file-system helper desk.  It resolves import paths to
// actual files (including `.hm` sidecar type files and package annotations),
// reads and lightly normalises source text, and keeps position bookkeeping
// so locations still line up when text was preprocessed.
// ============================================================================

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { Location } from 'vscode-languageserver/node';
import { InferenceResult } from '../infer';
import { buildAnnotationMap, extractDataDirectives, extractTypeDirectives, extractConstraintDirectives } from '../commentParser';
import { getDataType } from '../registries/dataTypeRegistry';
import { timeSidecarStage } from './sidecarPerf';
import { isFile, isDir, readJsonCached } from './fsProbe';

// ---------------------------------------------------------------------------
// Import specifier resolution
// ---------------------------------------------------------------------------

/** Source extensions used for import resolution; updated from file selection. */
let jsExtensions = ['', '.js', '.mjs', '.cjs', '.jsx'];
let indexExtensions = ['.js', '.mjs', '.cjs', '.jsx'];

/** Keep custom selected source extensions importable (explicit or extensionless).
 *
 *  NOTE: mutates process-global resolution state shared by every engine in
 *  this process. The LSP server and CLI each run in their own process; API
 *  consumers must not run two checkers with different extension sets
 *  concurrently in one process. */
export function configureModuleExtensions(extensions: readonly string[]): void {
  const source = [...new Set(extensions.filter(extension => extension !== '.hm'))];
  jsExtensions = ['', ...source];
  indexExtensions = source;
  MODULE_EXTS.clear();
  for (const extension of extensions) MODULE_EXTS.add(extension);
}

/**
 * Try to resolve a base path to an existing file by appending common
 * extensions and checking for index files.  Returns the resolved path
 * or null.
 */
function resolveWithExtensions(basePath: string): string | null {
  for (const ext of jsExtensions) {
    const candidate = basePath + ext;
    if (isFile(candidate)) return candidate;
  }
  for (const ext of indexExtensions) {
    const candidate = path.join(basePath, 'index' + ext);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Split a bare module specifier into [packageName, subpath].
 *   'lodash'              -> ['lodash', '.']
 *   'lodash/fp'           -> ['lodash', './fp']
 *   '@scope/pkg'          -> ['@scope/pkg', '.']
 *   '@scope/pkg/sub/x'    -> ['@scope/pkg', './sub/x']
 */
function splitBareSpecifier(specifier: string): [string, string] {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts.length < 2) return [specifier, '.'];
    const pkg = parts.slice(0, 2).join('/');
    const sub = parts.length > 2 ? './' + parts.slice(2).join('/') : '.';
    return [pkg, sub];
  }
  const slash = specifier.indexOf('/');
  if (slash === -1) return [specifier, '.'];
  return [specifier.slice(0, slash), './' + specifier.slice(slash + 1)];
}

/**
 * Resolve a value from package.json `exports`/`imports` conditional map.
 * Recursively walks nested condition objects, picking the first key matching
 * one of: `types`, `import`, `require`, `node`, `default`.
 * Returns the relative target string, or null if no condition matches.
 */
function resolveExportsConditions(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = resolveExportsConditions(item);
      if (r) return r;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  const conditionPriority = ['types', 'import', 'require', 'node', 'default'];
  for (const cond of conditionPriority) {
    if (cond in obj) {
      const r = resolveExportsConditions(obj[cond]);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Resolve a subpath against the package.json `exports` field. Supports:
 *   - Direct string mappings: `"./sub": "./lib/sub.js"`
 *   - Conditional mappings: `"./sub": { "import": "...", "require": "..." }`
 *   - Pattern mappings:    `"./*": "./src/*.js"`
 *   - Sugar form:          `"exports": "./index.js"` or `"exports": { "import": ... }`
 *
 * Returns the relative path within the package, or null if no match.
 */
function resolveExportsField(exportsField: unknown, subpath: string): string | null {
  // Sugar: string or condition map at top level => only the '.' subpath
  if (typeof exportsField === 'string') {
    return subpath === '.' ? exportsField : null;
  }
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
    return null;
  }
  const obj = exportsField as Record<string, unknown>;
  // If no key starts with '.', this is a sugar condition map for '.'
  const hasSubpathKeys = Object.keys(obj).some(k => k.startsWith('.'));
  if (!hasSubpathKeys) {
    return subpath === '.' ? resolveExportsConditions(obj) : null;
  }

  // Exact match
  if (subpath in obj) return resolveExportsConditions(obj[subpath]);

  // Pattern match (longest prefix wins)
  let bestMatchKey: string | null = null;
  for (const key of Object.keys(obj)) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)
        && subpath.length >= prefix.length + suffix.length) {
      if (!bestMatchKey || prefix.length > bestMatchKey.indexOf('*')) {
        bestMatchKey = key;
      }
    }
  }
  if (bestMatchKey) {
    const star = bestMatchKey.indexOf('*');
    const prefix = bestMatchKey.slice(0, star);
    const suffix = bestMatchKey.slice(star + 1);
    const captured = subpath.slice(prefix.length, subpath.length - suffix.length);
    const target = resolveExportsConditions(obj[bestMatchKey]);
    if (target) return target.replace(/\*/g, captured);
  }
  return null;
}

/**
 * Walk up from `fromDir` looking for `node_modules/<specifier>` and resolve
 * the package's entry file. Honours, in order:
 *   - `hinmil.sidecars` field (first existing entry)
 *   - `exports` field (subpath + conditional resolution)
 *   - `main` field
 *   - `index.{js,mjs,cjs}` fallback
 *
 * Supports subpath imports like `lodash/fp` or `@scope/pkg/sub/path`.
 */
function resolveNodeModulePackage(specifier: string, fromDir: string): string | null {
  const [pkgName, subpath] = splitBareSpecifier(specifier);
  let searchDir = fromDir;
  while (true) {
    const nodeModulesDir = path.join(searchDir, 'node_modules', pkgName);
    try {
      if (isDir(nodeModulesDir)) {
        const pkgJsonPath = path.join(nodeModulesDir, 'package.json');
        const pkgJson = readJsonCached(pkgJsonPath) ?? null;

        if (pkgJson) {
          // Prefer hinmil.sidecars field (only honoured for the package root).
          // Accepts either a single string or an array — for arrays we
          // return the first existing entry so `::types <pkg>` lands on
          // the package's primary sidecar.
          if (subpath === '.') {
            for (const rel of readPkgSidecarPathsFromJson(pkgJson)) {
              const hmPath = path.resolve(nodeModulesDir, rel);
              if (isFile(hmPath)) return hmPath;
            }
          }

          // Modern exports field
          if (pkgJson.exports !== undefined) {
            const target = resolveExportsField(pkgJson.exports, subpath);
            if (target) {
              const resolved = resolveWithExtensions(path.resolve(nodeModulesDir, target));
              if (resolved) return resolved;
            }
          }

          // main / module fallback (only for package root)
          if (subpath === '.') {
            for (const field of ['main', 'module']) {
              const v = pkgJson[field];
              if (typeof v === 'string') {
                const mainPath = path.resolve(nodeModulesDir, v);
                const resolved = resolveWithExtensions(mainPath);
                if (resolved) return resolved;
              }
            }
          }
        }

        // Subpath fallback: treat as relative to package root
        if (subpath !== '.') {
          const subResolved = resolveWithExtensions(path.resolve(nodeModulesDir, subpath));
          if (subResolved) return subResolved;
        } else {
          // Default: index.{js,mjs,cjs}
          const indexResolved = resolveWithExtensions(path.join(nodeModulesDir, 'index'));
          if (indexResolved) return indexResolved;
        }
      }
    } catch { /* continue */ }

    const parentDir = path.dirname(searchDir);
    if (parentDir === searchDir) break; // reached filesystem root
    searchDir = parentDir;
  }
  return null;
}

/**
 * Resolve an import specifier (relative path or bare package name) to a file URI.
 */
export function resolveImportSpecifier(specifier: string, fromUri: string): string | null {
  const fromPath = fileURLToPath(fromUri);
  const fromDir = path.dirname(fromPath);

  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const resolved = resolveWithExtensions(path.resolve(fromDir, specifier));
    return resolved ? pathToFileURL(resolved).href : null;
  }

  // Bare specifier — look up in node_modules
  const resolved = resolveNodeModulePackage(specifier, fromDir);
  return resolved ? pathToFileURL(resolved).href : null;
}

/**
 * Resolve an import specifier (seen from the file `fromPath`) to the SOURCE
 * file a reader would want to open: like {@link resolveImportSpecifier}, but
 * a package whose root resolves to an `.hm` sidecar yields its JavaScript
 * entry (`main` / `module` / `index`) instead.  Used by go-to-definition.
 */
export function resolveImportSourceFile(specifier: string, fromPath: string): string | null {
  const uri = resolveImportSpecifier(specifier, pathToFileURL(fromPath).href);
  if (!uri) return null;
  const resolved = fileURLToPath(uri);
  return resolved.endsWith('.hm') ? (effectiveJsEntry(resolved) ?? resolved) : resolved;
}

/** Module-ish extensions that are handled by inference rather than a bundler. */
const MODULE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.hm']);

/**
 * True when `specifier` is a bundler-managed asset import — a relative (or
 * absolute) path to an existing file whose extension is not a JS module
 * (e.g. `./assets/hero.png`, `./App.css`, `./logo.svg?url`).  Such imports
 * are resolved by the bundler (Vite, webpack) at build time; the engine
 * binds their names to the opaque `Any` type instead of reporting
 * "Cannot resolve module" / "Unbound variable".
 */
export function isAssetImportSpecifier(specifier: string, fromUri: string): boolean {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return false;
  // Strip bundler query/hash suffixes (Vite's `?url`, `?raw`, …).
  const clean = specifier.replace(/[?#].*$/, '');
  const ext = path.extname(clean).toLowerCase();
  if (!ext || MODULE_EXTS.has(ext)) return false;
  try {
    const fromDir = path.dirname(fileURLToPath(fromUri));
    return isFile(path.resolve(fromDir, clean));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ::types directive resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a `// ::types <specifier>` directive to a file path.
 * Supports:
 *   - Relative paths: `./demo`, `../lib/types`
 *   - Package names:  `fantasy-box`
 *   - Scoped packages: `@scope/package`
 */
export function resolveTypeDirectiveSpecifier(specifier: string, fromUri: string): string | null {
  const fromPath = fileURLToPath(fromUri);
  const fromDir = path.dirname(fromPath);

  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    // Relative path — resolve against the current file's directory.  A
    // `::types` file is often a `.hm` file: `./types` finds `types.hm` when
    // there is no JS module of that name (`.hm` exact paths already match).
    const base = path.resolve(fromDir, specifier);
    const js = resolveWithExtensions(base);
    if (js) return js;
    if (!base.endsWith('.hm') && isFile(base + '.hm')) return base + '.hm';
    return null;
  }

  const fromNodeModules = resolveNodeModulePackage(specifier, fromDir);
  if (fromNodeModules) return fromNodeModules;
  return resolvePackageSelfSidecar(specifier, fromPath);
}

/**
 * Package self-reference for `::types <own-package-name>`: a file INSIDE a
 * package's source tree names its own package (a query builder's generated
 * `src/generated/client/index.hm` starts with `::types query-builder`), which has no
 * `node_modules/<name>` entry in the source repository.  Resolve it to the
 * package's own primary sidecar — the same target a consumer reaches through
 * `node_modules`.  Package root only.
 */
function resolvePackageSelfSidecar(specifier: string, fromPath: string): string | null {
  const [pkgName, subpath] = splitBareSpecifier(specifier);
  if (subpath !== '.') return null;
  const own = findPackageJson(fromPath);
  if (!own || own.pkgJson.name !== pkgName) return null;
  for (const rel of readPkgSidecarPathsFromJson(own.pkgJson)) {
    const hmPath = path.resolve(own.pkgDir, rel);
    if (isFile(hmPath)) return hmPath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Import specifier extraction
// ---------------------------------------------------------------------------

/**
 * Extract import specifiers mapping imported name → module specifier.
 * Handles: `import Foo from './foo'`, `const { Foo } = require('./foo')`
 */
export function extractImportSpecifiers(source: string): Map<string, string> {
  const result = new Map<string, string>();
  // import Name from 'specifier'
  const defaultImportRe = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = defaultImportRe.exec(source)) !== null) {
    result.set(m[1], m[2]);
  }
  // import { Name } from 'specifier'  or  import { Name as Alias } from 'specifier'
  const namedImportRe = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = namedImportRe.exec(source)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) result.set(name, m[2]);
    }
  }
  // const { Name } = require('specifier')
  const requireRe = /const\s+\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = requireRe.exec(source)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) result.set(name, m[2]);
    }
  }
  // const Name = require('specifier')   — single-name CJS import (no destructure)
  const requireDefaultRe = /const\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = requireDefaultRe.exec(source)) !== null) {
    result.set(m[1], m[2]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Array literal ASI normalization
// ---------------------------------------------------------------------------

/**
 * Pre-process source to insert `;` before `[` at line starts where JS parsers
 * would otherwise treat the array literal as a computed member access on the
 * previous expression (the well-known ASI hazard).
 *
 * Returns the patched source and an array of insertion offsets so that
 * diagnostic positions can be mapped back to the original source.
 *
 * Heuristic: a `[` at the start of a line (after optional whitespace) is
 * treated as an array literal start when the last significant character of
 * the previous line is one of:  ) ] } identifier-char " ' ` digit
 * (i.e. something that ends a complete expression/statement).
 */
export function normalizeArrayLiteralASI(source: string): { patched: string; insertions: number[] } {
  const lines = source.split('\n');
  const insertions: number[] = [];
  let offset = 0; // running offset in the *original* source

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const trimmed = line.trimStart();
    if (trimmed.startsWith('[') && lineIdx > 0) {
      // Check if previous line ends with something that completes an expression
      let prevLineIdx = lineIdx - 1;
      // Skip blank lines
      while (prevLineIdx >= 0 && lines[prevLineIdx].trim() === '') prevLineIdx--;
      if (prevLineIdx >= 0) {
        const prevTrimmed = lines[prevLineIdx].trimEnd();
        const lastChar = prevTrimmed[prevTrimmed.length - 1];
        if (lastChar && /[)\]}'"`0-9A-Za-z_$]/.test(lastChar)) {
          // Insert ';' at the beginning of the trimmed content
          const leadingSpaces = line.length - trimmed.length;
          const insertPos = offset + leadingSpaces;
          insertions.push(insertPos);
          lines[lineIdx] = line.substring(0, leadingSpaces) + ';' + trimmed;
        }
      }
    }
    offset += line.length + 1; // +1 for the '\n'
  }

  return { patched: lines.join('\n'), insertions };
}

/**
 * Map an offset from original source to the patched source,
 * accounting for all `;` insertions.
 */
export function mapOffset(offset: number, insertions: number[]): number {
  let mapped = offset;
  for (const ins of insertions) { if (ins <= offset) mapped++; else break; }
  return mapped;
}

/**
 * Map an offset from patched source back to the original source,
 * accounting for all `;` insertions.
 */
export function unmapOffset(patchedOffset: number, insertions: number[]): number {
  let shift = 0;
  for (const ins of insertions) {
    if (ins + shift < patchedOffset) shift++;
    else break;
  }
  return patchedOffset - shift;
}

/**
 * Find the matching `[` for a `]` at `closeBracketIdx` in `source` and
 * return a patched source with `;` inserted before the `[`.
 *
 * This is the single, reusable fix for the ASI ambiguity where JavaScript
 * (and the parser) treat `[...]` on a new line as computed member access on
 * the previous expression rather than as an array literal.
 */
export function patchArrayLiteralASI(
  source: string,
  closeBracketIdx: number,
): { patched: string; openBracket: number; shift: number } | null {
  let bracketDepth = 0;
  let openBracket = -1;
  for (let i = closeBracketIdx - 1; i >= 0; i--) {
    if (source[i] === ']') bracketDepth++;
    if (source[i] === '[') {
      if (bracketDepth === 0) { openBracket = i; break; }
      bracketDepth--;
    }
  }
  if (openBracket < 0) return null;
  return {
    patched: source.substring(0, openBracket) + ';' + source.substring(openBracket),
    openBracket,
    shift: 1,
  };
}

// ---------------------------------------------------------------------------
// Export location lookup
// ---------------------------------------------------------------------------

/**
 * Find the offset of an exported identifier in a source file.
 * Handles: `export const name`, `export function name`, `export default name`,
 *          `export { name }`, and `const name` / `function name` (for default
 *          or re-export patterns).
 * Returns the start offset of the identifier or -1 if not found.
 */
export function findExportedIdentifierOffset(source: string, name: string): number {
  // export const name / export let name / export var name / export function name
  const exportDeclRe = new RegExp(`export\\s+(?:const|let|var|function)\\s+(${escapeRegExp(name)})\\b`);
  let m = exportDeclRe.exec(source);
  if (m) return m.index + m[0].length - name.length;

  // export default name (rare but possible)
  const exportDefaultRe = new RegExp(`export\\s+default\\s+(${escapeRegExp(name)})\\b`);
  m = exportDefaultRe.exec(source);
  if (m) return m.index + m[0].length - name.length;

  // export { name } or export { something as name }
  const exportListRe = /export\s+\{([^}]+)\}/g;
  let em;
  while ((em = exportListRe.exec(source)) !== null) {
    for (const part of em[1].split(',')) {
      const trimmed = part.trim();
      const asMatch = trimmed.match(/\w+\s+as\s+(\w+)/);
      const exported = asMatch ? asMatch[1] : trimmed;
      if (exported === name) {
        // Point to the actual declaration in the file
        const declRe = new RegExp(`(?:const|let|var|function)\\s+(${escapeRegExp(name)})\\b`);
        const dm = declRe.exec(source);
        if (dm) return dm.index + dm[0].length - name.length;
        // Fall back to the export list position
        return em.index;
      }
    }
  }

  // Plain declaration (for module.exports patterns or default export after decl)
  const plainDeclRe = new RegExp(`(?:const|let|var|function)\\s+(${escapeRegExp(name)})\\b`);
  m = plainDeclRe.exec(source);
  if (m) return m.index + m[0].length - name.length;

  return -1;
}

/** Escape special regex characters in a string. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Offset / position conversion
// ---------------------------------------------------------------------------

/** Convert a character offset to a Position {line, character}. */
export function positionAt(source: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { line, character: offset - lastNewline - 1 };
}

// ---------------------------------------------------------------------------
// Type definition location
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion inside a RegExp source.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check whether a comment slice is the actual local annotation / sumtype
 * declaration for `typeName` (i.e. `// typeName :: ...`).  Used to guard
 * against false positives where the globally-merged annotation/registry
 * entries point at unrelated comment ranges in the current file (e.g. a
 * `::types ./Either2` directive that happens to contain both `::` and
 * `Either2`).
 */
function isOwnAnnotationSlice(slice: string, typeName: string): boolean {
  if (!slice) return false;
  const pattern = new RegExp(`^\\s*//\\s*${escapeRegex(typeName)}\\s*::`);
  return pattern.test(slice);
}

/**
 * Find the definition location of a type name.
 * Checks: 1) type aliases, 2) local constructor annotations,
 *         3) imported files, 4) ::types directive targets,
 *         5) globals file.
 */
export function findTypeDefinitionLocation(
  typeName: string,
  source: string,
  fromUri: string,
  result: InferenceResult,
  globals?: { source: string; uri: string } | null,
): Location | null {
  // 1) Type alias in current file.  The typeAliases map also contains
  //    entries merged from project globals — those carry offsets from the
  //    GLOBALS source, not the current file.  Anchor-check the slice (must
  //    start with `// <typeName> ::`) so we only return a local location
  //    for aliases that are genuinely declared in this file; foreign
  //    entries fall through to the globals lookup below (step 5).
  const alias = result.typeAliases.get(typeName);
  if (alias) {
    const aliasSlice = alias.commentEnd <= source.length
      ? source.slice(alias.commentStart, alias.commentEnd)
      : '';
    if (isOwnAnnotationSlice(aliasSlice, typeName)) {
      return Location.create(fromUri, {
        start: positionAt(source, alias.commentStart),
        end: positionAt(source, alias.commentEnd),
      });
    }
  }

  // 2) Constructor annotation in current file (e.g. // RTask :: ... -> RTask r e a)
  //    The annotations map may also contain entries merged from ::types directive
  //    targets — those have offsets from the OTHER file.  Verify the comment
  //    text at those offsets actually references this type in the current source
  //    before using it as a local location.  The slice must start with an
  //    anchored `// <typeName> ::` pattern; a loose includes() check is too
  //    permissive (e.g. `// ::types ./Either2` coincidentally contains both
  //    `::` and `Either2`, which used to fool this heuristic).
  const localAnn = result.annotations.get(typeName);
  if (localAnn?.scheme) {
    const annSlice = localAnn.commentEnd <= source.length
      ? source.slice(localAnn.commentStart, localAnn.commentEnd)
      : '';
    if (isOwnAnnotationSlice(annSlice, typeName)) {
      return Location.create(fromUri, {
        start: positionAt(source, localAnn.commentStart),
        end: positionAt(source, localAnn.commentEnd),
      });
    }
  }

  // 2b) Sum type declaration in current file (e.g. // Either :: Left e | Right a)
  //     Same anchoring check: the comment must start with
  //     `// <typeName> ::` to be considered a definition in the current file.
  const dataType = getDataType(typeName);
  const sumtypeSlice = dataType && dataType.decl.commentEnd <= source.length
    ? source.slice(dataType.decl.commentStart, dataType.decl.commentEnd)
    : '';
  if (dataType && isOwnAnnotationSlice(sumtypeSlice, typeName)) {
    return Location.create(fromUri, {
      start: positionAt(source, dataType.decl.commentStart),
      end: positionAt(source, dataType.decl.commentEnd),
    });
  }

  // 2c) ::constraint directive in current file (e.g. // ::constraint Functor f { map :: ... })
  const constraintLoc = findConstraintDirectiveLocation(typeName, source, fromUri);
  if (constraintLoc) return constraintLoc;

  // 3+4) Breadth-first search across reachable files via runtime imports
  //      and `::types` directive targets.  This lets go-to-definition follow
  //      transitive paths: e.g. Repo.js imports `one` from db/one.js, which
  //      has `// ::types ../lib/RTask` — looking up `RTask` from Repo.js
  //      reaches the annotations in lib/RTask/RTask.js by following the
  //      `::types` directive of the imported module.
  const visited = new Set<string>([fromUri]);
  const queue: { uri: string; source: string }[] = [{ uri: fromUri, source }];
  const MAX_VISIT = 64;
  let visits = 0;
  while (queue.length > 0 && visits < MAX_VISIT) {
    const { uri: curUri, source: curSource } = queue.shift()!;

    // Enqueue runtime imports
    for (const specifier of new Set(extractImportSpecifiers(curSource).values())) {
      const nextUri = resolveImportSpecifier(specifier, curUri);
      if (!nextUri || visited.has(nextUri)) continue;
      visited.add(nextUri);
      try {
        const p = fileURLToPath(nextUri);
        const s = fs.readFileSync(p, 'utf-8');
        queue.push({ uri: nextUri, source: s });
      } catch {
        // unreadable file — skip
      }
    }

    // Enqueue ::types directive targets
    for (const specifier of extractTypeDirectives(curSource)) {
      const targetPath = resolveTypeDirectiveSpecifier(specifier, curUri);
      if (!targetPath) continue;
      const nextUri = pathToFileURL(targetPath).href;
      if (visited.has(nextUri)) continue;
      visited.add(nextUri);
      try {
        const s = fs.readFileSync(targetPath, 'utf-8');
        queue.push({ uri: nextUri, source: s });
      } catch {
        // unreadable file — skip
      }
    }

    // Skip the seed file (already searched above as steps 1, 2, 2b, 2c)
    if (curUri === fromUri) continue;

    visits++;

    // Annotation in this file
    const anns = buildAnnotationMap(curSource);
    const ann = anns.get(typeName);
    if (ann) {
      return Location.create(curUri, {
        start: positionAt(curSource, ann.commentStart),
        end: positionAt(curSource, ann.commentEnd),
      });
    }
    // Sumtype declaration in this file
    for (const decl of extractDataDirectives(curSource)) {
      if (decl.name === typeName) {
        return Location.create(curUri, {
          start: positionAt(curSource, decl.commentStart),
          end: positionAt(curSource, decl.commentEnd),
        });
      }
    }
    // ::constraint directive in this file
    const constraintLoc2 = findConstraintDirectiveLocation(typeName, curSource, curUri);
    if (constraintLoc2) return constraintLoc2;
  }

  // 5) Look in globals file (project-level globals with ::constraint, ::global, sumtype)
  if (globals) {
    const globalsAnns = buildAnnotationMap(globals.source);
    const ann = globalsAnns.get(typeName);
    if (ann) {
      return Location.create(globals.uri, {
        start: positionAt(globals.source, ann.commentStart),
        end: positionAt(globals.source, ann.commentEnd),
      });
    }
    const globalsDataDirectives = extractDataDirectives(globals.source);
    for (const decl of globalsDataDirectives) {
      if (decl.name === typeName) {
        return Location.create(globals.uri, {
          start: positionAt(globals.source, decl.commentStart),
          end: positionAt(globals.source, decl.commentEnd),
        });
      }
    }
    const globalsConstraintLoc = findConstraintDirectiveLocation(typeName, globals.source, globals.uri);
    if (globalsConstraintLoc) return globalsConstraintLoc;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Constraint directive location lookup
// ---------------------------------------------------------------------------

/** Pattern to extract the constraint name from a ::constraint directive text. */
const CONSTRAINT_NAME_PATTERN = /^[\s*]*::constraint\s+([A-Z]\w*)/;

/**
 * Search `// ::constraint Name v { ... }` directives in `source` for one
 * whose constraint name matches `name`.  Returns the Location of the
 * directive comment, or null if not found.
 */
function findConstraintDirectiveLocation(
  name: string,
  source: string,
  uri: string,
): Location | null {
  for (const directive of extractConstraintDirectives(source)) {
    const m = CONSTRAINT_NAME_PATTERN.exec(directive.text);
    if (m && m[1] === name) {
      return Location.create(uri, {
        start: positionAt(source, directive.start),
        end: positionAt(source, directive.end),
      });
    }
  }
  return null;
}

// .hm sidecar loading (npm package type stubs)

type Scheme = import('../hm/types').Scheme;
type Type = import('../hm/types').Type;
type Logger = { warn(msg: string): void };
const NOOP_LOGGER: Logger = { warn: () => { /* noop */ } };

const hmFileCache = new Map<string, { stamp: string; exports: Map<string, Scheme> | null }>();

/** Cheap freshness stamp for a sidecar on disk (mtime + size). */
function hmFileStamp(filePath: string): string | null {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

export function clearHmSidecarCache(): void {
  hmFileCache.clear();
}

/**
 * Evict a single `.hm` sidecar entry from the parse cache.  Used by the
 * selective-invalidation path so unrelated sidecars stay parsed when one
 * sidecar changes.  Accepts either an absolute file path (the cache key)
 * or a `file://` URI — converts the URI form to a path before lookup.
 */
export function evictHmSidecar(pathOrUri: string): void {
  const key = pathOrUri.startsWith('file://')
    ? fileURLToPath(pathOrUri)
    : pathOrUri;
  hmFileCache.delete(key);
}

/**
 * Wrap every non-comment line of a `.hm` source with `// ` so that the
 * existing comment-based annotation parser can extract `Name :: Type`
 * declarations.
 *
 * Comment semantics inside `.hm`:
 *   - A line starting with `//` (after trimming) is a true source-level
 *     comment and is NOT registered. Its bytes are blanked out (replaced
 *     by spaces of the same length) so directive/annotation regexes can
 *     never see them, while line offsets remain stable for diagnostics.
 *   - Block comments (`/* ... *\/`) are likewise stripped to whitespace.
 *   - Bare directive/annotation lines are wrapped with `// ` so the
 *     existing JS comment parser picks them up.
 */
export function wrapHmSource(source: string): string {
  const blank = (line: string) => ' '.repeat(line.length);
  let inBlock = false;
  return source
    .split('\n')
    .map(line => {
      if (inBlock) {
        const end = line.indexOf('*/');
        if (end >= 0) inBlock = false;
        return blank(line);
      }
      const trimmed = line.trimStart();
      if (trimmed === '') return line;
      if (trimmed.startsWith('//')) return blank(line);
      if (trimmed.startsWith('/*')) {
        if (!line.includes('*/')) inBlock = true;
        return blank(line);
      }
      if (trimmed.startsWith('*')) return blank(line);
      return "// " + blankTrailingHmComment(line);
    })
    .join('\n');
}

/**
 * Blank a trailing `// remark` on a `.hm` declaration line (same length, so
 * offsets stay put).  `//` never occurs in type syntax, except inside a
 * string-literal type (`'https://…'`), which is skipped.
 */
function blankTrailingHmComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '/' && line[i + 1] === '/') {
      return line.slice(0, i) + ' '.repeat(line.length - i);
    }
  }
  return line;
}

/**
 * Parse a `.hm` annotation source into a map from exported name to its
 * `Scheme`.  By default the source is wrapped via {@link wrapHmSource} so
 * the JS comment-parser can read bare-line `Name :: Type` declarations.
 * Pass `{ wrap: false }` when the source is JS (or any file whose
 * annotations already live inside `// ` comments) — e.g. when scanning
 * a package's JS entries for inline signatures next to definitions.
 */
export function parseHmSource(source: string, opts: { wrap?: boolean } = {}): Map<string, Scheme> {
  const wrap = opts.wrap !== false;
  const wrapped = wrap ? wrapHmSource(source) : source;
  const { extractAnnotations } = require('../commentParser') as typeof import('../commentParser');
  const { mergeOverloadSchemes } = require('../hm/env') as typeof import('../hm/env');
  const annotations = extractAnnotations(wrapped);
  const exports = new Map<string, Scheme>();
  for (const ann of annotations) {
    if (!ann.name || !ann.scheme) continue;
    const existing = exports.get(ann.name);
    if (existing) {
      // Same name already declared — merge into an overloaded (Union) scheme.
      // Skip merging for method/static annotations (`Type#m`, `Type.m`); those
      // go through the method registry which has its own overload semantics.
      if (ann.name.includes('#') || ann.name.includes('.')) {
        exports.set(ann.name, ann.scheme);
      } else {
        exports.set(ann.name, mergeOverloadSchemes(existing, ann.scheme));
      }
    } else {
      exports.set(ann.name, ann.scheme);
    }
  }
  return exports;
}

/**
 * Like `parseHmSource` but returns the raw signature text exactly as the
 * user wrote it, indexed by export name.  Used by hover / completion to
 * preserve the user's parens, whitespace and ordering instead of
 * round-tripping through the type printer (which loses redundant parens).
 */
export function parseHmSourceRaw(source: string): Map<string, string> {
  const wrapped = wrapHmSource(source);
  const { extractAnnotations } = require('../commentParser') as typeof import('../commentParser');
  const annotations = extractAnnotations(wrapped);
  const raws = new Map<string, string>();
  for (const ann of annotations) {
    if (!ann.name || !ann.raw) continue;
    const prev = raws.get(ann.name);
    // Preserve overloads: when the same name has multiple `Name :: ...`
    // declarations, join them with `\n${name} :: ` so the consumer (hover)
    // can render each overload on its own line.
    raws.set(ann.name, prev ? `${prev}\n${ann.name} :: ${ann.raw}` : ann.raw);
  }
  return raws;
}

/**
 * Read and parse a standalone `.hm` annotation file. Returns a map from
 * exported name to its parsed `Scheme`, or `null` when the file can't be
 * read. Results are cached by absolute path.
 */
export function loadHmFile(filePath: string, logger: Logger = NOOP_LOGGER): Map<string, Scheme> | null {
  const stamp = hmFileStamp(filePath);
  const cached = hmFileCache.get(filePath);
  if (cached !== undefined && cached.stamp === (stamp ?? 'missing')) return cached.exports;
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    logger.warn(`[hinmil] Failed to read '${filePath}': ${e instanceof Error ? e.message : String(e)}`);
    hmFileCache.set(filePath, { stamp: stamp ?? 'missing', exports: null });
    return null;
  }
  const exports = timeSidecarStage('parse', () => parseHmSource(source));
  hmFileCache.set(filePath, { stamp: stamp ?? 'missing', exports });
  return exports;
}

/**
 * Parse the contents of a `.hm` annotation source and extract the type
 * aliases declared in it.  An entry is treated as an alias when the name
 * is uppercase, is not a method (no `#`/`.`), is not a sumtype declaration
 * or constructor, and is not a registered data-type variant.  Returned
 * alongside each alias is the ordered list of free type-variable names
 * appearing in the alias body — needed for polymorphic alias expansion.
 */
export function parseHmTypeAliases(source: string, opts: { wrap?: boolean } = {}): {
  aliases: Map<string, Type>;
  aliasVars: Map<string, string[]>;
  constructors: Map<string, Scheme>;
  instanceCallables: Map<string, Scheme[]>;
  aliasExtensions: { name: string; raw: string; start: number; end: number }[];
} {
  const wrap = opts.wrap !== false;
  const wrapped = wrap ? wrapHmSource(source) : source;
  const { buildAnnotationMap, extractInstanceCallables, extractAliasExtensions } = require('../commentParser') as typeof import('../commentParser');
  const { buildTypeAliases, buildTypeAliasVars } = require('../infer/annotations') as typeof import('../infer/annotations');
  const { T_UNION } = require('../hm/types') as typeof import('../hm/types');
  const annotationMap = buildAnnotationMap(wrapped);
  const allAliases = buildTypeAliases(annotationMap);
  // Restrict to non-functional bodies. Constructor / factory annotations
  // such as `BooleanProp :: (String, a) -> Prop Boolean` would otherwise
  // be classified as aliases by `buildTypeAliases` (because their return
  // type's name does not match the binding's name).  Treating them as
  // aliases would cause bare `TCon('BooleanProp', [])` references to
  // expand into a function type at use sites — which is never what we
  // want for a value-level factory.
  //
  // Repeated annotations for the same name (e.g. two overloaded
  // `Table :: ... -> ...` declarations) are merged into a union by
  // `buildTypeAliases`.  When every branch of that union is a function
  // type, the binding is still a value-level factory rather than a
  // type alias — so we filter those too.  Otherwise references to
  // `Table` in another sidecar's signatures would expand to a union of
  // function types and lose access to the registered `Table#...` methods.
  const isFunctionalUnion = (t: Type): boolean =>
    t.tag === 'TCon' && t.name === T_UNION
      && t.args.length > 0 && t.args.every(a => a.tag === 'TFun');
  const aliases = new Map<string, Type>();
  for (const [name, type] of allAliases) {
    if (type.tag === 'TFun') continue;
    if (isFunctionalUnion(type)) continue;
    aliases.set(name, type);
  }
  // Constructor / callable-value annotations: uppercase-named entries
  // whose scheme body is a TFun, or a Union containing at least one TFun
  // branch.  These power the "constructor as callable" bridge so that a
  // value of an uppercase TCon (e.g. `QueryTag a` returned from
  // `Organisation([...])`) can be invoked when the imported sidecar
  // declares `QueryTag :: a -> RTask r e [b]`.  Method annotations and
  // lowercase-named values are excluded.
  const constructors = new Map<string, Scheme>();
  for (const [name, ann] of annotationMap) {
    if (!ann.scheme) continue;
    if (name.includes('#') || name.includes('.')) continue;
    if (!/^[A-Z]/.test(name)) continue;
    const t = ann.scheme.type;
    const isCallable = t.tag === 'TFun'
      || (t.tag === 'TCon' && t.name === T_UNION
          && t.args.some(a => a.tag === 'TFun'));
    if (isCallable) constructors.set(name, ann.scheme);
  }
  const aliasVars = buildTypeAliasVars(annotationMap, aliases);
  // Return all `Name() :: ...` entries verbatim — DO NOT filter orphans
  // here.  In an override sidecar (project `hm-types/<pkg>.hm` registered
  // via `package.json#hinmil.overrides`) it is intentional to declare only
  // an instance-callable while the matching constructor lives in the
  // base package sidecar.  The consumer engine merges constructors from
  // all sources and validates orphans against the union; doing it here
  // would silently drop a valid override.
  const instanceCallables = extractInstanceCallables(wrapped);
  const aliasExtensions = extractAliasExtensions(wrapped);
  return { aliases, aliasVars, constructors, instanceCallables, aliasExtensions };
}

/**
 * Type aliases declared in a JavaScript/TypeScript module's own comment
 * annotations (`// RequestObj :: { … }`, `// Rule :: (String, Any) -> …`).
 *
 * Only STANDALONE annotations count: an uppercase annotation that is not
 * attached to a declaration (`nodeStart === undefined`).  An annotation on a
 * declaration (`// Engine :: (String, EngineFn) -> Component` above
 * `const Engine = …`) types a value, not a type name.  Unlike `.hm`
 * sidecars, function-bodied aliases (`RouteFn :: RequestObj -> …`) stay
 * aliases: in a JS module the standalone form is always a type name.
 *
 * Used by the import-alias resolver so that importing a value from a module
 * also brings the type names that module (and its `::types` closure)
 * declares — consumers no longer need an explicit `// ::types` for them.
 */
export function parseJsTypeAliases(source: string): ReturnType<typeof parseHmTypeAliases> {
  const { extractAliasExtensions } = require('../commentParser') as typeof import('../commentParser');
  const { buildTypeAliases, buildTypeAliasVars } = require('../infer/annotations') as typeof import('../infer/annotations');
  const standalone = new Map<string, import('../commentParser').TypeAnnotation>();
  for (const [name, ann] of buildAnnotationMap(source)) {
    if (!ann.scheme || ann.nodeStart !== undefined) continue;
    if (name.includes('#') || name.includes('.')) continue;
    if (!/^[A-Z]/.test(name)) continue;
    standalone.set(name, ann);
  }
  const aliases = standalone.size > 0
    ? buildTypeAliases(standalone)
    : new Map<string, import('../hm/types').Type>();
  const aliasVars = aliases.size > 0 ? buildTypeAliasVars(standalone, aliases) : new Map<string, string[]>();
  return {
    aliases,
    aliasVars,
    constructors: new Map(),
    instanceCallables: new Map(),
    aliasExtensions: extractAliasExtensions(source),
  };
}

/**
 * Read the `hinmil.sidecars` field from an already-parsed package.json.
 * Returns the list of relative paths declared (single-string or array form),
 * or an empty array when the field is absent / malformed.  Filtering by
 * file existence is the caller's responsibility.
 */
function readPkgSidecarPathsFromJson(pkgJson: Record<string, unknown> | null): string[] {
  if (!pkgJson) return [];
  const hinMil = pkgJson['hinmil'];
  if (!hinMil || typeof hinMil !== 'object') return [];
  const raw = (hinMil as Record<string, unknown>).sidecars;
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  return [];
}

/**
 * Read the `hinmil.globals` field from an already-parsed package.json.
 * Returns the relative paths (always an array).  A non-array value is
 * rejected with a warning — library authors must use `"globals": ["..."]`.
 */
function readPkgGlobalsFromJson(
  pkgJson: Record<string, unknown> | null,
  pkgJsonPath: string | null = null,
  logger: Logger = NOOP_LOGGER,
): string[] {
  if (!pkgJson) return [];
  const hinMil = pkgJson['hinmil'];
  if (!hinMil || typeof hinMil !== 'object') return [];
  const raw = (hinMil as Record<string, unknown>).globals;
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  const loc = pkgJsonPath ? ` in ${pkgJsonPath}` : '';
  logger.warn(`[hinmil] 'hinmil.globals'${loc} must be an array of paths (got ${typeof raw}); ignoring.`);
  return [];
}

/**
 * Walk up from `entryPath` to the nearest `package.json` and collect every
 * sidecar declared in its `hinmil.sidecars` field.  The field may be a single
 * string or an array of strings — entries are resolved relative to the
 * `package.json` directory.  Missing files are silently skipped.  Order
 * is preserved: when consumers merge the results, later entries should
 * override earlier ones.
 */
export function findHmSidecarPaths(entryPath: string): string[] {
  let dir = path.dirname(entryPath);
  while (true) {
    const pkgJsonPath = path.join(dir, 'package.json');
    const pkgJson = readJsonCached(pkgJsonPath);
    if (pkgJson === null) return []; // malformed package.json
    if (pkgJson !== undefined) {
      const out: string[] = [];
      for (const rel of readPkgSidecarPathsFromJson(pkgJson)) {
        const sidecar = path.resolve(dir, rel);
        if (isFile(sidecar)) out.push(sidecar); // declared but missing → skipped
      }
      return out;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
}

/**
 * Walk up from `entryPath` to the nearest `package.json` and return the
 * package directory plus its parsed JSON.  Returns null when no
 * `package.json` is found.
 */
export function findPackageJson(entryPath: string): { pkgDir: string; pkgJson: Record<string, unknown> } | null {
  let dir = path.dirname(entryPath);
  while (true) {
    const pkgJsonPath = path.join(dir, 'package.json');
    const pkgJson = readJsonCached(pkgJsonPath);
    if (pkgJson === null) return null; // malformed package.json
    if (pkgJson !== undefined) return { pkgDir: dir, pkgJson };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the absolute paths of a package's `hinmil.globals` files.
 * Returns an empty array when the package declares no globals.  Each
 * declared entry must point at an existing file; unresolvable entries
 * are warned about and skipped.
 */
export function findPackageGlobalsPaths(
  entryPath: string,
  logger: Logger = NOOP_LOGGER,
): string[] {
  const found = findPackageJson(entryPath);
  if (!found) return [];
  const pkgJsonPath = path.join(found.pkgDir, 'package.json');
  const rels = readPkgGlobalsFromJson(found.pkgJson, pkgJsonPath, logger);
  const out: string[] = [];
  for (const rel of rels) {
    const abs = path.resolve(found.pkgDir, rel);
    if (isFile(abs)) {
      out.push(abs);
      continue;
    }
    logger.warn(`[hinmil] 'hinmil.globals' entry '${rel}' in ${pkgJsonPath} does not exist; skipping.`);
  }
  return out;
}

/** Backward-compatible single-result helper: returns the first sidecar, or null. */
export function findHmSidecarPath(entryPath: string): string | null {
  const all = findHmSidecarPaths(entryPath);
  return all.length > 0 ? all[0] : null;
}

export function loadHmSidecar(entryPath: string, logger: Logger = NOOP_LOGGER): Map<string, Scheme> | null {
  const paths = findHmSidecarPaths(entryPath);
  if (paths.length === 0) return null;
  const merged = new Map<string, Scheme>();
  let any = false;
  for (const p of paths) {
    const m = loadHmFile(p, logger);
    if (!m) continue;
    any = true;
    for (const [k, v] of m) merged.set(k, v); // later overrides earlier
  }
  return any ? merged : null;
}

// ---------------------------------------------------------------------------
// Bare specifier helpers (re-exported for use by the import resolver)
// ---------------------------------------------------------------------------

/** True for an import specifier that targets a node_modules package. */
export function isBareSpecifier(specifier: string): boolean {
  if (!specifier) return false;
  if (specifier.startsWith('.')) return false;
  if (specifier.startsWith('/')) return false;
  if (path.isAbsolute(specifier)) return false;
  return true;
}

/** Public re-export of the internal `splitBareSpecifier` helper. */
export function getBarePackageName(specifier: string): string {
  return splitBareSpecifier(specifier)[0];
}

/**
 * Candidate conventional stub paths (relative to `<typesDir>/`) for a bare
 * specifier, most specific first.  Deep imports of CJS utility packages
 * (`import RTask from "pkg/RTask/index.js"`) need a stub describing the
 * SUBPATH module's exports — the package-level `<pkg>.hm` stub describes
 * the root module and is only the last-resort fallback:
 *
 *   `pkg/RTask/index.js` → [`pkg/RTask/index.hm`, `pkg/RTask.hm`, `pkg.hm`]
 *   `pkg/RTask`          → [`pkg/RTask.hm`, `pkg/RTask/index.hm`, `pkg.hm`]
 *   `pkg`                → [`pkg.hm`]
 */
export function conventionalStubRelPaths(specifier: string): string[] {
  const [pkg, sub] = splitBareSpecifier(specifier);
  const out: string[] = [];
  if (sub !== '.') {
    const subRel = sub.slice(2).replace(/\.(?:m|c)?jsx?$/i, '');
    out.push(path.join(pkg, subRel + '.hm'));
    if (subRel.endsWith('/index')) {
      out.push(path.join(pkg, subRel.slice(0, -'/index'.length) + '.hm'));
    } else {
      out.push(path.join(pkg, subRel, 'index.hm'));
    }
  }
  out.push(pkg + '.hm');
  return out;
}

/**
 * Derive the conventional `@hm/*` companion package name for a given
 * bare package specifier. Mirrors the DefinitelyTyped (`@types/*`) scheme:
 *   `lodash`        → `@hm/lodash`
 *   `@scope/pkg`    → `@hm/scope__pkg`
 */
export function hmCompanionPackageName(pkgName: string): string {
  if (pkgName.startsWith('@')) {
    return '@hm/' + pkgName.slice(1).replace('/', '__');
  }
  return '@hm/' + pkgName;
}

// ---------------------------------------------------------------------------
// Inline package annotations
// ---------------------------------------------------------------------------
//
// A library author may ship HM signatures inline next to JS definitions
// (e.g. `// limit :: Number -> Limit` immediately above `export const
// limit = ...`) instead of a `.hm` sidecar.  Consumers picking the
// package up via `import { limit } from "pkg"` should see those
// signatures automatically.
//
// Strategy: BFS from the package's JS entry, following `import` /
// `export ... from` / `require` edges, staying inside `pkgRoot`, and
// merging all annotations found.

/** Hard cap on visited files per scan to keep cost bounded. */
export const INLINE_PACKAGE_MAX_FILES = 256;

export interface InlinePackageScan {
  /** Top-level `Name :: Type` annotations found inline.  Consumed by
   *  `createImportResolver` (merged with sidecar exports) to resolve
   *  imports of the package from outside its own tree. */
  exports: Map<string, Scheme>;
  /** Concatenated raw sources of all visited files — fed to the
   *  annotation registrar so it can pull out `Type#m` / `Type.m`
   *  method annotations and aliases. */
  methodSource: string;
  /** Verbatim raw signature text per top-level export name (the part
   *  after `Name :: `, exactly as written by the user).  Used by hover
   *  to render inline imports with their full constraint context, and
   *  by `findTypeDefinitions` to confirm an export carries an inline
   *  annotation. */
  inlineRawSignatures: Map<string, string>;
  /** Absolute file path of the visited source that first declared each
   *  top-level export (first-writer-wins).  Lets `findTypeDefinitions`
   *  jump directly to the defining file without re-scanning. */
  nameToSource: Map<string, string>;
  /** Absolute file paths visited — used for dependency tracking. */
  visitedFiles: string[];
}

const inlinePackageCache = new Map<string, InlinePackageScan | null>();

/** Package roots known to ship inline `// name :: Type` annotations. */
const inlineAnnotatedPackages = new Set<string>();

/** Max files probed per lookup by {@link isInlineAnnotatedPackageModule}. */
const INLINE_ANNOTATED_PROBE_FILES = 16;

/**
 * Runtime export names per `require` target, as read by
 * `supplementWithRuntimeExports` (importContext.ts); `null` = the module
 * could not be loaded.  Without this cache every import of a package re-ran
 * the `require` attempt and — for a package whose `main` is missing — logged
 * the same warning once per importing module.  Cleared together with the
 * inline-package cache (package changes on disk).
 */
export const runtimeExportNamesCache = new Map<string, string[] | null>();

export function clearInlinePackageCache(): void {
  inlinePackageCache.clear();
  inlineAnnotatedPackages.clear();
  runtimeExportNamesCache.clear();
}

/**
 * Does the package that owns `targetPath` (a JS module under node_modules)
 * ship inline HM annotations in its own source?  Such a package (e.g. a curried FP library,
 * whose buble build keeps every `// name :: Type` comment) has opted into
 * hinmil: its modules are inferred exactly like local source, so CommonJS
 * export shapes (`module.exports = _RTask` + dotted statics, re-export
 * barrels `module.exports = { RTask: require ("./RTask") }`) resolve
 * per module instead of through the name-based inline scan.
 *
 * Probes the target and a few same-package modules it requires (a barrel
 * `index.js` usually has no annotations itself).  Positive answers are
 * cached per package root.
 */
export function isInlineAnnotatedPackageModule(targetPath: string): boolean {
  if (targetPath.endsWith('.hm')) return false;
  const pkgRoot = inlinePkgRoot(targetPath);
  if (!pkgRoot) return false;
  if (inlineAnnotatedPackages.has(pkgRoot)) return true;
  const { extractAnnotations } = require('../commentParser') as typeof import('../commentParser');
  const queue = [path.resolve(targetPath)];
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < INLINE_ANNOTATED_PROBE_FILES) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    let source: string;
    try { source = fs.readFileSync(cur, 'utf-8'); } catch { continue; }
    // Cheap pre-filter before the real annotation parse.
    if (/^[ \t]*(?:\/\/|\*)[ \t]*[\w$]+(?:[#.][\w$]+)?[ \t]*::[ \t]/m.test(source)
        && extractAnnotations(source).some(a => !!a.name && !!a.scheme)) {
      inlineAnnotatedPackages.add(pkgRoot);
      return true;
    }
    for (const spec of extractAllModuleSpecifiers(source)) {
      if (!spec.startsWith('.')) continue;
      const next = resolveWithExtensions(path.resolve(path.dirname(cur), spec));
      if (next && path.resolve(next).startsWith(pkgRoot + path.sep)) queue.push(path.resolve(next));
    }
  }
  return false;
}

/**
 * Evict every inline-annotation scan whose cache key starts with the
 * given package root.  Use this instead of {@link clearInlinePackageCache}
 * when a single package's `.hm` sidecar changes — wiping the whole map
 * forces every other imported package to re-do its BFS scan on the next
 * resolver call (up to {@link INLINE_PACKAGE_MAX_FILES} files each),
 * which dominates cold-hover latency in workspaces with several heavy
 * dependencies.
 *
 * The cache key shape is `${pkgRoot}\0${effectiveEntry}` (see
 * {@link collectInlinePackageAnnotations}), so a prefix match on
 * `${pkgRoot}\0` cleanly targets the package.
 */
export function clearInlinePackageCacheForPackage(pkgRoot: string): void {
  inlineAnnotatedPackages.delete(pkgRoot);
  const prefix = pkgRoot + '\0';
  for (const key of inlinePackageCache.keys()) {
    if (key.startsWith(prefix)) inlinePackageCache.delete(key);
  }
}

/**
 * Extract every module specifier referenced by a JS source.  Handles:
 *   - `import x from '...'`
 *   - `import { x } from '...'`
 *   - `export { x } from '...'`
 *   - `export * from '...'`
 *   - `require('...')` (call expressions, anywhere)
 * Uses the parser when possible and falls back to a permissive regex when
 * the parse fails (e.g. flow / TS-only syntax).
 */
export function extractAllModuleSpecifiers(source: string): string[] {
  const seen = new Set<string>();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const walk = require('../walking') as typeof import('../walking');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseStrict } = require('../parsing') as typeof import('../parsing');
    const ast = parseStrict(source);
    walk.simple(ast, {
      ImportDeclaration(node: any): void {
        if (typeof node.source?.value === 'string') seen.add(node.source.value);
      },
      ExportNamedDeclaration(node: any): void {
        if (node.source && typeof node.source.value === 'string') seen.add(node.source.value);
      },
      ExportAllDeclaration(node: any): void {
        if (typeof node.source?.value === 'string') seen.add(node.source.value);
      },
      CallExpression(node: any): void {
        if (node.callee?.type === 'Identifier' && node.callee.name === 'require'
          && node.arguments?.length >= 1
          && node.arguments[0].type === 'Literal'
          && typeof node.arguments[0].value === 'string') {
          seen.add(node.arguments[0].value);
        }
      },
    });
  } catch {
    const re = /(?:import|from|require\s*\()\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) seen.add(m[1]);
  }
  return [...seen];
}

/**
 * Given an absolute path inside a package, walk up to the package root
 * (the directory containing the nearest `package.json`).  Returns null
 * when no `package.json` is found above `entryPath`.
 */
function inlinePkgRoot(entryPath: string): string | null {
  const found = findPackageJson(entryPath);
  return found ? found.pkgDir : null;
}

/**
 * If `entryPath` resolves to a `.hm` sidecar (or anything outside the
 * package's JS source tree), translate to the JS entry derived from
 * `main` / `module` so the inline-scan starts at real JavaScript.
 */
function effectiveJsEntry(entryPath: string): string | null {
  if (!entryPath.endsWith('.hm')) return entryPath;
  const found = findPackageJson(entryPath);
  if (!found) return null;
  for (const field of ['main', 'module']) {
    const v = found.pkgJson[field];
    if (typeof v === 'string') {
      const resolved = resolveWithExtensions(path.resolve(found.pkgDir, v));
      if (resolved) return resolved;
    }
  }
  // Fallback: index.{js,mjs,cjs}
  return resolveWithExtensions(path.join(found.pkgDir, 'index'));
}

/**
 * BFS the JS module graph rooted at `entryPath`, staying inside the
 * package root, collecting inline `// Name :: Type` annotations.  Returns
 * `null` when nothing was found (so callers can short-circuit).  Results
 * are cached by `pkgRoot + entry`.
 */
export function collectInlinePackageAnnotations(
  entryPath: string,
  logger: Logger = NOOP_LOGGER,
): InlinePackageScan | null {
  const effectiveEntry = effectiveJsEntry(entryPath);
  if (!effectiveEntry) return null;
  const pkgRoot = inlinePkgRoot(effectiveEntry);
  if (!pkgRoot) return null;
  const cacheKey = pkgRoot + '\0' + effectiveEntry;
  const cached = inlinePackageCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const exportsMap = new Map<string, Scheme>();
  const methodSourceParts: string[] = [];
  const inlineRawSignatures = new Map<string, string>();
  const nameToSource = new Map<string, string>();
  const visited = new Set<string>();
  const queue: string[] = [effectiveEntry];
  let hadAnyAnnotation = false;
  const { mergeOverloadSchemes } = require('../hm/env') as typeof import('../hm/env');
  const { extractAnnotations, extractTypeDirectives, extractAliasExtensions } =
    require('../commentParser') as typeof import('../commentParser');

  // Merge another scan (reached via `::types <bare-pkg>`) into the current
  // accumulators.  First writer wins on name collisions so the directly-
  // scanned package's exports take precedence over chained sources.
  const mergeChainedScan = (other: InlinePackageScan): void => {
    for (const [n, s] of other.exports) if (!exportsMap.has(n)) exportsMap.set(n, s);
    if (other.methodSource) methodSourceParts.push(other.methodSource);
    for (const [n, raw] of other.inlineRawSignatures) {
      if (!inlineRawSignatures.has(n)) inlineRawSignatures.set(n, raw);
    }
    for (const [n, p] of other.nameToSource) {
      if (!nameToSource.has(n)) nameToSource.set(n, p);
    }
    for (const f of other.visitedFiles) visited.add(f);
    if (other.exports.size > 0 || other.inlineRawSignatures.size > 0 || other.methodSource.length > 0) {
      hadAnyAnnotation = true;
    }
  };

  // Process a `.hm` file reached explicitly via `// ::types ./file.hm`.
  // Inline scans normally only walk JS, but an explicit `::types` directive
  // is the library author's opt-in to pull in a sidecar's signatures.
  const mergeHmFile = (hmPath: string): void => {
    if (visited.has(hmPath)) return;
    visited.add(hmPath);
    let hmSrc: string;
    try { hmSrc = fs.readFileSync(hmPath, 'utf-8'); }
    catch (e) {
      logger.warn(`[hinmil] inline scan failed to read '${hmPath}': ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const [n, s] of parseHmSource(hmSrc, { wrap: true })) {
      if (!exportsMap.has(n)) exportsMap.set(n, s);
    }
    methodSourceParts.push(wrapHmSource(hmSrc));
    for (const [n, raw] of parseHmSourceRaw(hmSrc)) {
      if (!inlineRawSignatures.has(n)) inlineRawSignatures.set(n, raw);
      if (!nameToSource.has(n)) nameToSource.set(n, hmPath);
      hadAnyAnnotation = true;
    }
  };

  while (queue.length > 0 && visited.size < INLINE_PACKAGE_MAX_FILES) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);

    let source: string;
    try { source = fs.readFileSync(cur, 'utf-8'); }
    catch (e) {
      logger.warn(`[hinmil] inline scan failed to read '${cur}': ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    methodSourceParts.push(source);

    // Top-level `Name :: Type` annotations (JS source, no wrap) — used to
    // resolve consumer-side imports of this package.
    for (const [name, scheme] of parseHmSource(source, { wrap: false })) {
      const existing = exportsMap.get(name);
      if (existing && !name.includes('#') && !name.includes('.')) {
        exportsMap.set(name, mergeOverloadSchemes(existing, scheme));
      } else {
        exportsMap.set(name, scheme);
      }
    }

    // Capture verbatim raw signature text for hover and origin file for
    // type-definition navigation.  Raw JS source is already inside `// `
    // comments, so `extractAnnotations` runs directly.
    for (const ann of extractAnnotations(source)) {
      if (!ann.name || !ann.raw) continue;
      hadAnyAnnotation = true;
      if (ann.name.includes('#') || ann.name.includes('.')) continue;
      const prev = inlineRawSignatures.get(ann.name);
      inlineRawSignatures.set(
        ann.name,
        prev ? `${prev}\n${ann.name} :: ${ann.raw}` : ann.raw,
      );
      if (!nameToSource.has(ann.name)) nameToSource.set(ann.name, cur);
    }
    if (!hadAnyAnnotation && extractAliasExtensions(source).length > 0) {
      hadAnyAnnotation = true;
    }

    // Follow re-export / import / require edges, restricted to pkgRoot.
    for (const spec of extractAllModuleSpecifiers(source)) {
      // Skip bare specifiers — only follow same-package paths.
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
      const next = resolveWithExtensions(path.resolve(path.dirname(cur), spec));
      if (!next) continue;
      const nextAbs = path.resolve(next);
      // Containment check: stay inside the package root.
      if (!nextAbs.startsWith(pkgRoot + path.sep) && nextAbs !== pkgRoot) continue;
      if (visited.has(nextAbs)) continue;
      queue.push(nextAbs);
    }

    // Follow `// ::types <specifier>` directives.  These are an explicit
    // opt-in by the library author, so containment is relaxed: relative
    // paths may point at sibling `.hm` files, and bare specifiers chain
    // into other packages' inline scans (or their sidecars, transitively).
    for (const spec of extractTypeDirectives(source)) {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const resolved = resolveWithExtensions(path.resolve(path.dirname(cur), spec));
        if (!resolved) continue;
        const resolvedAbs = path.resolve(resolved);
        if (visited.has(resolvedAbs)) continue;
        if (resolvedAbs.endsWith('.hm')) {
          mergeHmFile(resolvedAbs);
        } else {
          queue.push(resolvedAbs);
        }
      } else {
        // Bare package: recurse into its inline scan (cached) and merge.
        const otherEntry = resolveNodeModulePackage(spec, path.dirname(cur));
        if (!otherEntry) continue;
        const otherScan = collectInlinePackageAnnotations(otherEntry, logger);
        if (otherScan) mergeChainedScan(otherScan);
      }
    }
  }

  if (!hadAnyAnnotation) {
    inlinePackageCache.set(cacheKey, null);
    return null;
  }

  const scan: InlinePackageScan = {
    exports: exportsMap,
    methodSource: methodSourceParts.join('\n'),
    inlineRawSignatures,
    nameToSource,
    visitedFiles: [...visited],
  };
  inlinePackageCache.set(cacheKey, scan);
  return scan;
}

