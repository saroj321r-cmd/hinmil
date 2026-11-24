// Tests for "types as constraints" completion: a constraint head that names a
// known concrete type (scalar) or a structural union is BAKED into the
// constrained variable instead of being deferred.  This makes the variable
// usable as that type in the function body (hover shows the concrete type) and
// lets a trailing `T | Undefined` union act as an optional parameter.

import { resetTypeVarCounter, schemeToString } from '../../src/hm/types';
import { InferenceEngine } from '../../src/infer/index';
import { clearConstraints } from '../../src/registries/constraintRegistry';

beforeEach(() => {
  resetTypeVarCounter();
  clearConstraints();
});

function infer(src: string, names: string[]): Record<string, string> {
  const eng = new InferenceEngine();
  const r = eng.infer(src);
  const out: Record<string, string> = {};
  out.__diagnostics__ = r.diagnostics.map((d) => d.message).join('\n');
  for (const n of names) {
    const sch = r.topLevelBindings.get(n);
    if (sch) out[n] = schemeToString(sch);
  }
  return out;
}

describe('scalar + union constraints are baked into the signature', () => {
  test("the user's example: scalar + union constraints in a tuple", () => {
    const out = infer(
      `
// someStringsAndInts :: (String p, (Number | Undefined) x) => (p, x) -> p
const someStringsAndInts = (str, num) => str;
const nice = someStringsAndInts("2");
`,
      ['someStringsAndInts', 'nice'],
    );
    expect(out.__diagnostics__).toBe('');
    expect(out.someStringsAndInts).toBe('(String, Number | Undefined) -> String');
    // A trailing `T | Undefined` slot is optional, so a single argument is OK.
    expect(out.nice).toBe('String');
  });

  test('a bare scalar constraint makes the variable usable as that type in the body', () => {
    const out = infer(
      `
// shout :: String p => p -> p
const shout = (str) => str.toUpperCase();
const s = shout("hi");
`,
      ['shout', 's'],
    );
    expect(out.__diagnostics__).toBe('');
    expect(out.shout).toBe('String -> String');
    expect(out.s).toBe('String');
  });

  test('misusing a baked scalar variable in the body is reported', () => {
    const out = infer(
      `
// f :: String p => p -> p
const f = (str) => str * 2;
`,
      ['f'],
    );
    expect(out.__diagnostics__).toMatch(/Cannot unify 'String' with 'Number'/);
  });

  test('a union constraint inside a list resolves per call (var in return)', () => {
    const out = infer(
      `
// f :: (String s, (Number | Boolean) v) => (s, v) -> v
const f = (s, v) => v;
const a = f("k", 3);
const b = f("k", true);
const c = f("k", "oops");
`,
      ['a', 'b'],
    );
    // Per-call precision: the union var resolves to the matching alternative.
    expect(out.a).toBe('Number');
    expect(out.b).toBe('Boolean');
    // A value outside the alternatives is rejected.
    expect(out.__diagnostics__).toMatch(/does not satisfy union constraint/);
  });

  test('a genuinely unknown constraint name is still rejected', () => {
    const out = infer(
      `
// f :: Bogus x => x -> x
const f = (x) => x;
`,
      ['f'],
    );
    expect(out.__diagnostics__).toMatch(/Unknown constraint 'Bogus'/);
  });
});
