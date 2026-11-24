// Regression: inference must be deterministic across repeated runs.  Stale
// state in the cached builtin environment (baked-in type-var IDs colliding
// with per-run fresh IDs) previously made the same source intermittently
// produce a spurious `Cannot unify 'Number | String' with 'Boolean'` error —
// the result flipped when an offset changed (e.g. adding/removing a `;`).

import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

function analyze(src: string): { ts: string; diags: string[] } {
  clearCustomMethods();
  resetTypeVarCounter();
  const engine = new InferenceEngine();
  const r = engine.infer(src);
  const b = r.topLevelBindings.get('c1');
  return {
    ts: b ? typeToString(b.type) : '<none>',
    diags: r.diagnostics.map(d => d.message),
  };
}

const OVERLOADED = `
// concat :: ([a], [b]) -> [a | b]
// concat :: (String, String) -> String
const concat = (arr, arr2) => arr.concat(arr2);
const c1 = concat([1, 2, "String"], [1, true]);
`;

describe('Inference determinism (P6)', () => {
  test('repeated runs of the same source are identical and error-free', () => {
    const baseline = analyze(OVERLOADED);
    expect(baseline.diags).toHaveLength(0);
    for (let i = 0; i < 10; i++) {
      const r = analyze(OVERLOADED);
      expect(r.diags).toEqual(baseline.diags);
      expect(r.ts).toEqual(baseline.ts);
    }
  });

  test('offset-shifted variants (trailing semicolons) stay error-free', () => {
    // Interleave variants to maximise the chance of cross-run state leakage.
    const variants = [
      OVERLOADED,
      OVERLOADED.replace('[1, true]);', '[1, true]) ;'),
      OVERLOADED + '\n;',
      OVERLOADED.replace('arr.concat(arr2)', 'arr.concat(arr2) '),
    ];
    for (let i = 0; i < 5; i++) {
      for (const v of variants) {
        const r = analyze(v);
        expect(r.diags).toHaveLength(0);
      }
    }
  });
});
