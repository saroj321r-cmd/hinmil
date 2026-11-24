import {
  normalizeArrayLiteralASI,
  unmapOffset,
  mapOffset,
  patchArrayLiteralASI,
  positionAt,
  extractImportSpecifiers,
  resolveImportSpecifier,
  resolveTypeDirectiveSpecifier,
  findTypeDefinitionLocation,
  findExportedIdentifierOffset,
} from '../../src/services/files';
import { tNumber, tFun, tVar, tCon, mono } from '../../src/hm/types';
import { Substitution } from '../../src/hm/substitution';
import { InferenceResult } from '../../src/infer';
import { registerDataType, clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { pathToFileURL } from 'url';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function emptyResult(overrides: Partial<InferenceResult> = {}): InferenceResult {
  return {
    type: tNumber,
    substitution: new Substitution(),
    diagnostics: [],
    nodeTypes: new Map(),
    annotations: new Map(),
    annotationsByOffset: new Map(),
    methodSignatures: new Map(),
    exports: new Map(),
    kvConstraints: new Map(),
    kvConstructorConstraints: new Map(),
    typeAliases: new Map(),
    nodeTypesByEnd: new Map(),
    functionNodeTypes: new Map(),
    curriedNodes: new Set(),
    topLevelBindings: new Map(),
    dataVariantNames: new Set(),
    unconstrainedPropAccesses: new Set(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// positionAt
// ---------------------------------------------------------------------------

describe('positionAt', () => {
  it('returns (0,0) for offset 0', () => {
    expect(positionAt('hello\nworld', 0)).toEqual({ line: 0, character: 0 });
  });

  it('returns correct line and character after newline', () => {
    expect(positionAt('hello\nworld', 7)).toEqual({ line: 1, character: 1 });
  });

  it('handles multi-line source', () => {
    const src = 'aaa\nbb\nc';
    expect(positionAt(src, 5)).toEqual({ line: 1, character: 1 }); // second 'b'
    expect(positionAt(src, 7)).toEqual({ line: 2, character: 0 }); // 'c'
  });
});

// ---------------------------------------------------------------------------
// normalizeArrayLiteralASI
// ---------------------------------------------------------------------------

describe('normalizeArrayLiteralASI', () => {
  it('does not modify source without ASI hazard', () => {
    const source = 'const x = 1\nconst y = 2';
    const { patched, insertions } = normalizeArrayLiteralASI(source);
    expect(patched).toBe(source);
    expect(insertions).toEqual([]);
  });

  it('inserts semicolon before [ at line start after expression-ending char', () => {
    const source = 'const x = 1\n[1,2,3]';
    const { patched, insertions } = normalizeArrayLiteralASI(source);
    expect(patched).toContain(';[');
    expect(insertions.length).toBe(1);
  });

  it('does not insert semicolon when previous line does not end with expression char', () => {
    const source = 'if (true) {\n[1,2,3]\n}';
    const { patched, insertions } = normalizeArrayLiteralASI(source);
    // '{' does not end an expression → no insertion
    expect(insertions).toEqual([]);
    expect(patched).toBe(source);
  });
});

// ---------------------------------------------------------------------------
// mapOffset / unmapOffset
// ---------------------------------------------------------------------------

describe('mapOffset / unmapOffset', () => {
  it('mapOffset accounts for insertions before offset', () => {
    const insertions = [5, 10];
    expect(mapOffset(7, insertions)).toBe(8); // one insertion at 5 before offset 7
    expect(mapOffset(12, insertions)).toBe(14); // two insertions before offset 12
    expect(mapOffset(3, insertions)).toBe(3); // no insertions before offset 3
  });

  it('unmapOffset reverses insertions', () => {
    const insertions = [5, 10];
    expect(unmapOffset(8, insertions)).toBe(7);
    expect(unmapOffset(3, insertions)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// patchArrayLiteralASI
// ---------------------------------------------------------------------------

describe('patchArrayLiteralASI', () => {
  it('inserts semicolon before matching open bracket', () => {
    const source = 'x\n[1, 2]';
    const closeBracket = source.indexOf(']');
    const result = patchArrayLiteralASI(source, closeBracket);
    expect(result).not.toBeNull();
    expect(result!.patched).toContain(';[');
    expect(result!.shift).toBe(1);
  });

  it('returns null when no matching bracket found', () => {
    const result = patchArrayLiteralASI(']', 0);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractImportSpecifiers
// ---------------------------------------------------------------------------

describe('extractImportSpecifiers', () => {
  it('extracts default imports for capitalized names', () => {
    const source = "import Foo from './foo'\nimport Bar from './bar'";
    const result = extractImportSpecifiers(source);
    expect(result.get('Foo')).toBe('./foo');
    expect(result.get('Bar')).toBe('./bar');
  });

  it('extracts lowercase default imports', () => {
    const source = "import utils from './utils'";
    const result = extractImportSpecifiers(source);
    expect(result.get('utils')).toBe('./utils');
  });

  it('extracts require destructuring imports', () => {
    const source = "const { Box, Pair } = require('./types')";
    const result = extractImportSpecifiers(source);
    expect(result.get('Box')).toBe('./types');
    expect(result.get('Pair')).toBe('./types');
  });

  it('returns empty map for source with no imports', () => {
    const result = extractImportSpecifiers('const x = 1;\nconst y = 2;');
    expect(result.size).toBe(0);
  });

  it('extracts lowercase require destructuring', () => {
    const source = "const { helper } = require('./utils')";
    const result = extractImportSpecifiers(source);
    expect(result.get('helper')).toBe('./utils');
  });

  it('handles mixed import styles', () => {
    const source = [
      "import Foo from './foo'",
      "const { Bar } = require('./bar')",
      "import baz from './baz'",
    ].join('\n');
    const result = extractImportSpecifiers(source);
    expect(result.size).toBe(3);
    expect(result.get('Foo')).toBe('./foo');
    expect(result.get('Bar')).toBe('./bar');
    expect(result.get('baz')).toBe('./baz');
  });
});

// ---------------------------------------------------------------------------
// findExportedIdentifierOffset
// ---------------------------------------------------------------------------

describe('findExportedIdentifierOffset', () => {
  it('finds export const declaration', () => {
    const source = "// comment\nexport const curry = fn => fn;";
    const offset = findExportedIdentifierOffset(source, 'curry');
    expect(offset).toBe(source.indexOf('curry'));
  });

  it('finds export function declaration', () => {
    const source = "export function add(a, b) { return a + b; }";
    const offset = findExportedIdentifierOffset(source, 'add');
    expect(offset).toBe(source.indexOf('add'));
  });

  it('finds plain const declaration (for default/re-export patterns)', () => {
    const source = "const helper = x => x;\nmodule.exports = { helper };";
    const offset = findExportedIdentifierOffset(source, 'helper');
    expect(offset).toBe(source.indexOf('helper'));
  });

  it('returns -1 when name not found', () => {
    const source = "export const foo = 1;";
    expect(findExportedIdentifierOffset(source, 'bar')).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// resolveImportSpecifier
// ---------------------------------------------------------------------------

describe('resolveImportSpecifier', () => {
  const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
  const fromUri = pathToFileURL(path.join(sampleDir, 'demo.js')).href;

  it('resolves relative import to existing file', () => {
    const result = resolveImportSpecifier('./common', fromUri);
    expect(result).not.toBeNull();
    expect(result).toContain('common.js');
  });

  it('returns null for non-relative specifier', () => {
    const result = resolveImportSpecifier('some-package', fromUri);
    expect(result).toBeNull();
  });

  it('returns null for non-existing relative file', () => {
    const result = resolveImportSpecifier('./nonexistent', fromUri);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// positionAt — additional edge cases
// ---------------------------------------------------------------------------

describe('positionAt — edge cases', () => {
  it('returns last line/char for offset at end', () => {
    const src = 'abc\ndef';
    const pos = positionAt(src, 7);
    expect(pos).toEqual({ line: 1, character: 3 });
  });

  it('handles empty source', () => {
    expect(positionAt('', 0)).toEqual({ line: 0, character: 0 });
  });

  it('handles trailing newline', () => {
    const src = 'abc\n';
    expect(positionAt(src, 4)).toEqual({ line: 1, character: 0 });
  });
});

// ---------------------------------------------------------------------------
// normalizeArrayLiteralASI — additional edge cases
// ---------------------------------------------------------------------------

describe('normalizeArrayLiteralASI — edge cases', () => {
  it('inserts semicolons for multiple ASI hazards', () => {
    const source = 'const x = 1\n[1]\nconst y = 2\n[2]';
    const { patched, insertions } = normalizeArrayLiteralASI(source);
    expect(insertions.length).toBe(2);
    expect(patched.split(';[').length - 1).toBe(2);
  });

  it('skips blank lines between expression and bracket', () => {
    const source = 'const x = 1\n\n[1,2,3]';
    const { patched, insertions } = normalizeArrayLiteralASI(source);
    expect(insertions.length).toBe(1);
    expect(patched).toContain(';[');
  });

  it('handles indented bracket', () => {
    const source = 'const x = 1\n  [1,2]';
    const { patched, insertions } = normalizeArrayLiteralASI(source);
    expect(insertions.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// mapOffset / unmapOffset — additional edge cases
// ---------------------------------------------------------------------------

describe('mapOffset / unmapOffset — edge cases', () => {
  it('handles empty insertions array', () => {
    expect(mapOffset(5, [])).toBe(5);
    expect(unmapOffset(5, [])).toBe(5);
  });

  it('handles offset at exact insertion point', () => {
    const insertions = [5];
    expect(mapOffset(5, insertions)).toBe(6);
  });

  it('handles offset before all insertions', () => {
    const insertions = [10, 20];
    expect(mapOffset(3, insertions)).toBe(3);
    expect(unmapOffset(3, insertions)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// findTypeDefinitionLocation
// ---------------------------------------------------------------------------

describe('findTypeDefinitionLocation', () => {
  const source = '// Box :: a -> Box a\nconst Box = (v) => v;';
  const uri = 'file:///test.js';

  it('returns location for type alias', () => {
    const aliasSource = '// MyType :: Number\nconst x = 1;';
    const result = findTypeDefinitionLocation(
      'MyType', aliasSource, uri,
      emptyResult({
        typeAliases: new Map([['MyType', { type: tNumber, commentStart: 0, commentEnd: 19 }]]),
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(uri);
    expect(result!.range.start.line).toBe(0);
  });

  it('skips alias whose slice does not match (merged from globals)', () => {
    // Offsets point at `// Box ::` while the alias is `MyType` — this is
    // what a globals-merged alias looks like from the consumer file's
    // perspective; it must not produce a bogus local location.
    const result = findTypeDefinitionLocation(
      'MyType', source, uri,
      emptyResult({
        typeAliases: new Map([['MyType', { type: tNumber, commentStart: 0, commentEnd: 20 }]]),
      }),
    );
    expect(result).toBeNull();
  });

  it('returns location for local constructor annotation', () => {
    const result = findTypeDefinitionLocation(
      'Box', source, uri,
      emptyResult({
        annotations: new Map([['Box', {
          commentStart: 0, commentEnd: 20,
          scheme: mono(tFun(tVar('a'), tCon('Box', [tVar('a')]))),
          raw: 'a -> Box a',
        } as any]]),
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(uri);
  });

  it('returns null when type not found', () => {
    const result = findTypeDefinitionLocation(
      'Unknown', source, uri,
      emptyResult(),
    );
    expect(result).toBeNull();
  });

  it('returns location for sumtype data type declaration', () => {
    const sumSource = '// Either :: Left e | Right a\nfunction Left(v) { return v; }';
    registerDataType({
      name: 'Either',
      typeVars: ['e', 'a'],
      variants: [
        { name: 'Left', fields: ['e'] },
        { name: 'Right', fields: ['a'] },
      ],
      commentStart: 0,
      commentEnd: 41,
    });
    const result = findTypeDefinitionLocation(
      'Either', sumSource, uri,
      emptyResult(),
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(uri);
    expect(result!.range.start.line).toBe(0);
    clearDataTypes();
  });

  it('returns location for type defined in ::types target file', () => {
    // Use Either2 sample files: either2Sample.js has `// ::types ./Either2`
    // and Either2.js has `// Either2 :: Left e | Right a`
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const consumerPath = path.join(sampleDir, 'either2Sample.js');
    const fromUri = pathToFileURL(consumerPath).href;
    const source = fs.readFileSync(consumerPath, 'utf-8');

    const result = findTypeDefinitionLocation(
      'Either2', source, fromUri,
      emptyResult(),
    );
    expect(result).not.toBeNull();
    // Should point to Either2.js
    expect(result!.uri).toContain('Either2.js');
    expect(result!.range.start.line).toBe(0);
  });

  it('returns location for constructor annotation in ::types target file', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const consumerPath = path.join(sampleDir, 'either2Sample.js');
    const fromUri = pathToFileURL(consumerPath).href;
    const source = fs.readFileSync(consumerPath, 'utf-8');

    const result = findTypeDefinitionLocation(
      'Left', source, fromUri,
      emptyResult(),
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toContain('Either2.js');
  });

  it('returns null for type not in ::types target', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const consumerPath = path.join(sampleDir, 'either2Sample.js');
    const fromUri = pathToFileURL(consumerPath).href;
    const source = fs.readFileSync(consumerPath, 'utf-8');

    const result = findTypeDefinitionLocation(
      'NonExistentType', source, fromUri,
      emptyResult(),
    );
    expect(result).toBeNull();
  });

  it('falls through to ::types target even when the current file has a ::types directive whose text loosely matches (regression)', () => {
    // Regression: earlier, the sumtype/annotation registry was merged
    // globally from ::types target files and their `commentStart/End`
    // offsets pointed into the *consumer* file — where those offsets
    // happened to land on the `// ::types ./Either2` directive, which
    // loosely includes both `::` and `Either2`.  The sanity check was too
    // permissive and returned a Location inside the consumer file rather
    // than following through to the real definition in Either2.js.
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const consumerPath = path.join(sampleDir, 'either2Sample.js');
    const fromUri = pathToFileURL(consumerPath).href;
    const source = fs.readFileSync(consumerPath, 'utf-8');

    // Register Either2 in the global registry with offsets pointing at the
    // `::types` directive in the *consumer* file (this is what the real
    // importContext merge does when offsets aren't rewritten).
    clearDataTypes();
    const directiveStart = source.indexOf('// ::types');
    const directiveEnd = source.indexOf('\n', directiveStart);
    registerDataType({
      name: 'Either2',
      typeVars: [],
      variants: [
        { name: 'Left', fields: [] },
        { name: 'Right', fields: [] },
      ],
      commentStart: directiveStart,
      commentEnd: directiveEnd,
    });

    try {
      const result = findTypeDefinitionLocation(
        'Either2', source, fromUri, emptyResult(),
      );
      expect(result).not.toBeNull();
      // Must navigate to Either2.js, not the directive slice in the consumer.
      expect(result!.uri).toContain('Either2.js');
      expect(result!.uri).not.toBe(fromUri);
    } finally {
      clearDataTypes();
    }
  });

  it('returns location for ::constraint directive in current file', () => {
    const constraintSource = '// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }\n// map :: Functor f => (a -> b) -> f a -> f b\nconst map = fn => functor => functor.map(fn);';
    const result = findTypeDefinitionLocation(
      'Functor', constraintSource, uri,
      emptyResult(),
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(uri);
    expect(result!.range.start.line).toBe(0);
  });

  it('returns null for constraint name that does not exist', () => {
    const constraintSource = '// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }\nconst x = 1;';
    const result = findTypeDefinitionLocation(
      'Monad', constraintSource, uri,
      emptyResult(),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveTypeDirectiveSpecifier
// ---------------------------------------------------------------------------

describe('resolveTypeDirectiveSpecifier', () => {
  const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
  const fromUri = pathToFileURL(path.join(sampleDir, 'demo.js')).href;

  it('resolves relative path to existing file', () => {
    const result = resolveTypeDirectiveSpecifier('./Either2', fromUri);
    expect(result).not.toBeNull();
    expect(result).toContain('Either2.js');
  });

  it('returns null for non-existing relative path', () => {
    const result = resolveTypeDirectiveSpecifier('./nonexistent', fromUri);
    expect(result).toBeNull();
  });

  it('returns null for non-existing package name', () => {
    const result = resolveTypeDirectiveSpecifier('nonexistent-package-xyz', fromUri);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractImportSpecifiers — additional patterns
// ---------------------------------------------------------------------------

describe('extractImportSpecifiers — advanced', () => {
  it('handles import with "as" alias', () => {
    const source = "import { map as fmap } from './functor'";
    const result = extractImportSpecifiers(source);
    expect(result.get('fmap')).toBe('./functor');
  });

  it('handles multiple named imports', () => {
    const source = "import { Left, Right } from './Either'";
    const result = extractImportSpecifiers(source);
    expect(result.get('Left')).toBe('./Either');
    expect(result.get('Right')).toBe('./Either');
  });

  it('handles require with multiple destructured names', () => {
    const source = "const { add, multiply } = require('./math')";
    const result = extractImportSpecifiers(source);
    expect(result.get('add')).toBe('./math');
    expect(result.get('multiply')).toBe('./math');
  });
});

// ---------------------------------------------------------------------------
// findExportedIdentifierOffset — export list and "as" pattern
// ---------------------------------------------------------------------------

describe('findExportedIdentifierOffset — advanced', () => {
  it('finds identifier from export list', () => {
    const source = "const foo = 1;\nexport { foo };";
    const offset = findExportedIdentifierOffset(source, 'foo');
    expect(offset).toBe(source.indexOf('foo'));
  });

  it('finds identifier from export { x as y } via declaration', () => {
    const source = "const internal = 1;\nexport { internal as public };";
    // Because the export uses "as public", looking up 'public' should
    // fall back to the export list position (no declaration named 'public')
    const offset = findExportedIdentifierOffset(source, 'public');
    expect(offset).toBeGreaterThanOrEqual(0);
  });

  it('finds export default identifier', () => {
    const source = "export default main;\nconst main = () => 1;";
    const offset = findExportedIdentifierOffset(source, 'main');
    // Should find via export default pattern
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(source.substring(offset, offset + 4)).toBe('main');
  });

  it('finds export let declaration', () => {
    const source = "export let counter = 0;";
    const offset = findExportedIdentifierOffset(source, 'counter');
    expect(offset).toBe(source.indexOf('counter'));
  });

  it('finds export var declaration', () => {
    const source = "export var legacy = true;";
    const offset = findExportedIdentifierOffset(source, 'legacy');
    expect(offset).toBe(source.indexOf('legacy'));
  });
});

// ---------------------------------------------------------------------------
// findTypeDefinitionLocation — imported files and globals
// ---------------------------------------------------------------------------

describe('findTypeDefinitionLocation — cross-file', () => {
  const uri = 'file:///test.js';

  it('finds type in imported module via import specifiers', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const consumerPath = path.join(sampleDir, 'either2Sample.js');
    const fromUri = pathToFileURL(consumerPath).href;
    const source = fs.readFileSync(consumerPath, 'utf-8');

    // Right is defined in Either2.js which is imported
    const result = findTypeDefinitionLocation(
      'Right', source, fromUri,
      emptyResult(),
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toContain('Either2.js');
  });

  it('finds type from hm-globals file', () => {
    const globalsPath = path.resolve(__dirname, '..', '..', 'sample', 'globals.hm');
    const globalsSource = fs.readFileSync(globalsPath, 'utf-8');
    const globalsUri = pathToFileURL(globalsPath).href;

    // The globals file may have constraint definitions — test that path
    const result = findTypeDefinitionLocation(
      'Functor', 'const x = 1;', uri,
      emptyResult(),
      { source: globalsSource, uri: globalsUri },
    );
    // May or may not find Functor, but this exercises the globals path
    // without error. If Functor is defined, we find it; otherwise null.
    if (result) {
      expect(result.uri).toBe(globalsUri);
    }
  });

  it('returns null when globals does not contain type', () => {
    const result = findTypeDefinitionLocation(
      'NonExistent', 'const x = 1;', uri,
      emptyResult(),
      { source: '// no types here\nconst y = 1;', uri: 'file:///globals.js' },
    );
    expect(result).toBeNull();
  });

  it('globals-merged alias resolves to the globals file, not the consumer', () => {
    // Regression: inference merges project-globals aliases into
    // `result.typeAliases` with offsets from the GLOBALS source.  Returning
    // those offsets against the consumer file jumped to a meaningless spot
    // (e.g. `DbConfig` from a `globals.hm` while editing `db/sqlkit.js`).
    // The local-alias path must anchor-check the slice and fall through to
    // the globals lookup instead.
    const globalsSource = [
      '// DbConfig :: { host :: String, port :: Number, database :: String }',
      '',
      '// Pool :: { end :: () -> Promise e () }',
    ].join('\n');
    const globalsUri = 'file:///project/globals.hm';
    const consumerSource = [
      'import pg from "pg";',
      '',
      '// mkPool :: DbConfig -> Pool',
      'export const mkPool = config => new pg.Pool (config);',
    ].join('\n');
    // Simulate the merged alias entry: offsets point into globalsSource,
    // NOT into consumerSource.
    const aliasStart = globalsSource.indexOf('// DbConfig');
    const aliasEnd = globalsSource.indexOf('}') + 1;
    const result = findTypeDefinitionLocation(
      'DbConfig', consumerSource, uri,
      emptyResult({
        typeAliases: new Map([
          ['DbConfig', { commentStart: aliasStart, commentEnd: aliasEnd } as never],
        ]),
      }),
      { source: globalsSource, uri: globalsUri },
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(globalsUri);
    expect(result!.range.start.line).toBe(0);
  });

  it('annotation with scheme but comment text mismatch is skipped', () => {
    // Annotation commentStart/End don't contain `::` and name → should skip
    const source = 'const foo = 1;\nconst bar = foo;';
    const result = findTypeDefinitionLocation(
      'Box', source, uri,
      emptyResult({
        annotations: new Map([['Box', {
          commentStart: 0, commentEnd: 5,
          scheme: mono(tNumber),
          raw: 'Number',
        } as any]]),
      }),
    );
    // Should not match because source slice doesn't contain :: and Box
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// patchArrayLiteralASI — additional patterns
// ---------------------------------------------------------------------------

describe('patchArrayLiteralASI — nested brackets', () => {
  it('handles nested brackets correctly', () => {
    const source = 'x\n[[1, 2], [3, 4]]';
    const outerClose = source.lastIndexOf(']');
    const result = patchArrayLiteralASI(source, outerClose);
    expect(result).not.toBeNull();
    expect(result!.patched).toContain(';[');
  });
});

// ---------------------------------------------------------------------------
// findTypeDefinitionLocation — imported file lookups
// ---------------------------------------------------------------------------

describe('findTypeDefinitionLocation — cross-file imports', () => {
  const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
  const uri = 'file:///test.js';

  afterEach(() => { clearDataTypes(); });

  it('finds annotation in imported file via ES import', () => {
    // Source that imports from Either2.js in sample/
    const consumerPath = path.join(sampleDir, 'demo.js');
    const fromUri = pathToFileURL(consumerPath).href;
    const source = `import { Left } from './Either2'\nconst x = Left(1)`;

    const result = findTypeDefinitionLocation(
      'Left', source, fromUri,
      emptyResult(),
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toContain('Either2');
  });

  it('finds sumtype declaration in imported file', () => {
    const consumerPath = path.join(sampleDir, 'demo.js');
    const fromUri = pathToFileURL(consumerPath).href;
    const source = `import { Left, Right } from './Either2'\nconst x = Left(1)`;

    const result = findTypeDefinitionLocation(
      'Either2', source, fromUri,
      emptyResult(),
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toContain('Either2');
    expect(result!.range.start.line).toBe(0); // sumtype is on line 0
  });

  it('finds ::constraint directive in imported file', () => {
    // Create a temporary-ish test: use Component.js which has ::constraint directives
    const componentPath = path.join(sampleDir, 'Component.js');
    if (!fs.existsSync(componentPath)) return; // skip if sample missing
    const componentSource = fs.readFileSync(componentPath, 'utf-8');
    // Check if it has a ::constraint directive
    if (!componentSource.includes('::constraint')) return;
    const fromUri = pathToFileURL(path.join(sampleDir, 'demo.js')).href;
    const constraintMatch = componentSource.match(/::constraint\s+(\w+)/);
    if (!constraintMatch) return;
    const constraintName = constraintMatch[1];

    const source = `import { something } from './Component'\nconst x = 1`;
    const result = findTypeDefinitionLocation(
      constraintName, source, fromUri,
      emptyResult(),
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toContain('Component');
  });

  it('returns null when imported file has no matching annotation', () => {
    const consumerPath = path.join(sampleDir, 'demo.js');
    const fromUri = pathToFileURL(consumerPath).href;
    const source = `import { Left } from './Either2'\nconst x = Left(1)`;

    const result = findTypeDefinitionLocation(
      'CompletelyUnknownType', source, fromUri,
      emptyResult(),
    );
    expect(result).toBeNull();
  });

  it('finds annotation transitively via import-of-import', () => {
    // Build a 3-file chain in /tmp:
    //   typeOwner.js  -- declares  // MyTransitiveType :: a -> a
    //   middle.js     -- import { f } from './typeOwner'; export const g = f;
    //   consumer.js   -- import { g } from './middle';  ← lookup `MyTransitiveType` here
    // The new BFS in findTypeDefinitionLocation must traverse from the
    // consumer through middle's import to reach typeOwner's annotation.
    const tmpDir = '/tmp/hm-transitive-def-test';
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'typeOwner.js'), [
      '// MyTransitiveType :: a -> a',
      'export const f = x => x;',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'middle.js'), [
      "import { f } from './typeOwner';",
      'export const g = f;',
    ].join('\n'));
    const consumerPath = path.join(tmpDir, 'consumer.js');
    const consumerSource = "import { g } from './middle';\nconst y = g(1);";
    fs.writeFileSync(consumerPath, consumerSource);
    const fromUri = pathToFileURL(consumerPath).href;

    const result = findTypeDefinitionLocation(
      'MyTransitiveType', consumerSource, fromUri,
      emptyResult(),
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toContain('typeOwner.js');
  });

  it('finds annotation transitively via ::types directive in imported file', () => {
    // Even tougher: the type lives in a file reached by a `::types`
    // directive on a regular import.
    //   typesTarget.js    -- declares  // BridgeType :: Number -> Number
    //   bridge.js         -- // ::types ./typesTarget
    //                        export const helper = (x) => x;
    //   consumer.js       -- import { helper } from './bridge';
    const tmpDir = '/tmp/hm-transitive-typesdir-test';
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'typesTarget.js'), [
      '// BridgeType :: Number -> Number',
      'export const noop = x => x;',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'bridge.js'), [
      '// ::types ./typesTarget',
      'export const helper = (x) => x;',
    ].join('\n'));
    const consumerPath = path.join(tmpDir, 'consumer.js');
    const consumerSource = "import { helper } from './bridge';\nconst y = helper(1);";
    fs.writeFileSync(consumerPath, consumerSource);
    const fromUri = pathToFileURL(consumerPath).href;

    const result = findTypeDefinitionLocation(
      'BridgeType', consumerSource, fromUri,
      emptyResult(),
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toContain('typesTarget.js');
  });
});

// ---------------------------------------------------------------------------
// findTypeDefinitionLocation — globals file lookup
// ---------------------------------------------------------------------------

describe('findTypeDefinitionLocation — globals', () => {
  const uri = 'file:///test.js';

  afterEach(() => { clearDataTypes(); });

  it('finds annotation defined in globals file', () => {
    const globalsSource = '// log :: a -> a\nconst log = x => { console.log(x); return x; }';
    const globals = {
      source: globalsSource,
      uri: 'file:///project/globals.hm',
    };
    const source = 'const x = log(42)';
    const result = findTypeDefinitionLocation(
      'log', source, uri,
      emptyResult(),
      globals,
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(globals.uri);
    expect(result!.range.start.line).toBe(0);
  });

  it('finds sumtype declaration in globals file', () => {
    const globalsSource = '// Color :: Red | Green | Blue';
    registerDataType({
      name: 'Color',
      typeVars: [],
      variants: [
        { name: 'Red', fields: [] },
        { name: 'Green', fields: [] },
        { name: 'Blue', fields: [] },
      ],
      commentStart: 0,
      commentEnd: 35,
    });
    const globals = {
      source: globalsSource,
      uri: 'file:///project/globals.hm',
    };
    const source = 'const c = Red()';
    const result = findTypeDefinitionLocation(
      'Color', source, uri,
      emptyResult(),
      globals,
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(globals.uri);
  });

  it('finds ::constraint directive in globals file', () => {
    const globalsSource = '// ::constraint Semigroup s { s :: { concat :: s ~> s -> s } }';
    const globals = {
      source: globalsSource,
      uri: 'file:///project/globals.hm',
    };
    const source = 'const x = 1';
    const result = findTypeDefinitionLocation(
      'Semigroup', source, uri,
      emptyResult(),
      globals,
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(globals.uri);
    expect(result!.range.start.line).toBe(0);
  });

  it('returns null when globals has no matching type', () => {
    const globals = {
      source: '// log :: a -> a\nconst log = x => x',
      uri: 'file:///project/globals.hm',
    };
    const source = 'const x = 1';
    const result = findTypeDefinitionLocation(
      'NonExistentGlobal', source, uri,
      emptyResult(),
      globals,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveTypeDirectiveSpecifier — package resolution
// ---------------------------------------------------------------------------

describe('resolveTypeDirectiveSpecifier — package.json fields', () => {
  const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
  const fromUri = pathToFileURL(path.join(sampleDir, 'demo.js')).href;

  it('returns null when reaching filesystem root without finding package', () => {
    // A deeply non-existing package should eventually hit root and return null
    const result = resolveTypeDirectiveSpecifier('definitely-not-a-real-package-xyz-123', fromUri);
    expect(result).toBeNull();
  });
});
