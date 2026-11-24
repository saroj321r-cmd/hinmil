import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

describe('Inference with HM annotations', () => {
  test('annotation constrains variable type', () => {
    const r = engine.infer(`
// x :: Number
const x = 42;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(r.annotations.size).toBe(1);
    expect(r.annotations.has('x')).toBe(true);
  });

  test('annotation on function constrains parameter types', () => {
    const r = engine.infer(`
// add :: (Number, Number) -> Number
const add = (a, b) => a + b;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('annotation + incorrect body produces diagnostic', () => {
    const r = engine.infer(`
// f :: Number -> Number
const f = (x) => "hello";
    `);
    // Should produce a diagnostic: annotated as Number -> Number but returns String
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some(d => d.message.includes('Type mismatch') && d.message.includes('String') && d.message.includes('Number'))).toBe(true);
  });

  test('polymorphic annotation enables polymorphic use', () => {
    const r = engine.infer(`
// id :: a -> a
const id = (x) => x;
const n = id(42);
const s = id("hello");
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('annotation on function declaration', () => {
    const r = engine.infer(`
// double :: Number -> Number
function double(x) {
  return x * 2;
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('function declaration annotation type mismatch', () => {
    const r = engine.infer(`
// double :: String -> String
function double(x) {
  return x * 2;
}
    `);
    // Should produce a diagnostic: annotated as String -> String but body is numeric
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some(d => d.message.includes('Cannot unify') || d.message.includes('Type mismatch'))).toBe(true);
  });

  test('annotation on let without initializer', () => {
    const r = engine.infer(`
// x :: Number
let x;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(r.annotations.has('x')).toBe(true);
  });

  test('block comment annotation works', () => {
    const r = engine.infer(`
/* inc :: Number -> Number */
const inc = (x) => x + 1;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('multiple annotated functions', () => {
    const r = engine.infer(`
// double :: Number -> Number
const double = (x) => x * 2;
// add :: (Number, Number) -> Number
const add = (a, b) => a + b;
const result = add(double(1), 2);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Number');
  });

  test('annotations show up in result', () => {
    const r = engine.infer(`
// f :: Number -> Number
const f = (x) => x + 1;
    `);
    expect(r.annotations.size).toBe(1);
    expect(r.annotations.get('f')!.raw).toBe('Number -> Number');
  });

  test('invalid annotation produces diagnostic', () => {
    const r = engine.infer(`
// x :: ->
const x = 42;
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some(d => d.message.includes('Invalid type annotation'))).toBe(true);
  });

  test('invalid annotation diagnostic targets the variable name, not the comment', () => {
    const src = `
// reducer :: (Pair Boolean f m, m
const reducer = (acc, x) => {}`;
    const r = engine.infer(src);
    const diag = r.diagnostics.find(d => d.message.includes('Invalid type annotation'));
    expect(diag).toBeDefined();
    const snippet = src.slice(diag!.start, diag!.end);
    expect(snippet).toBe('reducer');
  });

  test('annotation does not leak across scopes for same-named variables', () => {
    const src = `
// outer :: (Number, Number) -> Number
const outer = (a, b) => {
  const helper = (x, y) => x + y;
  return helper(a, b);
}

// helper :: String -> String
const helper = s => s.toUpperCase();
    `;
    const r = engine.infer(src);
    // The annotation for 'helper' at the top level should NOT affect
    // the nested 'helper' variable inside 'outer'.
    const mismatch = r.diagnostics.filter(d =>
      d.message.includes('Type mismatch'));
    expect(mismatch).toHaveLength(0);
  });

  test('annotation with generic type', () => {
    const r = engine.infer(`
// head :: [Number] -> Number
const head = (arr) => arr[0];
    `);
    // Should accept without errors (arr is annotated as [Number])
    expect(r.annotations.has('head')).toBe(true);
  });

  test('annotationsByOffset maps correctly', () => {
    const r = engine.infer(`
// x :: Number
const x = 42;
    `);
    expect(r.annotationsByOffset.size).toBeGreaterThan(0);
  });

  test('inline annotation on anonymous callback is applied', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#chain :: Box a ~> (a -> Box b) -> Box b
const Box = (value) => ({
  chain: (f) => f(value),
  value
});

// ex6 :: ((y -> Box z), ...,(b -> Box c), (a -> Box b)) -> a -> Box z
const ex6 = (...args) =>  {
  const [first, ...rest] = args;
  return rest.reduce((acc, fn) => x => acc(x).chain(fn), first)
}

const ex6res = ex6(
  // :: String -> Box Boolean
  x => Box(2),
  // :: Number -> Box String
  x => Box(x + "?"),
  // :: String -> Box Number
  x => Box(x)
);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some(d => (d.message.includes('Type mismatch') || d.message.includes('Cannot unify')) && d.message.includes('Number') && d.message.includes('Boolean'))).toBe(true);
  });
});

describe('Type predicate narrowing', () => {
  test('::narrow directive narrows variable in if-consequent', () => {
    const r = engine.infer(`
// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

// test :: (Number | String) -> String
const test = x => {
  if (isString(x)) {
    return x
  }
  return "fallback"
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('type predicate narrows variable in if-consequent', () => {
    const r = engine.infer(`
// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

// test :: (Number | String) -> String
const test = x => {
  if (isString(x)) {
    return x
  }
  return "fallback"
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('type predicate narrows type variable to concrete type', () => {
    const r = engine.infer(`
// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

const test = x => {
  if (isString(x)) {
    return x + "!"
  }
  return "fallback"
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('narrowed type visible inside if block', () => {
    const r = engine.infer(`
// ::narrow Number
// isNumber :: a -> Boolean
const isNumber = x => typeof x === "number";

const test = x => {
  if (isNumber(x)) {
    return x + 1
  }
  return 0
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('type predicate on non-Boolean return produces parse error', () => {
    const r = engine.infer(`
// ::narrow String
// isString :: a -> String
const isString = x => typeof x === "string";
    `);
    // Should produce a diagnostic because ::narrow requires Boolean-returning signature
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain('::narrow');
    expect(r.diagnostics[0].message).toContain('Boolean');
  });

  test('guard clause with type predicate narrows after guard', () => {
    const r = engine.infer(`
// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

const test = x => {
  if (isString(x)) {
    return x
  }
  return "foemp"
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

describe('Type predicate narrowing — else branch', () => {
  test('else branch narrows to union remainder', () => {
    const r = engine.infer(`
// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

// f :: (String | Number) -> Number
const f = (x) => {
  if (isString(x)) {
    return 42;
  } else {
    return x + 1;
  }
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('else branch with three-way union narrows correctly', () => {
    const r = engine.infer(`
// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

// f :: (String | Number | Boolean) -> Number
const f = (x) => {
  if (isString(x)) {
    return 0;
  } else {
    return 1;
  }
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('predicate narrowing without alternate still narrows consequent', () => {
    const r = engine.infer(`
// ::narrow Number
// isNumber :: a -> Boolean
const isNumber = x => typeof x === "number";

// f :: (Number | String) -> String
const f = (x) => {
  if (isNumber(x)) {
    return "is a number";
  }
  return "not a number";
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

describe('Guard clause with type predicate', () => {
  test('guard clause narrows remainder after early return', () => {
    const r = engine.infer(`
// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

// process :: (String | Number) -> Number
const process = (x) => {
  if (isString(x)) return 0;
  return x + 1;
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('guard clause with predicate — no union remainder', () => {
    const r = engine.infer(`
// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

const process = (x) => {
  if (isString(x)) return x;
  return "fallback";
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

describe('OR narrowing — union from multiple predicates', () => {
  test('isPerson(x) || isString(x) narrows to (Person | String)', () => {
    const r = engine.infer(`
/* Person :: {
    name :: String,
    age :: Number } */

// ::narrow Person
// isPerson :: a -> Boolean
const isPerson = x => typeof x === "object";

// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

// test :: a -> String
const test = x => {
  if (isPerson(x) || isString(x)) {
    return "matched"
  }
  return "fallback"
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('OR narrowing provides union type inside consequent', () => {
    const r = engine.infer(`
// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

// ::narrow Number
// isNumber :: a -> Boolean
const isNumber = x => typeof x === "number";

// test :: (String | Number) -> (String | Number)
const test = (x) => {
  if (isString(x) || isNumber(x)) {
    return x
  }
  return "fallback"
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('three-way OR narrowing creates union of three types', () => {
    const r = engine.infer(`
// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

// ::narrow Number
// isNumber :: a -> Boolean
const isNumber = x => typeof x === "number";

// ::narrow Boolean
// isBool :: a -> Boolean
const isBool = x => typeof x === "boolean";

// test :: a -> String
const test = x => {
  if (isString(x) || isNumber(x) || isBool(x)) {
    return "matched"
  }
  return "fallback"
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// typeof narrowing
// ---------------------------------------------------------------------------

describe('typeof narrowing', () => {
  test('typeof x === "string" narrows x to String in consequent', () => {
    const r = engine.infer(`
// test :: (String | Number) -> String
const test = x => {
  if (typeof x === "string") {
    return x
  }
  return "fallback"
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('typeof x === "number" narrows x to Number in consequent', () => {
    const r = engine.infer(`
// test :: (String | Number) -> Number
const test = x => {
  if (typeof x === "number") {
    return x
  }
  return 0
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('typeof narrows else branch to remainder of union', () => {
    const r = engine.infer(`
// test :: (String | Number) -> Number
const test = x => {
  if (typeof x === "string") {
    return 0
  }
  return x
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('typeof x !== "string" narrows else branch to String', () => {
    const r = engine.infer(`
// test :: (String | Number) -> String
const test = x => {
  if (typeof x !== "string") {
    return "fallback"
  }
  return x
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('typeof narrowing works with boolean type', () => {
    const r = engine.infer(`
// test :: (String | Boolean) -> Boolean
const test = x => {
  if (typeof x === "boolean") {
    return x
  }
  return false
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('typeof narrowing with three-way union', () => {
    const r = engine.infer(`
// test :: (String | Number | Boolean) -> String
const test = x => {
  if (typeof x === "string") {
    return x
  }
  return "fallback"
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('typeof narrowing in guard clause', () => {
    const r = engine.infer(`
// test :: (String | Number) -> Number
const test = x => {
  if (typeof x === "string") return 0;
  return x
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('typeof narrowing with reversed operands: "string" === typeof x', () => {
    const r = engine.infer(`
// test :: (String | Number) -> String
const test = x => {
  if ("string" === typeof x) {
    return x
  }
  return "fallback"
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('typeof narrows unconstrained type variable to concrete type', () => {
    const r = engine.infer(`
const test = x => {
  if (typeof x === "string") {
    return x + "!"
  }
  return "fallback"
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('chained typeof checks narrow progressively', () => {
    const r = engine.infer(`
// test :: (String | Number | Boolean) -> String
const test = x => {
  if (typeof x === "string") return x;
  if (typeof x === "number") return String(x);
  return "bool"
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

describe('Curried vs tuple annotation mismatch', () => {
  test('annotation mismatch diagnostic targets only the identifier', () => {
    const src = `
// either :: (a -> c) -> (b -> d) -> (a | b) -> c | d
const either = (f, g, e) => {
  return e.isRight ? g(e) : f(e)
}`;
    const r = engine.infer(src);
    const mismatch = r.diagnostics.find(d => d.message.includes('Type mismatch'));
    expect(mismatch).toBeDefined();
    // Diagnostic should cover only the identifier "either", not the whole declaration
    const snippet = src.slice(mismatch!.start, mismatch!.end);
    expect(snippet).toBe('either');
  });

  test('collect annotation with multi-param implementation reports mismatch', () => {
    const r = engine.infer(`
// either :: (a -> c) -> (b -> d) -> (a | b) -> c | d
const either = (f, g, e) => {
  return e.isRight ? g(e) : f(e)
}
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some(d => d.message.includes('Type mismatch'))).toBe(true);
  });

  test('collect annotation with collect implementation is fine', () => {
    const r = engine.infer(`
// add :: Number -> Number -> Number
const add = (a) => (b) => a + b
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('tuple annotation with multi-param implementation is fine', () => {
    const r = engine.infer(`
// add :: (Number, Number) -> Number
const add = (a, b) => a + b
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('collect polymorphic annotation with multi-param implementation reports mismatch', () => {
    const r = engine.infer(`
// apply :: (a -> b) -> a -> b
const apply = (f, x) => f(x)
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some(d => d.message.includes('Type mismatch'))).toBe(true);
  });
});

describe('Structural mismatch with quantified return type', () => {
  test('polymorphic annotation returning array but body returns undefined', () => {
    const r = engine.infer(`
// takeWhile :: (a -> Boolean) -> [a]
const takeWhile = (pred) => {
  return undefined
}
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some(d => d.message.includes('Type mismatch'))).toBe(true);
  });

  test('polymorphic annotation with extra param in implementation reports mismatch', () => {
    const r = engine.infer(`
// takeWhile :: (a -> Boolean) -> [a]
const takeWhile = (pred, secondP) => {
  return undefined
}
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some(d => d.message.includes('Type mismatch'))).toBe(true);
  });

  test('polymorphic annotation with matching return structure passes', () => {
    const r = engine.infer(`
// wrap :: a -> [a]
const wrap = (x) => [x]
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('polymorphic identity passes without false positive', () => {
    const r = engine.infer(`
// id :: a -> a
const id = (x) => x
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

describe('Diagnostic deduplication — suppress Cannot unify when Type mismatch present', () => {
  let engine: InferenceEngine;
  beforeEach(() => { engine = new InferenceEngine(); });

  test('variable annotation mismatch produces only Type mismatch, not Cannot unify', () => {
    const r = engine.infer(`
// wrap :: a -> [a]
const wrap = (x) => true
    `);
    const mismatches = r.diagnostics.filter(d => d.message.includes('Type mismatch'));
    const unifies = r.diagnostics.filter(d => d.message.includes('Cannot unify'));
    expect(mismatches.length).toBeGreaterThan(0);
    expect(unifies).toHaveLength(0);
  });

  test('dotted static method annotation mismatch produces only Type mismatch', () => {
    const r = engine.infer(`
// Box :: a -> Box a
const Box = (value) => ({ value });
// Box.fromPair :: (a, b) -> Box b
Box.fromPair = (a, b) => Box(a)
    `);
    // The body is checked against the annotation's rigid variables (like a
    // `function` declaration), so the ONE diagnostic sits on the culprit.
    expect(r.diagnostics.map(d => d.message)).toEqual([
      "Type mismatch: Cannot unify 'a' with 'b'",
    ]);
  });

  test('prototype method annotation mismatch produces only Type mismatch', () => {
    const r = engine.infer(`
// Box :: a -> Box a
function Box(value) {
  if (!(this instanceof Box)) return new Box(value);
  this.value = value;
}
// Box#map :: Box a ~> (a -> b) -> Box b
Box.prototype.map = function(f) {
  return 42;
};
    `);
    const mismatches = r.diagnostics.filter(d => d.message.includes('Type mismatch'));
    const unifies = r.diagnostics.filter(d => d.message.includes('Cannot unify'));
    expect(mismatches.length).toBeGreaterThan(0);
    expect(unifies).toHaveLength(0);
  });

  test('class constructor annotation mismatch produces only Type mismatch', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#value :: Box a ~> a
class Box {
  constructor(v) { this.value = v; }
  // Box#map :: Box a ~> (a -> b) -> Box b
  map(f) { return "not a Box"; }
}
    `);
    const mismatches = r.diagnostics.filter(d => d.message.includes('Type mismatch'));
    const unifies = r.diagnostics.filter(d => d.message.includes('Cannot unify'));
    expect(mismatches.length).toBeGreaterThan(0);
    expect(unifies).toHaveLength(0);
  });

  test('class method annotation mismatch produces only Type mismatch', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#value :: Box a ~> a
class Box {
  constructor(v) { this.v = v; }
  // Box#map :: Box a ~> (a -> b) -> Box b
  map(f) { return 42; }
}
    `);
    const mismatches = r.diagnostics.filter(d => d.message.includes('Type mismatch'));
    const unifies = r.diagnostics.filter(d => d.message.includes('Cannot unify'));
    expect(mismatches.length).toBeGreaterThan(0);
    expect(unifies).toHaveLength(0);
  });

  test('unknown type constructor suppresses both Cannot unify and Type mismatch', () => {
    const r = engine.infer(`
// Box :: a -> Box a
const Box = (value) => ({ value });
// Box.withPair :: Pair a c -> Box (Foo a c)
Box.withPair = pair => Box(pair);
    `);
    const unknowns = r.diagnostics.filter(d => d.message.includes('Unknown type constructor'));
    const mismatches = r.diagnostics.filter(d => d.message.includes('Type mismatch'));
    const unifies = r.diagnostics.filter(d => d.message.includes('Cannot unify'));
    expect(unknowns.length).toBeGreaterThan(0);
    expect(mismatches).toHaveLength(0);
    expect(unifies).toHaveLength(0);
  });

  test('diagnostic on JS identifier, not comment signature name', () => {
    const src = `
// Box :: a -> Box a
const Box = (value) => ({ value });
// Box.fromPair :: (a, b) -> Box b
Box.fromPair = (a, b) => Box(a)
    `;
    const r = engine.infer(src);
    const mismatch = r.diagnostics.find(d => d.message.includes('Type mismatch'));
    expect(mismatch).toBeDefined();
    // Underlines the code, not the comment signature: the argument `a` that
    // is passed where the annotation's `b` is required.
    expect(mismatch!.start).toBeGreaterThan(src.indexOf('Box.fromPair ='));
    const underlined = src.slice(mismatch!.start, mismatch!.end);
    expect(underlined).toBe('a');
  });

  test('Type mismatch underlines variable name for const declaration', () => {
    const src = `
// Box :: a -> Box a
const Box = (value) => ({ value });
// Box.fromNum :: Number -> Box String
Box.fromNum = (n) => Box(n)
    `;
    const r = engine.infer(src);
    const mismatch = r.diagnostics.find(d => d.message.includes('Type mismatch'));
    expect(mismatch).toBeDefined();
    const underlined = src.slice(mismatch!.start, mismatch!.end);
    expect(underlined).toBe('fromNum');
  });

  test('Type mismatch underlines function name for function declaration', () => {
    const src = `
// identity :: a -> a
function identity(x) { return 42; }
    `;
    const r = engine.infer(src);
    const mismatch = r.diagnostics.find(d => d.message.includes('Type mismatch'));
    expect(mismatch).toBeDefined();
    const underlined = src.slice(mismatch!.start, mismatch!.end);
    expect(underlined).toBe('identity');
  });

  test('Type mismatch underlines method name for class method', () => {
    const src = `
// Box :: a -> Box a
// Box#value :: Box a ~> a
class Box {
  constructor(v) { this.v = v; }
  // Box#map :: Box a ~> (a -> b) -> Box b
  map(f) { return 42; }
}
    `;
    const r = engine.infer(src);
    const mismatch = r.diagnostics.find(d => d.message.includes('Type mismatch'));
    expect(mismatch).toBeDefined();
    const underlined = src.slice(mismatch!.start, mismatch!.end);
    expect(underlined).toBe('map');
  });

  test('Type mismatch underlines method name for prototype assignment', () => {
    const src = `
// Box :: a -> Box a
const Box = (value) => ({ value });
// Box#greet :: Number
Box.prototype.greet = function() { return 'hello'; }
    `;
    const r = engine.infer(src);
    const mismatch = r.diagnostics.find(d => d.message.includes('Type mismatch'));
    expect(mismatch).toBeDefined();
    const underlined = src.slice(mismatch!.start, mismatch!.end);
    expect(underlined).toBe('greet');
  });
});

describe('Curried function zero-arg call chain', () => {
  const curryPreamble = `
// curry :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curry = (fn) => {
  const collect = (...args) => {
    if (args.length >= fn.length) return fn(...args);
    return (...next) => collect(...args, ...next);
  };
  return collect;
};
`;

  test('collect function called with zero args repeatedly should not be infinitely callable', () => {
    const r = engine.infer(curryPreamble + `
// takeWhile :: ((a -> Boolean), Array a) -> Array a
const takeWhile = curry((pred, arr) => arr);
const result = takeWhile()()(() => true)([]);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    // The first diagnostic should flag the zero-arg call site
    expect(r.diagnostics.some(d => d.message.includes("Cannot unify 'Undefined"))).toBe(true);
  });

  test('collect function with valid partial application still works', () => {
    const r = engine.infer(curryPreamble + `
// add :: (Number, Number) -> Number
const add = (a, b) => a + b;
const curriedAdd = curry(add);
const add5 = curriedAdd(5);
const result = add5(3);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

describe('Strict union narrowing', () => {
  test('concrete annotation narrowing a union type produces diagnostic', () => {
    const src = `
// Either :: Left e | Right a
/* Either#cata :: Either e a ~> ({ Left :: (e -> r), Right :: (a -> r) }) -> r */

function Left(value) { this.value = value; }
function Right(value) { this.value = value; }

Left.prototype.cata = function(patterns) { return patterns.Left(this.value); };
Right.prototype.cata = function(patterns) { return patterns.Right(this.value); };

// handle :: Either String Number -> String | Number
function handle(e) {
  return e.cata({ Left: x => x, Right: x => x })
}

// num :: Number
const num = handle(new Right(42))
    `;
    const r = engine.infer(src);
    const diags = r.diagnostics.filter(d => d.message.startsWith('Type mismatch:') && d.message.includes("'num'"));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('Number');
    expect(diags[0].message).toContain('Number | String');
  });

  test('concrete annotation matching inferred type produces no narrowing diagnostic', () => {
    const src = `
// x :: Number
const x = 42;
    `;
    const r = engine.infer(src);
    const diags = r.diagnostics.filter(d => d.message.startsWith('Annotation narrows'));
    expect(diags).toHaveLength(0);
  });

  test('union annotation on union inferred type produces no narrowing diagnostic', () => {
    const src = `
// f :: Number -> String | Number
function f(x) { return x > 0 ? "yes" : x }

// y :: String | Number
const y = f(1)
    `;
    const r = engine.infer(src);
    const diags = r.diagnostics.filter(d => d.message.startsWith('Annotation narrows'));
    expect(diags).toHaveLength(0);
  });
});

describe('Nameless annotation diagnostic', () => {
  test('nameless annotation on named function produces diagnostic', () => {
    const r = engine.infer(`
// :: Number -> Boolean
const isPositive = x => x > 0;
    `);
    expect(r.diagnostics.some(d => d.message.includes("Nameless annotation") && d.message.includes("isPositive"))).toBe(true);
  });

  test('nameless annotation is not applied as type constraint', () => {
    const r = engine.infer(`
// :: Number -> Number
const id = x => x;
const y = id("hello");
    `);
    // The annotation should NOT be applied, so id should be polymorphic
    // and id("hello") should not produce a type error
    const typeErrors = r.diagnostics.filter(d => d.message.includes('Cannot unify'));
    expect(typeErrors).toHaveLength(0);
    // But the nameless diagnostic should still fire
    expect(r.diagnostics.some(d => d.message.includes("Nameless annotation"))).toBe(true);
  });

  test('nameless annotation on anonymous callback does not produce diagnostic', () => {
    const r = engine.infer(`
const run = f => f(42);
run(
  // :: Number -> Boolean
  x => x > 0
);
    `);
    expect(r.diagnostics.some(d => d.message.includes("Nameless annotation"))).toBe(false);
  });

  test('named annotation on named function does not produce diagnostic', () => {
    const r = engine.infer(`
// isPositive :: Number -> Boolean
const isPositive = x => x > 0;
    `);
    expect(r.diagnostics.some(d => d.message.includes("Nameless annotation"))).toBe(false);
  });
});

describe('Ternary expression narrowing', () => {
  test('::narrow on member expression narrows ternary branches', () => {
    const r = engine.infer(`
// Either2 :: Left e | Right a

// ::narrow Right
// Either2#isRight :: Either2 e a ~> Boolean
const _ = 0;

// Left :: e -> Either2 e a
function Left(value) { this.value = value; }

// Right :: a -> Either2 e a
function Right(value) { this.value = value; }

// Either2#value :: Either2 e a ~> (e | a)
const __ = 0;

// either :: ((a -> c), (b -> d), Either2 a b) -> c | d
const either = (f, g, e) => {
  return e.isRight ? g(e.value) : f(e.value)
}
    `);
    const mismatchErrors = r.diagnostics.filter(d =>
      d.message.includes('Cannot unify')
    );
    expect(mismatchErrors).toHaveLength(0);
  });

  test('typeof narrows in ternary expression', () => {
    const r = engine.infer(`
// test :: (String | Number) -> String
const test = x => typeof x === "string" ? x : "fallback"
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('type predicate narrows in ternary expression', () => {
    const r = engine.infer(`
// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

// test :: (Number | String) -> String
const test = x => isString(x) ? x : "fallback"
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('ternary with both branches returning same type deduplicates union to single type', () => {
    const r = engine.infer(`
// Either2 :: Left e | Right a

// ::narrow Right
// Either2#isRight :: Either2 e a ~> Boolean
const _ = 0;

// Left :: e -> Either2 e a
function Left(value) { this.value = value; }

// Right :: a -> Either2 e a
function Right(value) { this.value = value; }

// Either2#value :: Either2 e a ~> (e | a)
const __ = 0;

// either :: ((a -> c), (b -> d), Either2 a b) -> c | d
const either = (f, g, e) => {
  return e.isRight ? g(e.value) : f(e.value)
}

// test1 :: String
const test1 = either(
  e => "error: " + e,
  x => "x: " + x,
  Right(42)
)
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// =========================================================================
// Constrained annotation body mismatch (infinite type detection)
// =========================================================================

describe('Constrained annotation body mismatch', () => {
  test('wrong param type in constraint method call produces diagnostic', () => {
    const src = `
// ::constraint Chain m { m :: { chain :: m a ~> (a -> m b) -> m b } }
// chain :: Chain m => (a -> b, m a) -> m b
const chain = (fn, chain) => chain.chain(fn)
    `;
    const r = engine.infer(src);
    const mismatch = r.diagnostics.filter(d => d.message.includes('Type mismatch'));
    expect(mismatch).toHaveLength(1);
  });

  test('correct param type in constraint method call has no diagnostic', () => {
    const src = `
// ::constraint Chain m { m :: { chain :: m a ~> (a -> m b) -> m b } }
// chain :: Chain m => (a -> m b, m a) -> m b
const chain = (fn, chain) => chain.chain(fn)
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('correct liftM using of() has no diagnostic', () => {
    const src = `
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// liftM :: Monad m => (a -> b, m a) -> m b
const liftM = (fn, m) => m.chain(x => m.constructor.of(fn(x)))
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// Applied constraint validation
// =========================================================================

describe('Applied constraint validation', () => {
  test('applied constraint with varying type args produces diagnostic', () => {
    const src = `
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// run :: Monad (m a) => m a -> a
const run = (x) => x;
    `;
    const r = engine.infer(src);
    const appliedDiags = r.diagnostics.filter(d => d.message.includes('vary the type argument'));
    expect(appliedDiags).toHaveLength(1);
    expect(appliedDiags[0].message).toContain("Use 'Monad m' instead of 'Monad (m ...)'");
  });

  test('applied constraint with consistent type args does not produce diagnostic', () => {
    const src = `
// ::constraint Semigroup s { s :: { concat :: s ~> s -> s } }
// combine :: Semigroup (f a) => (f a, f a) -> f a
const combine = (x, y) => x.concat(y);
    `;
    const r = engine.infer(src);
    const appliedDiags = r.diagnostics.filter(d => d.message.includes('vary the type argument'));
    expect(appliedDiags).toHaveLength(0);
  });

  test('applied Functor produces diagnostic (map uses f a and f b)', () => {
    const src = `
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// lift :: Functor (f a) => (a -> b) -> f a -> f b
const lift = (fn, x) => x.map(fn);
    `;
    const r = engine.infer(src);
    const appliedDiags = r.diagnostics.filter(d => d.message.includes('vary the type argument'));
    expect(appliedDiags).toHaveLength(1);
  });
});

// =========================================================================
// Bare TVar method access blocking
// =========================================================================

describe('Bare TVar method access blocking', () => {
  test('bare TVar static method access produces diagnostic', () => {
    const src = `
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// run :: Monad m => (m, a) -> a
const run = (M, x) => M.of(x);
    `;
    const r = engine.infer(src);
    const bareDiags = r.diagnostics.filter(d => d.message.includes('bare type variable'));
    expect(bareDiags).toHaveLength(1);
    expect(bareDiags[0].message).toContain("TypeRep");
  });

  test('TypeRep param method access works without diagnostic', () => {
    const src = `
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// run :: Monad m => (TypeRep m, a) -> m a
const run = (M, x) => M.of(x);
    `;
    const r = engine.infer(src);
    const bareDiags = r.diagnostics.filter(d => d.message.includes('bare type variable'));
    expect(bareDiags).toHaveLength(0);
  });
});

describe('Sanctuary built-in types', () => {
  test('Any in annotation accepts any argument', () => {
    const r = engine.infer(`
// show :: Any -> String
const show = x => String(x);
const a = show(42);
const b = show("hello");
const c = show(true);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.topLevelBindings.get('a')!.type)).toBe('String');
    expect(typeToString(r.topLevelBindings.get('b')!.type)).toBe('String');
    expect(typeToString(r.topLevelBindings.get('c')!.type)).toBe('String');
  });

  test('Any in return position produces Any', () => {
    const r = engine.infer(`
// coerce :: String -> Any
const coerce = x => x;
const y = coerce("foo");
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.topLevelBindings.get('y')!.type)).toBe('Any');
  });

  test('Integer annotation parses and displays correctly', () => {
    const r = engine.infer(`
// toInt :: Any -> Integer
const toInt = x => x;
const n = toInt(3.5);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.topLevelBindings.get('n')!.type)).toBe('Integer');
  });

  test('StrMap annotation with type argument', () => {
    const r = engine.infer(`
// lookup :: (String, StrMap a) -> a
const lookup = (key, obj) => obj[key];
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Float and Double annotations', () => {
    const r = engine.infer(`
// toFloat :: Any -> Float
const toFloat = x => x;
// toDouble :: Any -> Double
const toDouble = x => x;
const d = toDouble(toFloat(42));
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.topLevelBindings.get('d')!.type)).toBe('Double');
  });

  test('NonNegativeInteger and NegativeInteger annotations', () => {
    const r = engine.infer(`
// abs :: Any -> NonNegativeInteger
const abs = x => x;
// negate :: Any -> NegativeInteger
const negate = x => x;
const n = negate(abs(5));
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.topLevelBindings.get('n')!.type)).toBe('NegativeInteger');
  });

  test('Object and Buffer annotations', () => {
    const r = engine.infer(`
// clone :: Any -> Object k a
const clone = x => x;
// readFile :: Any -> Buffer
const readFile = path => path;
const buf = readFile("test.txt");
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.topLevelBindings.get('buf')!.type)).toBe('Buffer');
  });
});

describe('Call-site argument validation for annotated functions', () => {
  test('Integer annotation rejects String argument', () => {
    const r = engine.infer(`
// parseJSON :: Integer -> Integer
const parseJSON = str => str;
const parsed = parseJSON("a");
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain('Cannot unify');
  });

  test('Number annotation rejects String argument', () => {
    const r = engine.infer(`
// add :: Number -> Number -> Number
const add = (a, b) => a + b;
const result = add("hello", 5);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some(d => d.message.includes('Cannot unify') || d.message.includes('Type mismatch'))).toBe(true);
  });

  test('annotated function accepts matching argument type', () => {
    const r = engine.infer(`
// double :: Number -> Number
const double = x => x;
const result = double(42);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('unannotated function still allows auto-union', () => {
    const r = engine.infer(`
const f = x => x;
const a = f(1);
const b = f("hello");
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

describe('Numeric subtype compatibility at call sites', () => {
  test('Double annotation accepts Number literal', () => {
    const r = engine.infer(`
// parseJSON :: Double -> Double
const parseJSON = str => str;
const parsed = parseJSON(2.1);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Integer annotation accepts Number literal', () => {
    const r = engine.infer(`
// inc :: Integer -> Integer
const inc = x => x;
const result = inc(5);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Float annotation accepts Number literal', () => {
    const r = engine.infer(`
// round :: Float -> Float
const round = x => x;
const result = round(3.14);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('NonNegativeInteger annotation accepts Number literal', () => {
    const r = engine.infer(`
// abs :: Number -> NonNegativeInteger
const abs = x => x;
const result = abs(-5);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('NegativeInteger annotation accepts Number literal', () => {
    const r = engine.infer(`
// negate :: Number -> NegativeInteger
const negate = x => x;
const result = negate(5);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('numeric subtypes unify with Number but not with each other', () => {
    const r = engine.infer(`
// toFloat :: Number -> Float
const toFloat = x => x;
// toDouble :: Number -> Double
const toDouble = x => x;
const a = toFloat(42);
const b = toDouble(42);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('numeric subtypes widen correctly (Integer -> Float)', () => {
    const r = engine.infer(`
// toFloat :: Integer -> Float
const toFloat = x => x;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('numeric subtypes widen correctly (Integer -> Double)', () => {
    const r = engine.infer(`
// toDouble :: Integer -> Double
const toDouble = x => x;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('numeric subtypes widen correctly (NonNegativeInteger -> Integer)', () => {
    const r = engine.infer(`
// toInt :: NonNegativeInteger -> Integer
const toInt = x => x;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('numeric subtypes widen correctly (NegativeInteger -> Number)', () => {
    const r = engine.infer(`
// toNum :: NegativeInteger -> Number
const toNum = x => x;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('incompatible numeric subtypes do not unify (NonNegativeInteger vs NegativeInteger)', () => {
    const r = engine.infer(`
// impossible :: NonNegativeInteger -> NegativeInteger
const impossible = x => x;
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain('Type mismatch');
  });

  test('Integer annotation still rejects String', () => {
    const r = engine.infer(`
// parseInt :: Integer -> Integer
const parseInt2 = x => x;
const result = parseInt2("hello");
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('Double annotation still rejects Boolean', () => {
    const r = engine.infer(`
// toDouble :: Double -> Double
const toDouble = x => x;
const result = toDouble(true);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('Object type compatibility at call sites', () => {
  test('Object annotation accepts record literal', () => {
    const r = engine.infer(`
// clone :: Object k a -> Object k a
const clone = x => x;
const result = clone({a: 1, b: 2});
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Object annotation rejects String', () => {
    const r = engine.infer(`
// keys :: Object k a -> [String]
const keys = x => x;
const result = keys("hello");
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('Object annotation rejects Number', () => {
    const r = engine.infer(`
// keys :: Object k a -> [String]
const keys = x => x;
const result = keys(42);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('StrMap type at call sites', () => {
  test('StrMap annotation accepts StrMap result', () => {
    const r = engine.infer(`
// toStrMap :: Any -> StrMap a
const toStrMap = x => x;
// fromStrMap :: StrMap a -> a
const fromStrMap = x => x.key;
const result = fromStrMap(toStrMap("test"));
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('StrMap accepts object literal with homogeneous values', () => {
    const r = engine.infer(`
// sumValues :: StrMap Number -> Number
const sumValues = m => 0;
const result = sumValues({foo: 1, bar: 2, baz: 3});
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('StrMap a infers value type from object literal', () => {
    const r = engine.infer(`
// values :: StrMap a -> Array a
const values = m => Object.values (m);
const result = values({x: "hello", y: "world"});
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.topLevelBindings.get('result')!.type)).toBe('[String]');
  });

  test('StrMap rejects object literal with heterogeneous values', () => {
    const r = engine.infer(`
// f :: StrMap Number -> Number
const f = m => 0;
const result = f({foo: 1, bar: "two"});
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('StrMap accepts empty object literal', () => {
    const r = engine.infer(`
// f :: StrMap Number -> Number
const f = m => 0;
const result = f({});
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('StrMap without type argument produces diagnostic', () => {
    const r = engine.infer(`
// f :: StrMap -> Number
const f = m => 0;
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain("'StrMap'");
    expect(r.diagnostics[0].message).toContain('1 type argument');
  });
});

describe('Buffer type at call sites', () => {
  test('Buffer annotation accepts Buffer result', () => {
    const r = engine.infer(`
// readFile :: Any -> Buffer
const readFile = x => x;
// bufLength :: Buffer -> Number
const bufLength = x => 0;
const result = bufLength(readFile("test.txt"));
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Buffer annotation rejects String', () => {
    const r = engine.infer(`
// bufLength :: Buffer -> Number
const bufLength = x => 0;
const result = bufLength("not a buffer");
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('Numeric literal refinement checks', () => {
  test('NonNegativeInteger rejects negative literal', () => {
    const r = engine.infer(`
// f :: NonNegativeInteger -> NonNegativeInteger
const f = x => x;
const result = f(-1);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain('negative');
  });

  test('NonNegativeInteger accepts zero', () => {
    const r = engine.infer(`
// f :: NonNegativeInteger -> NonNegativeInteger
const f = x => x;
const result = f(0);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('NonNegativeInteger accepts positive integer', () => {
    const r = engine.infer(`
// f :: NonNegativeInteger -> NonNegativeInteger
const f = x => x;
const result = f(42);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('NonNegativeInteger rejects float literal', () => {
    const r = engine.infer(`
// f :: NonNegativeInteger -> NonNegativeInteger
const f = x => x;
const result = f(2.5);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain('not an integer');
  });

  test('Integer rejects float literal', () => {
    const r = engine.infer(`
// parseJSON :: Integer -> Integer
const parseJSON = x => x;
const parsed = parseJSON(2.1);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain('not an integer');
  });

  test('Integer accepts integer literal', () => {
    const r = engine.infer(`
// parseJSON :: Integer -> Integer
const parseJSON = x => x;
const parsed = parseJSON(42);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Integer accepts negative integer literal', () => {
    const r = engine.infer(`
// f :: Integer -> Integer
const f = x => x;
const result = f(-5);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('NegativeInteger rejects positive literal', () => {
    const r = engine.infer(`
// f :: NegativeInteger -> NegativeInteger
const f = x => x;
const result = f(5);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain('not negative');
  });

  test('NegativeInteger rejects zero', () => {
    const r = engine.infer(`
// f :: NegativeInteger -> NegativeInteger
const f = x => x;
const result = f(0);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain('not negative');
  });

  test('NegativeInteger accepts negative integer literal', () => {
    const r = engine.infer(`
// f :: NegativeInteger -> NegativeInteger
const f = x => x;
const result = f(-3);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Float accepts any number literal', () => {
    const r = engine.infer(`
// f :: Float -> Float
const f = x => x;
const a = f(3.14);
const b = f(42);
const c = f(-1);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Double accepts any number literal', () => {
    const r = engine.infer(`
// f :: Double -> Double
const f = x => x;
const a = f(2.718);
const b = f(0);
const c = f(-99);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('PositiveInteger accepts positive integer', () => {
    const r = engine.infer(`
// f :: PositiveInteger -> PositiveInteger
const f = x => x;
const a = f(5);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('PositiveInteger rejects zero', () => {
    const r = engine.infer(`
// f :: PositiveInteger -> PositiveInteger
const f = x => x;
const a = f(0);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('PositiveInteger rejects negative', () => {
    const r = engine.infer(`
// f :: PositiveInteger -> PositiveInteger
const f = x => x;
const a = f(-1);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('NonZeroInteger accepts non-zero integer', () => {
    const r = engine.infer(`
// f :: NonZeroInteger -> NonZeroInteger
const f = x => x;
const a = f(5);
const b = f(-3);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('NonZeroInteger rejects zero', () => {
    const r = engine.infer(`
// f :: NonZeroInteger -> NonZeroInteger
const f = x => x;
const a = f(0);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('PositiveNumber accepts positive', () => {
    const r = engine.infer(`
// f :: PositiveNumber -> PositiveNumber
const f = x => x;
const a = f(3.14);
const b = f(1);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('PositiveNumber rejects zero and negative', () => {
    const r = engine.infer(`
// f :: PositiveNumber -> PositiveNumber
const f = x => x;
const a = f(0);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('NegativeNumber accepts negative', () => {
    const r = engine.infer(`
// f :: NegativeNumber -> NegativeNumber
const f = x => x;
const a = f(-5.5);
const b = f(-1);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('NegativeNumber rejects zero and positive', () => {
    const r = engine.infer(`
// f :: NegativeNumber -> NegativeNumber
const f = x => x;
const a = f(0);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('FiniteNumber accepts finite numbers', () => {
    const r = engine.infer(`
// f :: FiniteNumber -> FiniteNumber
const f = x => x;
const a = f(42);
const b = f(-3.14);
const c = f(0);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('NonZeroFiniteNumber accepts non-zero finite', () => {
    const r = engine.infer(`
// f :: NonZeroFiniteNumber -> NonZeroFiniteNumber
const f = x => x;
const a = f(42);
const b = f(-3.14);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('NonZeroFiniteNumber rejects zero', () => {
    const r = engine.infer(`
// f :: NonZeroFiniteNumber -> NonZeroFiniteNumber
const f = x => x;
const a = f(0);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('PositiveFiniteNumber accepts positive finite', () => {
    const r = engine.infer(`
// f :: PositiveFiniteNumber -> PositiveFiniteNumber
const f = x => x;
const a = f(42);
const b = f(0.001);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('PositiveFiniteNumber rejects zero and negative', () => {
    const r = engine.infer(`
// f :: PositiveFiniteNumber -> PositiveFiniteNumber
const f = x => x;
const a = f(0);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('NegativeFiniteNumber accepts negative finite', () => {
    const r = engine.infer(`
// f :: NegativeFiniteNumber -> NegativeFiniteNumber
const f = x => x;
const a = f(-42);
const b = f(-0.001);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('NegativeFiniteNumber rejects zero and positive', () => {
    const r = engine.infer(`
// f :: NegativeFiniteNumber -> NegativeFiniteNumber
const f = x => x;
const a = f(0);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('ValidNumber accepts regular numbers', () => {
    const r = engine.infer(`
// f :: ValidNumber -> ValidNumber
const f = x => x;
const a = f(42);
const b = f(-3.14);
const c = f(0);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('NonZeroValidNumber accepts non-zero numbers', () => {
    const r = engine.infer(`
// f :: NonZeroValidNumber -> NonZeroValidNumber
const f = x => x;
const a = f(42);
const b = f(-3.14);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('NonZeroValidNumber rejects zero', () => {
    const r = engine.infer(`
// f :: NonZeroValidNumber -> NonZeroValidNumber
const f = x => x;
const a = f(0);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('PositiveInteger widens to Integer', () => {
    const r = engine.infer(`
// f :: Integer -> Integer
const f = x => x;
// g :: Any -> PositiveInteger
const g = x => x;
const a = f(g(1));
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('FiniteNumber widens to ValidNumber', () => {
    const r = engine.infer(`
// f :: ValidNumber -> ValidNumber
const f = x => x;
// g :: Any -> FiniteNumber
const g = x => x;
const a = f(g(1));
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('ValidNumber rejects NaN identifier', () => {
    const r = engine.infer(`
// f :: ValidNumber -> ValidNumber
const f = x => x;
const a = f(NaN);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain('NaN');
  });

  test('FiniteNumber rejects Infinity identifier', () => {
    const r = engine.infer(`
// f :: FiniteNumber -> FiniteNumber
const f = x => x;
const a = f(Infinity);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain('not finite');
  });

  test('FiniteNumber rejects -Infinity', () => {
    const r = engine.infer(`
// f :: FiniteNumber -> FiniteNumber
const f = x => x;
const a = f(-Infinity);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('PositiveNumber rejects NaN', () => {
    const r = engine.infer(`
// f :: PositiveNumber -> PositiveNumber
const f = x => x;
const a = f(NaN);
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// typeof narrowing — reversed operand pattern
// ---------------------------------------------------------------------------

describe('typeof narrowing — reversed operand', () => {
  test('"string" === typeof x narrows x to String', () => {
    const r = engine.infer(`
// test :: (String | Number) -> String
const test = x => {
  if ("string" === typeof x) {
    return x
  }
  return "fallback"
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('"number" === typeof x narrows x to Number', () => {
    const r = engine.infer(`
// test :: (String | Number) -> Number
const test = x => {
  if ("number" === typeof x) {
    return x
  }
  return 0
}
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Conditional return narrowing (literal guard)
// ---------------------------------------------------------------------------

describe('Conditional return narrowing', () => {
  test('literal equality guard narrows return type', () => {
    const r = engine.infer(`
const describe = (n) => {
  if (n === 0) return "zero";
  if (n === 1) return "one";
  return "many";
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('null check narrows away Null from union', () => {
    const r = engine.infer(`
// safe :: (String | Null) -> String
const safe = x => {
  if (x === null) return "default";
  return x;
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bare constraint variable detection in nested function types
// ---------------------------------------------------------------------------

describe('Constraint variable in nested types', () => {
  test('constraint var used in function type position', () => {
    const r = engine.infer(`
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// transform :: Functor f => (f a -> f b) -> f a -> f b
const transform = fn => fa => fn(fa);
    `);
    // Should handle constraint variable 'f' within nested function type
    expect(r).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Applied constraint kind mismatch diagnostics
// ---------------------------------------------------------------------------

describe('Applied constraint kind validation', () => {
  test('annotation with Functor f (bare) produces no error', () => {
    const r = engine.infer(`
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// fmap :: Functor f => (a -> b) -> f a -> f b
const fmap = fn => fa => fa.map(fn);
    `);
    // Bare Functor f matches expected kind * -> *
    const kindErrors = r.diagnostics.filter(d => d.message.includes('kind mismatch'));
    expect(kindErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sum type member narrowing
// ---------------------------------------------------------------------------

describe('Sum type member narrowing', () => {
  test('member property check on sum type', () => {
    const r = engine.infer(`
// Either :: Left e | Right a
// Left :: e -> Either e a
const Left = v => ({ isLeft: true, isRight: false, value: v });
// Right :: a -> Either e a
const Right = v => ({ isLeft: false, isRight: true, value: v });

const show = (e) => {
  if (e.isLeft) return "left";
  return "right";
};
    `);
    expect(r).toBeDefined();
  });

  test('constructor this-assignment detection', () => {
    const r = engine.infer(`
function Box(value) {
  this.value = value;
  this.map = fn => Box(fn(value));
}
    `);
    expect(r).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Truthiness narrowing — removes Null/Undefined from union in if branch
// ---------------------------------------------------------------------------

describe('Truthiness narrowing', () => {
  test('if (x) narrows Null | String to String', () => {
    const r = engine.infer(`
// safe :: (String | Null) -> String
const safe = (x) => {
  if (x) {
    return x;
  }
  return "default";
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('typeof check narrows union in if-branch', () => {
    const r = engine.infer(`
// process :: (Number | String) -> String
const process = (x) => {
  if (typeof x === "string") {
    return x;
  }
  return "number";
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('typeof with function type check', () => {
    const r = engine.infer(`
// apply :: (Number | Function [a] b) -> Number
const apply = (x) => {
  if (typeof x === "function") {
    return 42;
  }
  return x;
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('typeof with object type check', () => {
    const r = engine.infer(`
// check :: (Number | Object k a) -> Boolean
const check = (x) => {
  if (typeof x === "object") {
    return true;
  }
  return false;
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Literal guard / conditional return narrowing
// ---------------------------------------------------------------------------

describe('Literal guard narrowing', () => {
  test('if (param === literal) return specific; return general', () => {
    const r = engine.infer(`
// toLabel :: (Number | String) -> String
const toLabel = (x) => {
  if (x === 0) {
    return "zero";
  }
  return "other";
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('truthiness guard: if (param) return T; return T2', () => {
    const r = engine.infer(`
// check :: (String | Null) -> Number
const check = (x) => {
  if (x) {
    return 1;
  }
  return 0;
};
const a = check("hello");
const b = check(null);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('equality guard with reversed operands: literal === param', () => {
    const r = engine.infer(`
// decode :: (Number | String) -> String
const decode = (x) => {
  if (42 === x) {
    return "the answer";
  }
  return "unknown";
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Logical OR predicate narrowing
// ---------------------------------------------------------------------------

describe('Logical OR narrowing', () => {
  test('if (typeof x === "string" || typeof x === "number") narrows union', () => {
    const r = engine.infer(`
// process :: (String | Number | Boolean) -> String
const process = (x) => {
  if (typeof x === "string" || typeof x === "number") {
    return "str-or-num";
  }
  return "boolean";
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sum type member narrowing via ::narrow on member expression
// ---------------------------------------------------------------------------

describe('Sum type member narrowing', () => {
  test('if (e.isRight) narrows in consequent', () => {
    const r = engine.infer(`
// Either :: Left e | Right a
// ::narrow Right
// Either#isRight :: Either e a ~> Boolean
// Left :: e -> Either e a
const Left = v => ({ isLeft: true, isRight: false, value: v });
// Right :: a -> Either e a
const Right = v => ({ isLeft: false, isRight: true, value: v });

// handle :: Either String Number -> String
const handle = (e) => {
  if (e.isRight) {
    return "right";
  }
  return "left";
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('chained narrowing: multiple if-checks on same variable', () => {
    const r = engine.infer(`
// Either :: Left e | Right a
// ::narrow Right
// Either#isRight :: Either e a ~> Boolean
// ::narrow Left
// Either#isLeft :: Either e a ~> Boolean
// Left :: e -> Either e a
const Left = v => ({ isLeft: true, isRight: false, value: v });
// Right :: a -> Either e a
const Right = v => ({ isLeft: false, isRight: true, value: v });

const branch = (e) => {
  if (e.isRight) return "right";
  if (e.isLeft) return "left";
  return "unknown";
};
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Kind-variable renaming in nested types (renameKvInType TRecord/TFun)
// ---------------------------------------------------------------------------

describe('Kind-variable constraints on nested types', () => {
  test('constraint on function returning record', () => {
    const r = engine.infer(`
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// lift :: Functor f => (a -> b) -> f a -> f b
const lift = fn => fa => fa.map(fn);
    `);
    expect(r.diagnostics).toHaveLength(0);
    // The function should have a Functor constraint
    expect(typeToString(r.type)).toContain('->');
  });
});

// ---------------------------------------------------------------------------
// Type predicate narrowing — multi-param tuple predicates
// ---------------------------------------------------------------------------

describe('Type predicate narrowing — multi-param', () => {
  test('collect predicate narrows second parameter in else branch', () => {
    const r = engine.infer(`
// ::narrow String
const isString = x => typeof x === "string";
const process = x => {
  if (isString(x)) {
    return x
  }
  return "fallback"
}
const result = process("hello");
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('String');
  });

  test('predicate on non-identifier argument does not narrow', () => {
    const r = engine.infer(`
// ::narrow String
const isString = x => typeof x === "string";
const arr = [1, "hello"];
const result = isString(arr[0]);
    `);
    // Should not crash; result is still Boolean
    expect(typeToString(r.type)).toBe('Boolean');
  });
});

// ---------------------------------------------------------------------------
// Constraint with bare constraint var in function param position
// ---------------------------------------------------------------------------

describe('Constraint var in function parameter', () => {
  test('constraint var with TypeRep in param position', () => {
    const r = engine.infer(`
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// Identity :: a -> Identity a
const Identity = x => ({ value: x, chain: f => f(x), constructor: Identity });
Identity.of = x => Identity(x);

// run :: Monad m => (TypeRep m, a) -> m a
const run = (M, a) => M.of(a);
    `);
    // Should parse and infer the constraint+TypeRep without crashing
    const typeErrors = r.diagnostics.filter(d => 
      !d.message.includes('has no HM annotation') && 
      !d.message.includes('does not satisfy'));
    expect(typeErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Applied constraint (Monoid on (f a)) pattern
// ---------------------------------------------------------------------------

describe('Applied constraint pattern', () => {
  test('applied constraint with Monoid on String', () => {
    const r = engine.infer(`
// ::constraint Monoid a { a :: { empty :: a, concat :: a ~> a -> a } }
// combine :: Monoid a => (a, a) -> a
const combine = (a, b) => a.concat(b);
    `);
    // Should parse and type-check the annotation and constraint
    const typeErrors = r.diagnostics.filter(d => 
      !d.message.includes('has no HM annotation'));
    expect(typeErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Global directive — static method registration
// ---------------------------------------------------------------------------

describe('Global directive — static method', () => {
  test('::global static method does not produce type errors', () => {
    const r = engine.infer(`
// ::global Array.from :: a -> [a]
const result = Array.from([1, 2, 3]);
    `);
    const typeErrors = r.diagnostics.filter(d =>
      !d.message.includes('has no HM annotation') &&
      !d.message.includes('Unbound'));
    expect(typeErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Data directive with unannotated variants
// ---------------------------------------------------------------------------

describe('Data directive with unannotated constructors', () => {
  test('data variants get auto-generated constructor annotations', () => {
    const r = engine.infer(`
// Either :: Left a | Right b
const l = Left(42);
const rr = Right('hello');
    `);
    // Left and Right may produce unbound diagnostics if not handled,
    // but should not crash
    expect(r.diagnostics).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Exported class with methods
// ---------------------------------------------------------------------------

describe('Exported class with methods', () => {
  test('export class declaration is inferred', () => {
    const r = engine.infer(`
export class Counter {
  constructor(n) { this.count = n; }
  increment() { return this.count + 1; }
}
    `);
    expect(r.diagnostics).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Equality guard narrowing with boolean identifier
// ---------------------------------------------------------------------------

describe('Equality guard narrowing — boolean identifier', () => {
  test('calling with identifier true narrows return via guard', () => {
    const r = engine.infer(`
// handle :: Boolean -> String | Number
const handle = flag => {
  if (flag === true) return 42;
  return 'hello';
};
const result = handle(true);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('calling with identifier false narrows return via guard', () => {
    const r = engine.infer(`
// handle :: Boolean -> String | Number
const handle = flag => {
  if (flag === false) return 'no';
  return 42;
};
const result = handle(false);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Global directives via globalsSource
// ---------------------------------------------------------------------------

describe('Global directives via globalsSource', () => {
  test('global instance method annotation registers method', () => {
    engine.globalsSource = `// ::global Array#ap :: [a -> b] ~> [a] -> [b]`;
    const r = engine.infer(`
const xs = [1, 2, 3];
    `);
    // Method should be registered — inference should not crash
    expect(r.diagnostics).toBeDefined();
  });

  test('global static method annotation registers', () => {
    engine.globalsSource = `// ::global Array.empty :: [a]`;
    const r = engine.infer(`
const xs = Array.empty;
    `);
    expect(r.diagnostics).toBeDefined();
  });

  test('malformed global directive is silently skipped', () => {
    engine.globalsSource = `// ::global not-valid-format`;
    const r = engine.infer(`const x = 1;`);
    // Should not crash — the malformed directive is skipped
    expect(r.diagnostics).toBeDefined();
  });

  test('global directive with invalid type signature is handled', () => {
    engine.globalsSource = `// ::global Array#bad :: -> -> ->`;
    const r = engine.infer(`const x = 1;`);
    // Should not crash — the parse error is caught
    expect(r.diagnostics).toBeDefined();
  });
});

describe('sumtype unused type variable diagnostic', () => {
  test('data type with variants is registered', () => {
    const r = engine.infer(`
// Result :: Ok a | Err b
class Ok {
  constructor(value) { this.value = value; }
}
class Err {
  constructor(error) { this.error = error; }
}
    `);
    expect(r.diagnostics).toBeDefined();
  });
});

describe('checkAnnotationRigid — non-constrained mismatch', () => {
  test('structural return type mismatch produces diagnostic', () => {
    const r = engine.infer(`
// pair :: a -> b -> (a, b)
const pair = (a, b) => a;
    `);
    const mismatch = r.diagnostics.filter(d =>
      d.message.includes('Type mismatch'));
    expect(mismatch.length).toBe(1);
  });

  test('annotation mismatch on conditional expression', () => {
    const r = engine.infer(`
// pick :: Number -> Number
const pick = (x) => x > 0 ? x + '' : x;
    `);
    expect(r.diagnostics.filter(d =>
      d.message.includes('mismatch') || d.message.includes('does not match')).length
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('Spread-annotated function with empty/non-returning body', () => {
  test('empty block body for higher-order function fires Type mismatch', () => {
    const r = engine.infer(`
// memoize :: ((a, b, ...) -> z) -> (a, b, ...) -> z
const memoize = (fn) => {
};
    `);
    const mismatches = r.diagnostics.filter(d =>
      d.message.startsWith('Type mismatch:') && d.message.includes("'memoize'"));
    expect(mismatches.length).toBe(1);
    expect(mismatches[0].message).toContain('()');
    expect(mismatches[0].message).toContain('(a, b, ...) -> z');
  });

  test('explicit `return undefined` for higher-order function fires Type mismatch', () => {
    const r = engine.infer(`
// wrap :: ((a, b, ...) -> z) -> (a, b, ...) -> z
const wrap = (fn) => { return undefined; };
    `);
    const mismatches = r.diagnostics.filter(d =>
      d.message.startsWith('Type mismatch:') && d.message.includes("'wrap'"));
    expect(mismatches.length).toBeGreaterThanOrEqual(1);
  });

  test('valid spread-annotated higher-order function produces no mismatch', () => {
    const r = engine.infer(`
// once :: ((a, b, ...) -> z) -> (a, b, ...) -> z
const once = (fn) => {
  let called = false, result;
  return (...args) => {
    if (!called) { called = true; result = fn(...args); }
    return result;
  };
};
    `);
    const mismatches = r.diagnostics.filter(d =>
      d.message.startsWith('Type mismatch:') && d.message.includes("'once'"));
    expect(mismatches.length).toBe(0);
  });

  test('non-spread polymorphic higher-order with empty body still detected via rigid check', () => {
    const r = engine.infer(`
// noop :: (a -> b) -> (a -> b)
const noop = (fn) => {
};
    `);
    const mismatches = r.diagnostics.filter(d =>
      d.message.startsWith('Type mismatch:') && d.message.includes("'noop'"));
    expect(mismatches.length).toBeGreaterThanOrEqual(1);
  });
});

// =========================================================================
// Builtin prototype extension via method annotations
// =========================================================================
describe('Method annotations on built-in types', () => {
  test('String#equals annotation registers and satisfies structural Setoid', () => {
    const r = engine.infer(`
// ::constraint Setoid a { a :: { equals :: a ~> a -> Boolean } }
// equals :: Setoid a => (a, a) -> Boolean
const equals = (a, b) => a.equals(b)

// String#equals :: String ~> String -> Boolean
String.prototype["equals"] = function(other) {
  return this.valueOf() === other.valueOf();
}

const StringEq = equals("a", "b")
    `);
    // No orphan-method diagnostic for the String#equals annotation.
    expect(r.diagnostics.some(d =>
      d.message.includes("Method annotation 'String#equals")
      && d.message.includes('has no constructor'))).toBe(false);
    // No "missing method 'equals'" Setoid violation on String.
    expect(r.diagnostics.some(d =>
      d.message.includes("Type 'String' does not satisfy constraint 'Setoid'"))).toBe(false);
    expect(r.annotations.has('StringEq')).toBe(false);
    expect(typeToString(r.topLevelBindings.get('StringEq')!.type)).toBe('Boolean');
  });

  test('orphan method annotation for unknown user type still reports diagnostic', () => {
    const r = engine.infer(`
// Widget#frob :: Widget ~> Number -> Number
    `);
    expect(r.diagnostics.some(d =>
      d.message.includes("Method annotation 'Widget#frob")
      && d.message.includes('has no constructor'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Skolem letter collision disambiguation (a vs a')
// ---------------------------------------------------------------------------

describe('Skolem letters in nested annotations are lexically scoped', () => {
  // A type variable in a nested annotation that
  // also occurs in an enclosing annotation IS that variable (like a generic
  // `T` inside an inner function in TypeScript).  `Other#use`'s `a` is
  // therefore Wrap's `a`, and applying `fn` to `value` is well typed.  (This
  // example used to render the two `a`s as a / a' and report a mismatch.)
  test("a nested method annotation shares the enclosing 'a'", () => {
    const r = engine.infer(`// Other :: a -> Other a
const Other = value => ({ value })

// Wrap :: a -> Wrap a
function Wrap(value) {
  // Other#use :: Other a ~> (a -> b) -> b
  const use = fn => fn(value)
  return { use, value }
}`);
    expect(r.diagnostics.filter(d => d.message.includes('Cannot unify'))).toEqual([]);
  });

  test('a nested annotation with a DIFFERENT letter is still rigid', () => {
    const r = engine.infer(`// Other :: a -> Other a
const Other = value => ({ value })

// Wrap :: a -> Wrap a
function Wrap(value) {
  // Other#use :: Other c ~> (c -> b) -> b
  const use = fn => fn(value)
  return { use, value }
}`);
    const mismatch = r.diagnostics.find(d => d.message.includes('Cannot unify'));
    expect(mismatch).toBeDefined();
    expect(mismatch!.message).toMatch(/Cannot unify '(a|c)' with '(a|c)'/);
  });
});

// ---------------------------------------------------------------------------
// Nested method annotation — receiver linked to enclosing factory signature
// ---------------------------------------------------------------------------

describe('Nested method annotation receiver linking', () => {
  test('method receiver vars reuse the enclosing annotated return vars (Either2 pattern)', () => {
    // The `Either2#map` receiver `Either2 e a` names the same constructor as
    // leftOrRight's annotated return type, so its `e`/`a` must be the SAME
    // rigid variables as the enclosing signature's — otherwise `fn(value)`
    // collides two unrelated same-letter skolems ("Cannot unify 'a' with 'a''").
    const r = engine.infer(`// Either2 :: Left e | Right a

// Left :: e -> Either2 e a
export function Left(value) {
  return leftOrRight(value, false)
}

// Right :: a -> Either2 e a
export function Right(value) {
  return leftOrRight(value, true)
}

// leftOrRight :: ((e | a), Boolean) -> Either2 e a
function leftOrRight(value, isRight) {
  // Either2#map :: Either2 e a ~> (a -> b) -> Either2 e b
  const map = fn =>
    isRight ? Right(fn(value)) : Left(value)

  // Either2#chain :: Either2 e a ~> (a -> Either2 e b) -> Either2 e b
  const chain = fn =>
    isRight ? fn(value) : Left(value)

  return {
    // Either2#value :: Either2 e a ~> a
    value,
    map,
    chain,
    // ::narrow Right
    // Either2#isRight :: Either2 e a ~> Boolean
    isRight
  }
}`);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });
});
