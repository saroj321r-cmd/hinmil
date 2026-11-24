// ============================================================================
// Go to definition for code: imports, re-exports and local bindings
//
// Plain language: when you click a name or a module path in JavaScript, this
// finds where it really comes from.  It follows imports into other files
// (ESM, CommonJS, dynamic import), keeps following re-exports until it hits
// the actual declaration, and understands the usual ways a module exports
// something (`export const`, `export default`, `module.exports = …`,
// `exports.x = …`, Babel's compiled output).
//
// The VS Code TypeScript/JavaScript extension normally does this.  hinmil
// takes over when that extension is not active (see `navigation.definitions`
// in config.ts), so a workspace that disabled it can still navigate.
//
// Purely syntactic: no inference, so it is fast and works on files with type
// errors.  Scope resolution for the clicked identifier reuses the reference
// collector (./references), so shadowed names resolve to the right binding.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseLoose, parseStrict } from '../parsing';
import { findReferencesAtOffset } from './references';
import { resolveImportSourceFile } from './files';

/** A place to jump to: a file and a span (0-based offsets) inside it. */
export interface DefinitionTarget {
  path: string;
  start: number;
  end: number;
}

/** The answer for one cursor position: the clicked text (the link the
 *  editor underlines, e.g. a whole module path) and where it leads. */
export interface CodeDefinition {
  origin: { start: number; end: number };
  targets: DefinitionTarget[];
}

export interface CodeDefinitionOptions {
  /** Also answer for identifiers that are declared in the same file. */
  includeLocal: boolean;
  /** Source text of a file; open editor buffers win over the disk. */
  readSource?: (filePath: string) => string | null;
}

/** What a local name was imported as. `'*'` is the whole module. */
interface ImportBinding {
  specifier: string;
  imported: string;
}

/** Safety net against re-export cycles (`a` re-exports `b` re-exports `a`). */
const MAX_DEPTH = 16;

// ---------------------------------------------------------------------------
// Parsing (with a small per-file cache keyed by the exact source text)
// ---------------------------------------------------------------------------

const astCache = new Map<string, { source: string; ast: any }>();

function parseAny(source: string): any | null {
  try {
    return parseStrict(source);
  } catch {
    try {
      return parseLoose(source);
    } catch {
      return null;
    }
  }
}

function parseCached(filePath: string, source: string): any | null {
  const hit = astCache.get(filePath);
  if (hit && hit.source === source) return hit.ast;
  const ast = parseAny(source);
  if (ast) astCache.set(filePath, { source, ast });
  return ast;
}

/** Drop cached trees (file watcher / document change). */
export function clearDefinitionCache(filePath?: string): void {
  if (filePath) astCache.delete(filePath);
  else astCache.clear();
}

function defaultReadSource(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

/** Visit every node (depth-first, parents before children). */
function visit(node: any, fn: (node: any, parent: any) => void, parent: any = null): void {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'leadingComments' || key === 'trailingComments') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === 'string') visit(c, fn, node);
    } else if (child && typeof child.type === 'string') {
      visit(child, fn, node);
    }
  }
}

function contains(node: any, offset: number): boolean {
  return node != null && node.start <= offset && offset <= node.end;
}

/** The name of an identifier or a string literal (`import { "a-b" as c }`). */
function nameOf(node: any): string | null {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if ((node.type === 'Literal' || node.type === 'StringLiteral') && typeof node.value === 'string') return node.value;
  return null;
}

function isStringLiteral(node: any): boolean {
  return node != null && (node.type === 'Literal' || node.type === 'StringLiteral') && typeof node.value === 'string';
}

/** `require ("x")` → "x". */
function requireSpecifier(node: any): string | null {
  if (node?.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require'
    && node.arguments?.length >= 1 && isStringLiteral(node.arguments[0])) {
    return node.arguments[0].value;
  }
  return null;
}

/** `import ("x")` (also `await import ("x")`) → "x". */
function dynamicImportSpecifier(node: any): string | null {
  const inner = node?.type === 'AwaitExpression' ? node.argument : node;
  if (inner?.type === 'ImportExpression' && isStringLiteral(inner.source)) return inner.source.value;
  // Babel's estree plugin can still produce `CallExpression (Import)`.
  if (inner?.type === 'CallExpression' && inner.callee?.type === 'Import' && isStringLiteral(inner.arguments?.[0])) {
    return inner.arguments[0].value;
  }
  return null;
}

/** The module a value comes from: `require (x)`, `import (x)`, and Babel's
 *  `_interopRequireDefault (require (x))` / `__importDefault (require (x))`. */
function moduleSourceOf(node: any): string | null {
  const direct = requireSpecifier(node) ?? dynamicImportSpecifier(node);
  if (direct) return direct;
  if (node?.type === 'CallExpression' && node.arguments?.length === 1) {
    return requireSpecifier(node.arguments[0]);
  }
  return null;
}

/** `module.exports` */
function isModuleExports(node: any): boolean {
  return node?.type === 'MemberExpression' && !node.computed
    && node.object?.type === 'Identifier' && node.object.name === 'module'
    && nameOf(node.property) === 'exports';
}

/** `exports` or `module.exports` */
function isExportsObject(node: any): boolean {
  return (node?.type === 'Identifier' && node.name === 'exports') || isModuleExports(node);
}

/** The property name of `obj.name` / `obj["name"]`. */
function memberName(node: any): string | null {
  if (node?.type !== 'MemberExpression') return null;
  if (!node.computed) return nameOf(node.property);
  return isStringLiteral(node.property) ? node.property.value : null;
}

function span(filePath: string, node: any): DefinitionTarget {
  return { path: filePath, start: node.start, end: node.end };
}

function fileTop(filePath: string): DefinitionTarget {
  return { path: filePath, start: 0, end: 0 };
}

/** Identifiers declared by a binding pattern (`a`, `{ a, b: c }`, `[a, ...r]`). */
function patternIdentifiers(node: any, out: any[] = []): any[] {
  if (!node) return out;
  switch (node.type) {
    case 'Identifier': out.push(node); break;
    case 'ObjectPattern':
      for (const p of node.properties) patternIdentifiers(p.type === 'RestElement' ? p.argument : p.value, out);
      break;
    case 'ArrayPattern': for (const e of node.elements) patternIdentifiers(e, out); break;
    case 'RestElement': patternIdentifiers(node.argument, out); break;
    case 'AssignmentPattern': patternIdentifiers(node.left, out); break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Module index: what a file imports and declares at the top level
// ---------------------------------------------------------------------------

interface ModuleIndex {
  /** Import bindings keyed by the start offset of the local identifier. */
  importsByStart: Map<number, ImportBinding>;
  /** Top-level declarations and import bindings, by local name. */
  topLevel: Map<string, any>;
  importsByName: Map<string, ImportBinding>;
}

const indexCache = new WeakMap<object, ModuleIndex>();

function indexModule(ast: any): ModuleIndex {
  const cached = indexCache.get(ast);
  if (cached) return cached;
  const importsByStart = new Map<number, ImportBinding>();
  const importsByName = new Map<string, ImportBinding>();
  const topLevel = new Map<string, any>();

  const addImport = (local: any, binding: ImportBinding): void => {
    importsByStart.set(local.start, binding);
  };

  // Import bindings anywhere (a `require` inside a function is still an import).
  visit(ast, (node) => {
    if (node.type === 'ImportDeclaration' && isStringLiteral(node.source)) {
      for (const s of node.specifiers ?? []) {
        if (s.type === 'ImportDefaultSpecifier') addImport(s.local, { specifier: node.source.value, imported: 'default' });
        else if (s.type === 'ImportNamespaceSpecifier') addImport(s.local, { specifier: node.source.value, imported: '*' });
        else if (s.type === 'ImportSpecifier') addImport(s.local, { specifier: node.source.value, imported: nameOf(s.imported) ?? s.local.name });
      }
    } else if (node.type === 'VariableDeclarator' && node.init) {
      const whole = moduleSourceOf(node.init);
      if (whole) {
        if (node.id.type === 'Identifier') addImport(node.id, { specifier: whole, imported: '*' });
        else if (node.id.type === 'ObjectPattern') {
          for (const p of node.id.properties) {
            if (p.type !== 'Property' && p.type !== 'ObjectProperty') continue;
            const key = p.computed ? (isStringLiteral(p.key) ? p.key.value : null) : nameOf(p.key);
            const local = p.value?.type === 'AssignmentPattern' ? p.value.left : p.value;
            if (key && local?.type === 'Identifier') addImport(local, { specifier: whole, imported: key });
          }
        }
        return;
      }
      // const x = require ("y").x
      const name = memberName(node.init);
      const fromModule = name ? moduleSourceOf(node.init.object) : null;
      if (fromModule && name && node.id.type === 'Identifier') {
        addImport(node.id, { specifier: fromModule, imported: name });
      }
    }
  });

  const body: any[] = ast.body ?? [];
  for (const stmt of body) {
    const decl = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration'
      ? stmt.declaration
      : stmt;
    if (!decl) continue;
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        for (const id of patternIdentifiers(d.id)) topLevel.set(id.name, id);
      }
    } else if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) {
      topLevel.set(decl.id.name, decl.id);
    } else if (decl.type === 'ImportDeclaration') {
      for (const s of decl.specifiers ?? []) topLevel.set(s.local.name, s.local);
    }
  }
  for (const [start, binding] of importsByStart) {
    for (const [name, id] of topLevel) {
      if (id.start === start) importsByName.set(name, binding);
    }
  }

  const index = { importsByStart, topLevel, importsByName };
  indexCache.set(ast, index);
  return index;
}

// ---------------------------------------------------------------------------
// Resolving an export of a module
// ---------------------------------------------------------------------------

interface Resolver {
  readSource: (filePath: string) => string | null;
  visited: Set<string>;
}

function loadModule(filePath: string, r: Resolver): { source: string; ast: any } | null {
  const source = r.readSource(filePath);
  if (source == null) return null;
  const ast = parseCached(filePath, source);
  return ast ? { source, ast } : null;
}

/** Where `name` exported by the module `specifier` (seen from `fromPath`)
 *  is really declared.  `'*'` is the module itself. */
function resolveModuleExport(fromPath: string, specifier: string, name: string, r: Resolver, depth: number): DefinitionTarget | null {
  const target = resolveImportSourceFile(specifier, fromPath);
  if (!target) return null;
  if (name === '*' || !/\.(m|c)?jsx?$/.test(target)) return fileTop(target);
  return resolveExportInFile(target, name, r, depth) ?? fileTop(target);
}

/** A local name of `filePath` → its declaration, following imports. */
function resolveLocal(filePath: string, ast: any, name: string, r: Resolver, depth: number): DefinitionTarget | null {
  const index = indexModule(ast);
  const imported = index.importsByName.get(name);
  if (imported) {
    return resolveModuleExport(filePath, imported.specifier, imported.imported, r, depth + 1)
      ?? span(filePath, index.topLevel.get(name));
  }
  const decl = index.topLevel.get(name);
  return decl ? span(filePath, decl) : null;
}

/** An exported VALUE expression → where to land (identifiers are followed). */
function resolveValue(filePath: string, ast: any, value: any, fallback: any, r: Resolver, depth: number): DefinitionTarget {
  if (value?.type === 'Identifier') {
    return resolveLocal(filePath, ast, value.name, r, depth) ?? span(filePath, fallback);
  }
  const fromModule = moduleSourceOf(value);
  if (fromModule) {
    return resolveModuleExport(filePath, fromModule, '*', r, depth + 1) ?? span(filePath, fallback);
  }
  return span(filePath, fallback);
}

/** `module.exports = { a, b: c }` → the property named `name`, if any. */
function objectProperty(obj: any, name: string): any | null {
  if (obj?.type !== 'ObjectExpression') return null;
  for (const p of obj.properties) {
    if ((p.type === 'Property' || p.type === 'ObjectProperty') && !p.computed && nameOf(p.key) === name) return p;
    if ((p.type === 'Property' || p.type === 'ObjectProperty') && p.computed && isStringLiteral(p.key) && p.key.value === name) return p;
  }
  return null;
}

export function resolveExportInFile(filePath: string, name: string, r: Resolver, depth = 0): DefinitionTarget | null {
  if (depth > MAX_DEPTH) return null;
  const key = filePath + '#' + name;
  if (r.visited.has(key)) return null;
  r.visited.add(key);

  const mod = loadModule(filePath, r);
  if (!mod) return null;
  const { ast } = mod;
  const body: any[] = ast.body ?? [];
  const starExports: string[] = [];
  let cjsExportsValue: any = null;

  for (const stmt of body) {
    // ── ESM ────────────────────────────────────────────────────────────────
    if (stmt.type === 'ExportNamedDeclaration') {
      const decl = stmt.declaration;
      if (decl?.type === 'VariableDeclaration') {
        for (const d of decl.declarations) {
          for (const id of patternIdentifiers(d.id)) if (id.name === name) return span(filePath, id);
        }
      } else if (decl && decl.id && decl.id.name === name) {
        return span(filePath, decl.id);
      }
      for (const s of stmt.specifiers ?? []) {
        if (nameOf(s.exported) !== name) continue;
        const local = nameOf(s.local) ?? name;
        if (stmt.source && isStringLiteral(stmt.source)) {
          return resolveModuleExport(filePath, stmt.source.value, local, r, depth + 1) ?? span(filePath, s.exported);
        }
        return resolveLocal(filePath, ast, local, r, depth) ?? span(filePath, s.exported);
      }
    } else if (stmt.type === 'ExportDefaultDeclaration' && name === 'default') {
      const decl = stmt.declaration;
      if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) return span(filePath, decl.id);
      return resolveValue(filePath, ast, decl, stmt, r, depth);
    } else if (stmt.type === 'ExportAllDeclaration' && isStringLiteral(stmt.source)) {
      if (stmt.exported && nameOf(stmt.exported) === name) {
        return resolveModuleExport(filePath, stmt.source.value, '*', r, depth + 1) ?? span(filePath, stmt.exported);
      }
      if (!stmt.exported && name !== 'default') starExports.push(stmt.source.value);
    }

    // ── CommonJS (top-level statements) ────────────────────────────────────
    if (stmt.type !== 'ExpressionStatement') continue;
    const expr = stmt.expression;
    if (expr.type === 'AssignmentExpression' && expr.operator === '=') {
      // module.exports = …
      if (isModuleExports(expr.left)) {
        cjsExportsValue = expr.right;
        continue;
      }
      // exports.name = … / module.exports.name = …  (Babel first writes
      // `exports.default = void 0;` as a placeholder: skip that one)
      if (expr.left.type === 'MemberExpression' && isExportsObject(expr.left.object) && memberName(expr.left) === name
        && !(expr.right.type === 'UnaryExpression' && expr.right.operator === 'void')) {
        return resolveValue(filePath, ast, expr.right, expr.left.property, r, depth);
      }
    }
    // Object.defineProperty (exports, "name", { … })  (Babel / TypeScript output)
    if (expr.type === 'CallExpression' && expr.callee?.type === 'MemberExpression'
      && nameOf(expr.callee.object) === 'Object' && nameOf(expr.callee.property) === 'defineProperty'
      && isExportsObject(expr.arguments?.[0]) && isStringLiteral(expr.arguments?.[1]) && expr.arguments[1].value === name) {
      return span(filePath, expr.arguments[1]);
    }
  }

  // module.exports = <value>
  if (cjsExportsValue) {
    if (name === 'default') return resolveValue(filePath, ast, cjsExportsValue, cjsExportsValue, r, depth);
    const prop = objectProperty(cjsExportsValue, name);
    if (prop) return resolveValue(filePath, ast, prop.value, prop.key, r, depth);
    // module.exports = X; X.name = …   (FP-library: `parseReq.parseReqWith = …`)
    if (cjsExportsValue.type === 'Identifier') {
      const exportedName = cjsExportsValue.name;
      for (const stmt of body) {
        const expr = stmt.type === 'ExpressionStatement' ? stmt.expression : null;
        if (expr?.type === 'AssignmentExpression' && expr.left.type === 'MemberExpression'
          && nameOf(expr.left.object) === exportedName && memberName(expr.left) === name) {
          return resolveValue(filePath, ast, expr.right, expr.left.property, r, depth);
        }
      }
      // const X = { name: … }; module.exports = X
      const local = indexModule(ast).topLevel.get(exportedName);
      const declarator = local ? findDeclarator(ast, local) : null;
      const inner = declarator ? objectProperty(declarator.init, name) : null;
      if (inner) return resolveValue(filePath, ast, inner.value, inner.key, r, depth);
    }
    // `module.exports = require ("./x")` passes everything through.
    const passThrough = moduleSourceOf(cjsExportsValue);
    if (passThrough) return resolveModuleExport(filePath, passThrough, name, r, depth + 1);
  }

  // export * from "…": the first module that has the name.
  for (const spec of starExports) {
    const target = resolveImportSourceFile(spec, filePath);
    if (!target) continue;
    const hit = resolveExportInFile(target, name, r, depth + 1);
    if (hit) return hit;
  }

  // Default export of a CommonJS module (ESM/Babel interop).
  if (name === 'default' && cjsExportsValue) return span(filePath, cjsExportsValue);
  return null;
}

function findDeclarator(ast: any, id: any): any | null {
  let found: any = null;
  for (const stmt of ast.body ?? []) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (decl?.type !== 'VariableDeclaration') continue;
    for (const d of decl.declarations) if (d.id === id || d.id?.start === id.start) found = d;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Entry point: the definition for the cursor in the current file
// ---------------------------------------------------------------------------

/** The module specifier string literal at `offset`, if the cursor is on one. */
function specifierAt(ast: any, offset: number): any | null {
  let found: any = null;
  visit(ast, (node) => {
    if (found) return;
    let literal: any = null;
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration')
      && isStringLiteral(node.source)) literal = node.source;
    else if (node.type === 'ImportExpression' && isStringLiteral(node.source)) literal = node.source;
    else if (requireSpecifier(node)) literal = node.arguments[0];
    else if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression'
      && nameOf(node.callee.object) === 'require' && nameOf(node.callee.property) === 'resolve'
      && isStringLiteral(node.arguments?.[0])) literal = node.arguments[0];
    if (literal && contains(literal, offset)) found = literal;
  });
  return found;
}

/**
 * The definition(s) of whatever is under `offset` in `source` (the file at
 * `uri`), or null when this provider has no answer (keywords, literals, …).
 */
export function findCodeDefinition(
  source: string,
  uri: string,
  offset: number,
  options: CodeDefinitionOptions,
): CodeDefinition | null {
  const filePath = fileURLToPath(uri);
  const ast = parseCached(filePath, source);
  if (!ast) return null;
  const r: Resolver = { readSource: options.readSource ?? defaultReadSource, visited: new Set() };

  // 1. A module path: jump to the file.  The whole string is the link.
  const literal = specifierAt(ast, offset);
  if (literal !== null) {
    const target = resolveImportSourceFile(literal.value, filePath);
    return target ? { origin: { start: literal.start, end: literal.end }, targets: [fileTop(target)] } : null;
  }

  const index = indexModule(ast);
  let result: DefinitionTarget | null = null;
  let handled = false;
  let origin: { start: number; end: number } = { start: offset, end: offset };
  /** The first of `nodes` under the cursor becomes the link. */
  const originFrom = (...nodes: any[]): void => {
    const hit = nodes.find(n => n && contains(n, offset));
    if (hit) origin = { start: hit.start, end: hit.end };
  };

  visit(ast, (node, parent) => {
    if (handled) return;
    // 2. Inside an import / re-export statement.
    if (node.type === 'ImportSpecifier' && contains(node, offset) && parent && isStringLiteral(parent.source)) {
      handled = true;
      originFrom(node.imported, node.local);
      result = resolveModuleExport(filePath, parent.source.value, nameOf(node.imported) ?? node.local.name, r, 0);
    } else if ((node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') && contains(node, offset)
      && parent && isStringLiteral(parent.source)) {
      handled = true;
      originFrom(node.local);
      result = resolveModuleExport(filePath, parent.source.value, node.type === 'ImportDefaultSpecifier' ? 'default' : '*', r, 0);
    } else if (node.type === 'ExportSpecifier' && contains(node, offset)) {
      handled = true;
      originFrom(node.local, node.exported);
      const local = nameOf(node.local);
      if (local) {
        result = parent?.source && isStringLiteral(parent.source)
          ? resolveModuleExport(filePath, parent.source.value, local, r, 0)
          : resolveLocal(filePath, ast, local, r, 0);
      }
    } else if (node.type === 'MemberExpression' && !node.computed && contains(node.property, offset)) {
      // 3. `ns.name` on a namespace import / whole-module require, or
      //    `require ("x").name`.
      const prop = nameOf(node.property);
      const direct = moduleSourceOf(node.object);
      originFrom(node.property);
      if (prop && direct) {
        handled = true;
        result = resolveModuleExport(filePath, direct, prop, r, 0);
      } else if (prop && node.object.type === 'Identifier') {
        const group = findReferencesAtOffset(source, node.object.start);
        const def = group?.locations.find(l => l.isDefinition);
        const binding = def ? index.importsByStart.get(def.start) : undefined;
        if (binding && binding.imported === '*') {
          handled = true;
          result = resolveModuleExport(filePath, binding.specifier, prop, r, 0);
        }
      }
    }
  });
  if (handled) return result ? { origin, targets: [result] } : null;

  // 4. An identifier: find its binding (scope-aware).
  const group = findReferencesAtOffset(source, offset);
  const def = group?.locations.find(l => l.isDefinition);
  if (!def) return null;
  const clicked = group?.locations.find(l => l.start <= offset && offset <= l.end) ?? def;
  origin = { start: clicked.start, end: clicked.end };
  const binding = index.importsByStart.get(def.start);
  if (binding) {
    const target = resolveModuleExport(filePath, binding.specifier, binding.imported, r, 0);
    if (target) return { origin, targets: [target] };
  }
  if (!options.includeLocal) return null;
  return { origin, targets: [{ path: filePath, start: def.start, end: def.end }] };
}

/** Convert a target to an LSP-style location (uri + line/character range). */
export function targetUri(target: DefinitionTarget): string {
  return pathToFileURL(path.resolve(target.path)).href;
}
