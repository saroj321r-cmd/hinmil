// Memoised filesystem probes for module / sidecar resolution.
//
// Resolution asks the same existence questions over and over: every import
// of every file walks `resolveWithExtensions` (one stat per extension), the
// `node_modules` chain and the `package.json` chain up to the root.  Most of
// those probes MISS, and a missing path makes `fs.statSync` throw — building
// an Error per miss.  Profiling the FP-library lint showed `statSync` at ~16% of
// the total run time.
//
// The cache answers "is this a file / a directory" and "what does this
// package.json contain".  It never answers freshness questions (mtime/size
// stamps stay uncached in their callers), so a changed `.hm` sidecar is still
// detected by its stamp.
//
// Lifetime: the CLI lints a snapshot of the disk, so the cache lives for the
// process.  The LSP server calls `clearFsProbeCache()` on every watched-file
// event and on configuration reloads, so a created or deleted file is seen
// on the next validation.

import * as fs from 'fs';

type Kind = 'file' | 'dir' | null;

const kindCache = new Map<string, Kind>();
const jsonCache = new Map<string, Record<string, unknown> | null | undefined>();

function kindOf(p: string): Kind {
  const cached = kindCache.get(p);
  if (cached !== undefined) return cached;
  let kind: Kind = null;
  try {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (st) kind = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : null;
  } catch { /* EACCES, ENOTDIR, … — treat as missing */ }
  kindCache.set(p, kind);
  return kind;
}

/** True when `p` exists and is a regular file. */
export function isFile(p: string): boolean {
  return kindOf(p) === 'file';
}

/** True when `p` exists and is a directory. */
export function isDir(p: string): boolean {
  return kindOf(p) === 'dir';
}

/**
 * Parsed `package.json` (or any JSON file) at `p`.  Returns `undefined` when
 * the file does not exist and `null` when it exists but cannot be read or
 * parsed — callers distinguish "no package here" from "malformed package".
 * The returned object is shared: callers must not mutate it.
 */
export function readJsonCached(p: string): Record<string, unknown> | null | undefined {
  if (jsonCache.has(p)) return jsonCache.get(p);
  let result: Record<string, unknown> | null | undefined;
  if (!isFile(p)) {
    result = undefined;
  } else {
    try { result = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>; }
    catch { result = null; }
  }
  jsonCache.set(p, result);
  return result;
}

/** Forget every cached probe (LSP: on watched-file events / config reloads). */
export function clearFsProbeCache(): void {
  kindCache.clear();
  jsonCache.clear();
}
