import {
  isUnionable,
  mergeUnion,
  mergeSameConstructor,
  replaceUnionInType,
  collectTVarIdsFromType,
  extractCorresponding,
  freshenType,
  replaceSpreadTupleWithConcrete,
  hasSpreadInArrowChain,
  detectSpreadChainLink,
  extractParamTVarIds,
  narrowCallResultByArgs,
  containsQuantifiedVar,
  neutralizeUnions,
} from '../../src/hm/typeUtils';
import {
  tVar,
  tFun,
  tNumber,
  tString,
  tBool,
  tCon,
  tRecord,
  tUnion,
  tSpread,
  typeToString,
  resetTypeVarCounter, T_TUPLE } from '../../src/hm/types';

beforeEach(() => {
  resetTypeVarCounter();
});

// ---------------------------------------------------------------------------
// isUnionable
// ---------------------------------------------------------------------------

describe('isUnionable', () => {
  test('simple concrete TCon with no args is unionable', () => {
    expect(isUnionable(tNumber)).toBe(true);
    expect(isUnionable(tString)).toBe(true);
    expect(isUnionable(tBool)).toBe(true);
  });

  test('Union TCon is unionable', () => {
    expect(isUnionable(tUnion([tNumber, tString]))).toBe(true);
  });

  test('TVar is not unionable', () => {
    expect(isUnionable(tVar())).toBe(false);
  });

  test('TCon with type args (Array, Maybe) is not unionable', () => {
    expect(isUnionable(tCon('Array', [tNumber]))).toBe(false);
    expect(isUnionable(tCon('Maybe', [tString]))).toBe(false);
  });

  test('TFun is not unionable', () => {
    expect(isUnionable(tFun(tNumber, tString))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergeUnion
// ---------------------------------------------------------------------------

describe('mergeUnion', () => {
  test('merges two distinct types into a Union', () => {
    const result = mergeUnion(tNumber, tString);
    expect(result.tag).toBe('TCon');
    expect(typeToString(result)).toBe('Number | String');
  });

  test('deduplicates identical members', () => {
    const result = mergeUnion(tNumber, tNumber);
    const str = typeToString(result);
    // Should only contain Number once
    expect(str).toBe('Number');
  });

  test('flattens nested unions', () => {
    const ab = tUnion([tNumber, tString]);
    const result = mergeUnion(ab, tBool);
    const str = typeToString(result);
    expect(str).toContain('Number');
    expect(str).toContain('String');
    expect(str).toContain('Boolean');
    // Should not be doubly nested
    expect(str).not.toContain('Union');
  });

  test('merging two union types flattens both', () => {
    const ab = tUnion([tNumber, tString]);
    const cd = tUnion([tBool, tCon('Null', [])]);
    const result = mergeUnion(ab, cd);
    const str = typeToString(result);
    expect(str).toContain('Number');
    expect(str).toContain('String');
    expect(str).toContain('Boolean');
    expect(str).toContain('Null');
  });
});

// ---------------------------------------------------------------------------
// replaceUnionInType
// ---------------------------------------------------------------------------

describe('replaceUnionInType', () => {
  test('replaces a matching union at top level', () => {
    const union = tUnion([tNumber, tString]);
    const result = replaceUnionInType(union, union, tBool);
    expect(typeToString(result)).toBe('Boolean');
  });

  test('replaces a union nested in TCon args', () => {
    const union = tUnion([tNumber, tString]);
    const arr = tCon('Array', [union]);
    const result = replaceUnionInType(arr, union, tBool);
    expect(typeToString(result)).toBe('[Boolean]');
  });

  test('replaces a union in function param', () => {
    const union = tUnion([tNumber, tString]);
    const fn = tFun(union, tBool);
    const result = replaceUnionInType(fn, union, tNumber);
    expect(result.tag).toBe('TFun');
    if (result.tag === 'TFun') {
      expect(typeToString(result.param)).toBe('Number');
    }
  });

  test('leaves non-matching types unchanged', () => {
    const union = tUnion([tNumber, tString]);
    const other = tUnion([tBool]);
    const result = replaceUnionInType(tNumber, union, other);
    expect(typeToString(result)).toBe('Number');
  });

  test('TVar is left unchanged', () => {
    const a = tVar();
    const union = tUnion([tNumber, tString]);
    const result = replaceUnionInType(a, union, tBool);
    expect(result).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// collectTVarIdsFromType
// ---------------------------------------------------------------------------

describe('collectTVarIdsFromType', () => {
  test('collects TVar id from plain TVar', () => {
    const a = tVar();
    const ids = new Set<number>();
    collectTVarIdsFromType(a, ids);
    expect(ids).toContain(a.id);
  });

  test('collects nothing from concrete type', () => {
    const ids = new Set<number>();
    collectTVarIdsFromType(tNumber, ids);
    expect(ids.size).toBe(0);
  });

  test('collects TVars from function type', () => {
    const a = tVar();
    const b = tVar();
    const ids = new Set<number>();
    collectTVarIdsFromType(tFun(a, b), ids);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  test('collects TVars from TCon args', () => {
    const a = tVar();
    const ids = new Set<number>();
    collectTVarIdsFromType(tCon('Array', [a]), ids);
    expect(ids).toContain(a.id);
  });

  test('collects TVars from record fields', () => {
    const a = tVar();
    const ids = new Set<number>();
    collectTVarIdsFromType(tRecord({ x: a, y: tNumber }), ids);
    expect(ids).toContain(a.id);
    expect(ids.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// extractCorresponding
// ---------------------------------------------------------------------------

describe('extractCorresponding', () => {
  test('returns target when template is the target TVar', () => {
    const a = tVar();
    const result = extractCorresponding(a, tNumber, a.id);
    expect(result).toBe(tNumber);
  });

  test('extracts from matching TCon arg position', () => {
    const a = tVar();
    const template = tCon('Array', [a]);
    const target = tCon('Array', [tString]);
    const result = extractCorresponding(template, target, a.id);
    expect(result && typeToString(result)).toBe('String');
  });

  test('extracts from function param', () => {
    const a = tVar();
    const b = tVar();
    const template = tFun(a, b);
    const target = tFun(tNumber, tString);
    expect(extractCorresponding(template, target, a.id) && typeToString(extractCorresponding(template, target, a.id)!)).toBe('Number');
    expect(extractCorresponding(template, target, b.id) && typeToString(extractCorresponding(template, target, b.id)!)).toBe('String');
  });

  test('returns null when id not found in template', () => {
    const a = tVar();
    const b = tVar();
    const result = extractCorresponding(tFun(a, tNumber), tFun(tString, tNumber), b.id);
    expect(result).toBeNull();
  });

  test('returns null when structures do not match', () => {
    const a = tVar();
    const result = extractCorresponding(tFun(a, tNumber), tNumber, a.id);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// freshenType
// ---------------------------------------------------------------------------

describe('freshenType', () => {
  test('concrete type is returned unchanged', () => {
    const result = freshenType(tNumber);
    expect(typeToString(result)).toBe('Number');
  });

  test('TVar is replaced with a fresh TVar', () => {
    const a = tVar();
    const result = freshenType(a);
    expect(result.tag).toBe('TVar');
    expect(result).not.toBe(a);
  });

  test('function type preserves structure with fresh vars', () => {
    const a = tVar();
    const b = tVar();
    const original = tFun(a, b);
    const fresh = freshenType(original);
    expect(fresh.tag).toBe('TFun');
    if (fresh.tag === 'TFun') {
      // Must be different var identities
      expect(fresh.param).not.toBe(a);
      expect(fresh.result).not.toBe(b);
      // But still TVars
      expect(fresh.param.tag).toBe('TVar');
      expect(fresh.result.tag).toBe('TVar');
    }
  });

  test('same TVar in multiple positions gets the same fresh var', () => {
    const a = tVar();
    // f :: a -> a
    const t = tFun(a, a);
    const fresh = freshenType(t);
    if (fresh.tag === 'TFun') {
      // Both sides should be the SAME fresh var
      expect(fresh.param).toBe(fresh.result);
    }
  });
});

// ---------------------------------------------------------------------------
// replaceSpreadTupleWithConcrete
// ---------------------------------------------------------------------------

describe('replaceSpreadTupleWithConcrete', () => {
  test('non-spread types are returned unchanged', () => {
    const t = tFun(tNumber, tString);
    expect(replaceSpreadTupleWithConcrete(t, [tBool])).toBe(t);
  });

  test('TVar is returned unchanged', () => {
    const a = tVar();
    expect(replaceSpreadTupleWithConcrete(a, [tNumber])).toBe(a);
  });

  test('Tuple with spread marker is replaced by concrete single param', () => {
    const spreadTuple = tCon(T_TUPLE, [tNumber, tSpread]);
    const result = replaceSpreadTupleWithConcrete(spreadTuple, [tString]);
    // Single concrete param → the param itself is returned
    expect(typeToString(result)).toBe('String');
  });

  test('Tuple with spread is replaced by Tuple of concrete params', () => {
    const spreadTuple = tCon(T_TUPLE, [tNumber, tSpread]);
    const result = replaceSpreadTupleWithConcrete(spreadTuple, [tString, tBool]);
    expect(typeToString(result)).toBe('(String, Boolean)');
  });

  test('non-spread TCon with nested spread arg is recursed into', () => {
    const inner = tCon(T_TUPLE, [tNumber, tSpread]);
    const outer = tCon('Array', [inner]);
    const result = replaceSpreadTupleWithConcrete(outer, [tString, tBool]);
    expect(result.tag).toBe('TCon');
    expect(typeToString(result)).toBe('[(String, Boolean)]');
  });
});

// ---------------------------------------------------------------------------
// hasSpreadInArrowChain
// ---------------------------------------------------------------------------

describe('hasSpreadInArrowChain', () => {
  test('returns false for non-function type', () => {
    expect(hasSpreadInArrowChain(tNumber)).toBe(false);
  });

  test('returns false for normal function type', () => {
    expect(hasSpreadInArrowChain(tFun(tNumber, tString))).toBe(false);
  });

  test('returns true when a param in the chain is a spread marker', () => {
    // a -> ... -> b
    const chain = tFun(tNumber, tFun(tSpread, tString));
    expect(hasSpreadInArrowChain(chain)).toBe(true);
  });

  test('detects spread in nested chain', () => {
    const chain = tFun(tNumber, tFun(tString, tFun(tSpread, tBool)));
    expect(hasSpreadInArrowChain(chain)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectSpreadChainLink
// ---------------------------------------------------------------------------

describe('detectSpreadChainLink', () => {
  test('returns null for fewer than two elements', () => {
    expect(detectSpreadChainLink([], [])).toBeNull();
    expect(detectSpreadChainLink([tFun(tNumber, tString)], [])).toBeNull();
  });

  test('detects LTR chain: result of elem[i] links to param of elem[i+1]', () => {
    const a = tVar(); // a
    const b = tVar(); // b
    const c = tVar(); // c
    // LTR: (a->b), (b->c)  — result of [0] shares b.id with param of [1]
    const elements = [tFun(a, b), tFun(b, c)];
    const result = detectSpreadChainLink(elements, []);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('ltr');
    expect(result?.linkId).toBe(b.id);
  });

  test('detects RTL chain: param of elem[i] links to result of elem[i+1]', () => {
    const a = tVar();
    const b = tVar();
    const c = tVar();
    // RTL: (b->c), (a->b)  — param of [0] shares b.id with result of [1]
    const elements = [tFun(b, c), tFun(a, b)];
    const result = detectSpreadChainLink(elements, []);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('rtl');
    expect(result?.linkId).toBe(b.id);
  });

  test('tries after when before yields nothing', () => {
    const a = tVar();
    const b = tVar();
    const c = tVar();
    const elements = [tFun(a, b), tFun(b, c)];
    const result = detectSpreadChainLink([], elements);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('ltr');
  });

  test('returns null when no shared TVars between adjacent elements', () => {
    const a = tVar();
    const b = tVar();
    const c = tVar();
    const d = tVar();
    // no shared ids
    const elements = [tFun(a, b), tFun(c, d)];
    expect(detectSpreadChainLink(elements, [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractParamTVarIds
// ---------------------------------------------------------------------------

describe('extractParamTVarIds', () => {
  test('returns empty array for 0 params', () => {
    expect(extractParamTVarIds(tNumber, 0)).toEqual([]);
  });

  test('returns TVar id for plain TVar param', () => {
    const a = tVar();
    const b = tVar();
    const fn = tFun(a, b);
    const ids = extractParamTVarIds(fn, 1);
    expect(ids).toEqual([a.id]);
  });

  test('extracts multiple params from curried function', () => {
    const a = tVar();
    const b = tVar();
    const c = tVar();
    const fn = tFun(a, tFun(b, c));
    const ids = extractParamTVarIds(fn, 2);
    expect(ids).toEqual([a.id, b.id]);
  });

  test('returns undefined for concrete (non-TVar) param', () => {
    const a = tVar();
    const fn = tFun(tNumber, a);
    const ids = extractParamTVarIds(fn, 1);
    expect(ids).toEqual([undefined]);
  });

  test('returns undefined when type is not a function', () => {
    const ids = extractParamTVarIds(tNumber, 2);
    expect(ids).toEqual([undefined, undefined]);
  });

  test('extracts param TVar ids from TCon -> representation', () => {
    const a = tVar();
    const b = tVar();
    // TCon('->', [a, b]) is an alternative representation of a -> b
    const arrowCon = tCon('->', [a, b]);
    const ids = extractParamTVarIds(arrowCon, 1);
    expect(ids).toEqual([a.id]);
  });

  test('extracts multiple params from nested TCon -> representation', () => {
    const a = tVar();
    const b = tVar();
    const c = tVar();
    // TCon('->', [a, TCon('->', [b, c])]) represents a -> b -> c
    const arrowCon = tCon('->', [a, tCon('->', [b, c])]);
    const ids = extractParamTVarIds(arrowCon, 2);
    expect(ids).toEqual([a.id, b.id]);
  });
});

// ---------------------------------------------------------------------------
// isUnionable — wildcard
// ---------------------------------------------------------------------------

describe('isUnionable — edge cases', () => {
  test('wildcard type is not unionable', () => {
    const wildcard = tCon('*');
    expect(isUnionable(wildcard)).toBe(false);
  });

  test('named wildcard is not unionable', () => {
    const namedWildcard = tCon('*:a');
    expect(isUnionable(namedWildcard)).toBe(false);
  });

  test('TRecord is not unionable', () => {
    expect(isUnionable(tRecord({ x: tNumber }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergeSameConstructor
// ---------------------------------------------------------------------------

describe('mergeSameConstructor', () => {
  test('merges same-name constructors with differing unionable args', () => {
    const a = tCon('Maybe', [tNumber]);
    const b = tCon('Maybe', [tString]);
    const result = mergeSameConstructor(a, b);
    expect(result).not.toBeNull();
    expect(typeToString(result!)).toContain('Number');
    expect(typeToString(result!)).toContain('String');
  });

  test('returns null for different constructor names', () => {
    const a = tCon('Maybe', [tNumber]);
    const b = tCon('Either', [tNumber]);
    expect(mergeSameConstructor(a, b)).toBeNull();
  });

  test('returns null for non-TCon types', () => {
    expect(mergeSameConstructor(tVar(), tVar())).toBeNull();
    expect(mergeSameConstructor(tNumber, tVar())).toBeNull();
  });

  test('returns null for zero-arg constructors', () => {
    expect(mergeSameConstructor(tNumber, tNumber)).toBeNull();
  });

  test('returns null for different arg counts', () => {
    const a = tCon('F', [tNumber]);
    const b = tCon('F', [tNumber, tString]);
    expect(mergeSameConstructor(a, b)).toBeNull();
  });

  test('recursively merges nested same-name constructors', () => {
    // Array (Maybe Number) + Array (Maybe String)
    // Inner Maybe should be merged recursively
    const a = tCon('Array', [tCon('Maybe', [tNumber])]);
    const b = tCon('Array', [tCon('Maybe', [tString])]);
    const result = mergeSameConstructor(a, b);
    expect(result).not.toBeNull();
    const str = typeToString(result!);
    expect(str).toContain('Number');
    expect(str).toContain('String');
  });

  test('returns null when nested types cannot be merged', () => {
    // Array (a -> b) + Array (c -> d) — functions are not unionable and not same-constructor
    const a = tCon('Array', [tFun(tNumber, tString)]);
    const b = tCon('Array', [tFun(tBool, tNumber)]);
    expect(mergeSameConstructor(a, b)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// replaceUnionInType — TRecord
// ---------------------------------------------------------------------------

describe('replaceUnionInType — TRecord', () => {
  test('replaces union inside record fields', () => {
    const union = tUnion([tNumber, tString]);
    const rec = tRecord({ x: union, y: tBool });
    const result = replaceUnionInType(rec, union, tNumber);
    expect(result.tag).toBe('TRecord');
    if (result.tag === 'TRecord') {
      expect(typeToString(result.fields.x)).toBe('Number');
      expect(typeToString(result.fields.y)).toBe('Boolean');
    }
  });
});

// ---------------------------------------------------------------------------
// collectTVarIdsFromType — TRecord
// ---------------------------------------------------------------------------

describe('collectTVarIdsFromType — TRecord', () => {
  test('collects TVars from record fields', () => {
    const a = tVar();
    const b = tVar();
    const ids = new Set<number>();
    collectTVarIdsFromType(tRecord({ foo: a, bar: b, baz: tNumber }), ids);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// freshenType — TRecord
// ---------------------------------------------------------------------------

describe('freshenType — TRecord', () => {
  test('freshens TVars inside record fields', () => {
    const a = tVar();
    const original = tRecord({ x: a, y: tNumber });
    const fresh = freshenType(original);
    expect(fresh.tag).toBe('TRecord');
    if (fresh.tag === 'TRecord') {
      expect(fresh.fields.x.tag).toBe('TVar');
      expect(fresh.fields.x).not.toBe(a); // new identity
      expect(typeToString(fresh.fields.y)).toBe('Number');
    }
  });

  test('same TVar in multiple fields gets the same fresh var', () => {
    const a = tVar();
    const original = tRecord({ x: a, y: a });
    const fresh = freshenType(original);
    if (fresh.tag === 'TRecord') {
      expect(fresh.fields.x).toBe(fresh.fields.y);
    }
  });
});

// ---------------------------------------------------------------------------
// narrowCallResultByArgs
// ---------------------------------------------------------------------------

describe('narrowCallResultByArgs', () => {
  test('narrows union result when arg matches a union member', () => {
    const paramUnion = tUnion([tNumber, tCon('Null', [])]);
    const result = narrowCallResultByArgs(
      paramUnion, // result type same as param
      [paramUnion], // param is union
      [tNumber],    // arg is concrete Number
    );
    expect(typeToString(result)).toBe('Number');
  });

  test('does not narrow when param is not a union', () => {
    const result = narrowCallResultByArgs(
      tNumber,
      [tNumber],
      [tNumber],
    );
    expect(typeToString(result)).toBe('Number');
  });

  test('does not narrow when arg is also a union', () => {
    const paramUnion = tUnion([tNumber, tString]);
    const argUnion = tUnion([tNumber, tString]);
    const result = narrowCallResultByArgs(
      paramUnion,
      [paramUnion],
      [argUnion],
    );
    // Should remain unchanged
    expect(typeToString(result)).toBe('Number | String');
  });

  test('does not narrow when arg is not a member of param union', () => {
    const paramUnion = tUnion([tNumber, tString]);
    const result = narrowCallResultByArgs(
      paramUnion,
      [paramUnion],
      [tBool], // Boolean is not a member
    );
    expect(typeToString(result)).toBe('Number | String');
  });

  test('does not narrow a union NESTED in the result (a declared shape, not a copy of the argument)', () => {
    const union1 = tUnion([tNumber, tCon('Null', [])]);
    const union2 = tUnion([tString, tCon('Null', [])]);
    // f :: (Number | Null, String | Null) -> (Number | Null, String | Null)
    // The signature does not promise a non-null result for non-null
    // arguments, so the tuple keeps its declared members.
    const resultType = tCon(T_TUPLE, [union1, union2]);
    const result = narrowCallResultByArgs(
      resultType,
      [union1, union2],
      [tNumber, tString],
    );
    expect(typeToString(result)).toBe('(Null | Number, Null | String)');
  });

  test('narrows the top-level result for the matching parameter only', () => {
    const union1 = tUnion([tNumber, tCon('Null', [])]);
    const union2 = tUnion([tString, tCon('Null', [])]);
    // g :: (Number | Null, String | Null) -> String | Null, called with (Number, String)
    const result = narrowCallResultByArgs(union2, [union1, union2], [tNumber, tString]);
    expect(typeToString(result)).toBe('String');
  });
});

// ---------------------------------------------------------------------------
// detectSpreadChainLink — RTL in 'after' array
// ---------------------------------------------------------------------------

describe('detectSpreadChainLink — additional patterns', () => {
  test('finds RTL chain in after array (compose pattern)', () => {
    const a = tVar();
    const b = tVar();
    const c = tVar();
    // (b->c), (a->b) — param of [0] = b shares with result of [1] = b
    const elements = [tFun(b, c), tFun(a, b)];
    const result = detectSpreadChainLink([], elements);
    expect(result).not.toBeNull();
    expect(result?.direction).toBe('rtl');
    expect(result?.linkId).toBe(b.id);
  });

  test('skips non-function elements in chain', () => {
    const a = tVar();
    const b = tVar();
    // [Number, a->b] — Number is not a TFun, so skip
    expect(detectSpreadChainLink([tNumber, tFun(a, b)], [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// containsQuantifiedVar
// ---------------------------------------------------------------------------

describe('containsQuantifiedVar', () => {
  test('returns true when TVar is in the set', () => {
    const a = tVar();
    expect(containsQuantifiedVar(a, new Set([a.id]))).toBe(true);
  });

  test('returns false when TVar is not in the set', () => {
    const a = tVar();
    const b = tVar();
    expect(containsQuantifiedVar(a, new Set([b.id]))).toBe(false);
  });

  test('finds quantified var inside TCon args', () => {
    const a = tVar();
    const arr = tCon('Array', [a]);
    expect(containsQuantifiedVar(arr, new Set([a.id]))).toBe(true);
  });

  test('finds quantified var inside TFun', () => {
    const a = tVar();
    const fn = tFun(tNumber, a);
    expect(containsQuantifiedVar(fn, new Set([a.id]))).toBe(true);
  });

  test('finds quantified var inside TRecord fields', () => {
    const a = tVar();
    const rec = tRecord({ x: a, y: tNumber });
    expect(containsQuantifiedVar(rec, new Set([a.id]))).toBe(true);
  });

  test('returns false for TRecord with no quantified vars', () => {
    const a = tVar();
    const rec = tRecord({ x: tNumber, y: tString });
    expect(containsQuantifiedVar(rec, new Set([a.id]))).toBe(false);
  });

  test('returns false for concrete types with empty var set', () => {
    expect(containsQuantifiedVar(tNumber, new Set())).toBe(false);
    expect(containsQuantifiedVar(tFun(tNumber, tString), new Set())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// neutralizeUnions
// ---------------------------------------------------------------------------

describe('neutralizeUnions', () => {
  test('replaces Union at top level with fresh TVar', () => {
    const union = tUnion([tNumber, tString]);
    const result = neutralizeUnions(union);
    expect(result.tag).toBe('TVar');
  });

  test('replaces Union inside TCon args', () => {
    const union = tUnion([tNumber, tString]);
    const arr = tCon('Array', [union]);
    const result = neutralizeUnions(arr);
    expect(result.tag).toBe('TCon');
    if (result.tag === 'TCon') {
      expect(result.args[0].tag).toBe('TVar');
    }
  });

  test('replaces Union inside TFun', () => {
    const union = tUnion([tNumber, tString]);
    const fn = tFun(union, tBool);
    const result = neutralizeUnions(fn);
    expect(result.tag).toBe('TFun');
    if (result.tag === 'TFun') {
      expect(result.param.tag).toBe('TVar');
      expect(typeToString(result.result)).toBe('Boolean');
    }
  });

  test('replaces Union inside TRecord fields', () => {
    const union = tUnion([tNumber, tString]);
    const rec = tRecord({ x: union, y: tBool });
    const result = neutralizeUnions(rec);
    expect(result.tag).toBe('TRecord');
    if (result.tag === 'TRecord') {
      expect(result.fields.x.tag).toBe('TVar');
      expect(typeToString(result.fields.y)).toBe('Boolean');
    }
  });

  test('leaves non-union types unchanged', () => {
    expect(typeToString(neutralizeUnions(tNumber))).toBe('Number');
    const a = tVar();
    const result = neutralizeUnions(a);
    expect(result).toBe(a); // TVar is returned as-is
  });
});

// ---------------------------------------------------------------------------
// replaceSpreadTupleWithConcrete — TRecord branch
// ---------------------------------------------------------------------------

describe('replaceSpreadTupleWithConcrete — TRecord', () => {
  test('replaces spread tuples inside record fields', () => {
    const spreadTuple = tCon(T_TUPLE, [tNumber, tSpread]);
    const rec = tRecord({ fn: tFun(spreadTuple, tString) });
    const result = replaceSpreadTupleWithConcrete(rec, [tBool, tNumber]);
    expect(result.tag).toBe('TRecord');
    if (result.tag === 'TRecord') {
      const fnType = result.fields.fn;
      expect(fnType.tag).toBe('TFun');
      if (fnType.tag === 'TFun') {
        expect(typeToString(fnType.param)).toBe('(Boolean, Number)');
      }
    }
  });

  test('returns same reference when no spread found in record', () => {
    const rec = tRecord({ x: tNumber, y: tString });
    const result = replaceSpreadTupleWithConcrete(rec, [tBool]);
    expect(result).toBe(rec); // no change, same reference
  });
});
