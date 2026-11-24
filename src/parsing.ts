// ============================================================================
// Parsing façade — the single place where a JavaScript parser is invoked
//
// WHAT THIS FILE DOES (in plain language): before the type checker can say
// anything about a piece of JavaScript, the text has to be turned into a
// tree structure (an AST).  This module is the only door through which that
// happens.  The concrete parser library lives behind a small `ParserBackend`
// interface with four operations:
//
//   - `parseStrict`  — normal parsing; throws on a syntax error.
//   - `parseLoose`   — forgiving parsing that produces a best-effort tree
//                      for half-typed / broken sources.  Essential for an
//                      editor: files are broken most of the time while the
//                      user is typing.
//   - `parseExpression` — parse a single standalone expression (used for
//                      synthesized snippets like `new Function(...)` bodies).
//   - `describeParseError` — translates the parser's own error object into
//                      a plain { message, start, end } record, stripping
//                      parser-specific decorations.
//
// TWO BACKENDS exist today:
//   - acorn (+ acorn-loose)  — the default fast path for plain JavaScript.
//   - @babel/parser          — shipped with the extension since JSX support:
//                              its `jsx` plugin is always on, so the façade
//                              routes JSX sources to it (see below).  It can
//                              also be selected for EVERYTHING with the
//                              environment variable  HINMIL_PARSER=babel
//                              (see `parsing-babel.ts`).
//
// JSX DISPATCH: acorn has no JSX support (and acorn-loose cannot take
// plugins), so the façade decides per call:
//   - `parseStrict`: try acorn first (hot path unchanged); when it throws,
//     retry with the Babel backend — if that succeeds the source was JSX.
//   - `parseLoose`: acorn-loose never throws, it would silently mangle JSX —
//     so a cheap sniff (`</` or `/>` — every JSX element must close one of
//     those two ways) routes likely-JSX sources to Babel's loose parser.
//     False positives (e.g. `"</div>"` in a string) are harmless: Babel is
//     a fully correct JS parser too, just marginally slower.
//   - `parseExpression`: stays acorn — synthesized snippets never hold JSX.
//
// No other src module may import a parser library for PARSING.  (Importing
// the AST *types* is done via `estree.ts`; typed traversal via `walking.ts`.)
// Adding/replacing a parser therefore means writing one backend object that
// honours the contract documented in `estree.ts` and enforced by
// tests/parserContract.test.ts.
// ============================================================================

import * as acorn from 'acorn';
import * as acornLoose from 'acorn-loose';
import type { Program, Comment, Node } from './estree';

/** Normalized description of a syntax error raised by {@link parseStrict}. */
export interface ParseErrorInfo {
  /** Human-readable message, without parser-specific "(line:col)" suffixes. */
  message: string;
  /** Start offset of the offending token. */
  start: number;
  /** End offset (always > start, clamped to the source length). */
  end: number;
}

/**
 * Everything a concrete parser library must provide to power the engine.
 * See the header comment and `estree.ts` for the exact contract.
 */
export interface ParserBackend {
  /** Backend identifier, e.g. 'acorn' or 'babel' (used in test output). */
  name: string;
  parseStrict(source: string, onComment?: Comment[]): Program;
  parseLoose(source: string, onComment?: Comment[]): Program;
  parseExpression(source: string): Node;
  describeParseError(e: unknown, source: string): ParseErrorInfo;
}

// ---------------------------------------------------------------------------
// The acorn backend (production default)
// ---------------------------------------------------------------------------

/** Shared acorn parse options for ES-module source code. */
const ACORN_OPTS: acorn.Options = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  locations: true,
};

const acornBackend: ParserBackend = {
  name: 'acorn',

  parseStrict(source, onComment) {
    return acorn.parse(
      source,
      onComment ? { ...ACORN_OPTS, onComment: onComment as unknown as acorn.Comment[] } : ACORN_OPTS,
    ) as unknown as Program;
  },

  parseLoose(source, onComment) {
    return acornLoose.parse(
      source,
      onComment ? { ...ACORN_OPTS, onComment: onComment as unknown as acorn.Comment[] } : ACORN_OPTS,
    ) as unknown as Program;
  },

  parseExpression(source) {
    return acorn.parseExpressionAt(source, 0, { ecmaVersion: 'latest' }) as unknown as Node;
  },

  // Acorn attaches `pos` / `raisedAt` offsets and a trailing "(line:col)"
  // suffix on the message.  Babel errors (possible here via the JSX retry in
  // the façade's parseStrict) carry `pos` / `loc.index` and the same message
  // suffix, so the fallbacks below handle both shapes.
  describeParseError(e, source) {
    const msg = e instanceof Error ? e.message : String(e);
    const errAny = e as { pos?: number; raisedAt?: number; loc?: { index?: number } };
    let start = typeof errAny.pos === 'number' ? errAny.pos
      : typeof errAny.loc?.index === 'number' ? errAny.loc.index : 0;
    let end = typeof errAny.raisedAt === 'number' ? errAny.raisedAt : start;
    if (end <= start) end = Math.min(start + 1, source.length);
    if (start === 0 && end === 0) end = source.length;
    // Strip trailing "(line:col)" — the LSP conveys the location through the
    // diagnostic range instead.
    const message = msg.replace(/\s*\(\d+:\d+\)\s*$/, '');
    return { message, start, end };
  },
};

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/**
 * Pick the initial backend.  Setting HINMIL_PARSER=babel selects the Babel
 * backend for ALL parsing (used by the parser contract tests to verify
 * parser independence).  The require is lazy so the acorn hot path never
 * pays for it.
 */
function selectInitialBackend(): ParserBackend {
  if (process.env.HINMIL_PARSER === 'babel') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { babelBackend } = require('./parsing-babel') as typeof import('./parsing-babel');
      return babelBackend;
    } catch (e) {
      throw new Error(
        'HINMIL_PARSER=babel requires the @babel/parser devDependency (npm install). ' +
        `Underlying error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return acornBackend;
}

let activeBackend: ParserBackend = selectInitialBackend();

/** The currently active parser backend (mainly for test output). */
export function getParserBackend(): ParserBackend {
  return activeBackend;
}

/** Test hook: swap the active parser backend. Returns the previous one. */
export function setParserBackend(backend: ParserBackend): ParserBackend {
  const prev = activeBackend;
  activeBackend = backend;
  return prev;
}

/** The built-in backends, exported for the parser contract test. */
export function builtinBackends(): ParserBackend[] {
  const backends = [acornBackend];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { babelBackend } = require('./parsing-babel') as typeof import('./parsing-babel');
    backends.push(babelBackend);
  } catch {
    // @babel/parser not installed (production) — acorn only.
  }
  return backends;
}

// ---------------------------------------------------------------------------
// JSX routing helpers
// ---------------------------------------------------------------------------

let cachedJsxBackend: ParserBackend | null | undefined;

/**
 * The Babel backend doubles as the JSX parser (its `jsx` plugin is always
 * enabled).  Loaded lazily and cached; returns null when @babel/parser is
 * unavailable (JSX support then degrades to acorn's behaviour).
 */
function jsxBackend(): ParserBackend | null {
  if (cachedJsxBackend === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { babelBackend } = require('./parsing-babel') as typeof import('./parsing-babel');
      cachedJsxBackend = babelBackend;
    } catch {
      cachedJsxBackend = null;
    }
  }
  return cachedJsxBackend;
}

/**
 * Cheap textual sniff for JSX: every JSX element ends with either a
 * self-closing `/>` or a closing tag starting with `</` (fragments close
 * with `</>`), so one of the two substrings is guaranteed to appear in any
 * source that uses JSX.  False positives only cost a Babel (still correct)
 * parse.
 */
export function looksLikeJsx(source: string): boolean {
  return source.includes('</') || source.includes('/>');
}

// ---------------------------------------------------------------------------
// Public parsing API (delegates to the active backend)
// ---------------------------------------------------------------------------

/**
 * Parse `source` strictly; throws on the first syntax error.
 * Pass an array as `onComment` to collect every comment encountered
 * (HM annotations live in comments, so most callers want them).
 *
 * When the default acorn backend rejects the source, a JSX retry with the
 * Babel backend happens transparently (each attempt gets a fresh comment
 * array so a failed attempt cannot leave partial comments behind).
 */
export function parseStrict(source: string, onComment?: Comment[]): Program {
  if (activeBackend !== acornBackend) return activeBackend.parseStrict(source, onComment);
  const acornComments: Comment[] | undefined = onComment ? [] : undefined;
  try {
    const ast = acornBackend.parseStrict(source, acornComments);
    if (onComment && acornComments) onComment.push(...acornComments);
    return ast;
  } catch (acornError) {
    const jsx = jsxBackend();
    if (jsx) {
      const jsxComments: Comment[] | undefined = onComment ? [] : undefined;
      try {
        const ast = jsx.parseStrict(source, jsxComments);
        if (onComment && jsxComments) onComment.push(...jsxComments);
        return ast;
      } catch (babelError) {
        // A JSX-looking source with a real syntax error: Babel's error points
        // at the actual problem, acorn's at the first (valid) JSX token.
        if (looksLikeJsx(source)) throw babelError;
      }
    }
    throw acornError;
  }
}

/**
 * Parse `source` with the error-tolerant parser: syntax errors are patched
 * over so a best-effort tree is still produced for the valid portions.
 * Used as the fallback when `parseStrict` throws, so hover / completion /
 * diagnostics keep working while the user is mid-edit.
 *
 * Likely-JSX sources are routed to the Babel loose parser (acorn-loose
 * would silently mangle JSX instead of failing).
 */
export function parseLoose(source: string, onComment?: Comment[]): Program {
  if (activeBackend !== acornBackend) return activeBackend.parseLoose(source, onComment);
  if (looksLikeJsx(source)) {
    const jsx = jsxBackend();
    if (jsx) return jsx.parseLoose(source, onComment);
  }
  return acornBackend.parseLoose(source, onComment);
}

/**
 * Parse a single standalone EXPRESSION (not a whole module) and return its
 * node.  Used for synthesized snippets, e.g. inferring the body passed to
 * `new Function('a', 'b', 'return a + b')`.  Throws on a syntax error.
 */
export function parseExpression(source: string): Node {
  return activeBackend.parseExpression(source);
}

/**
 * Convert the exception thrown by {@link parseStrict} into a normalized
 * `{ message, start, end }` record.  The backend is the ONE place that knows
 * the shape of its parser's error objects.
 */
export function describeParseError(e: unknown, source: string): ParseErrorInfo {
  return activeBackend.describeParseError(e, source);
}
