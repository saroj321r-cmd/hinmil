// Regression tests for single-name member annotations on plain-object hosts:
//
//   let natives = {};
//   // natives.Object :: Object ~> Object -> Object
//   natives.Object = function (other) { ... };
//
// Without the fix, the orphan-method cleanup would treat `natives.Object`
// as a static-method annotation requiring a constructor `natives`, emit
//   "Static annotation 'natives.Object :: ...' has no constructor 'natives :: ...'"
// and delete the entry, which then provoked a downstream
//   "Method 'natives.Object' has no HM annotation"
// from detectMissingSignatures.
//
// The chained form `// Array#chain :: natives.Array :: T` (covered by
// `chainedSecondaryMemberAssignment.test.ts`) already worked.  This test
// pins the *single-name* form to the same behaviour: when the host is a
// top-level `let|const|var X = {}` binding, the member annotation is a
// binding annotation for the member assignment, not an orphan static.

import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { detectMissingSignatures } from '../../src/services/diagnostics';
import { buildAnnotationMap } from '../../src/commentParser';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  engine = new InferenceEngine();
});

const SRC = `
"use strict";

let natives = {};

// natives.Object :: Object ~> Object -> Object
natives.Object = function (other) {
  const out = {};
  Object.keys (this).forEach (key => { out[key] = this[key]; });
  Object.keys (other).forEach (key => { out[key] = other[key]; });
  return out;
};
`;

describe('single-name member annotation on plain-object host', () => {
  test('no "has no constructor \'natives\'" orphan diagnostic', () => {
    const r = engine.infer(SRC);
    const orphan = r.diagnostics.filter(d =>
      d.message.includes("has no constructor 'natives'"));
    expect(orphan).toEqual([]);
  });

  test('natives.Object annotation is preserved in the annotation map', () => {
    engine.infer(SRC);
    expect(engine.annotationMap.has('natives.Object')).toBe(true);
  });

  test('no "Method \'natives.Object\' has no HM annotation" missing-sig diagnostic', () => {
    engine.infer(SRC);
    const annMap = buildAnnotationMap(SRC);
    const doc = TextDocument.create('file:///t.js', 'javascript', 1, SRC);
    const diags = detectMissingSignatures(
      SRC, doc, annMap,
      DiagnosticSeverity.Information,
      null,
    );
    const missing = diags.find(d =>
      d.message === "Method 'natives.Object' has no HM annotation");
    expect(missing).toBeUndefined();
  });

  test('hover at `let natives = {}` reflects the member extension', () => {
    const r = engine.infer(SRC);
    const declOffset = SRC.indexOf('let natives = {}') + 'let '.length;
    const entry = r.nodeTypes.get(declOffset);
    expect(entry).toBeDefined();
    expect(entry!.type.tag).toBe('TRecord');
    const fields = (entry!.type as any).fields;
    expect(Object.keys(fields)).toEqual(['Object']);
  });

  test('field display preserves `~>` method-form for the binding annotation', () => {
    const r = engine.infer(SRC);
    const declOffset = SRC.indexOf('let natives = {}') + 'let '.length;
    const entry = r.nodeTypes.get(declOffset);
    const displays = (entry!.type as any).fieldDisplays;
    expect(displays).toBeDefined();
    expect(displays.Object).toMatch(/Object\s*~>\s*Object\s*->\s*Object/);
  });

  test('orphan diagnostic still fires for a missing constructor host', () => {
    // Sanity: `Missing` is not a plain-object binding, class, sumtype,
    // or imported constructor — the orphan check must still catch this
    // case (not regressed by the plain-object rescue).
    const SRC2 = `
// Missing.foo :: Number -> Number
Missing.foo = function (n) { return n + 1; };
`;
    const r = engine.infer(SRC2);
    const orphan = r.diagnostics.filter(d =>
      d.message.includes("has no constructor 'Missing ::"));
    expect(orphan.length).toBe(1);
  });
});
