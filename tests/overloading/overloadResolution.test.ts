// Core overload-resolution semantics — how repeated `name :: ...` annotation
// lines merge into a union of function branches, and how the engine picks,
// validates, and propagates through the matching branch:
//
//   1. Sidecar overloads         — same name annotated twice in a package .hm
//      sidecar; each call site picks the matching branch.
//   2. Body validation (P3)      — the body of an overloaded function must
//      satisfy AT LEAST ONE branch.
//   3. Curried discrimination (P4) — overloads sharing leading parameters must
//      not greedily commit to the first branch.
//   4. Concrete TypeRep preferred — a concrete branch wins over a constrained
//      branch whose constraint the argument violates.
//   5. Substitution propagation  — the selected branch's unify() delta reaches
//      the result type (was discarded in tryInferOverloadedCall).
//   6. Duplicate detection (P3/P2) — alpha-aware duplicate signatures and
//      open-object synonyms are reported; genuinely distinct overloads not.
//   7. Constraint-var collision  — a constraint letter shared across branches
//      attaches only to its own branch's var (fl/compose.js).
//   8. Nested overload disambiguation — a later Contravariant argument selects
//      the container branch without leaking poison diagnostics.

import { diags, freshEngine, inferSource, InferenceEngine } from '../helpers/infer';
import { TempProject } from '../helpers/project';
import { schemeToString, prettyTypeToString } from '../../src/hm/types';
import type { Type } from '../../src/hm/types';

// ---------------------------------------------------------------------------
// From overloading.test.ts
// Tests for overloaded annotations — same name declared twice with different
// signatures. The engine should pick the matching branch at each call site.
// ---------------------------------------------------------------------------

describe('annotation overloading via repeated `Name :: ...` lines', () => {
  const project = new TempProject('overload-resolution-sidecar');

  beforeAll(() => project.setup());
  afterAll(() => project.cleanup());

  function setupModule(name: string, hmContent: string, jsContent = ''): void {
    project.write(`node_modules/${name}/package.json`,
      JSON.stringify({ name, main: 'index.js', 'hinmil': { sidecars: './types.hm' } }));
    project.write(`node_modules/${name}/index.js`, jsContent);
    project.write(`node_modules/${name}/types.hm`, hmContent);
  }

  function runInfer(jsSrc: string) {
    project.write('consumer.js', jsSrc);
    return project.inferSource('consumer.js', jsSrc);
  }

  test('two overloads, both shapes typecheck', () => {
    setupModule('overloaded-pkg', [
      'f :: Number -> String',
      'f :: String -> Number',
      '',
    ].join('\n'));

    const result = runInfer([
      'import { f } from "overloaded-pkg";',
      'export const a = f(42);      // expect String',
      'export const b = f("hello"); // expect Number',
    ].join('\n'));

    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('argument that matches no overload still produces a diagnostic', () => {
    setupModule('overloaded-pkg2', [
      'f :: Number -> String',
      'f :: String -> Number',
      '',
    ].join('\n'));

    const result = runInfer([
      'import { f } from "overloaded-pkg2";',
      'export const a = f(true); // matches neither',
    ].join('\n'));

    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test('Table-style: callable factory returning a callable', () => {
    setupModule('callable-pkg', [
      'Mk :: [a] -> Mk b',
      'Mk :: c -> Promise [d]',
      '',
    ].join('\n'));

    const result = runInfer([
      'import { Mk } from "callable-pkg";',
      'export const tag = Mk(["sel1", "sel2"]);   // first overload',
      'export const rows = Mk({ id: 1 });          // second overload',
    ].join('\n'));

    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// From overloadBodyNoMatch.test.ts
// Regression (P3): when a function carries an overloaded annotation (two or
// more `// f :: ...` signatures that merge into a Union of function branches),
// the body must satisfy AT LEAST ONE branch.  If it matches none, a diagnostic
// must be emitted; if it matches one, no diagnostic appears.
// ---------------------------------------------------------------------------

describe('overloaded annotation body validation (P3)', () => {
  test('body matching none of the overloads reports a diagnostic', () => {
    const src = `
// concat :: ([a], [b]) -> [a | b]
// concat :: (String, String) -> String
const concat = (x, y) => null;
`;
    expect(diags(src).some(m => m.includes('matches none of the'))).toBe(true);
  });

  test('body matching one overload produces no overload diagnostic', () => {
    const src = `
// combine :: (String, String) -> String
// combine :: (Number, Number) -> Number
const combine = (a, b) => a + b;
`;
    expect(diags(src).some(m => m.includes('matches none of the'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// From overloadCurriedDiscrimination.test.ts
// Regression for P4: a curried overloaded function whose overloads share the
// same leading parameter(s) must not greedily commit to the first branch and
// thereby reject a later, discriminating argument.
//
//   // reduce :: (b -> a -> b) -> b -> Array a -> b
//   // reduce :: (b -> a -> b) -> b -> { [k] :: a } -> b
//
// Both `reduce(f)(init)([...])` and `reduce(f)(init)({...})` must type-check;
// the record argument previously produced a spurious
// "Cannot unify '{ ... }' with '[Number]'".
// ---------------------------------------------------------------------------

describe('curried overload discrimination (P4)', () => {
  let engine: InferenceEngine;

  beforeEach(() => {
    engine = freshEngine();
  });

  const PRELUDE = `
// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }
// reducer :: f -> (b -> a -> b) -> b -> b
const reducer = foldable => fn => init => init;
// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b
// reduce :: (b -> a -> b) -> b -> Array a -> b
// reduce :: (b -> a -> b) -> b -> { [k] :: a } -> b
const reduce = fn => init => foldable => reducer (foldable) (fn) (init);
`;

  function typeAtToken(src: string, result: ReturnType<InferenceEngine['infer']>, token: string): string | null {
    const off = src.indexOf(token);
    if (off < 0) return null;
    let best: { type: Type; end?: number } | null = null;
    let bestStart = -1;
    for (const [start, entry] of result.nodeTypes.entries()) {
      const e = entry as { type: Type; end?: number };
      const end = e.end ?? start;
      if (start <= off && off < end && start > bestStart) { bestStart = start; best = e; }
    }
    return best ? prettyTypeToString(engine.subst.apply(best.type)) : null;
  }

  test('record argument does not produce a false [Number] unification error', () => {
    const src = PRELUDE + `const reducedObj = reduce(acc => value => value)(1)({ a: 1, b: 2 });`;
    expect(diags(src)).toHaveLength(0);
  });

  test('array argument still type-checks', () => {
    const src = PRELUDE + `const reducedArr = reduce(acc => value => value)(1)([1, 2]);`;
    expect(diags(src)).toHaveLength(0);
  });

  test('both array and record call sites coexist without diagnostics', () => {
    const src = PRELUDE +
      `const reducedArr = reduce(acc => value => value)(1)([1, 2]);\n` +
      `const reducedObj = reduce(acc => value => value)(1)({ a: 1, b: 2 });`;
    const result = engine.infer(src);
    expect(result.diagnostics.map(d => d.message)).toHaveLength(0);
    expect(typeAtToken(src, result, 'reducedArr')).toBe('Number');
    expect(typeAtToken(src, result, 'reducedObj')).toBe('Number');
  });
});

// ---------------------------------------------------------------------------
// From overloadConcreteTypeRepPreferred.test.ts
// Mirrors fpkit src/fl/id.js: `id` has two overloads — a Category-constrained
// one and a concrete `TypeRep Function` one — and is called `id(Function)('foo')`.
// The constrained branch must NOT be selected for `id(Function)` because
// `Function` does not satisfy `Category`; the concrete branch wins instead.
// ---------------------------------------------------------------------------

describe('overloaded TypeRep: concrete branch preferred over violating constraint (p2)', () => {
  const SRC = `"use strict";
// ::constraint Category c { c :: { id :: c, compose :: c -> c -> c } }
// id :: Category c => TypeRep c -> c
// id :: TypeRep Function -> a -> a
const id = (TR) => TR;

const r = id(Function)('foo');
`;

  test('`id(Function)` does not report a Category constraint violation', () => {
    const res = inferSource(SRC);
    const cat = res.diagnostics.filter((d: any) => /Category/.test(d.message));
    expect(cat.map((d: any) => d.message)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// From overloadSubstPropagation.test.ts
// ---------------------------------------------------------------------------

describe('overload-resolution: substitution propagation through union branches', () => {
  function inferAndGet(src: string, names: string[]): Record<string, string> {
    const r = inferSource(src);
    const out: Record<string, string> = {};
    out.__diagnostics__ = r.diagnostics.map(d => d.message).join('\n');
    for (const n of names) {
      const sch = r.topLevelBindings.get(n);
      if (sch) out[n] = schemeToString(sch);
    }
    return out;
  }

  test('selected branch propagates argument substitution into result type', () => {
    // Regression: previously the unify() delta was discarded inside
    // tryInferOverloadedCall's curried-branch loop, so the inner type
    // var `a` in `Limit (a -> Number)` was not substituted by the
    // matched argument's actual type.
    const out = inferAndGet(`
// Limit :: (a -> Number) -> Limit (a -> Number)
// Limit :: Number -> Limit Number
const Limit = (x) => x;

// getLimit :: { limit :: Number } -> Number
const getLimit = p => p.limit;

const a = Limit(5);
const b = Limit(getLimit);
`, ['a', 'b']);
    expect(out.a).toBe('Limit Number');
    expect(out.b).toBe('Limit ({ limit :: Number } -> Number)');
  });

  test('multi-arg tuple branch also propagates substitutions to result', () => {
    const out = inferAndGet(`
// pair :: (a, a) -> Pair a a
// pair :: (Number, String) -> Pair Number String
const pair = (x, y) => [x, y];

// getId :: { id :: Number } -> Number
const getId = p => p.id;

const p1 = pair(getId, getId);
`, ['p1']);
    // Branch 1 matches first because pair(getId, getId) has matching types.
    // a should resolve to ({ id :: Number } -> Number) since both args are getId.
    expect(out.p1).toBe('Pair ({ id :: Number } -> Number) ({ id :: Number } -> Number)');
  });

  test('curried multi-arg branch propagates substitutions through chain', () => {
    const out = inferAndGet(`
// app :: (a -> b) -> a -> b
// app :: Number -> Number -> Number
const app = (f, x) => f(x);

// double :: Number -> Number
const double = n => n + n;

const r = app(double, 5);
`, ['r']);
    // Both branches match; the first one returns Number when a=Number, b=Number.
    expect(out.r).toBe('Number');
  });
});

// ---------------------------------------------------------------------------
// From duplicateOverload.test.ts
// Coverage for the duplicate-overload diagnostic: writing the same overload
// signature twice (P3) should be reported, while genuinely distinct overloads
// must not be.  Equivalence is alpha (variable-renaming) aware.
// ---------------------------------------------------------------------------

{
  const dupDiags = (src: string): string[] =>
    diags(src).filter(m => /Duplicate overload signature/.test(m));

  describe('duplicate overload diagnostic (P3)', () => {
    test('exact duplicate signature is reported once', () => {
      const diags = dupDiags(`
// reduce :: (b -> a -> b) -> b -> [a] -> b
// reduce :: (b -> a -> b) -> b -> [a] -> b
const reduce = fn => init => arr => arr.reduce((acc, x) => fn(acc)(x), init);
`);
      expect(diags).toHaveLength(1);
      expect(diags[0]).toContain("Duplicate overload signature for 'reduce'");
      expect(diags[0]).toContain('(b -> a -> b) -> b -> [a] -> b');
    });

    test('alpha-renamed duplicate is reported', () => {
      const diags = dupDiags(`
// reduce :: (b -> a -> b) -> b -> [a] -> b
// reduce :: (y -> x -> y) -> y -> [x] -> y
const reduce = fn => init => arr => arr.reduce((acc, x) => fn(acc)(x), init);
`);
      expect(diags).toHaveLength(1);
    });

    test('distinct overloads are not reported', () => {
      const diags = dupDiags(`
// reduce :: (b -> a -> b) -> b -> [a] -> b
// reduce :: (b -> a -> b) -> b -> { [k] :: a } -> b
const reduce = fn => init => foldable => foldable;
`);
      expect(diags).toHaveLength(0);
    });

    test('three signatures with one exact duplicate flags only the duplicate', () => {
      const diags = dupDiags(`
// reduce :: (b -> a -> b) -> b -> [a] -> b
// reduce :: (b -> a -> b) -> b -> { [k] :: a } -> b
// reduce :: (b -> a -> b) -> b -> [a] -> b
const reduce = fn => init => foldable => foldable;
`);
      expect(diags).toHaveLength(1);
      expect(diags[0]).toContain('[a] -> b');
    });

    test('a single annotation is never a duplicate', () => {
      const diags = dupDiags(`
// id :: a -> a
const id = x => x;
`);
      expect(diags).toHaveLength(0);
    });
  });

  describe('open-object overload synonyms (P2)', () => {
    test('{ [k] :: a }, { a } and Object collapse to one overload key', () => {
      const diags = dupDiags(`
// reduce :: (b -> a -> b) -> b -> { [k] :: a } -> b
// reduce :: (b -> a -> b) -> b -> { a } -> b
// reduce :: (b -> a -> b) -> b -> Object -> b
const reduce = fn => init => foldable => init;
`);
      expect(diags).toHaveLength(2);
      expect(diags[0]).toContain('{ a }');
      expect(diags[1]).toContain('Object');
    });

    test('a concrete index value keeps overloads distinct', () => {
      const diags = dupDiags(`
// pick :: { [k] :: Number } -> Number
// pick :: { [k] :: String } -> Number
const pick = o => 1;
`);
      expect(diags).toHaveLength(0);
    });

    test('Array and Object stay distinct overloads', () => {
      const diags = dupDiags(`
// g :: Array a -> a
// g :: Object -> a
const g = x => x;
`);
      expect(diags).toHaveLength(0);
    });

    test('a concrete-field record is not collapsed into Object', () => {
      const diags = dupDiags(`
// h :: { x :: Number } -> Number
// h :: Object -> Number
const h = o => 1;
`);
      expect(diags).toHaveLength(0);
    });
  });
}

// ---------------------------------------------------------------------------
// From composeOverloadConstraintVarCollision.test.ts
// Regression for fpkit/src/fl/compose.js: an overloaded function whose two
// annotations independently use the SAME type-variable letter (`c`), where one
// branch attaches a class constraint to it and the other uses it as a plain
// output var:
//
//   // ::constraint Semigroupoid c { c :: { compose :: c i j ~> c j k -> c i k } }
//   // compose :: Semigroupoid c => c j k -> c i j -> c i k
//   // compose :: Function [b] c -> Function [a] b -> Function [a] c
//   const compose = f => g => x => f (g (x));
//
// `mergeOverloadSchemes` refreshes each branch's vars to DISTINCT ids but keeps
// the letter `c`.  Resolving the `Semigroupoid c` constraint by NAME at
// instantiation time collapsed both branches' `c` onto one fresh id (the
// Function branch's, processed last), so when the Function overload was selected
// and its output `c` bound to `Boolean`, the mis-attributed Semigroupoid
// constraint fired: "Type 'Boolean' does not satisfy constraint 'Semigroupoid'".
//
// The fix records a branch-specific `varId` on each merged constraint so the
// `Semigroupoid c` constraint attaches ONLY to its own branch's `c`.
// ---------------------------------------------------------------------------

describe('compose overload constraint-var collision (fl/compose.js)', () => {
  test('constraint var letter shared across overload branches does not fire spuriously', () => {
    const src = [
      '// ::constraint Semigroupoid c { c :: { compose :: c i j ~> c j k -> c i k } }',
      '// compose :: Semigroupoid c => c j k -> c i j -> c i k',
      '// compose :: Function [b] c -> Function [a] b -> Function [a] c',
      'const compose = f => g => x => f (g (x));',
      '',
      '// gt :: Number -> Number -> Boolean',
      'const gt = a => b => a > b;',
      '',
      '// fst :: g -> h',
      'const fst = p => p;',
      '',
      'const out = compose (gt (0)) (fst);',
    ].join('\n');

    const result = inferSource(src);
    const semigroupoidDiags = result.diagnostics.filter(d =>
      /Semigroupoid/.test(d.message),
    );
    expect(semigroupoidDiags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// From contramapNestedOverload.test.ts
// A nested application of an overloaded function where the SECOND argument (a
// Contravariant value) must disambiguate the outer call to the container
// overload rather than the plain-function overload.  Previously the outer call
// spuriously matched the `(a -> c) -> b -> c` function overload: pushing its
// function-shaped parameter down into the nested overloaded argument forced the
// inner overload resolution to fail, and the resulting poison type variable
// unified with anything — leaking a bogus "No overload matches" diagnostic.
// ---------------------------------------------------------------------------

describe('contramap nested overload disambiguation', () => {
  const SRC = `"use strict";
// ::constraint Contravariant f { f :: { contramap :: f a ~> (b -> a) -> f b } }

// contramap :: Contravariant f => (b -> a) -> f a -> f b
// contramap :: (a -> b) -> (b -> c) -> (a -> c)
const contramap = fn => contravariant => contravariant;

// equals :: a -> a -> Boolean
const equals = x => y => true;

// composition :: Contravariant f => f a -> (b -> a) -> (c -> b) -> Boolean
const composition = u => f => g => {
  const rhs = contramap (g) (contramap (f) (u));
  return equals (rhs) (rhs);
};
`;

  test('nested contramap disambiguates the outer overload via its Contravariant argument', () => {
    const ds = diags(SRC);
    expect(ds).toEqual([]);
  });
});

// README › Overloading: branches are tried in DECLARATION order.  The union of
// branches used to be sorted by rendered type, so a generic branch declared
// LAST (`a -> Free a`, renders "(a …") shadowed the specific first one
// (`Functor m => m a -> Free a`, renders "(m a …").  (fpkit Free.liftF.)
describe('overload branches are tried in declaration order', () => {
  const engine = freshEngine();
  test('specific first branch wins over a later generic branch', () => {
    const r = engine.infer(`
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// Box :: a -> Box a
function Box(v) { this.v = v; }
// Box#map :: Box a ~> (a -> b) -> Box b
Box.prototype.map = function (fn) { return new Box (fn (this.v)); };
// Free :: a -> Free a
function Free(v) { this.v = v; }
// liftF :: Functor m => m a -> Free a
// liftF :: a -> Free a
const liftF = x => new Free (x);
// boxed :: Free Number
const boxed = liftF (new Box (1));
// plain :: Free String
const plain = liftF ("a");
`);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('a later branch is used when the first does not fit', () => {
    const r = engine.infer(`
// f :: Number -> String
// f :: a -> Number
const f = x => x;
// s :: String
const s = f (1);
// n :: Number
const n = f ("x");
`);
    expect(r.diagnostics.filter(d => /Type mismatch: '[sn]'/.test(d.message))).toEqual([]);
  });
});
