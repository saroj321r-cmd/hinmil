import * as path from 'path';

export const DEFAULT_FILE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.hm'] as const;
export const DEFAULT_FILE_INCLUDE = ['**/*'] as const;
export const DEFAULT_FILE_EXCLUDE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**'] as const;

export interface FileSelection {
  extensions: string[];
  include: string[];
  exclude: string[];
}
export interface PartialFileSelection {
  extensions?: unknown;
  include?: unknown;
  exclude?: unknown;
}

type Warn = (message: string) => void;

function strings(value: unknown, key: string, warn: Warn): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    warn(`[hinmil] Invalid files.${key}: expected an array of strings; ignoring.`);
    return undefined;
  }
  return [...new Set(value.map(item => item.trim()).filter(Boolean))];
}

export function normalizeExtension(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || /[*?]/.test(trimmed)) return null;
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

/** Merge defaults < editor < project. Arrays replace the previous layer. */
export function mergeFileSelection(
  layers: ReadonlyArray<unknown>,
  warn: Warn = () => {},
): FileSelection {
  const result: FileSelection = {
    extensions: [...DEFAULT_FILE_EXTENSIONS],
    include: [...DEFAULT_FILE_INCLUDE],
    exclude: [...DEFAULT_FILE_EXCLUDE],
  };
  for (const raw of layers) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      warn('[hinmil] Invalid files configuration: expected an object; ignoring.');
      continue;
    }
    const layer = raw as PartialFileSelection;
    const extensions = strings(layer.extensions, 'extensions', warn);
    if (extensions) {
      const valid = extensions.map(normalizeExtension).filter((x): x is string => Boolean(x));
      if (valid.length !== extensions.length) warn('[hinmil] Invalid extension in files.extensions; invalid entries ignored.');
      result.extensions = [...new Set(valid)];
    }
    const include = strings(layer.include, 'include', warn);
    if (include) result.include = include;
    const exclude = strings(layer.exclude, 'exclude', warn);
    if (exclude) result.exclude = exclude;
  }
  return result;
}

function escapeRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

/** Compiled glob patterns; selection globs are few and reused for every file. */
const compiledGlobs = new Map<string, RegExp>();

function compileGlob(glob: string): RegExp {
  const cached = compiledGlobs.get(glob);
  if (cached) return cached;
  const pattern = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; regex += '(?:.*/)?'; }
      else regex += '.*';
    } else if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else regex += escapeRegex(char);
  }
  const compiled = new RegExp(`${regex}$`);
  compiledGlobs.set(glob, compiled);
  return compiled;
}

/** Minimal, dependency-free glob matcher: `**`, `*` and `?`, with `/` separators. */
export function globMatches(relativePath: string, glob: string): boolean {
  const value = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return compileGlob(glob).test(value);
}

export function isSelectedFile(filePath: string, root: string, selection: FileSelection): boolean {
  const absolute = path.resolve(filePath);
  const relative = path.relative(path.resolve(root), absolute).replace(/\\/g, '/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return false;
  if (!selection.extensions.includes(path.extname(absolute).toLowerCase())) return false;
  // Literal semantics: an explicitly empty `include` selects no files.
  if (!selection.include.some(glob => globMatches(relative, glob))) return false;
  return !selection.exclude.some(glob => globMatches(relative, glob));
}

/** Add repeatable CLI extensions without replacing configured extensions. */
export function addExtensions(selection: FileSelection, extensions: readonly string[], warn: Warn = () => {}): FileSelection {
  const normalized: string[] = [];
  for (const extension of extensions) {
    const value = normalizeExtension(extension);
    if (value) normalized.push(value);
    else warn(`[hinmil] Invalid --ext value ${JSON.stringify(extension)}; ignoring.`);
  }
  return { ...selection, extensions: [...new Set([...selection.extensions, ...normalized])] };
}
