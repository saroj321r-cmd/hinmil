// ============================================================================
// Babel parser backend — JSX parsing + proof that the parser is swappable
//
// WHAT THIS FILE DOES (in plain language): the engine talks to its parser
// only through the `ParserBackend` interface in `parsing.ts`.  This module
// implements that interface a second time, on top of `@babel/parser` (with
// its `estree` plugin so the output uses the standard ESTree shapes).  It
// serves two purposes:
//   1. JSX: the `jsx` plugin is always enabled here, and the parsing façade
//      routes JSX sources to this backend (acorn cannot parse JSX).  This is
//      why @babel/parser is a production dependency.
//   2. Contract proof: running the whole test suite with `HINMIL_PARSER=babel`
//      verifies that nothing outside the parsing façade depends on acorn.
//
// Normalizations performed here (the contract in `estree.ts`):
//   - the Program node is stretched to span the whole source (0..length);
//   - Babel comments (CommentLine/CommentBlock) are mapped to the ESTree
//     Line/Block shape with absolute start/end offsets;
//   - parse errors are translated to { message, start, end } records;
//   - loose parsing: Babel's `errorRecovery` handles many mistakes, but
//     unlike acorn-loose it still throws on some (e.g. `const x = ;`).
//     When it does, the offending LINE is blanked out with spaces — which
//     keeps every other node's absolute offsets intact — and the parse is
//     retried, so statements before and after the broken one survive.
// ============================================================================

import { parse, parseExpression as babelParseExpression } from '@babel/parser';
import type { Program, Comment, Node } from './estree';
import type { ParserBackend, ParseErrorInfo } from './parsing';

const BABEL_OPTS = {
  sourceType: 'module' as const,
  // `jsx` is enabled alongside `estree`: it only changes how `<` in
  // expression position is parsed (invalid JS otherwise), so plain
  // JavaScript sources parse identically with or without it.
  plugins: [['estree', { classFeatures: true }], 'jsx'] as import('@babel/parser').ParserPlugin[],
  attachComment: false,
};

/** Map Babel's comment objects onto the ESTree Line/Block shape. */
function mapComments(
  babelComments: ReadonlyArray<{ type: string; value: string; start?: number | null; end?: number | null; loc?: unknown }> | null | undefined,
  onComment: Comment[],
): void {
  if (!babelComments) return;
  for (const c of babelComments) {
    onComment.push({
      type: c.type === 'CommentLine' ? 'Line' : 'Block',
      value: c.value,
      start: c.start ?? 0,
      end: c.end ?? 0,
      // 1-based line / 0-based column positions, same shape as acorn's
      // `locations: true` output — several directive extractors use them.
      loc: c.loc,
    } as Comment);
  }
}

/** Run a Babel parse and normalize the result to the contract's Program. */
function parseToProgram(source: string, onComment: Comment[] | undefined, errorRecovery: boolean): Program {
  const file = parse(source, { ...BABEL_OPTS, errorRecovery });
  if (onComment) mapComments(file.comments, onComment);
  const program = file.program as unknown as Program;
  // The engine expects the Program to span the entire source.
  program.start = 0;
  program.end = source.length;
  return program;
}

/** Extract the character offset from a Babel syntax error, if present. */
function babelErrorPos(e: unknown): number | undefined {
  const errAny = e as { pos?: number; loc?: { index?: number } };
  if (typeof errAny.pos === 'number') return errAny.pos;
  if (typeof errAny.loc?.index === 'number') return errAny.loc.index;
  return undefined;
}

/**
 * Compute the closing tokens a half-typed source is missing at its end
 * (`)`, `]`, `}`, an unterminated quote, `\`` or `*​/`), by scanning the text
 * once while tracking bracket depth and string/comment state.  Appending
 * these at EOF repairs the most common mid-edit breakage — an unfinished
 * call/object/string on the line being typed — WITHOUT shifting any
 * existing node offsets.
 */
function missingClosers(text: string): string {
  const stack: string[] = [];
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    switch (mode) {
      case 'line':
        if (ch === '\n') mode = 'code';
        break;
      case 'block':
        if (ch === '*' && next === '/') { mode = 'code'; i++; }
        break;
      case 'single':
        if (ch === '\\') i++;
        else if (ch === "'" || ch === '\n') mode = 'code';
        break;
      case 'double':
        if (ch === '\\') i++;
        else if (ch === '"' || ch === '\n') mode = 'code';
        break;
      case 'template':
        if (ch === '\\') i++;
        else if (ch === '`') mode = 'code';
        else if (ch === '$' && next === '{') { stack.push('}'); mode = 'code'; i++; }
        break;
      case 'code':
        if (ch === '/' && next === '/') { mode = 'line'; i++; }
        else if (ch === '/' && next === '*') { mode = 'block'; i++; }
        else if (ch === "'") mode = 'single';
        else if (ch === '"') mode = 'double';
        else if (ch === '`') mode = 'template';
        else if (ch === '(') stack.push(')');
        else if (ch === '[') stack.push(']');
        else if (ch === '{') stack.push('}');
        else if (ch === ')' || ch === ']' || ch === '}') {
          if (stack[stack.length - 1] === ch) stack.pop();
        }
        break;
    }
  }
  let closers = '';
  if (mode === 'single') closers += "'";
  else if (mode === 'double') closers += '"';
  else if (mode === 'template') closers += '`';
  else if (mode === 'block') closers += '*/';
  for (let i = stack.length - 1; i >= 0; i--) closers += stack[i];
  return closers;
}

/**
 * Comment-only scan for the last-resort loose path: even when the code is
 * too broken to parse at all, the comments (where directives and HM
 * annotations live) are still perfectly extractable with a small tokenizer
 * that skips string literals.
 */
function collectCommentsOnly(text: string, onComment: Comment[]): void {
  let line = 1;
  let lineStart = 0;
  const posAt = (offset: number) => ({ line, column: offset - lineStart });
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\n') { line++; lineStart = i + 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === ch) break;
        else if (text[i] === '\n') { line++; lineStart = i + 1; if (ch !== '`') break; }
      }
    } else if (ch === '/' && next === '/') {
      const start = i;
      const startLoc = posAt(start);
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      onComment.push({
        type: 'Line', value: text.slice(start + 2, end), start, end,
        loc: { start: startLoc, end: posAt(end) },
      } as unknown as Comment);
      i = end - 1;
    } else if (ch === '/' && next === '*') {
      const start = i;
      const startLoc = posAt(start);
      let end = text.indexOf('*/', i + 2);
      end = end === -1 ? text.length : end + 2;
      for (let j = start; j < end; j++) {
        if (text[j] === '\n') { line++; lineStart = j + 1; }
      }
      onComment.push({
        type: 'Block', value: text.slice(start + 2, Math.max(start + 2, end - 2)), start, end,
        loc: { start: startLoc, end: posAt(end) },
      } as unknown as Comment);
      i = end - 1;
    }
  }
}

/**
 * Clamp every node's offsets to the real source length.  Used after parsing
 * repaired text that had closing tokens appended at EOF: nodes closed by the
 * appended tokens would otherwise end past the source, and the engine's
 * offset-keyed lookups expect ends within it (acorn-loose behaves that way).
 */
function clampOffsets(node: unknown, max: number): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) clampOffsets(item, max);
    return;
  }
  const n = node as { type?: unknown; start?: unknown; end?: unknown };
  if (typeof n.type === 'string') {
    if (typeof n.start === 'number' && n.start > max) n.start = max;
    if (typeof n.end === 'number' && n.end > max) n.end = max;
  }
  for (const key of Object.keys(n)) {
    if (key === 'loc') continue;
    const v = (n as Record<string, unknown>)[key];
    if (v && typeof v === 'object') clampOffsets(v, max);
  }
}

export const babelBackend: ParserBackend = {
  name: 'babel',

  parseStrict(source, onComment) {
    return parseToProgram(source, onComment, false);
  },

  parseLoose(source, onComment) {
    // First try Babel's own error recovery; it patches over many mistakes.
    try {
      return parseToProgram(source, onComment, true);
    } catch { /* fall through to the repair loop below */ }

    // Repair loop.  Each iteration parses the working text PLUS whatever
    // closing tokens it is still missing at EOF (`)`, `}`, a quote, …) —
    // that alone fixes the most common mid-edit state, an unfinished
    // call/object/string (`const x = add(1, 2`).  When the parse still
    // fails at a position inside the text, apply a surgical repair there,
    // escalating per position: (1) replace the offending character with
    // `0` — turns `const x = ;` into `const x = 0` and `sort(())` into
    // `sort((0))`; (2) replace it with a space; (3) blank the whole line.
    // Every repair keeps the text length identical, so all other nodes keep
    // their absolute offsets.
    let text = source;
    const attemptsAt = new Map<number, number>();
    let lastRepairPos: number | null = null;
    for (let attempt = 0; attempt < 50; attempt++) {
      const closers = missingClosers(text);
      try {
        const program = parseToProgram(text + closers, onComment, true);
        if (closers) clampOffsets(program, source.length);
        program.end = source.length;
        return program;
      } catch (e) {
        let pos = babelErrorPos(e);
        if (pos !== undefined && (pos >= text.length || text[pos] === '\n')) {
          // The error moved into the appended closers / EOF — the previous
          // repair wasn't enough; escalate at the same spot instead.
          pos = lastRepairPos ?? undefined;
        }
        if (pos === undefined || pos >= text.length || text[pos] === '\n') break;
        const tries = attemptsAt.get(pos) ?? 0;
        attemptsAt.set(pos, tries + 1);
        lastRepairPos = pos;
        let repaired: string;
        if (tries === 0) {
          repaired = text.slice(0, pos) + '0' + text.slice(pos + 1);
        } else if (tries === 1) {
          repaired = text.slice(0, pos) + ' ' + text.slice(pos + 1);
        } else if (tries === 2) {
          const lineStart = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
          let lineEnd = text.indexOf('\n', pos);
          if (lineEnd === -1) lineEnd = text.length;
          if (lineEnd <= lineStart) break;
          repaired = text.slice(0, lineStart) + ' '.repeat(lineEnd - lineStart) + text.slice(lineEnd);
        } else {
          break; // this position resists all repairs — give up
        }
        if (repaired === text) break; // no progress
        text = repaired;
      }
    }
    // Last resort: an empty best-effort Program spanning the source.  Still
    // collect the comments (directives/annotations live there and remain
    // extractable no matter how broken the code is) via a comment-only scan.
    if (onComment) collectCommentsOnly(source, onComment);
    return {
      type: 'Program',
      sourceType: 'module',
      body: [],
      start: 0,
      end: source.length,
    } as unknown as Program;
  },

  parseExpression(source) {
    return babelParseExpression(source, BABEL_OPTS) as unknown as Node;
  },

  // Babel errors carry a `pos` offset (and `loc.index`) plus a trailing
  // "(line:col)" suffix on the message.
  describeParseError(e, source): ParseErrorInfo {
    const msg = e instanceof Error ? e.message : String(e);
    const pos = babelErrorPos(e);
    let start = pos ?? 0;
    let end = Math.min(start + 1, source.length);
    if (end <= start) end = source.length;
    const message = msg.replace(/\s*\(\d+:\d+\)\s*$/, '');
    return { message, start, end };
  },
};
