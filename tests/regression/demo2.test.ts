// Tests for sample/demo2.js — a regression sample that combines:
//   • RTask constructor with multi-arg callback
//   • Functor/Chain/Semigroup constraints (provided via globals.hm)
//   • Curry helpers, Maybe/Either, traverse, etc.
//
// Also covers the narrowToIdentifier fix that keeps "Cannot unify"
// diagnostics on the function signature instead of the entire body.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { wrapHmSource } from '../../src/services/files';

const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
const globalsSrc = wrapHmSource(fs.readFileSync(path.join(sampleDir, 'globals.hm'), 'utf8'));

function inferSample(file: string) {
  const filePath = path.join(sampleDir, file);
  const fileUri = pathToFileURL(filePath).href;
  const src = fs.readFileSync(filePath, 'utf8');
  const docs = new TextDocuments<TextDocument>(TextDocument as any);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  const resolver = ctx.createImportResolver(fileUri);
  const eng = new InferenceEngine();
  eng.globalsSource = globalsSrc;
  const result = eng.infer(src, undefined, resolver);
  return { src, result };
}

function offsetToLine(src: string, offset: number): number {
  return src.slice(0, offset).split('\n').length;
}

describe('sample/demo2.js (regression sample)', () => {
  test('infers with only the expected missing-field diagnostic', () => {
    const { result } = inferSample('demo2.js');
    const messages = result.diagnostics.map(d => d.message);
    // `task...fork(console.log, console.log, {})` passes an empty env where
    // `{ leader :: Person }` is required.  Nested returns are
    // checked against the annotated return type too, which also exposes a
    // real bug in the sample: `pFn2 :: … -> Promise e Number` returns
    // `Promise.resolve (x + y)` with `y :: String` in its typeof branch.
    expect(messages).toEqual([
      "Missing required field 'leader' on argument; expected '{ leader :: Person }'",
      "Type mismatch: Cannot unify 'String' with 'Number'",
    ]);
  });
});

// ---------------------------------------------------------------------------
// "Cannot unify" diagnostics on a callback argument should point at the
// callback's parameter list (its signature), not its multi-line body.
// ---------------------------------------------------------------------------

describe('Cannot unify on arrow-function argument — narrowed to params', () => {
  test('multi-line arrow body does not get fully underlined', () => {
    const src = [
      // The callback must return a String; its Number result is the
      // mismatch (a `-> ()` slot would ignore the result).
      '// callMe :: ((Number, Number, Number) -> String) -> ()',
      'const callMe = fn => fn(1, 2, 3)',
      '',
      'callMe((a) => {',
      '  let x = 1;',
      '  let y = 2;',
      '  let z = 3;',
      '  return x + y + z;',
      '})',
    ].join('\n');

    const eng = new InferenceEngine();
    const result = eng.infer(src);
    expect(result.diagnostics.length).toBeGreaterThan(0);

    // Find the "Cannot unify" diagnostic on the callback.
    const unifyDiag = result.diagnostics.find(d =>
      /Cannot unify|not callable|argument/.test(d.message),
    );
    expect(unifyDiag).toBeDefined();

    const startLine = offsetToLine(src, unifyDiag!.start);
    const endLine = offsetToLine(src, unifyDiag!.end);
    // Range must stay on the arrow's signature line — never spill into
    // the multi-line body below.
    expect(endLine - startLine).toBeLessThanOrEqual(0);

    // And must NOT cover the entire body span.
    const underlined = src.slice(unifyDiag!.start, unifyDiag!.end);
    expect(underlined).not.toContain('let y = 2');
    expect(underlined).not.toContain('return x + y + z');
  });

  test('arrow function with no params still narrows away from body', () => {
    const src = [
      '// take3 :: ((Number, Number) -> Number) -> Number',
      'const take3 = fn => fn(1, 2)',
      '',
      'take3(() => {',
      '  return "hello"',
      '})',
    ].join('\n');

    const eng = new InferenceEngine();
    const result = eng.infer(src);
    const unifyDiag = result.diagnostics.find(d =>
      d.message.includes('Cannot unify'),
    );
    expect(unifyDiag).toBeDefined();
    const startLine = offsetToLine(src, unifyDiag!.start);
    const endLine = offsetToLine(src, unifyDiag!.end);
    expect(endLine - startLine).toBeLessThanOrEqual(0);
  });
});
