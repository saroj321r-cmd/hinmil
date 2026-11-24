import {
  tVar,
  tCon,
  tFun,
  tNumber,
  tString,
  tBool,
  tNull,
  tUndefined,
  tArray,
  tRecord,
  tNamedWildcard,
  mono,
  scheme,
  typeToString,
  schemeToString,
  prettyTypeToString,
  resetTypeVarCounter,
  saveTypeVarCounter,
  restoreTypeVarCounter,
  isWildcard,
  wildcardDisplayName,
  kvName,
  tUnion,
  tVoid,
  tAny,
  parseKvName,
  structuralEquals,
  isTCon,
  tStrMap,
  countFunParams,
  isKindVariable,
  mergeReturnTypes, T_TUPLE } from '../../src/hm/types';

beforeEach(() => {
  resetTypeVarCounter();
});

describe('Type constructors', () => {
  test('tVar creates a type variable with incremental id', () => {
    const a = tVar('a');
    const b = tVar('b');
    expect(a.tag).toBe('TVar');
    expect(a.id).toBe(0);
    expect(a.name).toBe('a');
    expect(b.id).toBe(1);
    expect(b.name).toBe('b');
  });

  test('tVar auto-generates names when not provided', () => {
    const t = tVar();
    expect(t.name).toBe('t0');
  });

  test('tCon creates a constructed type', () => {
    const num = tCon('Number');
    expect(num.tag).toBe('TCon');
    expect(num.name).toBe('Number');
    expect(num.args).toEqual([]);
  });

  test('tCon with type arguments', () => {
    const arr = tCon('Array', [tNumber]);
    expect(arr.args).toHaveLength(1);
    expect(arr.args[0]).toBe(tNumber);
  });

  test('tFun creates a function type', () => {
    const fn = tFun(tNumber, tString);
    expect(fn.tag).toBe('TFun');
    expect(fn.param).toBe(tNumber);
    expect(fn.result).toBe(tString);
  });

  test('tArray creates [T]', () => {
    const arr = tArray(tNumber);
    expect(arr.tag).toBe('TCon');
    expect(arr.name).toBe('Array');
    expect(arr.args).toEqual([tNumber]);
  });
});

describe('Scheme constructors', () => {
  test('mono creates a monomorphic scheme', () => {
    const s = mono(tNumber);
    expect(s.vars).toEqual([]);
    expect(s.type).toBe(tNumber);
  });

  test('scheme creates a polymorphic scheme', () => {
    const a = tVar('a');
    const s = scheme([a.id], tFun(a, a));
    expect(s.vars).toEqual([a.id]);
    expect(s.type.tag).toBe('TFun');
  });
});

describe('typeToString', () => {
  test('primitive types', () => {
    expect(typeToString(tNumber)).toBe('Number');
    expect(typeToString(tString)).toBe('String');
    expect(typeToString(tBool)).toBe('Boolean');
    expect(typeToString(tNull)).toBe('Null');
    expect(typeToString(tUndefined)).toBe('Undefined');
  });

  test('type variable', () => {
    const a = tVar('a');
    expect(typeToString(a)).toBe('a');
  });

  test('function type', () => {
    const fn = tFun(tNumber, tString);
    expect(typeToString(fn)).toBe('Number -> String');
  });

  test('nested function type (right-associative)', () => {
    const fn = tFun(tNumber, tFun(tString, tBool));
    expect(typeToString(fn)).toBe('Number -> String -> Boolean');
  });

  test('function type as param gets parenthesized', () => {
    const inner = tFun(tNumber, tString);
    const fn = tFun(inner, tBool);
    expect(typeToString(fn)).toBe('(Number -> String) -> Boolean');
  });

  test('generic type', () => {
    const arr = tArray(tNumber);
    expect(typeToString(arr)).toBe('[Number]');
  });

  test('tuple function type: (Number, String) -> Boolean', () => {
    const fn = tFun(tCon(T_TUPLE, [tNumber, tString]), tBool);
    expect(typeToString(fn)).toBe('(Number, String) -> Boolean');
  });

  test('standalone tuple renders with parens and commas', () => {
    const tuple = tCon(T_TUPLE, [tNumber, tString, tBool]);
    expect(typeToString(tuple)).toBe('(Number, String, Boolean)');
  });

  test('nested tuple in function type', () => {
    const fn = tFun(tCon(T_TUPLE, [tFun(tNumber, tString), tArray(tNumber)]), tArray(tString));
    expect(typeToString(fn)).toBe('(Number -> String, [Number]) -> [String]');
  });
});

describe('schemeToString', () => {
  test('monomorphic scheme', () => {
    expect(schemeToString(mono(tNumber))).toBe('Number');
  });

  test('polymorphic scheme', () => {
    const a = tVar('a');
    const s = scheme([a.id], tFun(a, a));
    expect(schemeToString(s)).toBe('a -> a');
  });

  test('scheme with single constraint', () => {
    const a = tVar('a');
    const s = scheme([a.id], tFun(a, a));
    s.constraints = [{ className: 'Num', typeVarName: 'a' }];
    expect(schemeToString(s)).toContain('Num a =>');
  });

  test('scheme with multiple constraints', () => {
    const a = tVar('a');
    const s = scheme([a.id], tFun(a, a));
    s.constraints = [
      { className: 'Num', typeVarName: 'a' },
      { className: 'Eq', typeVarName: 'a' },
    ];
    const str = schemeToString(s);
    expect(str).toContain('(Num a, Eq a) =>');
  });
});

describe('saveTypeVarCounter / restoreTypeVarCounter', () => {
  test('save and restore resets counter', () => {
    const saved = saveTypeVarCounter();
    tVar('x');
    tVar('y');
    restoreTypeVarCounter(saved);
    const a = tVar('a');
    expect(a.id).toBe(saved);
  });
});

describe('wildcardDisplayName', () => {
  test('bare wildcard returns *', () => {
    expect(wildcardDisplayName(tCon('*'))).toBe('*');
  });

  test('named wildcard returns name', () => {
    expect(wildcardDisplayName(tNamedWildcard('foo'))).toBe('foo');
  });
});

describe('prettyTypeToString', () => {
  test('named wildcard displays name', () => {
    expect(prettyTypeToString(tNamedWildcard('item'))).toBe('item');
  });

  test('record with alias displays alias', () => {
    const r = tRecord({ name: tString, age: tNumber });
    r.alias = 'Person';
    expect(prettyTypeToString(r)).toBe('Person');
  });

  test('empty record displays {}', () => {
    const r = tRecord({});
    expect(prettyTypeToString(r)).toBe('{}');
  });

  test('kind variable id is collected for pretty printing', () => {
    const a = tVar('f');
    const kv = tCon(kvName('f', a.id), [tNumber]);
    const str = prettyTypeToString(kv);
    // Should use a pretty name for the kind variable
    expect(str).toContain('Number');
  });
});

describe('typeToStringWithNames — wildcard in named map', () => {
  test('wildcard type displays as *', () => {
    const t = tCon('*');
    const str = typeToString(t);
    expect(str).toBe('*');
  });

  test('named wildcard type displays with name', () => {
    const t = tNamedWildcard('foo');
    const str = typeToString(t);
    expect(str).toBe('foo');
  });
});

describe('typeToStringWithNames — TRecord branches', () => {
  test('TRecord with alias displays alias name', () => {
    const rec = { ...tRecord({ x: tNumber }), alias: 'Point' };
    const str = prettyTypeToString(rec);
    expect(str).toBe('Point');
  });

  test('TRecord with no fields displays {}', () => {
    const rec = tRecord({});
    const str = prettyTypeToString(rec);
    expect(str).toBe('{}');
  });
});
describe('prettyTypeToString — multi-character type variable names', () => {
  test('preserves type variable name a1', () => {
    const a1 = tVar('a1');
    const b = tVar('b');
    const fn = tFun(tFun(a1, b), tFun(tNumber, tNumber));
    expect(prettyTypeToString(fn)).toBe('(a1 -> b) -> Number -> Number');
  });

  test('preserves type variable name b2', () => {
    const b2 = tVar('b2');
    const fn = tFun(b2, b2);
    expect(prettyTypeToString(fn)).toBe('b2 -> b2');
  });

  test('does not preserve auto-generated names like t0', () => {
    const t = tVar(); // auto-generated name like t0
    const fn = tFun(t, tNumber);
    // Should be prettified to a single letter, not kept as t0
    expect(prettyTypeToString(fn)).toBe('a -> Number');
  });
});

describe('prettyTypeToString — SpreadArray', () => {
  test('SpreadArray with type variables is pretty-printed correctly', () => {
    // [a, ..., b] — the SpreadArray branch in typeToStringWithNames
    const a = tVar('a');
    const b = tVar('b');
    const spread = tCon('...');
    const t = tCon('SpreadArray', [a, spread, b]);
    expect(prettyTypeToString(t)).toBe('[a, ..., b]');
  });

  test('SpreadArray with auto-generated var names gets prettified names', () => {
    const x = tVar(); // auto-generated, e.g. t0
    const spread = tCon('...');
    const t = tCon('SpreadArray', [x, spread]);
    // x should be prettified to 'a'
    expect(prettyTypeToString(t)).toBe('[a, ...]');
  });
});

describe('prettyTypeToString — TRecord with fields (no alias)', () => {
  test('TRecord with fields renders field names and types', () => {
    // Non-empty, non-aliased record — the branch at lines 454-455
    const rec = tRecord({ name: tString, age: tNumber });
    const str = prettyTypeToString(rec);
    expect(str).toBe('{ name :: String, age :: Number }');
  });

  test('TRecord with a type-variable field gets prettified var name', () => {
    const a = tVar(); // auto-generated
    const rec = tRecord({ value: a });
    const str = prettyTypeToString(rec);
    expect(str).toBe('{ value :: a }');
  });
});

describe('tUnion — single element shortcut', () => {
  test('tUnion with a single type returns that type directly', () => {
    expect(tUnion([tNumber])).toBe(tNumber);
  });
});

describe('parseKvName — error paths', () => {
  test('returns null when there is no colon in the rest portion after prefix', () => {
    // '$kv:foo' → rest = 'foo', lastIndexOf(':') = -1 → null
    expect(parseKvName('$kv:foo')).toBeNull();
  });

  test('returns null when the varId segment is not a number', () => {
    // '$kv:fname:notanumber' → varId = NaN → null
    expect(parseKvName('$kv:fname:notanumber')).toBeNull();
  });
});

describe('prettyTypeToString — needsParens', () => {
  test('TFun argument to a TCon gets wrapped in parentheses', () => {
    // needsParens returns true for TFun, so 'Number -> String' gets parens
    const t = tCon('Maybe', [tFun(tNumber, tString)]);
    expect(prettyTypeToString(t)).toBe('Maybe (Number -> String)');
  });

  test('applied TCon argument to a TCon gets wrapped in parentheses', () => {
    // needsParens returns true for an applied TCon (args.length > 0)
    const t = tCon('Either', [tCon('Maybe', [tNumber]), tString]);
    expect(prettyTypeToString(t)).toBe('Either (Maybe Number) String');
  });
});

describe('varNameFromIndex — names beyond z', () => {
  test('assigns two-character names when more than 26 auto-gen type vars', () => {
    // Create 27 auto-generated type variables; the global beforeEach resets the counter
    // so indices 0..26 are used, and varNameFromIndex(26) exercises the i >= 26 branch
    const vars = Array.from({ length: 27 }, () => tVar());
    const t = tCon(T_TUPLE, vars);
    const str = prettyTypeToString(t);
    // The 27th variable (index 26) should be named 'a1' (letter='a', suffix='1')
    expect(str).toContain('a1');
  });
});

describe('structuralEquals', () => {
  test('same reference is equal', () => {
    expect(structuralEquals(tNumber, tNumber)).toBe(true);
  });

  test('different TVars with different ids are not equal', () => {
    const a = tVar('a');
    const b = tVar('b');
    expect(structuralEquals(a, b)).toBe(false);
  });

  test('same TVar id is equal', () => {
    const a = tVar('a');
    expect(structuralEquals(a, a)).toBe(true);
  });

  test('TCon same name and args', () => {
    expect(structuralEquals(tArray(tNumber), tArray(tNumber))).toBe(true);
  });

  test('TCon different args', () => {
    expect(structuralEquals(tArray(tNumber), tArray(tString))).toBe(false);
  });

  test('TFun structurally equal', () => {
    expect(structuralEquals(tFun(tNumber, tString), tFun(tNumber, tString))).toBe(true);
  });

  test('TFun different param', () => {
    expect(structuralEquals(tFun(tNumber, tString), tFun(tBool, tString))).toBe(false);
  });

  test('TRecord structurally equal', () => {
    expect(structuralEquals(tRecord({ x: tNumber }), tRecord({ x: tNumber }))).toBe(true);
  });

  test('TRecord different fields', () => {
    expect(structuralEquals(tRecord({ x: tNumber }), tRecord({ x: tString }))).toBe(false);
  });

  test('TRecord different keys', () => {
    expect(structuralEquals(tRecord({ x: tNumber }), tRecord({ y: tNumber }))).toBe(false);
  });

  test('different tags are not equal', () => {
    expect(structuralEquals(tNumber, tVar('a'))).toBe(false);
    expect(structuralEquals(tFun(tNumber, tString), tNumber)).toBe(false);
  });
});

describe('tUnion — structural dedup', () => {
  test('deduplicates identical concrete types', () => {
    const union = tUnion([tNumber, tNumber, tString]);
    expect(typeToString(union)).toBe('Number | String');
  });

  test('bare wildcard absorbs the union (`X | *` ≡ `*`)', () => {
    // Annotation style from task libraries: `fork :: (…) -> * | (() -> ())`
    // — the author explicitly does not care, so the union IS the wildcard.
    // Without absorption the union survives and downstream checks fail
    // (`'(() -> ()) | *' is not callable`).
    expect(typeToString(tUnion([tFun(tVoid, tVoid), tAny]))).toBe('*');
    expect(typeToString(tUnion([tAny, tNumber, tString]))).toBe('*');
  });

  test('NAMED wildcards are not absorbed (they carry identity)', () => {
    const named = tNamedWildcard('cancel');
    const union = tUnion([named, tNumber]);
    expect(typeToString(union)).toContain('|');
  });

  test('single type collapses', () => {
    const union = tUnion([tNumber]);
    expect(union).toEqual(tNumber);
  });

  test('deduplicates parameterized types', () => {
    const union = tUnion([tArray(tNumber), tArray(tNumber), tArray(tString)]);
    expect(typeToString(union)).toBe('[Number] | [String]');
  });

  test('deduplicates function types', () => {
    const fn = tFun(tNumber, tString);
    const union = tUnion([fn, fn, tBool]);
    // `|` binds looser than `->`, so the function member needs parens
    // to round-trip correctly: Union(Number→String, Boolean) ≠ Number→(String|Boolean).
    expect(typeToString(union)).toBe('Boolean | (Number -> String)');
  });

  test('TVars with same id are deduplicated', () => {
    const a = tVar('a');
    const union = tUnion([a, a, tNumber]);
    expect(typeToString(union)).toBe('a | Number');
  });
});

describe('isTCon', () => {
  test('returns true for matching TCon name', () => {
    expect(isTCon(tNumber, 'Number')).toBe(true);
  });
  test('returns false for non-matching TCon name', () => {
    expect(isTCon(tNumber, 'String')).toBe(false);
  });
  test('returns false for non-TCon type', () => {
    expect(isTCon(tVar(), 'Number')).toBe(false);
  });
});

describe('tStrMap', () => {
  test('creates a StrMap TCon with value type', () => {
    const t = tStrMap(tString);
    expect(t.tag).toBe('TCon');
    expect(t.name).toBe('StrMap');
    expect(t.args).toEqual([tString]);
  });
});

describe('isKindVariable', () => {
  test('returns true for kv-prefixed name', () => {
    expect(isKindVariable(kvName('m', 1))).toBe(true);
  });
  test('returns false for normal name', () => {
    expect(isKindVariable('Maybe')).toBe(false);
  });
});

describe('countFunParams', () => {
  test('returns 0 for non-function type', () => {
    expect(countFunParams(tNumber)).toBe('0 parameters');
  });
  test('returns tuple arity for tuple param', () => {
    const t = tFun(tCon(T_TUPLE, [tNumber, tString]), tBool);
    expect(countFunParams(t)).toBe('2 parameter(s)');
  });
  test('counts curried params', () => {
    const t = tFun(tNumber, tFun(tString, tBool));
    expect(countFunParams(t)).toBe('2 parameter(s)');
  });
  test('single param', () => {
    const t = tFun(tNumber, tBool);
    expect(countFunParams(t)).toBe('1 parameter(s)');
  });
});

describe('mergeReturnTypes', () => {
  test('returns the single type unchanged when given one type', () => {
    const t = tCon('Either', [tVar('e'), tNumber]);
    expect(typeToString(mergeReturnTypes([t]))).toBe(typeToString(t));
  });

  test('merges identical TCons by deduplicating per-arg', () => {
    const a = tCon('Either', [tVar('e'), tNumber]);
    const b = tCon('Either', [tVar('e'), tNumber]);
    expect(typeToString(mergeReturnTypes([a, b]))).toBe('Either e Number');
  });

  test('merges different TCons of the same name by unioning per-arg', () => {
    const a = tCon('Either', [tVar('e'), tNumber]);
    const b = tCon('Either', [tVar('e'), tString]);
    // Second slot becomes Number | String, first slot stays `e`.
    const merged = mergeReturnTypes([a, b]);
    expect(typeToString(merged)).toMatch(
      /^Either e \((Number \| String|String \| Number)\)$/,
    );
  });

  test('falls back to a flat union when outer TCons differ', () => {
    const merged = mergeReturnTypes([tNumber, tString]);
    expect(typeToString(merged)).toMatch(/^(Number \| String|String \| Number)$/);
  });

  // Wildcard absorption: when one branch returns a phantom-wildcard slot
  // and another returns a concrete type, the wildcard must be dropped from
  // the union (because the wildcard branch is unconstrained in that slot).
  describe('wildcard absorption', () => {
    test('drops a single named wildcard when paired with a concrete type', () => {
      const phantom = tCon('Either', [tVar('e'), tNamedWildcard('a')]);
      const concrete = tCon('Either', [tVar('e'), tNumber]);
      const merged = mergeReturnTypes([phantom, concrete]);
      // *:a should be absorbed; result keeps only Number in the second slot.
      expect(typeToString(merged)).toBe('Either e Number');
    });

    test('drops named wildcard regardless of order', () => {
      const phantom = tCon('Either', [tVar('e'), tNamedWildcard('a')]);
      const concrete = tCon('Either', [tVar('e'), tString]);
      const merged = mergeReturnTypes([concrete, phantom]);
      expect(typeToString(merged)).toBe('Either e String');
    });

    test('keeps wildcards when ALL branches are wildcards in that slot', () => {
      const a = tCon('Either', [tVar('e'), tNamedWildcard('a')]);
      const b = tCon('Either', [tVar('e'), tNamedWildcard('a')]);
      const merged = mergeReturnTypes([a, b]);
      // Both wildcards → dedup keeps one wildcard.
      expect(typeToString(merged)).toBe('Either e a');
    });

    test('absorbs wildcard while still unioning multiple concrete types', () => {
      const phantom = tCon('Either', [tVar('e'), tNamedWildcard('a')]);
      const num = tCon('Either', [tVar('e'), tNumber]);
      const str = tCon('Either', [tVar('e'), tString]);
      const merged = mergeReturnTypes([phantom, num, str]);
      expect(typeToString(merged)).toMatch(
        /^Either e \((Number \| String|String \| Number)\)$/,
      );
    });

    test('absorbs wildcards independently per arg slot', () => {
      // Slot 0: wildcard absorbed by Number; Slot 1: wildcard absorbed by String.
      const a = tCon('Pair', [tNamedWildcard('x'), tString]);
      const b = tCon('Pair', [tNumber, tNamedWildcard('y')]);
      const merged = mergeReturnTypes([a, b]);
      expect(typeToString(merged)).toBe('Pair Number String');
    });
  });
});