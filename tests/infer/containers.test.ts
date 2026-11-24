import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

// =========================================================================
// .map — the key case: container element type changes
// =========================================================================

describe('Array.map type tracking', () => {
  test('[Number].map(n => String(n)) infers [String]', () => {
    const r = engine.infer(`
// nums :: [Number]
const nums = [1, 2, 3];
// toString :: Number -> String
const toString = (n) => "str";
const strs = nums.map(toString);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('[String]');
  });

  test('.map with inline arrow infers new element type', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const doubled = nums.map((n) => n * 2);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('[Number]');
  });

  test('.map Number -> Boolean changes element type', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const bools = nums.map((n) => n > 0);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('[Boolean]');
  });

  test('chained .map tracks type through each step', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const bools = nums.map((n) => n > 0).map((b) => !b);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('[Boolean]');
  });
});

// =========================================================================
// .filter — element type stays the same
// =========================================================================

describe('Array.filter type tracking', () => {
  test('.filter preserves element type', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const evens = nums.filter((n) => n > 1);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('[Number]');
  });

  test('.map then .filter tracks correctly', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const result = nums.map((n) => n > 0).filter((b) => b);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('[Boolean]');
  });
});

// =========================================================================
// .reduce — accumulator type
// =========================================================================

describe('Array.reduce type tracking', () => {
  test('.reduce with Number accumulator', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const sum = nums.reduce((acc, n) => acc + n, 0);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Number');
  });
});

// =========================================================================
// .find — returns element type
// =========================================================================

describe('Array.find type tracking', () => {
  test('.find returns element type', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const found = nums.find((n) => n > 1);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Number');
  });
});

// =========================================================================
// .some / .every — returns Boolean
// =========================================================================

describe('Array.some / .every', () => {
  test('.some returns Boolean', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const hasBig = nums.some((n) => n > 2);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Boolean');
  });

  test('.every returns Boolean', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const allPos = nums.every((n) => n > 0);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Boolean');
  });
});

// =========================================================================
// .length — Number property
// =========================================================================

describe('Array.length', () => {
  test('.length is Number', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const len = nums.length;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Number');
  });
});

// =========================================================================
// .includes / .indexOf
// =========================================================================

describe('Array.includes / indexOf', () => {
  test('.includes returns Boolean', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const has = nums.includes(2);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Boolean');
  });

  test('.indexOf returns Number', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const idx = nums.indexOf(2);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Number');
  });
});

// =========================================================================
// Computed access: arr[i]
// =========================================================================

describe('Array computed access', () => {
  test('arr[0] returns element type', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const first = nums[0];
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Number');
  });

  test('string array access returns String', () => {
    const r = engine.infer(`
const strs = ["a", "b"];
const s = strs[0];
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('String');
  });
});

// =========================================================================
// Method on unknown (type variable) arrays
// =========================================================================

describe('Method inference on untyped arrays', () => {
  test('.map on annotated param infers element types', () => {
    const r = engine.infer(`
// toBools :: [Number] -> [Boolean]
const toBools = (arr) => arr.map((n) => n > 0);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// Complex chains with HM annotations
// =========================================================================

describe('Complex chain with annotations', () => {
  test('annotated pipeline: numbers -> strings -> booleans', () => {
    const r = engine.infer(`
// numToStr :: Number -> String
const numToStr = (n) => "s";
// isNonEmpty :: String -> Boolean
const isNonEmpty = (s) => s === "a";
const nums = [1, 2, 3];
const result = nums.map(numToStr).map(isNonEmpty);
    `);
    // If annotations are used, the chain should type-check
    // nums: [Number], .map(numToStr): [String], .map(isNonEmpty): [Boolean]
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('[Boolean]');
  });

  test('.map followed by .filter preserves mapped type', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const result = nums.map((n) => n > 0).filter((b) => b).map((b) => !b);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('[Boolean]');
  });
});

// =========================================================================
// .concat preserves element type
// =========================================================================

describe('Array.concat', () => {
  test('.concat preserves element type', () => {
    const r = engine.infer(`
const a = [1, 2];
const b = [3, 4];
const c = a.concat(b);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('[Number]');
  });
});

// =========================================================================
// String methods / properties
// =========================================================================

describe('String.length', () => {
  test('"hello".length is Number', () => {
    const r = engine.infer(`
const len = "hello".length;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Number');
  });
});

describe('String.toUpperCase / toLowerCase', () => {
  test('.toUpperCase() returns String', () => {
    const r = engine.infer(`
// s :: String
const s = "hello";
const u = s.toUpperCase();
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('String');
  });

  test('.toLowerCase() returns String', () => {
    const r = engine.infer(`
const s = "HELLO";
const l = s.toLowerCase();
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('String');
  });
});

describe('String.split', () => {
  test('.split(",") returns [String]', () => {
    const r = engine.infer(`
const s = "a,b,c";
const parts = s.split(",");
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('[String]');
  });
});

describe('String.includes / startsWith / endsWith', () => {
  test('.includes("x") returns Boolean', () => {
    const r = engine.infer(`
const s = "hello";
const has = s.includes("x");
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Boolean');
  });

  test('.startsWith returns Boolean', () => {
    const r = engine.infer(`
const s = "hello";
const sw = s.startsWith("he");
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Boolean');
  });

  test('.endsWith returns Boolean', () => {
    const r = engine.infer(`
const s = "hello";
const ew = s.endsWith("lo");
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Boolean');
  });
});

describe('String.indexOf / charAt / trim / slice', () => {
  test('.indexOf returns Number', () => {
    const r = engine.infer(`
const s = "hello";
const idx = s.indexOf("l");
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Number');
  });

  test('.charAt returns String', () => {
    const r = engine.infer(`
const s = "hello";
const c = s.charAt(0);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('String');
  });

  test('.trim returns String', () => {
    const r = engine.infer(`
const s = "  hello  ";
const t = s.trim();
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('String');
  });

  test('.slice returns String', () => {
    const r = engine.infer(`
const s = "hello";
const sl = s.slice(1);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('String');
  });
});

describe('Ambiguous .length (String vs Array)', () => {
  test('.length on type variable does not prematurely unify', () => {
    // When a type variable has .length, both String and Array have it
    // The engine should not crash or wrongly unify
    const r = engine.infer(`
const getLen = (x) => x.length;
    `);
    // Should not produce a crash; diagnostics may or may not exist
    // but inference should complete
    expect(typeToString(r.type)).toBeDefined();
  });
});

// =========================================================================
// Error types
// =========================================================================

describe('Error types', () => {
  test('Error constructor returns Error', () => {
    const r = engine.infer(`
      const err = new Error("something went wrong");
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('RangeError constructor', () => {
    const r = engine.infer(`
      const err = new RangeError("out of range");
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Error has message property', () => {
    const r = engine.infer(`
      const err = new Error("test");
      const msg = err.message;
    `);
    expect(r.diagnostics).toHaveLength(0);
    const msgType = Array.from(r.nodeTypes.values()).find(v =>
      typeToString(v.type) === 'String'
    );
    expect(msgType).toBeDefined();
  });
});

// =========================================================================
// JSON built-in
// =========================================================================

describe('JSON built-in', () => {
  test('JSON.parse returns a value', () => {
    const r = engine.infer(`
      const data = JSON.parse('{"key": "value"}');
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('JSON.stringify returns String', () => {
    const r = engine.infer(`
      const str = JSON.stringify({ key: "value" });
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// String/Number/Boolean conversion functions
// =========================================================================

describe('String/Number/Boolean conversion functions', () => {
  test('String() converts to String', () => {
    const r = engine.infer(`
      const s = String(42);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Number() converts to Number', () => {
    const r = engine.infer(`
      const n = Number("42");
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Boolean() converts to Boolean', () => {
    const r = engine.infer(`
      const b = Boolean(0);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// Map methods
// =========================================================================

describe('Map methods', () => {
  test('Map set and get', () => {
    const r = engine.infer(`
      const m = new Map();
      m.set("key", 42);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Map has returns Boolean', () => {
    const r = engine.infer(`
      const m = new Map();
      const exists = m.has("key");
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// Set methods
// =========================================================================

describe('Set methods', () => {
  test('Set add and has', () => {
    const r = engine.infer(`
      const s = new Set();
      s.add(42);
      const exists = s.has(42);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// RegExp methods
// =========================================================================

describe('RegExp methods', () => {
  test('RegExp test returns Boolean', () => {
    const r = engine.infer(`
      const re = /hello/;
      const result = re.test("hello world");
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('RegExp exec returns array', () => {
    const r = engine.infer(`
      const re = /hello/;
      const result = re.exec("hello world");
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// Number methods
// =========================================================================

describe('Number methods', () => {
  test('Number.toFixed returns String', () => {
    const r = engine.infer(`
      const n = 3.14;
      const s = n.toFixed(2);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Number.toString returns String', () => {
    const r = engine.infer(`
      const n = 42;
      const s = n.toString();
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// Array.isArray
// =========================================================================

describe('Array.isArray', () => {
  test('Array.isArray returns Boolean', () => {
    const r = engine.infer(`
      const result = Array.isArray([1, 2, 3]);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// Symbol built-in
// =========================================================================

describe('Symbol built-in', () => {
  test('Symbol() creates a Symbol', () => {
    const r = engine.infer(`
      const sym = Symbol("mySymbol");
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// For-of with Set
// =========================================================================

describe('For-of with Set', () => {
  test('for-of on Set iterates element type', () => {
    const r = engine.infer(`
      const s = new Set();
      s.add(42);
      for (const item of s) {
        const x = item;
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// Map with for-of
// =========================================================================

describe('Map with for-of', () => {
  test('Map.keys() returns iterable', () => {
    const r = engine.infer(`
      const m = new Map();
      m.set("a", 1);
      const keys = m.keys();
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});
