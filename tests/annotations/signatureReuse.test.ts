// Feature: auto-suppress the "no HM annotation" warning on a function wrapper
// whose returned object literal is built entirely from calls to already-
// annotated bindings (e.g. fpkit `categoryLaws`).

import { detectMissingSignatures } from '../../src/services/diagnostics';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TypeAnnotation } from '../../src/commentParser';

function detect(source: string, annotatedNames: string[] = []) {
  const doc = TextDocument.create('file:///test.js', 'javascript', 1, source);
  const annotations = new Map<string, TypeAnnotation>();
  for (const name of annotatedNames) {
    annotations.set(name, {} as TypeAnnotation);
  }
  return detectMissingSignatures(
    source,
    doc,
    annotations,
    DiagnosticSeverity.Information,
    DiagnosticSeverity.Information,
  );
}

describe('signature reuse — auto-suppress derivable object wrappers', () => {
  test('categoryLaws: object of annotated calls → no missing-annotation warning', () => {
    const src = `const categoryLaws = C => ({
  leftIdentity: leftIdentity(C),
  rightIdentity: rightIdentity(C)
});`;
    const result = detect(src, ['leftIdentity', 'rightIdentity']);
    expect(result.filter(d => d.message.includes('has no HM annotation'))).toHaveLength(0);
  });

  test('block-body wrapper with `return { ... }` of annotated calls → no warning', () => {
    const src = `const laws = C => {
  return { a: leftIdentity(C), b: rightIdentity(C) };
};`;
    const result = detect(src, ['leftIdentity', 'rightIdentity']);
    expect(result.filter(d => d.message.includes('has no HM annotation'))).toHaveLength(0);
  });

  test('curried wrapper `C => a => ({ ... })` → no warning', () => {
    const src = `const laws = C => a => ({ x: leftIdentity(C) });`;
    const result = detect(src, ['leftIdentity']);
    expect(result.filter(d => d.message.includes('has no HM annotation'))).toHaveLength(0);
  });

  test('function declaration wrapper → no warning', () => {
    const src = `function laws(C) {
  return { a: leftIdentity(C) };
}`;
    const result = detect(src, ['leftIdentity']);
    expect(result.filter(d => d.message.includes('has no HM annotation'))).toHaveLength(0);
  });

  test('NOT suppressed when a field value is not a call to an annotated binding', () => {
    const src = `const laws = C => ({
  leftIdentity: leftIdentity(C),
  other: 42
});`;
    const result = detect(src, ['leftIdentity']);
    expect(result.some(d => d.message === "Function 'laws' has no HM annotation")).toBe(true);
  });

  test('NOT suppressed when a field calls an UN-annotated binding', () => {
    const src = `const laws = C => ({ a: helper(C) });`;
    const result = detect(src, []); // helper has no annotation
    expect(result.some(d => d.message === "Function 'laws' has no HM annotation")).toBe(true);
  });

  test('altLaws: shorthand references to annotated bindings → no warning', () => {
    const src = `const altLaws = () => ({
  associativity,
  distributivity
});`;
    const result = detect(src, ['associativity', 'distributivity']);
    expect(result.filter(d => d.message.includes('has no HM annotation'))).toHaveLength(0);
  });

  test('explicit `key: ident` references to annotated bindings → no warning', () => {
    const src = `const laws = () => ({ assoc: associativity, dist: distributivity });`;
    const result = detect(src, ['associativity', 'distributivity']);
    expect(result.filter(d => d.message.includes('has no HM annotation'))).toHaveLength(0);
  });

  test('mixed calls and shorthand references → no warning', () => {
    const src = `const laws = M => ({
  leftIdentity: leftIdentity(M),
  associativity
});`;
    const result = detect(src, ['leftIdentity', 'associativity']);
    expect(result.filter(d => d.message.includes('has no HM annotation'))).toHaveLength(0);
  });

  test('NOT suppressed when a shorthand reference is UN-annotated', () => {
    const src = `const laws = () => ({ associativity, helper });`;
    const result = detect(src, ['associativity']); // helper has no annotation
    expect(result.some(d => d.message === "Function 'laws' has no HM annotation")).toBe(true);
  });

  test('empty object literal is not treated as derivable', () => {
    const src = `const laws = C => ({});`;
    const result = detect(src, []);
    expect(result.some(d => d.message === "Function 'laws' has no HM annotation")).toBe(true);
  });
});
