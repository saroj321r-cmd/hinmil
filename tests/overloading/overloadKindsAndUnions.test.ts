// Kind variables & union interactions in overloads:
//
//   1. KINDS matrix           — signature help + selection across tuple
//      (non-curried), curried, MIXED, and arity-only-differing overload
//      shapes, locking down rendering and narrowing per shape.
//   2. Repeated kind-variable — a higher-kinded `$kv` var (`Alt f`) appearing
//      in more than one branch must keep its letter in display (alt.js).
//   3. Union label-var freshening — label vars in merged overload unions must
//      be freshened independently at every call site.
//   4. Union method preservation — identity-on-receiver methods keep the FULL
//      overload union across a module boundary (sqlkit-style).
//   5. Imported narrowing     — signature help narrows an imported curried
//      overload by an applied call-expression argument's RESULT type.

import { pathToFileURL } from 'url';
import { diags, freshEngine, inferSource, InferenceEngine } from '../helpers/infer';
import { TempProject } from '../helpers/project';
import { typeToString, prettyTypeToString } from '../../src/hm/types';
import type { Type } from '../../src/hm/types';
import { provideSignatureHelp } from '../../src/services/signatureHelp';
import { buildHover } from '../../src/services/hover';
import { instantiate } from '../../src/hm/env';

// ---------------------------------------------------------------------------
// From overloadKindsMatrix.test.ts
// Overload KINDS matrix: exercises signature help + selection for tuple
// (non-curried), curried, MIXED, and arity-only-differing overloads so the
// rendering and narrowing behaviour of each shape is locked down.
//
//  - tuple overloads          → comma-separated params, one paren frame
//  - curried overloads        → per-frame params, active advances with `)(`
//  - mixed tuple + curried    → every overload SHAPE stays visible (non-lossy)
//  - arity-only-differing      → both arities offered; wrong arity → diagnostic
// ---------------------------------------------------------------------------

describe('overload KINDS matrix (signature help + selection)', () => {
  let engine: InferenceEngine;

  beforeEach(() => {
    engine = freshEngine();
  });

  function help(src: string) {
    return provideSignatureHelp({
      source: src,
      offset: src.length,
      engine,
      resolver: () => null,
      typeResolver: () => null,
      reinferWithArrayASI: () => null,
    });
  }

  function labels(src: string): string[] {
    const h = help(src);
    return h ? h.signatures.map(s => s.label) : [];
  }

  // Tuple (non-curried) overloads
  describe('tuple (non-curried) overloads', () => {
    const SRC = [
      '// add :: (Number, Number) -> Number',
      '// add :: (String, String) -> String',
      'const add = (a, b) => a;',
      '',
    ].join('\n');

    test('a Number call narrows to the Number overload', () => {
      expect(labels(SRC + 'const x = add(1, 2')).toEqual(['add(Number, Number) -> Number']);
    });

    test('a String call narrows to the String overload', () => {
      expect(labels(SRC + 'const x = add("a", "b')).toEqual(['add(String, String) -> String']);
    });

    test('no arguments yet shows every overload', () => {
      expect(labels(SRC + 'const x = add(')).toEqual([
        'add(Number, Number) -> Number',
        'add(String, String) -> String',
      ]);
    });

    test('the active parameter follows the comma index', () => {
      const h = help(SRC + 'const x = add(1, ');
      expect(h!.activeParameter).toBe(1);
    });
  });

  // Curried overloads (selection + per-frame narrowing)
  describe('curried overloads', () => {
    const SRC = [
      '// at :: Number -> Array a -> a',
      '// at :: String -> { [k] :: a } -> a',
      'const at = k => coll => coll;',
      '',
    ].join('\n');

    test('each overload renders fully curried with both frames segmented', () => {
      expect(labels(SRC + 'const x = at(')).toEqual([
        'at(Number)([a]) -> a',
        'at(String)({ [k] :: a }) -> a',
      ]);
    });

    test('applying a Number key narrows to the Array overload and advances the frame', () => {
      const h = help(SRC + 'const x = at(1)(');
      expect(h!.signatures.map(s => s.label)).toEqual(['at(Number)([a]) -> a']);
      expect(h!.activeParameter).toBe(1);
    });

    test('applying a String key narrows to the record overload', () => {
      expect(labels(SRC + 'const x = at("k")(')).toEqual(['at(String)({ [k] :: a }) -> a']);
    });
  });

  // Mixed tuple + curried overloads — every overload SHAPE stays visible
  // (the partial-application fix makes this non-lossy: a chained call no longer
  // collapses to a bare remainder).
  describe('mixed tuple + curried overloads', () => {
    const SRC = [
      '// combine :: (Number, Number) -> Number',
      '// combine :: String -> String -> String',
      'const combine = (a, b) => a;',
      '',
    ].join('\n');

    test('a tuple-style call shows the tuple overload', () => {
      expect(labels(SRC + 'const x = combine(1, 2')).toEqual(['combine(Number, Number) -> Number']);
    });

    test('a chained curried call still surfaces BOTH overload shapes (non-lossy)', () => {
      const got = labels(SRC + 'const x = combine("a")(');
      // The curried overload must show ALL its parameters (not a bare remainder).
      expect(got).toContain('combine(String) -> String -> String');
      // The tuple overload shape is still listed.
      expect(got).toContain('combine(Number, Number) -> Number');
    });
  });

  // Arity-only-differing overloads
  describe('arity-only-differing overloads', () => {
    const SRC = [
      '// pick :: (a, b) -> a',
      '// pick :: (a, b, c) -> a',
      'const pick = (a, b) => a;',
      '',
    ].join('\n');

    test('a two-argument call offers the matching arity', () => {
      expect(labels(SRC + 'const x = pick(1, 2')).toContain('pick(Number, Number) -> Number');
    });

    test('a three-argument call offers the three-arity overload', () => {
      expect(labels(SRC + 'const x = pick(1, 2, 3')).toContain('pick(Number, Number, Number) -> Number');
    });

    test('too many arguments produces a no-overload-matches diagnostic', () => {
      const ds = diags(SRC + 'const x = pick(1, 2, 3, 4);');
      expect(ds.some(m => /No overload matches arguments/.test(m))).toBe(true);
    });
  });

  // Curried arity-only-differing overloads (per-frame narrowing by depth)
  describe('curried arity-only-differing overloads', () => {
    const SRC = [
      '// ap :: a -> b -> r',
      '// ap :: a -> b -> c -> r',
      'const ap = a => b => b;',
      '',
    ].join('\n');

    test('after one application both arities are still possible', () => {
      const got = labels(SRC + 'const x = ap(1)(');
      expect(got).toContain('ap(Number)(b) -> r');
      expect(got).toContain('ap(Number)(b)(c) -> r');
    });

    test('after two applications only the three-frame overload survives', () => {
      const h = help(SRC + 'const x = ap(1)(2)(');
      expect(h!.signatures.map(s => s.label)).toEqual(['ap(Number)(Number)(c) -> r']);
      expect(h!.activeParameter).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// From overloadRepeatedKindVar.test.ts
// Regression for fpkit/src/fl/alt.js: an overloaded, curried function whose
// kind-variable `f` (from `Alt f =>`) appears in MORE THAN ONE branch.
//
//   // alt :: Alt f => f a -> f a -> f a
//   // alt :: Array a -> Array a -> Array a
//   // alt :: Alt f => Function [a] (f a) -> Function [a] (f a) -> Function [a] (f a)
//   const alt = alt1 => alt2 => altFn (alt2) (alt1);
//
// `mergeOverloadSchemes` + `instantiateWithConstraints` give each branch's `f`
// a DISTINCT fresh id (`$kv:f:F1`, `$kv:f:F3`).  The display-canonicalizer used
// to collapse same-named ordinary vars but ignored higher-kinded (`$kv`) vars,
// so the second `f` was re-lettered to `b` — `alt2` showed
// `Alt f => [a] | (a -> f a) | b a` instead of `... | f a`.
// ---------------------------------------------------------------------------

describe('overload union with a repeated kind-variable (alt.js)', () => {
  let engine: InferenceEngine;

  beforeEach(() => {
    engine = freshEngine();
  });

  function typeAtToken(
    src: string,
    result: ReturnType<InferenceEngine['infer']>,
    token: string,
  ): string | null {
    const off = src.indexOf(token);
    if (off < 0) return null;
    let best: { type: Type } | null = null;
    let bestStart = -1;
    for (const [start, entry] of result.nodeTypes.entries()) {
      const end = (entry as { end?: number }).end ?? start;
      if (start <= off && off < end && start > bestStart) {
        bestStart = start;
        best = entry as { type: Type };
      }
    }
    return best ? prettyTypeToString(result.substitution.apply(best.type)) : null;
  }

  /** Mirror the server onHover flow, including the declaredSchemes override that
   *  renders a binding's generic scheme at its declaration site. */
  function hoverAt(src: string, offset: number): string | null {
    const r = engine.infer(src);
    let bestStart = -1;
    let bestType: Type | null = null;
    let rawBestType: Type | null = null;
    for (const [s, info] of r.nodeTypes) {
      const end = (info as { end: number }).end;
      if (s <= offset && offset < end && s > bestStart) {
        bestStart = s;
        bestType = r.substitution.apply((info as { type: Type }).type);
        rawBestType = (info as { type: Type }).type;
      }
    }
    if (bestStart >= 0 && r.declaredSchemes?.has(bestStart)) {
      const generic = instantiate(r.declaredSchemes.get(bestStart)!);
      bestType = generic;
      rawBestType = generic;
    }
    const h = buildHover({
      source: src, offset, result: r, bestType, rawBestType, bestStart, arrayShift: 0,
      inferredTypeStyle: 'pretty', uri: 'file:///t.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
    } as Parameters<typeof buildHover>[0]);
    return h ? (h.contents as { value: string }).value : null;
  }

  const ALT_DEF =
    '// ::constraint Alt f { f :: { alt :: f a ~> f a -> f a } }\n';

  const ALT_SRC = `"use strict";
const altFn = x => x;
// alt :: Alt f => f a -> f a -> f a
// alt :: Array a -> Array a -> Array a
// alt :: Alt f => Function [a] (f a) -> Function [a] (f a) -> Function [a] (f a)
const alt = alt1 => alt2 =>
  altFn (alt2) (alt1);
`;

  test('alt2 renders the repeated `f` as `f a`, never `b a`', () => {
    const src = ALT_DEF + ALT_SRC;
    const r = engine.infer(src);
    const t = typeAtToken(src, r, 'alt2');
    expect(t).toContain('f a');
    expect(t).not.toContain('b a');
  });

  test('alt2 hover keeps the `Alt f =>` prefix and shows `f a`', () => {
    const src = ALT_DEF + ALT_SRC;
    const off = src.indexOf('alt2 =>') + 1;
    const h = hoverAt(src, off)!;
    expect(h).toContain('Alt f =>');
    expect(h).toContain('f a');
    expect(h).not.toContain('b a');
  });

  test('hovering the binding name `alt` shows `f a` in both f-branches, not `b a`', () => {
    const src = ALT_DEF + ALT_SRC;
    const off = src.indexOf('const alt =') + 'const '.length;
    const h = hoverAt(src, off)!;
    expect(h).not.toContain('b a');
  });
});

// ---------------------------------------------------------------------------
// From overloadUnionLabelFreshening.test.ts
// Regression: overloaded (multi-annotation) functions whose FIRST parameter is
// a label variable must freshen that label var independently at every call
// site.
//
// `mergeOverloadSchemes` combines each `// name :: ...` line into a single
// `Union` scheme.  Its `refresh` step re-quantified every bound id as a plain
// `tVar`.  Mapping a label-var id to a `tVar` is a no-op in
// `Substitution.apply` (it defensively keeps the original TLabel node), so the
// original label-var id survived UNQUANTIFIED — free in the union and therefore
// shared across every instantiation.  The first call pinned it to its literal
// key; the second call's differing key then failed to unify, surfacing a
// spurious "No overload matches arguments (String)" diagnostic.
//
// The fix refreshes label-var / row-var ids in their own disjoint sort so each
// call site gets an independent label key.
// ---------------------------------------------------------------------------

describe('overload-union label-var freshening', () => {
  const PROP_OVERLOADS = [
    '// prop :: k1 -> { [k1] :: a } -> Maybe a',
    '// prop :: [k1] -> { [k1] :: a } -> Maybe a',
    '// prop :: [k1, k2] -> { [k1] :: { [k2] :: a } } -> Maybe a',
  ].join('\n');

  test('two call sites with DIFFERENT keys both resolve overload 1', () => {
    const src = [
      PROP_OVERLOADS,
      '// ::types Maybe a = Nothing | Just a',
      'const prop = key => obj => obj',
      'const a = prop("firstName")',
      'const b = prop("lastName")',
    ].join('\n');
    const r = inferSource(src);
    const overloadDiags = r.diagnostics.filter(d => /No overload matches/.test(d.message));
    expect(overloadDiags).toHaveLength(0);
    const a = r.topLevelBindings.get('a');
    const b = r.topLevelBindings.get('b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Each call site specialises the label key independently — no leak.
    expect(typeToString(a!.type)).toContain('firstName ::');
    expect(typeToString(b!.type)).toContain('lastName ::');
    expect(typeToString(b!.type)).not.toContain('firstName ::');
  });

  test('same key twice is unaffected', () => {
    const src = [
      PROP_OVERLOADS,
      '// ::types Maybe a = Nothing | Just a',
      'const prop = key => obj => obj',
      'const a = prop("firstName")',
      'const b = prop("firstName")',
    ].join('\n');
    const r = inferSource(src);
    const overloadDiags = r.diagnostics.filter(d => /No overload matches/.test(d.message));
    expect(overloadDiags).toHaveLength(0);
    const b = r.topLevelBindings.get('b');
    expect(typeToString(b!.type)).toContain('firstName ::');
  });
});

// ---------------------------------------------------------------------------
// From overloadUnionMethodPreserve.test.ts
// Regression: a multi-file scenario in which the consumer imports a
// `default`-exported value built by chaining an identity-on-receiver
// method (e.g. `Table#addProps`) on an overloaded-constructor union.
//
// Original symptom (from a sqlkit-using project): the consumer surfaced a
// misleading "'EmployeeRow' is not a valid relation here" diagnostic.
// Two compounding bugs were responsible:
//
//  1. `inferUnionPropertyAccess` flagged identity-on-receiver method
//     access (`addProps`) on the `{props ...}` metadata branch as a
//     "Property does not exist on type" error.  The exception caused
//     `User` in `model.js` to fall back to a single matched member
//     (`Table UserRow`), discarding the per-table selector overload.
//
//  2. `ImportInferenceContext.inferFileAndCacheExports` did not pass
//     the alias resolver to nested per-file inference, so the imported
//     module had no access to the project's globals/sidecar aliases.
//     Combined with (1) this collapsed the cross-file imported `User`
//     to a fresh tvar, allowing arbitrary calls to type-check while
//     side-arguments unified against an unrelated relation's selector
//     (here: `Caregiver`'s).
//
// Both fixes are required to keep the consumer diagnostic-free.
// ---------------------------------------------------------------------------

describe('overload-union method preservation across module boundary', () => {
  const project = new TempProject('overload-union-method-preserve');

  beforeAll(() => {
    project.setup();

    // Minimal sqlkit-style sidecar for a `dbpkg` package.
    project.write('node_modules/dbpkg/package.json', JSON.stringify({
      name: 'dbpkg',
      main: 'build/index.js',
      'hinmil': { sidecars: ['./dbpkg.hm'] },
    }));
    project.write('node_modules/dbpkg/build/index.js', 'exports.x = 1;');
    project.write('node_modules/dbpkg/dbpkg.hm', [
      'QueryTag :: p -> a -> QueryTag p a',
      'Picked :: r -> a -> Picked r a',
      'Table  :: a -> Table a',
      'Prop   :: t -> a -> Prop t a',

      'CaregiverTag :: () -> CaregiverTag',
      'EmployeeTag  :: () -> EmployeeTag',
      'UserTag      :: () -> UserTag',

      'CaregiverRow :: { id :: Number }',
      'EmployeeRow  :: { id :: Number }',
      'UserRow      :: { id :: Number }',

      // Selector unions (the per-table allowed argument set).
      'CaregiverSelector :: ("id" | Prop CaregiverTag a | Table UserRow | QueryTag p (Picked UserRow a))',
      'EmployeeSelector  :: ("id" | Prop EmployeeTag a)',
      'UserSelector      :: ("id" | Prop UserTag a | Table CaregiverRow | QueryTag p (Picked CaregiverRow a) | Table EmployeeRow | QueryTag p (Picked EmployeeRow a))',

      // Constructor-callable overloads — both Table form and selector form.
      'User      :: Table UserRow',
      'User      :: [UserSelector] -> QueryTag p (Picked UserRow UserSelector)',
      'Caregiver :: Table CaregiverRow',
      'Caregiver :: [CaregiverSelector] -> QueryTag p (Picked CaregiverRow CaregiverSelector)',
      'Employee  :: Table EmployeeRow',
      'Employee  :: [EmployeeSelector] -> QueryTag p (Picked EmployeeRow EmployeeSelector)',

      // Identity-on-receiver method whose return type structurally equals
      // the receiver (`Table p ~> [a] -> Table p`).  This is the shape that
      // exposed bug (1).
      'Table#addProps :: Table p ~> [a] -> Table p',

      // tables namespace, mirroring the project's `db.js` export.
      'tables :: { organisation :: { User :: User, Caregiver :: Caregiver, Employee :: Employee } }',
      '',
    ].join('\n'));

    // model.js: chain `addProps` on the overloaded-constructor union and
    // re-export.  The default export must preserve the FULL overload union.
    project.write('src/models/user/model.js', [
      'import { tables } from "dbpkg";',
      'const User = tables.organisation.User.addProps([1, 2]);',
      'export default User;',
      '',
    ].join('\n'));

    // repo.js: import `User` and call it as the selector overload.
    project.write('src/models/organisation/repo.js', [
      'import User from "../user/model";',
      'import { tables } from "dbpkg";',
      'const { Caregiver, Employee } = tables.organisation;',
      'export const q = User([Caregiver, Employee]);',
      '',
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  it('produces no "not a valid relation" / unification diagnostics on the consumer', () => {
    const result = project.inferFile('src/models/organisation/repo.js');
    const offending = result.diagnostics.filter(d =>
      / is not a valid relation here\b/.test(d.message) ||
      /Cannot unify/.test(d.message) ||
      /Property 'addProps' does not exist/.test(d.message),
    );
    if (offending.length > 0) {
      // eslint-disable-next-line no-console
      console.log('unexpected diagnostics:', offending.map(d => `${d.start}-${d.end}: ${d.message}`));
    }
    expect(offending).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// From overloadImportedNarrowing.test.ts
// Regression: signature help for a CURRIED, OVERLOADED function imported across
// files must narrow the overload menu by an applied call-expression argument.
//
// `equals` is annotated with 6 overloads (a polymorphic `Setoid a` branch plus
// five concrete `X -> X -> Boolean` branches).  When the consumer writes
// `equals(Left("2"))(`, the applied argument is a CALL EXPRESSION whose RESULT
// type is `Either String _` — not the callee `Left`'s constructor function
// type.  Previously the signature-help arg collector resolved the argument to
// the callee identifier's type (because the CallExpression shares its start
// offset with the `Left` identifier and is dropped from `nodeTypes`, keyed by
// start), so the concrete branches were never rejected and all 6 overloads
// lingered.  Consulting `nodeTypesByEnd` recovers the call RESULT type, so only
// the polymorphic `Setoid a` branch survives.
// ---------------------------------------------------------------------------

describe('imported curried overload narrowing by applied call-expression argument', () => {
  const project = new TempProject('overload-imported-narrowing');

  beforeAll(() => {
    project.setup();
    project.write('src/fl/equals.js', [
      '"use strict";',
      '// equals :: Setoid a => a -> a -> Boolean',
      '// equals :: Null -> Null -> Boolean',
      '// equals :: Undefined -> Undefined -> Boolean',
      '// equals :: Number -> Number -> Boolean',
      '// equals :: String -> String -> Boolean',
      '// equals :: Boolean -> Boolean -> Boolean',
      '// ::ignore-function',
      'const equals = v1 => v2 => v1 === v2;',
      'module.exports = equals;',
      '',
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  function signatureHelpFor(consumer: string, offset: number) {
    const consumerPath = project.write('src/Either/index.js', consumer);
    const fileUri = pathToFileURL(consumerPath).href;
    const ctx = project.createContext();
    return provideSignatureHelp({
      source: consumer,
      offset,
      engine: new InferenceEngine(),
      resolver: ctx.createImportResolver(fileUri),
      typeResolver: ctx.createTypeDirectiveResolver(fileUri),
      importTypeAliasResolver: ctx.createImportTypeAliasResolver(fileUri),
      reinferWithArrayASI: () => null,
    });
  }

  const PRELUDE = [
    '"use strict";',
    'const equals = require("../fl/equals");',
    '// Left :: e -> Either e a',
    'function Left(value) { this.value = value; }',
  ];

  test('equals(Left("2"))( narrows to the single Setoid/Either branch', () => {
    const consumer = [...PRELUDE, 'const eq = equals(Left("2"))('].join('\n');
    const help = signatureHelpFor(consumer, consumer.length);
    expect(help).not.toBeNull();
    expect(help!.signatures.map(s => s.label)).toEqual([
      'equals(Either String a)(Either String a) -> Boolean',
    ]);
    expect(help!.activeParameter).toBe(1);
  });

  test('cursor inside the trailing empty parens narrows identically', () => {
    const consumer = [...PRELUDE, 'const eq = equals(Left("2"))()'].join('\n');
    // Offset between the final '(' and ')'.
    const help = signatureHelpFor(consumer, consumer.length - 1);
    expect(help).not.toBeNull();
    expect(help!.signatures.map(s => s.label)).toEqual([
      'equals(Either String a)(Either String a) -> Boolean',
    ]);
    expect(help!.activeParameter).toBe(1);
  });

  test('primitive arguments still narrow to their concrete branch', () => {
    const boolConsumer = [...PRELUDE, 'const eq = equals(true)('].join('\n');
    const boolHelp = signatureHelpFor(boolConsumer, boolConsumer.length);
    expect(boolHelp!.signatures.map(s => s.label)).toEqual([
      'equals(Boolean)(Boolean) -> Boolean',
    ]);

    const numConsumer = [...PRELUDE, 'const eq = equals(1)('].join('\n');
    const numHelp = signatureHelpFor(numConsumer, numConsumer.length);
    expect(numHelp!.signatures.map(s => s.label)).toEqual([
      'equals(Number)(Number) -> Boolean',
    ]);
  });
});
