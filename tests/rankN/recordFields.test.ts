// =============================================================================
// Rank-N phase 5 — `forall` in record fields and toplevel positions
//
// A record field typed `forall a. …` stores a genuinely polymorphic value:
// every access instantiates fresh (usage), and construction of the record
// checks the supplied value by subsumption.
// =============================================================================

import { inferSource, diags } from '../helpers/infer';
import { prettyTypeToString } from '../../src/hm/types';

function bindingType(src: string, name: string): string {
  const r = inferSource(src);
  const sch = r.topLevelBindings.get(name);
  if (!sch) throw new Error(`no binding ${name}`);
  return prettyTypeToString(r.substitution.apply(sch.type));
}

describe('rank-N record fields', () => {
  test('polymorphic field used at two types', () => {
    const src = `
// box :: { run :: forall a. a -> a, label :: String }
const box = { run: x => x, label: "id" };

const n = box.run(1);
const s = box.run("x");
`;
    expect(diags(src)).toEqual([]);
    expect(bindingType(src, 'n')).toBe('Number');
    expect(bindingType(src, 's')).toBe('String');
  });

  test('deferred member access in the callback resolves once the data argument arrives', () => {
    // `s.length` is inferred BEFORE `["aa", "b"]` pins `s` to String — the
    // parked access must be retried so `lens` resolves to [Number], not [b].
    const src = `
// listOps :: { map :: forall a b. (a -> b) -> [a] -> [b], name :: String }
const listOps = { map: fn => xs => xs.map(fn), name: "list" };

const nums = listOps.map(x => x * 2)([1, 2, 3]);
const lens = listOps.map(s => s.length)(["aa", "b"]);
`;
    expect(diags(src)).toEqual([]);
    expect(bindingType(src, 'nums')).toBe('[Number]');
    expect(bindingType(src, 'lens')).toBe('[Number]');
  });

  test('monomorphic field value is rejected at construction', () => {
    const src = `
// badBox :: { run :: forall a. a -> a, label :: String }
const badBox = { run: x => x + 1, label: "inc" };
`;
    const d = diags(src);
    expect(d.some(m => m.includes('not polymorphic enough'))).toBe(true);
    expect(d.length).toBe(1);
  });

  test('polymorphic field forwarded into a forall call slot', () => {
    const src = `
// box :: { run :: forall a. a -> a }
const box = { run: x => x };

// applyBoth :: (forall a. a -> a) -> (Number, String) -> [Number, String]
const applyBoth = f => (n, s) => [f(n), f(s)];

const r = applyBoth(box.run)(1, "one");
`;
    expect(diags(src)).toEqual([]);
  });

  test('rank-1 record fields unchanged (compat)', () => {
    const src = `
// box :: { inc :: Number -> Number }
const box = { inc: x => x + 1 };
const n = box.inc(1);
`;
    expect(diags(src)).toEqual([]);
  });
});

describe('rank-N toplevel forall (prenex hoisting)', () => {
  test('toplevel forall behaves as a plain rank-1 scheme', () => {
    const src = `
// id :: forall a. a -> a
const id = x => x;
const n = id(1);
const s = id("x");
`;
    expect(diags(src)).toEqual([]);
  });

  test('result-position forall is hoisted into the scheme', () => {
    const src = `
// mk :: Number -> forall a. a -> Number
const mk = n => x => n;
const f = mk(1);
const a = f("any");
const b = f(true);
`;
    expect(diags(src)).toEqual([]);
  });
});
