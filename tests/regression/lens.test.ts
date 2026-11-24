// ============================================================================
// lens.test.ts — comprehensive tests for sample/lens.js (Ramda-style lenses)
//
// Verifies that the lens utilities defined in sample/lens.js infer correctly
// under HinMil:
//   • view / set / over preserve types through getter/setter records
//   • lensProp produces a label-polymorphic lens whose type carries the
//     concrete property name when applied to a literal key
//   • composeL chains two lenses end-to-end, producing the right outer
//     getter/setter signature
//   • lensIndex works on arrays
//   • Updates round-trip: setting through a lens preserves the record shape
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { InferenceEngine } from '../../src/infer';
import { typeToString, prettyTypeToString, resetTypeVarCounter, Type } from '../../src/hm/types';

const lensModule = fs.readFileSync(path.join(__dirname, '..', '..', 'sample', 'lens.js'), 'utf-8');

beforeEach(() => {
  resetTypeVarCounter();
});

/** Helper: infer `lensModule + tail`, return the engine result. */
function inferWithLens(tail: string) {
  const engine = new InferenceEngine();
  return engine.infer(lensModule + '\n' + tail);
}

/** Helper: find the inferred type for a top-level `const NAME` in the source. */
function typeOf(source: string, result: ReturnType<InferenceEngine['infer']>, name: string): string | null {
  const re = new RegExp('\\bconst\\s+' + name + '\\b');
  const m = re.exec(source);
  if (!m) return null;
  const identStart = source.indexOf(name, m.index + 'const '.length - 1);
  const entry = result.nodeTypes.get(identStart);
  if (!entry) return null;
  return prettyTypeToString(result.substitution.apply(entry.type));
}

describe('sample/lens.js — module loads cleanly', () => {
  test('no diagnostics in lens.js itself', () => {
    const engine = new InferenceEngine();
    const r = engine.infer(lensModule);
    expect(r.diagnostics).toEqual([]);
  });

  test('lens has expected signature', () => {
    const engine = new InferenceEngine();
    const r = engine.infer(lensModule);
    const t = typeOf(lensModule, r, 'lens');
    expect(t).toBe('(s -> a, (a, s) -> s) -> { getter :: s -> a, setter :: (a, s) -> s }');
  });

  test('view, set, over have lens-typed first parameter', () => {
    const engine = new InferenceEngine();
    const r = engine.infer(lensModule);
    expect(typeOf(lensModule, r, 'view'))
      .toBe('({ getter :: s -> a, setter :: (a, s) -> s }, s) -> a');
    expect(typeOf(lensModule, r, 'set'))
      .toBe('({ getter :: s -> a, setter :: (a, s) -> s }, a, s) -> s');
    expect(typeOf(lensModule, r, 'over'))
      .toBe('({ getter :: s -> a, setter :: (a, s) -> s }, a -> a, s) -> s');
  });

  test('composeL chains two lenses through an intermediate type b', () => {
    const engine = new InferenceEngine();
    const r = engine.infer(lensModule);
    const t = typeOf(lensModule, r, 'composeL');
    expect(t).toBe(
      '({ getter :: s -> b, setter :: (b, s) -> s }, '
      + '{ getter :: b -> c, setter :: (c, b) -> b }) '
      + '-> { getter :: s -> c, setter :: (c, s) -> s }'
    );
  });

  test('lensProp is label-polymorphic in the key', () => {
    const engine = new InferenceEngine();
    const r = engine.infer(lensModule);
    const t = typeOf(lensModule, r, 'lensProp');
    expect(t).toBe(
      'k -> { getter :: { [k] :: a, ...r } -> a, '
      + 'setter :: (a, { [k] :: a, ...r }) -> { [k] :: a, ...r } }'
    );
  });

  test('lensIndex specialises to numeric index and array values', () => {
    const engine = new InferenceEngine();
    const r = engine.infer(lensModule);
    const t = typeOf(lensModule, r, 'lensIndex');
    expect(t).toBe(
      'Number -> { getter :: [a] -> a, setter :: (a, [a]) -> [a] }'
    );
  });
});

describe('lensProp — label-polymorphic property lens', () => {
  test('lensProp("name") fixes the focused field name', () => {
    const r = inferWithLens(`const nameLens = lensProp("name");`);
    expect(r.diagnostics).toEqual([]);
    const t = typeOf(lensModule + '\nconst nameLens = lensProp("name");', r, 'nameLens');
    expect(t).toBe(
      '{ getter :: { name :: a, ...r } -> a, '
      + 'setter :: (a, { name :: a, ...r }) -> { name :: a, ...r } }'
    );
  });

  test('view through lensProp returns the focused field type', () => {
    const tail = `
const nameLens = lensProp("name");
const u = { name: "Alice", age: 30 };
const n = view(nameLens, u);
`;
    const r = inferWithLens(tail);
    expect(r.diagnostics).toEqual([]);
    const t = typeOf(lensModule + '\n' + tail, r, 'n');
    expect(t).toBe('String');
  });

  test('set through lensProp preserves all other fields', () => {
    const tail = `
const nameLens = lensProp("name");
const u = { name: "Alice", age: 30 };
const u2 = set(nameLens, "Bob", u);
`;
    const r = inferWithLens(tail);
    expect(r.diagnostics).toEqual([]);
    const t = typeOf(lensModule + '\n' + tail, r, 'u2');
    expect(t).toContain('name :: String');
    expect(t).toContain('age :: Number');
  });

  test('over through lensProp applies a function and preserves shape', () => {
    const tail = `
const nameLens = lensProp("name");
const u = { name: "Alice", age: 30 };
const u3 = over(nameLens, s => s + "!", u);
`;
    const r = inferWithLens(tail);
    expect(r.diagnostics).toEqual([]);
    const t = typeOf(lensModule + '\n' + tail, r, 'u3');
    expect(t).toContain('name :: String');
    expect(t).toContain('age :: Number');
  });

  test('lensProp with a Number-valued field works (a is fresh per call)', () => {
    const tail = `
const ageLens = lensProp("age");
const u = { name: "Alice", age: 30 };
const a = view(ageLens, u);
const u4 = set(ageLens, 31, u);
`;
    const r = inferWithLens(tail);
    expect(r.diagnostics).toEqual([]);
    const t = typeOf(lensModule + '\n' + tail, r, 'a');
    expect(t).toBe('Number');
  });
});

describe('composeL — two-level lens composition', () => {
  test('composeL of two property lenses focuses through nested records', () => {
    const tail = `
const addrLens = lensProp("addr");
const cityLens = lensProp("city");
const addrCity = composeL(addrLens, cityLens);
const person = { name: "X", addr: { city: "Brussels", zip: 1000 } };
const c1 = view(addrCity, person);
`;
    const r = inferWithLens(tail);
    expect(r.diagnostics).toEqual([]);
    const t = typeOf(lensModule + '\n' + tail, r, 'c1');
    expect(t).toBe('String');
  });

  test('set through composed lens updates the inner field of nested record', () => {
    const tail = `
const addrLens = lensProp("addr");
const cityLens = lensProp("city");
const addrCity = composeL(addrLens, cityLens);
const person = { name: "X", addr: { city: "Brussels", zip: 1000 } };
const p2 = set(addrCity, "Antwerp", person);
`;
    const r = inferWithLens(tail);
    expect(r.diagnostics).toEqual([]);
    const t = typeOf(lensModule + '\n' + tail, r, 'p2');
    // Outer record retains name + addr, inner addr retains zip + city
    expect(t).toContain('name :: String');
    expect(t).toContain('addr ::');
    expect(t).toContain('city :: String');
    expect(t).toContain('zip :: Number');
  });

  test('over through composed lens applies inner update', () => {
    const tail = `
const addrLens = lensProp("addr");
const cityLens = lensProp("city");
const addrCity = composeL(addrLens, cityLens);
const person = { name: "X", addr: { city: "brussels", zip: 1000 } };
const p3 = over(addrCity, s => s + "!", person);
`;
    const r = inferWithLens(tail);
    expect(r.diagnostics).toEqual([]);
    const t = typeOf(lensModule + '\n' + tail, r, 'p3');
    expect(t).toContain('city :: String');
  });
});

describe('lensIndex — array-element lens', () => {
  test('view through lensIndex returns the element type', () => {
    const tail = `
const headLens = lensIndex(0);
const xs = [10, 20, 30];
const h = view(headLens, xs);
`;
    const r = inferWithLens(tail);
    expect(r.diagnostics).toEqual([]);
    const t = typeOf(lensModule + '\n' + tail, r, 'h');
    expect(t).toBe('Number');
  });

  test('set through lensIndex returns an array of the same element type', () => {
    const tail = `
const headLens = lensIndex(0);
const xs = ["a", "b", "c"];
const xs2 = set(headLens, "X", xs);
`;
    const r = inferWithLens(tail);
    expect(r.diagnostics).toEqual([]);
    const t = typeOf(lensModule + '\n' + tail, r, 'xs2');
    expect(t).toBe('[String]');
  });

  test('over through lensIndex applies a same-type endo on the element', () => {
    const tail = `
const headLens = lensIndex(0);
const xs = [1, 2, 3];
const xs2 = over(headLens, n => n + 100, xs);
`;
    const r = inferWithLens(tail);
    expect(r.diagnostics).toEqual([]);
    const t = typeOf(lensModule + '\n' + tail, r, 'xs2');
    expect(t).toBe('[Number]');
  });

  test('compose lensProp with lensIndex: focus into the head of an array field', () => {
    const tail = `
const itemsLens = lensProp("items");
const headLens = lensIndex(0);
const itemsHead = composeL(itemsLens, headLens);
const inv = { items: [10, 20, 30], owner: "X" };
const first = view(itemsHead, inv);
const inv2 = set(itemsHead, 99, inv);
`;
    const r = inferWithLens(tail);
    expect(r.diagnostics).toEqual([]);
    expect(typeOf(lensModule + '\n' + tail, r, 'first')).toBe('Number');
    const t = typeOf(lensModule + '\n' + tail, r, 'inv2');
    expect(t).toContain('items :: [Number]');
    expect(t).toContain('owner :: String');
  });
});

describe('lens factory direct use', () => {
  test('hand-rolled lens via `lens(get, set)` infers correctly', () => {
    const tail = `
// firstNameLens :: { getter :: { firstName :: String, ...r } -> String, setter :: (String, { firstName :: String, ...r }) -> { firstName :: String, ...r } }
const firstNameLens = lens(
  (p) => p.firstName,
  (v, p) => ({ ...p, firstName: v }),
);
const p = { firstName: "Ada", lastName: "Lovelace" };
const fn = view(firstNameLens, p);
const p2 = set(firstNameLens, "Grace", p);
`;
    const r = inferWithLens(tail);
    expect(r.diagnostics).toEqual([]);
    expect(typeOf(lensModule + '\n' + tail, r, 'fn')).toBe('String');
    const t = typeOf(lensModule + '\n' + tail, r, 'p2');
    expect(t).toContain('firstName :: String');
    expect(t).toContain('lastName :: String');
  });
});

describe('label-polymorphism re-instantiation across calls', () => {
  test('two `lensProp` calls with different keys do not mix their `k` bindings', () => {
    const tail = `
const nameLens = lensProp("name");
const ageLens = lensProp("age");
const u = { name: "Alice", age: 30 };
const n = view(nameLens, u);
const a = view(ageLens, u);
`;
    const r = inferWithLens(tail);
    expect(r.diagnostics).toEqual([]);
    expect(typeOf(lensModule + '\n' + tail, r, 'n')).toBe('String');
    expect(typeOf(lensModule + '\n' + tail, r, 'a')).toBe('Number');
  });
});
