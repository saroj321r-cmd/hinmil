import { typeToString, resetTypeVarCounter, generateCurriedOverloads, flattenCurriedType, tNumber, tString, tBool, tFun } from '../../src/hm/types';

beforeEach(() => {
  resetTypeVarCounter();
});

// ---------------------------------------------------------------------------
// Unit tests for utility functions
// ---------------------------------------------------------------------------

describe('generateCurriedOverloads', () => {
  test('single param returns single overload', () => {
    const overloads = generateCurriedOverloads([tNumber], tString);
    expect(overloads).toHaveLength(1);
    expect(typeToString(overloads[0])).toBe('Number -> String');
  });

  test('two params generates 2 overloads', () => {
    const overloads = generateCurriedOverloads([tNumber, tString], tBool);
    expect(overloads).toHaveLength(2);
    const strs = overloads.map(o => typeToString(o));
    expect(strs).toContain('(Number, String) -> Boolean');
    expect(strs).toContain('Number -> String -> Boolean');
  });

  test('three params generates 4 overloads', () => {
    const overloads = generateCurriedOverloads([tNumber, tNumber, tNumber], tNumber);
    expect(overloads).toHaveLength(4);
    const strs = overloads.map(o => typeToString(o));
    expect(strs).toContain('Number -> Number -> Number -> Number');
    expect(strs).toContain('(Number, Number) -> Number -> Number');
    expect(strs).toContain('Number -> (Number, Number) -> Number');
    expect(strs).toContain('(Number, Number, Number) -> Number');
  });

  test('four params generates 8 overloads', () => {
    const overloads = generateCurriedOverloads([tNumber, tString, tBool, tNumber], tString);
    expect(overloads).toHaveLength(8);
    const strs = overloads.map(o => typeToString(o));
    // Fully curried
    expect(strs).toContain('Number -> String -> Boolean -> Number -> String');
    // All at once
    expect(strs).toContain('(Number, String, Boolean, Number) -> String');
    // Some mixed
    expect(strs).toContain('(Number, String) -> (Boolean, Number) -> String');
    expect(strs).toContain('Number -> (String, Boolean, Number) -> String');
    expect(strs).toContain('(Number, String, Boolean) -> Number -> String');
  });

  test('empty params returns just the result', () => {
    const overloads = generateCurriedOverloads([], tNumber);
    expect(overloads).toHaveLength(1);
    expect(typeToString(overloads[0])).toBe('Number');
  });
});

describe('flattenCurriedType', () => {
  test('flattens curried type', () => {
    const t = tFun(tNumber, tFun(tString, tBool));
    const { params, result } = flattenCurriedType(t);
    expect(params).toHaveLength(2);
    expect(typeToString(params[0])).toBe('Number');
    expect(typeToString(params[1])).toBe('String');
    expect(typeToString(result)).toBe('Boolean');
  });

  test('flattens deeply curried type', () => {
    const t = tFun(tNumber, tFun(tString, tFun(tBool, tNumber)));
    const { params, result } = flattenCurriedType(t);
    expect(params).toHaveLength(3);
    expect(typeToString(result)).toBe('Number');
  });

  test('non-function returns empty params', () => {
    const { params, result } = flattenCurriedType(tNumber);
    expect(params).toHaveLength(0);
    expect(typeToString(result)).toBe('Number');
  });
});
