// Regression coverage for the `size.js` problem set (fpkit):
//
//   // ::constraint Foldable f { ... }
//   // size :: Foldable f => f a -> Number
//   // size :: String -> Number
//   const size = foldable => {
//     if (hasProp ("length") (foldable)) {
//       return foldable.length;
//     }
//     return reduce (count => _x => count + 1) (0) (foldable);
//   };
//
// `foldable` is an annotated, overloaded (`f a | String`) parameter.  Passing
// it as a plain *value* to an unrelated helper (`hasProp : String -> Object k a
// -> Boolean`) must NOT unify `foldable`'s type variable with the helper's
// concrete parameter type (`Object k a`).  Previously that global pin produced
// a spurious `Property 'length' does not exist on type Object k a` diagnostic
// and made every occurrence of `foldable` render as `Object k a`.
//
// The fix freshens the argument type at the call boundary for parameters whose
// declared (frozen) display is an overload union, so the helper cannot leak its
// parameter type back onto the polymorphic parameter.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import { buildHover } from '../../src/services/hover';
import type { Type } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

/**
 * Hover string for `offset`, mirroring server.ts: prefer the frozen parameter
 * snapshot (`frozenParamType`) when the cursor sits on an annotated parameter.
 */
function hoverAt(src: string, offset: number): string | null {
  const r = engine.infer(src);
  let bestStart = -1;
  let bestType: Type | null = null;
  for (const [s, info] of r.nodeTypes) {
    const end = (info as { end: number }).end;
    if (s <= offset && offset < end && s > bestStart) {
      bestStart = s;
      bestType = r.substitution.apply((info as { type: Type }).type);
    }
  }
  const frozenMap = (r as unknown as { frozenParamType?: Map<number, Type> }).frozenParamType;
  if (bestStart >= 0 && frozenMap?.has(bestStart)) {
    bestType = frozenMap.get(bestStart)!;
  }
  const h = buildHover({
    source: src, offset, result: r, bestType, bestStart, arrayShift: 0,
    inferredTypeStyle: 'pretty', uri: 'file:///t.js',
    resolveImportSpecifier: () => null,
    extractImportSpecifiers: () => new Map(),
  } as Parameters<typeof buildHover>[0]);
  return h ? (h.contents as { value: string }).value : null;
}

const SIZE_SRC = `"use strict";
// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }
const reduce = a => b => c => 0;
// hasProp :: String -> Object k a -> Boolean
const hasProp = key => obj => true;
// size :: Foldable f => f a -> Number
// size :: String -> Number
const size = foldable => {
  if (hasProp ("length") (foldable)) {
    return foldable.length;
  }
  return reduce (count => _x => count + 1) (0) (foldable);
};
`;

describe('polymorphic parameter global-pin protection (size.js)', () => {
  test('passing an overloaded parameter to an unrelated helper produces no spurious diagnostics', () => {
    const r = engine.infer(SIZE_SRC);
    const len = r.diagnostics.filter(d => d.message.includes('length'));
    expect(len).toHaveLength(0);
    const objK = r.diagnostics.filter(d => d.message.includes('Object k a'));
    expect(objK).toHaveLength(0);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('the parameter still displays as its declared overload union at the helper call site', () => {
    const off = SIZE_SRC.indexOf('(foldable)') + 1; // the `foldable` arg to hasProp
    const hover = hoverAt(SIZE_SRC, off);
    expect(hover).toContain('Foldable f => f a | String');
  });

  test('the parameter displays as its declared overload union at the declaration', () => {
    const off = SIZE_SRC.indexOf('foldable =>');
    const hover = hoverAt(SIZE_SRC, off);
    expect(hover).toContain('Foldable f => f a | String');
  });

  test('the parameter is not pinned to the helper parameter type anywhere', () => {
    const r = engine.infer(SIZE_SRC);
    for (const [start, info] of r.nodeTypes.entries()) {
      const text = SIZE_SRC.slice(start, (info as { end: number }).end);
      if (text === 'foldable') {
        const ty = prettyTypeToString(r.substitution.apply((info as { type: Type }).type));
        expect(ty).not.toContain('Object');
      }
    }
  });

  test('member access on the polymorphic parameter does not error', () => {
    const r = engine.infer(SIZE_SRC);
    const memberErr = r.diagnostics.filter(d => d.message.includes("does not exist"));
    expect(memberErr).toHaveLength(0);
  });
});

describe('global-pin protection does not suppress real mismatches', () => {
  // A *single* polymorphic parameter (not an overload union) passed to a
  // callee whose slot has more structure must still report a mismatch.
  test('wrong constraint-method argument still produces a diagnostic', () => {
    const src = `
// ::constraint Chain m { m :: { chain :: m a ~> (a -> m b) -> m b } }
// chain :: Chain m => (a -> b, m a) -> m b
const chain = (fn, chain) => chain.chain(fn)
    `;
    const r = engine.infer(src);
    const mismatch = r.diagnostics.filter(d => d.message.includes('Type mismatch'));
    expect(mismatch).toHaveLength(1);
  });
});
