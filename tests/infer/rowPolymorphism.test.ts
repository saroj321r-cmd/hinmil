// ============================================================================
// Row polymorphism — `{ x, ...rest } => rest` infers a polymorphic record
// where the row variable absorbs caller-supplied surplus fields.
//
// Also covers:
//   * bigint / symbol typeof narrowing
//   * `42n` BigInt literal inference
// ============================================================================

import { InferenceEngine } from '../../src/index';
import {
  Type,
  resetTypeVarCounter,
  prettyTypeToString,
} from '../../src/hm/types';

function findVarType(
  result: import('../../src/infer').InferenceResult,
  source: string,
  name: string,
): Type | null {
  for (const keyword of ['const ', 'let ', 'var ']) {
    const idx = source.indexOf(keyword + name);
    if (idx < 0) continue;
    const entry = result.nodeTypes.get(idx + keyword.length);
    if (entry) return result.substitution.apply(entry.type);
  }
  return null;
}

let engine: InferenceEngine;
beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

// ---------------------------------------------------------------------------
// Row polymorphism
// ---------------------------------------------------------------------------

describe('Row polymorphism — destructuring rest pattern', () => {
  test('rest binding on parameter destructure infers as open record', () => {
    const src = `
const drop = ({ x, ...rest }) => rest;
`;
    const r = engine.infer(src);
    const t = findVarType(r, src, 'drop');
    expect(t).not.toBeNull();
    // The inferred type should mention a row variable: `{ x :: a, ...r } -> { ...r }`
    const s = prettyTypeToString(t!);
    expect(s).toMatch(/\.\.\./);
  });

  test('rest binding receives leftover concrete fields at callsite', () => {
    const src = `
const drop = ({ x, ...rest }) => rest;
const out = drop({ x: 1, y: "two", z: true });
`;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const t = findVarType(r, src, 'out');
    expect(t).not.toBeNull();
    const s = prettyTypeToString(t!);
    // After substitution, `rest`'s row variable should resolve to the
    // surplus fields y and z (any order).
    expect(s).toContain('y :: String');
    expect(s).toContain('z :: Boolean');
    expect(s).not.toContain('x ::');
  });

  test('without rest pattern, parameter stays closed (no row variable leak)', () => {
    const src = `
const takeX = ({ x }) => x;
`;
    const r = engine.infer(src);
    const t = findVarType(r, src, 'takeX');
    expect(t).not.toBeNull();
    // No row variable when `...rest` is absent.
    expect(prettyTypeToString(t!)).not.toMatch(/\.\.\.[a-z]/);
  });

  test('caller passing extra fields is still accepted (closed-vs-closed lenience preserved)', () => {
    const src = `
const takeX = ({ x }) => x;
const v = takeX({ x: 1, y: 2 });
`;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('closed annotation rejects fields the value cannot have (dropped by rest pattern)', () => {
    const src = `
const drop = ({ x, ...rest }) => rest;
// leftover :: { y :: String, z :: Boolean, x :: Number }
const leftover = drop({ x: 1, y: "two", z: true });
`;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].message).toMatch(/Missing record fields:.*'x'/);
  });
});

// ---------------------------------------------------------------------------
// bigint / symbol narrowing + BigInt literal
// ---------------------------------------------------------------------------

describe('typeof narrowing — bigint / symbol', () => {
  test('typeof x === "bigint" narrows to BigInt', () => {
    const src = `
// f :: (Number | BigInt) -> Number
const f = (x) => typeof x === "bigint" ? Number(x) : x;
`;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('typeof x === "symbol" narrows to Symbol', () => {
    const src = `
// f :: (String | Symbol) -> String
const f = (x) => typeof x === "symbol" ? "sym" : x;
`;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });
});

describe('BigInt literal', () => {
  test('a bigint literal (42n) has type BigInt', () => {
    const src = `
const big = 42n;
`;
    const r = engine.infer(src);
    const t = findVarType(r, src, 'big');
    expect(t).not.toBeNull();
    expect(prettyTypeToString(t!)).toBe('BigInt');
  });
});
