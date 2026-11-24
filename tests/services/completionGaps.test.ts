// Targeted tests for previously-uncovered regions of src/services/completion.ts:
//  - resolveRecordFields Union/alias resolution (destructuring member-chain RHS)
//  - getExpectedRecordTypeForCallArg (record-literal call arguments, both the
//    direct TFun callee and the instance-callable TCon callee)
//  - getTypeAliasRecordCompletions with a TCon-alias return type
//  - RHS-chain scanning past call parens containing string literals
//  - import-path / ::types-path completion edge cases (unreadable dirs, `.`)
//  - getTableSelectorCompletions (sqlkit-style `Table(["…`)
//  - resolveTypeBeforeDot fallbacks (dot after `)`, string/template literals)
//  - class statics on `ClassName.` and kv-constraint `.constructor.`
//  - getAnnotationNameCompletions

import {
  getDestructuringCompletions,
  getTypeAliasRecordCompletions,
  getImportPathCompletions,
  getTypeDirectivePathCompletions,
  getTableSelectorCompletions,
  getDotCompletions,
  getAnnotationNameCompletions,
  CompletionContext,
} from '../../src/services/completion';
import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, tCon, tRecord, tString, tNumber, mono, Scheme } from '../../src/hm/types';
import * as path from 'path';

function makeCtx(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    engine: new InferenceEngine(),
    createImportResolver: () => () => null,
    createTypeDirectiveResolver: () => () => null,
    inferFileAndCacheExports: () => null,
    inferredTypeStyle: 'pretty',
    ...overrides,
  };
}

const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
const sampleUri = 'file://' + path.join(sampleDir, 'test.js');

// ---------------------------------------------------------------------------
// Record-literal call arguments — getExpectedRecordTypeForCallArg
// ---------------------------------------------------------------------------

describe('record-literal call argument completions', () => {
  beforeEach(() => resetTypeVarCounter());

  test('empty literal argument offers the annotated record parameter fields', () => {
    const source = [
      '// save :: { name :: String, age :: Number } -> String',
      'function save(r) { return ""; }',
      'save({  });',
    ].join('\n');
    const braceOpen = source.lastIndexOf('{');
    const offset = braceOpen + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['age', 'name']);
  });

  test('mid-typing key still offers the matching expected field', () => {
    const source = [
      '// save :: { name :: String, age :: Number } -> String',
      'function save(r) { return ""; }',
      'save({ na });',
    ].join('\n');
    const offset = source.lastIndexOf('na') + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('name');
    expect(labels).toContain('age');
  });

  test('fully-typed key with concrete expected type is kept', () => {
    const source = [
      '// save :: { name :: String, age :: Number } -> String',
      'function save(r) { return ""; }',
      'save({ name });',
    ].join('\n');
    const offset = source.lastIndexOf('name') + 4;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('name');
  });

  test('fields typed `| Undefined` are marked optional', () => {
    const source = [
      '// RangeParams :: { from :: Date | Undefined, to :: Date }',
      '// list :: RangeParams -> String',
      'function list(r) { return ""; }',
      'list({  });',
    ].join('\n');
    const braceOpen = source.lastIndexOf('{');
    const items = getDestructuringCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    const detail = (label: string) => items.find(i => i.label === label)?.detail ?? '';
    expect(detail('from')).toMatch(/\(optional\)$/);
    expect(detail('to')).not.toMatch(/optional/);
  });

  test('second argument uses the second parameter of a curried record signature', () => {
    const source = [
      '// upsert :: (String, { title :: String, done :: Boolean }) -> String',
      'function upsert(k, r) { return k; }',
      'upsert("x", {  });',
    ].join('\n');
    const braceOpen = source.lastIndexOf('{');
    const offset = braceOpen + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['done', 'title']);
  });

  test('instance-callable TCon callee resolves record parameter from Name() overload', () => {
    const source = [
      '// QueryTag :: a -> QueryTag a',
      '// QueryTag() :: { title :: String, count :: Number } -> String',
      'const QueryTag = (a) => a;',
      'const tag = QueryTag(0);',
      'tag({  });',
    ].join('\n');
    const braceOpen = source.lastIndexOf('{');
    const offset = braceOpen + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['count', 'title']);
  });
});

// ---------------------------------------------------------------------------
// Destructuring RHS — union / alias record resolution + string-bearing calls
// ---------------------------------------------------------------------------

describe('destructuring RHS record resolution', () => {
  beforeEach(() => resetTypeVarCounter());

  test('member-chain RHS with Union type picks the record branch', () => {
    const recordBranch = tRecord({ id: tNumber, name: tString });
    const fooType = tRecord({
      props: tCon('Union', [tNumber, recordBranch]),
    });
    const importedSchemes = new Map<string, Scheme>([
      ['foo', mono(fooType)],
    ]);
    const ctx = makeCtx({
      createImportResolver: () => (specifier: string) =>
        specifier === './foo' ? importedSchemes : null,
    });
    const source = [
      'import { foo } from "./foo";',
      'const {  } = foo.props;',
    ].join('\n');
    const braceOpen = source.lastIndexOf('{');
    const offset = braceOpen + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', ctx);
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['id', 'name']);
  });

  test('member-chain RHS with alias TCon expands through result.typeAliases', () => {
    const confType = tRecord({ settings: tCon('Settings', []) });
    const importedSchemes = new Map<string, Scheme>([
      ['conf', mono(confType)],
    ]);
    const ctx = makeCtx({
      createImportResolver: () => (specifier: string) =>
        specifier === './conf' ? importedSchemes : null,
    });
    const source = [
      '// Settings :: { host :: String, port :: Number }',
      'import { conf } from "./conf";',
      'const {  } = conf.settings;',
    ].join('\n');
    const braceOpen = source.lastIndexOf('{');
    const offset = braceOpen + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', ctx);
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['host', 'port']);
  });

  test('RHS call with a string argument containing a dot resolves the call result', () => {
    const source = [
      '// Table :: String -> { name :: String, schema :: String }',
      'const Table = (s) => ({ name: s, schema: "public" });',
      'const {  } = Table("public.user");',
    ].join('\n');
    const braceOpen = source.lastIndexOf('const {') + 'const '.length;
    const offset = braceOpen + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['name', 'schema']);
  });

  test('RHS call with an escaped quote inside the string argument', () => {
    const source = [
      '// Table :: String -> { name :: String, schema :: String }',
      'const Table = (s) => ({ name: s, schema: "public" });',
      'const {  } = Table("a\\"b(c");',
    ].join('\n');
    const braceOpen = source.lastIndexOf('const {') + 'const '.length;
    const offset = braceOpen + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['name', 'schema']);
  });
});

// ---------------------------------------------------------------------------
// getTypeAliasRecordCompletions — TCon alias return type
// ---------------------------------------------------------------------------

describe('getTypeAliasRecordCompletions (alias TCon return)', () => {
  beforeEach(() => resetTypeVarCounter());

  test('return { | } inside a function annotated to return a record alias', () => {
    const source = [
      '// Point :: { x :: Number, y :: Number }',
      '// makePoint :: () -> Point',
      'function makePoint() {',
      '  return {  }',
      '}',
    ].join('\n');
    const braceOpen = source.lastIndexOf('{  }');
    const offset = braceOpen + 2;
    const items = getTypeAliasRecordCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['x', 'y']);
  });

  test('present keys are excluded from alias record completions', () => {
    const source = [
      '// Point :: { x :: Number, y :: Number }',
      '// makePoint :: () -> Point',
      'function makePoint() {',
      '  return { x: 1,  }',
      '}',
    ].join('\n');
    const offset = source.lastIndexOf(',') + 2;
    const items = getTypeAliasRecordCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('y');
    expect(labels).not.toContain('x');
  });
});

// ---------------------------------------------------------------------------
// Path completion edge cases
// ---------------------------------------------------------------------------

describe('path completion edge cases', () => {
  beforeEach(() => resetTypeVarCounter());

  test('import path into a nonexistent directory returns null', () => {
    const source = "import x from './missing-dir-xyz/f";
    const offset = source.length;
    const result = getImportPathCompletions(source, offset, sampleUri, makeCtx());
    expect(result).toBeNull();
  });

  test('::types with bare `.` lists the current directory', () => {
    const source = '// ::types .';
    const offset = source.length;
    const result = getTypeDirectivePathCompletions(source, offset, sampleUri);
    expect(result).not.toBeNull();
    const labels = result!.map(i => i.label);
    expect(labels).toContain('common');
    expect(labels).toContain('predicate/');
  });

  test('::types into a nonexistent directory returns null', () => {
    const source = '// ::types ./missing-dir-xyz/f';
    const offset = source.length;
    const result = getTypeDirectivePathCompletions(source, offset, sampleUri);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getTableSelectorCompletions
// ---------------------------------------------------------------------------

const SELECTOR_PRELUDE = [
  '// OrganisationRow :: { id :: Number, name :: String, slug :: String }',
  '// OrganisationSelector :: "id" | "name" | "slug"',
  '// Organisation :: [OrganisationSelector] -> QueryTag (Picked OrganisationRow OrganisationSelector)',
  'function Organisation(xs) { return null; }',
];

describe('getTableSelectorCompletions', () => {
  beforeEach(() => resetTypeVarCounter());

  test('offers quoted selector literals inside PascalCase([ ])', () => {
    const source = [...SELECTOR_PRELUDE, 'Organisation([ ]);'].join('\n');
    const offset = source.lastIndexOf('[') + 2;
    const items = getTableSelectorCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['"id"', '"name"', '"slug"']);
    expect(items[0].insertText).toMatch(/^"/);
  });

  test('inside an open quote the insert text is unquoted', () => {
    const source = [...SELECTOR_PRELUDE, 'Organisation([""]);'].join('\n');
    const offset = source.lastIndexOf('[""]') + 2; // between the quotes
    const items = getTableSelectorCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.insertText).not.toMatch(/^"/);
    }
    const filterTexts = items.map(i => i.filterText).sort();
    expect(filterTexts).toEqual(['id', 'name', 'slug']);
  });

  test('selectors already present in the literal are filtered out', () => {
    const source = [...SELECTOR_PRELUDE, 'Organisation(["id",  ]);'].join('\n');
    const offset = source.lastIndexOf(',') + 2;
    const items = getTableSelectorCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['"name"', '"slug"']);
  });

  test('returns empty for lowercase callee', () => {
    const source = [
      '// sel :: "a" | "b"',
      '// pick :: [sel] -> String',
      'function pick(xs) { return ""; }',
      'pick([ ]);',
    ].join('\n');
    const offset = source.lastIndexOf('[') + 2;
    const items = getTableSelectorCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });

  test('returns empty when not directly inside a call argument list', () => {
    const source = 'const xs = [ ];';
    const offset = source.lastIndexOf('[') + 2;
    const items = getTableSelectorCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveTypeBeforeDot fallbacks (dot after `)`, string / template literals)
// ---------------------------------------------------------------------------

describe('dot completion fallbacks', () => {
  beforeEach(() => resetTypeVarCounter());

  test('dot directly after a call expression offers the result record fields', () => {
    const source = [
      'function f() { return { alpha: 1, beta: "x" }; }',
      'f().',
    ].join('\n');
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('alpha');
    expect(labels).toContain('beta');
  });

  test('dot after a double-quoted string literal offers String methods', () => {
    const source = 'const x = 1;\n"hello".';
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('toUpperCase');
  });

  test('dot after a template literal offers String methods', () => {
    const source = 'const x = 1;\n`hello`.';
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('toUpperCase');
  });

  test('dot after a call expression with a partial member typed', () => {
    const source = [
      'function g() { return [1, 2, 3]; }',
      'g().ma',
    ].join('\n');
    const dotIdx = source.lastIndexOf('.');
    const offset = source.length; // cursor after the partial word
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('map');
  });
});

// ---------------------------------------------------------------------------
// Class statics + kv-constraint constructor dot
// ---------------------------------------------------------------------------

describe('class / constructor dot completions', () => {
  beforeEach(() => resetTypeVarCounter());

  test('FactoryName. offers registered static methods on the constructor function', () => {
    const source = [
      '// Wrapper :: a -> Wrapper a',
      '// Wrapper.of :: a -> Wrapper a',
      'function Wrapper(x) { return null; }',
      'Wrapper.',
    ].join('\n');
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('of');
  });

  test('.constructor. on a kind * -> * constrained param offers only statics', () => {
    const source = [
      '// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }',
      '// lift :: Monad m => m a -> m a',
      'const lift = (m) => {',
      '  return m.constructor.',
      '};',
    ].join('\n');
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('of');
    expect(labels).not.toContain('chain');
  });
});

// ---------------------------------------------------------------------------
// getAnnotationNameCompletions
// ---------------------------------------------------------------------------

describe('getAnnotationNameCompletions', () => {
  beforeEach(() => resetTypeVarCounter());

  test('offers unannotated top-level bindings with `Name :: ` insert text', () => {
    const source = [
      'const myFunc = (x) => x + 1;',
      '// myF',
    ].join('\n');
    const offset = source.length;
    const items = getAnnotationNameCompletions(source, offset, 'file:///test.js', makeCtx());
    const myFunc = items.find(i => i.label === 'myFunc');
    expect(myFunc).toBeDefined();
    expect(myFunc!.insertText).toBe('myFunc :: ');
  });

  test('bindings that already have an annotation are skipped', () => {
    const source = [
      '// annotated :: Number -> Number',
      'const annotated = (x) => x + 1;',
      'const plain = 2;',
      '// ',
    ].join('\n');
    const offset = source.length;
    const items = getAnnotationNameCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('plain');
    expect(labels).not.toContain('annotated');
  });

  test('partial word filters the offered bindings', () => {
    const source = [
      'const alpha = 1;',
      'const beta = 2;',
      '// al',
    ].join('\n');
    const offset = source.length;
    const items = getAnnotationNameCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('alpha');
    expect(labels).not.toContain('beta');
  });

  test('offers member-assignment targets like obj.member', () => {
    const source = [
      'const natives = {};',
      'natives.Object = (o) => o;',
      '// nat',
    ].join('\n');
    const offset = source.length;
    const items = getAnnotationNameCompletions(source, offset, 'file:///test.js', makeCtx());
    const member = items.find(i => i.label === 'natives.Object');
    expect(member).toBeDefined();
    expect(member!.insertText).toBe('natives.Object :: ');
  });

  test('returns empty when the comment line already contains ::', () => {
    const source = [
      'const myFunc = (x) => x;',
      '// myFunc :: ',
    ].join('\n');
    const offset = source.length;
    const items = getAnnotationNameCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });

  test('returns empty outside comments', () => {
    const source = 'const myFunc = 1;\nmyF';
    const offset = source.length;
    const items = getAnnotationNameCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });
});
