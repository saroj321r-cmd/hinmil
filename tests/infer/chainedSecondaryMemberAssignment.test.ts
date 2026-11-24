// Regression tests for the chained-annotation form on member assignments
// where the LHS object is a plain record (not a class / sumtype):
//
//   let natives = {};
//   // Array#chain :: natives.Array :: Array a ~> (a -> Array b) -> Array b
//   natives.Array = function (fn) { ... };
//
// The secondary entry `natives.Array` is a *binding annotation* for the
// member-assignment LHS, not a static-method annotation on a constructor
// `natives`.  It must therefore:
//   1. carry `chainedSecondary: true` on the TypeAnnotation,
//   2. NOT trigger the "Static annotation … has no constructor … in scope"
//      orphan diagnostic, and
//   3. consequently NOT cause a "Method 'natives.Array' has no HM annotation"
//      missing-signature diagnostic at the member-assignment site.

import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { detectMissingSignatures } from '../../src/services/diagnostics';
import { buildAnnotationMap, extractAnnotations } from '../../src/commentParser';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  engine = new InferenceEngine();
});

const SRC = `
let natives = {};

// Array#chain :: natives.Array :: Array a ~> (a -> Array b) -> Array b
natives.Array = function (fn) {
  return this.flatMap (x => fn (x));
};
`;

describe('chained-annotation secondary on member assignment', () => {
  test('parser flags the secondary entry with chainedSecondary: true', () => {
    const anns = extractAnnotations(SRC);
    const primary   = anns.find(a => a.name === 'Array#chain');
    const secondary = anns.find(a => a.name === 'natives.Array');
    expect(primary).toBeDefined();
    expect(secondary).toBeDefined();
    expect(primary!.chainedSecondary).toBeUndefined();
    expect(secondary!.chainedSecondary).toBe(true);
  });

  test('no "has no constructor \'natives\'" orphan diagnostic', () => {
    const r = engine.infer(SRC);
    const orphan = r.diagnostics.filter(d =>
      d.message.includes("has no constructor 'natives'"));
    expect(orphan).toEqual([]);
  });

  test('Array#chain annotation is preserved in the annotation map', () => {
    engine.infer(SRC);
    // The orphan-method cleanup must NOT have deleted either entry:
    // the primary `Array#chain` (the Chain-instance declaration that
    // makes `findAlg('chain')(natives)` work at runtime) and the
    // chained-secondary `natives.Array` (the binding annotation).
    expect(engine.annotationMap.has('Array#chain')).toBe(true);
    expect(engine.annotationMap.has('natives.Array')).toBe(true);
  });

  test('no "Method \'natives.Array\' has no HM annotation" missing-sig diagnostic', () => {
    engine.infer(SRC);
    const annMap = buildAnnotationMap(SRC);
    const doc = TextDocument.create('file:///t.js', 'javascript', 1, SRC);
    const diags = detectMissingSignatures(
      SRC, doc, annMap,
      DiagnosticSeverity.Information,
      null,
    );
    const missing = diags.find(d =>
      d.message === "Method 'natives.Array' has no HM annotation");
    expect(missing).toBeUndefined();
  });

  test('hover at `let natives = {}` reflects later record extensions', () => {
    // Regression: `subst.apply` on a closed TRecord clones the record,
    // so recording the clone as the declaration's `displayType` while
    // letting the env-bound scheme keep the original instance caused
    // later mutations (`natives.Array = …`) to land on a different
    // TRecord than the one hover reads.  Fix: store `resolved` (same
    // instance as `displayType`) in the `let`/`var` scheme so both
    // alias the same TRecord and field-extension mutations propagate.
    const SRC2 = `
let natives = {};

// Array#chain :: natives.Array :: Array a ~> (a -> Array b) -> Array b
natives.Array = function (fn) {
  return this.flatMap (x => fn (x));
};

// Function#chain :: (x -> a) ~> (a -> x -> b) -> x -> b
natives.Function = function (fn) {
  return input => fn (this (input)) (input);
};
`;
    const r = engine.infer(SRC2);
    // Offset of `natives` identifier in `let natives = {}` (after leading "\nlet ")
    const declOffset = SRC2.indexOf('let natives = {}') + 'let '.length;
    const entry = r.nodeTypes.get(declOffset);
    expect(entry).toBeDefined();
    expect(entry!.type.tag).toBe('TRecord');
    const fields = (entry!.type as any).fields;
    expect(Object.keys(fields).sort()).toEqual(['Array', 'Function']);
  });

  test('field display preserves `~>` method-form for chained-secondary annotation', () => {
    // Regression: the chained-secondary annotation's scheme stores only
    // the methodType (right of `~>`), so the field on `natives` would
    // render as `(a -> Array b) -> Array b` — losing the `Array a ~>`
    // receiver context.  We stash the original raw signature in
    // `TRecord.fieldDisplays[k]` so hover renders the full form.
    const SRC3 = `
let natives = {};

// Array#chain :: natives.Array :: Array a ~> (a -> Array b) -> Array b
natives.Array = function (fn) {
  return this.flatMap (x => fn (x));
};
`;
    const r = engine.infer(SRC3);
    const declOffset = SRC3.indexOf('let natives = {}') + 'let '.length;
    const entry = r.nodeTypes.get(declOffset);
    expect(entry).toBeDefined();
    const rec = entry!.type as any;
    expect(rec.tag).toBe('TRecord');
    expect(rec.fieldDisplays?.Array).toBe('Array a ~> (a -> Array b) -> Array b');
    const { prettyTypeToString } = require('../../src/hm/types');
    const rendered = prettyTypeToString(rec);
    expect(rendered).toContain('Array :: Array a ~> (a -> Array b) -> Array b');
  });

  test('primary Array#chain registers in the method registry (Chain dispatch)', () => {
    // The chained form must not flag the attached name (`natives.Array`) as
    // a methodNameMismatch on the primary `Array#chain`.  If it did,
    // processMethodAnnotations would skip registration and any `Chain m`
    // constraint check unifying `m = Array` would fail with
    // "Type 'Array' does not satisfy constraint 'Chain': missing method
    // 'chain'" — even from the same file.
    engine.infer(SRC);
    const primary = engine.annotationMap.get('Array#chain');
    expect(primary?.methodNameMismatch).toBeUndefined();
    // Lazy import to avoid pulling the registry at top-level (other suites
    // may reset it).
    const { lookupMethod } = require('../../src/registries/methodRegistry');
    const entry = lookupMethod('Array', 'chain');
    expect(entry).not.toBeNull();
    expect(entry.signature).toContain('Array a ~> (a -> Array b) -> Array b');
  });
});

