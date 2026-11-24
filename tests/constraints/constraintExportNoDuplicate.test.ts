// A structural constraint-shape diagnostic (a kind mismatch, or an unknown
// constraint, in the annotation) belongs to the annotation's *declaration* site
// only. A bare value reference to the constrained binding — such as
// `module.exports = f` — must NOT re-emit it, otherwise the definition-site
// diagnostic is duplicated at every reference. Regression for the drop.js
// `module.exports = drop` duplicate.

import { InferenceEngine } from '../../src/infer';

const MONOID = '// ::constraint Monoid a { a :: { empty :: a, concat :: a ~> a -> a } }';

describe('constraint diagnostics are not duplicated at export references', () => {
  const KIND_MISMATCH = /Constraint kind mismatch: 'Monoid'/;
  const UNKNOWN = /Unknown constraint 'Monoid'/;

  test('kind mismatch is not repeated on `module.exports = f`', () => {
    const source = [
      MONOID,
      '// f :: (Monoid f) => f a -> f a',
      'const f = xs => xs;',
      'module.exports = f;',
      '',
    ].join('\n');

    const result = new InferenceEngine().infer(source);
    const matches = result.diagnostics.filter(d => KIND_MISMATCH.test(d.message));

    // Exactly one — at the annotation, not repeated at `module.exports = f`.
    expect(matches).toHaveLength(1);
  });

  test('kind mismatch is not repeated on a bare `const g = f` reference', () => {
    const source = [
      MONOID,
      '// f :: (Monoid f) => f a -> f a',
      'const f = xs => xs;',
      'const g = f;',
      '',
    ].join('\n');

    const result = new InferenceEngine().infer(source);
    const matches = result.diagnostics.filter(d => KIND_MISMATCH.test(d.message));

    expect(matches).toHaveLength(1);
  });

  test('unknown constraint is not repeated on `module.exports = f`', () => {
    const source = [
      '// f :: (Monoid f) => f a -> f a',
      'const f = xs => xs;',
      'module.exports = f;',
      '',
    ].join('\n');

    const result = new InferenceEngine().infer(source);
    const matches = result.diagnostics.filter(d => UNKNOWN.test(d.message));

    expect(matches).toHaveLength(1);
  });

  test('the definition-site diagnostic is still reported', () => {
    const source = [
      MONOID,
      '// f :: (Monoid f) => f a -> f a',
      'const f = xs => xs;',
      'module.exports = f;',
      '',
    ].join('\n');

    const result = new InferenceEngine().infer(source);

    expect(result.diagnostics.some(d => KIND_MISMATCH.test(d.message))).toBe(true);
  });
});
