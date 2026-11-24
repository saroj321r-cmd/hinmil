// Unit tests for the chain-combinator subsystem's public surface in
// src/infer/functionPatterns.ts: the structural call-pattern classifier
// (classifyCallPattern) and the re-exported chain predicates that were
// centralized during the Option-C consolidation.

import {
  classifyCallPattern,
  CallPatternKind,
  isArrowChainTuple,
  collapseArrowChainTuple,
  hasTopLevelSpreadChain,
  hasSpreadInArrowChain,
  isSpreadTupleOrArray,
} from '../../src/infer/functionPatterns';
import {
  tVar,
  tFun,
  tNumber,
  tString,
  tCon,
  tArray,
  tSpread,
  kvName,
  resetTypeVarCounter,
  T_TUPLE,
  T_SPREAD_ARRAY,
  Type,
} from '../../src/hm/types';

beforeEach(() => {
  resetTypeVarCounter();
});

// A minimal stand-in for an acorn CallExpression: the classifier only reads
// `node.arguments.length` and `node.arguments[0].type`.
function callNode(argTypes: string[]): any {
  return { type: 'CallExpression', arguments: argTypes.map(t => ({ type: t })) };
}

// A spread arrow chain tuple `(a -> b, b -> c, ...)` — an arrow chain.
function arrowChainTuple(name = T_TUPLE): Type {
  const ab = tFun(tVar('a'), tVar('b'));
  const bc = tFun(tVar('b'), tVar('c'));
  return tCon(name, [ab, bc, tSpread]);
}

// ---------------------------------------------------------------------------
// isArrowChainTuple / collapseArrowChainTuple
// ---------------------------------------------------------------------------

describe('isArrowChainTuple', () => {
  test('spread tuple whose non-spread elements are all arrows is a chain', () => {
    expect(isArrowChainTuple(arrowChainTuple())).toBe(true);
    expect(isArrowChainTuple(arrowChainTuple(T_SPREAD_ARRAY))).toBe(true);
  });

  test('a spread tuple with a non-arrow element is NOT a chain', () => {
    const mixed = tCon(T_TUPLE, [tFun(tVar('a'), tVar('b')), tNumber, tSpread]);
    expect(isArrowChainTuple(mixed)).toBe(false);
  });

  test('a tuple WITHOUT a spread marker is not a chain', () => {
    const noSpread = tCon(T_TUPLE, [tFun(tVar('a'), tVar('b'))]);
    expect(isArrowChainTuple(noSpread)).toBe(false);
  });

  test('non-tuple types are not chains', () => {
    expect(isArrowChainTuple(tNumber)).toBe(false);
    expect(isArrowChainTuple(tFun(tNumber, tString))).toBe(false);
    expect(isArrowChainTuple(tArray(tNumber))).toBe(false);
  });
});

describe('collapseArrowChainTuple', () => {
  test('collapses (a -> b, b -> c, ...) to a -> c', () => {
    const a = tVar('a');
    const b = tVar('b');
    const c = tVar('c');
    const tuple = tCon(T_TUPLE, [tFun(a, b), tFun(b, c), tSpread]);
    const collapsed = collapseArrowChainTuple(
      tuple as Type & { tag: 'TCon'; args: Type[] },
    );
    expect(collapsed).not.toBeNull();
    expect(collapsed!.tag).toBe('TFun');
    const fn = collapsed as Extract<Type, { tag: 'TFun' }>;
    expect(fn.param).toEqual(a);
    expect(fn.result).toEqual(c);
  });
});

// ---------------------------------------------------------------------------
// hasTopLevelSpreadChain / hasSpreadInArrowChain
// ---------------------------------------------------------------------------

describe('hasTopLevelSpreadChain', () => {
  test('true for a flat variadic chain a -> b -> ... -> z', () => {
    const chain = tFun(tVar('a'), tFun(tVar('b'), tFun(tSpread, tVar('z'))));
    expect(hasTopLevelSpreadChain(chain)).toBe(true);
  });

  test('false when the spread is nested inside a higher-order parameter', () => {
    const inner = tFun(tVar('a'), tFun(tSpread, tVar('z')));
    const higherOrder = tFun(inner, tVar('r'));
    expect(hasTopLevelSpreadChain(higherOrder)).toBe(false);
  });

  test('false for a plain function with no spread', () => {
    expect(hasTopLevelSpreadChain(tFun(tNumber, tString))).toBe(false);
  });
});

describe('re-exported predicates keep their identity', () => {
  test('hasSpreadInArrowChain and isSpreadTupleOrArray behave as expected', () => {
    expect(hasSpreadInArrowChain(tFun(tNumber, tFun(tSpread, tString)))).toBe(true);
    expect(hasSpreadInArrowChain(tFun(tNumber, tString))).toBe(false);
    expect(isSpreadTupleOrArray(tCon(T_TUPLE, [tNumber, tSpread]))).toBe(true);
    expect(isSpreadTupleOrArray(tCon(T_TUPLE, [tNumber]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyCallPattern
// ---------------------------------------------------------------------------

describe('classifyCallPattern', () => {
  test('Regular for a non-function callee', () => {
    expect(classifyCallPattern(tNumber, callNode([]))).toBe(CallPatternKind.Regular);
  });

  test('Regular for an ordinary function call', () => {
    const callee = tFun(tNumber, tString);
    expect(classifyCallPattern(callee, callNode(['Literal']))).toBe(CallPatternKind.Regular);
  });

  test('VariadicWrapper: ((a, b, ...) -> z) -> (a, b, ...) -> z applied to one arg', () => {
    const spreadParam = tCon(T_TUPLE, [tVar('a'), tVar('b'), tSpread]);
    const wrapped = tFun(spreadParam, tVar('z'));
    const callee = tFun(wrapped, tFun(spreadParam, tVar('z')));
    expect(classifyCallPattern(callee, callNode(['ArrowFunctionExpression']))).toBe(
      CallPatternKind.VariadicWrapper,
    );
  });

  test('VariadicItems: a spread tuple applied positionally', () => {
    const callee = tFun(tCon(T_TUPLE, [tFun(tVar('a'), tVar('b')), tSpread]), tVar('z'));
    expect(classifyCallPattern(callee, callNode(['Identifier', 'Identifier']))).toBe(
      CallPatternKind.VariadicItems,
    );
  });

  test('SpreadArrayApplier: [a, ..., z] -> r applied to one array literal', () => {
    const callee = tFun(tCon(T_SPREAD_ARRAY, [tVar('a'), tSpread]), tVar('z'));
    expect(classifyCallPattern(callee, callNode(['ArrayExpression']))).toBe(
      CallPatternKind.SpreadArrayApplier,
    );
  });

  test('ContainerSpreadChain: f (a->b, b->c, ...) with a single array arg', () => {
    const f = tVar('f');
    const container = tCon(kvName('f', f.id), [arrowChainTuple()]);
    const callee = tFun(container, tVar('z'));
    expect(classifyCallPattern(callee, callNode(['ArrayExpression']))).toBe(
      CallPatternKind.ContainerSpreadChain,
    );
  });

  test('FanOut: f (combiner, a->x1, a->x2, ...) with a single array arg', () => {
    const f = tVar('f');
    // Multi-arity CURRIED combiner head: x1 -> x2 -> z, then branches a -> x1, a -> x2.
    const combiner = tFun(tVar('x1'), tFun(tVar('x2'), tVar('z')));
    const b1 = tFun(tVar('a'), tVar('x1'));
    const b2 = tFun(tVar('a'), tVar('x2'));
    const container = tCon(kvName('f', f.id), [tCon(T_TUPLE, [combiner, b1, b2, tSpread])]);
    const callee = tFun(container, tFun(tVar('a'), tVar('z')));
    expect(classifyCallPattern(callee, callNode(['ArrayExpression']))).toBe(
      CallPatternKind.FanOut,
    );
  });

  test('ContainerSpreadChain takes priority over FanOut for a linear chain', () => {
    // Every element is a single-arg arrow → linear pipe/compose chain, NOT fan-out.
    const f = tVar('f');
    const container = tCon(kvName('f', f.id), [arrowChainTuple()]);
    const callee = tFun(container, tVar('z'));
    expect(classifyCallPattern(callee, callNode(['ArrayExpression']))).not.toBe(
      CallPatternKind.FanOut,
    );
  });
});
