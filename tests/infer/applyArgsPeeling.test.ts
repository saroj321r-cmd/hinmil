// Follow-up Phase 2/3: `applyArgs :: (a -> b -> ... -> z) -> [a, b, ...] -> z`.
//
// When a concrete curried function is applied via the `[a, b, ...]` (SpreadArray)
// applier, the result is derived by PEELING the function by the number of array
// elements:
//   - elements === levels  -> full application, result is the terminal `z`
//   - elements <  levels    -> partial application, result is the curried remainder
//   - elements >  levels    -> over-application (runtime crash) -> diagnostic
//
// A function level that takes more than one parameter (`(x, dummy) => …`) has no
// clean per-level correspondence and is rejected (Phase 3).

import { InferenceEngine } from '../../src/infer';
import { prettyTypeToString, Type } from '../../src/hm/types';

// `reduce`'s container parameter is a bare polymorphic var (`c`) — no Array,
// no Foldable — so the harness isolates the peeling behaviour from method /
// constraint resolution.
const PRELUDE = `
// apply :: (a -> b) -> a -> b
const apply = (f) => (x) => f(x);
// reduce :: (b -> a -> b) -> b -> c -> b
const reduce = (f) => (acc) => (xs) => acc;
// applyArgs :: (a -> b -> ... -> z) -> [a, b, ...] -> z
const applyArgs = reduce(apply);
`;

function run(expr: string): { type: Type | null; diags: string[] } {
  const src = `${PRELUDE}\nconst ex = ${expr};\n`;
  const r = new InferenceEngine().infer(src);
  const off = src.indexOf('const ex = ') + 'const '.length;
  const entry = r.nodeTypes.get(off);
  return {
    type: entry ? r.substitution.apply(entry.type) : null,
    diags: r.diagnostics.map((d) => d.message),
  };
}

describe('applyArgs — peeling result type', () => {
  test('the annotated binding alone produces no diagnostics', () => {
    const src = `${PRELUDE}`;
    const r = new InferenceEngine().infer(src);
    expect(r.diagnostics.map((d) => d.message)).toEqual([]);
  });

  test('full application (2 levels, 2 elements) yields the terminal result', () => {
    const { type, diags } = run('applyArgs(x => y => x + y)([1, 2])');
    expect(prettyTypeToString(type!)).toBe('Number');
    expect(diags).toEqual([]);
  });

  test('partial application (3 levels, 2 elements) yields a 1-arg remainder', () => {
    const { type, diags } = run('applyArgs(x => y => z => x + y)([1, 2])');
    expect(prettyTypeToString(type!)).toBe('a -> Number');
    expect(diags).toEqual([]);
  });

  test('partial application (4 levels, 2 elements) yields a 2-arg remainder', () => {
    const { type, diags } = run('applyArgs(w => x => y => z => w + x)([1, 2])');
    expect(prettyTypeToString(type!)).toBe('a -> b -> Number');
    expect(diags).toEqual([]);
  });

  test('heterogeneous element types are tied to the function parameters', () => {
    const { type, diags } = run('applyArgs(s => n => s)(["hi", 42])');
    expect(prettyTypeToString(type!)).toBe('String');
    expect(diags).toEqual([]);
  });
});

describe('applyArgs — over-application diagnostic', () => {
  test('more elements than function levels is flagged', () => {
    const { diags } = run('applyArgs(x => x)([1, 2])');
    expect(
      diags.some((m) => /takes at most 1 argument/.test(m)),
    ).toBe(true);
  });

  test('a matching arity is NOT flagged as over-application', () => {
    const { diags } = run('applyArgs(x => y => x + y)([1, 2])');
    expect(diags.some((m) => /takes at most/.test(m))).toBe(false);
  });
});

describe('applyArgs — multi-parameter levels soft-collapse', () => {
  test('a level with two parameters collapses to its first parameter', () => {
    const { diags } = run('applyArgs((x, dummy) => y => x + y)([1, 2])');
    expect(
      diags.some((m) => /single-parameter \(curried\) levels/.test(m)),
    ).toBe(false);
  });

  test('a single-parameter curried function is accepted', () => {
    const { diags } = run('applyArgs(x => y => x + y)([1, 2])');
    expect(
      diags.some((m) => /single-parameter \(curried\) levels/.test(m)),
    ).toBe(false);
  });
});
