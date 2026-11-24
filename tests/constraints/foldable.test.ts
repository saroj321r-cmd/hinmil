// Foldable-constraint regressions: how the `Foldable f` type class interacts
// with built-in container methods (`Array#reduce`, `Object` reps) and with
// overloaded user-level `reduce` signatures.
//
//   1. Curried vs uncurried — a curried class method `(b -> a -> b) -> b -> b`
//      must NOT be satisfied by the uncurried native `Array#reduce`.
//   2. Optional init — a class method declared in the SAME uncurried tuple
//      shape as the native `((b, a) -> b, b) -> b` must accept Array, even
//      though the built-in models its optional init as `b | Undefined`.
//   3. Object rep — `::rep Foldable Object#reduce` lets an object literal
//      satisfy a higher-kinded `f a` parameter.

import { diags } from '../helpers/infer';
import { TempProject } from '../helpers/project';

// ---------------------------------------------------------------------------
// 1. Curried class method vs uncurried built-in (P1).
// ---------------------------------------------------------------------------

describe('Foldable curried constraint vs built-in Array#reduce (P1)', () => {
  const FOLDABLE =
    '// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }\n';

  test('single constrained overload: Array argument is rejected', () => {
    const src = FOLDABLE +
      `// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b\n` +
      `const reduce = fn => init => foldable => foldable;\n` +
      `const r = reduce(acc => value => value)(1)([1, 2]);`;
    const msgs = diags(src);
    expect(msgs.some(m => /does not satisfy constraint 'Foldable'/.test(m))).toBe(true);
    expect(msgs.some(m => /cannot be unified with the required/.test(m))).toBe(true);
  });

  test('merged overloads WITHOUT an Array branch: Array argument is rejected', () => {
    const src = FOLDABLE +
      `// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b\n` +
      `// reduce :: (b -> a -> b) -> b -> { [k] :: a } -> b\n` +
      `const reduce = fn => init => foldable => foldable;\n` +
      `const r = reduce(acc => value => value)(1)([1, 2]);`;
    expect(diags(src).some(m => /does not satisfy constraint 'Foldable'/.test(m))).toBe(true);
  });

  test('merged overloads WITH an Array branch: Array argument type-checks', () => {
    const src = FOLDABLE +
      `// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b\n` +
      `// reduce :: (b -> a -> b) -> b -> Array a -> b\n` +
      `// reduce :: (b -> a -> b) -> b -> { [k] :: a } -> b\n` +
      `const reduce = fn => init => foldable => foldable;\n` +
      `const r = reduce(acc => value => value)(1)([1, 2]);`;
    expect(diags(src)).toHaveLength(0);
  });

  test('object argument never triggers the Foldable curry mismatch', () => {
    const src = FOLDABLE +
      `// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b\n` +
      `// reduce :: (b -> a -> b) -> b -> { [k] :: a } -> b\n` +
      `const reduce = fn => init => foldable => foldable;\n` +
      `const r = reduce(acc => value => value)(1)({ a: 1, b: 2 });`;
    expect(diags(src)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Uncurried tuple shape with optional-init union (P1).
// ---------------------------------------------------------------------------

describe('Foldable uncurried reduce vs built-in Array#reduce optional init (P1)', () => {
  const FOLDABLE_TUPLE =
    '// ::constraint Foldable f { f :: { reduce :: f a ~> ((b, a) -> b, b) -> b } }\n';

  test('Array satisfies Foldable whose reduce matches the native tuple shape', () => {
    const src = FOLDABLE_TUPLE +
      `// reduce :: Foldable f => ((b, a) -> b, b) -> f a -> b\n` +
      `const reduce = (fn, init) => foldable => foldable;\n` +
      `const r = reduce((acc, value) => acc, 0)([1, 2]);`;
    const msgs = diags(src);
    expect(msgs.some(m => /does not satisfy constraint 'Foldable'/.test(m))).toBe(false);
    expect(msgs.some(m => /cannot be unified with the required/.test(m))).toBe(false);
  });

  test('the optional-init union is not confused with a genuine value union', () => {
    // Object argument still never triggers the Foldable mismatch.
    const src = FOLDABLE_TUPLE +
      `// reduce :: Foldable f => ((b, a) -> b, b) -> f a -> b\n` +
      `// reduce :: ((b, a) -> b, b) -> { [k] :: a } -> b\n` +
      `const reduce = (fn, init) => foldable => foldable;\n` +
      `const r = reduce((acc, value) => acc, 0)({ a: 1, b: 2 });`;
    expect(diags(src)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. `::rep Foldable Object#reduce` lets an object literal satisfy `f a`.
// ---------------------------------------------------------------------------

describe('Foldable Object rep lets an object literal satisfy `f a`', () => {
  const GLOBALS =
    '// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }';

  const project = new TempProject('foldable-object-rep');

  beforeAll(() => {
    project.setup();
    project.projectConfig = {
      globalsSource: GLOBALS,
      globalsFilePath: project.pathOf('globals.js'),
    };
    project.write('globals.js', GLOBALS);
    project.write('fl/reduce.js', [
      '"use strict";',
      'let natives = {};',
      '// ::rep Foldable Array#reduce',
      '// natives.Array :: Array a ~> (b -> a -> b) -> b -> b',
      'natives.Array = function (fn) {',
      '  return init => this.reduce ((acc, value) => fn (acc) (value), init);',
      '};',
      '// ::rep Foldable Object#reduce',
      '// natives.Object :: { [k] :: a } ~> (b -> a -> b) -> b -> b',
      'natives.Object = function (fn) {',
      '  return init => Object.keys (this).reduce ((acc, key) => fn (acc) (this[key]), init);',
      '};',
      '// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b',
      'const reduce = fn => init => foldable => natives.Array (fn) (init);',
      'module.exports = reduce;',
    ].join('\n'));
    project.write('lst/size.js', [
      '"use strict";',
      'const reduce = require ("../fl/reduce");',
      '// size :: Foldable f => f a -> Number',
      '// size :: String -> Number',
      'const size = foldable => {',
      '  return reduce (count => _x => count + 1) (0) (foldable);',
      '};',
      'module.exports = size;',
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  function diagsFor(consumerSrc: string): string[] {
    project.write('lst/size.spec.js', consumerSrc);
    const result = project.inferSource('lst/size.spec.js', consumerSrc, eng => {
      eng.globalsSource = GLOBALS;
    });
    return result.diagnostics.map(d => d.message);
  }

  test('size on an object literal produces no overload diagnostic', () => {
    const msgs = diagsFor([
      '"use strict";',
      'const size = require ("./size");',
      'size ({ a: 1, b: 2, c: 3 });',
    ].join('\n'));
    expect(msgs.filter(m => /No overload/.test(m))).toEqual([]);
  });

  test('size still accepts an array and a string (other Foldable / overload arms)', () => {
    const msgs = diagsFor([
      '"use strict";',
      'const size = require ("./size");',
      'size ([1, 2, 3]);',
      'size ("abc");',
    ].join('\n'));
    expect(msgs.filter(m => /No overload/.test(m))).toEqual([]);
  });
});
