import { parseTypeSignature, parseType, parseMethodTypeSignature, TypeParseError } from '../../src/hm/typeParser';
import { typeToString, resetTypeVarCounter, schemeToString, T_TUPLE } from '../../src/hm/types';

beforeEach(() => {
  resetTypeVarCounter();
});

describe('parseType — primitives', () => {
  test('Number', () => {
    expect(typeToString(parseType('Number'))).toBe('Number');
  });

  test('String', () => {
    expect(typeToString(parseType('String'))).toBe('String');
  });

  test('Boolean', () => {
    expect(typeToString(parseType('Boolean'))).toBe('Boolean');
  });

  test('Null', () => {
    expect(typeToString(parseType('Null'))).toBe('Null');
  });

  test('Undefined', () => {
    expect(typeToString(parseType('Undefined'))).toBe('Undefined');
  });

  test('custom type MyType', () => {
    expect(typeToString(parseType('MyType'))).toBe('MyType');
  });
});

describe('parseType — type variables', () => {
  test('single lowercase variable', () => {
    const t = parseType('a');
    expect(t.tag).toBe('TVar');
    expect(typeToString(t)).toBe('a');
  });

  test('same variable used twice resolves to same id', () => {
    const sig = parseTypeSignature('a -> a');
    expect(sig.type.tag).toBe('TFun');
    if (sig.type.tag === 'TFun') {
      expect(sig.type.param.tag).toBe('TVar');
      expect(sig.type.result.tag).toBe('TVar');
      if (sig.type.param.tag === 'TVar' && sig.type.result.tag === 'TVar') {
        expect(sig.type.param.id).toBe(sig.type.result.id);
      }
    }
  });

  test('different variables get different ids', () => {
    const sig = parseTypeSignature('a -> b');
    if (sig.type.tag === 'TFun') {
      if (sig.type.param.tag === 'TVar' && sig.type.result.tag === 'TVar') {
        expect(sig.type.param.id).not.toBe(sig.type.result.id);
      }
    }
  });
});

describe('parseType — function types', () => {
  test('simple function', () => {
    expect(typeToString(parseType('Number -> String'))).toBe('Number -> String');
  });

  test('multi-param (curried)', () => {
    expect(typeToString(parseType('Number -> String -> Boolean'))).toBe(
      'Number -> String -> Boolean',
    );
  });

  test('right-associativity', () => {
    // a -> b -> c is a -> (b -> c)
    const t = parseType('Number -> String -> Boolean');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun') {
      expect(typeToString(t.param)).toBe('Number');
      expect(t.result.tag).toBe('TFun');
    }
  });

  test('parenthesized function as param', () => {
    expect(typeToString(parseType('(Number -> String) -> Boolean'))).toBe(
      '(Number -> String) -> Boolean',
    );
  });

  test('nested parentheses', () => {
    const t = parseType('(a -> b) -> (c -> d)');
    expect(typeToString(t)).toBe('(a -> b) -> c -> d');
  });
});

describe('parseType — generic / constructed types', () => {
  test('[Number]', () => {
    expect(typeToString(parseType('[Number]'))).toBe('[Number]');
  });

  test('[a]', () => {
    const t = parseType('[a]');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Array');
      expect(t.args).toHaveLength(1);
      expect(t.args[0].tag).toBe('TVar');
    }
  });

  test('Map<String, Number>', () => {
    expect(typeToString(parseType('Map<String, Number>'))).toBe('Map String Number');
  });

  test('nested arrays: [[Number]]', () => {
    expect(typeToString(parseType('[[Number]]'))).toBe('[[Number]]');
  });

  test('array in function position', () => {
    expect(typeToString(parseType('[Number] -> Number'))).toBe('[Number] -> Number');
  });
});

describe('parseTypeSignature — auto-quantification', () => {
  test('implicit quantification for free variables', () => {
    // Free type vars are auto-quantified
    const sig = parseTypeSignature('a -> b -> a');
    expect(sig.vars.length).toBeGreaterThanOrEqual(2);
  });
});

describe('parseType — edge cases', () => {
  test('single parenthesized type', () => {
    expect(typeToString(parseType('(Number)'))).toBe('Number');
  });

  test('deeply nested parens', () => {
    expect(typeToString(parseType('((Number))'))).toBe('Number');
  });

  test('empty input throws', () => {
    expect(() => parseType('')).toThrow(TypeParseError);
  });

  test('unterminated generic throws', () => {
    expect(() => parseType('[Number')).toThrow(TypeParseError);
  });

  test('missing arrow RHS throws', () => {
    expect(() => parseType('Number ->')).toThrow(TypeParseError);
  });

  test('trailing tokens throw', () => {
    expect(() => parseType('Number -> String ,')).toThrow(TypeParseError);
  });

  test('juxtaposition with uppercase args is valid', () => {
    expect(typeToString(parseType('Box Number'))).toBe('Box Number');
  });

  test('juxtaposition with parenthesized type arg', () => {
    // Box (Pair a c) should parse as Box with one arg: Pair a c
    const t = parseType('Box (Pair a c)');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Box');
      expect(t.args).toHaveLength(1);
      expect(t.args[0].tag).toBe('TCon');
      if (t.args[0].tag === 'TCon') {
        expect(t.args[0].name).toBe('Pair');
        expect(t.args[0].args).toHaveLength(2);
      }
    }
    expect(typeToString(t)).toBe('Box (Pair a c)');
  });

  test('juxtaposition with array shorthand arg', () => {
    // Box [a] should parse as Box with one arg: Array a
    const t = parseType('Box [a]');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Box');
      expect(t.args).toHaveLength(1);
      expect(typeToString(t.args[0])).toBe('[a]');
    }
  });

  test('parenthesized type arg in function signature', () => {
    // Pair a c -> Box (Pair a c) should work
    const t = parseType('Pair a c -> Box (Pair a c)');
    expect(t.tag).toBe('TFun');
    expect(typeToString(t)).toBe('Pair a c -> Box (Pair a c)');
  });

  test('parenthesized lowercase type application (f m)', () => {
    // Pair Boolean (f m) should parse (f m) as a kind-variable application
    const t = parseType('Pair Boolean (f m)');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Pair');
      expect(t.args).toHaveLength(2);
      expect(t.args[0].tag).toBe('TCon');
      // second arg should be a kind-variable application (TCon with $kv: name)
      expect(t.args[1].tag).toBe('TCon');
    }
  });

  test('parenthesized lowercase type application in tuple', () => {
    // (Pair Boolean (f m), m) -> Pair Boolean (f m)  should parse correctly
    const t = parseType('(Pair Boolean (f m), m) -> Pair Boolean (f m)');
    expect(t.tag).toBe('TFun');
  });
});

describe('parseType — complex signatures', () => {
  test('higher-order: (a -> b) -> [a] -> [b] (map)', () => {
    const t = parseType('(a -> b) -> [a] -> [b]');
    expect(typeToString(t)).toBe('(a -> b) -> [a] -> [b]');
  });

  test('fold/reduce style', () => {
    const t = parseType('(b -> a -> b) -> b -> [a] -> b');
    expect(typeToString(t)).toBe('(b -> a -> b) -> b -> [a] -> b');
  });

  test('identity', () => {
    const sig = parseTypeSignature('a -> a');
    expect(typeToString(sig.type)).toBe('a -> a');
    expect(sig.vars).toHaveLength(1);
  });
});

describe('parseType — tuple / uncurried function types', () => {
  test('(Number, String) -> Boolean parses as tuple-based function', () => {
    const t = parseType('(Number, String) -> Boolean');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun') {
      expect(t.param.tag).toBe('TCon');
      if (t.param.tag === 'TCon') {
        expect(t.param.name).toBe(T_TUPLE);
        expect(t.param.args).toHaveLength(2);
        expect(typeToString(t.param.args[0])).toBe('Number');
        expect(typeToString(t.param.args[1])).toBe('String');
      }
      expect(typeToString(t.result)).toBe('Boolean');
    }
    expect(typeToString(t)).toBe('(Number, String) -> Boolean');
  });

  test('((a -> b), [a]) -> [b] tuple with function element', () => {
    const t = parseType('((a -> b), [a]) -> [b]');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun') {
      expect(t.param.tag).toBe('TCon');
      if (t.param.tag === 'TCon') {
        expect(t.param.name).toBe(T_TUPLE);
        expect(t.param.args).toHaveLength(2);
        expect(typeToString(t.param.args[0])).toBe('a -> b');
        expect(typeToString(t.param.args[1])).toBe('[a]');
      }
      expect(typeToString(t.result)).toBe('[b]');
    }
    expect(typeToString(t)).toBe('(a -> b, [a]) -> [b]');
  });

  test('(Number) -> String is regular parenthesized type, not tuple', () => {
    const t = parseType('(Number) -> String');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun') {
      // Single element in parens should NOT be a Tuple
      expect(t.param.tag).toBe('TCon');
      if (t.param.tag === 'TCon') {
        expect(t.param.name).toBe('Number');
      }
      expect(typeToString(t.result)).toBe('String');
    }
    expect(typeToString(t)).toBe('Number -> String');
  });
});
describe('parseType — empty parens as Void', () => {
  test('() -> Number has Void param', () => {
    const t = parseType('() -> Number');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun') {
      expect(typeToString(t.param)).toBe('()');
      expect(typeToString(t.result)).toBe('Number');
    }
  });
});

describe('parseType — record types', () => {
  test('empty record {}', () => {
    const t = parseType('{}');
    expect(t.tag).toBe('TRecord');
    if (t.tag === 'TRecord') {
      expect(Object.keys(t.fields)).toHaveLength(0);
    }
  });

  test('record with fields { name :: String, age :: Number }', () => {
    const t = parseType('{ name :: String, age :: Number }');
    expect(t.tag).toBe('TRecord');
    if (t.tag === 'TRecord') {
      expect(typeToString(t.fields['name'])).toBe('String');
      expect(typeToString(t.fields['age'])).toBe('Number');
    }
  });

  test('record with single colon throws', () => {
    expect(() => parseType('{ name: String }')).toThrow("Use '::'");
  });

  test('record in function position', () => {
    const t = parseType('{ x :: Number } -> String');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun') {
      expect(t.param.tag).toBe('TRecord');
    }
  });
});

describe('parseType — union types', () => {
  test('A | B parses as union', () => {
    const t = parseType('Number | String');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Union');
      expect(t.args).toHaveLength(2);
    }
  });

  test('Union followed by arrow: union binds tighter than arrow', () => {
    // `Number | String -> Boolean` parses as `(Number | String) -> Boolean`
    // because `|` binds tighter than `->` (the most natural reading).
    // To make a function a union member, write `Number | (String -> Boolean)`.
    const t = parseType('Number | String -> Boolean');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun') {
      expect(t.param.tag).toBe('TCon');
      if (t.param.tag === 'TCon') {
        expect(t.param.name).toBe('Union');
        expect(t.param.args).toHaveLength(2);
      }
      expect(typeToString(t.result)).toBe('Boolean');
    }
  });

  test('Parenthesized union followed by arrow', () => {
    // Explicit parens make the union the parameter
    const t = parseType('(Number | String) -> Boolean');
    expect(t.tag).toBe('TFun');
    if (t.tag === 'TFun') {
      expect(t.param.tag).toBe('TCon');
      if (t.param.tag === 'TCon') {
        expect(t.param.name).toBe('Union');
      }
      expect(typeToString(t.result)).toBe('Boolean');
    }
  });

  test('Union member can be a function type with explicit parens', () => {
    // `|` binds tighter than `->`, so to make a function a union member
    // the user must add explicit parens around the function type.
    const t = parseType('() | (() -> ())');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Union');
      expect(t.args).toHaveLength(2);
      expect(typeToString(t.args[0])).toBe('()');
      expect(typeToString(t.args[1])).toBe('() -> ()');
    }
  });
});

describe('parseType — boolean literals', () => {
  test('true parses as Boolean type', () => {
    const t = parseType('true');
    expect(typeToString(t)).toBe('Boolean');
  });

  test('false parses as Boolean type', () => {
    const t = parseType('false');
    expect(typeToString(t)).toBe('Boolean');
  });
});

describe('parseType — number and string literals in type position', () => {
  // A number in type position is a numeric
  // literal (singleton) type, the counterpart of string-literal types.
  test('number literal maps to a numeric literal type', () => {
    const t = parseType('42');
    expect(typeToString(t)).toBe('42');
    expect(t).toEqual({ tag: 'TCon', name: '42', args: [] });
  });

  test('negative number literal maps to a numeric literal type', () => {
    const t = parseType('-5');
    expect(typeToString(t)).toBe('-5');
  });

  test('string literal maps to label-literal (singleton) type', () => {
    const t = parseType("'hello'");
    expect(typeToString(t)).toBe("'hello'");
    expect(t.tag).toBe('TLabel');
    if (t.tag === 'TLabel') expect(t.kind).toBe('lit');
  });
});

describe('parseTypeSignature — constraints', () => {
  test('constraint applied to concrete type parses as positionalArgs', () => {
    // `Eq A => ...` is now a valid concrete-type constraint application.
    // The parser succeeds; semantic validity (instance lookup) happens
    // during inference.
    const scheme = parseTypeSignature('Eq A => A -> Boolean');
    expect(scheme.constraints).toBeDefined();
    expect(scheme.constraints).toHaveLength(1);
    expect(scheme.constraints![0].className).toBe('Eq');
    expect(scheme.constraints![0].positionalArgs).toBeDefined();
    expect(scheme.constraints![0].positionalArgs).toHaveLength(1);
    expect(scheme.constraints![0].positionalArgs![0].tag).toBe('TCon');
    expect((scheme.constraints![0].positionalArgs![0] as any).name).toBe('A');
  });

  test('applied constraint: Monoid (f a)', () => {
    const scheme = parseTypeSignature('(Applicative f, Foldable f, Monoid (f a)) => f a -> Maybe (f a)');
    expect(scheme.constraints).toBeDefined();
    expect(scheme.constraints).toHaveLength(3);
    expect(scheme.constraints![0]).toEqual({ className: 'Applicative', typeVarName: 'f' });
    expect(scheme.constraints![1]).toEqual({ className: 'Foldable', typeVarName: 'f' });
    expect(scheme.constraints![2]).toEqual({ className: 'Monoid', typeVarName: 'f', isApplied: true, appliedArgNames: ['a'], appliedArgs: [expect.objectContaining({ tag: 'TVar', name: 'a' })] });
  });

  test('applied constraint with single constraint syntax', () => {
    const scheme = parseTypeSignature('Monoid (f a) => f a -> f a -> f a');
    expect(scheme.constraints).toBeDefined();
    expect(scheme.constraints).toHaveLength(1);
    expect(scheme.constraints![0]).toEqual({ className: 'Monoid', typeVarName: 'f', isApplied: true, appliedArgNames: ['a'], appliedArgs: [expect.objectContaining({ tag: 'TVar', name: 'a' })] });
  });

  test('applied constraint without outer parens, comma-separated', () => {
    const scheme = parseTypeSignature('Monoid (m a), Foldable f => (TypeRep m, f a) -> m a');
    expect(scheme.constraints).toBeDefined();
    expect(scheme.constraints).toHaveLength(2);
    expect(scheme.constraints![0]).toEqual({ className: 'Monoid', typeVarName: 'm', isApplied: true, appliedArgNames: ['a'], appliedArgs: [expect.objectContaining({ tag: 'TVar', name: 'a' })] });
    expect(scheme.constraints![1]).toEqual({ className: 'Foldable', typeVarName: 'f' });
  });

  test('applied constraint with nested application: Setoid (f (t a))', () => {
    const scheme = parseTypeSignature('(Traversable t, Applicative f, Setoid (f (t a))) => TypeRep f -> t a -> Boolean');
    expect(scheme.constraints).toBeDefined();
    expect(scheme.constraints).toHaveLength(3);
    const setoid = scheme.constraints![2];
    expect(setoid.className).toBe('Setoid');
    expect(setoid.typeVarName).toBe('f');
    expect(setoid.isApplied).toBe(true);
    expect(setoid.appliedArgNames).toEqual(['(t a)']);
    expect(setoid.appliedArgs).toHaveLength(1);
    const nested = setoid.appliedArgs![0];
    expect(nested.tag).toBe('TCon');
    if (nested.tag === 'TCon') {
      // kv-encoded application of the constrained var `t`
      expect(nested.name).toMatch(/^\$kv:t:/);
      expect(nested.args).toHaveLength(1);
      expect(nested.args[0]).toMatchObject({ tag: 'TVar', name: 'a' });
    }
  });

  test('applied constraint with bare variable Monoid (m) throws', () => {
    expect(() => parseTypeSignature('Monoid (m) => m -> m')).toThrow(TypeParseError);
    expect(() => parseTypeSignature('Monoid (m), Foldable f => m -> m')).toThrow(TypeParseError);
  });
});

describe('parseType — kind variables', () => {
  test('kind variable in constraint annotation context', () => {
    // Kind variables only work with constraint var names set.
    // Use parseMethodTypeSignature which supports them.
    const result = parseMethodTypeSignature(
      'f a ~> (a -> b) -> f b',
      ['f'],
    );
    expect(result.methodType.tag).toBe('TFun');
  });
});

describe('parseMethodTypeSignature', () => {
  test('method type with receiver', () => {
    const result = parseMethodTypeSignature('Array a ~> (a -> b) -> Array b');
    expect(result.receiver.tag).toBe('TCon');
    if (result.receiver.tag === 'TCon') {
      expect(result.receiver.name).toBe('Array');
    }
    expect(result.methodType.tag).toBe('TFun');
  });
});

describe('parseType — juxtaposition args via parseSimpleAtom', () => {
  test('constructor with record arg: Maybe { x :: Number }', () => {
    const t = parseType('Maybe { x :: Number }');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Maybe');
      expect(t.args).toHaveLength(1);
      expect(t.args[0].tag).toBe('TRecord');
    }
  });

  test('constructor with tuple arg via parens', () => {
    const t = parseType('Pair (Number, String)');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Pair');
      expect(t.args).toHaveLength(1);
      if (t.args[0].tag === 'TCon') {
        expect(t.args[0].name).toBe(T_TUPLE);
      }
    }
  });

  test('constructor with unit arg ()', () => {
    const t = parseType('IO ()');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('IO');
      expect(t.args).toHaveLength(1);
      expect(typeToString(t.args[0])).toBe('()');
    }
  });

  test('constructor with bare uppercase type arg', () => {
    const t = parseType('Maybe Number');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Maybe');
      expect(t.args).toHaveLength(1);
      expect(typeToString(t.args[0])).toBe('Number');
    }
  });

  test('constructor with number literal arg', () => {
    const t = parseType('Const 42');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Const');
      expect(typeToString(t.args[0])).toBe('42');
    }
  });

  test('constructor with string literal arg', () => {
    const t = parseType("Const 'hello'");
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Const');
      expect(typeToString(t.args[0])).toBe("'hello'");
    }
  });
});

describe('parseType — decimal numbers in tokenizer', () => {
  test('decimal number parses as a numeric literal type', () => {
    const t = parseType('3.14');
    expect(typeToString(t)).toBe('3.14');
  });
});

describe('parseType — angle-bracket generics', () => {
  test('Array<Number> parses correctly', () => {
    const t = parseType('Array<Number>');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Array');
      expect(t.args).toHaveLength(1);
      expect(typeToString(t.args[0])).toBe('Number');
    }
  });

  test('Map<String, Number> parses with two args', () => {
    const t = parseType('Map<String, Number>');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Map');
      expect(t.args).toHaveLength(2);
      expect(typeToString(t.args[0])).toBe('String');
      expect(typeToString(t.args[1])).toBe('Number');
    }
  });

  test('Result<a, Error> with type variable', () => {
    const t = parseType('Result<a, Error>');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Result');
      expect(t.args).toHaveLength(2);
      expect(t.args[0].tag).toBe('TVar');
      expect(typeToString(t.args[1])).toBe('Error');
    }
  });

  test('angle-bracket generics in juxtaposition context (parseSimpleAtom)', () => {
    // Maybe Array<Number> → Maybe with arg Array<Number>
    const t = parseType('Maybe Array<Number>');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Maybe');
      expect(t.args).toHaveLength(1);
      expect(t.args[0].tag).toBe('TCon');
      if (t.args[0].tag === 'TCon') {
        expect(t.args[0].name).toBe('Array');
        expect(t.args[0].args).toHaveLength(1);
        expect(typeToString(t.args[0].args[0])).toBe('Number');
      }
    }
  });

  test('Box Map<String, Number> in juxtaposition with angle brackets', () => {
    const t = parseType('Box Map<String, Number>');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Box');
      expect(t.args).toHaveLength(1);
      if (t.args[0].tag === 'TCon') {
        expect(t.args[0].name).toBe('Map');
        expect(t.args[0].args).toHaveLength(2);
      }
    }
  });
});

describe('parseMethodTypeSignature — trailing token error', () => {
  test('trailing garbage after method type throws', () => {
    expect(() => parseMethodTypeSignature('Array a ~> a -> a ,')).toThrow(TypeParseError);
  });

  test('trailing identifier after method type throws', () => {
    expect(() => parseMethodTypeSignature('Array a ~> a -> a extra')).toThrow(TypeParseError);
  });
});

describe('parseTypeSignature — legacy type predicate syntax', () => {
  test('inline predicate syntax (a is T) is rejected', () => {
    expect(() => parseTypeSignature('a -> Boolean (a is String)')).toThrow(TypeParseError);
  });

  test('normal signature without inline predicate still parses', () => {
    const scheme = parseTypeSignature('a -> Boolean');
    expect(typeToString(scheme.type)).toBe('a -> Boolean');
    expect(scheme.typePredicate).toBeUndefined();
  });
});

describe('parseType — lowercase type keywords', () => {
  test('null is parsed as Null type, not a type variable', () => {
    const scheme = parseTypeSignature('(Number | null) -> Number');
    expect(scheme.vars).toHaveLength(0);
    // `|` binds tighter than `->`, so the union as param needs no parens.
    expect(typeToString(scheme.type)).toBe('Null | Number -> Number');
  });

  test('undefined is parsed as Undefined type, not a type variable', () => {
    const scheme = parseTypeSignature('(Number | undefined) -> Number');
    expect(scheme.vars).toHaveLength(0);
    expect(typeToString(scheme.type)).toBe('Number | Undefined -> Number');
  });

  test('null in union with type variables', () => {
    const scheme = parseTypeSignature('(a | null) -> a');
    // 'a' is quantified, 'null' is NOT
    expect(scheme.vars).toHaveLength(1);
    expect(typeToString(scheme.type)).toBe('a | Null -> a');
  });

  test('undefined in simple atom position', () => {
    expect(typeToString(parseType('undefined'))).toBe('Undefined');
  });

  test('null in simple atom position', () => {
    expect(typeToString(parseType('null'))).toBe('Null');
  });
});

// =========================================================================
// Spread tuple / spread array parsing
// =========================================================================

describe('parseType — spread tuples', () => {
  test('trailing spread: (a, b, ...)', () => {
    const t = parseType('(a, b, ...)');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe(T_TUPLE);
      expect(t.args).toHaveLength(3);
      expect(t.args[2].tag).toBe('TCon');
      if (t.args[2].tag === 'TCon') expect(t.args[2].name).toBe('...');
    }
  });

  test('leading spread: (..., y, z)', () => {
    const t = parseType('(..., y, z)');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe(T_TUPLE);
      expect(t.args).toHaveLength(3);
      expect(t.args[0].tag).toBe('TCon');
      if (t.args[0].tag === 'TCon') expect(t.args[0].name).toBe('...');
    }
  });

  test('middle spread: (a, ..., z)', () => {
    const t = parseType('(a, ..., z)');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe(T_TUPLE);
      expect(t.args).toHaveLength(3);
    }
  });
});

describe('parseType — spread arrays', () => {
  test('spread array: [a, ..., b]', () => {
    const t = parseType('[a, ..., b]');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('SpreadArray');
      expect(t.args).toHaveLength(3);
    }
  });

  test('leading spread array: [..., a, b]', () => {
    const t = parseType('[..., a, b]');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('SpreadArray');
      expect(t.args).toHaveLength(3);
    }
  });
});

describe('parseType — number and string literals', () => {
  test('number literal in type position parses as a numeric literal type', () => {
    expect(typeToString(parseType('42'))).toBe('42');
  });

  test('string literal in type position parses as label-literal', () => {
    expect(typeToString(parseType("'hello'"))).toBe("'hello'");
  });
});

describe('parseType — bare spread marker', () => {
  test('bare ... parses as spread', () => {
    const t = parseType('...');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') expect(t.name).toBe('...');
  });
});

describe('parseType — wildcard', () => {
  test('star parses as wildcard', () => {
    expect(typeToString(parseType('*'))).toBe('*');
  });
});

describe('parseType — error on unexpected token', () => {
  test('unexpected token throws TypeParseError', () => {
    expect(() => parseType(']')).toThrow(TypeParseError);
  });
});

// =========================================================================
// Coverage completeness: paths in parseSimpleAtom & edge cases
// =========================================================================

describe('parseTypeSignature — constraint list with uppercase var', () => {
  // parseSingleConstraint throws when the var name is uppercase.
  // tryParseConstraints silently catches this, but the trailing `=>` token
  // then causes the outer parseTypeSignature to throw.
  test('(Functor A) => ... throws because var name must be lowercase', () => {
    expect(() => parseTypeSignature('(Functor A) => A -> A')).toThrow(TypeParseError);
  });
});

describe('parseType — consecutive spreads in leading-spread tuple', () => {
  test('(..., ..., z) contains two spread markers', () => {
    const t = parseType('(..., ..., z)');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe(T_TUPLE);
      // [ ..., ..., z ]
      expect(t.args).toHaveLength(3);
      expect(t.args[0].tag).toBe('TCon');
      if (t.args[0].tag === 'TCon') expect(t.args[0].name).toBe('...');
      expect(t.args[1].tag).toBe('TCon');
      if (t.args[1].tag === 'TCon') expect(t.args[1].name).toBe('...');
    }
  });
});

describe('parseType — consecutive spreads in leading-spread array', () => {
  test('[..., ..., z] contains two spread markers', () => {
    const t = parseType('[..., ..., z]');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('SpreadArray');
      expect(t.args).toHaveLength(3);
      expect(t.args[0].tag).toBe('TCon');
      if (t.args[0].tag === 'TCon') expect(t.args[0].name).toBe('...');
      expect(t.args[1].tag).toBe('TCon');
      if (t.args[1].tag === 'TCon') expect(t.args[1].name).toBe('...');
    }
  });
});

describe('parseType — spread tuples as juxtaposition argument (parseSimpleAtom)', () => {
  test('leading-spread tuple as arg: IO (..., a, b)', () => {
    // IO takes a variadic spread-tuple argument
    const t = parseType('IO (..., a, b)');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('IO');
      expect(t.args).toHaveLength(1);
      expect(t.args[0].tag).toBe('TCon');
      if (t.args[0].tag === 'TCon') {
        expect(t.args[0].name).toBe(T_TUPLE);
        expect(t.args[0].args[0].tag).toBe('TCon');
        if (t.args[0].args[0].tag === 'TCon')
          expect(t.args[0].args[0].name).toBe('...');
      }
    }
  });

  test('leading-spread tuple with consecutive spreads as arg: IO (..., ..., b)', () => {
    const t = parseType('IO (..., ..., b)');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('IO');
      expect(t.args).toHaveLength(1);
      if (t.args[0].tag === 'TCon') {
        expect(t.args[0].name).toBe(T_TUPLE);
        expect(t.args[0].args).toHaveLength(3);
        expect(t.args[0].args[0].tag).toBe('TCon');
        if (t.args[0].args[0].tag === 'TCon') expect(t.args[0].args[0].name).toBe('...');
        expect(t.args[0].args[1].tag).toBe('TCon');
        if (t.args[0].args[1].tag === 'TCon') expect(t.args[0].args[1].name).toBe('...');
      }
    }
  });

  test('middle-spread tuple as arg: IO (a, ..., b)', () => {
    const t = parseType('IO (a, ..., b)');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('IO');
      expect(t.args).toHaveLength(1);
      if (t.args[0].tag === 'TCon') {
        expect(t.args[0].name).toBe(T_TUPLE);
        const spreadArg = t.args[0].args[1];
        expect(spreadArg.tag).toBe('TCon');
        if (spreadArg.tag === 'TCon') expect(spreadArg.name).toBe('...');
      }
    }
  });
});

describe('parseType — spread arrays as juxtaposition argument (parseSimpleAtom)', () => {
  test('leading-spread array as arg: IO [..., a, b]', () => {
    const t = parseType('IO [..., a, b]');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('IO');
      expect(t.args).toHaveLength(1);
      if (t.args[0].tag === 'TCon') {
        expect(t.args[0].name).toBe('SpreadArray');
        expect(t.args[0].args[0].tag).toBe('TCon');
        if (t.args[0].args[0].tag === 'TCon')
          expect(t.args[0].args[0].name).toBe('...');
      }
    }
  });

  test('leading-spread array with consecutive spreads as arg: IO [..., ..., b]', () => {
    const t = parseType('IO [..., ..., b]');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('IO');
      expect(t.args).toHaveLength(1);
      if (t.args[0].tag === 'TCon') {
        expect(t.args[0].name).toBe('SpreadArray');
        expect(t.args[0].args).toHaveLength(3);
        expect(t.args[0].args[0].tag).toBe('TCon');
        if (t.args[0].args[0].tag === 'TCon') expect(t.args[0].args[0].name).toBe('...');
        expect(t.args[0].args[1].tag).toBe('TCon');
        if (t.args[0].args[1].tag === 'TCon') expect(t.args[0].args[1].name).toBe('...');
      }
    }
  });

  test('spread array as arg: IO [a, ..., b]', () => {
    const t = parseType('IO [a, ..., b]');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('IO');
      expect(t.args).toHaveLength(1);
      if (t.args[0].tag === 'TCon') {
        expect(t.args[0].name).toBe('SpreadArray');
      }
    }
  });
});

describe('parseType — boolean / null / undefined as juxtaposition args (parseSimpleAtom)', () => {
  test('Maybe true — boolean literal arg becomes Boolean', () => {
    const t = parseType('Maybe true');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Maybe');
      expect(t.args).toHaveLength(1);
      expect(typeToString(t.args[0])).toBe('Boolean');
    }
  });

  test('Maybe false — boolean literal arg becomes Boolean', () => {
    const t = parseType('Maybe false');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Maybe');
      expect(typeToString(t.args[0])).toBe('Boolean');
    }
  });

  test('Maybe null — null arg becomes Null', () => {
    const t = parseType('Maybe null');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Maybe');
      expect(typeToString(t.args[0])).toBe('Null');
    }
  });

  test('Maybe undefined — undefined arg becomes Undefined', () => {
    const t = parseType('Maybe undefined');
    expect(t.tag).toBe('TCon');
    if (t.tag === 'TCon') {
      expect(t.name).toBe('Maybe');
      expect(typeToString(t.args[0])).toBe('Undefined');
    }
  });
});
