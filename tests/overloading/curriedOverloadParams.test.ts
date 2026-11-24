// Curried-overload PARAMETER regressions (fpkit `map` / `ap.js` problem set):
//
//   1. Faithful fpkit repro — the callback parameter (`pair`) of an overloaded
//      curried `map` used to hover as a bare type variable (or the `$error`
//      sentinel) because the Phase-1 branch trials are rolled back; the fix
//      links callback parameter nodes to the surviving tails' element type.
//      Runs against the REAL fpkit checkout (skips when absent).
//   2. Self-contained repro — the same fix verified through a temp project
//      with an overloaded `map` and `reduce (stepper) (seed) (xs)` two-pass
//      resolution.
//   3. Parameter unions (`ap.js`) — the SECOND curried parameter of a curried
//      overloaded function must display as the union of its position across
//      every overload; the kind-variable constraint (`Apply f =>`) survives
//      into hovers; a parenless final overload behaves identically.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { wrapHmSource } from '../../src/services/files';
import {
  resetTypeVarCounter,
  typeToString,
  prettyTypeToString,
  Type,
} from '../../src/hm/types';
import { buildHover, buildScopeSeedType } from '../../src/services/hover';
import { freshEngine } from '../helpers/infer';
import { TempProject } from '../helpers/project';

// ---------------------------------------------------------------------------
// Regression for fpkit src/lst/take.js `stepper` callback parameter (`pair`).
//
//   const stepper = acc => x =>
//     map (pair => {           // <- hovering `pair`
//       let n = pair.fst;
//       let xs = pair.snd;
//       return Pair (n - 1) (appendOrNot (n) (xs) (x));
//     }) (acc);
//
// `map` is OVERLOADED in fpkit (`Functor f => (a -> b) -> f a -> f b` AND
// `(a -> b) -> { [k] :: a } -> { [k] :: b }`), so `map (pair => …) (acc)` is
// resolved through the ambiguous curried-overload union path in
// src/infer/calls.ts.  The Phase-1 branch trials are rolled back, so the
// callback parameter `pair` used to hover as a bare type variable `a`: each
// surviving overload tail referenced its own (now-unbound) element var and the
// later `(acc)` application pinned a DIFFERENT var.  The fix links the callback
// parameter node to the surviving tails' element type, so `pair` resolves to the
// annotated element `Pair Number (f a)`.
//
// This uses the REAL fpkit type environment (its globals + fl modules) because
// the two-pass ordering that triggered the orphaning depends on the full module
// graph; a self-contained harness resolves `pair` cleanly and does not reproduce
// it.  Runs on the fp-library fixture (tests/fixtures/scenarios/fp-library).
// ---------------------------------------------------------------------------

describe('fpkit take.js stepper callback param', () => {
  const FPKIT = path.join(__dirname, '..', 'fixtures', 'scenarios', 'fp-library');
  const takePath = `${FPKIT}/src/lst/take.js`;
  const globalsPath = `${FPKIT}/src/globals.js`;
  const jestHmPath = `${FPKIT}/src/jest.hm`;

  const available =
    fs.existsSync(takePath) && fs.existsSync(globalsPath) && fs.existsSync(jestHmPath);
  const maybe = available ? test : test.skip;

  maybe('`pair` reflects the annotation when present, else stays a free var (never nominally coerced)', () => {
    resetTypeVarCounter();
    const globalsSource =
      fs.readFileSync(globalsPath, 'utf-8') + '\n' + wrapHmSource(fs.readFileSync(jestHmPath, 'utf-8'));
    const source = fs.readFileSync(takePath, 'utf-8');
    const marker = 'map (pair =>';
    const markerIdx = source.indexOf(marker);
    if (markerIdx < 0) return; // take.js structure changed — nothing to assert.

    // The `stepper` binding may or may not carry its type signature comment
    // (the fpkit author toggles it).  When the signature IS present, the
    // callback parameter `pair` legitimately resolves to the annotated element
    // `Pair Number (f a)` — flowing from `acc :: Maybe (Pair Number (f a))`
    // through `map`, NOT from nominal coercion.  When it is ABSENT, `pair` is
    // unconstrained and must stay a free variable.  Either way, bare `.fst` /
    // `.snd` access must never NOMINALLY coerce the receiver to `Pair`.
    const hasSignature = /stepper\s*::[^\n]*\bPair\b/.test(source);

    const fileUri = pathToFileURL(takePath).href;
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(FPKIT, { globalsSource, globalsFilePath: globalsPath });
    const resolver = ctx.createImportResolver(fileUri);
    const typeResolver = ctx.createTypeDirectiveResolver(fileUri);
    const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
    const eng = new InferenceEngine();
    eng.globalsSource = globalsSource;
    const result = eng.infer(source, undefined, resolver, typeResolver, aliasResolver);

    const pairPos = markerIdx + 'map ('.length;
    const entry = result.nodeTypes.get(pairPos);
    const pairType = entry ? typeToString(result.substitution.apply(entry.type)) : '(none)';
    // `_` is how typeToString renders the `$error` poison sentinel.
    expect(pairType).not.toContain('_');

    if (hasSignature) {
      // Annotation present: `pair` is the annotated element, driven by the
      // signature through `map` — this is correct, not nominal coercion.
      expect(pairType).toMatch(/\bPair\b/);
      expect(pairType).toMatch(/Pair Number \(f a\)/);
    } else {
      // No annotation: accessing `pair.fst` / `pair.snd` must NOT nominally
      // coerce `pair` to `Pair` just because `Pair` is the sole registered
      // owner of those members — the receiver stays a free type variable.
      expect(pairType).not.toMatch(/\bPair\b/);
    }

    // The body-local bindings derive from the parameter.  Without a signature
    // they stay free (not coerced to `Pair`); with a signature they take their
    // annotated shapes (`n :: Number`, `xs :: f a`) — neither is `Pair`.
    const typeAt = (needle: string): string => {
      const idx = source.indexOf(needle);
      if (idx < 0) return '(none)';
      const e = result.nodeTypes.get(idx);
      return e ? typeToString(result.substitution.apply(e.type)) : '(none)';
    };
    expect(typeAt('n = pair.fst')).not.toMatch(/\bPair\b/);
    expect(typeAt('xs = pair.snd')).not.toMatch(/\bPair\b/);
  });

  // HOVER-level guard for the frozen-bare-var + shared-letter fixes.  The
  // overloaded-`map` callback parameter `pair` is captured in `frozenParamType`
  // as a BARE type variable (the overload's expected element var), which only
  // resolves to `Pair Number (f a)` after unification.  Rendering the raw
  // frozen snapshot used to show a meaningless `pair :: a`.  The server now
  // ignores frozen bare vars and keeps the live substitution-applied type.
  // `xs :: f a` (a sub-read of `pair`) must reuse the SAME letter `f` as `pair`
  // rather than being re-lettered to `b a` by the scope seed.
  maybe('hover renders `pair :: … Pair Number (f a)` and `xs :: … f a` (never `a` / `b a`)', () => {
    resetTypeVarCounter();
    const globalsSource =
      fs.readFileSync(globalsPath, 'utf-8') + '\n' + wrapHmSource(fs.readFileSync(jestHmPath, 'utf-8'));
    const source = fs.readFileSync(takePath, 'utf-8');
    if (source.indexOf('map (pair =>') < 0) return;
    // Only meaningful when the stepper signature is present.
    if (!/stepper\s*::[^\n]*\bPair\b/.test(source)) return;

    const fileUri = pathToFileURL(takePath).href;
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(FPKIT, { globalsSource, globalsFilePath: globalsPath });
    const eng = new InferenceEngine();
    eng.globalsSource = globalsSource;
    const result = eng.infer(
      source, undefined,
      ctx.createImportResolver(fileUri),
      ctx.createTypeDirectiveResolver(fileUri),
      ctx.createImportTypeAliasResolver(fileUri),
    );

    // Mirror the server's onHover bestType selection (frozen-bare-var rule).
    const hoverAt = (needle: string): string => {
      const offset = source.indexOf(needle);
      let bestStart = -1, bestEnd = -1;
      let bestType: Type | null = null;
      for (const [s, info] of result.nodeTypes) {
        if (s <= offset && offset < info.end && s > bestStart) {
          bestStart = s; bestEnd = info.end;
          bestType = result.substitution.apply(info.type);
        }
      }
      let bestFromFrozen = false;
      if (bestStart >= 0 && result.frozenParamType?.has(bestStart)) {
        const frozen = result.frozenParamType.get(bestStart)!;
        if (frozen.tag !== 'TVar') { bestType = frozen; bestFromFrozen = true; }
      }
      const scopeType = bestFromFrozen
        ? null
        : buildScopeSeedType(result, result.substitution, bestStart, bestEnd);
      const h = buildHover({
        source, offset, result, bestType, bestStart, bestEnd, scopeType, arrayShift: 0,
        inferredTypeStyle: 'pretty', uri: fileUri,
        resolveImportSpecifier: () => null,
        extractImportSpecifiers: () => new Map(),
      } as unknown as Parameters<typeof buildHover>[0]);
      return h ? (h.contents as { value: string }).value : '(none)';
    };

    const pairHover = hoverAt('pair =>');
    expect(pairHover).toMatch(/pair :: [^\n]*Pair Number \(f a\)/);
    expect(pairHover).not.toMatch(/pair :: a\b/);

    const xsHover = hoverAt('xs = pair.snd');
    expect(xsHover).toMatch(/xs :: [^\n]*\bf a\b/);
    expect(xsHover).not.toMatch(/xs :: [^\n]*\bb a\b/);
  });
});

// ---------------------------------------------------------------------------
// Self-contained repro of the same regression (fpkit take.js line 24).
//
// `map` is OVERLOADED (`Functor f => (a -> b) -> f a -> f b` and
// `(a -> b) -> { [k] :: a } -> { [k] :: b }`), so `map (pair => …) (acc)` goes
// through the ambiguous curried-overload union path in src/infer/calls.ts.  When
// `stepper` is ALSO used as the callback of `reduce (stepper) (seed) (xs)` the
// call is resolved in TWO passes.  The Phase-1 branch trials are rolled back, so
// the callback parameter `pair` used to hover as a bare type variable `a`.
// The fix links each provided callback's parameter nodes to the surviving tails'
// element type (a shared var when still free, or the concrete applied type once
// pinned), so `pair` now resolves to `Pair Number (f a)` — not a bare `a` and
// not the `$error` sentinel `_`.
// ---------------------------------------------------------------------------

describe('Curried overloaded map: callback param resolves to the functor element', () => {
  const GLOBALS = [
    '// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }',
    '// ::constraint Apply f { f :: Functor, f :: { ap :: f a ~> f (a -> b) -> f b } }',
    '// ::constraint Applicative f { f :: Apply, f :: { of :: a -> f a } }',
    '// ::constraint Semigroup s { s :: { concat :: s ~> s -> s } }',
    '// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }',
  ].join('\n');

  const project = new TempProject('curried-overload-callback');

  beforeAll(() => {
    project.setup();
    project.projectConfig = {
      globalsSource: GLOBALS,
      globalsFilePath: project.pathOf('globals.js'),
    };
    project.write('globals.js', GLOBALS);
    project.write(
      'map.js',
      [
        '"use strict";',
        '// map :: Functor f => (a -> b) -> f a -> f b',
        '// map :: (a -> b) -> { [k] :: a } -> { [k] :: b }',
        'const map = fn => functor => map (fn) (functor);',
        'module.exports = map;',
      ].join('\n'),
    );
    project.write(
      'reduce.js',
      [
        '"use strict";',
        '// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b',
        'const reduce = fn => seed => xs => reduce (fn) (seed) (xs);',
        'module.exports = reduce;',
      ].join('\n'),
    );
    project.write(
      'Pair.js',
      [
        '"use strict";',
        '// Pair :: a -> b -> Pair a b',
        'const Pair = a => b => Pair (a) (b);',
        'module.exports = Pair;',
      ].join('\n'),
    );
    project.write(
      'append.js',
      [
        '"use strict";',
        '// append :: Semigroup (f a) => a -> f a -> f a',
        'const append = x => xs => append (x) (xs);',
        'module.exports = append;',
      ].join('\n'),
    );
  });

  afterAll(() => project.cleanup());

  function inferCallbackParam(): { pairType: string; fnType: string; diags: string[] } {
    const src = [
      '"use strict";',
      'const map = require ("./map");',
      'const reduce = require ("./reduce");',
      'const Pair = require ("./Pair");',
      'const append = require ("./append");',
      '// stepper :: Maybe (Pair Number (f a)) -> a -> Maybe (Pair Number (f a))',
      'const stepper = acc => x =>',
      '  map (pair => {',
      '    let n = pair.fst;',
      '    let xs = pair.snd;',
      '    return Pair (n - 1) (append (x) (xs));',
      '  }) (acc);',
      '// run :: Maybe (Pair Number (f a)) -> f a -> Maybe (Pair Number (f a))',
      'const run = seed => xs => reduce (stepper) (seed) (xs);',
      'module.exports = run;',
    ].join('\n');
    project.write('stepper.js', src);
    const result = project.inferSource('stepper.js', src, eng => {
      eng.globalsSource = GLOBALS;
    });
    const pairPos = src.indexOf('map (pair =>') + 'map ('.length;
    const pairEntry = result.nodeTypes.get(pairPos);
    const pairType = pairEntry ? typeToString(result.substitution.apply(pairEntry.type)) : '(none)';
    const declPos = src.indexOf('stepper = ');
    const fnEntry = result.nodeTypes.get(declPos);
    const fnType = fnEntry ? typeToString(result.substitution.apply(fnEntry.type)) : '(none)';
    return { pairType, fnType, diags: result.diagnostics.map(d => d.message) };
  }

  test('pair resolves to the concrete Pair element type (not a bare var, not $error)', () => {
    const { pairType } = inferCallbackParam();
    // `_` is how typeToString renders the `$error` poison sentinel.
    expect(pairType).not.toContain('_');
    // Must be the concrete element `Pair Number (f a)` — a `Pair …`, NOT a bare
    // single-letter type variable.
    expect(pairType).toMatch(/^Pair\b/);
  });
});

// ---------------------------------------------------------------------------
// Regression coverage for the `ap.js` problem set (fpkit):
//   * `valArg` — the SECOND curried parameter of a curried overloaded function
//     — must display as the union of its position across every overload, just
//     like the first parameter `fnsArg` already did.
//   * The kind-variable constraint (`Apply f =>`) must survive into the
//     displayed parameter unions / hover.
//   * The last overload may be written with redundant parentheses removed
//     (`(a -> b -> c) -> (a -> b) -> a -> c`) and must be treated identically
//     to its fully-parenthesised form.
// ---------------------------------------------------------------------------

describe('curried overloaded parameters (ap.js)', () => {
  let engine: InferenceEngine;

  beforeEach(() => {
    engine = freshEngine();
  });

  /** Inferred (substituted) type string for the first occurrence of `token`. */
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
    const h = buildHover({
      source: src, offset, result: r, bestType, bestStart, arrayShift: 0,
      inferredTypeStyle: 'pretty', uri: 'file:///t.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
    } as Parameters<typeof buildHover>[0]);
    return h ? (h.contents as { value: string }).value : null;
  }

  const AP_PARENS = `"use strict";
const apFn = x => x;
// ap :: Apply f => f (a -> b) -> f a -> f b
// ap :: Array (a -> b) -> Array a -> Array b
// ap :: { [a] :: b -> c } -> { [a] :: b } -> { [a] :: c }
// ap :: (a -> b -> c) -> (a -> b) -> (a -> c)
const ap = fnsArg => valArg => {
  return apFn (valArg) (fnsArg);
};
`;

  const AP_NO_PARENS = `"use strict";
const apFn = x => x;
// ap :: Apply f => f (a -> b) -> f a -> f b
// ap :: Array (a -> b) -> Array a -> Array b
// ap :: { [a] :: b -> c } -> { [a] :: b } -> { [a] :: c }
// ap :: (a -> b -> c) -> (a -> b) -> a -> c
const ap = fnsArg => valArg => {
  return apFn (valArg) (fnsArg);
};
`;

  const APPLY_DEF =
    '// ::constraint Apply f { f :: Functor, f :: { ap :: f a ~> f (a -> b) -> f b } }\n';

  test('fnsArg displays the union of each overload first parameter', () => {
    const r = engine.infer(AP_PARENS);
    expect(typeAtToken(AP_PARENS, r, 'fnsArg')).toBe(
      '[a -> b] | { [a] :: b -> c } | (a -> b -> c) | f (a -> b)',
    );
  });

  test('valArg (the SECOND curried parameter) also displays a union', () => {
    const r = engine.infer(AP_PARENS);
    expect(typeAtToken(AP_PARENS, r, 'valArg')).toBe(
      '[a] | { [a] :: b } | (a -> b) | f a',
    );
  });

  test('the parenless final overload yields identical parameter unions', () => {
    const r = engine.infer(AP_NO_PARENS);
    expect(typeAtToken(AP_NO_PARENS, r, 'fnsArg')).toBe(
      '[a -> b] | { [a] :: b -> c } | (a -> b -> c) | f (a -> b)',
    );
    expect(typeAtToken(AP_NO_PARENS, r, 'valArg')).toBe(
      '[a] | { [a] :: b } | (a -> b) | f a',
    );
  });

  test('the kind-variable constraint (Apply f =>) shows in parameter hovers', () => {
    const src = APPLY_DEF + AP_PARENS;
    const off1 = src.indexOf('fnsArg =>') + 1;
    const h1 = hoverAt(src, off1)!;
    expect(h1).toContain('Apply f =>');
    expect(h1).toContain('f (a -> b)');

    // Re-infer fresh for the second parameter (hover mutates shared subst).
    resetTypeVarCounter();
    engine = new InferenceEngine();
    const off2 = src.indexOf('valArg =>') + 1;
    const h2 = hoverAt(src, off2)!;
    expect(h2).toContain('Apply f =>');
    expect(h2).toContain('f a');
  });

  test('the parenless overload form produces no diagnostics', () => {
    const src = APPLY_DEF + AP_NO_PARENS;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });
});
