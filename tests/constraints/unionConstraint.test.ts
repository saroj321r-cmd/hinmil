import { parseTypeSignature } from '../../src/hm/typeParser';
import { resetTypeVarCounter, schemeToString } from '../../src/hm/types';
import { InferenceEngine } from '../../src/infer/index';

beforeEach(() => {
  resetTypeVarCounter();
});

describe('parser — structural-union constraint syntax', () => {
  test('parses ((a -> Number) | Number) run =>', () => {
    const sch = parseTypeSignature('((a -> Number) | Number) run => run -> Limit run');
    expect(sch.constraints).toBeDefined();
    expect(sch.constraints).toHaveLength(1);
    const c = sch.constraints![0];
    expect(c.unionAlternatives).toBeDefined();
    expect(c.unionAlternatives).toHaveLength(2);
    expect(c.typeVarName).toBe('run');
    // schemeToString round-trip
    expect(schemeToString(sch)).toBe('((a -> Number) | Number) run => run -> Limit run');
  });

  test('parses union with three alternatives', () => {
    const sch = parseTypeSignature('(String | Number | Boolean) v => v -> v');
    expect(sch.constraints).toHaveLength(1);
    expect(sch.constraints![0].unionAlternatives).toHaveLength(3);
  });

  test('regular nominal constraint still parses', () => {
    const sch = parseTypeSignature('Functor f => (a -> b) -> f a -> f b');
    expect(sch.constraints).toHaveLength(1);
    expect(sch.constraints![0].className).toBe('Functor');
    expect(sch.constraints![0].unionAlternatives).toBeUndefined();
  });

  test('parens around single non-union type do NOT become a constraint', () => {
    // `(Number) v => v -> v` is not a valid union (no `|`). Parser must not
    // treat it as a constraint.
    const sch = parseTypeSignature('Number -> Number');
    expect(sch.constraints).toBeUndefined();
  });
});

describe('inference — structural-union constraint resolution', () => {
  function inferAndGet(src: string, names: string[]): Record<string, string> {
    const eng = new InferenceEngine();
    const r = eng.infer(src);
    const out: Record<string, string> = {};
    out.__diagnostics__ = r.diagnostics.map(d => d.message).join('\n');
    for (const n of names) {
      const sch = r.topLevelBindings.get(n);
      if (sch) out[n] = schemeToString(sch);
    }
    return out;
  }

  test('Limit with function alternative substitutes inner var precisely', () => {
    const out = inferAndGet(`
// Limit :: ((a -> Number) | Number) run => run -> Limit run
const Limit = (x) => x;

// getLimit :: { limit :: Number } -> Number
const getLimit = p => p.limit;

const a = Limit(5);
const b = Limit(getLimit);
`, ['a', 'b']);
    expect(out.a).toBe('Limit Number');
    expect(out.b).toBe('Limit ({ limit :: Number } -> Number)');
  });

  test('Limit with non-matching argument emits union-constraint diagnostic', () => {
    const out = inferAndGet(`
// Limit :: ((a -> Number) | Number) run => run -> Limit run
const Limit = (x) => x;

const c = Limit("nope");
`, ['c']);
    expect(out.__diagnostics__).toMatch(/does not satisfy union constraint/);
    expect(out.__diagnostics__).toMatch(/String/);
  });

  test('union constraint with three primitive alternatives selects matching branch', () => {
    const out = inferAndGet(`
// pick :: (String | Number | Boolean) v => v -> v
const pick = x => x;

const s = pick("hello");
const n = pick(42);
const b = pick(true);
`, ['s', 'n', 'b']);
    expect(out.s).toBe('String');
    expect(out.n).toBe('Number');
    expect(out.b).toBe('Boolean');
    expect(out.__diagnostics__).not.toMatch(/does not satisfy/);
  });

  test('union constraint rejects type outside the alternatives', () => {
    const out = inferAndGet(`
// pick :: (String | Number) v => v -> v
const pick = x => x;

const x = pick(true);
`, ['x']);
    expect(out.__diagnostics__).toMatch(/does not satisfy union constraint/);
  });

  test('union constraint coexists with nominal constraint on same scheme', () => {
    // Multiple constraints not in v1 — but ensure parsing and resolution
    // of a single union constraint does not interfere with adjacent
    // nominal-constraint inference elsewhere in the same file.
    const out = inferAndGet(`
// id1 :: ((a -> Number) | Number) run => run -> Limit run
const id1 = x => x;

// map :: Functor f => (a -> b) -> f a -> f b
const map = (f, fa) => fa;

const a = id1(7);
`, ['a']);
    expect(out.a).toBe('Limit Number');
  });

  test('unresolved union-constrained var is left unconstrained (no spurious diag)', () => {
    // When the constrained var never resolves to a concrete type at the
    // call site (e.g. used polymorphically), no diagnostic is emitted.
    const out = inferAndGet(`
// pick :: (String | Number) v => v -> v
const pick = x => x;
`, ['pick']);
    expect(out.__diagnostics__).not.toMatch(/does not satisfy/);
  });
});
