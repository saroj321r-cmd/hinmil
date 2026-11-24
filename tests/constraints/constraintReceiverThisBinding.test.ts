// Regression: a method-form annotation that combines a CONSTRAINT (`=>`) with
// a receiver (`~>`) must still bind `this` to the receiver type inside the
// method body.  Previously, the constrained-member-assignment path passed an
// expected type to the RHS function, which bypassed the inline method-`this`
// binding (that only fires when no expected type is set), leaving `this` as an
// unbound type variable instead of the receiver `Function [a] (f a)`.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString } from '../../src/hm/types';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import { clearConstraints } from '../../src/registries/constraintRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  clearCustomMethods();
  clearConstraints();
  engine = new InferenceEngine();
});

/** Pretty type of the `this` expression at the given source offset. */
function thisTypeAt(r: ReturnType<InferenceEngine['infer']>, src: string): string | undefined {
  const offset = src.indexOf('this (value)');
  const info = r.nodeTypes.get(offset);
  return info ? prettyTypeToString(info.type) : undefined;
}

describe('constraint + receiver (~>) method this-binding', () => {
  const src = `"use strict";
// ::constraint Alt f { f :: { alt :: f a ~> f a -> f a } }
const alt = a => b => a;
let natives = {};
// natives.Function :: Alt f => Function [a] (f a) ~> Function [a] (f a) -> Function [a] (f a)
natives.Function = function (other) {
  return value => alt (this (value)) (other (value));
};
`;

  it('binds `this` to the receiver type even with a leading constraint', () => {
    const r = engine.infer(src);
    expect(thisTypeAt(r, src)).toBe('a -> f a');
  });

  it('an unconstrained sibling still binds `this` (no regression)', () => {
    const src2 = `"use strict";
let natives = {};
// natives.Array :: Array a ~> Array a -> Array a
natives.Array = function (other) {
  return this;
};
`;
    const r = engine.infer(src2);
    const offset = src2.indexOf('this;');
    const info = r.nodeTypes.get(offset);
    // `this` resolves to the receiver `Array a` (the element var may be a
    // rigid skolem in this unconstrained path, which the LSP scrubs back to
    // `a` for display — here we just assert the Array TCon shape).
    expect(info?.type.tag).toBe('TCon');
    expect((info?.type as { name: string }).name).toBe('Array');
  });
});

// ---------------------------------------------------------------------------
// A constrained *method-form* annotation (constraint `=>` AND receiver `~>`)
// whose body returns a curried lambda that calls another OVERLOADED function.
// Two bugs combined here:
//   1. Calling an overloaded function (`alt :: Alt f => f a -> … | Array a ->
//      …`) with a constraint-variable argument (`f a`) must NOT commit the
//      concrete `Array` branch and pin `f` to `Array` everywhere.
//   2. The constrained-method assignment path must not dereference an unset
//      `constrainedAnnotation` (the receiver case routes through the inline
//      `this`-binding path), which previously threw an internal error.
// ---------------------------------------------------------------------------
describe('constrained method body calling an overloaded constraint function', () => {
  const src = `"use strict";
// ::constraint Alt f { f :: { alt :: f a ~> f a -> f a } }
const concat = a => b => a;
let natives = {};
// natives.Array :: Array a ~> Array a -> Array a
natives.Array = function (other) { return concat (other) (this); };
// natives.Function :: Alt f => Function [a] (f a) ~> Function [a] (f a) -> Function [a] (f a)
natives.Function = function (other) {
  return value => alt (other (value)) (this (value));
};
// alt :: Alt f => f a -> f a -> f a
// alt :: Array a -> Array a -> Array a
// alt :: Alt f => Function [a] (f a) -> Function [a] (f a) -> Function [a] (f a)
const alt = alt1 => alt2 => alt1;
`;

  it('produces no diagnostics (no internal error, no spurious mismatch)', () => {
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  it('binds `this` in the constrained method to its receiver', () => {
    const r = engine.infer(src);
    const offset = src.indexOf('this (value)');
    const info = r.nodeTypes.get(offset);
    expect(info ? prettyTypeToString(info.type) : undefined).toBe('a -> f a');
  });

  it('does not pin a constraint variable to a concrete overload branch', () => {
    const src2 = `"use strict";
// ::constraint Alt f { f :: { alt :: f a ~> f a -> f a } }
// wrap :: Alt f => f a -> f a
const wrap = x => alt (x) (x);
// alt :: Alt f => f a -> f a -> f a
// alt :: Array a -> Array a -> Array a
const alt = alt1 => alt2 => alt1;
`;
    const r = engine.infer(src2);
    expect(r.diagnostics).toHaveLength(0);
    // Every `x` keeps its constraint-variable type `f a`; it is NOT pinned to
    // `[a]` by the concrete `Array` overload of `alt`.
    for (const [start, info] of r.nodeTypes.entries()) {
      if (src2.slice(start, info.end) === 'x') {
        expect(prettyTypeToString(r.substitution.apply(info.type))).toBe('f a');
      }
    }
  });

  it('still selects the concrete branch for a genuinely concrete argument', () => {
    const src3 = `"use strict";
// ::constraint Alt f { f :: { alt :: f a ~> f a -> f a } }
// useArr :: Array Number -> Array Number
const useArr = xs => alt (xs) (xs);
// alt :: Alt f => f a -> f a -> f a
// alt :: Array a -> Array a -> Array a
const alt = alt1 => alt2 => alt1;
`;
    const r = engine.infer(src3);
    expect(r.diagnostics).toHaveLength(0);
    // The concrete `Array` overload is selected for a concrete argument:
    // `useArr` is `[Number] -> [Number]` and no constraint variable `f` leaks.
    const off = src3.indexOf('useArr = xs');
    const bindingType = prettyTypeToString(r.substitution.apply(r.nodeTypes.get(off)!.type));
    expect(bindingType).toBe('[Number] -> [Number]');
  });
});

