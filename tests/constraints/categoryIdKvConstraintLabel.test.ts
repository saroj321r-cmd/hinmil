// Regression for fpkit src/test/laws/Category.js + src/fl/id.js.
//
//   // id :: Category c => TypeRep c -> c a a
//   // id :: TypeRep Function -> a -> a
//   const id = ...;
//
//   // leftIdentity :: Category c => TypeRep (c a a) -> c a a -> Boolean
//   const leftIdentity = C => a => { const idd = id(C); ... };
//
// `id(C)` selects the Category-constrained overload, whose result `c a a` is a
// higher-kinded head (`c`) applied to two args.  The head is kv-encoded as a
// TCon (`$kv:c:ID`).  The hover body renames it to a display letter (e.g. `b`),
// but the constraint prefix used to be built from the RAW annotation name `c`,
// producing the malformed `Category c => b d d` where the constraint variable
// `c` does not appear in the body.  The prefix must use the SAME display letter
// as the body head.
import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import { buildHover } from '../../src/services/hover';
import type { Type } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

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
  const h = buildHover({
    source: src, offset, result: r, bestType, rawBestType, bestStart, arrayShift: 0,
    inferredTypeStyle: 'pretty', uri: 'file:///t.js',
    resolveImportSpecifier: () => null,
    extractImportSpecifiers: () => new Map(),
  } as Parameters<typeof buildHover>[0]);
  return h ? (h.contents as { value: string }).value : null;
}

const SRC = `"use strict";
// ::constraint Category c { c :: { id :: c, compose :: c -> c -> c } }
// id :: Category c => TypeRep c -> c a a
// id :: TypeRep Function -> a -> a
const id = (TR) => TR;

// leftIdentity :: Category c => TypeRep (c a a) -> c a a -> Boolean
const leftIdentity = C => a => {
  const idd = id (C);
  return idd;
};
`;

describe('Category id: kv-head constraint label matches body head letter', () => {
  test('hover on `idd` does not disconnect the constraint variable from the body', () => {
    const off = SRC.indexOf('idd = id') + 1;
    const h = hoverAt(SRC, off)!;
    expect(h).toContain('Category');
    // Extract the `Category X` prefix letter and the body head letter and
    // assert they are the SAME variable — the constraint must appear in body.
    const m = h.match(/Category\s+([a-z])\s*=>\s*([a-z])\s/);
    expect(m).not.toBeNull();
    const [, constraintVar, bodyHead] = m!;
    expect(constraintVar).toBe(bodyHead);
    // The old bug produced `Category c => b d d` (c not in body).
    expect(h).not.toMatch(/Category\s+c\s*=>\s*b\b/);
  });
});

// ---------------------------------------------------------------------------
// Scope-seeded rendering (the real server passes the enclosing function's type
// as `scopeType`).  Before the display-id alignment fix, the enclosing
// `leftIdentity` function's recorded type used a SEPARATE annotation
// instantiation than the body, so `idd`'s category head (a body-internal
// `$kv:c` id) rendered with a fresh letter `b` — `idd :: Category b => b b b` —
// even though it IS `leftIdentity`'s category `c`.  After the fix the recorded
// display type shares the body's ids, so the head renders `c`, matching the
// enclosing law's declared category.
// ---------------------------------------------------------------------------
function hoverAtWithScope(src: string, offset: number): string | null {
  const r = engine.infer(src);
  let bestStart = -1;
  let bestEnd = -1;
  let bestType: Type | null = null;
  let rawBestType: Type | null = null;
  for (const [s, info] of r.nodeTypes) {
    const end = (info as { end: number }).end;
    if (s <= offset && offset < end && s > bestStart) {
      bestStart = s;
      bestEnd = end;
      bestType = r.substitution.apply((info as { type: Type }).type);
      rawBestType = (info as { type: Type }).type;
    }
  }
  // Compute scopeType exactly like server.ts: the smallest-span enclosing node
  // whose applied type is a function (`TFun`).
  let scopeType: Type | null = null;
  let bestScopeSpan = Infinity;
  for (const [start, info] of r.nodeTypes) {
    const end = (info as { end: number }).end;
    if (start <= bestStart && end >= bestEnd && (start < bestStart || end > bestEnd)) {
      const applied = r.substitution.apply((info as { type: Type }).type);
      if (applied.tag === 'TFun') {
        const span = end - start;
        if (span < bestScopeSpan) {
          bestScopeSpan = span;
          scopeType = applied;
        }
      }
    }
  }
  const h = buildHover({
    source: src, offset, result: r, bestType, rawBestType, bestStart, arrayShift: 0,
    scopeType, inferredTypeStyle: 'pretty', uri: 'file:///t.js',
    resolveImportSpecifier: () => null,
    extractImportSpecifiers: () => new Map(),
  } as Parameters<typeof buildHover>[0]);
  return h ? (h.contents as { value: string }).value : null;
}

describe('Category id: kv-head shares the enclosing law\'s category letter under scope seeding', () => {
  test('hover on `idd` renders the head as `c` (the law\'s category), never `b`', () => {
    const off = SRC.indexOf('idd = id') + 1;
    const h = hoverAtWithScope(SRC, off)!;
    expect(h).toContain('Category');
    const m = h.match(/Category\s+([a-z])\s*=>\s*([a-z])\s+([a-z])\s+([a-z])/);
    expect(m).not.toBeNull();
    const [, constraintVar, bodyHead, arg1, arg2] = m!;
    // The constraint variable and the body head are the SAME variable, and it is
    // the law's declared category letter `c` (not a fresh `b`) — because the
    // category flows in from the shared `TypeRep` argument.
    expect(bodyHead).toBe(constraintVar);
    expect(bodyHead).toBe('c');
    // The object arguments are id's OWN fresh variable (`id :: … -> c a a`
    // introduces `a` from no argument), so they must render as a DISTINCT letter
    // — never collapsed onto the category head `c`.
    expect(arg1).toBe(arg2);
    expect(arg1).not.toBe(bodyHead);
    expect(arg1).toBe('b');
    // The pre-fix rendering leaked a fresh `b` for the head.
    expect(h).not.toMatch(/Category\s+b\s*=>\s*b\b/);
  });
});

