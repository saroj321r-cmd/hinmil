// Regression: a registered sumtype *carrier* (`function Maybe(){}`, declared
// via `// Maybe :: Nothing | Just a`) passed where a `Monoid m => TypeRep m`
// parameter is expected must act as a type-representative witness (`TypeRep
// (Maybe a)`), NOT be return-type-extracted through `unifyTypeRep` (which
// pinned `m = ()` and produced a spurious `Cannot unify 'Maybe a' with '()'`).
//
// Mirrors fpkit `src/test/laws/Monoid.js` + `src/Maybe/index.spec.js` L112.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';

beforeEach(() => resetTypeVarCounter());

const PRELUDE = `
// ::constraint Monoid m { m :: { empty :: () -> m, concat :: m ~> m -> m } }

// Maybe :: Nothing | Just a
function Maybe() {}

// Just :: a -> Maybe a
function Just(x) {}

// Nothing :: Maybe a
const Nothing = Just (0);

// empty :: Monoid m => TypeRep m -> m
const empty = M => M.empty();

// concat :: Monoid m => m -> m -> m
const concat = a => b => a;

// equals :: a -> a -> Boolean
const equals = a => b => true;

// leftIdentity :: Monoid m => TypeRep m -> m -> Boolean
const leftIdentity = M => m => equals (m) (concat (m) (empty (M)));

const monoidLaws = M => ({ leftIdentity: leftIdentity (M) });
`;

test('sumtype carrier passed to TypeRep m does not collapse m to ()', () => {
  const engine = new InferenceEngine();
  const src = `${PRELUDE}
// checkLaw :: Maybe a -> Boolean
const checkLaw = m => monoidLaws (Maybe).leftIdentity (m);
`;
  const r = engine.infer(src);
  const bad = r.diagnostics.filter(d =>
    /Cannot unify 'Maybe a' with '\(\)'/.test(d.message)
    || /Type constructor 'Maybe'/.test(d.message));
  expect(bad).toHaveLength(0);
  expect(r.diagnostics).toHaveLength(0);
});

test('sumtype carrier witness only applies in TypeRep position (member access intact)', () => {
  const engine = new InferenceEngine();
  const src = `${PRELUDE}
// staticEmpty :: () -> Maybe a
Maybe.empty = () => Nothing;
const viaStatic = Maybe.empty ();
`;
  const r = engine.infer(src);
  // `Maybe.empty` (member access) must still resolve on the carrier — the
  // witness coercion must not fire here (no TypeRep expected).
  const unbound = r.diagnostics.filter(d => /empty.*does not exist|not callable/i.test(d.message));
  expect(unbound).toHaveLength(0);
});
