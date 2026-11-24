import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

describe('row-spread annotation validation', () => {
  test('row-spread merge annotation does not produce "returns a generic value" diagnostic', () => {
    // The body uses Object.keys(...).reduce(...) which HM cannot structurally
    // derive as Merge(a, b); the annotation is authoritative. The "wildcard
    // leak" guard must recognise that TRow ids in scheme.vars make the
    // annotation return polymorphic.
    const src = `
// merge :: (a, b) -> { ...a, ...b }
const merge = (obj1, obj2) =>
  Object.keys(obj1).reduce((acc, k) => ({ ...acc, [k]: obj2[k] }), obj1);
`;
    // Run several times to flush out any unification-order non-determinism.
    for (let i = 0; i < 5; i++) {
      resetTypeVarCounter();
      const r = new InferenceEngine().infer(src);
      const bad = r.diagnostics.filter(d =>
        d.message.includes('returns a generic value but annotation expects'),
      );
      expect(bad).toEqual([]);
    }
  });

  test('concrete-return annotation still flags wildcard-leaking body', () => {
    // Sanity: the diagnostic is not over-suppressed. A concrete return type
    // (no TVar/TRow/TLabel anchors) should still surface mismatches when the
    // body returns something unrelated.
    const r = engine.infer(`
// f :: Number -> String
const f = (x) => x;
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('identity annotation a -> a remains accepted', () => {
    const r = engine.infer(`
// id :: a -> a
const id = (x) => x;
    `);
    const bad = r.diagnostics.filter(d =>
      d.message.includes('returns a generic value but annotation expects'),
    );
    expect(bad).toEqual([]);
  });
});
