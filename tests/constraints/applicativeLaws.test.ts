// Applicative-law regressions (fpkit src/test/laws/Applicative.js).
//
// The fantasy-land Applicative laws exercise a constraint-polymorphic,
// overloaded `ap` together with `of :: Applicative f => TypeRep f -> a -> f a`
// inside annotated law bodies.  Historically these bodies triggered four
// distinct instabilities, each covered by a describe block below:
//
//   1. TypeRep sharing   — one `TypeRep f` binding feeding several `of` calls
//      with different value types raised a spurious kv-arity mismatch.
//   2. Rigid functor     — a concrete `Array …` overload branch could pin a
//      GIVEN/rigid `Applicative f =>` functor, yielding
//      "Cannot unify 'Array' with 'f a'".
//   3. Constraint display — identical `of (A) (f)` expressions displayed
//      different constraint subsets (Applicative vs leaked Apply).
//   4. Interchange poison — speculative overload trials froze the `$error`
//      sentinel into a captured branch remainder, blanking hover for `u`.

import { typeToString } from '../../src/hm/types';
import { collectConstraintInfo } from '../../src/services/hover';
import { freshEngine, diags } from '../helpers/infer';
import { TempProject } from '../helpers/project';

// Shared fantasy-land prelude: constraint hierarchy + overloaded `ap`.
const PRELUDE = `"use strict";
// ::constraint Setoid s { s :: { equals :: s ~> s -> Boolean } }
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Apply f { f :: Functor, f :: { ap :: f a ~> f (a -> b) -> f b } }
// ::constraint Applicative f { f :: Apply, f :: { of :: a -> f a } }
const ext = () => ext ();
// of :: Applicative f => TypeRep f -> a -> f a
const of = A => x => ext ();
// ap :: Apply f => f (a -> b) -> f a -> f b
// ap :: Array (a -> b) -> Array a -> Array b
// ap :: { [a] :: b -> c } -> { [a] :: b } -> { [a] :: c }
// ap :: (a -> b -> c) -> (a -> b) -> (a -> c)
const ap = apply1 => apply2 => ext ();
// equals :: Setoid a => a -> a -> Boolean
const equals = a => b => ext ();
`;

// ---------------------------------------------------------------------------
// 1. A single `TypeRep f` shared across `of()` calls with different value
//    types must not raise kv-arity errors, nor default `f` to Object.
// ---------------------------------------------------------------------------

describe('Applicative homomorphism law: TypeRep shared across of() calls is stable', () => {
  const WITHOUT_APPLIE = PRELUDE + `// homomorphism :: Applicative f => TypeRep f -> (a -> b) -> a -> Boolean
const homomorphism = A => f => x => {
  const lhs = ap (of (A) (f)) (of (A) (x));
  const rhs = of (A) (f (x));
  return equals (rhs) (lhs) ;
};
`;

  const WITH_APPLIE = PRELUDE + `// homomorphism :: Applicative f => TypeRep f -> (a -> b) -> a -> Boolean
const homomorphism = A => f => x => {
  const applie = of (A) (f);
  const lhs = ap (of (A) (f)) (of (A) (x));
  const rhs = of (A) (f (x));
  return equals (rhs) (lhs) ;
};
`;

  test('no spurious "Cannot unify \'f\' with \'f a\'"', () => {
    expect(diags(WITHOUT_APPLIE).some(m => /Cannot unify 'f' with 'f a'/.test(m))).toBe(false);
    expect(diags(WITH_APPLIE).some(m => /Cannot unify 'f' with 'f a'/.test(m))).toBe(false);
  });

  test('f never defaults to Object (no spurious Applicative violation)', () => {
    for (const src of [WITHOUT_APPLIE, WITH_APPLIE]) {
      expect(diags(src).some(m => /does not satisfy constraint 'Applicative'/.test(m))).toBe(false);
    }
  });

  test('diagnostics are identical whether or not the unrelated `applie` line is present', () => {
    expect(diags(WITH_APPLIE)).toEqual(diags(WITHOUT_APPLIE));
  });
});

// ---------------------------------------------------------------------------
// 2. Inside a body with a RIGID `Applicative f =>` functor, `ap` must resolve
//    through the polymorphic `Apply f` branch; concrete container branches
//    may not pin the rigid functor.
// ---------------------------------------------------------------------------

describe('Applicative homomorphism: rigid functor resolves ap via the polymorphic branch', () => {
  const HOMOMORPHISM = PRELUDE + `// homomorphism :: (Applicative f, Setoid (f b)) => TypeRep f -> (a -> b) -> a -> Boolean
const homomorphism = A => f => x => {
  const lhs = ap (of (A) (f)) (of (A) (x));
  const rhs = of (A) (f (x));
  return equals (rhs) (lhs) ;
};
`;

  // Same body but with an EARLIER, unrelated `of(A)(f)` statement —
  // diagnostics must not change depending on its presence.
  const HOMOMORPHISM_WITH_EXTRA = PRELUDE + `// homomorphism :: (Applicative f, Setoid (f b)) => TypeRep f -> (a -> b) -> a -> Boolean
const homomorphism = A => f => x => {
  const applie = of (A) (f);
  const lhs = ap (of (A) (f)) (of (A) (x));
  const rhs = of (A) (f (x));
  return equals (rhs) (lhs) ;
};
`;

  // No `=>` constraint context: the functor is FREE, so the parametricity
  // filter must be a no-op and resolution stays permissive.
  const UNANNOTATED = PRELUDE + `const helper = A => f => x => {
  const lhs = ap (of (A) (f)) (of (A) (x));
  return lhs ;
};
`;

  test('no spurious "Cannot unify \'Array\' with \'f a\'"', () => {
    expect(diags(HOMOMORPHISM).some(m => /Cannot unify 'Array' with 'f a'/.test(m))).toBe(false);
    expect(diags(HOMOMORPHISM_WITH_EXTRA).some(m => /Cannot unify 'Array' with 'f a'/.test(m))).toBe(false);
  });

  test('rigid functor is never pinned to a concrete container (fully clean)', () => {
    expect(diags(HOMOMORPHISM)).toEqual([]);
  });

  test('diagnostics are stable whether or not the unrelated `applie` line is present', () => {
    expect(diags(HOMOMORPHISM_WITH_EXTRA)).toEqual(diags(HOMOMORPHISM));
  });

  test('an UNANNOTATED (free) functor stays permissive — the filter is a no-op', () => {
    expect(diags(UNANNOTATED).some(m => /Cannot unify 'Array' with 'f a'/.test(m))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Identical `of (A) (f)` expressions must display identical constraint
//    sets after kv-representative normalization + superclass subsumption.
// ---------------------------------------------------------------------------

describe('Applicative homomorphism: identical of(A)(f) expressions display identical constraints', () => {
  const SRC = PRELUDE + `// homomorphism :: (Applicative f, Setoid (f b)) => TypeRep f -> (a -> b) -> a -> Boolean
const homomorphism = A => f => x => {
  const appie1 = of (A) (f);
  const lhs = ap (of (A) (f)) (of (A) (x));
  const appie2 = of (A) (f);
  const rhs = of (A) (f (x));
  return equals (rhs) (lhs) ;
};
`;

  /** Constraints displayed for the initializer of `const <name>`. */
  function constraintsOfBinding(src: string, name: string): string[] {
    const result = freshEngine().infer(src);
    const declIdx = src.indexOf(`const ${name} = `);
    const rhsStart = declIdx + `const ${name} = `.length;
    const entry = result.nodeTypes.get(rhsStart);
    if (!entry) throw new Error(`no node type recorded for ${name} at ${rhsStart}`);
    const resolved = result.substitution.apply(entry.type);
    return collectConstraintInfo(
      resolved,
      result.kvConstraints,
      result.kvConstructorConstraints,
      result.substitution,
    );
  }

  test('appie1 and appie2 both display exactly [Applicative f]', () => {
    const c1 = constraintsOfBinding(SRC, 'appie1');
    const c2 = constraintsOfBinding(SRC, 'appie2');
    expect(c1).toEqual(['Applicative f']);
    expect(c2).toEqual(['Applicative f']);
    expect(c1).toEqual(c2);
  });

  test('the weaker superclass `Apply` is subsumed by `Applicative` (never shown alongside)', () => {
    const c1 = constraintsOfBinding(SRC, 'appie1');
    expect(c1).not.toContain('Apply f');
  });

  test('the applied `Setoid (f b)` constraint does not leak onto the functor variable', () => {
    const c1 = constraintsOfBinding(SRC, 'appie1');
    expect(c1.some(s => /Setoid/.test(s))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Interchange law: speculative overload trials must not freeze the
//    `$error` poison sentinel into a captured branch remainder.
// ---------------------------------------------------------------------------

describe('Applicative interchange: shared argument is not poisoned by overload trials', () => {
  const GLOBALS = [
    '// ::global Array#ap :: [a] ~> [a -> b] -> [b]',
    '// ::global Array#equals :: [a] ~> [a] -> Boolean',
    '// ::constraint Setoid s { s :: { equals :: s ~> s -> Boolean } }',
    '// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }',
    '// ::constraint Apply f { f :: Functor, f :: { ap :: f a ~> f (a -> b) -> f b } }',
    '// ::constraint Applicative f { f :: Apply, f :: { of :: a -> f a } }',
  ].join('\n');

  const project = new TempProject('applicative-interchange');

  beforeAll(() => {
    project.setup();
    project.projectConfig = {
      globalsSource: GLOBALS,
      globalsFilePath: project.pathOf('globals.js'),
    };
    project.write('globals.js', GLOBALS);
    project.write('fl/of.js', [
      '"use strict";',
      '// of :: Applicative f => TypeRep f -> a -> f a',
      'const of = A => x => of (A) (x);',
      'module.exports = of;',
    ].join('\n'));
    project.write('fl/ap.js', [
      '"use strict";',
      '// ap :: Apply f => f (a -> b) -> f a -> f b',
      '// ap :: Array (a -> b) -> Array a -> Array b',
      '// ap :: { [a] :: b -> c } -> { [a] :: b } -> { [a] :: c }',
      '// ap :: (a -> b -> c) -> (a -> b) -> (a -> c)',
      'const ap = apply1 => apply2 => ap (apply1) (apply2);',
      'module.exports = ap;',
    ].join('\n'));
    project.write('fl/equals.js', [
      '"use strict";',
      '// equals :: Setoid a => a -> a -> Boolean',
      'const equals = a => b => equals (a) (b);',
      'module.exports = equals;',
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  function inferInterchange(): { fnType: string; diags: string[] } {
    const consumerSrc = [
      '"use strict";',
      'const ap = require ("./fl/ap");',
      'const equals = require ("./fl/equals");',
      'const of = require ("./fl/of");',
      'const interchange = A => u => y => {',
      '  const lhs = ap (u) (of (A) (y));',
      '  const rhs = ap (of (A) (f => f (y))) (u);',
      '  return equals (rhs) (lhs) ;',
      '};',
      'module.exports = interchange;',
    ].join('\n');
    project.write('interchange.js', consumerSrc);
    const result = project.inferSource('interchange.js', consumerSrc, eng => {
      eng.globalsSource = GLOBALS;
    });
    const declPos = consumerSrc.indexOf('interchange = ');
    const entry = result.nodeTypes.get(declPos);
    const fnType = entry ? typeToString(result.substitution.apply(entry.type)) : '(none)';
    return { fnType, diags: result.diagnostics.map(d => d.message) };
  }

  test('the interchange body infers without diagnostics', () => {
    expect(inferInterchange().diags).toEqual([]);
  });

  test('u resolves to a clean Array-of-functions element type (no $error poison)', () => {
    const { fnType } = inferInterchange();
    // `_` is how typeToString renders the `$error` poison sentinel.
    expect(fnType).not.toContain('_');
    // Shape: the principal type `TypeRep f -> f (a -> b) -> a -> Boolean`.
    // Overload branches are tried in declaration order (README › Overloading)
    // and a branch whose trial errors is rejected, so the generic
    // `Apply f => …` branch of `ap` is selected; formerly the sorted order
    // picked the Array branch and pinned `f := Array`.
    expect(fnType).toBe('TypeRep f -> f (a -> b) -> a -> Boolean');
  });
});
