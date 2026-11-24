// ============================================
// Spread arrow chains — curried chains of
// unknown length:  a -> b -> ... -> z
// ============================================
// The `...` inside an arrow chain reads "zero or more parameters following
// this pattern". It types variadic combinators that rank-1 HM cannot
// express directly — see TYPE-SYSTEM.md for the rules and their limits.

// ::constraint Apply f { f :: { ap :: f (a -> b) ~> f a -> f b } }
// ::constraint Applicative f { f :: Apply, f :: { of :: a -> f a } }

// coerce :: a -> b
const coerce = v => v;

// lift2 :: Apply m => (x -> y -> z) -> m x -> m y -> m z
const lift2 = fn => a1 => a2 => coerce(a1);
// lift3 :: Apply m => (x -> y -> z2 -> z) -> m x -> m y -> m z2 -> m z
const lift3 = fn => a1 => a2 => a3 => coerce(a1);

// ============================================
// liftN — one chain annotation over a union
// of concrete lift functions
// ============================================
// The body returns lift2 | lift3; the union is accepted because EVERY
// member fits the chain (unanimity, not first-match).

// liftN :: Applicative m => Number -> (x -> y -> ... -> z) -> m x -> m y -> ... -> m z
const liftN = n => {
  switch (n) {
    case 2: return lift2;
    case 3: return lift3;
    default:
      throw new TypeError("You can only lift functions with an arity between 2 and 5.");
  }
};

// add3 :: Number -> Number -> Number -> Number
const add3 = x => y => z => x + y + z;

const lifted = liftN(3)(add3);
// hover shows:  m Number -> m Number -> ... -> m Number
// Applying a chain peels one parameter per call; the remainder keeps its
// `...` marker — the length is not statically known.

// ============================================
// Heterogeneous fold accumulator — the
// reducer recipe (fpkit-style `combine`)
// ============================================
// The accumulator loses one argument per fold step, so its type changes
// every iteration. A spread chain absorbs the shrinking middle. The
// constraint is load-bearing: only constraint variables parse the `m x`
// juxtaposition inside the chain.

// ::constraint Mappable m { m :: { map :: m a ~> (a -> b) -> m b } }

// reducer :: Mappable m => (m x -> m y -> ... -> m z) -> (a -> m x) -> m y -> ... -> m z
const reducer = acc => fn => acc(fn("seed"));

// g :: Array Number -> Array String -> Array Boolean
const g = x => y => coerce(y);
// h :: String -> Array Number
const h = s => coerce(s);

const peeled = reducer(g)(h);
// hover shows:  [String] -> ... -> [Boolean]
// One application consumed `m x` (with m := Array); the ends are pinned,
// the middle stays variadic.
