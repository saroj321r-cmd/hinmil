// ============================================================================
// Per-document caches and edit-tracking state for the language server.
//
// Extracted from server.ts.  These module-level singletons hold the
// per-URI validation caches and the word-boundary-gate bookkeeping;
// server.ts imports and mutates them directly (same identity as before).
// ============================================================================

import { Diagnostic } from 'vscode-languageserver/node';
import { InferenceResult } from '../index';

/** Cached inference results per document URI — used by code actions and other features. */
export const cachedResults = new Map<string, InferenceResult>();

/**
 * Per-document source-text fingerprint.  When `validateTextDocument` is
 * called and the source text is identical to the last seen value (e.g. the
 * user pressed undo/redo, or the editor sent overlapping change notifications
 * that produced the same final document), we skip the expensive re-parse +
 * re-inference and reuse the cached `InferenceResult` directly.  Cleared
 * in `onDidClose` along with `cachedResults`.
 */
export const lastValidatedSource = new Map<string, string>();

/** Per-document globals generation at the time it was last validated. */
export const validatedUnderGeneration = new Map<string, number>();

/**
 * Per-document snapshot of the diagnostics array we most recently published
 * for that URI.  The source-identity short-circuit re-publishes this snapshot
 * so the editor always reflects the diagnostics that correspond to the file's
 * current text — without this, an undo back to a previously validated text
 * would leave the editor showing whichever diagnostics the LAST validation
 * pass had emitted (which, for the intermediate edit, may differ from the
 * original validation's diagnostics).
 */
export const lastPublishedDiagnostics = new Map<string, Diagnostic[]>();

/**
 * Per-document snapshot of the import-module-specifier list extracted from
 * the source on the last validation pass.  When the new validation pass
 * extracts the same list, we can skip the eager dependency pre-warm loop
 * (which calls `inferFileAndCacheExports` for every imported file) — the
 * underlying file-level cache is idempotent, but iterating + resolving
 * specifiers on every keystroke adds up on files with many imports.
 */
export const lastImportSpecifiers = new Map<string, string[]>();

/**
 * Per-document snapshot of the source text observed at the start of the
 * previous `onDidChangeContent` event.  Used by the word-boundary gate
 * (see {@link computeCaretOffset}) to derive the caret position of the
 * latest edit by diffing prev↔curr.  Distinct from `lastValidatedSource`,
 * which only updates after a successful validation pass.
 */
export const lastSeenSource = new Map<string, string>();

/**
 * Per-document {offset, at} for the most recent edit.  `offset` is the
 * caret position immediately after the edit; `at` is the wall-clock time
 * the edit arrived.  Read by the word-boundary gate in
 * `validateTextDocument` to decide whether the cursor is currently
 * mid-identifier (in which case validation is deferred to avoid
 * generating noisy `Unbound variable: 'foo'` diagnostics on incomplete
 * identifiers).
 */
export const lastEditPosition = new Map<string, { offset: number; at: number }>();

/**
 * Request-path inference cache: recent inference results keyed by the EXACT
 * source text that was inferred (a few slots per URI — the original text
 * plus ASI-patched variants).  Request handlers (hover, signature help,
 * completion providers) that need to infer a not-yet-validated document
 * version consult this first, so the N providers of a single completion
 * request — and repeated requests on an unchanged document — pay for at
 * most ONE inference per source version instead of one each.  Edits
 * self-invalidate (the key is the exact text); dependency/config changes
 * must evict entries explicitly (see `invalidateFileSelf` /
 * `reloadGlobals` in server.ts).
 */
export const requestInferCache = new Map<string, Array<{ key: string; result: InferenceResult }>>();

/** Max cached source-text variants per URI in {@link requestInferCache}. */
export const REQUEST_INFER_SLOTS = 3;

/** Wall-clock budget (ms) within which the word-boundary gate defers
 *  validation when the caret is mid-identifier.  After this elapsed
 *  without further edits we accept the user really paused inside a
 *  partial word and validate anyway (any `Unbound variable` diagnostic
 *  is then legitimate). */
export const WORD_BOUNDARY_GATE_MS = 3000;

/** Word-character predicate used to identify identifier boundaries. */
export function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && (
    (c >= 'a' && c <= 'z')
    || (c >= 'A' && c <= 'Z')
    || (c >= '0' && c <= '9')
    || c === '_' || c === '$'
  );
}

/**
 * Compute the caret offset of the latest edit by diffing the previous
 * text against the current text.  The caret is, by construction, at the
 * end of the inserted (or deleted) range.  Pure / synchronous / O(n).
 */
export function computeCaretOffset(prev: string, curr: string): number {
  let p = 0;
  const maxP = Math.min(prev.length, curr.length);
  while (p < maxP && prev.charCodeAt(p) === curr.charCodeAt(p)) p++;
  let s = 0;
  const maxS = Math.min(prev.length - p, curr.length - p);
  while (
    s < maxS
    && prev.charCodeAt(prev.length - 1 - s) === curr.charCodeAt(curr.length - 1 - s)
  ) s++;
  return curr.length - s;
}
