// Display sugar for `Object` and `Function` types, mirroring the existing
// `Array a` -> `[a]` sugar:
//   Object k a               -> { [k] :: a }
//   Function [x] a           -> x -> a
//   Function [x, y] a        -> (x, y) -> a
//   Function [] a            -> () -> a
//   Function [x] (Function [y] a) -> x -> y -> a
import {
  Type,
  tCon,
  tVar,
  tArray,
  tLabelVar,
  prettyTypeToString,
} from '../../src/hm/types';

const strictEmptyArray = (): Type =>
  Object.assign(tArray(tVar()), { strictEmpty: true });

describe('Object display sugar', () => {
  test('`Object k a` renders as `{ [k] :: a }`', () => {
    const t = tCon('Object', [tLabelVar('k'), tVar('a')]);
    expect(prettyTypeToString(t)).toBe('{ [k] :: a }');
  });

  test('nested inside an array: `[Object k a]` -> `[{ [k] :: a }]`', () => {
    const t = tArray(tCon('Object', [tLabelVar('k'), tVar('a')]));
    expect(prettyTypeToString(t)).toBe('[{ [k] :: a }]');
  });

  test('as a juxtaposition arg it needs NO wrapping parens', () => {
    const t = tCon('Maybe', [tCon('Object', [tLabelVar('k'), tVar('a')])]);
    expect(prettyTypeToString(t)).toBe('Maybe { [k] :: a }');
  });

  test('a bare `Object` (arity 0) is left untouched', () => {
    expect(prettyTypeToString(tCon('Object', []))).toBe('Object');
  });

  test('malformed `Object a b c` (arity 3) falls through to the raw form', () => {
    const t = tCon('Object', [tVar('a'), tVar('b'), tVar('c')]);
    expect(prettyTypeToString(t)).toBe('Object a b c');
  });
});

describe('Function display sugar', () => {
  test('`Function [x] a` renders as `x -> a`', () => {
    const t = tCon('Function', [tArray(tVar('x')), tVar('a')]);
    expect(prettyTypeToString(t)).toBe('x -> a');
  });

  test('`Function [x, y] a` renders as `(x, y) -> a`', () => {
    const t = tCon('Function', [
      tCon('SpreadArray', [tVar('x'), tVar('y')]),
      tVar('a'),
    ]);
    expect(prettyTypeToString(t)).toBe('(x, y) -> a');
  });

  test('`Function [] a` renders as `() -> a`', () => {
    const t = tCon('Function', [strictEmptyArray(), tVar('a')]);
    expect(prettyTypeToString(t)).toBe('() -> a');
  });

  test('curried `Function [x] (Function [y] a)` renders as `x -> y -> a`', () => {
    const t = tCon('Function', [
      tArray(tVar('x')),
      tCon('Function', [tArray(tVar('y')), tVar('a')]),
    ]);
    expect(prettyTypeToString(t)).toBe('x -> y -> a');
  });

  test('higher-order param keeps parens: `Function [Function [y] a] b` -> `(y -> a) -> b`', () => {
    const t = tCon('Function', [
      tArray(tCon('Function', [tArray(tVar('y')), tVar('a')])),
      tVar('b'),
    ]);
    expect(prettyTypeToString(t)).toBe('(y -> a) -> b');
  });

  test('as a union member it is parenthesized: `Number | (x -> a)`', () => {
    const t = tCon('Union', [
      tCon('Number', []),
      tCon('Function', [tArray(tVar('x')), tVar('a')]),
    ]);
    expect(prettyTypeToString(t)).toBe('Number | (x -> a)');
  });

  test('as a juxtaposition arg it is parenthesized: `Maybe (x -> a)`', () => {
    const t = tCon('Maybe', [tCon('Function', [tArray(tVar('x')), tVar('a')])]);
    expect(prettyTypeToString(t)).toBe('Maybe (x -> a)');
  });
});
