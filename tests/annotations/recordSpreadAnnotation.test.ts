// Plan v6.3 Phase A & B — annotation surface for spread-form records.
// Verifies that:
//   - the parser accepts multiple `...x` segments inside a record annotation
//     and lowers them to the internal `Merge` TCon, and
//   - the pretty-printer renders any `Merge` whose args are TRecords / TVars
//     back in spread form.
// Raw `Merge a b` annotation syntax remains accepted as input and is also
// rendered as spread form on output.

import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

describe('Plan v6.3 — record spread annotation surface', () => {
  test('two `...rest` segments parse and render in spread form', () => {
    const src = `
// f :: { ...a } -> { ...b } -> { ...a, ...b }
function f(a, b) { return null; }
const r = f;
    `;
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    // Should render the function with the spread form on every record arg.
    expect(ts).toContain('...a');
    expect(ts).toContain('...b');
    // Internal Merge name should NOT leak into the rendered form.
    expect(ts).not.toContain('Merge');
  });

  test('concrete fields mixed with two `...rest` segments parse and render', () => {
    const src = `
// f :: { x :: Number, ...a, ...b } -> { ...a, ...b }
function f(x) { return null; }
const r = f;
    `;
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('x :: Number');
    expect(ts).toContain('...a');
    expect(ts).toContain('...b');
    expect(ts).not.toContain('Merge');
  });

  test('raw `Merge a b` annotation parses and renders in spread form', () => {
    const src = `
// f :: a -> b -> Merge a b
function f(a, b) { return null; }
const r = f;
    `;
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('...a');
    expect(ts).toContain('...b');
    // We accept both `Merge a b` (raw) and `{ ...a, ...b }` (sugar) on
    // input; the pretty-printer prefers the spread form on output.
    expect(ts).not.toContain('Merge a b');
  });
});
