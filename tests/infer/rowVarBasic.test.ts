/**
 * W2 verification — TRow as a first-class, disjoint type variant.
 */

import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter, Type, TRecord, TRow } from '../../src/hm/types';
import { parseTypeSignature } from '../../src/hm/typeParser';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

describe('W2 — TRow basic behaviour', () => {
  test('parser emits TRow (not TVar) for record-rest spread', () => {
    const scheme = parseTypeSignature('{ x :: Number, ...r } -> { ...r }');
    const t = scheme.type;
    expect(t.tag).toBe('TFun');
    const param = (t as { tag: 'TFun'; param: Type }).param as TRecord;
    expect(param.tag).toBe('TRecord');
    expect(param.rest).toBeDefined();
    expect(param.rest!.tag).toBe('TRow');
    expect((param.rest as TRow).name).toBe('r');
  });

  test('quantified row-var names survive instantiation', () => {
    const src = `
// merge :: { ...a } -> { ...b } -> { ...a, ...b }
function merge(x, y) { return null; }
const r = merge;
    `;
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('...a');
    expect(ts).toContain('...b');
    expect(ts).not.toContain('Merge');
  });

  test('row-vs-row record unification succeeds for compatible records', () => {
    const src = `
// f :: { x :: Number, ...a } -> Number
function f(p) { return p.x; }
const out = f({ x: 1, y: "h" });
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });
});
