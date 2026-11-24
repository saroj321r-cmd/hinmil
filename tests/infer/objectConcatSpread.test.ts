// Plan v6.3 Phase F3 — end-to-end Object#concat with a user-declared
// Semigroup instance.  The user opts into row-merge semantics for Object
// by writing the spread-form annotation on the prototype method; the
// core does NOT hardcode Object#concat anywhere.

import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

describe('Plan v6.3 — Object#concat (user-declared Semigroup instance)', () => {
  test('concat({ a: 1 })({ b: 2 }) infers as { a :: Number, b :: Number }', () => {
    const src = `
// ::constraint Semigroup a { a :: { concat :: a ~> a -> a } }
// Object#concat :: { ...a } ~> { ...b } -> { ...a, ...b }
// concat :: Semigroup a => a -> a -> a
const concat = a => b => a.concat(b);
const result = concat({ a: 1 })({ b: 2 });
    `;
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    // Generic 'Object' fallback in validatePendingConstraints lets the
    // user-declared Object#concat satisfy the Semigroup constraint, so
    // no constraint diagnostic should surface.
    const semigroupDiags = r.diagnostics.filter(d =>
      d.message.includes('Semigroup'),
    );
    expect(semigroupDiags).toHaveLength(0);
    expect(ts).toContain('a :: Number');
    expect(ts).toContain('b :: Number');
  });
});
