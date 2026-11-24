// Tests for newly-supported JavaScript syntax in the inference engine:
//   - Logical assignment operators (||=, &&=, ??=)
//   - Class fields (PropertyDefinition), incl. private (#field) and static
//   - Static initialization blocks (`static { ... }`)
//   - Dynamic import expressions (`import('./mod')`)
//   - Private member access (`obj.#field`)
//   - Catch clause parameter typed as Error record
//   - Optional `for await ... of` (already supported, smoke test)

import * as fs from 'fs';
import * as path from 'path';
import { InferenceEngine } from '../../src/index';
import { typeToString } from '../../src/hm/types';

const engine = new InferenceEngine();

// ---------------------------------------------------------------------------
// Logical assignment operators
// ---------------------------------------------------------------------------

describe('Logical assignment (||=, &&=, ??=)', () => {
  test('||= unifies same-type operands without diagnostics', () => {
    const r = engine.infer(`
      let x = "";
      x ||= "default";
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('||= reports diagnostic on type mismatch', () => {
    const r = engine.infer(`
      let s = "";
      s ||= 2;
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('||= reports diagnostic on member-expression type mismatch', () => {
    const r = engine.infer(`
      // Config :: { name :: String }
      // withDefaults :: Config -> Config
      const withDefaults = (config) => {
        config.name ||= 2;
        return config;
      };
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('??= accepts unrelated fallback types (Null LHS)', () => {
    const r = engine.infer(`
      let label = null;
      label ??= "fallback";
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('??= reports diagnostic when LHS is a concrete non-Null type', () => {
    const r = engine.infer(`
      let port = 8080;
      port ??= "oops";
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('??= reports diagnostic on member-expression type mismatch', () => {
    const r = engine.infer(`
      // Config :: { host :: String }
      // withDefaults :: Config -> Config
      const withDefaults = (config) => {
        config.host ??= 2;
        return config;
      };
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('??= on member-expression accepts matching fallback type', () => {
    const r = engine.infer(`
      // Config :: { host :: String }
      // withDefaults :: Config -> Config
      const withDefaults = (config) => {
        config.host ??= "localhost";
        return config;
      };
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('&&= unifies same-type operands without diagnostics', () => {
    const r = engine.infer(`
      let x = 1;
      x &&= 0;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('&&= reports diagnostic on type mismatch', () => {
    const r = engine.infer(`
      let n = 1;
      n &&= "oops";
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('plain compound = still unifies (regression: += keeps Number)', () => {
    const r = engine.infer(`
      let n = 1;
      n += 2;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Class fields (PropertyDefinition)
// ---------------------------------------------------------------------------

describe('Class fields (PropertyDefinition)', () => {
  test('instance field initialiser is type-checked', () => {
    const r = engine.infer(`
      class Counter {
        count = 0;
        label = "n";
      }
      const c = new Counter();
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('static field is registered and accessible via ClassName.field', () => {
    const r = engine.infer(`
      class Config {
        static VERSION = "1.0";
      }
      const v = Config.VERSION;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('annotated instance field unifies with initialiser', () => {
    const r = engine.infer(`
      // Box :: () -> Box
      // Box#size :: Box ~> Number
      class Box {
        size = 10;
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('class annotation as bare TCon (not a function type) produces diagnostic', () => {
    // `AsyncCache :: AsyncCache` is a common mistake — the class is a
    // constructor, so its annotation must be `() -> AsyncCache` (or with
    // args).  The engine should flag this explicitly.
    const r = engine.infer(`
      // AsyncCache :: AsyncCache
      class AsyncCache {
        size = 0;
      }
    `);
    const invalid = r.diagnostics.find(d =>
      d.message.startsWith("Invalid type annotation for class 'AsyncCache'"),
    );
    expect(invalid).toBeDefined();
    expect(invalid!.message).toContain("() -> AsyncCache");
  });

  test('class annotation as proper function type is accepted', () => {
    const r = engine.infer(`
      // AsyncCache :: () -> AsyncCache
      class AsyncCache {
        size = 0;
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('nullary variant class of a sumtype keeps its bare-TCon annotation', () => {
    // Convention: nullary variants of a registered sumtype may be
    // annotated with the parent type directly — e.g. `Nothing :: Maybe a`.
    // This must NOT be flagged as an invalid class annotation.
    const r = engine.infer(`
      // Maybe :: Just a | Nothing
      // Just :: a -> Maybe a
      // Nothing :: Maybe a
      class Just { constructor(value) { this.value = value; } }
      class Nothing {}
    `);
    const bogus = r.diagnostics.find(d =>
      d.message.startsWith("Invalid type annotation for class"),
    );
    expect(bogus).toBeUndefined();
  });

  test('private field initialisers are inferred', () => {
    const r = engine.infer(`
      class Cell {
        #value = 42;
        get() { return this.#value; }
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('field referring to other field via this', () => {
    const r = engine.infer(`
      class Pair {
        x = 1;
        y = 2;
        sum() { return this.x + this.y; }
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('class with only fields (no constructor) infers fine', () => {
    const r = engine.infer(`
      class Empty {
        a = 0;
      }
      const e = new Empty();
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Static initialization blocks
// ---------------------------------------------------------------------------

describe('Static initialization blocks', () => {
  test('static block body is inferred', () => {
    const r = engine.infer(`
      class Setup {
        static initialised = false;
        static {
          const x = 1 + 2;
        }
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('multiple static blocks supported', () => {
    const r = engine.infer(`
      class M {
        static {
          const a = "first";
        }
        static {
          const b = "second";
        }
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Private member access
// ---------------------------------------------------------------------------

describe('Private member access (#field)', () => {
  test('reading a private field via this.#field works', () => {
    const r = engine.infer(`
      class Stack {
        #items = [];
        peek() { return this.#items; }
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('private method definition does not crash inference', () => {
    const r = engine.infer(`
      class Worker {
        #helper(x) { return x; }
        run(v) { return this.#helper(v); }
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Class##field annotation pins the private field type', () => {
    // Annotation declares the private field as Array Number; the initialiser
    // is unified against it, and `this.#items` lookups inside the class get
    // the same type.
    const r = engine.infer(`
      // Stack :: () -> Stack
      // Stack##items :: Array Number
      class Stack {
        #items = [];
        push(x) { this.#items = [...this.#items, x]; return this.#items; }
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Class##field annotation rejects mismatching initialiser', () => {
    const r = engine.infer(`
      // Box :: () -> Box
      // Box##count :: Number
      class Box {
        #count = "oops";
      }
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('Class##method annotation pins the private method type', () => {
    const r = engine.infer(`
      // Calc :: () -> Calc
      // Calc##double :: Number -> Number
      class Calc {
        #double(x) { return x + x; }
        twice(n) { return this.#double(n); }
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Class##field annotation enforces type at private assignment site', () => {
    // Private-field assignment (`this.#history = ...`) must unify the LHS
    // (the annotated private type) with the RHS expression.
    const r = engine.infer(`
      // Counter :: () -> Counter
      // Counter##history :: Array String
      class Counter {
        #history = [];
        push() { this.#history = [...this.#history, 1]; }
      }
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some(d => /String|Number/.test(d.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Member assignment unification (regression)
// ---------------------------------------------------------------------------

describe('Member assignment unification', () => {
  test('record field assignment must unify with field type', () => {
    const r = engine.infer(`
      // withDefaults :: { name :: String } -> { name :: String }
      const withDefaults = (config) => {
        config.name = 42;
        return config;
      };
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Async function with Promise-returning annotation
// ---------------------------------------------------------------------------

describe('Async function annotated with Promise return', () => {
  test('inner async arrow returning T satisfies "... -> Promise T" annotation', () => {
    // Regression: when an outer annotation pins a curried function as
    // `Number -> Number -> Promise Number`, the inner async arrow's body
    // returns Number (not Promise Number) — the engine must peel the
    // Promise off the expected body type and re-wrap on the way out.
    const r = engine.infer(`
      // useCurry :: Number -> Number -> Promise e Number
      const useCurry = (x) => async (y) => x + y;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('plain async function with Promise annotation type-checks', () => {
    const r = engine.infer(`
      // greet :: String -> Promise e String
      const greet = async (name) => "hello " + name;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dynamic import expression
// ---------------------------------------------------------------------------

describe('Dynamic import (import())', () => {
  test('dynamic import returns Promise', () => {
    const r = engine.infer(`
      const p = import('./other');
    `);
    expect(r.diagnostics).toHaveLength(0);
    const pType = Array.from(r.nodeTypes.values())
      .map(v => typeToString(r.substitution.apply(v.type)))
      .find(s => s.startsWith('Promise'));
    expect(pType).toBeDefined();
  });

  test('await import() unwraps to the namespace placeholder', async () => {
    const r = engine.infer(`
      async function load() {
        const mod = await import('./x');
        return mod;
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('dynamic import with string literal resolves exports via importResolver', () => {
    const { mono, tFun, tVar } = require('../../src/hm/types');
    const a = tVar();
    const b = tVar();
    const curryScheme = mono(tFun(tFun(a, b), tFun(a, b)));
    const resolver = (spec: string) =>
      spec === './common' ? new Map([['curry', curryScheme]]) : null;
    const r = engine.infer(`
      const useIt = async () => {
        const mod = await import('./common');
        return mod.curry;
      };
    `, undefined, resolver);
    expect(r.diagnostics).toHaveLength(0);
    // After unwrapping the Promise, mod.curry should be visible — find a
    // node whose type stringifies to a function (not a free TVar).
    const fnTypes = Array.from(r.nodeTypes.values())
      .map(v => typeToString(r.substitution.apply(v.type)))
      .filter(s => s.includes('->'));
    expect(fnTypes.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Catch clause parameter typing
// ---------------------------------------------------------------------------

describe('Catch clause parameter typing', () => {
  test('catch param has .message accessible', () => {
    const r = engine.infer(`
      try {
        const x = 1;
      } catch (e) {
        const msg = e.message;
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('catch param has .name and .stack', () => {
    const r = engine.infer(`
      try { throw new Error("x"); } catch (e) {
        const n = e.name;
        const s = e.stack;
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('optional catch binding (no param) is supported', () => {
    const r = engine.infer(`
      try { const x = 1; } catch { const fallback = 0; }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// for-await-of (smoke test — was already supported)
// ---------------------------------------------------------------------------

describe('for await ... of', () => {
  test('for-await-of over Promise<Array<T>>', () => {
    const r = engine.infer(`
      async function run(items) {
        for await (const x of items) {
          const y = x;
        }
      }
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: sample/demo4.js exercises every feature above
// ---------------------------------------------------------------------------

describe('sample/demo4.js (modern JS syntax demo)', () => {
  test('infers cleanly with no diagnostics', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'sample', 'demo4.js'), 'utf8');
    const r = new InferenceEngine().infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });
});
