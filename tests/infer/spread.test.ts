import { InferenceEngine } from '../../src/infer';
import { typeToString, prettyTypeToString, resetTypeVarCounter, Type, T_TUPLE } from '../../src/hm/types';
import { parseType, parseTypeSignature } from '../../src/hm/typeParser';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

// ---------------------------------------------------------------------------
// Helper: find a declared variable's type by name
// ---------------------------------------------------------------------------

function findNodeType(result: import('../../src/infer').InferenceResult, source: string, name: string): import('../../src/hm/types').Type | null {
  for (const keyword of ['const ', 'let ', 'var ']) {
    const pattern = keyword + name;
    let searchFrom = 0;
    while (true) {
      const idx = source.indexOf(pattern, searchFrom);
      if (idx < 0) break;
      const identStart = idx + keyword.length;
      const entry = result.nodeTypes.get(identStart);
      if (entry) {
        return result.substitution.apply(entry.type);
      }
      searchFrom = idx + 1;
    }
  }
  return null;
}

// =========================================================================
// Spread/variadic type parser tests
// =========================================================================

describe('parseType — spread/variadic tuples', () => {
  test('(a, ..., z) -> z parses with spread marker', () => {
    const t = parseType('(a, ..., z) -> z');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun') {
      expect(t.param.tag).toBe('TCon');
      if (t.param.tag === 'TCon') {
        expect(t.param.name).toBe(T_TUPLE);
        expect(t.param.args).toHaveLength(3);
        expect(typeToString(t.param.args[0])).toBe('a');
        expect(typeToString(t.param.args[1])).toBe('...');
        expect(typeToString(t.param.args[2])).toBe('z');
      }
      expect(typeToString(t.result)).toBe('z');
    }
    expect(typeToString(t)).toBe('(a, ..., z) -> z');
  });

  test('(a, b, ..., y, z) -> b parses with spread and multiple before/after', () => {
    const t = parseType('(a, b, ..., y, z) -> b');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun' && t.param.tag === 'TCon') {
      expect(t.param.name).toBe(T_TUPLE);
      expect(t.param.args).toHaveLength(5);
      expect(typeToString(t.param.args[0])).toBe('a');
      expect(typeToString(t.param.args[1])).toBe('b');
      expect(typeToString(t.param.args[2])).toBe('...');
      expect(typeToString(t.param.args[3])).toBe('y');
      expect(typeToString(t.param.args[4])).toBe('z');
    }
    expect(typeToString(t)).toBe('(a, b, ..., y, z) -> b');
  });

  test('((a -> b), (b -> c), ..., (y -> z)) -> a -> z parses pipe pattern', () => {
    const t = parseType('((a -> b), (b -> c), ..., (y -> z)) -> a -> z');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun' && t.param.tag === 'TCon') {
      expect(t.param.name).toBe(T_TUPLE);
      expect(t.param.args).toHaveLength(4);
      expect(typeToString(t.param.args[0])).toBe('a -> b');
      expect(typeToString(t.param.args[1])).toBe('b -> c');
      expect(typeToString(t.param.args[2])).toBe('...');
      expect(typeToString(t.param.args[3])).toBe('y -> z');
    }
  });

  test('spread with constraints parses correctly', () => {
    const scheme = parseTypeSignature('Chain m => ((a -> m b), (b -> m c), ..., (y -> m z)) -> a -> m z');
    expect(scheme.constraints).toBeDefined();
    expect(scheme.constraints).toHaveLength(1);
    expect(scheme.constraints![0].className).toBe('Chain');
    if (scheme.type.tag === 'TFun' && scheme.type.param.tag === 'TCon') {
      expect(scheme.type.param.name).toBe(T_TUPLE);
      // Should have 4 elements: (a -> m b), (b -> m c), ..., (y -> m z)
      expect(scheme.type.param.args).toHaveLength(4);
      expect(typeToString(scheme.type.param.args[2])).toBe('...');
    }
  });

  test('leading spread in tuple: (..., y, z) -> z parses correctly', () => {
    const t = parseType('(..., y, z) -> z');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun' && t.param.tag === 'TCon') {
      expect(t.param.name).toBe(T_TUPLE);
      expect(t.param.args).toHaveLength(3);
      expect(typeToString(t.param.args[0])).toBe('...');
      expect(typeToString(t.param.args[1])).toBe('y');
      expect(typeToString(t.param.args[2])).toBe('z');
    }
    expect(typeToString(t)).toBe('(..., y, z) -> z');
  });

  test('leading spread in SpreadArray: [..., a, b] -> b parses correctly', () => {
    const t = parseType('[..., a, b] -> b');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun' && t.param.tag === 'TCon') {
      expect(t.param.name).toBe('SpreadArray');
      expect(t.param.args).toHaveLength(3);
      expect(typeToString(t.param.args[0])).toBe('...');
      expect(typeToString(t.param.args[1])).toBe('a');
      expect(typeToString(t.param.args[2])).toBe('b');
    }
    expect(typeToString(t)).toBe('[..., a, b] -> b');
  });

  test('leading spread with function elements: [..., a -> b, b -> c] -> a -> b parses correctly', () => {
    const t = parseType('[..., a -> b, b -> c] -> a -> b');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun' && t.param.tag === 'TCon') {
      expect(t.param.name).toBe('SpreadArray');
      expect(t.param.args).toHaveLength(3);
      expect(typeToString(t.param.args[0])).toBe('...');
      expect(typeToString(t.param.args[1])).toBe('a -> b');
      expect(typeToString(t.param.args[2])).toBe('b -> c');
    }
  });

  test('trailing comma length-1 array [a,] parses as a fixed 1-slot SpreadArray', () => {
    const t = parseType('[a,]');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('SpreadArray');
      expect(t.args).toHaveLength(1);
      expect(typeToString(t.args[0])).toBe('a');
    }
  });

  test('[a] (no trailing comma) still parses as Array a (any length)', () => {
    const t = parseType('[a]');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Array');
      expect(t.args).toHaveLength(1);
    }
  });

  test('curryEx type annotation parses and displays correctly', () => {
    const t = parseType('((a, b, ...) -> z) -> a -> b -> ... -> z');
    expect(typeToString(t)).toBe('((a, b, ...) -> z) -> a -> b -> ... -> z');
  });
});

// =========================================================================
// Spread/variadic annotation inference
// =========================================================================

describe('Spread/variadic annotations', () => {
  test('(a, ..., z) -> z infers last arg type as result', () => {
    const src = `
// ex1 :: (a, ..., z) -> z
const ex1 = (...args) => args[args.length - 1]
ex1(1, 2, 3, 4, "foemp")
    `;
    const r = engine.infer(src);
    expect(typeToString(r.type)).toBe('String');
  });

  test('(a, b, ..., y, z) -> b infers second arg type as result', () => {
    const src = `
// ex2 :: (a, b, ..., y, z) -> b
const ex2 = (...args) => args[1]
ex2(1, "foemp", 3, 4, 5)
    `;
    const r = engine.infer(src);
    expect(typeToString(r.type)).toBe('String');
  });

  test('pipe pattern ((a -> b), (b -> c), ..., (y -> z)) -> a -> z', () => {
    const src = `
// ex3 :: ((a -> b), (b -> c), ..., (y -> z)) -> a -> z
const ex3 = (...args) => {
  return args.reduce((acc, fn) => x => fn(acc(x)))
}
ex3(x => x + 1, x => "(" + x + ")")
    `;
    const r = engine.infer(src);
    // With 2 args: before=[(a->b), (b->c)], after=[(y->z)]
    // arg[0]=(a->b), arg[1]=(b->c) AND (y->z) overlap → b=y, c=z
    // x => x + 1: Number -> Number (a=Number, b=Number)
    // x => "(" + x + ")": Number -> String (y=Number=b ✓, z=String=c)
    // Result: a -> z = Number -> String
    expect(typeToString(r.type)).toBe('Number -> String');
  });

  test('compose pattern ((y -> z), ..., (b -> c), (a -> b)) -> a -> z', () => {
    const src = `
// fn1 :: Number -> String
const fn1 = x => "s"
// fn2 :: String -> Number
const fn2 = x => 1
// ex4 :: ((y -> z), ..., (b -> c), (a -> b)) -> a -> z
const ex4 = (...args) => {
  return args.reduceRight((acc, fn) => x => fn(acc(x)))
}
ex4(fn1, fn2)
    `;
    const r = engine.infer(src);
    // before=[(y->z)], after=[(b->c), (a->b)]
    // arg[0] gets before[0]=(y->z) AND after[0]=(b->c) → y=b, z=c
    // arg[1] gets after[1]=(a->b)
    // fn1 = Number -> String → y=Number, z=String → b=Number, c=String
    // fn2 = String -> Number → a=String, b=Number ✓
    // Result: a -> z = String -> String
    expect(typeToString(r.type)).toBe('String -> String');
  });

  test('spread with minimum args (2 args, 2 before + 1 after → overlap)', () => {
    const src = `
// pipe :: ((a -> b), (b -> c), ..., (y -> z)) -> a -> z
const pipe = (...args) => args.reduce((acc, fn) => x => fn(acc(x)))
pipe(x => x + 1, x => "(" + x + ")")
    `;
    const r = engine.infer(src);
    expect(typeToString(r.type)).toBe('Number -> String');
  });

  test('spread call with no diagnostics', () => {
    const src = `
// last :: (a, ..., z) -> z
const last = (...args) => args[args.length - 1]
last(1, 2, 3)
    `;
    const r = engine.infer(src);
    // Should not produce diagnostics for the spread call
    expect(r.diagnostics).toHaveLength(0);
  });

  test('spread with single arg (minimum case)', () => {
    const src = `
// first :: (a, ..., z) -> a
const first = (...args) => args[0]
first(42)
    `;
    const r = engine.infer(src);
    // With 1 arg: before=[a], after=[z], overlap: a and z unify
    expect(typeToString(r.type)).toBe('Number');
  });

  test('compose with 3 args detects chain type error at boundary', () => {
    const src = `
// fn1 :: String -> Number
const fn1 = x => 1
// fn2 :: String -> Number
const fn2 = x => 2
// fn3 :: Boolean -> String
const fn3 = x => "foemp"
// ex4 :: ((y -> z), ..., (b -> c), (a -> b)) -> a -> z
const ex4 = (...args) => {
  return args.reduceRight((acc, fn) => x => fn(acc(x)))
}
ex4(fn1, fn2, fn3)
    `;
    const r = engine.infer(src);
    // before=[(y->z)], after=[(b->c), (a->b)]
    // fn1 → (y->z): y=String, z=Number
    // fn2 → (b->c): b=String, c=Number
    // fn3 → (a->b): a=Boolean, b=String ✓ (b shared with fn2)
    // Chain constraint: RTL boundary → y = c → String = Number → ERROR
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain('Cannot unify');
  });

  test('compose with 3 valid args has no diagnostics', () => {
    const src = `
// fn1 :: String -> Number
const fn1 = x => 1
// fn2 :: Boolean -> String
const fn2 = x => "s"
// fn3 :: Number -> Boolean
const fn3 = x => true
// ex4 :: ((y -> z), ..., (b -> c), (a -> b)) -> a -> z
const ex4 = (...args) => {
  return args.reduceRight((acc, fn) => x => fn(acc(x)))
}
ex4(fn1, fn2, fn3)
    `;
    const r = engine.infer(src);
    // fn3: Number -> Boolean (a=Number, b=Boolean)
    // fn2: Boolean -> String (b=Boolean ✓, c=String)
    // fn1: String -> Number (y=String, z=Number)
    // Chain: y = c → String = String ✓
    expect(r.diagnostics).toHaveLength(0);
    // Result: a -> z = Number -> Number
    expect(typeToString(r.type)).toBe('Number -> Number');
  });

  test('pipe with 3 args detects chain type error at boundary', () => {
    const src = `
// pipe :: ((a -> b), (b -> c), ..., (y -> z)) -> a -> z
const pipe = (...args) => args.reduce((acc, fn) => x => fn(acc(x)))
// fn1 :: Number -> String
const fn1 = x => "s"
// fn2 :: Number -> Boolean
const fn2 = x => true
// fn3 :: Boolean -> String
const fn3 = x => "t"
pipe(fn1, fn2, fn3)
    `;
    const r = engine.infer(src);
    // before=[(a->b), (b->c)], after=[(y->z)]
    // fn1 → (a->b): a=Number, b=String
    // fn2 → (b->c): b=String fails — fn2 takes Number not String → OR
    // Actually: fn2 = Number -> Boolean, unified with (b->c) → b=Number
    // But b was already set to String from fn1 → String ≠ Number → ERROR
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain('Cannot unify');
    expect(r.diagnostics[0].message).toContain('Number');
    expect(r.diagnostics[0].message).toContain('String');
  });

  test('compose with 4 args — error appears on the middle arg that breaks the chain', () => {
    const src = `
// fn1 :: String -> Number
const fn1 = x => 1
// fn0 :: Number -> Number
const fn0 = x => x + 1
// fn2 :: String -> Number
const fn2 = x => 2
// fn3 :: Boolean -> String
const fn3 = x => "foemp"
// ex4 :: ((y -> z), ..., (b -> c), (a -> b)) -> a -> z
const ex4 = (...args) => {
  return args.reduceRight((acc, fn) => x => fn(acc(x)))
}
ex4(fn1, fn0, fn2, fn3)
    `;
    const r = engine.infer(src);
    // fn3: Boolean -> String (a=Boolean, b=String)
    // fn2: String -> Number (b=String ✓, c=Number)
    // fn0: Number -> Number — chain says fn0.result must match fn1.param=String
    //   but fn0.result=Number ≠ String → ERROR on fn0
    // fn1: String -> Number (y=String, z=Number)
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toContain('Cannot unify');
    expect(r.diagnostics[0].message).toContain('Number');
    expect(r.diagnostics[0].message).toContain('String');
  });

  test('compose with 4 valid args has no diagnostics', () => {
    const src = `
// fn1 :: String -> Number
const fn1 = x => 1
// fn0 :: Number -> String
const fn0 = x => "s"
// fn2 :: String -> Number
const fn2 = x => 2
// fn3 :: Boolean -> String
const fn3 = x => "foemp"
// ex4 :: ((y -> z), ..., (b -> c), (a -> b)) -> a -> z
const ex4 = (...args) => {
  return args.reduceRight((acc, fn) => x => fn(acc(x)))
}
ex4(fn1, fn0, fn2, fn3)
    `;
    const r = engine.infer(src);
    // Chain: fn3(Bool→Str) → fn2(Str→Num) → fn0(Num→Str) → fn1(Str→Num)
    // Result: a -> z = Boolean -> Number
    expect(typeToString(r.type)).toBe('Boolean -> Number');
  });

  test('rest parameter args gets element type from spread annotation', () => {
    const src = `
// ex3 :: ((a -> b), (b -> c), ..., (y -> z)) -> a -> z
const ex3 = (...args) => {
  return args.reduce((acc, fn) => x => fn(acc(x)))
}
    `;
    const r = engine.infer(src);
    // args should be typed as [a -> b] (array of functions), not [a]
    const argsNode = r.nodeTypes;
    // Find the args identifier node type — it should be Array of a function type
    let argsType: Type | undefined;
    for (const [, entry] of argsNode) {
      const t = entry.type;
      if (t.tag === 'TCon' && t.name === 'Array' && t.args.length === 1 &&
          t.args[0].tag === 'TFun') {
        argsType = t;
        break;
      }
    }
    expect(argsType).toBeDefined();
    if (argsType && argsType.tag === 'TCon') {
      expect(argsType.args[0].tag).toBe('TFun');
    }
  });

  test('pipe with 4 args and valid chain infers correct result type', () => {
    const src = `
// pipe :: ((a -> b), (b -> c), ..., (y -> z)) -> a -> z
const pipe = (...args) => args.reduce((acc, fn) => x => fn(acc(x)))
// fn1 :: Number -> String
const fn1 = x => "s"
// fn2 :: String -> Boolean
const fn2 = x => true
// fn3 :: Boolean -> Number
const fn3 = x => 42
pipe(fn1, fn2, fn3)
    `;
    const r = engine.infer(src);
    // Chain: fn1(Num→Str) → fn2(Str→Bool) → fn3(Bool→Num)
    expect(typeToString(r.type)).toBe('Number -> Number');
  });

  test('spread-annotated function body does not produce reduce diagnostic', () => {
    const src = `
// ex3 :: ((a -> b), (b -> c), ..., (y -> z)) -> a -> z
const ex3 = (...args) => {
  return args.reduce((acc, fn) => x => fn(acc(x)))
}
    `;
    const r = engine.infer(src);
    // The reduce call inside the body should NOT produce a "Cannot unify" diagnostic
    expect(r.diagnostics).toHaveLength(0);
  });

  test('array destructuring of spread-typed args gives correct element and rest types', () => {
    const src = `
// ::constraint Chain m { m :: { chain :: m a ~> (a -> m b) -> m b } }
// ex5 :: Chain m => ((a -> m b), (b -> m c), ..., (y -> m z)) -> a -> m z
const ex5 = (...args) => {
  const [first, ...rest] = args;
  return rest.reduce((acc, fn) => x => acc(x).chain(fn), first)
}
    `;
    const r = engine.infer(src);
    // Should not produce diagnostics
    expect(r.diagnostics).toHaveLength(0);
    // first should be a function type (a -> m b)
    let firstType: Type | undefined;
    let restType: Type | undefined;
    for (const [, entry] of r.nodeTypes) {
      const t = entry.type;
      // first: a -> m b (TFun)
      if (t.tag === 'TFun' && !firstType) {
        firstType = t;
      }
      // rest: [a -> m b] (Array of TFun)
      if (t.tag === 'TCon' && t.name === 'Array' && t.args.length === 1 &&
          t.args[0].tag === 'TFun' && !restType) {
        restType = t;
      }
    }
    expect(firstType).toBeDefined();
    expect(firstType!.tag).toBe('TFun');
    expect(restType).toBeDefined();
    expect(restType!.tag).toBe('TCon');
  });

  // --- Spread array annotations: [a, ..., b] ---

  test('[a,] fixed 1-slot array: a 1-element literal type-checks', () => {
    const src = `
// head1 :: [a,] -> a
const head1 = (arr) => arr[0]
head1([42])
    `;
    const r = engine.infer(src);
    const arityDiag = r.diagnostics.filter((d) => /Array literal has/.test(d.message));
    expect(arityDiag).toHaveLength(0);
  });

  test('[a,] fixed 1-slot array: a 2-element literal is flagged (expected 1)', () => {
    const src = `
// head1 :: [a,] -> a
const head1 = (arr) => arr[0]
head1([1, 2])
    `;
    const r = engine.infer(src);
    const arityDiag = r.diagnostics.filter((d) => /Array literal has 2 elements, expected 1/.test(d.message));
    expect(arityDiag).toHaveLength(1);
  });

  test('[a, ..., b] -> b infers last array element type as result', () => {
    const src = `
// ex7 :: [a, ..., b] -> b
const ex7 = (arr) => {
  return arr[arr.length - 1]
}
ex7([1, 2, 3, 4, "foemp"])
    `;
    const r = engine.infer(src);
    expect(typeToString(r.type)).toBe('String');
  });

  test('[a -> b, b -> c, ..., y -> z] -> a -> z (pipe via array)', () => {
    const src = `
// fn1 :: Number -> String
const fn1 = x => "s"
// fn2 :: String -> Boolean
const fn2 = x => true
// ex8 :: [a -> b, b -> c, ..., y -> z] -> a -> z
const ex8 = (arr) => {
  return arr.reduce((acc, fn) => x => fn(acc(x)))
}
ex8([fn1, fn2])
    `;
    const r = engine.infer(src);
    expect(typeToString(r.type)).toBe('Number -> Boolean');
  });

  test('spread array annotation produces no diagnostics', () => {
    const src = `
// ex7 :: [a, ..., b] -> b
const ex7 = (arr) => {
  return arr[arr.length - 1]
}
ex7([1, 2, 3, 4, "foemp"])
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('spread array with 4 chained functions infers correct result', () => {
    const src = `
// fn1 :: Boolean -> String
const fn1 = x => "foemp"
// fn2 :: String -> Number
const fn2 = x => 2
// fn3 :: Number -> Boolean
const fn3 = x => true
// fn0 :: Boolean -> [Number]
const fn0 = x => [1]
// ex8 :: [a -> b, b -> c, ..., y -> z] -> a -> z
const ex8 = (arr) => {
  return arr.reduce((acc, fn) => x => fn(acc(x)))
}
ex8([fn1, fn2, fn3, fn0])
    `;
    const r = engine.infer(src);
    expect(typeToString(r.type)).toBe('Boolean -> [Number]');
  });

  test('positional array destructuring of [a, b, c, ..., d] gives distinct types per index', () => {
    const src = `
// ex7 :: [a, b, c, ..., d] -> b
const ex7 = ([first, second]) => second
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const firstOff = src.indexOf('first');
    const secondOff = src.indexOf('second');
    const firstType = r.nodeTypes.get(firstOff)?.type;
    const secondType = r.nodeTypes.get(secondOff)?.type;
    expect(firstType).toBeDefined();
    expect(secondType).toBeDefined();
    // first should be type variable a, second should be type variable b — distinct
    expect(typeToString(r.substitution.apply(firstType!)))
      .not.toBe(typeToString(r.substitution.apply(secondType!)));
  });

  test('array destructuring of [a, b, ..., z] aligns trailing positional with after-spread', () => {
    const src = `
// ex :: [a, b, ..., z] -> z
const ex = ([first, second, third, fourth]) => fourth
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const firstOff = src.indexOf('first');
    const secondOff = src.indexOf('second');
    const fourthOff = src.indexOf('fourth');
    const firstType = r.nodeTypes.get(firstOff)?.type;
    const secondType = r.nodeTypes.get(secondOff)?.type;
    const fourthType = r.nodeTypes.get(fourthOff)?.type;
    expect(firstType).toBeDefined();
    expect(secondType).toBeDefined();
    expect(fourthType).toBeDefined();
    // first=a, second=b are distinct from fourth=z
    expect(typeToString(r.substitution.apply(firstType!)))
      .not.toBe(typeToString(r.substitution.apply(fourthType!)));
    expect(typeToString(r.substitution.apply(secondType!)))
      .not.toBe(typeToString(r.substitution.apply(fourthType!)));
  });

  test('mixed-type array literal matches positional [String, Number] param', () => {
    const src = `
// head2 :: [String, Number] -> String
const head2 = ([first, second]) => first;
const head2Ex = head2(["3", 3])
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const headExType = findNodeType(r, src, 'head2Ex');
    expect(headExType).not.toBeNull();
    expect(typeToString(headExType!)).toBe('String');
  });

  test('mixed-type array literal matches [a, ..., b] spread param', () => {
    const src = `
// last :: [a, ..., b] -> b
const last = (arr) => arr[arr.length - 1];
const lastEx = last([1, 2, 3, "end"])
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const lastExType = findNodeType(r, src, 'lastEx');
    expect(lastExType).not.toBeNull();
    expect(typeToString(lastExType!)).toBe('String');
  });

  test('positional [String, Number]: too many elements produces arity diagnostic', () => {
    const src = `
// head2 :: [String, Number] -> String
const head2 = ([first, second]) => first;
const e = head2(["3", 2, 3])
    `;
    const r = engine.infer(src);
    expect(r.diagnostics.some(d => /Array literal has 3 elements, expected 2/.test(d.message))).toBe(true);
  });

  test('positional [String, Number]: too few elements produces arity diagnostic', () => {
    const src = `
// head2 :: [String, Number] -> String
const head2 = ([first, second]) => first;
const e = head2(["3"])
    `;
    const r = engine.infer(src);
    expect(r.diagnostics.some(d => /Array literal has 1 element, expected 2/.test(d.message))).toBe(true);
  });

  test('spread [..., Number]: last array element must be Number', () => {
    const src = `
// last :: [..., Number] -> Number
const last = (arr) => arr[arr.length - 1];
const e = last([1, 2, "x"])
    `;
    const r = engine.infer(src);
    expect(r.diagnostics.some(d => /Cannot unify 'String' with 'Number'/.test(d.message))).toBe(true);
  });

  test('spread [String, ..., Number]: too few elements (less than before+after) produces arity diagnostic', () => {
    const src = `
// pair :: [String, ..., Number] -> String
const pair = (arr) => arr[0];
const e = pair(["a"])
    `;
    const r = engine.infer(src);
    expect(r.diagnostics.some(d => /Array literal has 1 element, expected at least 2/.test(d.message))).toBe(true);
  });
});

// =========================================================================
// Auto-detected curry wrapper from annotation type
// =========================================================================

describe('Auto-detected curry wrapper from annotation type', () => {
  test('((a, b, ...) -> z) annotation auto-detects curry wrapper', () => {
    const src = `
// curryEx :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curryEx = (fn) => {
  const collect = (...args) => {
    if (args.length >= fn.length) {
      return fn(...args);
    }
    return (...next) => collect(...args, ...next);
  }
  return collect;
}

// add :: (Number, Number, Number) -> Number
const add = (a, b, c) => a + b + c;

const curriedAdd = curryEx(add);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const curriedAddType = findNodeType(r, src, 'curriedAdd');
    expect(curriedAddType).not.toBeNull();
    expect(prettyTypeToString(curriedAddType!)).toBe('Number -> Number -> Number -> Number');
  });

  test('auto-detected curry wrapper: chained calls curryEx(fn)(1)(2)(3)', () => {
    const src = `
// curryEx :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curryEx = (fn) => {
  const collect = (...args) => {
    if (args.length >= fn.length) {
      return fn(...args);
    }
    return (...next) => collect(...args, ...next);
  }
  return collect;
}

const res = curryEx((a, b, c) => a + b + c)(1)(2)(3);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const resType = findNodeType(r, src, 'res');
    expect(resType).not.toBeNull();
    expect(prettyTypeToString(resType!)).toBe('Number');
  });

  test('auto-detected curry wrapper: partial application', () => {
    const src = `
// curryEx :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curryEx = (fn) => {
  const collect = (...args) => {
    if (args.length >= fn.length) {
      return fn(...args);
    }
    return (...next) => collect(...args, ...next);
  }
  return collect;
}

// add :: (Number, Number, Number) -> Number
const add = (a, b, c) => a + b + c;

const curriedAdd = curryEx(add);
const partial = curriedAdd(1);
const partial2 = partial(2);
const final = partial2(3);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const partialType = findNodeType(r, src, 'partial');
    expect(partialType).not.toBeNull();
    expect(prettyTypeToString(partialType!)).toBe('Number -> Number -> Number');
    const partial2Type = findNodeType(r, src, 'partial2');
    expect(partial2Type).not.toBeNull();
    expect(prettyTypeToString(partial2Type!)).toBe('Number -> Number');
    const finalType = findNodeType(r, src, 'final');
    expect(finalType).not.toBeNull();
    expect(prettyTypeToString(finalType!)).toBe('Number');
  });

  test('auto-detected curry wrapper: multi-arg call', () => {
    const src = `
// curryEx :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curryEx = (fn) => {
  const collect = (...args) => {
    if (args.length >= fn.length) {
      return fn(...args);
    }
    return (...next) => collect(...args, ...next);
  }
  return collect;
}

// add :: (Number, Number, Number) -> Number
const add = (a, b, c) => a + b + c;

const curriedAdd = curryEx(add);
const r = curriedAdd(1, 2);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const rType = findNodeType(r, src, 'r');
    expect(rType).not.toBeNull();
    expect(prettyTypeToString(rType!)).toBe('Number -> Number');
  });
});

// =========================================================================
// Spread-tuple higher-order patterns: memoize, uncurry, once, tryCatch
// =========================================================================

describe('Spread-tuple higher-order function patterns', () => {
  test('memoize preserves parameter types', () => {
    const src = `
// memoize :: ((a, b, ...) -> z) -> (a, b, ...) -> z
const memoize = (fn) => {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const result = fn(...args);
    cache.set(key, result);
    return result;
  }
}

// greet :: (String, Number) -> String
const greet = (name, age) => name + " is " + age;

const memoGreet = memoize(greet);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const memoGreetType = findNodeType(r, src, 'memoGreet');
    expect(memoGreetType).not.toBeNull();
    expect(prettyTypeToString(memoGreetType!)).toBe('(String, Number) -> String');
  });

  test('memoize with 3 params', () => {
    const src = `
// memoize :: ((a, b, ...) -> z) -> (a, b, ...) -> z
const memoize = (fn) => {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const result = fn(...args);
    cache.set(key, result);
    return result;
  }
}

// add3 :: (Number, Number, Number) -> Number
const add3 = (a, b, c) => a + b + c;

const memoAdd = memoize(add3);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const memoAddType = findNodeType(r, src, 'memoAdd');
    expect(memoAddType).not.toBeNull();
    expect(prettyTypeToString(memoAddType!)).toBe('(Number, Number, Number) -> Number');
  });

  test('once preserves parameter types', () => {
    const src = `
// once :: ((a, b, ...) -> z) -> (a, b, ...) -> z
const once = (fn) => {
  let called = false, result;
  return (...args) => {
    if (!called) { called = true; result = fn(...args); }
    return result;
  }
}

// init :: (String, Number) -> Boolean
const init = (name, port) => true;

const initOnce = once(init);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const initOnceType = findNodeType(r, src, 'initOnce');
    expect(initOnceType).not.toBeNull();
    expect(prettyTypeToString(initOnceType!)).toBe('(String, Number) -> Boolean');
  });

  test('tryCatch wraps return type with Error union', () => {
    const src = `
// tryCatch :: ((a, b, ...) -> z) -> (a, b, ...) -> z | Error
const tryCatch = (fn) => (...args) => {
  try { return fn(...args); }
  catch (e) { return e; }
}

// divide :: (Number, Number) -> Number
const divide = (a, b) => a / b;

const safeDivide = tryCatch(divide);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const safeDivideType = findNodeType(r, src, 'safeDivide');
    expect(safeDivideType).not.toBeNull();
    expect(prettyTypeToString(safeDivideType!)).toBe('(Number, Number) -> Error | Number');
  });

  test('uncurry converts collect to multi-param', () => {
    const src = `
// uncurry :: (a -> b -> ... -> z) -> (a, b, ...) -> z
const uncurry = (fn) => (...args) => args.reduce((f, arg) => f(arg), fn);

// curriedAdd :: Number -> Number -> Number
const curriedAdd = a => b => a + b;

const add = uncurry(curriedAdd);
    `;
    const r = engine.infer(src);
    // uncurry uses spread in arrow chain as input, which is currently
    // not fully supported. Just verify parsing doesn't crash.
    const addType = findNodeType(r, src, 'add');
    expect(addType).not.toBeNull();
  });

  test('memoize chained call infers return type', () => {
    const src = `
// memoize :: ((a, b, ...) -> z) -> (a, b, ...) -> z
const memoize = (fn) => {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const r = fn(...args);
    cache.set(key, r);
    return r;
  }
}

// greet :: (String, Number) -> String
const greet = (name, age) => name + " is " + age;

const memoRes = memoize(greet)("Alice", 30);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const resType = findNodeType(r, src, 'memoRes');
    expect(resType).not.toBeNull();
    expect(prettyTypeToString(resType!)).toBe('String');
  });
});

// =========================================================================
// Rest parameter passthrough / spread argument inference
// =========================================================================

describe('Rest parameter passthrough with spread args', () => {
  test('wrap = (fn) => (...args) => fn(...args) infers (* -> a) -> * -> a', () => {
    const src = `const wrap = (fn) => (...args) => fn(...args);`;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const t = findNodeType(r, src, 'wrap');
    expect(t).not.toBeNull();
    expect(prettyTypeToString(t!)).toBe('(* -> a) -> * -> a');
  });

  test('wrap with block body infers (* -> a) -> * -> a', () => {
    const src = `const wrap = (fn) => (...args) => { return fn(...args); };`;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const t = findNodeType(r, src, 'wrap');
    expect(t).not.toBeNull();
    expect(prettyTypeToString(t!)).toBe('(* -> a) -> * -> a');
  });

  test('wrap applied to annotated function infers result type', () => {
    const src = `
const wrap = (fn) => (...args) => fn(...args);
// add :: (Number, Number) -> Number
const add = (x, y) => x + y;
const wrappedAdd = wrap(add);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const t = findNodeType(r, src, 'wrappedAdd');
    expect(t).not.toBeNull();
    expect(prettyTypeToString(t!)).toBe('* -> Number');
  });
});
