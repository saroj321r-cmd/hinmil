// ============================================================================
// demo4.js — modern JavaScript syntax features now supported by HinMil
//
// This file showcases each feature added in the syntax-coverage pass:
//   1. Logical assignment operators (||=, &&=, ??=)
//   2. Class fields (PropertyDefinition), incl. private (#field) and static
//   3. Static initialization blocks (`static { ... }`)
//   4. Private methods and private member access (`obj.#field`, `this.#m()`)
//   5. Dynamic import expressions (`import('./mod')`)
//   6. `for await ... of` over async iterables
//   7. Catch parameter typed as Error so `e.message` etc. type-check
// ============================================================================


// -----------------------------------------------------------------------
// 1. Logical assignment operators (||=, &&=, ??=)
// -----------------------------------------------------------------------
// Each operator only assigns when the short-circuit condition holds, so the
// two sides of the assignment may have unrelated types — the engine no
// longer forces unification.

// Config :: { name :: String, host :: String, port :: Number }

// withDefaults :: Config -> Config
const withDefaults = (config) => {
  config.name ||= "anonymous";          // empty string → "anonymous"
  config.host ??= "localhost";          // null/undefined → "localhost"
  config.port &&= config.port + 1000;   // truthy → bump into user-port range
  return config;
};


// -----------------------------------------------------------------------
// 2. Class fields (instance, static, private)
// -----------------------------------------------------------------------
// Field initialisers are inferred just like ordinary expressions.  Static
// fields are registered on the class so `ClassName.field` works at call
// sites.  Private fields (#name) are scoped to the class.

// Each instance field can be annotated with `Class#field :: Class ~> T`.
// Static fields use `Class.field :: T`.  Private fields and methods (the
// ones written with `#name`) use `Class##name :: T` — they are only visible
// inside the class body, so the annotation lives in the same private scope.

// Counter :: () -> Counter
// Counter.MAX :: Number
// Counter##history :: Array Number
// Counter##record :: Number -> Void
class Counter {
  // instance fields (run in an environment where `this` is the instance)
  count = 0;
  label = "ticks";

  // private state — invisible outside the class
  #history = [];

  // static field — accessed as Counter.MAX
  static MAX = 1000;

  // static initialisation block — runs once when the class is evaluated
  static {
    const greeting = "Counter loaded";
  }

  tick(by) {
    this.count = this.count + by;
    this.#record(this.count);
    return this.count;
  }

  history() {
    return this.#history;
  }

  // private method — also part of the class's private surface
  #record(snapshot) {
    this.#history = [...this.#history, snapshot];
  }
}

const counter = new Counter();
// -----------------------------------------------------------------------
// 3. Annotated class field
// -----------------------------------------------------------------------
// An explicit annotation pins the field's type and is enforced against the
// initialiser.

// Box :: () -> Box
// Box#size :: Box ~> Number
class Box {
  size = 0;
}


// -----------------------------------------------------------------------
// 4. Dynamic import + await
// -----------------------------------------------------------------------
// When the import specifier is a string literal, the engine resolves the
// module's exports the same way it resolves static `import` statements.
// That means `mod.curry` below has full hover / completion support after
// the await — try hovering on `mod` or typing `mod.` in your editor.

// loadHelpers :: () -> Promise e { curry :: (a -> b -> c) -> a -> b -> c }
const loadHelpers = async () => {
  const mod = await import("./common");
  return mod;
};

// `useCurry` curries two arguments and only goes async on the inner call,
// so its type is exactly `Number -> Number -> Promise Number`.  Making the
// outer arrow non-async (instead of `async x => async y => ...`) keeps the
// curried shape — an `async` outer would wrap the inner function in a
// Promise too, giving `Number -> Promise (Number -> Promise Number)`.

// useCurry :: Number -> Number -> Promise e Number
const useCurry = (x) => async (y) => {
  // After the await, `curry` is the function exported from common.js,
  // so completion / hover work on it.  We just reference it here to show
  // that the import resolved; the actual sum is plain addition.
  const { curry } = await import("./common");
  void curry;
  return x + y;
};


// -----------------------------------------------------------------------
// 5. for await ... of  (async iteration)
// -----------------------------------------------------------------------
// Annotating the parameter pins the element type so the loop variable
// (and any derived locals) get a precise type.

// Annotating an async function as `... -> X` is fine because the engine
// already knows the function is async; the parameter annotation pins the
// element type that flows into the loop variable.

// drainStrings :: Array (Promise e String) -> Void
const drainStrings = async (chunks) => {
  for await (const chunk of chunks) {
    // chunk has type String
    const upper = chunk;
  }
};

// drainNumbers :: Array (Promise e Number) -> Number
const drainNumbers = async (chunks) => {
  let total = 0;
  for await (const n of chunks) {
    total = total + n;          // n has type Number
  }
  return total;
};


// -----------------------------------------------------------------------
// 6. try / catch with a typed error parameter
// -----------------------------------------------------------------------
// The catch parameter is typed as `Error`, a record with `message`, `name`
// and `stack` — so the obvious property accesses succeed without manual
// annotations.

// ParseResult :: { ok :: Boolean, value :: String, error :: String }

// safeJsonParse :: String -> ParseResult
const safeJsonParse = (raw) => {
  try {
    const value = raw;            // pretend we parsed
    return { ok: true, value, error: "" };
  } catch (e) {
    // e has type Error  →  e.message has type String
    return { ok: false, value: "", error: e.message };
  } finally {
    // cleanup has type String
    const cleanup = "done";
  }
};


// -----------------------------------------------------------------------
// 7. Putting it together — a small async cache class
// -----------------------------------------------------------------------

// AsyncCache :: () -> AsyncCache
// AsyncCache.DEFAULT_TTL :: Number
class AsyncCache {
  #entries = {};
  static DEFAULT_TTL = 60;

  static {
    const banner = "AsyncCache initialised";
  }

  async get(key) {
    this.#entries[key] ??= key;
    return this.#entries[key];
  }

  async load(key) {
    try {
      // mod is the resolved namespace; mod.curry is fully typed
      const mod = await import("./common");
      return key;
    } catch (e) {
      return e.message;           // e has type Error
    }
  }
}

const cache = new AsyncCache();


// -----------------------------------------------------------------------
// 8. Row polymorphism — `{ field, ...rest }` destructuring
// -----------------------------------------------------------------------
// When a parameter pattern uses a rest element, the parameter's record
// type stays *open*: it carries a row variable that the caller's surplus
// fields flow into.  That row variable also propagates to the `rest`
// binding, so `rest` ends up with exactly the leftover fields.
//
// Hover over `drop` below to see something like
//   { x :: a, ...r } -> { ...r }
// and over `leftover` to see the spliced concrete record.

// drop :: { x :: a, ...r } -> { ...r }
const drop = ({ x, ...rest }) => rest;


// leftover :: { y :: String, z :: Boolean }
const leftover = drop({ x: 1, y: "two", z: true });

// `getX` ignores the rest, so it accepts records with *any* extra fields.

// getX :: { x :: a, ...r } -> a
const getX = ({ x, ...rest }) => x;

// xn :: Number
const xn = getX({ x: 7, name: "ignored", flag: true });


// -----------------------------------------------------------------------
// 9. typeof narrowing for `bigint` and `symbol` + BigInt literals
// -----------------------------------------------------------------------
// `typeof x === "bigint"` and `typeof x === "symbol"` now narrow the
// scrutinee to `BigInt` / `Symbol` respectively, just like the existing
// "number" / "string" / "boolean" branches.  BigInt literals (`42n`) are
// inferred directly as `BigInt`.

// big :: BigInt
const big = 42n;

// describe :: (Number | BigInt) -> String
const describe = (x) => {
  if (typeof x === "bigint") {
    // x is narrowed to BigInt here
    return "huge";
  }
  // x is narrowed to Number here
  return "ordinary";
};

// tag :: (String | Symbol) -> String
const tag = (s) => {
  if (typeof s === "symbol") {
    // s is narrowed to Symbol
    return "sym";
  }
  // s is narrowed to String
  return s;
};


// -----------------------------------------------------------------------
// 10. Label-polymorphic record functions: `[k]` field keys
// -----------------------------------------------------------------------
// A bracketed lowercase identifier inside a record type — `{ [k] :: a }`
// — names a *label* type variable.  Together with a row variable `...r`
// it expresses presence/absence row polymorphism: the function works for
// any record that *contains* the field named `k`, and `r` captures the
// remaining fields.  String literals passed as the label argument are
// promoted to label literals at the call site.

// omit :: (k, { [k] :: a, ...r }) -> { ...r }
//   ↳ remove a single field from a record, regardless of its name.
const omit = (k, obj) => {
  const out = {};
  for (const key in obj) if (key !== k) out[key] = obj[key];
  return out;
};

// `omit("x", ...)` : { y :: Number, z :: String }
const stripped = omit("x", { x: 1, y: 2, z: "hi" });

// pluck :: (k, { [k] :: a, ...r }) -> a
//   ↳ project a single field's value, polymorphic in both label and value.
const pluck = (k, obj) => obj[k];

const userName  = pluck("name", { name: "Ada", age: 36 });   // String
const userAge   = pluck("age",  { name: "Ada", age: 36 });   // Number
const isActive  = pluck("flag", { flag: true, count: 0 });   // Boolean

// rename :: (k1, k2, { [k1] :: a, ...r }) -> { [k2] :: a, ...r }
//   ↳ rename one field; the rest of the record (`r`) flows through.
const rename = (oldKey, newKey, obj) => {
  const out = { [newKey]: obj[oldKey] };
  for (const key in obj) if (key !== oldKey) out[key] = obj[key];
  return out;
};

// renamed: { id :: Number, name :: String }
const renamed = rename("uid", "id", { uid: 7, name: "Ada" });

// setField :: (k, a, { ...r }) -> { [k] :: a, ...r }
//   ↳ add (or overwrite) a field, returning an extended record.
const setField = (k, v, obj) => ({ ...obj, [k]: v });

const withEmail = setField("email", "ada@example.com", { name: "Ada" });

// -----------------------------------------------------------------------
// 11. Computed-key destructuring drives label-polymorphism inference
// -----------------------------------------------------------------------
// `const { [k]: value } = obj` constrains `obj` to `{ [k] :: a, ...r }` and
// binds `value :: a` — the inferred function signature is fully
// label-polymorphic without any explicit annotation.

// Inferred: (k, { [k] :: a, ...r }) -> a
const pluckD = (k, obj) => {
  const { [k]: value } = obj;
  return value;
};

const nameD = pluckD("name", { name: "Ada", age: 36 });   // String
const ageD  = pluckD("age",  { name: "Ada", age: 36 });   // Number

// Inferred: (k, { [k] :: a, ...r }) -> { ...r }
const omitD = (k, obj) => {
  const { [k]: _dropped, ...rest } = obj;
  return rest;
};

// strippedD :: { y :: Number, z :: String }
const strippedD = omitD("x", { x: 1, y: 2, z: "hi" });

// getTwo :: (k, i, { [k] :: a, [i] :: b, ...r }) -> { [k] :: a, [i] :: b }
const getTwo = (k, i, obj) => ({
  [k]: obj[k],
  [i]: obj[i]
})

const res = getTwo("name", "age", {})

// OPMERKING, wat met pluckDeep, of omitDeep ??