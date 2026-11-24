import {
  scanWord,
  getIdentifierAt,
  resolveValidIdent,
  collectConstraintInfo,
  validIdentLooksLikeArrayMethod,
  getWordAt,
  isOffsetInAnnotation,
  isOffsetInAnyAnnotation,
  isOffsetInComment,
  getNarrowDirectiveTypeAtOffset,
  isOffsetInConstraintDirective,
  getAliasHoverAtOffset,
  buildHover,
  buildConstraintHover,
  prototypeToHashName,
  tryArrayLiteralReinfer,
  wrapLongRecord,
  wrapHmBlocks,
  HoverContext,
} from '../../src/services/hover';
import {
  tVar, tCon, tFun, tNumber, tString, tBool, kvName, tRecord, tUnion,
  mono, prettyTypeToString,
  Type,
} from '../../src/hm/types';
import { Substitution } from '../../src/hm/substitution';
import { InferenceResult } from '../../src/infer';
import * as path from 'path';
import { pathToFileURL } from 'url';

// ---------------------------------------------------------------------------
// Helper — build a minimal InferenceResult for tests
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
// scanWord
// ---------------------------------------------------------------------------

describe('scanWord', () => {
  it('returns word boundaries at offset inside a word', () => {
    const result = scanWord('hello world', 2);
    expect(result).toEqual({ start: 0, end: 5 });
  });

  it('includes trailing boundary character (word extends left)', () => {
    const result = scanWord('hello world', 5);
    // offset 5 is the space; scanWord scans left to find the word boundary
    expect(result).toEqual({ start: 0, end: 5 });
  });

  it('handles offset at start of word', () => {
    const result = scanWord('foo bar', 4);
    expect(result).toEqual({ start: 4, end: 7 });
  });

  it('returns null for empty string', () => {
    expect(scanWord('', 0)).toBeNull();
  });

  it('returns null when offset is on non-word character', () => {
    expect(scanWord('a + b', 2)).toBeNull();
  });

  it('handles $ and _ in identifiers', () => {
    const result = scanWord('$_foo$bar_', 5);
    expect(result).toEqual({ start: 0, end: 10 });
  });

  it('handles offset at the very end of source', () => {
    const result = scanWord('abc', 3);
    expect(result).toEqual({ start: 0, end: 3 });
  });

  it('handles offset beyond source length', () => {
    const result = scanWord('abc', 10);
    // scanWord does not clamp end to source length
    expect(result).toEqual({ start: 0, end: 10 });
  });
});

// ---------------------------------------------------------------------------
// getIdentifierAt
// ---------------------------------------------------------------------------

describe('getIdentifierAt', () => {
  it('returns identifier at offset', () => {
    expect(getIdentifierAt('const foo = 1', 7)).toBe('foo');
  });

  it('returns null when offset is not on identifier', () => {
    expect(getIdentifierAt('const foo = 1', 10)).toBeNull(); // on '='
  });

  it('returns dotted name for property access', () => {
    expect(getIdentifierAt('Box.map(x)', 5)).toBe('Box.map');
  });

  it('returns simple name when no dot precedes', () => {
    expect(getIdentifierAt('map(x)', 1)).toBe('map');
  });

  it('returns null for empty string', () => {
    expect(getIdentifierAt('', 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveValidIdent
// ---------------------------------------------------------------------------

describe('resolveValidIdent', () => {
  it('resolves dotted property access to full qualified name', () => {
    const result = resolveValidIdent('obj.prop', 5);
    expect(result).toBe('obj.prop');
  });

  it('returns digits as-is (no filtering)', () => {
    expect(resolveValidIdent('123', 1)).toBe('123');
  });

  it('returns null for JS keywords', () => {
    expect(resolveValidIdent('const x = 1', 2)).toBeNull();
    expect(resolveValidIdent('return 42', 3)).toBeNull();
    expect(resolveValidIdent('function f() {}', 4)).toBeNull();
  });

  it('returns null for true/false/null/undefined', () => {
    expect(resolveValidIdent('true', 1)).toBeNull();
    expect(resolveValidIdent('false', 1)).toBeNull();
    expect(resolveValidIdent('null', 1)).toBeNull();
    expect(resolveValidIdent('undefined', 3)).toBeNull();
  });

  it('allows non-keyword identifiers', () => {
    expect(resolveValidIdent('myVar', 2)).toBe('myVar');
    expect(resolveValidIdent('foo', 1)).toBe('foo');
  });

  it('allows keyword-named properties in dot access', () => {
    // "obj.default" — "default" is a keyword but valid as a property name
    expect(resolveValidIdent('obj.default', 8)).toBe('obj.default');
  });

  it('returns dotted name when bare ident is not keyword', () => {
    expect(resolveValidIdent('obj.value', 6)).toBe('obj.value');
  });
});

// ---------------------------------------------------------------------------
// collectConstraintInfo
// ---------------------------------------------------------------------------

describe('collectConstraintInfo', () => {
  it('returns empty array for non-kv type', () => {
    const result = collectConstraintInfo(tNumber, new Map());
    expect(result).toEqual([]);
  });

  it('collects constraint names for kv type', () => {
    const varId = 42;
    const t = tCon(kvName('f', varId), [tVar('a')]);
    const kvConstraints = new Map<number, string[]>([[varId, ['Functor', 'Monad']]]);
    const result = collectConstraintInfo(t, kvConstraints);
    expect(result).toContain('Functor f');
    expect(result).toContain('Monad f');
  });

  it('collects recursively from function types', () => {
    const varId = 10;
    const inner = tCon(kvName('f', varId), [tVar('a')]);
    const t = tFun(inner, tNumber);
    const kvConstraints = new Map<number, string[]>([[varId, ['Applicative']]]);
    const result = collectConstraintInfo(t, kvConstraints);
    expect(result).toContain('Applicative f');
  });

  it('de-duplicates constraint entries', () => {
    const varId = 5;
    const inner = tCon(kvName('f', varId), [tVar('a')]);
    // f a -> f a — same kv appears twice
    const t = tFun(inner, inner);
    const kvConstraints = new Map<number, string[]>([[varId, ['Functor']]]);
    const result = collectConstraintInfo(t, kvConstraints);
    expect(result).toEqual(['Functor f']);
  });

  it('collects from record field types', () => {
    const varId = 7;
    const inner = tCon(kvName('m', varId), [tString]);
    const t = tRecord({ field: inner });
    const kvConstraints = new Map<number, string[]>([[varId, ['Monad']]]);
    const result = collectConstraintInfo(t, kvConstraints);
    expect(result).toContain('Monad m');
  });

  it('returns empty when kv has no constraints', () => {
    const varId = 99;
    const t = tCon(kvName('f', varId), [tVar('a')]);
    const result = collectConstraintInfo(t, new Map());
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validIdentLooksLikeArrayMethod
// ---------------------------------------------------------------------------

describe('validIdentLooksLikeArrayMethod', () => {
  it('returns true for .map after bracket', () => {
    expect(validIdentLooksLikeArrayMethod('[1,2].map', 7)).toBe(true);
  });

  it('returns false for non-array method context', () => {
    expect(validIdentLooksLikeArrayMethod('obj.map', 5)).toBe(false);
  });

  it('returns false when only dot but no bracket before', () => {
    expect(validIdentLooksLikeArrayMethod('x.map', 3)).toBe(false);
  });

  it('handles nested brackets', () => {
    expect(validIdentLooksLikeArrayMethod('a[0].map', 6)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getWordAt
// ---------------------------------------------------------------------------

describe('getWordAt', () => {
  it('returns word at offset', () => {
    expect(getWordAt('hello world', 2)).toBe('hello');
  });

  it('returns word even at boundary (space included in scan)', () => {
    expect(getWordAt('hello world', 5)).toBe('hello');
  });

  it('returns null for non-word position', () => {
    expect(getWordAt('a + b', 2)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(getWordAt('', 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isOffsetInAnnotation
// ---------------------------------------------------------------------------

describe('isOffsetInAnnotation', () => {
  it('returns true when offset is inside an annotation range', () => {
    const annotations = new Map([['foo', { commentStart: 10, commentEnd: 20 }]]);
    expect(isOffsetInAnnotation(annotations, 15)).toBe(true);
  });

  it('returns false when offset is outside all annotations', () => {
    const annotations = new Map([['foo', { commentStart: 10, commentEnd: 20 }]]);
    expect(isOffsetInAnnotation(annotations, 5)).toBe(false);
    expect(isOffsetInAnnotation(annotations, 25)).toBe(false);
  });

  it('returns true at exact boundary (start)', () => {
    const annotations = new Map([['foo', { commentStart: 10, commentEnd: 20 }]]);
    expect(isOffsetInAnnotation(annotations, 10)).toBe(true);
  });

  it('returns true at exact boundary (end)', () => {
    const annotations = new Map([['foo', { commentStart: 10, commentEnd: 20 }]]);
    expect(isOffsetInAnnotation(annotations, 20)).toBe(true);
  });

  it('returns false for empty annotation map', () => {
    expect(isOffsetInAnnotation(new Map(), 5)).toBe(false);
  });

  it('checks multiple annotations', () => {
    const annotations = new Map([
      ['foo', { commentStart: 0, commentEnd: 5 }],
      ['bar', { commentStart: 20, commentEnd: 30 }],
    ]);
    expect(isOffsetInAnnotation(annotations, 3)).toBe(true);
    expect(isOffsetInAnnotation(annotations, 10)).toBe(false);
    expect(isOffsetInAnnotation(annotations, 25)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isOffsetInAnyAnnotation
// ---------------------------------------------------------------------------

describe('isOffsetInAnyAnnotation', () => {
  it('returns true for named annotations', () => {
    const annotations = new Map([['foo', { commentStart: 10, commentEnd: 20 }]]);
    expect(isOffsetInAnyAnnotation(annotations, new Map(), 15)).toBe(true);
  });

  it('returns true for anonymous annotations in annotationsByOffset', () => {
    const annotations = new Map<string, { commentStart: number; commentEnd: number }>();
    const byOffset = new Map([[50, { commentStart: 30, commentEnd: 45 }]]);
    expect(isOffsetInAnyAnnotation(annotations, byOffset, 35)).toBe(true);
  });

  it('returns false when offset is outside all annotations', () => {
    const annotations = new Map([['foo', { commentStart: 5, commentEnd: 10 }]]);
    const byOffset = new Map([[50, { commentStart: 30, commentEnd: 45 }]]);
    expect(isOffsetInAnyAnnotation(annotations, byOffset, 20)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isOffsetInComment
// ---------------------------------------------------------------------------

describe('isOffsetInComment', () => {
  it('returns true when offset is inside a line comment', () => {
    const source = '// :: String -> Box Boolean\nconst x = 1;';
    expect(isOffsetInComment(source, 15)).toBe(true); // on "Box"
  });

  it('returns false when offset is in code', () => {
    const source = '// :: String -> Box Boolean\nconst x = 1;';
    expect(isOffsetInComment(source, 34)).toBe(false); // on "x"
  });

  it('returns true when offset is inside a block comment', () => {
    const source = '/* :: String -> Boolean */\nconst x = 1;';
    expect(isOffsetInComment(source, 15)).toBe(true);
  });

  it('returns false after a block comment closes', () => {
    const source = '/* comment */ const x = 1;';
    expect(isOffsetInComment(source, 20)).toBe(false);
  });

  it('detects anonymous annotation comment before arrow function', () => {
    const source = 'ex6(\n  // :: String -> Box Boolean\n  x => Box(true),\n)';
    const boxOffset = source.indexOf('Box Boolean') + 4; // on "Boolean"
    expect(isOffsetInComment(source, boxOffset)).toBe(true);
    const codeBoxOffset = source.indexOf('Box(true)'); // on "Box" in code
    expect(isOffsetInComment(source, codeBoxOffset)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getNarrowDirectiveTypeAtOffset
// ---------------------------------------------------------------------------

describe('getNarrowDirectiveTypeAtOffset', () => {
  it('returns type name when cursor is on ::narrow directive', () => {
    const source = '// ::narrow String\n// isString :: a -> Boolean';
    // cursor on "String" (offset 11 = start of "String")
    expect(getNarrowDirectiveTypeAtOffset(source, 11)).toBe('String');
  });

  it('returns type name when cursor is on ::narrow keyword', () => {
    const source = '// ::narrow Person\n// isPerson :: a -> Boolean';
    // cursor on "::narrow" part (offset 3)
    expect(getNarrowDirectiveTypeAtOffset(source, 3)).toBe('Person');
  });

  it('returns null when cursor is outside ::narrow directive', () => {
    const source = '// ::narrow String\n// isString :: a -> Boolean';
    // cursor on the annotation line (offset 20)
    expect(getNarrowDirectiveTypeAtOffset(source, 20)).toBeNull();
  });

  it('returns null when no ::narrow directive exists', () => {
    const source = '// isString :: a -> Boolean\nconst isString = x => typeof x === "string";';
    expect(getNarrowDirectiveTypeAtOffset(source, 5)).toBeNull();
  });

  it('handles multiple ::narrow directives', () => {
    const source = '// ::narrow String\n// isString :: a -> Boolean\n\n// ::narrow Number\n// isNumber :: a -> Boolean';
    // cursor on first "String"
    expect(getNarrowDirectiveTypeAtOffset(source, 11)).toBe('String');
    // cursor on second "Number" (offset of "// ::narrow Number" = 47, "Number" starts at 58)
    const secondNarrowIdx = source.indexOf('// ::narrow Number');
    expect(getNarrowDirectiveTypeAtOffset(source, secondNarrowIdx + 11)).toBe('Number');
  });
});

// ---------------------------------------------------------------------------
// isOffsetInConstraintDirective
// ---------------------------------------------------------------------------

describe('isOffsetInConstraintDirective', () => {
  it('returns true when offset is inside a ::constraint directive', () => {
    const source = '// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }\nconst x = 1;';
    // offset on "Functor" (starts at 15)
    expect(isOffsetInConstraintDirective(source, 15)).toBe(true);
  });

  it('returns false when offset is outside all ::constraint directives', () => {
    const source = '// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }\nconst x = 1;';
    // offset in code area (directive is 68 chars + newline = 69; 75 lands inside `const x = 1;`)
    expect(isOffsetInConstraintDirective(source, 75)).toBe(false);
  });

  it('returns false when no ::constraint directives exist', () => {
    const source = '// foo :: Number -> Number\nconst foo = x => x;';
    expect(isOffsetInConstraintDirective(source, 5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAliasHoverAtOffset
// ---------------------------------------------------------------------------

describe('getAliasHoverAtOffset', () => {
  const dummyResolve = () => null;
  const dummyExtract = () => new Map<string, string>();

  it('returns null when word is not capitalized', () => {
    const result = getAliasHoverAtOffset(
      '// :: foo', 5,
      emptyResult({ annotations: new Map([['foo', { commentStart: 0, commentEnd: 9 } as any]]) }),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).toBeNull();
  });

  it('returns null when offset is not inside an annotation comment', () => {
    const result = getAliasHoverAtOffset(
      'const Foo = 1', 6,
      emptyResult(),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).toBeNull();
  });

  it('returns hover for type alias in annotation', () => {
    const source = '// :: MyType -> Number\nconst f = (x) => x';
    const result = getAliasHoverAtOffset(
      source, 8, // on "MyType" (starts at offset 6)
      emptyResult({
        annotations: new Map([['f', { commentStart: 0, commentEnd: 21 } as any]]),
        typeAliases: new Map([['MyType', { type: tRecord({ x: tNumber }), commentStart: 0, commentEnd: 10 }]]),
      }),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).not.toBeNull();
    expect(result!.contents).toHaveProperty('value');
    expect((result!.contents as any).value).toContain('MyType');
  });

  it('returns hover for constructor annotation in current file', () => {
    const source = '// :: Box a -> a\nconst unbox = (b) => b.value';
    const result = getAliasHoverAtOffset(
      source, 6, // on "Box" (starts at offset 5)
      emptyResult({
        annotations: new Map([
          ['unbox', { commentStart: 0, commentEnd: 16 } as any],
          ['Box', { commentStart: 0, commentEnd: 16, scheme: mono(tFun(tVar('a'), tCon('Box', [tVar('a')]))), raw: 'a -> Box a' } as any],
        ]),
      }),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).not.toBeNull();
    expect((result!.contents as any).value).toContain('Box');
    expect((result!.contents as any).value).toContain('a -> Box a');
  });

  it('returns null when word is not a known type alias or constructor', () => {
    const source = '// :: Unknown -> Number';
    const result = getAliasHoverAtOffset(
      source, 5, // on "Unknown"
      emptyResult({
        annotations: new Map([['f', { commentStart: 0, commentEnd: 22 } as any]]),
      }),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).toBeNull();
  });

  it('shows built-in type hover for Boolean in annotation', () => {
    const source = '// :: a -> Boolean\nconst f = (x) => true';
    const boolOffset = source.indexOf('Boolean');
    const result = getAliasHoverAtOffset(
      source, boolOffset + 1,
      emptyResult({
        annotations: new Map([['f', { commentStart: 0, commentEnd: 18 } as any]]),
      }),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).not.toBeNull();
    expect((result!.contents as any).value).toContain('Boolean');
    expect((result!.contents as any).value).toContain(':: Type');
  });

  it('shows built-in type hover for Number in annotation', () => {
    const source = '// :: Number -> String\nconst f = (x) => ""';
    const numberOffset = source.indexOf('Number');
    const result = getAliasHoverAtOffset(
      source, numberOffset + 1, // on "Number"
      emptyResult({
        annotations: new Map([['f', { commentStart: 0, commentEnd: 21 } as any]]),
      }),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).not.toBeNull();
    expect((result!.contents as any).value).toContain('Number');
    expect((result!.contents as any).value).toContain(':: Type');
  });

  it('shows built-in type hover in anonymous annotation comment', () => {
    const source = 'ex6(\n  // :: String -> Box Boolean\n  x => Box(true),\n)';
    const booleanOffset = source.indexOf('Boolean');
    const result = getAliasHoverAtOffset(
      source, booleanOffset + 1, // on "Boolean" inside anonymous annotation
      emptyResult(),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).not.toBeNull();
    expect((result!.contents as any).value).toContain('Boolean');
    expect((result!.contents as any).value).toContain(':: Type');
  });

  // -------------------------------------------------------------------------
  // findTypeDefinitions fallback (sidecar / globals lookup)
  // -------------------------------------------------------------------------

  it('shows hover from findTypeDefinitions when name is not in result.annotations', () => {
    const source = '// updateBy :: Prop a -> b\nconst updateBy = p => p;';
    const propOffset = source.indexOf('Prop');
    const find = (name: string) => name === 'Prop'
      ? [{ raw: '(String, a) -> Prop b', origin: 'sqlkit', sourcePath: '/x/sqlkit.hm', commentStart: 0, commentEnd: 0 }]
      : [];
    const result = getAliasHoverAtOffset(
      source, propOffset + 1,
      emptyResult({ annotations: new Map([['updateBy', { commentStart: 0, commentEnd: 26 } as any]]) }),
      'file:///test.js', dummyResolve, dummyExtract, find,
    );
    expect(result).not.toBeNull();
    const value = (result!.contents as any).value as string;
    expect(value).toContain('Prop :: (String, a) -> Prop b');
    expect(value).toContain('from sqlkit');
  });

  it('shows ambiguity hint when findTypeDefinitions returns multiple definitions', () => {
    const source = '// f :: Prop a -> a\nconst f = p => p;';
    const propOffset = source.indexOf('Prop');
    const find = () => [
      { raw: '(String, a) -> Prop b',  origin: 'sqlkit',     sourcePath: '/x/sqlkit.hm', commentStart: 0, commentEnd: 0 },
      { raw: '(Number, a) -> Prop b',  origin: 'other-lib', sourcePath: '/x/other.hm', commentStart: 0, commentEnd: 0 },
    ];
    const result = getAliasHoverAtOffset(
      source, propOffset + 1,
      emptyResult({ annotations: new Map([['f', { commentStart: 0, commentEnd: 19 } as any]]) }),
      'file:///test.js', dummyResolve, dummyExtract, find,
    );
    const value = (result!.contents as any).value as string;
    // Primary is the first entry
    expect(value).toContain('Prop :: (String, a) -> Prop b');
    // Other is listed
    expect(value).toContain('(Number, a) -> Prop b');
    expect(value).toContain('other-lib');
    expect(value).toContain('Multiple definitions found');
    expect(value).toContain('::prefer Prop from <source>');
  });

  it('honours ::prefer directive to select the primary definition', () => {
    const source = `// ::prefer Prop from other-lib
// f :: Prop a -> a
const f = p => p;`;
    const propOffset = source.indexOf('Prop a');
    const find = () => [
      { raw: '(String, a) -> Prop b',  origin: 'sqlkit',     sourcePath: '/x/sqlkit.hm', commentStart: 0, commentEnd: 0 },
      { raw: '(Number, a) -> Prop b',  origin: 'other-lib', sourcePath: '/x/other.hm', commentStart: 0, commentEnd: 0 },
    ];
    const result = getAliasHoverAtOffset(
      source, propOffset + 1,
      emptyResult({ annotations: new Map([['f', { commentStart: 32, commentEnd: 51 } as any]]) }),
      'file:///test.js', dummyResolve, dummyExtract, find,
    );
    const value = (result!.contents as any).value as string;
    // Primary line shows the preferred one
    expect(value.split('\n\n')[0]).toContain('(Number, a) -> Prop b');
    expect(value).toContain('active preference');
    expect(value).toContain('::prefer Prop from other-lib');
  });

  it('multi-name ::prefer applies to each declared name', () => {
    const source = `// ::prefer Prop, Table from sqlkit
// f :: Table a
const f = p => p;`;
    const tableOffset = source.indexOf('Table a');
    const find = (name: string) => name === 'Table'
      ? [
          { raw: 'Object', origin: 'other-lib', sourcePath: '/x/o.hm', commentStart: 0, commentEnd: 0 },
          { raw: '{ name :: String }', origin: 'sqlkit', sourcePath: '/x/r.hm', commentStart: 0, commentEnd: 0 },
        ]
      : [];
    const result = getAliasHoverAtOffset(
      source, tableOffset + 1,
      emptyResult({ annotations: new Map([['f', { commentStart: 35, commentEnd: 50 } as any]]) }),
      'file:///test.js', dummyResolve, dummyExtract, find,
    );
    const value = (result!.contents as any).value as string;
    expect(value.split('\n\n')[0]).toContain('{ name :: String }');
    expect(value).toContain('active preference');
  });

  it('returns null when findTypeDefinitions has no matches', () => {
    const source = '// f :: WhoKnows a -> a\nconst f = p => p;';
    const offset = source.indexOf('WhoKnows') + 1;
    const find = () => [];
    const result = getAliasHoverAtOffset(
      source, offset,
      emptyResult({ annotations: new Map([['f', { commentStart: 0, commentEnd: 23 } as any]]) }),
      'file:///test.js', dummyResolve, dummyExtract, find,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildHover
// ---------------------------------------------------------------------------

describe('buildHover', () => {
  function makeCtx(overrides: Partial<HoverContext> = {}): HoverContext {
    return {
      source: 'const x = 42',
      offset: 6,
      result: emptyResult(),
      bestType: null,
      bestStart: -1,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: 'file:///test.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
      ...overrides,
    };
  }

  it('returns null when no type and no annotation at position', () => {
    const hover = buildHover(makeCtx());
    expect(hover).toBeNull();
  });

  it('returns null when identifier is a keyword', () => {
    const hover = buildHover(makeCtx({
      source: 'const x = 42',
      offset: 2, // on "const" — keyword
      bestType: tNumber,
      bestStart: 0,
    }));
    expect(hover).toBeNull();
  });

  it('returns hover with type for a valid identifier', () => {
    const source = 'const myVar = 42';
    const hover = buildHover(makeCtx({
      source,
      offset: 8, // on "myVar"
      bestType: tNumber,
      bestStart: 6,
    }));
    expect(hover).not.toBeNull();
    expect((hover!.contents as any).value).toContain('myVar');
    expect((hover!.contents as any).value).toContain('Number');
  });

  it('returns method signature when present at bestStart', () => {
    const source = 'box.map(f)';
    const hover = buildHover(makeCtx({
      source,
      offset: 5, // on "map"
      bestType: tNumber,
      bestStart: 4,
      result: emptyResult({
        methodSignatures: new Map([[4, 'Box#map :: Box a ~> (a -> b) -> Box b']]),
      }),
    }));
    expect(hover).not.toBeNull();
    expect((hover!.contents as any).value).toContain('Box#map');
    expect((hover!.contents as any).value).toContain('Box a ~> (a -> b) -> Box b');
  });

  it('includes annotation raw text when available', () => {
    const source = '// :: Number -> Number\nconst f = (x) => x + 1';
    const hover = buildHover(makeCtx({
      source,
      offset: 29, // on "f"
      bestType: tFun(tNumber, tNumber),
      bestStart: 29,
      result: emptyResult({
        annotationsByOffset: new Map([[29, { name: 'f', raw: 'Number -> Number', scheme: mono(tFun(tNumber, tNumber)) } as any]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain(':: Number -> Number');
  });

  it('shows constraint prefix on type', () => {
    const varId = 10;
    const kvType = tCon(kvName('f', varId), [tVar('a')]);
    const source = 'const myFn = (x) => x';
    const hover = buildHover(makeCtx({
      source,
      offset: 8, // on "myFn"
      bestType: tFun(kvType, kvType),
      bestStart: 6,
      result: emptyResult({
        kvConstraints: new Map([[varId, ['Functor']]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('Functor f =>');
  });

  it('shows per-field constraints on TRecord instead of hoisting', () => {
    const fId = 99990;
    const mId = 99991;
    // map :: Functor f => (a -> b, f a) -> f b
    const mapA = tVar('a');
    const mapB = tVar('b');
    const mapType = tFun(
      tCon('Tuple', [tFun(mapA, mapB), tCon(kvName('f', fId), [mapA])]),
      tCon(kvName('f', fId), [mapB]),
    );
    // chain :: Chain m => (a -> m b, m a) -> m b
    const chainA = tVar('a');
    const chainB = tVar('b');
    const chainType = tFun(
      tCon('Tuple', [tFun(chainA, tCon(kvName('m', mId), [chainB])), tCon(kvName('m', mId), [chainA])]),
      tCon(kvName('m', mId), [chainB]),
    );
    const recordType = tRecord({ map: mapType, chain: chainType });
    const source = 'const fl = { map, chain }';
    const hover = buildHover(makeCtx({
      source,
      offset: 8, // on "fl"
      bestType: recordType,
      bestStart: 6,
      result: emptyResult({
        kvConstraints: new Map([[fId, ['Functor']], [mId, ['Chain']]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // Constraints should be per-field, not hoisted
    expect(value).not.toMatch(/\(Functor f, Chain m\) =>/);
    expect(value).toContain('map :: Functor f =>');
    expect(value).toContain('chain :: Chain m =>');
  });

  it('shows curried overloads for curried function', () => {
    const source = 'const add = (a) => (b) => a + b';
    // add :: Number -> Number -> Number  (curried)
    const curryType = tFun(tNumber, tFun(tNumber, tNumber));
    const hover = buildHover(makeCtx({
      source,
      offset: 8, // on "add"
      bestType: curryType,
      bestStart: 6,
      result: emptyResult({
        curriedNodes: new Set([6]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // Should show multiple overloads for curried function
    expect(value).toContain('add ::');
  });

  it('does not show duplicate raw annotation line for regular functions', () => {
    const source = 'const memoize = (fn) => fn;';
    const hover = buildHover(makeCtx({
      source,
      offset: 8, // on "memoize"
      bestType: tFun(tVar('a'), tVar('b')),
      bestStart: 6,
      result: emptyResult({
        annotationsByOffset: new Map([[6, {
          name: 'memoize',
          raw: '((a, b) -> z) -> (a, b) -> z',
          scheme: mono(tFun(tVar('a'), tVar('b'))),
          commentStart: 0,
          commentEnd: 10,
        } as any]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // Should show "memoize :: ..." but NOT a separate ":: ..." line
    expect(value).toContain('memoize ::');
    const lines = value.split('\n').filter((l: string) => l.includes('::'));
    expect(lines).toHaveLength(1);
  });

  it('falls through to alias hover when no type match', () => {
    const source = '// :: MyType -> Number\nconst f = (x) => x';
    const hover = buildHover(makeCtx({
      source,
      offset: 8, // on "MyType" inside annotation (starts at offset 6)
      bestType: null,
      bestStart: -1,
      result: emptyResult({
        annotations: new Map([['f', { commentStart: 0, commentEnd: 21 } as any]]),
        typeAliases: new Map([['MyType', { type: tNumber, commentStart: 0, commentEnd: 10 }]]),
      }),
    }));
    expect(hover).not.toBeNull();
    expect((hover!.contents as any).value).toContain('MyType');
  });

  it('skips bestType and shows alias hover for type names in anonymous annotation comments', () => {
    // This simulates hovering on "Boolean" in an anonymous annotation like:
    //   // :: String -> Box Boolean
    //   x => Box(true),
    // where bestType would be the enclosing call type, not the correct type info.
    const source = 'ex6(\n  // :: String -> Box Boolean\n  x => Box(true),\n)';
    const booleanOffset = source.indexOf('Boolean');
    const hover = buildHover(makeCtx({
      source,
      offset: booleanOffset + 1, // on "Boolean" inside anonymous comment
      bestType: tCon('Array', [tFun(tVar('a'), tCon('Box', [tVar('b')]))]), // enclosing node type
      bestStart: 0,
    }));
    // Should NOT show the enclosing node type
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('Boolean');
    expect(value).toContain(':: Type');
    expect(value).not.toContain('[a -> Box b]');
  });

  it('uses raw typeToString when inferredTypeStyle is raw', () => {
    const source = 'const myVar = [1]';
    const arrayType = tCon('Array', [tNumber]);
    const hover = buildHover(makeCtx({
      source,
      offset: 8, // on "myVar"
      bestType: arrayType,
      bestStart: 6,
      inferredTypeStyle: 'raw',
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('myVar');
  });

  it('uses X#Y display name for X$prototype$Y identifiers', () => {
    const source = 'function RTask$prototype$map(f) { return f; }';
    const hover = buildHover(makeCtx({
      source,
      offset: 12, // on "RTask$prototype$map"
      bestType: tFun(tVar('a'), tVar('b')),
      bestStart: 9,
      result: emptyResult({
        annotationsByOffset: new Map([[9, {
          name: 'RTask#map',
          raw: 'RTask r e a ~> (a -> b) -> RTask r e b',
          scheme: mono(tFun(tVar('a'), tVar('b'))),
        } as any]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('RTask#map ::');
    expect(value).not.toContain('RTask$prototype$map');
  });

  it('falls back to name-based annotation lookup when offset misses', () => {
    const source = 'export const fromPromise = function (fn) { return fn; }';
    const hover = buildHover(makeCtx({
      source,
      offset: 16, // on "fromPromise"
      bestType: tFun(tVar('a'), tVar('b')),
      bestStart: 13, // declarator id start
      result: emptyResult({
        // annotation is at offset 0 (export statement start), not 13
        annotationsByOffset: new Map([[0, {
          name: 'fromPromise',
          raw: '(* -> Promise a) -> (* -> RTask r e a)',
          scheme: mono(tFun(tVar('a'), tVar('b'))),
        } as any]]),
        annotations: new Map([['fromPromise', {
          name: 'fromPromise',
          raw: '(* -> Promise a) -> (* -> RTask r e a)',
          scheme: mono(tFun(tVar('a'), tVar('b'))),
          commentStart: 0,
          commentEnd: 10,
        } as any]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // User-written annotations are shown verbatim (never re-formatted).
    expect(value).toContain('fromPromise :: (* -> Promise a) -> (* -> RTask r e a)');
  });

  it('falls back to X#Y annotation for X$prototype$Y identifier', () => {
    const source = 'function Box$prototype$map(f) { return f; }';
    const hover = buildHover(makeCtx({
      source,
      offset: 12, // on "Box$prototype$map"
      bestType: tFun(tVar('a'), tVar('b')),
      bestStart: 9,
      result: emptyResult({
        // No offset-based annotation, but name-based with X#Y
        annotations: new Map([['Box#map', {
          name: 'Box#map',
          raw: 'Box a ~> (a -> b) -> Box b',
          scheme: mono(tFun(tVar('a'), tVar('b'))),
          receiver: { tag: 'TCon', name: 'Box', args: [{ tag: 'TVar', name: 'a', id: 1 }] },
          commentStart: 0,
          commentEnd: 10,
        } as any]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('Box#map :: Box a ~>');
    expect(value).not.toContain('Box$prototype$map');
  });

  it('appends imported callable overloads when bestType is an uppercase TCon', () => {
    // QueryTag() :: a -> RTask r e [b]   (instance-callable from sidecar)
    const overloadFn = tFun(tVar('a'), tCon('RTask', [tVar('r'), tVar('e'), tCon('Array', [tVar('b')])]));
    const source = 'export const readRandomOrganisations = mkTag([])';
    const hover = buildHover({
      source,
      offset: 'export const readRand'.length,
      bestType: tCon('QueryTag', [tVar('b')]),
      bestStart: 'export const '.length,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: 'file:///test.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
      result: emptyResult({
        instanceCallables: new Map([['QueryTag', [mono(overloadFn)]]]),
      }),
    });
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // The bare TCon preview line is kept — `QueryTag` remains a real
    // value, the overload merely describes how to invoke it.
    expect(value).toContain('readRandomOrganisations :: QueryTag');
    // Overload line should be rendered under the binding's name, not the
    // constructor name — so the reader sees the signature attached to the
    // value they're invoking.
    expect(value).toContain('readRandomOrganisations :: a -> RTask r e');
    expect(value).not.toContain('QueryTag :: a -> RTask');
  });

  it('substitutes the host row arg into the carrier slot of the imported overload', () => {
    // When the bestType is `QueryTag <projected record>`, the second
    // overload `a -> RTask r e [b]` should display with `b` replaced by
    // the host's row arg, mirroring what the call would actually return.
    const projectedRow = {
      tag: 'TRecord' as const,
      fields: { id: tCon('Number', []), name: tCon('String', []) },
    };
    const overloadFn = tFun(tVar('a'), tCon('RTask', [tVar('r'), tVar('e'), tCon('Array', [tVar('b')])]));
    const source = 'export const readRandomOrganisations = mkTag([])';
    const hover = buildHover({
      source,
      offset: 'export const readRand'.length,
      bestType: tCon('QueryTag', [projectedRow]),
      bestStart: 'export const '.length,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: 'file:///test.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
      result: emptyResult({
        instanceCallables: new Map([['QueryTag', [mono(overloadFn)]]]),
      }),
    });
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // Overload line should carry the projected record in the carrier slot
    // instead of a bare type variable.
    expect(value).toMatch(/readRandomOrganisations :: a -> RTask r e \[\{[^}]*id :: Number/);
    // The bare carrier tvar must NOT appear in the overload line.
    expect(value).not.toMatch(/readRandomOrganisations :: a -> RTask r e \[b\]/);
  });
});
// ---------------------------------------------------------------------------
// prototypeToHashName
// ---------------------------------------------------------------------------

describe('prototypeToHashName', () => {
  it('converts X$prototype$Y to X#Y', () => {
    expect(prototypeToHashName('RTask$prototype$map')).toBe('RTask#map');
  });

  it('returns null for names without $prototype$', () => {
    expect(prototypeToHashName('fromPromise')).toBeNull();
    expect(prototypeToHashName('myFunc')).toBeNull();
  });

  it('returns null for malformed patterns', () => {
    expect(prototypeToHashName('$prototype$map')).toBeNull();
    expect(prototypeToHashName('Box$prototype$')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Prototype method hover issues
// ---------------------------------------------------------------------------

describe('buildHover — prototype method patterns', () => {
  function makeCtx(overrides: Partial<HoverContext> = {}): HoverContext {
    return {
      source: '',
      offset: 0,
      result: emptyResult(),
      bestType: null,
      bestStart: -1,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: 'file:///test.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
      ...overrides,
    };
  }

  it('does not show constructor annotation when hovering on X in X.prototype.Y', () => {
    // Problem 1: hovering on `Left` in `Left.prototype.map` should NOT
    // show the `Left` constructor annotation `:: e -> Either e a`.
    const source = 'Left.prototype.map = function (_fn) { return this; };';
    const hover = buildHover(makeCtx({
      source,
      offset: 2, // on "Left"
      bestType: tFun(tVar('e'), tCon('Either', [tVar('e'), tVar('a')])),
      bestStart: 0,
      result: emptyResult({
        // The Left constructor annotation is in the annotations map
        annotations: new Map([['Left', {
          name: 'Left',
          raw: 'e -> Either e a',
          scheme: mono(tFun(tVar('e'), tCon('Either', [tVar('e'), tVar('a')]))),
          commentStart: 0,
          commentEnd: 10,
          nodeStart: 100, // points to a different location (the function declaration)
        } as any]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // Should NOT contain the raw annotation line for the constructor
    expect(value).not.toContain(':: e -> Either e a');
  });

  it('shows method signature via methodSignatures for map in X.prototype.map', () => {
    // Problem 3: hovering on `map` should show `Left#map :: ...` or `Either#map :: ...`
    // not `prototype.map :: ...`
    const source = 'Left.prototype.map = function (_fn) { return this; };';
    const mapOffset = source.indexOf('map');
    const hover = buildHover(makeCtx({
      source,
      offset: mapOffset + 1, // on "map" (the property name)
      bestType: tFun(tFun(tVar('a'), tVar('b')), tCon('Either', [tVar('e'), tVar('b')])),
      bestStart: mapOffset,
      result: emptyResult({
        methodSignatures: new Map([[mapOffset, 'Either#map :: Either e a ~> (a -> b) -> Either e b']]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('Either#map');
    expect(value).toContain('~>');
    expect(value).not.toContain('prototype.map');
  });
});

// ---------------------------------------------------------------------------
// Nested method annotation hover (Type#method on bare local variable)
// ---------------------------------------------------------------------------

describe('buildHover — nested method annotation fallback', () => {
  function makeCtx(overrides: Partial<HoverContext> = {}): HoverContext {
    return {
      source: '',
      offset: 0,
      result: emptyResult(),
      bestType: null,
      bestStart: -1,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: 'file:///test.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
      ...overrides,
    };
  }

  it('shows Type#method annotation when hovering bare method name inside constructor body', () => {
    // Scenario: `// Either2#map :: Either2 e a ~> (a -> b) -> Either2 e b`
    // above `const map = fn => ...` inside a function body.
    // The annotationsByOffset lookup misses because nodeStart points at
    // the arrow function init, not the declarator. The name-based lookup
    // also misses because the annotation is keyed as "Either2#map" not "map".
    const source = '  const map = fn => isRight ? Right(fn(value)) : Left(value)';
    const mapOffset = source.indexOf('map');
    const hover = buildHover(makeCtx({
      source,
      offset: mapOffset + 1, // middle of "map"
      bestType: tFun(tFun(tVar('a'), tVar('b')), tCon('Either2', [tVar('e'), tVar('b')])),
      bestStart: mapOffset,  // nodeTypes entry for the declarator
      result: emptyResult({
        annotations: new Map([['Either2#map', {
          name: 'Either2#map',
          raw: 'Either2 e a ~> (a -> b) -> Either2 e b',
          scheme: mono(tFun(tFun(tVar('a'), tVar('b')), tCon('Either2', [tVar('e'), tVar('b')]))),
          receiver: { tag: 'TCon', name: 'Either2', args: [{ tag: 'TVar', name: 'e', id: 1 }, { tag: 'TVar', name: 'a', id: 2 }] },
          commentStart: 0,
          commentEnd: 10,
          nodeStart: mapOffset + 6, // points to init (fn =>), not declarator
        } as any]]),
        // annotation is at nodeStart = mapOffset+6, but bestStart = mapOffset
        annotationsByOffset: new Map([[mapOffset + 6, {
          name: 'Either2#map',
          raw: 'Either2 e a ~> (a -> b) -> Either2 e b',
          scheme: mono(tFun(tFun(tVar('a'), tVar('b')), tCon('Either2', [tVar('e'), tVar('b')]))),
          receiver: { tag: 'TCon', name: 'Either2', args: [{ tag: 'TVar', name: 'e', id: 1 }, { tag: 'TVar', name: 'a', id: 2 }] },
          commentStart: 0,
          commentEnd: 10,
          nodeStart: mapOffset + 6,
        } as any]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // Should show the declared annotation, not the inferred type
    expect(value).toContain('Either2#map');
    expect(value).toContain('Either2 e a ~> (a -> b) -> Either2 e b');
  });

  it('does not hijack the first parameter with the enclosing method annotation', () => {
    // `fn` and its enclosing arrow function share the same start offset, so
    // the offset-keyed lookup finds the `Either2#map` annotation that
    // describes the enclosing `const map = fn => …` — not the parameter.
    // Hovering `fn` must render the parameter's own inferred type.
    const source = '  const map = fn => isRight ? Right(fn(value)) : Left(value)';
    const fnOffset = source.indexOf('fn');
    const hover = buildHover(makeCtx({
      source,
      offset: fnOffset + 1, // inside "fn"
      bestType: tFun(tVar('a'), tVar('b')),
      bestStart: fnOffset,  // param node start == arrow function start
      result: emptyResult({
        annotationsByOffset: new Map([[fnOffset, {
          name: 'Either2#map',
          raw: 'Either2 e a ~> (a -> b) -> Either2 e b',
          scheme: mono(tFun(tFun(tVar('a'), tVar('b')), tCon('Either2', [tVar('e'), tVar('b')]))),
          receiver: { tag: 'TCon', name: 'Either2', args: [{ tag: 'TVar', name: 'e', id: 1 }, { tag: 'TVar', name: 'a', id: 2 }] },
          commentStart: 0,
          commentEnd: 10,
          nodeStart: fnOffset,
        } as any]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).not.toContain('Either2#map');
    expect(value).toContain('fn ::');
    expect(value).toContain('a -> b');
  });

  it('does not pick up Type#method annotation when name does not match', () => {
    const source = '  const chain = fn => fn(value)';    const chainOffset = source.indexOf('chain');
    const hover = buildHover(makeCtx({
      source,
      offset: chainOffset + 1,
      bestType: tFun(tFun(tVar('a'), tVar('b')), tVar('b')),
      bestStart: chainOffset,
      result: emptyResult({
        // Only Either2#map is in annotations, not Either2#chain
        annotations: new Map([['Either2#map', {
          name: 'Either2#map',
          raw: 'Either2 e a ~> (a -> b) -> Either2 e b',
          scheme: mono(tFun(tFun(tVar('a'), tVar('b')), tCon('Either2', [tVar('e'), tVar('b')]))),
          receiver: { tag: 'TCon', name: 'Either2', args: [{ tag: 'TVar', name: 'e', id: 1 }, { tag: 'TVar', name: 'a', id: 2 }] },
          commentStart: 0,
          commentEnd: 10,
        } as any]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // Should show the inferred type, not the map annotation
    expect(value).not.toContain('Either2#map');
    expect(value).toContain('chain');
  });

  it('does not pick up unrelated Type#method annotation when shapes differ', () => {
    // Regression: hovering a locally destructured `insert` (e.g.
    // `const { insert } = Repo (Organisation)`) used to be polluted by
    // an unrelated sidecar annotation `DpiTemplate#insert :: DpiTemplate
    // ~> [a] -> QueryTag b` simply because the method name matched.
    // The fallback must reject candidates whose declared method type is
    // structurally incompatible with the inferred type.
    const source = '  const insert = data => doInsert(data)';
    const insertOffset = source.indexOf('insert');
    // Inferred: `Organisation -> RTask r e Organisation`
    const inferredArg = tCon('Organisation', []);
    const inferredRet = tCon('RTask', [tVar('r'), tVar('e'), tCon('Organisation', [])]);
    const hover = buildHover(makeCtx({
      source,
      offset: insertOffset + 1,
      bestType: tFun(inferredArg, inferredRet),
      bestStart: insertOffset,
      result: emptyResult({
        // Sidecar annotation: `DpiTemplate#insert :: DpiTemplate ~> [a] -> QueryTag b`
        // methodType is `[a] -> QueryTag b` — incompatible with the inferred
        // `Organisation -> RTask r e Organisation` (different concrete
        // TCon names: Array vs Organisation, QueryTag vs RTask).
        annotations: new Map([['DpiTemplate#insert', {
          name: 'DpiTemplate#insert',
          raw: 'DpiTemplate ~> [a] -> QueryTag b',
          scheme: mono(tFun(tCon('Array', [tVar('a')]), tCon('QueryTag', [tVar('b')]))),
          methodType: tFun(tCon('Array', [tVar('a')]), tCon('QueryTag', [tVar('b')])),
          receiver: { tag: 'TCon', name: 'DpiTemplate', args: [] },
          commentStart: 0,
          commentEnd: 10,
        } as any]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).not.toContain('DpiTemplate');
    expect(value).not.toContain('QueryTag');
    expect(value).toContain('Organisation');
  });

  it('does not pick up Type#property (non-function) annotation for unrelated bindings', () => {
    // Regression: `// Param#rules :: Param a b c ~> [b]` used to leak
    // onto unrelated `const rules = [1, "2"]` because both are arrays
    // and the structural-shape check is permissive on TVars.  Property
    // annotations (declared method type is a bare TCon, not a TFun)
    // should never be picked up via the bare-method-name fallback —
    // there is no syntactic context (`obj.rules`) to anchor the match.
    const source = '  const rules = [1, "2"]';
    const rulesOffset = source.indexOf('rules');
    // Inferred: `[Number | String]`
    const inferredArrType = tCon('Array', [
      { tag: 'TCon', name: 'Union', args: [tCon('Number', []), tCon('String', [])] } as any,
    ]);
    const hover = buildHover(makeCtx({
      source,
      offset: rulesOffset + 1,
      bestType: inferredArrType,
      bestStart: rulesOffset,
      result: emptyResult({
        annotations: new Map([['Param#rules', {
          name: 'Param#rules',
          raw: 'Param a b c ~> [b]',
          // methodType is `[b]` — a bare TCon, not a TFun — so this
          // fallback must NOT fire.
          methodType: tCon('Array', [tVar('b')]),
          scheme: mono(tCon('Array', [tVar('b')])),
          receiver: { tag: 'TCon', name: 'Param', args: [tVar('a'), tVar('b'), tVar('c')] },
          commentStart: 0,
          commentEnd: 10,
        } as any]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).not.toContain('Param#rules');
    expect(value).not.toContain('Param a b c');
  });
});

// ---------------------------------------------------------------------------
// buildConstraintHover
// ---------------------------------------------------------------------------

import { registerConstraint, clearConstraints } from '../../src/registries/constraintRegistry';
import { registerDataType, clearDataTypes } from '../../src/registries/dataTypeRegistry';

describe('buildConstraintHover', () => {
  beforeEach(() => {
    clearConstraints();
  });

  afterEach(() => {
    clearConstraints();
  });

  it('returns hover with constraint definition', () => {
    registerConstraint({
      name: 'Functor',
      typeVar: 'f',
      methods: [{ name: 'map', signature: 'f a ~> (a -> b) -> f b' }],
    });
    const hover = buildConstraintHover('Functor');
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('::constraint Functor f');
    expect(value).toContain('map :: f a ~> (a -> b) -> f b');
  });

  it('returns null for unregistered constraint', () => {
    const hover = buildConstraintHover('Unknown');
    expect(hover).toBeNull();
  });

  it('shows multiple methods', () => {
    registerConstraint({
      name: 'Monad',
      typeVar: 'm',
      methods: [
        { name: 'chain', signature: 'm a ~> (a -> m b) -> m b' },
        { name: 'of', signature: 'a -> m a' },
      ],
    });
    const hover = buildConstraintHover('Monad');
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('::constraint Monad m');
    expect(value).toContain('chain :: m a ~> (a -> m b) -> m b');
    expect(value).toContain('of :: a -> m a');
  });
});

// ---------------------------------------------------------------------------
// Hover.range
// ---------------------------------------------------------------------------

describe('buildHover — range', () => {
  function makeCtx(overrides: Partial<HoverContext> = {}): HoverContext {
    return {
      source: 'const x = 42',
      offset: 6,
      result: emptyResult(),
      bestType: null,
      bestStart: -1,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: 'file:///test.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
      ...overrides,
    };
  }

  it('sets range on hover for a valid identifier', () => {
    const source = 'const myVar = 42';
    const hover = buildHover(makeCtx({
      source,
      offset: 8, // on "myVar"
      bestType: tNumber,
      bestStart: 6,
    }));
    expect(hover).not.toBeNull();
    expect(hover!.range).toBeDefined();
    // myVar starts at col 6, ends at col 11
    expect(hover!.range!.start).toEqual({ line: 0, character: 6 });
    expect(hover!.range!.end).toEqual({ line: 0, character: 11 });
  });

  it('sets range on multiline source', () => {
    const source = 'const a = 1;\nconst b = 2';
    // "b" is at offset 19 (line 1, char 6)
    const hover = buildHover(makeCtx({
      source,
      offset: 19, // on "b"
      bestType: tNumber,
      bestStart: 19,
    }));
    expect(hover).not.toBeNull();
    expect(hover!.range).toBeDefined();
    expect(hover!.range!.start).toEqual({ line: 1, character: 6 });
    expect(hover!.range!.end).toEqual({ line: 1, character: 7 });
  });

  it('sets range on method signature hover', () => {
    const source = 'box.map(f)';
    const hover = buildHover(makeCtx({
      source,
      offset: 5, // on "map"
      bestType: tNumber,
      bestStart: 4,
      result: emptyResult({
        methodSignatures: new Map([[4, 'Box#map :: Box a ~> (a -> b) -> Box b']]),
      }),
    }));
    expect(hover).not.toBeNull();
    expect(hover!.range).toBeDefined();
    // "map" starts at col 4, ends at col 7
    expect(hover!.range!.start).toEqual({ line: 0, character: 4 });
    expect(hover!.range!.end).toEqual({ line: 0, character: 7 });
  });

  it('uses positionAt callback when provided', () => {
    const source = 'const myVar = 42';
    const positionAt = (offset: number) => ({ line: 99, character: offset });
    const hover = buildHover(makeCtx({
      source,
      offset: 8,
      bestType: tNumber,
      bestStart: 6,
      positionAt,
    }));
    expect(hover).not.toBeNull();
    expect(hover!.range).toBeDefined();
    // positionAt returns the offset as character, line always 99
    expect(hover!.range!.start).toEqual({ line: 99, character: 6 });
    expect(hover!.range!.end).toEqual({ line: 99, character: 11 });
  });

  it('returns null hover without crashing when no identifier', () => {
    const source = '   ';
    const hover = buildHover(makeCtx({
      source,
      offset: 1,
      bestType: null,
      bestStart: -1,
    }));
    expect(hover).toBeNull();
  });

  it('applied constraint does not appear in value hover, only on constructor', () => {
    // foldable has type f a where f has Applicative+Foldable (regular)
    // and Monoid (applied, for constructor only).
    const fVarId = 50;
    const kvType = tCon(kvName('f', fVarId), [tVar('a')]);
    const source = 'const foldable = 1';
    // kvConstraints only has Applicative and Foldable (not Monoid)
    const kvConstraints = new Map<number, string[]>([[fVarId, ['Applicative', 'Foldable']]]);

    const hover = buildHover(makeCtx({
      source,
      offset: 6, // on "foldable"
      bestType: kvType,
      bestStart: 6,
      result: emptyResult({ kvConstraints }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('Applicative f');
    expect(value).toContain('Foldable f');
    expect(value).not.toContain('Monoid');
  });

  it('applied kind * constraint appears in value hover (Semigroup (s a))', () => {
    clearConstraints();
    registerConstraint({
      name: 'Semigroup',
      typeVar: 's',
      methods: [{ name: 'concat', signature: 's ~> s -> s' }],
    });
    const sVarId = 70;
    const kvType = tCon(kvName('s', sVarId), [tVar('a')]);
    const source = 'const xs = 1';
    const kvConstructorConstraints = new Map<number, string[]>([[sVarId, ['Semigroup']]]);

    const hover = buildHover(makeCtx({
      source,
      offset: 6, // on "xs"
      bestType: kvType,
      bestStart: 6,
      result: emptyResult({ kvConstructorConstraints }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('Semigroup');
    clearConstraints();
  });

  it('regular constraint appears in constructor hover (Monad m => m)', () => {
    // When .constructor is accessed on a kv value with a regular constraint
    // (e.g. Monad m), the constructor TVar should show the constraint in hover.
    const mVarId = 60;
    const ctorVarId = 99;
    const ctorType: Type = { tag: 'TVar', id: ctorVarId, name: 'm' };
    const source = 'const ctor = this.run.constructor';
    // Regular constraint "Monad" should appear on the constructor TVar
    const kvConstraints = new Map<number, string[]>([[ctorVarId, ['Monad']]]);

    const hover = buildHover(makeCtx({
      source,
      offset: 22, // on "constructor"
      bestType: ctorType,
      bestStart: 21,
      result: emptyResult({ kvConstraints }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('Monad m');
  });
});

describe('Sanctuary type hover', () => {
  const dummyResolve = () => null;
  const dummyExtract = () => new Map<string, string>();

  it('shows hover with description for Any type', () => {
    const source = '// show :: Any -> String\nconst show = x => String(x)';
    const anyOffset = source.indexOf('Any');
    const result = getAliasHoverAtOffset(
      source, anyOffset + 1,
      emptyResult({
        annotations: new Map([['show', { commentStart: 0, commentEnd: 24 } as any]]),
      }),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).not.toBeNull();
    expect((result!.contents as any).value).toContain('Any');
    expect((result!.contents as any).value).toContain('Type');
  });

  it('shows hover for Integer type', () => {
    const source = '// f :: Number -> Integer\nconst f = x => x';
    const intOffset = source.indexOf('Integer');
    const result = getAliasHoverAtOffset(
      source, intOffset + 1,
      emptyResult({
        annotations: new Map([['f', { commentStart: 0, commentEnd: 24 } as any]]),
      }),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).not.toBeNull();
    expect((result!.contents as any).value).toContain('Integer');
    expect((result!.contents as any).value).toContain('Type');
  });

  it('shows hover for StrMap type', () => {
    const source = '// f :: StrMap a -> a\nconst f = x => x';
    const smOffset = source.indexOf('StrMap');
    const result = getAliasHoverAtOffset(
      source, smOffset + 1,
      emptyResult({
        annotations: new Map([['f', { commentStart: 0, commentEnd: 20 } as any]]),
      }),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).not.toBeNull();
    expect((result!.contents as any).value).toContain('StrMap');
    expect((result!.contents as any).value).toContain('Type');
  });
});

// ---------------------------------------------------------------------------
// getAliasHoverAtOffset — data type registry
// ---------------------------------------------------------------------------

describe('getAliasHoverAtOffset — data types', () => {
  const dummyResolve = () => null;
  const dummyExtract = () => new Map<string, string>();

  beforeEach(() => { clearDataTypes(); });
  afterEach(() => { clearDataTypes(); });

  it('shows hover for registered data type name', () => {
    registerDataType({
      name: 'Maybe',
      typeVars: ['a'],
      variants: [
        { name: 'Just', fields: ['a'] },
        { name: 'Nothing', fields: [] },
      ],
      commentStart: 9000,
      commentEnd: 9030,
    });
    const source = '// f :: Maybe a -> a\nconst f = x => x';
    const offset = source.indexOf('Maybe');
    const result = getAliasHoverAtOffset(
      source, offset + 1,
      emptyResult({
        annotations: new Map([['f', { commentStart: 0, commentEnd: 20 } as any]]),
      }),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).not.toBeNull();
    expect((result!.contents as any).value).toContain('Maybe');
  });

  it('shows hover for variant name of registered data type', () => {
    registerDataType({
      name: 'Maybe',
      typeVars: ['a'],
      variants: [
        { name: 'Just', fields: ['a'] },
        { name: 'Nothing', fields: [] },
      ],
      commentStart: 9000,
      commentEnd: 9030,
    });
    const source = '// f :: Just a -> a\nconst f = x => x';
    const offset = source.indexOf('Just');
    const result = getAliasHoverAtOffset(
      source, offset + 1,
      emptyResult({
        annotations: new Map([['f', { commentStart: 0, commentEnd: 19 } as any]]),
      }),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).not.toBeNull();
    expect((result!.contents as any).value).toContain('Maybe');
  });

  it('returns null when word is not a known alias, data type, or built-in', () => {
    const source = '// f :: Xyz -> a\nconst f = x => x';
    const offset = source.indexOf('Xyz');
    const result = getAliasHoverAtOffset(
      source, offset + 1,
      emptyResult({
        annotations: new Map([['f', { commentStart: 0, commentEnd: 16 } as any]]),
      }),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).toBeNull();
  });

  it('suppresses hover for type name inside its own sum type declaration comment', () => {
    const source = '// Maybe :: Just a | Nothing\nconst x = 1';
    registerDataType({
      name: 'Maybe',
      typeVars: ['a'],
      variants: [
        { name: 'Just', fields: ['a'] },
        { name: 'Nothing', fields: [] },
      ],
      commentStart: 0,
      commentEnd: 28,
    });
    const offset = source.indexOf('Maybe');
    const result = getAliasHoverAtOffset(
      source, offset + 1,
      emptyResult(),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).toBeNull();
  });

  it('suppresses hover for variant name inside its own sum type declaration comment', () => {
    const source = '// Maybe :: Just a | Nothing\nconst x = 1';
    registerDataType({
      name: 'Maybe',
      typeVars: ['a'],
      variants: [
        { name: 'Just', fields: ['a'] },
        { name: 'Nothing', fields: [] },
      ],
      commentStart: 0,
      commentEnd: 28,
    });
    const offset = source.indexOf('Just');
    const result = getAliasHoverAtOffset(
      source, offset + 1,
      emptyResult(),
      'file:///test.js', dummyResolve, dummyExtract,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildHover — constraint directive hover
// ---------------------------------------------------------------------------

describe('buildHover — constraint directive', () => {
  function makeCtx(overrides: Partial<HoverContext> = {}): HoverContext {
    return {
      source: 'const x = 42',
      offset: 6,
      result: emptyResult(),
      bestType: null,
      bestStart: -1,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: 'file:///test.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
      ...overrides,
    };
  }

  beforeEach(() => { clearConstraints(); });
  afterEach(() => { clearConstraints(); });

  it('returns constraint hover when cursor is in a ::constraint directive', () => {
    registerConstraint({
      name: 'Functor',
      typeVar: 'f',
      methods: [{ name: 'map', signature: 'f a ~> (a -> b) -> f b' }],
    });
    const source = '// ::constraint Functor f\nconst x = 1';
    const offset = source.indexOf('Functor');
    const hover = buildHover(makeCtx({
      source,
      offset: offset + 2,
      bestType: null,
      bestStart: -1,
    }));
    expect(hover).not.toBeNull();
    expect((hover!.contents as any).value).toContain('Functor');
    expect((hover!.contents as any).value).toContain('map');
  });

  it('returns null at end of buildHover when nothing matches', () => {
    const source = 'const x = 42';
    const hover = buildHover(makeCtx({
      source,
      offset: 10, // on "42" — a numeric literal, not an identifier
      bestType: null,
      bestStart: -1,
    }));
    expect(hover).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tryArrayLiteralReinfer
// ---------------------------------------------------------------------------

describe('tryArrayLiteralReinfer', () => {
  it('returns null when reinferWithArrayASI returns null', () => {
    const source = '[1,2].map';
    const offset = 7; // on "map"
    const result = tryArrayLiteralReinfer(
      source, offset, () => null, () => null,
      { infer: () => emptyResult() },
      () => null,
    );
    expect(result).toBeNull();
  });

  it('returns best type when reinfer succeeds', () => {
    const source = '[1,2].map';
    const offset = 7;
    const nodeTypes = new Map<number, { type: Type; end: number }>([
      [8, { type: tFun(tNumber, tString), end: 12 }],
    ]);
    const sub = new Substitution();
    const result = tryArrayLiteralReinfer(
      source, offset, () => null, () => null,
      { infer: () => emptyResult() },
      () => ({ result: emptyResult({ nodeTypes, substitution: sub }), shift: 1, patched: ';[1,2].map' }),
    );
    expect(result).not.toBeNull();
    expect(result!.bestType.tag).toBe('TFun');
  });

  it('returns null when reinferred type is a bare TVar', () => {
    const source = '[1,2].map';
    const offset = 7;
    const v = tVar();
    const nodeTypes = new Map<number, { type: Type; end: number }>([
      [8, { type: v, end: 12 }],
    ]);
    const result = tryArrayLiteralReinfer(
      source, offset, () => null, () => null,
      { infer: () => emptyResult() },
      () => ({ result: emptyResult({ nodeTypes, substitution: new Substitution() }), shift: 1, patched: ';[1,2].map' }),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildHover — receiver annotation
// ---------------------------------------------------------------------------

describe('buildHover — receiver annotation', () => {
  function makeCtx(overrides: Partial<HoverContext> = {}): HoverContext {
    return {
      source: 'const x = 42',
      offset: 6,
      result: emptyResult(),
      bestType: null,
      bestStart: -1,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: 'file:///test.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
      ...overrides,
    };
  }

  it('shows raw annotation for method with receiver (~>)', () => {
    const source = 'const map = function(f) { return this; }';
    const hover = buildHover(makeCtx({
      source,
      offset: 8, // on "map"
      bestType: tFun(tVar('a'), tVar('b')),
      bestStart: 6,
      result: emptyResult({
        annotationsByOffset: new Map([[6, {
          name: 'map',
          raw: 'Box a ~> (a -> b) -> Box b',
          scheme: mono(tFun(tVar('a'), tVar('b'))),
          receiver: true,
          commentStart: 0,
          commentEnd: 10,
        } as any]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('Box a ~> (a -> b) -> Box b');
  });
});

// ---------------------------------------------------------------------------
// getAliasHoverAtOffset — imported file constructor annotations
// ---------------------------------------------------------------------------

describe('getAliasHoverAtOffset — imported file annotations', () => {
  const sampleDir = path.resolve(__dirname, '..', '..', 'sample');

  // Real resolver that uses the same logic as the production code
  const realResolve = (specifier: string, fromUri: string): string | null => {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
    const { fileURLToPath: f2p } = require('url');
    const fromPath = f2p(fromUri);
    const fromDir = path.dirname(fromPath);
    const fs = require('fs');
    for (const ext of ['', '.js', '.mjs']) {
      const candidate = path.resolve(fromDir, specifier) + ext;
      try { if (fs.statSync(candidate).isFile()) return pathToFileURL(candidate).href; } catch {}
    }
    return null;
  };

  // Real extractor that parses import statements
  const realExtract = (source: string): Map<string, string> => {
    const result = new Map<string, string>();
    const namedRe = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = namedRe.exec(source)) !== null) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) result.set(name, m[2]);
      }
    }
    return result;
  };

  it('shows annotation from imported file for constructor name', () => {
    const fromUri = pathToFileURL(path.join(sampleDir, 'demo.js')).href;
    // Source that imports Left from Either2.js
    const source = `// f :: Left e -> String\nimport { Left } from './Either2'\nconst f = x => x`;
    const offset = source.indexOf('Left');
    const result = getAliasHoverAtOffset(
      source, offset + 1,
      emptyResult({
        annotations: new Map([['f', { commentStart: 0, commentEnd: 23 } as any]]),
      }),
      fromUri, realResolve, realExtract,
    );
    expect(result).not.toBeNull();
    expect((result!.contents as any).value).toContain('Left');
    expect((result!.contents as any).value).toContain('Either2');
  });

  it('returns null when imported file does not contain matching annotation', () => {
    const fromUri = pathToFileURL(path.join(sampleDir, 'demo.js')).href;
    const source = `// f :: FakeConstructor a -> a\nimport { Left } from './Either2'\nconst f = x => x`;
    const offset = source.indexOf('FakeConstructor');
    const result = getAliasHoverAtOffset(
      source, offset + 1,
      emptyResult({
        annotations: new Map([['f', { commentStart: 0, commentEnd: 29 } as any]]),
      }),
      fromUri, realResolve, realExtract,
    );
    // FakeConstructor is not in Either2.js, and not in built-in types
    expect(result).toBeNull();
  });

  it('returns null when resolver returns null for specifier', () => {
    const source = `// f :: Left e -> String\nimport { Left } from './NonExistent'\nconst f = x => x`;
    const offset = source.indexOf('Left');
    const result = getAliasHoverAtOffset(
      source, offset + 1,
      emptyResult({
        annotations: new Map([['f', { commentStart: 0, commentEnd: 23 } as any]]),
      }),
      'file:///fake/dir/test.js',
      () => null, // resolver always returns null
      realExtract,
    );
    // Left is not a built-in type, no local alias, and resolver fails
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildHover — curried function overloads
// ---------------------------------------------------------------------------

describe('buildHover — curried overloads', () => {
  function makeCtx(overrides: Partial<HoverContext> = {}): HoverContext {
    return {
      source: 'const add = a => b => a + b',
      offset: 6,
      result: emptyResult(),
      bestType: null,
      bestStart: -1,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: 'file:///test.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
      ...overrides,
    };
  }

  it('shows curried overloads when function is in curriedNodes', () => {
    const source = 'const add = a => b => a + b';
    const curriedType = tFun(tNumber, tFun(tNumber, tNumber));
    const hover = buildHover(makeCtx({
      source,
      offset: 6, // on "add"
      bestType: curriedType,
      bestStart: 6,
      result: emptyResult({
        curriedNodes: new Set([6]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // Should show multiple overloads
    expect(value).toContain('add ::');
  });

  it('shows constraint prefix on curried overloads', () => {
    const source = 'const lift = f => fx => fx.map(f)';
    const fxVar = tVar('fx');
    const curriedType = tFun(tVar('a'), tFun(fxVar, tVar('c')));
    const hover = buildHover(makeCtx({
      source,
      offset: 6, // on "lift"
      bestType: curriedType,
      bestStart: 6,
      result: emptyResult({
        curriedNodes: new Set([6]),
        kvConstraints: new Map([[fxVar.id, ['Functor']]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('lift ::');
    expect(value).toContain('Functor');
  });

  it('shows plain type for curried node with single param', () => {
    const source = 'const id = x => x';
    const singleParamType = tFun(tNumber, tNumber);
    const hover = buildHover(makeCtx({
      source,
      offset: 6, // on "id"
      bestType: singleParamType,
      bestStart: 6,
      result: emptyResult({
        curriedNodes: new Set([6]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('id ::');
    expect(value).toContain('Number');
  });
});

// ---------------------------------------------------------------------------
// buildHover — record type without field constraints
// ---------------------------------------------------------------------------

describe('buildHover — record without field constraints', () => {
  function makeCtx(overrides: Partial<HoverContext> = {}): HoverContext {
    return {
      source: 'const x = 42',
      offset: 6,
      result: emptyResult(),
      bestType: null,
      bestStart: -1,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: 'file:///test.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
      ...overrides,
    };
  }

  it('shows record type without per-field constraints', () => {
    const source = 'const cfg = { host: "localhost", port: 8080 }';
    const recordType = tRecord({ host: tString, port: tNumber });
    const hover = buildHover(makeCtx({
      source,
      offset: 6, // on "cfg"
      bestType: recordType,
      bestStart: 6,
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('cfg');
    expect(value).toContain('host');
    expect(value).toContain('port');
  });
});

// ---------------------------------------------------------------------------
// wrapLongRecord — multi-line reflow of long record literals
// ---------------------------------------------------------------------------

describe('wrapLongRecord', () => {
  it('keeps short lines untouched', () => {
    expect(wrapLongRecord('Foo :: { x :: Number }')).toBe('Foo :: { x :: Number }');
  });

  it('breaks a long top-level record at every comma', () => {
    const long = 'Big :: Table { a :: Number, b :: String, c :: Boolean, d :: Date, e :: Number, f :: String }';
    const wrapped = wrapLongRecord(long);
    expect(wrapped).toContain('Big :: Table {\n');
    expect(wrapped).toContain('  a :: Number,');
    expect(wrapped).toContain('  f :: String\n}');
    // Each field ends up on its own line.
    expect(wrapped.split('\n').length).toBeGreaterThanOrEqual(7);
  });

  it('does not split commas inside nested parens or brackets', () => {
    const long = 'Big :: Table { coord :: (Number, Number, Number), tags :: [Foo, Bar, Baz, Qux, Other], extraCol :: String }';
    const wrapped = wrapLongRecord(long);
    // The tuple/array commas must NOT cause inner splits.
    expect(wrapped).toContain('coord :: (Number, Number, Number),');
    expect(wrapped).toContain('tags :: [Foo, Bar, Baz, Qux, Other],');
  });

  it('returns the line unchanged when only one top-level field exists', () => {
    const long = 'Wrapper :: { onlyField :: SomeReallyLongTypeNameThatExceedsTheEightyCharacterLimitX }';
    expect(wrapLongRecord(long)).toBe(long);
  });

  it('wraps a record nested inside an array bracket', () => {
    // Regression: the first balanced `{ ... }` block must be located even
    // when it sits inside `[ ... ]` (or `( ... )`).
    const long = 'Foo :: [{ a :: Number, b :: String, c :: Boolean, d :: Date, e :: Number, f :: String }]';
    const wrapped = wrapLongRecord(long, 60);
    expect(wrapped).toContain('Foo :: [{\n');
    expect(wrapped).toContain('  a :: Number,');
    expect(wrapped).toContain('}]');
  });

  it('scans past a short single-field record to wrap a later multi-field record', () => {
    // Regression: signatures like
    //   `query :: { applicationId :: Number } -> Result { ...many fields... }`
    // used to bail out at the 1-field params record and never wrap the
    // larger return-type record.  The implementation must continue
    // searching for the next `{...}` block when the first one has only
    // one top-level field.
    const long = 'query :: { applicationId :: Number } -> Result { a :: Number, b :: String, c :: Boolean, d :: Date, e :: Number, f :: String }';
    const wrapped = wrapLongRecord(long, 60);
    // Short prefix record stays inline.
    expect(wrapped).toContain('{ applicationId :: Number }');
    // The trailing multi-field record gets reflowed.
    expect(wrapped).toContain('Result {\n');
    expect(wrapped).toContain('  a :: Number,');
    expect(wrapped).toContain('  f :: String\n}');
  });
});

// ---------------------------------------------------------------------------
// wrapHmBlocks — only reflow lines inside fenced ```hm blocks
// ---------------------------------------------------------------------------

describe('wrapHmBlocks', () => {
  it('reflows long records inside ```hm fences', () => {
    const long = 'Big :: Table { a :: Number, b :: String, c :: Boolean, d :: Date, e :: Number, f :: String }';
    const md = '```hm\n' + long + '\n```';
    const out = wrapHmBlocks(md);
    expect(out).toContain('Big :: Table {\n');
    expect(out).toContain('  a :: Number,');
  });

  it('leaves prose outside fenced blocks untouched', () => {
    const long = 'Big :: Table { a :: Number, b :: String, c :: Boolean, d :: Date, e :: Number, f :: String, g :: Number }';
    const md = `Some prose with a very long line ${long} not in a code fence`;
    expect(wrapHmBlocks(md)).toBe(md);
  });

  it('does not reflow lines inside non-hm fenced blocks', () => {
    const long = 'Big :: Table { a :: Number, b :: String, c :: Boolean, d :: Date, e :: Number, f :: String, g :: Number }';
    const md = '```js\n' + long + '\n```';
    expect(wrapHmBlocks(md)).toBe(md);
  });
});

// ---------------------------------------------------------------------------
// buildHover — overloaded constructor: data shape + callable signature
// ---------------------------------------------------------------------------

describe('buildHover — multi-overload constructor', () => {
  function makeCtx(overrides: Partial<HoverContext> = {}): HoverContext {
    return {
      source: 'const x = 42',
      offset: 6,
      result: emptyResult(),
      bestType: null,
      bestStart: -1,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: 'file:///test.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
      ...overrides,
    };
  }

  it('renders multiple instance-callable overloads under the binding name', () => {
    // Organisation() :: [Selector] -> QueryTag b
    // Organisation() :: () -> QueryTag b
    // (modelled as two separate `Name()` schemes, NOT as branches of the
    // constructor scheme)
    const callA = tFun(
      tCon('Array', [tCon('Selector', [])]),
      tCon('QueryTag', [tVar('b')]),
    );
    const callB = tFun(
      tCon('Unit', []),
      tCon('QueryTag', [tVar('b')]),
    );
    const source = 'const Organisation = makeOrg();';
    const hover = buildHover(makeCtx({
      source,
      offset: 'const Organi'.length,
      bestType: tCon('Organisation', []),
      bestStart: 'const '.length,
      result: emptyResult({
        instanceCallables: new Map([['Organisation', [mono(callA), mono(callB)]]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // Both instance-callable overloads must appear under the binding name.
    expect(value).toContain('Organisation :: [Selector] -> QueryTag b');
    expect(value).toContain('Organisation :: Unit -> QueryTag b');
    // The redundant `Organisation :: Organisation` line should be dropped.
    expect(value).not.toMatch(/Organisation :: Organisation\b/);
  });

  it('does NOT surface the constructor scheme as a callable overload on an instance', () => {
    // Constructor `QueryTag :: a -> QueryTag a` describes how to construct an
    // QueryTag, not how to call one.  Hover on an `QueryTag X` instance must
    // therefore NOT show `readRandom :: a -> QueryTag a` as an overload.
    const ctorScheme = mono(tFun(tVar('a'), tCon('QueryTag', [tVar('a')])));
    const source = 'export const readRandom = mkTag();';
    const hover = buildHover(makeCtx({
      source,
      offset: 'export const readR'.length,
      bestType: tCon('QueryTag', [tVar('b')]),
      bestStart: 'export const '.length,
      result: emptyResult({
        importedConstructors: new Map([['QueryTag', ctorScheme]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // Inferred type line is preserved.
    expect(value).toContain('readRandom :: QueryTag');
    // Constructor scheme must NOT appear as an overload of the instance.
    expect(value).not.toMatch(/readRandom :: a -> QueryTag/);
  });

  it('renders an inferred non-curried Union inline as a single value type', () => {
    // Non-curried Union of value types (e.g. produced by inference when a
    // binding accepts a union of legal shapes).  Real user-written
    // multi-annotation overloads (`// name :: T1` + `// name :: T2`) are
    // handled by the raw-annotation branch and are unaffected; this
    // branch fires only for inference-built value unions, where rendering
    // per-arm "overload" lines is misleading.
    const source = 'const x = Foo';
    const offset = 'const x = F'.length;
    const hover = buildHover(makeCtx({
      source,
      offset,
      bestType: tUnion([tNumber, tString]),
      bestStart: 'const x = '.length,
      result: emptyResult(),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toMatch(/Foo :: Number \| String/);
  });
});

// ---------------------------------------------------------------------------
// buildHover — multiple raw annotations for the same name
// ---------------------------------------------------------------------------

describe('buildHover — overloaded raw annotations', () => {
  function makeCtx(overrides: Partial<HoverContext> = {}): HoverContext {
    return {
      source: '',
      offset: 0,
      result: emptyResult(),
      bestType: null,
      bestStart: -1,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: 'file:///test.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
      ...overrides,
    };
  }

  it('shows every overload of a locally annotated curried-style function', () => {
    const source = '// add :: (Number, Number) -> Number\n// add :: (String, String) -> String\nconst add = (a, b) => a + b;';
    const nameStart = source.indexOf('const add = ') + 'const '.length;
    const offset = nameStart;
    const annotation: any = {
      name: 'add',
      raw: '(Number, Number) -> Number',
      scheme: mono(tFun(tNumber, tFun(tNumber, tNumber))),
      commentStart: 0,
      commentEnd: 36,
      nodeStart: nameStart,
      nameStart,
    };
    const hover = buildHover(makeCtx({
      source,
      offset,
      bestType: tFun(tNumber, tFun(tNumber, tNumber)),
      bestStart: nameStart,
      result: emptyResult({
        annotations: new Map([['add', annotation]]),
        annotationsByOffset: new Map([[nameStart, annotation]]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // BOTH raw signatures must appear, not just the first.
    expect(value).toContain('add :: (Number, Number) -> Number');
    expect(value).toContain('add :: (String, String) -> String');
  });

  it('expands curry overloads at usage sites of an auto-curried binding even when a same-named freestanding comment annotation exists', () => {
    // A `// name :: ...` documentation comment placed next to a curry(...)
    // call must NOT short-circuit overload expansion at usage sites of the
    // curried binding.  The inferred curried TFun should be expanded into
    // every partition shape so hover over `curriedAdd3(...)` shows the
    // tuple form, the fully chained form, and the intermediate partial
    // application forms.
    const source = [
      '// curriedAdd3 :: Number -> Number -> Number -> Number',
      'const curriedAdd3 = (a) => (b) => (c) => a + b + c;',
      'curriedAdd3(1, 2, 3);',
    ].join('\n');
    const usageStart = source.lastIndexOf('curriedAdd3');
    const annotation: any = {
      name: 'curriedAdd3',
      raw: 'Number -> Number -> Number -> Number',
      // commentStart/commentEnd point at the comment; nameStart/nodeStart left undefined
      commentStart: 0,
      commentEnd: source.indexOf('\n'),
    };
    const triNum = tFun(tNumber, tFun(tNumber, tFun(tNumber, tNumber)));
    const curried = new Set<number>([usageStart]);
    const hover = buildHover(makeCtx({
      source,
      offset: usageStart + 1,
      bestType: triNum,
      bestStart: usageStart,
      result: emptyResult({
        annotations: new Map([['curriedAdd3', annotation]]),
        annotationsByOffset: new Map([[0, annotation]]),
        curriedNodes: curried,
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('curriedAdd3 :: (Number, Number, Number) -> Number');
    expect(value).toContain('curriedAdd3 :: Number -> Number -> Number -> Number');
  });

  it('augments user-overloaded curried bindings with tuple-partition forms', () => {
    // When the user writes multiple `// name :: a -> b -> c` annotations
    // on a curried binding (e.g. `curry((a, b) => ...)`), the inferred
    // type is a Union of TFuns.  Hover must surface BOTH the user's
    // chained forms AND the LSP-generated tuple partitions so every
    // callable shape is visible at a glance.
    const source = [
      '// curriedAdd :: Number -> Number -> Number',
      '// curriedAdd :: String -> String -> String',
      'const curriedAdd = (a) => (b) => a + b;',
    ].join('\n');
    const nameStart = source.lastIndexOf('curriedAdd');
    const numFn = tFun(tNumber, tFun(tNumber, tNumber));
    const strFn = tFun(tString, tFun(tString, tString));
    const union: any = { tag: 'TCon', name: 'Union', args: [numFn, strFn] };
    const annotation: any = {
      name: 'curriedAdd',
      raw: 'Number -> Number -> Number',
      scheme: mono(numFn),
      commentStart: 0,
      commentEnd: source.indexOf('\n'),
      nodeStart: nameStart,
      nameStart,
    };
    const hover = buildHover(makeCtx({
      source,
      offset: nameStart + 1,
      bestType: union,
      bestStart: nameStart,
      result: emptyResult({
        annotations: new Map([['curriedAdd', annotation]]),
        annotationsByOffset: new Map([[nameStart, annotation]]),
        curriedNodes: new Set<number>([nameStart]),
      }),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    // Chained forms (user-written) must still appear.
    expect(value).toContain('curriedAdd :: Number -> Number -> Number');
    expect(value).toContain('curriedAdd :: String -> String -> String');
    // LSP-augmented tuple partitions for each branch.
    expect(value).toContain('curriedAdd :: (Number, Number) -> Number');
    expect(value).toContain('curriedAdd :: (String, String) -> String');
  });

  it('expands curry overloads even when an imported raw signature is available', () => {
    // When the imported binding resolves through `getImportedRawSignature`
    // (e.g. a `// name :: ...` annotation in the providing JS module),
    // hover used to short-circuit with that single line.  For an
    // auto-detected curried binding we must instead fall through to
    // inferred-type overload expansion so both the chained form (from
    // the user's annotation) AND the tuple partition surface.
    const source = "const hasFunction = require('../predicate/hasFunction');\nhasFunction;";
    const importStart = source.indexOf('hasFunction');
    const tFun3 = tFun(tString, tFun(tVar('a'), tBool));
    const hover = buildHover(makeCtx({
      source,
      offset: importStart + 1,
      bestType: tFun3,
      bestStart: importStart,
      result: emptyResult({
        curriedNodes: new Set<number>([importStart]),
      }),
      // Real LSP provides a raw signature for the imported binding.
      getImportedRawSignature: () => 'String -> a -> Boolean',
      extractImportSpecifiers: () => new Map([['hasFunction', '../predicate/hasFunction']]),
    }));
    expect(hover).not.toBeNull();
    const value = (hover!.contents as any).value;
    expect(value).toContain('hasFunction :: (String, a) -> Boolean');
    expect(value).toContain('hasFunction :: String -> a -> Boolean');
  });
});