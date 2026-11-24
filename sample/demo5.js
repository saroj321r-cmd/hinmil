import Pair from './Pair';
// ============================================================================
// demo5.js — objects-in-arrays + record spread
//
// Demonstrates how HinMil handles the combination of:
//   • record spread inside an object literal: `{ ...a, ...b }`
//   • mapping over arrays of records, producing merged shapes
//   • heterogeneous record arrays — missing fields surface as
//     `T | Undefined` (matching JS runtime semantics)
//   • label polymorphism (`[k] :: v`) so a helper can be generic over
//     "which key is the id"
//
// Hover any binding in the editor to see the type HinMil inferred.
//
// Two style notes:
//   1. Concrete spread (`{ ...someLiteral, ...other }`) is fully inferred —
//      both sides are visible records and the engine merges their fields.
//   2. A polymorphic helper that spreads its parameter (e.g.
//      `it => ({ ...it, ts: 0 })`) needs an explicit annotation, because
//      at the moment the body is checked, `it` is still an unbound type
//      variable and the spread has no fields to merge.  The annotation
//      uses an open record + row variable (`{ ...r }`) to thread the
//      caller's fields through.
// ============================================================================


// -----------------------------------------------------------------------
// 1. Concrete spread merge — both sides have known fields
// -----------------------------------------------------------------------

const defaults = { method: "GET", auth: false, timeout: 5000 };

// HinMil merges the heterogeneous element shapes: every field that
// appears in *any* element is present in the inferred element type;
// fields missing from at least one element get `T | Undefined` (which
// matches JS runtime semantics — reading a missing key yields
// `undefined`).  Hover `item` inside the callback to see all four.

const routes = [
  { path: "/users" },
  { path: "/admin", auth: true },
  { path: "/upload", method: "POST", timeout: 30000 },
].map(item => {
  return ({ ...defaults, ...item})
});
// Inferred:
//   item   = { path: String,
//              auth: Boolean | Undefined,
//              method: String | Undefined,
//              timeout: Number | Undefined }
//   routes = [{ method: String | Undefined,
//               auth: Boolean | Undefined,
//               timeout: Number | Undefined,
//               path: String }]
// (spreading an `Undefined`-valued field overrides the default — exactly
//  what JS does at runtime; if you want to keep the defaults instead,
//  filter undefined out of `item` first.)


// -----------------------------------------------------------------------
// 2. Stamping events with shared metadata (concrete inline)
// -----------------------------------------------------------------------

const meta = { source: "api", env: "prod" };

const logs = [
  { level: "info",  msg: "started" },
  { level: "error", msg: "boom", code: 500 },
].map(e => ({ ...meta, ...e }));
// → logs : [{ source, env, level, msg, code (Number | Undefined) }]
// `code` only appears on the second element, so the merged element shape
// types it as `Number | Undefined`.


// -----------------------------------------------------------------------
// 3. Polymorphic helper: needs an annotation to thread fields through
// -----------------------------------------------------------------------
// Without the annotation the row variable `r` would not exist at
// body-inference time, and spreading `it` would yield `{}`.

// addTs :: [{ ts :: Number, ...r }] -> [{ ts :: Number, ...r }]
const addTs = items => items.map(it => ({ ...it, ts: 0 }));

const stamped = addTs([
  { id: 1, name: "Ada"   },
  { id: 2, name: "Linus" },
]);
// → stamped : [{ ts :: Number, id :: Number, name :: String }]


// -----------------------------------------------------------------------
// 4. Label polymorphism — generic over which field acts as the "id"
// -----------------------------------------------------------------------

// pluck :: (k, [{ [k] :: v, ...r }]) -> [v]
const pluck = (key, list) => list.map(item => item[key]);

const users = [
  { id: 1, name: "Ada",   role: "user"  },
  { id: 2, name: "Linus", role: "user"  },
  { id: 3, name: "Grace", role: "admin" },
];

const pluckedNames = pluck("name", users);  // → [String]
const pluckedIds   = pluck("id",   users);  // → [Number]


// -----------------------------------------------------------------------
// 5. Element-wise merge of two parallel arrays
// -----------------------------------------------------------------------

const ids    = [{ id: 1 }, { id: 2 }, { id: 3 }];
const scores = [{ score: 0.9 }, { score: 0.7 }, { score: 0.5 }];

const enriched = ids.map((x, i) => ({ ...x, ...scores[i] }));
// → enriched : [{ id :: Number, score :: Number }]


// -----------------------------------------------------------------------
// 6. Row-map fan-out — `[k]` quantifies over EVERY key when free
// -----------------------------------------------------------------------
// When the label var `k` is *not* bound by any other parameter (unlike
// `pluck` above, where `k` arrives as the first positional arg), the
// engine treats `{ [k] :: T }` as "for every key in the argument
// record".  At the call site each concrete key in the object literal
// gets its own freshening of the type vars internal to the label-field
// group.
//
// Hover `obj[k]` in the body — the engine knows it is `Pair a b`, so
// completion on `obj[k].` shows `fst` and `snd`.  At the call site the
// label var is fanned out across every key of the literal.

 // unwrap :: { [k] :: Pair a b } -> { [k] :: b }
const unwrap = obj => Object.keys(obj).reduce((acc, k) => ({ ...acc, [k]: obj[k].snd }), {});

const unwrapped = unwrap({
  a: Pair(1, "one"),
  b: Pair(2, 2),
});
// → unwrapped : { a :: String, b :: String }
//
// (Try changing `Pair(2, "two")` to `Pair(2, 42)` — the inferred type
//  becomes `{ a :: String, b :: Number }`, each key picks up its own
//  freshened `b` independently.)

// merge :: ({a}, {b}) -> { ...a, ...b }
const merge = (obj1, obj2) => Object.keys(obj1).reduce((acc, k) => ({ ...acc, [k]: obj2[k] }), obj1);

const merged = merge({ a: 1}, {b : 2})

const emptyMerge = merge({}, {})

// pickDeep :: (k, { deep :: { [k]::a, ...r } }) -> a
const pickDeep = (key, obj) => obj.deep[key]

const deep = pickDeep("buh", { deep: { buh: "dd"}})