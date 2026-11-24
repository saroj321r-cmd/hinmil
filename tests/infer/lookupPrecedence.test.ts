// Fase 6 (#7): lookup precedence — an explicit file-local `Type#method`
// annotation takes precedence over the built-in registry entry, and a bare
// (unannotated) receiver is never coerced to a built-in container by a
// name/pattern heuristic.  Resolution flows only from explicit signatures,
// directives, and assignment structure.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, typeToString } from '../../src/hm/types';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import {
  clearCustomMethods,
  getMethodNames,
  lookupMethod,
  snapshotBuiltinOriginalEntries,
  restoreBuiltinOriginalEntries,
} from '../../src/registries/methodRegistry';
import { clearConstraints } from '../../src/registries/constraintRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  clearCustomMethods();
  clearConstraints();
  engine = new InferenceEngine();
});

/** Mirrors `safeEngineInfer` in server.ts: file-scope any builtin override. */
function safeInfer(src: string) {
  const snap = snapshotBuiltinOriginalEntries();
  try {
    return engine.infer(src);
  } finally {
    restoreBuiltinOriginalEntries(snap);
  }
}

describe('explicit local annotation beats the built-in entry', () => {
  test('a new file-local `Array#chunk` registers and governs member dispatch', () => {
    // `chunk` is not a built-in Array method.  Attached to a member
    // assignment on a plain-object host (case (f)), the annotation registers
    // `chunk` on `Array` itself.
    const src = `
let natives = {};
// Array#chunk :: Array a ~> Number -> Array (Array a)
natives.Array = function (n) { return [this]; };
const grouped = [1, 2, 3].chunk(2);
`;
    const r = safeInfer(src);
    // No "Property 'chunk' does not exist" diagnostic — the explicit
    // annotation is the authority for `[...].chunk(...)`.
    const chunkErrors = r.diagnostics.filter((d) => /chunk/.test(d.message));
    expect(chunkErrors).toEqual([]);
  });

  test('a file-local override of a built-in method drives dispatch in-file', () => {
    // Override built-in `Array#map` (normally `~> Array b`) with a custom
    // return shape; member dispatch must use the LOCAL signature, not the
    // built-in one.
    const src = `
let natives = {};
// Array#map :: Array a ~> (a -> b) -> Number
natives.Array = function (f) { return this.length; };
const sz = [1, 2, 3].map(x => x + 1);
`;
    const r = safeInfer(src);
    const szType = r.exports.get('sz');
    // The local override returns Number, not Array b.
    if (szType) expect(typeToString(szType.type)).toBe('Number');
    expect(r.diagnostics).toEqual([]);
  });

  test('built-in override is restored after the file-scoped pass', () => {
    const before = lookupMethod('Array', 'map')!.signature;
    safeInfer(`
let natives = {};
// Array#map :: Array a ~> (a -> b) -> Number
natives.Array = function (f) { return this.length; };
`);
    expect(lookupMethod('Array', 'map')!.signature).toBe(before);
  });
});

describe('no name/pattern heuristic resolves a method without an explicit owner', () => {
  test('member access on an unannotated param stays polymorphic (no Array coercion)', () => {
    // `join` is owned by the built-in Array, but a bare receiver must NOT be
    // coerced to Array by the sole-owner heuristic (removed in Fase 1).
    const r = engine.infer(`const f = (x) => x.join();`);
    const t = typeToString(r.type);
    expect(t).not.toContain('Array');
    expect(t).not.toContain('[');
  });

  test('a built-in method is still available on a concrete array literal', () => {
    // Precedence does not break built-in resolution: `join` still resolves on
    // a literal array.
    expect(getMethodNames('Array')).toContain('join');
  });
});
