import { InferenceEngine } from '../../src/infer';

function diagnostics(src: string): string[] {
  const eng = new InferenceEngine();
  return eng.infer(src).diagnostics.map(d => `${d.start}:${d.message}`);
}

// Regression: a point-free `of :: Applicative f => TypeRep f -> a -> f a`
// whose `TypeRep f` param is rewritten to its kv-applied form (`TypeRep (f a)`)
// must NOT force a *caller's* bare `TypeRep f` argument to absorb that
// application.  Previously calling `of(typeRep)` inside a `traverse`
// implementation bound the caller's functor-kind var to the applied
// `f a`, so a later `f (Maybe b)` collapsed to the ill-kinded `f a (Maybe b)`
// and unification reported: Cannot unify 'f a' with 'f a (Maybe b)'.
describe('traverse TypeRep arity', () => {
  const prelude = [
    '// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }',
    '// ::constraint Apply f { f :: Functor, f :: { ap :: f a ~> f (a -> b) -> f b } }',
    '// ::constraint Applicative f { f :: Apply, f :: { of :: a -> f a } }',
    '',
    '// Maybe :: Nothing | Just a',
    'function Maybe() {}',
    '',
    '// map :: Functor f => (a -> b) -> f a -> f b',
    'const map = f => x => x.map (f);',
    '',
    '// of :: Applicative f => TypeRep f -> a -> f a',
    'const of = tr => x => tr.of (x);',
    '',
    '// Just :: a -> Maybe a',
    'function Just(value) {',
    '  // Maybe#value :: a',
    '  this.value = value;',
    '}',
    '',
    '// Nothing :: () -> Maybe a',
    'function Nothing() {}',
    '',
    '// Nothing# :: Maybe',
    'Nothing.prototype = Object.create (Maybe.prototype);',
    '// Just# :: Maybe',
    'Just.prototype = Object.create (Maybe.prototype);',
    '',
    '// _Just :: a -> Maybe a',
    'function _Just(value) { return new Just (value); }',
    '',
    '// Maybe#traverse :: Applicative f => Maybe a ~> TypeRep f -> (a -> f b) -> f (Maybe b)',
  ].join('\n');

  it('both traverse implementations together type-check cleanly', () => {
    const src = [
      prelude,
      'Nothing.prototype.traverse = function (typeRep) {',
      '  return _fn => {',
      '    return of (typeRep) (this);',
      '  };',
      '};',
      '',
      'Just.prototype.traverse = function (_typeRep) {',
      '  return fn => {',
      '    return map (_Just) (fn (this.value));',
      '  };',
      '};',
    ].join('\n');
    expect(diagnostics(src)).toEqual([]);
  });
});
