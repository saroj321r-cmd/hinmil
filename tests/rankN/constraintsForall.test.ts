// =============================================================================
// Rank-N phase 4 — constraints inside `forall` (HKT binders)
//
// `(forall f. Functor f => f Number -> f Number)` demands a natural-ish
// transformation argument: polymorphic in the functor, with the Functor
// methods available on it.  Body-side the binder instantiates per use with
// its constraint; call-site the skolemized binder promises the constraint.
// =============================================================================

import { diags } from '../helpers/infer';

const PRELUDE = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// Maybe :: Just a | Nothing

// Just :: a -> Maybe a
class Just {
  constructor(value) {
    // Maybe#value :: Maybe a ~> a
    this.value = value;
  }

  // Maybe#map :: Maybe a ~> (a -> b) -> Maybe b
  map(fn) {
    return new Just(fn(this.value));
  }
}

// Nothing :: () -> Maybe a
class Nothing {
  map(_fn) {
    return new Nothing();
  }
}
`;

describe('rank-N constraints inside forall', () => {
  test('polymorphic constrained argument is accepted', () => {
    const src = PRELUDE + `
// useNat :: (forall f. Functor f => f Number -> f Number) -> Maybe Number -> Maybe Number
const useNat = nat => mx => nat(mx);

// double :: Functor f => f Number -> f Number
const double = fx => fx.map(x => x * 2);

const ok = useNat(double)(Just(1));
`;
    expect(diags(src)).toEqual([]);
  });

  test('monomorphic argument is rejected', () => {
    const src = PRELUDE + `
// useNat :: (forall f. Functor f => f Number -> f Number) -> Maybe Number -> Maybe Number
const useNat = nat => mx => nat(mx);

// mono :: Maybe Number -> Maybe Number
const mono = mx => mx;
const bad = useNat(mono)(Just(1));
`;
    const d = diags(src);
    expect(d.some(m => m.includes('not polymorphic enough'))).toBe(true);
  });

  test('body may use the constraint methods of the forall binder', () => {
    const src = PRELUDE + `
// applyTwice :: (forall f. Functor f => f Number -> f Number) -> Maybe Number -> Maybe Number
const applyTwice = nat => mx => nat(nat(mx));
`;
    expect(diags(src)).toEqual([]);
  });

  test('lambda argument using only Functor methods is accepted', () => {
    const src = PRELUDE + `
// useNat :: (forall f. Functor f => f Number -> f Number) -> Maybe Number -> Maybe Number
const useNat = nat => mx => nat(mx);

const ok = useNat(fx => fx.map(x => x + 1))(new Just(1));
`;
    expect(diags(src)).toEqual([]);
  });

  test('naturality shape: forall a under a concrete constructor', () => {
    const src = PRELUDE + `
// endo :: (forall a. Maybe a -> Maybe a) -> (Maybe Number, Maybe String) -> [Maybe Number, Maybe String]
const endo = t => (mn, ms) => [t(mn), t(ms)];
const ok = endo(mx => mx)(new Just(1), new Just("x"));
`;
    expect(diags(src)).toEqual([]);
  });

  test('naturality shape rejects element-pinned argument', () => {
    const src = PRELUDE + `
// endo :: (forall a. Maybe a -> Maybe a) -> (Maybe Number, Maybe String) -> [Maybe Number, Maybe String]
const endo = t => (mn, ms) => [t(mn), t(ms)];
// doubleM :: Maybe Number -> Maybe Number
const doubleM = mx => mx.map(x => x * 2);
const bad = endo(doubleM)(new Just(1), new Just("x"));
`;
    const d = diags(src);
    expect(d.some(m => m.includes('not polymorphic enough'))).toBe(true);
  });
});
