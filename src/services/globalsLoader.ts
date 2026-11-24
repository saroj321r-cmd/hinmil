// ============================================================================
// Globals loading — project config discovery and globals-file resolution.
//
// Extracted from server.ts.  These are pure(ish) file-reading helpers; the
// two runtime dependencies (open-document lookup and warning output) are
// injected so the functions stay testable and free of LSP wiring.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { HinMilProjectConfig, DEFAULT_GLOBALS_FILES, loadProjectConfig } from '../config';
import { wrapHmSource } from './files';

// Re-exported for backwards compatibility: the implementation moved to
// src/config.ts so the extension client can use it without pulling in the
// inference engine.
export { loadProjectConfig };

export interface GlobalsLoaderDeps {
  /** Return the live text of an open document for the given file URI, or null. */
  getOpenDocText(uri: string): string | null;
  /** Emit a warning (routed to the LSP console by the server). */
  warn(message: string): void;
}

/**
 * Resolve and load the globals file(s) based on project config.
 * `config.globals` is an array of relative paths; their contents are
 * concatenated (in order, blank-line separated).  A string value is
 * rejected with a warning.  Prefers reading from the open document
 * manager (live edits) over disk.
 */
export function loadGlobalsFile(
  rootDir: string,
  config: HinMilProjectConfig,
  deps: GlobalsLoaderDeps,
): { source: string | null; filePaths: string[] } {
  const tryRead = (filePath: string): string | null => {
    // Prefer open document (has unsaved edits)
    const uri = pathToFileURL(filePath).href;
    const open = deps.getOpenDocText(uri);
    if (open !== null) return open;
    // Fall back to disk
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch { /* file not found or unreadable */
      return null;
    }
  };

  // `.hm` globals files use the bare-line syntax (no leading `// `) and are
  // wrapped before being handed to the directive parser.
  const maybeWrap = (filePath: string, source: string | null): string | null => {
    if (source === null) return null;
    return filePath.endsWith('.hm') ? wrapHmSource(source) : source;
  };

  // Explicit list from config
  const rawGlobals = config.globals as unknown;
  if (rawGlobals !== undefined && rawGlobals !== null) {
    if (!Array.isArray(rawGlobals)) {
      deps.warn(
        `[hinmil] 'hinmil.globals' in project config must be an array of paths (got ${typeof rawGlobals}); ignoring.`,
      );
    } else {
      const parts: string[] = [];
      const paths: string[] = [];
      for (const rel of rawGlobals) {
        if (typeof rel !== 'string') continue;
        const resolved = path.resolve(rootDir, rel);
        paths.push(resolved);
        const raw = tryRead(resolved);
        if (raw === null) {
          deps.warn(`[hinmil] Globals file not found: ${resolved}`);
          continue;
        }
        const wrapped = maybeWrap(resolved, raw);
        if (wrapped !== null) parts.push(wrapped);
      }
      return {
        source: parts.length > 0 ? parts.join('\n') : null,
        filePaths: paths,
      };
    }
  }

  // Fallback: try conventional names in order — first match wins
  for (const name of DEFAULT_GLOBALS_FILES) {
    const candidate = path.join(rootDir, name);
    const raw = tryRead(candidate);
    if (raw !== null) {
      return { source: maybeWrap(candidate, raw), filePaths: [candidate] };
    }
  }
  // Nothing found — return the first conventional path so file-watching
  // still picks up a future create.
  const fallback = path.join(rootDir, DEFAULT_GLOBALS_FILES[0]);
  return { source: null, filePaths: [fallback] };
}
