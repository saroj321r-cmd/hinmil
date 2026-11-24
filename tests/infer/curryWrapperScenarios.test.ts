// Scenarios from converting fpkit's nested-arrow functions (`a => b => …`) to
// `curry ((a, b) => …)`.  A `curry (…)` result is
// flagged `isCurriedResult`, and its calls take the curried call path — that
// path must not lose behaviour the regular call path has:
//
//   1. `pipe ([splitOn (""), joinWith ("")])` with a curried `pipe` still goes
//      through the spread-chain machinery (link-by-link typing), instead of
//      unifying `Array (f | g)` against `(a -> b, b -> c, ..., y -> z)`.
//   2. An OVERLOADED annotation over a `curry (…)` implementation (fpkit's
//      `ap`, `contramap`) is checked branch-wise, not unified as one union.
//   3. An overload-annotated parameter passed to a curried helper
//      (`hasProp ("length") (foldable)` in fpkit's `size`) is not pinned to
//      the helper's parameter type.

import { InferenceEngine } from '../../src/infer';

const diags = (src: string) => new InferenceEngine().infer(src).diagnostics.map(d => d.message);

const PRELUDE = [
  '// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }',
  '',
  '// curry :: ((a, b, ...) -> z) -> a -> b -> ... -> z',
  'const curry = fn => (...args) => args.length >= fn.length ? fn (...args) : curry (fn.bind (null, ...args));',
  '',
  '// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b',
  'const reduce = fn => seed => foldable => foldable.reduce (fn) (seed);',
  '',
  '// applyTo :: a -> (a -> b) -> b',
  'const applyTo = curry ((value, fn) => fn (value));',
  '',
  '// pipe :: Foldable f => f (a -> b, b -> c, ..., y -> z) -> a -> z',
  'const pipe = curry ((foldable, value) => reduce (applyTo) (value) (foldable));',
  '',
  '// splitOn :: String -> String -> Array String',
  'const splitOn = curry ((separator, str) => str.split (separator));',
  '',
  '// joinWith :: String -> Array a -> String',
  'const joinWith = curry ((separator, arr) => arr.join (separator));',
].join('\n');

describe('curried combinators keep their specialised typing', () => {
  test('curried pipe over curried partials types link by link (fpkit reverseText)', () => {
    const src = `${PRELUDE}\n// reverseText :: String -> String\nconst reverseText = pipe ([splitOn (""), arr => arr.reverse (), joinWith ("")]);`;
    // Before the fix the array literal was unified as `Array (f | g | h)`
    // against the spread chain.  (The separate "Array does not satisfy
    // Foldable" discharge gap for native Array#reduce is tracked apart.)
    const ds = diags(src);
    expect(ds.filter(d => /\.\.\./.test(d) || /Cannot unify '\[/.test(d))).toEqual([]);
    expect(ds.filter(d => /Type mismatch/.test(d))).toEqual([]);
  });

  test('a wrong pipe endpoint is still reported', () => {
    const src = `${PRELUDE}\n// countText :: String -> Number\nconst countText = pipe ([splitOn (""), joinWith ("")]);`;
    expect(diags(src).join('\n')).toMatch(/Cannot unify 'String' with 'Number'/);
  });
});

describe('overloaded annotation over a curry (…) implementation', () => {
  test('a body valid for the overloads is accepted (fpkit fl/contramap)', () => {
    const src = [
      PRELUDE,
      '// concatBoth :: String -> String -> String',
      '// concatBoth :: Number -> Number -> Number',
      'const concatBoth = curry ((a, b) => a + b);',
    ].join('\n');
    expect(diags(src)).toEqual([]);
  });

  test('a body matching no overload is reported', () => {
    const src = [
      PRELUDE,
      '// sameBoth :: String -> String -> String',
      '// sameBoth :: Number -> Number -> Number',
      'const sameBoth = curry ((a, b) => a === b);',
    ].join('\n');
    expect(diags(src).join('\n')).toMatch(/sameBoth/);
  });
});

describe('overload-annotated parameter passed to a curried helper', () => {
  test('is not pinned to the helper parameter type (fpkit lst/size)', () => {
    const src = [
      PRELUDE,
      '// ::narrow { [k] :: a, ...r }',
      '// hasProp :: k -> { [k] :: a | Undefined, ...r } -> Boolean',
      'const hasProp = curry ((key, obj) => obj != null && obj[key] !== undefined);',
      '',
      '// size :: Array a -> Number',
      '// size :: String -> Number',
      'const size = foldable => hasProp ("length") (foldable) ? foldable.length : 0;',
    ].join('\n');
    expect(diags(src)).toEqual([]);
  });
});
