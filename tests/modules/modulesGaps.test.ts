// Coverage-gap tests for src/infer/modules.ts.
//
//   1. `collectPatternNames` — export of destructuring declarations
//      (ObjectPattern, ArrayPattern, RestElement, AssignmentPattern).
//   2. Default import from an UNTYPED_MODULE npm package (no sidecar).
//   3. Named re-exports `export { x, y as z } from './other'` — typed source,
//      untyped npm source, missing name, unresolvable module.
//   4. `export * from` / `export * as ns from` — typed source, untyped npm
//      source, unresolvable module.
//   5. `inferExportDefaultDeclaration` defensive fallback (no declaration).
//   6. `inferClassDeclaration` defensive catch around class-field
//      initialiser / static-block inference.

import { parseStrict } from '../../src/parsing';
import type * as estree from '../../src/estree';
import { schemeToString } from '../../src';
import { defaultEnv } from '../../src/infer';
import {
  inferClassDeclaration,
  inferExportDefaultDeclaration,
} from '../../src/infer/modules';
import { freshEngine, inferSource } from '../helpers/infer';
import { TempProject } from '../helpers/project';

// ---------------------------------------------------------------------------
// 1. Exported destructuring patterns (collectPatternNames)
// ---------------------------------------------------------------------------

describe('export const with destructuring patterns', () => {
  test('object pattern: shorthand and renamed properties are exported', () => {
    const res = inferSource([
      'const o = { a: 1, b: "hi" };',
      'export const { a, b: bee } = o;',
    ].join('\n'));
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    expect(res.exports.has('a')).toBe(true);
    expect(res.exports.has('bee')).toBe(true);
    // The renamed property must NOT leak the source name as an export.
    expect(res.exports.has('b')).toBe(false);
  });

  test('object pattern with rest element exports the rest binding', () => {
    const res = inferSource([
      'const o = { a: 1, b: 2, c: 3 };',
      'export const { a, ...rest } = o;',
    ].join('\n'));
    expect(res.exports.has('a')).toBe(true);
    expect(res.exports.has('rest')).toBe(true);
  });

  test('array pattern with hole, default value and rest element', () => {
    const res = inferSource([
      'const arr = [1, 2, 3, 4];',
      'export const [first, , third = 9, ...tail] = arr;',
    ].join('\n'));
    expect(res.exports.has('first')).toBe(true);
    expect(res.exports.has('third')).toBe(true);
    expect(res.exports.has('tail')).toBe(true);
  });

  test('nested object pattern exports the innermost binding', () => {
    const res = inferSource([
      'const o = { outer: { inner: true } };',
      'export const { outer: { inner } } = o;',
    ].join('\n'));
    expect(res.exports.has('inner')).toBe(true);
    expect(res.exports.has('outer')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Static class field access (registered method factory)
// ---------------------------------------------------------------------------

describe('static class field on an annotated class', () => {
  test('accessing ClassName.field resolves the registered field type', () => {
    const res = inferSource([
      '// Counter :: Number -> Counter',
      'class Counter {',
      '  constructor(n) { this.n = n; }',
      '  static initial = 5;',
      '}',
      'export const n = Counter.initial + 1;',
    ].join('\n'));
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    const n = res.exports.get('n');
    expect(n).toBeDefined();
    expect(schemeToString(n!)).toBe('Number');
  });
});

// ---------------------------------------------------------------------------
// Cross-module scenarios — typed local lib + untyped npm package
// ---------------------------------------------------------------------------

describe('re-exports and untyped default imports (TempProject)', () => {
  const project = new TempProject('modules-gaps');

  beforeAll(() => {
    project.setup();

    // Typed local module with named + default exports.
    project.write('lib.js', [
      'export const one = 1;',
      'export const greet = (s) => s + "!";',
      'export default 42;',
    ].join('\n'));

    // npm package with neither `.hm` sidecar nor override → UNTYPED_MODULE.
    project.write('node_modules/anonpkg/package.json', JSON.stringify({
      name: 'anonpkg',
      main: 'index.js',
    }));
    project.write('node_modules/anonpkg/index.js', [
      'exports.foo = 1;',
      'module.exports.helper = (x) => x;',
      'module.exports.default = function main() {};',
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  // --- 2. Untyped module: default import specifier ---

  test('default import from untyped npm package binds Any', () => {
    const res = project.inferSource('main.js', [
      'import anon from "anonpkg";',
      'export const v = anon;',
    ].join('\n'));
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    const v = res.exports.get('v');
    expect(v).toBeDefined();
    expect(schemeToString(v!)).toBe('Any');
  });

  // --- 3. Named re-exports (`export { ... } from`) ---

  test('re-export named binding from a typed local module', () => {
    const res = project.inferSource('reexport.js', [
      "export { greet } from './lib.js';",
    ].join('\n'));
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    const greet = res.exports.get('greet');
    expect(greet).toBeDefined();
    expect(schemeToString(greet!)).toContain('String');
  });

  test('re-export with rename exposes only the alias', () => {
    const res = project.inferSource('reexportAlias.js', [
      "export { one as uno, greet } from './lib.js';",
    ].join('\n'));
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    expect(res.exports.has('uno')).toBe(true);
    expect(res.exports.has('one')).toBe(false);
    expect(res.exports.has('greet')).toBe(true);
  });

  test('re-export of a name missing from the source module emits a diagnostic', () => {
    const res = project.inferSource('reexportMissing.js', [
      "export { nope } from './lib.js';",
    ].join('\n'));
    expect(res.diagnostics.map(d => d.message))
      .toContain("'nope' is not exported from './lib.js'");
  });

  test('re-export from an unresolvable module emits a diagnostic', () => {
    const res = project.inferSource('reexportUnresolved.js', [
      "export { x } from './does-not-exist.js';",
    ].join('\n'));
    expect(res.diagnostics.map(d => d.message))
      .toContain("Cannot resolve module './does-not-exist.js'");
  });

  test('re-export from an untyped npm package surfaces names as Any', () => {
    const res = project.inferSource('reexportUntyped.js', [
      'export { foo, helper as h } from "anonpkg";',
    ].join('\n'));
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    const foo = res.exports.get('foo');
    const h = res.exports.get('h');
    expect(foo).toBeDefined();
    expect(h).toBeDefined();
    expect(schemeToString(foo!)).toBe('Any');
    expect(schemeToString(h!)).toBe('Any');
    expect(res.exports.has('helper')).toBe(false);
  });

  // --- 4. export * / export * as ns ---

  test('export * from a typed module re-exports all named bindings except default', () => {
    const res = project.inferSource('star.js', [
      "export * from './lib.js';",
    ].join('\n'));
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    expect(res.exports.has('one')).toBe(true);
    expect(res.exports.has('greet')).toBe(true);
    expect(res.exports.has('default')).toBe(false);
  });

  test('export * as ns bundles all exports into a namespace record', () => {
    const res = project.inferSource('starNs.js', [
      "export * as ns from './lib.js';",
    ].join('\n'));
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    const ns = res.exports.get('ns');
    expect(ns).toBeDefined();
    const shown = schemeToString(ns!);
    expect(shown).toContain('one');
    expect(shown).toContain('greet');
  });

  test('export * from an unresolvable module emits a diagnostic', () => {
    const res = project.inferSource('starUnresolved.js', [
      "export * from './nowhere.js';",
    ].join('\n'));
    expect(res.diagnostics.map(d => d.message))
      .toContain("Cannot resolve module './nowhere.js'");
  });

  test('export * as ns from an untyped npm package binds ns to Any', () => {
    const res = project.inferSource('starNsUntyped.js', [
      'export * as ns from "anonpkg";',
    ].join('\n'));
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    const ns = res.exports.get('ns');
    expect(ns).toBeDefined();
    expect(schemeToString(ns!)).toBe('Any');
  });

  test('export * from an untyped npm package is a silent no-op', () => {
    const res = project.inferSource('starUntyped.js', [
      'export * from "anonpkg";',
      'export const local = 1;',
    ].join('\n'));
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    expect(res.exports.has('local')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. + 6. Defensive branches, exercised via the exported module functions
// ---------------------------------------------------------------------------

describe('defensive branches in modules.ts', () => {
  test('inferExportDefaultDeclaration without a declaration returns [env, Void]', () => {
    const engine = freshEngine();
    const env = defaultEnv();
    const node = {
      type: 'ExportDefaultDeclaration',
      declaration: null,
      start: 0,
      end: 0,
    } as unknown as estree.ExportDefaultDeclaration;
    const [outEnv] = inferExportDefaultDeclaration(engine, node, env);
    expect(outEnv).toBe(env);
    expect(engine.exportedNames.has('default')).toBe(false);
  });

  test('class field initialiser that throws during inference is swallowed', () => {
    const engine = freshEngine();
    const env = defaultEnv();
    const ast = parseStrict(
      [
        'class C {',
        '  x = 1;',
        '  static { let y = 2; }',
        '}',
      ].join('\n'),
    ) as unknown as { body: estree.ClassDeclaration[] };
    const classNode = ast.body[0];

    // Force both the PropertyDefinition and StaticBlock walk into the
    // defensive catch handlers.
    (engine as unknown as Record<string, unknown>).inferExpression = () => {
      throw new Error('boom-expression');
    };
    (engine as unknown as Record<string, unknown>).inferStatement = () => {
      throw new Error('boom-statement');
    };

    const [newEnv, type] = inferClassDeclaration(engine, classNode, env);
    expect(type).toBeDefined();
    expect(newEnv.lookup('C')).toBeDefined();
  });
});
