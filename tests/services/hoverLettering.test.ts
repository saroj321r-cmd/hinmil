// Hover display-letter assignment consistency.
//
// Consolidated from six regression suites, all exercising how the hover
// pretty-printer assigns type-variable letters:
//   1. applicativeHomomorphismHoverLetters — `of (A) (f)` inside an annotated
//      law reuses the law's letters (display TVar aligned onto a body kv head).
//   2. functorCompositionHoverLetters — map's PARAMETRIC result variable shares
//      the enclosing function's letter (recorded scope type aligned onto body
//      instantiation ids).
//   3. frozenParamSignatureLetters — the SIGNATURE always wins over body
//      inference for parameter hover; frozen params keep signature letters.
//   4. hoverScopeConsistentLetters — hover letters are seeded from the
//      enclosing function type so variables shared across bindings render
//      consistently within a scope.
//   5. hoverSiblingBindingLetters — scope seeding is SHARE-GATED: an unrelated
//      sibling binding no longer bumps a self-contained hovered type's letters.
//   6. scopeSeedShareGatedLettering — `monoidLaws (Maybe)` renders its sole
//      witness variable `a` even next to an unrelated sibling binding.

import { freshEngine, InferenceEngine } from '../helpers/infer';
import { Type } from '../../src/hm/types';
import { scrubSkolems } from '../../src/hm/typeUtils';
import { buildHover, buildScopeSeedType } from '../../src/services/hover';

let engine: InferenceEngine;

beforeEach(() => {
  engine = freshEngine();
});

// Shared by sections 1 and 2 (the two originals defined identical copies).
// Mirror the server's onHover: pick the smallest node covering the offset, then
// seed pretty-printing from the smallest strictly-enclosing function-typed node.
function hoverAtWithScope(src: string, offset: number): string | null {
  const r = engine.infer(src);
  let bestStart = -1, bestEnd = -1, bestType: Type | null = null, rawBestType: Type | null = null;
  for (const [s, info] of r.nodeTypes) {
    const end = (info as { end: number }).end;
    if (s <= offset && offset < end && s > bestStart) {
      bestStart = s; bestEnd = end;
      bestType = r.substitution.apply((info as { type: Type }).type);
      rawBestType = (info as { type: Type }).type;
    }
  }
  let scopeType: Type | undefined;
  let scopeSpan = Infinity;
  for (const [s, info] of r.nodeTypes) {
    const end = (info as { end: number }).end;
    if ((s < bestStart || end > bestEnd) && s <= bestStart && end >= bestEnd) {
      const t = r.substitution.apply((info as { type: Type }).type);
      if (t.tag === 'TFun' && (end - s) < scopeSpan) { scopeSpan = end - s; scopeType = t; }
    }
  }
  const h = buildHover({
    source: src, offset, result: r, bestType, rawBestType, bestStart, arrayShift: 0,
    inferredTypeStyle: 'pretty', uri: 'file:///t.js', scopeType,
    resolveImportSpecifier: () => null,
    extractImportSpecifiers: () => new Map(),
  } as Parameters<typeof buildHover>[0]);
  return h ? (h.contents as { value: string }).value : null;
}

// ---------------------------------------------------------------------------
// 1. applicativeHomomorphismHoverLetters
// ---------------------------------------------------------------------------
// Regression for fpkit src/test/laws/Applicative.js + src/fl/of.js.
//
//   // of :: Applicative f => TypeRep f -> a -> f a
//   // homomorphism :: Applicative f => TypeRep f -> (a -> b) -> a -> Boolean
//   const homomorphism = A => f => x => {
//     const applie = of (A) (f);   // :: Applicative f => f (a -> b)
//   };
//
// `applie`'s type genuinely uses the enclosing law's BODY instantiation ids:
// `of`'s TypeRep pins its applicative var to the law's `f`, and its value slot
// to the param `f :: (a -> b)`.  So `applie :: f (a -> b)` reusing the law's
// `f`, `a`, `b` — NOT fresh `c (d -> e)`.
//
// Regression: the law is annotated `Applicative f => …` where `f` appears as a
// bare TVar inside `TypeRep f`, but body inference specializes it to a
// higher-kinded kv head (`$kv:f`) because `of` uses it as `f a`.  The display
// instance still has `f` as a bare TVar, so `alignDisplayVarIds` used to abort
// on the TVar-vs-kvTCon tag mismatch, leaving the recorded scope type on fresh
// display ids → `applie` rendered `Applicative c => c (d -> e)`.  The alignment
// now maps a display TVar onto a body kv head so the scope type adopts the body
// identity and the inner binding shares the law's letters.

{
  const SRC = `"use strict";
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Apply f { f :: Functor, f :: { ap :: f a ~> f (a -> b) -> f b } }
// ::constraint Applicative f { f :: Apply, f :: { of :: a -> f a } }
// of :: Applicative f => TypeRep f -> a -> f a
const of = A => x => x;
// homomorphism :: Applicative f => TypeRep f -> (a -> b) -> a -> Boolean
const homomorphism = A => f => x => {
  const applie = of (A) (f);
};
`;

  describe('Applicative homomorphism: of(A)(f) reuses the law\u2019s letters', () => {
    test('applie hovers as Applicative f => f (a -> b), not Applicative c => c (d -> e)', () => {
      const off = SRC.indexOf('applie = of') + 1;
      const h = hoverAtWithScope(SRC, off)!;
      expect(h).toContain('applie :: Applicative f => f (a -> b)');
      expect(h).not.toMatch(/applie :: Applicative c/);
    });

    test('the constraint is Applicative (of requires it), never weakened to Apply', () => {
      const off = SRC.indexOf('applie = of') + 1;
      const h = hoverAtWithScope(SRC, off)!;
      expect(h).toContain('Applicative f =>');
      expect(h).not.toMatch(/applie :: Apply /);
    });
  });
}

// ---------------------------------------------------------------------------
// 2. functorCompositionHoverLetters
// ---------------------------------------------------------------------------
// Regression for fpkit src/test/laws/Functor.js + src/fl/map.js.
//
//   // map :: Functor f => (a -> b) -> f a -> f b
//   // composition :: Functor f => f a -> (a -> b) -> (b -> c) -> Boolean
//   const composition = u => f => g => {
//     const noVal = map (f) (u);              // :: f b   (f's codomain)
//     const lhs  = map (x => g (f (x))) (u); // :: f c
//     const rhs  = map (g) (map (f) (u));    // :: f c
//     ...
//   };
//
// `map`'s result variable `b` is PARAMETRIC — it occurs in map's `(a -> b)`
// parameter, so it flows in from the argument `f` and is the enclosing
// function's own `b`/`c`.  Under scope seeding the inner binding must therefore
// render with the SAME letter as the enclosing scope (`f b` / `f c`), not a
// fresh next-free letter (`f d`).  Regression: the enclosing annotated function
// is instantiated twice (body vs display) with divergent ids; the recorded scope
// type must be aligned onto the body ids so the shared (parametric) variable
// lines up.

{
  const SRC = `"use strict";
// map :: Functor f => (a -> b) -> f a -> f b
const map = fn => functor => functor;
// equals :: a -> a -> Boolean
const equals = x => y => true;
// composition :: Functor f => f a -> (a -> b) -> (b -> c) -> Boolean
const composition = u => f => g => {
  const noVal = map (f) (u);
  const lhs = map (x => g (f (x))) (u);
  const rhs = map (g) (map (f) (u));
  return equals (rhs) (lhs);
};
`;

  describe('Functor composition: parametric result var shares the enclosing letter', () => {
    test('noVal = map(f)(u) hovers as f b (f\u2019s codomain), not f d', () => {
      const off = SRC.indexOf('noVal = map') + 1;
      const h = hoverAtWithScope(SRC, off)!;
      expect(h).toContain('noVal :: f b');
    });

    test('lhs = map(x => g(f(x)))(u) hovers as f c', () => {
      const off = SRC.indexOf('lhs = map') + 1;
      const h = hoverAtWithScope(SRC, off)!;
      expect(h).toContain('lhs :: f c');
    });

    test('rhs = map(g)(map(f)(u)) hovers as f c', () => {
      const off = SRC.indexOf('rhs = map') + 1;
      const h = hoverAtWithScope(SRC, off)!;
      expect(h).toContain('rhs :: f c');
    });
  });
}

// ---------------------------------------------------------------------------
// 3. frozenParamSignatureLetters
// ---------------------------------------------------------------------------
// Rule #1: the SIGNATURE always wins over body inference for parameter hover.
//
// Regression for fpkit/src/fl/alt.js: a member-assignment method annotation
// (`natives.Array :: Array a ~> ...`) freezes the parameter's declared type,
// but the hover pipeline used to re-letter that frozen signature type by
// seeding the pretty-printer from the enclosing function scope — so `other`
// (declared `Array a` / `Object k a`) showed `[b]` / `Object b c` instead of
// the signature's own letters.  With the fix, a frozen parameter renders with
// its signature letters AND through the Object/Function display sugar.

{
  /** Mirror server.ts onHover, including the frozen-parameter override and the
   *  scopeType-seeding SKIP when the type comes from a frozen signature. */
  function hoverAt(source: string, offset: number): string | null {
    const r = engine.infer(source);
    let bestStart = -1, bestEnd = -1;
    let bestType: Type | null = null;
    let rawBestType: Type | null = null;
    for (const [s, info] of r.nodeTypes) {
      const end = (info as { end: number }).end;
      if (s <= offset && offset < end && s > bestStart) {
        bestStart = s; bestEnd = end;
        bestType = r.substitution.apply((info as { type: Type }).type);
        rawBestType = (info as { type: Type }).type;
      }
    }
    let bestFromFrozen = false;
    if (bestStart >= 0 && r.frozenParamType?.has(bestStart)) {
      const frozen = r.frozenParamType.get(bestStart)!;
      bestType = frozen;
      rawBestType = frozen;
      bestFromFrozen = true;
    }
    if (bestType && r.skolemDisplayNames && r.skolemDisplayNames.size > 0) {
      bestType = scrubSkolems(bestType, r.skolemDisplayNames);
    }
    let scopeType: Type | null = null;
    if (!bestFromFrozen && bestType && bestStart >= 0 && bestEnd >= 0) {
      let span = Infinity;
      for (const [s, info] of r.nodeTypes) {
        const end = (info as { end: number }).end;
        if (s <= bestStart && end >= bestEnd && (s < bestStart || end > bestEnd)) {
          const a = r.substitution.apply((info as { type: Type }).type);
          if (a.tag === 'TFun' && (end - s) < span) { span = end - s; scopeType = a; }
        }
      }
    }
    const h = buildHover({
      source, offset, result: r, bestType, rawBestType, bestStart, bestEnd,
      scopeType, arrayShift: 0, inferredTypeStyle: 'pretty', uri: 'file:///t.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
    } as Parameters<typeof buildHover>[0]);
    return h ? (h.contents as { value: string }).value : null;
  }

  describe('signature wins for frozen parameter hover (alt.js)', () => {
    const src = `"use strict";
let natives = {};
// natives.Array :: Array a ~> Array a -> Array a
natives.Array = function (other) {
  return concat (other) (this);
};
// natives.Object :: Object k a ~> Object k a -> Object k a
natives.Object = function (other) {
  return concat (other) (this);
};
`;

    test('`other` in natives.Array hovers as the signature `[a]` (not `[b]`)', () => {
      const off = src.indexOf('function (other)', src.indexOf('natives.Array')) + 'function ('.length;
      expect(hoverAt(src, off)).toContain('[a]');
    });

    test('`other` in natives.Object hovers as the signature `{ [k] :: a }` (not `Object b c`)', () => {
      const off = src.indexOf('function (other)', src.indexOf('natives.Object')) + 'function ('.length;
      const hov = hoverAt(src, off);
      expect(hov).toContain('{ [k] :: a }');
      expect(hov).not.toContain('Object b c');
    });

    test('`this` in natives.Array hovers as the signature receiver `[a]` (not `[b]`)', () => {
      const bodyStart = src.indexOf('(this)', src.indexOf('natives.Array')) + 1;
      const hov = hoverAt(src, bodyStart);
      expect(hov).toContain('[a]');
      expect(hov).not.toContain('[b]');
    });

    test('`this` in natives.Object hovers as the signature receiver `{ [k] :: a }`', () => {
      const bodyStart = src.indexOf('(this)', src.indexOf('natives.Object')) + 1;
      const hov = hoverAt(src, bodyStart);
      expect(hov).toContain('{ [k] :: a }');
      expect(hov).not.toContain('Object b c');
    });
  });
}

// ---------------------------------------------------------------------------
// 4. hoverScopeConsistentLetters
// ---------------------------------------------------------------------------
// Scope-consistent hover letters.
//
// When the cursor is on a sub-expression inside a function, the pretty-printer
// seeds its variable letters from the enclosing function's type.  Without this,
// each hover re-letters variables from scratch, so a variable shared between
// `f :: a -> b` and its `const result = f(arg)` would show `b` on `f` but `a`
// on `result`.  Regression for demo3.js `memoizeCurried` where `result :: a`
// looked wrong next to `f :: a -> b`.

{
  /** Mirror the server's onHover: find bestType + the smallest STRICTLY enclosing
   *  function type (scopeType), then render via buildHover. */
  function hoverAt(source: string, offset: number): string | null {
    const r = new InferenceEngine().infer(source);
    let bestStart = -1, bestEnd = -1;
    let bestType: Type | null = null;
    for (const [s, info] of r.nodeTypes) {
      const end = (info as { end: number }).end;
      if (s <= offset && offset < end && s > bestStart) {
        bestStart = s; bestEnd = end;
        bestType = r.substitution.apply((info as { type: Type }).type);
      }
    }
    let scopeType: Type | null = null;
    if (bestType && bestStart >= 0) {
      let span = Infinity;
      for (const [s, info] of r.nodeTypes) {
        const end = (info as { end: number }).end;
        if (s <= bestStart && end >= bestEnd && (s < bestStart || end > bestEnd)) {
          const a = r.substitution.apply((info as { type: Type }).type);
          if (a.tag === 'TFun' && (end - s) < span) { span = end - s; scopeType = a; }
        }
      }
    }
    const h = buildHover({
      source, offset, result: r, bestType, bestStart, bestEnd, scopeType, arrayShift: 0,
      inferredTypeStyle: 'pretty', uri: 'file:///t.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
    } as Parameters<typeof buildHover>[0]);
    return h ? (h.contents as { value: string }).value : null;
  }

  describe('hover letters are consistent within a function scope', () => {
    const SRC = [
      'const wrap = (f) => (arg) => {',
      '  const result = f(arg);',
      '  return result;',
      '};',
    ].join('\n');

    test('`f` renders `a -> b`', () => {
      const off = SRC.indexOf('result = f(arg)') + 'result = '.length;
      expect(hoverAt(SRC, off)).toContain('a -> b');
    });

    test('`arg` renders `a` (the function\'s parameter letter)', () => {
      const off = SRC.indexOf('(arg)') + 1;
      expect(hoverAt(SRC, off)).toMatch(/arg :: a\b/);
    });

    test('`result` renders `b` — f\'s return — NOT a re-lettered `a`', () => {
      const off = SRC.indexOf('const result') + 'const '.length;
      const h = hoverAt(SRC, off);
      expect(h).toContain('result :: b');
      expect(h).not.toContain('result :: a');
    });

    test('top-level hover (no enclosing function) is unaffected — plain letters', () => {
      // `id` at top level has no enclosing function scope; it still renders from
      // its own letters starting at `a`.
      const src = 'const id = (x) => x;';
      const off = src.indexOf('id');
      expect(hoverAt(src, off)).toContain('id :: a -> a');
    });
  });
}

// ---------------------------------------------------------------------------
// 5. hoverSiblingBindingLetters  (+ 6. scopeSeedShareGatedLettering — the two
//    originals used an identical `hoverAt` harness, shared below)
// ---------------------------------------------------------------------------
// Hover display-letter assignment is SHARE-GATED: enclosing scope context
// influences a hover's letters only for variables the hovered type genuinely
// SHARES with that context.  An unrelated sibling binding therefore no longer
// bumps a self-contained hovered type's letters — each such lone binding starts
// its own lettering at `a` (previously `let n` → `b`, `let xs` → `c`, which
// leaked the sibling `pair`'s letter and confused users who expected a
// self-contained type to begin at `a`).  Genuinely shared variables (a
// parameter and a binding derived so that they share the SAME variable id)
// still align — see the `shared variable still aligns` case below.

{
  /** Mirror the server's onHover: smallest node covering the offset (bestType),
   *  then the scope seed built from the tightest enclosing function scope. */
  function hoverAt(source: string, offset: number): string | null {
    const r = new InferenceEngine().infer(source);
    let bestStart = -1, bestEnd = -1;
    let bestType: Type | null = null;
    for (const [s, info] of r.nodeTypes) {
      const end = (info as { end: number }).end;
      if (s <= offset && offset < end && s > bestStart) {
        bestStart = s; bestEnd = end;
        bestType = r.substitution.apply((info as { type: Type }).type);
      }
    }
    const scopeType = buildScopeSeedType(r, r.substitution, bestStart, bestEnd);
    const h = buildHover({
      source, offset, result: r, bestType, bestStart, bestEnd, scopeType, arrayShift: 0,
      inferredTypeStyle: 'pretty', uri: 'file:///t.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
    } as Parameters<typeof buildHover>[0]);
    return h ? (h.contents as { value: string }).value : null;
  }

  describe('unrelated sibling bindings each start their own lettering at `a`', () => {
    const SRC = [
      'const f = (pair) => {',
      '  let n = pair.fst;',
      '  let xs = pair.snd;',
      '  return null;',
      '};',
    ].join('\n');

    test('`pair` renders `a`', () => {
      const off = SRC.indexOf('(pair)') + 1;
      expect(hoverAt(SRC, off)).toMatch(/pair :: a\b/);
    });

    test('`n` renders `a` — self-contained, not bumped by the sibling `pair`', () => {
      const off = SRC.indexOf('n = pair.fst');
      expect(hoverAt(SRC, off)).toMatch(/n :: a\b/);
    });

    test('`xs` renders `a` — self-contained, not bumped by `n` or `pair`', () => {
      const off = SRC.indexOf('xs = pair.snd');
      expect(hoverAt(SRC, off)).toMatch(/xs :: a\b/);
    });
  });

  describe('a variable genuinely SHARED with the enclosing scope still aligns', () => {
    // `result`'s variable IS the function's result variable, so hovering it must
    // keep the letter it has in the enclosing signature (`a -> b` → `b`), not
    // reset to `a`.
    const SRC = [
      'const f = (x) => {',
      '  const result = x;',
      '  return [x, result];',
      '};',
    ].join('\n');

    test('`x` renders `a`', () => {
      const off = SRC.indexOf('(x)') + 1;
      expect(hoverAt(SRC, off)).toMatch(/x :: a\b/);
    });

    test('`result` shares `x`\u2019s variable and renders `a` too', () => {
      const off = SRC.indexOf('result = x');
      expect(hoverAt(SRC, off)).toMatch(/result :: a\b/);
    });
  });

  describe('distinct variables connected through the enclosing signature keep sequential letters', () => {
    // Two DISTINCT params of the same function.  Because each parameter shares
    // its variable with the enclosing signature `(a, b) -> a`, share-gating pulls
    // that signature into the seed, so the letters stay aligned: `x` is `a` and
    // `y` is `b` (NOT reset to `a`).  This is the case a user intuitively expects
    // to render `a b c`, and it does whenever the variables are genuinely related.
    const SRC = 'const g = (x, y) => x;';

    test('the signature renders both variables distinctly: `(a, b) -> a`', () => {
      const off = SRC.indexOf('g =');
      expect(hoverAt(SRC, off)).toMatch(/g :: \(a, b\) -> a\b/);
    });

    test('`x` renders `a`', () => {
      const off = SRC.indexOf('(x') + 1;
      expect(hoverAt(SRC, off)).toMatch(/x :: a\b/);
    });

    test('`y` renders `b` — aligned to the signature, not reset to `a`', () => {
      const off = SRC.indexOf('y)');
      expect(hoverAt(SRC, off)).toMatch(/y :: b\b/);
    });
  });

  // -------------------------------------------------------------------------
  // 6. scopeSeedShareGatedLettering
  // -------------------------------------------------------------------------
  // Regression: a self-contained hovered type starts its lettering at `a`, even
  // when an UNRELATED sibling binding sits in the same enclosing function scope.
  //
  // Hovering `monoidLaws (Maybe)` inside a function that also binds an unrelated
  // `const other = Just (0)` used to render `TypeRep (Maybe b) -> …` — the
  // sibling `other :: Maybe a` consumed the letter `a`, bumping the witness
  // variable to `b`.  Hover scope-seeding is now share-gated: only context that
  // genuinely shares a variable with the hovered type may influence its letters,
  // so the sole witness variable renders `a`.
  //
  // Mirrors fpkit `src/Maybe/index.spec.js` L112.

  const SRC = `
// ::constraint Monoid m { m :: { empty :: () -> m, concat :: m ~> m -> m } }

// Maybe :: Nothing | Just a
function Maybe() {}

// Just :: a -> Maybe a
function Just(x) {}

// Nothing :: Maybe a
const Nothing = Just (0);

// empty :: Monoid m => TypeRep m -> m
const empty = M => M.empty();

// concat :: Monoid m => m -> m -> m
const concat = a => b => a;

// equals :: a -> a -> Boolean
const equals = a => b => true;

// leftIdentity :: Monoid m => TypeRep m -> m -> Boolean
const leftIdentity = M => m => equals (m) (concat (m) (empty (M)));

// rightIdentity :: Monoid m => TypeRep m -> m -> Boolean
const rightIdentity = M => m => equals (m) (concat (empty (M)) (m));

const monoidLaws = M => ({ leftIdentity: leftIdentity (M), rightIdentity: rightIdentity (M) });

const run = () => {
  const other = Just (0);
  const laws = monoidLaws (Maybe);
  return laws;
};
`;

  describe('scope-seed share-gated lettering (monoidLaws witness)', () => {
    test('monoidLaws (Maybe) renders its sole witness variable as `a`, not `b`', () => {
      const off = SRC.indexOf('monoidLaws (Maybe)');
      const hover = hoverAt(SRC, off);
      expect(hover).not.toBeNull();
      expect(hover).toContain('TypeRep (Maybe a)');
      expect(hover).not.toContain('Maybe b');
    });
  });
}
