// Coverage for all four supported annotation shapes on a plain-object
// host (`let natives = {}; natives.X = function (...) { ... }`):
//
//   F1: // Array#chain :: natives.Array :: Array a ~> (a -> Array b) -> Array b
//   F2: // natives.Array :: Array#chain :: Array a ~> (a -> Array b) -> Array b
//   F3: // Array#chain :: Array a ~> (a -> Array b) -> Array b
//   F4: // natives.Array :: Array a ~> (a -> Array b) -> Array b
//
// All four must:
//   - parse without parser-level errors
//   - produce no orphan-method ("has no constructor 'natives'") diagnostics
//   - produce no missing-signature diagnostics on the member-assignment
//
// F1, F2 and F4 additionally extend the inferred record type of `natives`
// with a field named `Array`.  F3 carries only the method-registry side
// (no binding extension is implied).

import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { detectMissingSignatures } from '../../src/services/diagnostics';
import { buildAnnotationMap, extractAnnotations } from '../../src/commentParser';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { clearCustomMethods, getMethodNames, isMethodHidden } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  clearCustomMethods();
  engine = new InferenceEngine();
});

const BODY = `function (fn) {
  return [].concat (...this.map (value => fn (value)));
};`;

function noOrphan(src: string): void {
  const r = engine.infer(src);
  const orphan = r.diagnostics.filter(d =>
    d.message.includes("has no constructor 'natives'"));
  expect(orphan).toEqual([]);
}

function noMissingSig(src: string, methodName = 'natives.Array'): void {
  engine.infer(src);
  const annMap = buildAnnotationMap(src);
  const doc = TextDocument.create('file:///t.js', 'javascript', 1, src);
  const diags = detectMissingSignatures(
    src, doc, annMap,
    DiagnosticSeverity.Information,
    null,
  );
  const missing = diags.find(d =>
    d.message === `Method '${methodName}' has no HM annotation`);
  expect(missing).toBeUndefined();
}

function builtInFields(src: string): string[] {
  const r = engine.infer(src);
  const declOffset = src.indexOf('let natives = {}') + 'let '.length;
  const entry = r.nodeTypes.get(declOffset);
  expect(entry).toBeDefined();
  expect(entry!.type.tag).toBe('TRecord');
  return Object.keys((entry!.type as any).fields).sort();
}

describe('F1: // Array#chain :: natives.Array :: T', () => {
  const SRC = `
let natives = {};

// Array#chain :: natives.Array :: Array a ~> (a -> Array b) -> Array b
natives.Array = ${BODY}
`;
  test('parser flags secondary entry', () => {
    const anns = extractAnnotations(SRC);
    expect(anns.find(a => a.name === 'Array#chain')?.chainedSecondary).toBeUndefined();
    expect(anns.find(a => a.name === 'natives.Array')?.chainedSecondary).toBe(true);
  });
  test('no orphan diagnostic', () => noOrphan(SRC));
  test('no missing-signature diagnostic', () => noMissingSig(SRC));
  test('natives record gets Array field', () => {
    expect(builtInFields(SRC)).toEqual(['Array']);
  });
  test('Array#chain registered as instance method', () => {
    engine.infer(SRC);
    expect(getMethodNames('Array')).toContain('chain');
  });
});

describe('F2: // natives.Array :: Array#chain :: T', () => {
  const SRC = `
let natives = {};

// natives.Array :: Array#chain :: Array a ~> (a -> Array b) -> Array b
natives.Array = ${BODY}
`;
  test('parser accepts `Array#chain` as secondary', () => {
    const anns = extractAnnotations(SRC);
    const primary = anns.find(a => a.name === 'natives.Array');
    const secondary = anns.find(a => a.name === 'Array#chain');
    expect(primary).toBeDefined();
    expect(secondary).toBeDefined();
    expect(primary!.chainedSecondary).toBeUndefined();
    expect(secondary!.chainedSecondary).toBe(true);
    expect(primary!.error).toBeUndefined();
    expect(secondary!.error).toBeUndefined();
  });
  test('no orphan diagnostic', () => noOrphan(SRC));
  test('no missing-signature diagnostic', () => noMissingSig(SRC));
  test('natives record gets Array field', () => {
    expect(builtInFields(SRC)).toEqual(['Array']);
  });
  test('Array#chain registered as instance method', () => {
    engine.infer(SRC);
    expect(getMethodNames('Array')).toContain('chain');
  });
});

describe('F3: // Array#chain :: T (method only)', () => {
  const SRC = `
let natives = {};

// Array#chain :: Array a ~> (a -> Array b) -> Array b
natives.Array = ${BODY}
`;
  test('no orphan diagnostic', () => noOrphan(SRC));
  test('Array#chain registered as instance method', () => {
    engine.infer(SRC);
    expect(getMethodNames('Array')).toContain('chain');
  });
});

describe('F4: // natives.Array :: T (binding only)', () => {
  const SRC = `
let natives = {};

// natives.Array :: Array a ~> (a -> Array b) -> Array b
natives.Array = ${BODY}
`;
  test('no orphan diagnostic', () => noOrphan(SRC));
  test('no missing-signature diagnostic', () => noMissingSig(SRC));
  test('natives record gets Array field', () => {
    expect(builtInFields(SRC)).toEqual(['Array']);
  });
});

describe('::hidden on a chained annotation hides the member-shaped target', () => {
  // Ordering where the registration target (`Array#chain`) is a chained
  // SECONDARY rather than the primary binding name.  A `::hidden` directive
  // above must hide `chain` on `Array` even though the primary name is the
  // plain-object binding `natives.Array`.
  const SRC = `
let natives = {};

// ::hidden
// natives.Array :: Array#chain :: Array a ~> (a -> Array b) -> Array b
natives.Array = ${BODY}
`;
  test('secondary inherits hidden flag', () => {
    const anns = extractAnnotations(SRC);
    const secondary = anns.find(a => a.name === 'Array#chain');
    expect(secondary?.chainedSecondary).toBe(true);
    expect(secondary?.hidden).toBe(true);
  });
  test('chain is registered but hidden on Array', () => {
    engine.infer(SRC);
    expect(getMethodNames('Array')).toContain('chain');
    expect(isMethodHidden('Array', 'chain')).toBe(true);
  });
});

describe('::private on a chained annotation marks the member-shaped target', () => {
  const SRC = `
let natives = {};

// ::private
// natives.Array :: Array#chain :: Array a ~> (a -> Array b) -> Array b
natives.Array = ${BODY}
`;
  test('secondary inherits private + hidden flags', () => {
    const anns = extractAnnotations(SRC);
    const secondary = anns.find(a => a.name === 'Array#chain');
    expect(secondary?.private).toBe(true);
    expect(secondary?.hidden).toBe(true);
  });
  test('chain is private (and hidden) on Array', () => {
    engine.infer(SRC);
    expect(isMethodHidden('Array', 'chain')).toBe(true);
  });
});
