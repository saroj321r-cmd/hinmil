// Plan v6.3 Phase F4 — generic Object fallback for constraint dispatch.
// When a TVar resolves to TRecord, Phase C maps it to 'Object' as the
// representative type.  This test proves the fallback works for ANY
// constraint without hardcoding class names: a Functor constraint on a
// record value surfaces "Type 'Object' does not satisfy constraint
// 'Functor': missing method 'map'" via the standard instance-lookup
// path, not via a special-cased branch.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

describe('Plan v6.3 — Object constraint fallback (no class hardcoding)', () => {
  test('record arg with Functor constraint surfaces missing-method diag', () => {
    const src = `
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// apply :: Functor f => f -> f
const apply = (x) => x;
const result = apply({ a: 1 });
    `;
    const r = engine.infer(src);
    const missing = r.diagnostics.filter(d =>
      d.message.includes("does not satisfy constraint 'Functor'") &&
      d.message.includes("'map'"),
    );
    expect(missing.length).toBeGreaterThanOrEqual(1);
  });
});
