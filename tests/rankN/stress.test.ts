// =============================================================================
// Rank-N phase 8 — performance stress test
//
// A file with ~100 rank-2 annotations (plus usages) must stay well within a
// normal inference budget: skolemization/subsumption work only happens at
// `forall` sites and must not blow up.
// =============================================================================

import { inferSource } from '../helpers/infer';

function makeStressSource(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`
// apply${i} :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const apply${i} = f => (x, y) => [f(x), f(y)];
const ok${i} = apply${i}(v => v)(${i}, "s${i}");
`);
  }
  return parts.join('\n');
}

describe('rank-N stress', () => {
  test('100 forall annotations infer cleanly and quickly', () => {
    const src = makeStressSource(100);
    const t0 = Date.now();
    const r = inferSource(src);
    const elapsed = Date.now() - t0;
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    // Generous ceiling: this typically runs in well under a second; the
    // bound only guards against pathological blow-ups.
    expect(elapsed).toBeLessThan(5000);
  });

  test('100 rank-1 functions as control stay clean', () => {
    const parts: string[] = [];
    for (let i = 0; i < 100; i++) {
      parts.push(`
// plain${i} :: a -> a
const plain${i} = x => x;
const use${i} = plain${i}(${i});
`);
    }
    const r = inferSource(parts.join('\n'));
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });
});
