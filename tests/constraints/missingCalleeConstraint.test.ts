// Regression for fpkit: a function that calls a constrained helper must DECLARE
// (or entail) every type-class constraint that helper requires on the shared
// type variable — Haskell's "No instance for (C a) arising from a use of …".
//
//   // append :: (Applicative f, Semigroup (f a)) => a -> f a -> f a
//   // appendOrNot :: Semigroup (f a) => a -> f a -> f a
//   const appendOrNot = x => acc => append (x) (acc);
//
// `appendOrNot` calls `append`, whose `Applicative f` requirement lands on
// `appendOrNot`'s own (still-polymorphic) `f`.  Since `appendOrNot` only
// declares `Semigroup (f a)` — which does NOT entail `Applicative f` — the LSP
// must flag the missing constraint.  When the signature declares (or entails
// via superclasses) the constraint, no diagnostic fires.
import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;
beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

const PRELUDE = `// ::constraint Semigroup s { s :: { concat :: s ~> s -> s } }
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Apply f { f :: Functor, f :: { ap :: f a ~> f (a -> b) -> f b } }
// ::constraint Applicative f { f :: Apply, f :: { of :: a -> f a } }
// append :: (Applicative f, Semigroup (f a)) => a -> f a -> f a
const append = x => acc => acc;
`;

function missingConstraintDiags(src: string) {
  const r = engine.infer(src);
  return r.diagnostics.filter(d => /Missing constraint/.test(d.message));
}

test('flags a callee constraint not declared by the enclosing signature', () => {
  const diags = missingConstraintDiags(
    PRELUDE +
    `// appendOrNot :: Semigroup (f a) => a -> f a -> f a
const appendOrNot = x => acc => append (x) (acc);
`,
  );
  expect(diags).toHaveLength(1);
  expect(diags[0].message).toContain("Applicative f");
});

test('no diagnostic when the enclosing signature declares the constraint', () => {
  const diags = missingConstraintDiags(
    PRELUDE +
    `// appendOrNot :: (Applicative f, Semigroup (f a)) => a -> f a -> f a
const appendOrNot = x => acc => append (x) (acc);
`,
  );
  expect(diags).toHaveLength(0);
});

test('no diagnostic when a superclass constraint entails the requirement', () => {
  // Declaring `Applicative f` provides `Apply f` and `Functor f` too, so a
  // callee requiring `Functor f` is entailed.
  const src = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Apply f { f :: Functor, f :: { ap :: f a ~> f (a -> b) -> f b } }
// ::constraint Applicative f { f :: Apply, f :: { of :: a -> f a } }
// fmapish :: Functor f => f a -> (a -> b) -> f b
const fmapish = fa => g => fa;
// useIt :: Applicative f => f a -> (a -> b) -> f b
const useIt = fa => g => fmapish (fa) (g);
`;
  expect(missingConstraintDiags(src)).toHaveLength(0);
});

test('applied constraints keep their applied form in the label (Monoid (f a), not Monoid f)', () => {
  // fpkit pipeK scenario: `tail` requires `Monoid (f a)` on the caller's `f`;
  // the diagnostic label must show the full applied form so the user can
  // copy it verbatim into the signature.
  const diags = missingConstraintDiags(
    PRELUDE +
    `// ::constraint Monoid m { m :: Semigroup, m :: { empty :: () -> m } }
// tailish :: (Applicative f, Monoid (f a)) => f a -> f a
const tailish = fa => fa;
// pipeish :: Applicative f => f a -> f a
const pipeish = fa => tailish (fa);
`,
  );
  expect(diags).toHaveLength(1);
  expect(diags[0].message).toContain("Missing constraint 'Monoid (f a)'");
});
