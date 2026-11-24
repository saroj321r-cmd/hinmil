// ============================================================================
// lens.js — Ramda-style lenses for HinMil
//
// A lens is a first-class getter/setter pair focused on a part `a` of a
// whole `s`.  All lens operations (`view`, `set`, `over`) and lens
// composition are fully type-safe.  Two factories are provided:
//   • lensProp(key)  — focus a record property (label-polymorphic)
//   • lensIndex(i)   — focus an array element
//
// Encoding:
//
//   Lens s a ≅ { getter :: s -> a
//              , setter :: (a, s) -> s
//              }
//
// (We use plain record fields `getter`/`setter` rather than `get`/`set`
// to avoid clashing with the registered methods of the JS `Map` type.)
// ============================================================================

// lens :: (s -> a, (a, s) -> s) -> { getter :: s -> a, setter :: (a, s) -> s }
export const lens = (getter, setter) => ({ getter, setter });

// view :: ({ getter :: s -> a, setter :: (a, s) -> s }, s) -> a
export const view = (l, obj) => l.getter(obj);

// set :: ({ getter :: s -> a, setter :: (a, s) -> s }, a, s) -> s
export const set = (l, val, obj) => l.setter(val, obj);

// over :: ({ getter :: s -> a, setter :: (a, s) -> s }, a -> a, s) -> s
export const over = (l, fn, obj) => l.setter(fn(l.getter(obj)), obj);

// composeL :: ( { getter :: s -> b, setter :: (b, s) -> s }
//             , { getter :: b -> c, setter :: (c, b) -> b }
//             ) -> { getter :: s -> c, setter :: (c, s) -> s }
//
// Compose two lenses focusing through `s -> b -> c`.  The result focuses
// from the outer whole `s` to the inner part `c`.  Setting through the
// composed lens updates the inner part and rebuilds the whole.
export const composeL = (outer, inner) => lens(
  (s) => inner.getter(outer.getter(s)),
  (a, s) => outer.setter(inner.setter(a, outer.getter(s)), s),
);

// lensProp :: (k) -> { getter :: { [k] :: a, ...r } -> a
//                    , setter :: (a, { [k] :: a, ...r }) -> { [k] :: a, ...r }
//                    }
//
// Build a lens focused on the property named by `k`.  Label-polymorphism
// (`[k]`) means each call to `lensProp("foo")` produces a lens whose
// row-poly type fixes `k := 'foo'` at the call site, so the focused
// record type carries the actual property name.
export const lensProp = (key) => lens(
  (obj) => obj[key],
  (val, obj) => ({ ...obj, [key]: val }),
);

// lensIndex :: (Number) -> { getter :: [a] -> a
//                          , setter :: (a, [a]) -> [a]
//                          }
//
// Build a lens focused on the element at array index `i`.  Setting
// returns a new array (the original is not mutated).
export const lensIndex = (i) => lens(
  (xs) => xs[i],
  (v, xs) => xs.map((x, j) => j === i ? v : x),
);

// lensPath :: ([k1,]) -> { getter :: { [k1] :: a, ...r } -> a, setter :: (a, { [k1] :: a, ...r }) -> { [k1] :: a, ...r } }
// lensPath :: ([k1, k2]) -> { getter :: { [k1] :: { [k2] :: a, ...s }, ...r } -> a, setter :: (a, { [k1] :: { [k2] :: a, ...s }, ...r }) -> { [k1] :: { [k2] :: a, ...s }, ...r } }
// lensPath :: ([k1, k2, k3]) -> { getter :: { [k1] :: { [k2] :: { [k3] :: a, ...t }, ...s }, ...r } -> a, setter :: (a, { [k1] :: { [k2] :: { [k3] :: a, ...t }, ...s }, ...r }) -> { [k1] :: { [k2] :: { [k3] :: a, ...t }, ...s }, ...r } }
//
// Build a lens focused on a nested path of record properties.  This is a
// single overloaded form: the overload selected at a call site is chosen by
// the LENGTH of the path literal — `lensPath(["a"])` focuses one level,
// `lensPath(["a", "b"])` two, `lensPath(["a", "b", "c"])` three — so the
// focused record type is reconstructed to the exact nesting depth.  Each
// level is row-polymorphic (`[k]`/`...r`), exactly like `lensProp`, and the
// path is desugared into a chain of `lensProp` foci via `composeL`.
export const lensPath = (keys) =>
  keys.length === 1 ? lensProp(keys[0])
  : keys.length === 2 ? composeL(lensProp(keys[0]), lensProp(keys[1]))
  : composeL(composeL(lensProp(keys[0]), lensProp(keys[1])), lensProp(keys[2]));
