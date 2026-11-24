// Regression: a user-defined nominal type structurally satisfies a record
// parameter when its registered instance members cover the record's fields.
//
// Real case (fpkit `Arrow`): `getType :: { @@type :: String } | Undefined ->
// String` was called with an `Arrow a b` value.  `Arrow` declares
// `Arrow#@@type :: Arrow a b ~> String`, so structurally it exposes
// `{ @@type :: String }` — yet unify reported
//   "Cannot unify '{ @@type :: String } | Undefined' with 'Arrow a b'"
// because the TCon-vs-TRecord path only consulted builtin structural members
// (Array/String `length`), never a user type's registered members.
//
// Fix: src/hm/unify.ts TCon-vs-TRecord path now consults `lookupMethod` for
// non-builtin nominal types.  See also the fpkit `getType` helper.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  clearCustomMethods();
  engine = new InferenceEngine();
});

const errs = (r: ReturnType<InferenceEngine['infer']>) =>
  r.diagnostics.filter((d) => d.severity !== 3 && !d.message.includes('Unused'));

describe('nominal type satisfies a structural record via registered members', () => {
  test('Arrow (with `@@type :: String` member) unifies with `{ @@type :: String }`', () => {
    const src = [
      '// Arrow :: (a -> b) -> Arrow a b',
      'function Arrow(run) { this.run = run; }',
      '',
      '// Arrow#@@type :: Arrow a b ~> String',
      'Arrow.prototype["@@type"] = "Arrow";',
      '',
      '// getType :: { @@type :: String } | Undefined -> String',
      'const getType = value => value && value["@@type"];',
      '',
      'const t = getType(new Arrow(x => x));',
    ].join('\n');
    const r = engine.infer(src);
    const bad = errs(r).filter((d) => /@@type|Arrow a b/.test(d.message));
    expect(bad).toEqual([]);
  });

  test('a record requiring a member the type does NOT declare still fails', () => {
    const src = [
      '// Arrow :: (a -> b) -> Arrow a b',
      'function Arrow(run) { this.run = run; }',
      '',
      '// Arrow#@@type :: Arrow a b ~> String',
      'Arrow.prototype["@@type"] = "Arrow";',
      '',
      '// needsFoo :: { foo :: String } -> String',
      'const needsFoo = value => value.foo;',
      '',
      'const t = needsFoo(new Arrow(x => x));',
    ].join('\n');
    const r = engine.infer(src);
    // `Arrow` has no `foo` member → the structural match must NOT succeed.
    expect(errs(r).length).toBeGreaterThan(0);
  });
});
