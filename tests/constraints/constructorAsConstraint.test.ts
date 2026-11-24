// Issue 9: constructors-as-constraints — `Pair p => ... -> p c a`.
// When a constraint names a known type constructor (declared or imported)
// rather than a `::constraint` class, the constrained variable IS that
// constructor: bare `p` resolves to `Pair`, and applied `p c a` resolves to
// `Pair c a`.  No "Unknown constraint" diagnostic should be emitted.

import { InferenceEngine } from '../../src/infer';

function infer(src: string) {
  return new InferenceEngine().infer(src);
}

describe('constructor as constraint (Pair p =>)', () => {
  test('higher-kinded constructor constraint resolves `p a b` to `Pair a b`', () => {
    const r = infer(`
// Pair :: (a, b) -> Pair a b
function Pair(fst, snd) {
  this.fst = fst;
  this.snd = snd;
}

// pairUp :: Pair p => a -> b -> p a b
const pairUp = (x) => (y) => new Pair(x, y);
`);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('does not emit an Unknown constraint diagnostic for a known constructor', () => {
    const r = infer(`
// Pair :: (a, b) -> Pair a b
function Pair(fst, snd) {
  this.fst = fst;
  this.snd = snd;
}

// Arrow :: (a -> b) -> Arrow a b
function Arrow(run) {
  this.run = run;

  // Arrow#second :: Pair p => Arrow a b ~> () -> Arrow (p c a) (p c b)
  this.second = function () {
    return this;
  };
}
`);
    expect(r.diagnostics.some(d => /Unknown constraint/.test(d.message))).toBe(false);
  });

  test('a genuinely unknown constructor constraint still reports', () => {
    const r = infer(`
// mk :: Nope p => a -> p a
const mk = (x) => x;
`);
    expect(r.diagnostics.some(d => /Unknown constraint 'Nope'/.test(d.message))).toBe(true);
  });
});
