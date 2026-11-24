import { InferenceEngine } from '../../src/infer';

describe('point-free curried callback arity (issue 5)', () => {
  test('`.map(dumpKey(this))` — a CallExpression callback returning a unary function pads to the callback slot', () => {
    const src = `
// dumpKey :: a -> String -> String
const dumpKey = (ctx) => (s) => s;

const arr = ["a", "b"];
const out = arr.map(dumpKey(null));
`;
    const { diagnostics } = new InferenceEngine().infer(src);
    expect(diagnostics.map(d => d.message)).toEqual([]);
  });

  test('identifier callback still type-checks (regression guard)', () => {
    const src = `
const arr = [1, 2];
const out = arr.map(String);
`;
    const { diagnostics } = new InferenceEngine().infer(src);
    expect(diagnostics.map(d => d.message)).toEqual([]);
  });

  test('a genuinely mismatched point-free callback return still reports', () => {
    const src = `
// makeBad :: a -> Number -> Boolean
const makeBad = (ctx) => (n) => true;

// wantsString :: ((String, Number, [String]) -> String) -> [String]
const wantsString = (cb) => ["x"];

const out = wantsString(makeBad(null));
`;
    const { diagnostics } = new InferenceEngine().infer(src);
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  // --- p5: confirm the fix generalises beyond `f(x)` point-free callbacks ---

  test('member-expression callback returning a unary function pads to the callback slot', () => {
    const src = `
// helpers :: { fmt :: String -> String }
const helpers = { fmt: (s) => s };

const arr = ["a", "b"];
const out = arr.map(helpers.fmt);
`;
    const { diagnostics } = new InferenceEngine().infer(src);
    expect(diagnostics.map(d => d.message)).toEqual([]);
  });

  test('a curried-result callback (a chained call returning a function) pads to the callback slot', () => {
    const src = `
// pick :: a -> b -> String -> String
const pick = (x) => (y) => (s) => s;

const arr = ["a", "b"];
const out = arr.map(pick(1)(2));
`;
    const { diagnostics } = new InferenceEngine().infer(src);
    expect(diagnostics.map(d => d.message)).toEqual([]);
  });
});
