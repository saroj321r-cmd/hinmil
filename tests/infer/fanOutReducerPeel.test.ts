// Fase 0 — characterization: fpkit `combine`'s heterogeneous fold `reducer`.
//
// fpkit src/combinator/combine.js folds a lifted n-ary function over effectful
// branches:
//
//   const reducer = acc => fn => acc (fn (value));
//   return reduce (reducer) (liftN (n - 1) (hd)) (tl);
//
// Per step the reducer peels ONE argument off the lifted accumulator
// (`(m x -> r) -> (a -> m x) -> r`), so the accumulator type changes every
// iteration — a heterogeneous fold, not expressible in rank-1 HM with a
// homogeneous `reduce :: (b -> a -> b) -> b -> f a -> b`.
//
// The supported recipe expresses the accumulator as a SPREAD ARROW CHAIN,
// whose `...` absorbs the shrinking middle:
//
//   reducer :: (m x -> m y -> ... -> m z) -> (a -> m x) -> m y -> ... -> m z
//   liftN   :: Applicative m => Number -> (x -> y -> ... -> z) -> m x -> m y -> ... -> m z
//
// This suite characterizes (a) the unannotated status quo and verifies
// (b)–(e) the annotated recipe: nested annotation pickup, acc-application
// peeling, unification against `reduce`'s homogeneous `b -> a -> b`, and the
// liftN seed side.

import { InferenceEngine } from '../../src/infer';
import { prettyTypeToString, Type } from '../../src/hm/types';

const PRELUDE = `
// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }
// ::constraint Apply f { f :: { ap :: f (a -> b) ~> f a -> f b } }
// ::constraint Applicative f { f :: Apply, f :: { of :: a -> f a } }
// ::constraint Semigroup a { a :: { concat :: a ~> a -> a } }
// ::constraint Monoid a { a :: Semigroup, a :: { empty :: () -> a } }
const natives = {};
// ::rep Foldable Array#reduce
// natives.Array :: Array a ~> (b -> a -> b) -> b -> b
natives.Array = function (fn) { return init => init; };
// coerce :: a -> b
const coerce = v => v;
// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b
const reduce = f => acc => xs => coerce(xs);
// size :: Foldable f => f a -> Number
const size = xs => 0;
// head :: Foldable f => f a -> a
const head = xs => coerce(xs);
// tail :: (Applicative f, Foldable f, Monoid (f a)) => f a -> f a
const tail = xs => xs;
// lift2 :: Apply m => (x -> y -> z) -> m x -> m y -> m z
const lift2 = fn => a1 => a2 => coerce(a1);
// lift3 :: Apply m => (x -> y -> z2 -> z) -> m x -> m y -> m z2 -> m z
const lift3 = fn => a1 => a2 => a3 => coerce(a1);
`;

const LIFTN_ANNOTATED = `
// liftN :: Applicative m => Number -> (x -> y -> ... -> z) -> m x -> m y -> ... -> m z
const liftN = n => {
  switch (n) {
    case 2: return lift2;
    case 3: return lift3;
    default:
      throw new TypeError("You can only lift functions with an arity between 2 and 5.");
  }
};
`;

// NOTE: the constraint is load-bearing for PARSING — only constraint
// variables get higher-kinded juxtaposition (`m x`), so a bare
// `(m x -> ...)` without `Applicative m =>` is a parse error.
const REDUCER_ANNOTATION =
  '// reducer :: Applicative m => (m x -> m y -> ... -> m z) -> (a -> m x) -> m y -> ... -> m z';

function combineSource(reducerAnnotation: string): string {
  return `${PRELUDE}${LIFTN_ANNOTATED}
// combine :: (Foldable f, Applicative f, Applicative m, Monoid (f a)) => f (x1 -> x2 -> ... -> z, a -> m x1, a -> m x2, ...) -> a -> m z
const combine = foldable => value => {
  const n = size(foldable);
  const hd = head(foldable);
  const tl = tail(foldable);
  ${reducerAnnotation}
  const reducer = acc => fn => acc(fn(value));
  return reduce(reducer)(liftN(n - 1)(hd))(tl);
};
`;
}

function run(src: string, needle: string): { type: Type | null; diags: string[] } {
  const r = new InferenceEngine().infer(src);
  const off = src.indexOf(needle) + 'const '.length;
  const entry = r.nodeTypes.get(off);
  return {
    type: entry ? r.substitution.apply(entry.type) : null,
    diags: r.diagnostics.map((d) => d.message),
  };
}

describe('liftN — spread-chain annotation over concrete liftK bodies', () => {
  test('the annotated switch body (lift2/lift3 returns) is accepted', () => {
    const { diags } = run(`${PRELUDE}${LIFTN_ANNOTATED}`, 'const liftN = ');
    expect(diags).toEqual([]);
  });

  test('applying liftN to a concrete ternary function peels per level', () => {
    const src = `${PRELUDE}${LIFTN_ANNOTATED}
// add3 :: Number -> Number -> Number -> Number
const add3 = x => y => z => x + y + z;
const lifted = liftN(3)(add3);
`;
    const { type, diags } = run(src, 'const lifted = ');
    expect(diags).toEqual([]);
    // The result chain keeps its variadic marker (the engine cannot know the
    // fold length statically); the fixed ends are pinned to Number.
    expect(prettyTypeToString(type!)).toBe('m Number -> m Number -> ... -> m Number');
  });
});

describe('reducer — standalone spread-chain accumulator peeling', () => {
  // `Mappable` instead of `Applicative`: the peel test binds `m := Array`,
  // and the harness Array satisfies `map` natively but has no `ap`/`of` reps.
  // The constraint is still load-bearing for parsing (`m x` juxtaposition).
  const STANDALONE = `${PRELUDE}
// ::constraint Mappable m { m :: { map :: m a ~> (a -> b) -> m b } }
// reducer :: Mappable m => (m x -> m y -> ... -> m z) -> (a -> m x) -> m y -> ... -> m z
const reducer = acc => fn => acc(fn("seed"));
`;

  test('the annotated binding produces no diagnostics', () => {
    const { diags } = run(STANDALONE, 'const reducer = ');
    expect(diags).toEqual([]);
  });

  test('the binding shows the annotated spread-chain type', () => {
    const { type } = run(STANDALONE, 'const reducer = ');
    expect(prettyTypeToString(type!)).toBe(
      '(m x -> m y -> ... -> m z) -> (a -> m x) -> m y -> ... -> m z',
    );
  });

  test('one application peels one argument off the accumulator chain', () => {
    const src = `${STANDALONE}
// g :: Array Number -> Array String -> Array Boolean
const g = x => y => coerce(y);
// h :: String -> Array Number
const h = s => coerce(s);
const peeled = reducer(g)(h);
`;
    const { type, diags } = run(src, 'const peeled = ');
    expect(diags).toEqual([]);
    // One argument is peeled off (`m x` is consumed); the ends are pinned to
    // the concrete instantiation (m := Array).  The remainder keeps its
    // variadic marker — the chain length is not statically known.
    expect(prettyTypeToString(type!)).toBe('[String] -> ... -> [Boolean]');
  });

  test('`reduce(reducer)` unifies the chain with the homogeneous `b -> a -> b`', () => {
    const src = `${STANDALONE}
const step = reduce(reducer);
`;
    const { diags } = run(src, 'const step = ');
    expect(diags).toEqual([]);
  });
});

describe('combine — full body mirror of fpkit src/combinator/combine.js', () => {
  test('baseline: UNANNOTATED reducer — the engine reports the infinite type (the editor stays clean only because the server post-pass drops HM_INFINITE_TYPE inside an annotated extent)', () => {
    const { diags } = run(combineSource(''), 'const combine = ');
    expect(diags.some((m) => /has an infinite type/.test(m))).toBe(true);
  });

  test('annotated reducer: body stays clean', () => {
    const { diags } = run(combineSource(REDUCER_ANNOTATION), 'const combine = ');
    expect(diags).toEqual([]);
  });

  test('annotated reducer: the nested binding shows the annotated chain', () => {
    const src = combineSource(REDUCER_ANNOTATION);
    const { type } = run(src, 'const reducer = ');
    expect(prettyTypeToString(type!)).toContain('...');
  });
});

describe('annotated NESTED value bindings — signature is authoritative (rule 1)', () => {
  // Regression: nested annotations used to attach ONLY to function-shaped
  // initializers (`const f = x => ...`).  A nested `const test = <call>` let
  // the annotation leak through to the next top-level statement, so the
  // binding silently displayed its inferred type instead of the signature.
  test('a nested annotation above a call-initialized binding attaches', () => {
    const src = `${PRELUDE}
const outer = () => {
  // picked :: Number
  const picked = coerce("s");
  return picked;
};
`;
    const { type, diags } = run(src, 'const picked = ');
    expect(diags).toEqual([]);
    expect(prettyTypeToString(type!)).toBe('Number');
  });

  // Regression: asserting a non-function annotation over a binding whose
  // inferred type is a top-level spread arrow chain is the fold-completion
  // boundary — the chain stands for "once fully applied", so validation must
  // compare the chain's TERMINAL (mirroring unifyWithDiagnostic) instead of
  // reporting a false chain-vs-terminal mismatch, and hover must show the
  // annotated type.  This is the fpkit `test :: Applicative m => m z` case.
  test('a chain-typed binding collapses to its annotated terminal', () => {
    const src = `${PRELUDE}
// ::constraint Mappable m { m :: { map :: m a ~> (a -> b) -> m b } }
// mkChain :: Mappable m => Number -> (m x -> m y -> ... -> m z)
const mkChain = n => coerce(n);
const outer = () => {
  // res :: Mappable m => m z
  const res = mkChain(1);
  return res;
};
`;
    const { type, diags } = run(src, 'const res = ');
    expect(diags).toEqual([]);
    expect(prettyTypeToString(type!)).toBe('m z');
  });
});
