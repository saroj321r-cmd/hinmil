// Regression tests for cross-module member-access through the
// `fieldSchemes` mechanism on TRecord, AND for preservation of scheme
// metadata (constraints, narrowing predicates) through the
// `buildExportMap` pipeline.
//
// Two specific behaviours covered:
//
//  1. When a value file does `export const Param = {}; export const Query =
//     Param.Query = (…) => …;` with a chained annotation
//     `// Query :: Param.Query :: (String|Number) b => …`, an importing
//     file using EITHER `Query(...)` directly OR `P.Query(...)` (where
//     `import { Param as P } from …`) must see the same union-constraint
//     diagnostic when the call's array argument violates it.
//
//  2. The constraint must survive `applySubstToScheme` → `generalize`:
//     before this fix `generalize` reconstructed the Scheme without
//     copying `constraints`/`typePredicate`, dropping the constraint at
//     the export boundary so that `Query("k", [true], …)` from another
//     module silently passed.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { resetTypeVarCounter } from '../../src/hm/types';

const tmpRoot = '/tmp/hm-cross-module-param-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  writeFile('Param.js', [
    '// Param :: Path a b c | Query a b c',
    'export const Param = {};',
    '',
    '// Path :: Param.Path :: (a, [b], c) -> Param a b c',
    'export const Path = Param.Path = (key, rules, defaultValue) => key;',
    '',
    '// Query :: Param.Query :: (String | Number) b => (a, [b], c) -> Param a b c',
    'export const Query = Param.Query = (key, rules, defaultValue) => key;',
    '',
  ].join('\n'));
});

beforeEach(() => resetTypeVarCounter());

function inferConsumer(source: string): string[] {
  const consumerPath = writeFile('consumer.js', source);
  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  const resolver = ctx.createImportResolver(fileUri);
  const typeResolver = ctx.createTypeDirectiveResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const eng = new InferenceEngine();
  const r = eng.infer(source, undefined, resolver, typeResolver, aliasResolver);
  return r.diagnostics.map(d => d.message);
}

describe('cross-module Param: imported scheme preserves constraints', () => {
  test('direct `Query(…, [Boolean], …)` from importing file fires union-constraint diag', () => {
    const diags = inferConsumer([
      'import { Query } from "./Param";',
      'const r = Query("k", ["2", true], undefined);',
    ].join('\n'));
    const violations = diags.filter(d => d.includes('does not satisfy union constraint'));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(d => d.includes("'Boolean'"))).toBe(true);
  });

  test('aliased `P.Query(…, [Boolean], …)` (import { Param as P }) also fires the diag', () => {
    const diags = inferConsumer([
      'import { Param as P } from "./Param";',
      'const r = P.Query("k", ["2", true], undefined);',
    ].join('\n'));
    const violations = diags.filter(d => d.includes('does not satisfy union constraint'));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(d => d.includes("'Boolean'"))).toBe(true);
  });

  test('direct and aliased member-access produce the same number of constraint diagnostics', () => {
    const direct = inferConsumer([
      'import { Query } from "./Param";',
      'const r = Query("k", ["2", true], undefined);',
    ].join('\n')).filter(d => d.includes('does not satisfy union constraint'));
    const aliased = inferConsumer([
      'import { Param as P } from "./Param";',
      'const r = P.Query("k", ["2", true], undefined);',
    ].join('\n')).filter(d => d.includes('does not satisfy union constraint'));
    expect(direct.length).toBe(aliased.length);
  });

  test('Path (no constraint, free [b]) accepts heterogeneous [1, "3"] from importing file', () => {
    const diags = inferConsumer([
      'import { Path, Param as P } from "./Param";',
      'const a = Path("k", [1, "3"], undefined);',
      'const b = P.Path("k", [1, "3"], undefined);',
    ].join('\n'));
    expect(diags.filter(d => d.includes('Cannot unify'))).toEqual([]);
  });

  test('valid call with all-Number array does NOT fire the constraint diag', () => {
    const diags = inferConsumer([
      'import { Query, Param as P } from "./Param";',
      'const a = Query("k", [1, 2], undefined);',
      'const b = P.Query("k", [1, 2], undefined);',
    ].join('\n'));
    expect(diags.filter(d => d.includes('does not satisfy union constraint'))).toEqual([]);
  });
});
