// Cross-tag array-literal widening: when an array literal has no
// expected type AND no spread element, mixed-shape elements (records,
// functions, nested arrays, primitives) should widen to a Union element
// type instead of producing a "Cannot unify" diagnostic from the first
// pair of differently-shaped siblings.
//
// A spread element (`[...arr, x]`) protects the surrounding literal from
// widening: the spread imports its element type from a typed source
// whose stricter type must still drive sibling unification (cf. the
// `Class##field annotation enforces type at private assignment site`
// regression test in tests/jsSyntax.test.ts).

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString, typeToString } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

function inferLet(src: string, name: string): { type: string; diags: string[] } {
  const r = engine.infer(src);
  const offset = src.indexOf(name);
  const nt = (engine as unknown as { nodeTypes: Map<number, { type: import('../../src/hm/types').Type }> }).nodeTypes.get(offset);
  const type = nt ? prettyTypeToString(engine.subst.apply(nt.type)) : '(unknown)';
  return { type, diags: r.diagnostics.map(d => d.message) };
}

describe('cross-tag array-literal widening (no expected type, no spread)', () => {
  test('primitive mix [1, "2"] widens to [String | Number] without diags', () => {
    const r = inferLet('const xs = [1, "2"];', 'xs');
    expect(r.diags).toEqual([]);
    expect(r.type).toMatch(/^\[(String \| Number|Number \| String)\]$/);
  });

  test('three primitives [1, true, "x"] widen to a 3-member union', () => {
    const r = inferLet('const xs = [1, true, "x"];', 'xs');
    expect(r.diags).toEqual([]);
    expect(r.type).toContain('String');
    expect(r.type).toContain('Number');
    expect(r.type).toContain('Boolean');
  });

  test('cross-tag: number + nested array widens to [Number | [Number]]', () => {
    const r = inferLet('const xs = [1, [2, 3]];', 'xs');
    expect(r.diags).toEqual([]);
    expect(r.type).toMatch(/Number/);
    expect(r.type).toMatch(/\[Number\]/);
  });

  test('cross-tag: record + string widens (no Cannot-unify diag)', () => {
    const r = inferLet('const xs = [{x: 1}, "hi"];', 'xs');
    expect(r.diags.filter(d => d.includes('Cannot unify'))).toEqual([]);
    expect(r.type).toContain('String');
    expect(r.type).toContain('x ::');
  });

  test('cross-tag: function + number widens (no Cannot-unify diag)', () => {
    const r = inferLet('const xs = [function(){}, 1];', 'xs');
    expect(r.diags.filter(d => d.includes('Cannot unify'))).toEqual([]);
    expect(r.type).toContain('Number');
    expect(r.type).toContain('->');
  });

  test('mixed records with disjoint fields merge field-wise (existing record-merge path is preserved)', () => {
    const r = inferLet('const xs = [{x: 1}, {y: 2}];', 'xs');
    expect(r.diags).toEqual([]);
    // both x and y appear, each marked Undefined-merged
    expect(r.type).toContain('x ::');
    expect(r.type).toContain('y ::');
    expect(r.type).toContain('Undefined');
  });

  test('spread element preserves strict per-element unification (no widening)', () => {
    // Regression: `Class##field :: Array String` must keep enforcing
    // the annotation when the body does `this.#history = [...this.#history, 1]`.
    // The `[..., 1]` literal has a spread element, so widening is
    // disabled and the per-element unification of `Number` against
    // `String` (via the spread's element type) emits a diagnostic.
    const r = engine.infer(`
      // Counter :: () -> Counter
      // Counter##history :: Array String
      class Counter {
        #history = [];
        push() { this.#history = [...this.#history, 1]; }
      }
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some(d => /String|Number/.test(d.message))).toBe(true);
  });

  test('expected element type narrows widening (no widening when LHS is Array String)', () => {
    // When the array literal has an expected `Array String` type, the
    // strict per-element unification is honoured — `1` does not widen
    // to `String | Number`, it just fails.
    const r = engine.infer(`
      // xs :: Array String
      const xs = ["a", 1];
    `);
    expect(r.diagnostics.some(d => d.message.includes('Cannot unify'))).toBe(true);
  });

  test('top-level [String | Number] still satisfies a typed parameter that expects [b]', () => {
    // The widened type should remain compatible with a free-TVar parameter
    // — the parameter receives a single union element type bound to a free var.
    const r = engine.infer(`
      // foo :: [b] -> b
      const foo = (xs) => xs[0];
      const r = foo([1, "2"]);
    `);
    const noUnifyDiags = r.diagnostics.filter(d => d.message.includes('Cannot unify'));
    expect(noUnifyDiags).toEqual([]);
  });
});
