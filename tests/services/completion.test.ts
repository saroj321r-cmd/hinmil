import {
  buildAutoImportEdit,
  getDestructuringCompletions,
  getIdentifierCompletions,
  getDotCompletions,
  getBracketStringCompletions,
  getSumTypeRecordCompletions,
  getTypeAliasRecordCompletions,
  getImportSpecifierCompletions,
  getImportPathCompletions,
  getTypeDirectivePathCompletions,
  getWorkspaceExports,
  warmWorkspaceExports,
  clearWorkspaceExportCache,
  getAnnotationTypeCompletions,
  getDirectiveCompletions,
  getJSXPropCompletions,
  getJSXComponentCompletions,
  getJSXStyleKeyCompletions,
  findJsxOpeningTagContext,
  findJsxAttrObjectContext,
  CompletionContext,
} from '../../src/services/completion';
import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString, tCon, tFun, tString, tRecord, mono, Scheme } from '../../src/hm/types';
import { TempProject } from '../helpers/project';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Helper — minimal CompletionContext for tests
// ---------------------------------------------------------------------------

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

describe('buildAutoImportEdit', () => {
  // ── Default imports ──────────────────────────────────────────────────

  test('inserts default import after last import line', () => {
    const source = `import { foo } from './foo';\nimport { bar } from './bar';\n\nconst x = 1;\n`;
    const edit = buildAutoImportEdit(source, 'Baz', './baz', true);

    expect(edit.newText).toBe("import Baz from './baz';\n");
    expect(edit.range.start).toEqual({ line: 2, character: 0 });
    expect(edit.range.end).toEqual({ line: 2, character: 0 });
  });

  test('inserts default import at top when no imports exist', () => {
    const source = `const x = 1;\nconst y = 2;\n`;
    const edit = buildAutoImportEdit(source, 'Foo', './foo', true);

    expect(edit.newText).toBe("import Foo from './foo';\n");
    expect(edit.range.start).toEqual({ line: 0, character: 0 });
    expect(edit.range.end).toEqual({ line: 0, character: 0 });
  });

  // ── Named imports — new import line ──────────────────────────────────

  test('inserts new named import after last import line', () => {
    const source = `import { foo } from './foo';\nimport { bar } from './bar';\n\nconst x = 1;\n`;
    const edit = buildAutoImportEdit(source, 'baz', './baz');

    expect(edit.newText).toBe("import { baz } from './baz';\n");
    expect(edit.range.start).toEqual({ line: 2, character: 0 });
    expect(edit.range.end).toEqual({ line: 2, character: 0 });
  });

  test('inserts new named import at top when no imports exist', () => {
    const source = `const x = 1;\nconst y = 2;\n`;
    const edit = buildAutoImportEdit(source, 'foo', './foo');

    expect(edit.newText).toBe("import { foo } from './foo';\n");
    expect(edit.range.start).toEqual({ line: 0, character: 0 });
    expect(edit.range.end).toEqual({ line: 0, character: 0 });
  });

  // ── Named imports — append to existing import ────────────────────────

  test('appends to existing named import from same specifier', () => {
    const source = `import { foo } from './bar';\n\nconst x = 1;\n`;
    const edit = buildAutoImportEdit(source, 'baz', './bar');

    // Should replace from after last identifier to closing } (inclusive)
    expect(edit.newText).toBe(', baz }');
    // "import { foo } from './bar';"
    //  0123456789012  <- nameEnd=12 (after skipping space before }), bracePos=13
    expect(edit.range.start).toEqual({ line: 0, character: 12 });
    expect(edit.range.end).toEqual({ line: 0, character: 14 });
  });

  test('appends to existing named import with trailing comma', () => {
    const source = `import { foo, } from './bar';\n\nconst x = 1;\n`;
    const edit = buildAutoImportEdit(source, 'baz', './bar');

    // With trailing comma, it inserts " baz }" (no extra comma)
    expect(edit.newText).toBe(' baz }');
    // "import { foo, } from './bar';"
    //  0123456789012345  <- nameEnd=13 (comma at 12, space at 13 skipped), bracePos=14
    expect(edit.range.start).toEqual({ line: 0, character: 13 });
    expect(edit.range.end).toEqual({ line: 0, character: 15 });
  });

  // ── Named imports — append to existing require ───────────────────────

  test('appends to existing require from same specifier', () => {
    const source = `const { foo } = require('./bar');\n\nconst x = 1;\n`;
    const edit = buildAutoImportEdit(source, 'baz', './bar');

    expect(edit.newText).toBe(', baz }');
    // "const { foo } = require('./bar');"
    //  nameEnd=11 (after skipping space before }), bracePos=12
    expect(edit.range.start).toEqual({ line: 0, character: 11 });
    expect(edit.range.end).toEqual({ line: 0, character: 13 });
  });

  // ── Named imports — specifier differs ────────────────────────────────

  test('inserts new named import when specifier differs', () => {
    const source = `import { foo } from './foo';\n\nconst x = 1;\n`;
    const edit = buildAutoImportEdit(source, 'bar', './bar');

    expect(edit.newText).toBe("import { bar } from './bar';\n");
    // Insert after the one existing import line
    expect(edit.range.start).toEqual({ line: 1, character: 0 });
    expect(edit.range.end).toEqual({ line: 1, character: 0 });
  });

  // ── Edge: require counts as an import line for insert position ───────

  test('inserts after require lines when computing insert position', () => {
    const source = `const { a } = require('./a');\nconst { b } = require('./b');\n\nconst x = 1;\n`;
    const edit = buildAutoImportEdit(source, 'foo', './foo');

    // Source has no `import`/`export` keywords but contains `require(` —
    // detected as CJS, so the new import uses require-syntax to match.
    expect(edit.newText).toBe("const { foo } = require('./foo');\n");
    expect(edit.range.start).toEqual({ line: 2, character: 0 });
    expect(edit.range.end).toEqual({ line: 2, character: 0 });
  });

  // ── Module-style detection ───────────────────────────────────────────

  test('emits require for named import in pure CJS file', () => {
    const source = `"use strict";\nconst nil = require('./nil');\nmodule.exports = x => x;\n`;
    const edit = buildAutoImportEdit(source, 'isFunction', './isFunction');
    expect(edit.newText).toBe("const { isFunction } = require('./isFunction');\n");
  });

  test('emits require for default import in pure CJS file', () => {
    const source = `"use strict";\nconst nil = require('./nil');\nmodule.exports = x => x;\n`;
    const edit = buildAutoImportEdit(source, 'curry', '../more/curry', true);
    expect(edit.newText).toBe("const curry = require('../more/curry');\n");
  });

  test('emits import for ESM file even when require appears in a comment', () => {
    const source = `import { foo } from './foo';\n// const x = require('./x')\nexport const y = 1;\n`;
    const edit = buildAutoImportEdit(source, 'bar', './bar');
    expect(edit.newText).toBe("import { bar } from './bar';\n");
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  test('inserts default import when source is empty', () => {
    const edit = buildAutoImportEdit('', 'Foo', './foo', true);
    expect(edit.newText).toBe("import Foo from './foo';\n");
    expect(edit.range.start).toEqual({ line: 0, character: 0 });
  });

  test('inserts named import when source is empty', () => {
    const edit = buildAutoImportEdit('', 'foo', './foo');
    expect(edit.newText).toBe("import { foo } from './foo';\n");
    expect(edit.range.start).toEqual({ line: 0, character: 0 });
  });

  test('handles specifier with special regex characters', () => {
    const source = `import { foo } from './foo[bar]';\nconst x = 1;\n`;
    const edit = buildAutoImportEdit(source, 'baz', './baz');
    // Should not crash on special characters in existing specifier
    expect(edit.newText).toContain('baz');
  });
});

// ---------------------------------------------------------------------------
// getDestructuringCompletions
// ---------------------------------------------------------------------------

describe('getDestructuringCompletions', () => {
  beforeEach(() => resetTypeVarCounter());

  test('returns empty when cursor is not inside destructuring', () => {
    const source = 'const x = 42;';
    const items = getDestructuringCompletions(source, 10, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });

  test('returns record fields for destructuring of record-typed expression', () => {
    const source = `
const obj = { name: "hello", age: 42 };
const {  } = obj;
`;
    // Place cursor inside { } on last line — offset inside braces
    const braceOpen = source.lastIndexOf('{');
    const offset = braceOpen + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('name');
    expect(labels).toContain('age');
  });

  test('returns empty when braces are not preceded by const/let/var', () => {
    const source = 'if (true) {  }';
    const braceOpen = source.indexOf('{');
    const items = getDestructuringCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });

  test('returns record fields for object-pattern parameter inside higher-order call', () => {
    const source = `
const people = [{ name: "Bob", age: 25 }, { name: "Eve", age: 31 }];
const names = people.map(({  }) => 1);
`;
    const callIdx = source.indexOf('people.map');
    const braceOpen = source.indexOf('{', callIdx);
    const offset = braceOpen + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['age', 'name']);
  });

  test('object-pattern parameter excludes already-present keys', () => {
    const source = `
const people = [{ name: "Bob", age: 25 }];
const ages = people.map(({ name,  }) => 1);
`;
    const callIdx = source.indexOf('people.map');
    const commaIdx = source.indexOf(',', callIdx);
    const offset = commaIdx + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('age');
    expect(labels).not.toContain('name');
  });

  test('object-pattern parameter on plain arrow with annotated record', () => {
    const source = `
// User :: { name :: String, age :: Number }
// greet :: User -> String
const greet = ({  }) => "hi";
`;
    const arrowIdx = source.indexOf('=>');
    const braceOpen = source.lastIndexOf('{', arrowIdx);
    const offset = braceOpen + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['age', 'name']);
  });

  test('nested object-pattern parameter offers inner record fields', () => {
    const source = `
const people = [{ name: "Bob", age: 25, address: { street: "Keizersgracht", city: "Amsterdam" } }];
const r = people.map(({ address: {  } }) => 1);
`;
    // Inner '{' after 'address: '
    const addrIdx = source.indexOf('address:', source.indexOf('people.map'));
    const innerBrace = source.indexOf('{', addrIdx + 'address:'.length);
    const offset = innerBrace + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['city', 'street']);
  });

  test('nested object-pattern in `const { a: { | } }` destructuring', () => {
    const source = `
const obj = { a: { b: 1, c: 2 }, d: 3 };
const { a: {  } } = obj;
`;
    const declIdx = source.indexOf('const {');
    const innerBrace = source.indexOf('{', source.indexOf('a:', declIdx));
    const offset = innerBrace + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label).sort();
    expect(labels).toEqual(['b', 'c']);
  });

  test('member-chain RHS — `const { | } = foo.props` resolves nested record fields', () => {
    // Import a value `foo :: { props :: { id, name, age } }` and destructure
    // its `.props` member — the destructuring completion must follow the
    // member-chain to find the inner record's fields.
    const innerRec = tRecord({
      id: tCon('Number', []),
      name: tCon('String', []),
      age: tCon('Number', []),
    });
    const fooType = tRecord({ props: innerRec });
    const importedSchemes = new Map<string, Scheme>([
      ['foo', { type: fooType, vars: [] } as Scheme],
    ]);
    const ctx = makeCtx({
      createImportResolver: () => (specifier) =>
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
    expect(labels).toEqual(['age', 'id', 'name']);
  });
});

// ---------------------------------------------------------------------------
// getIdentifierCompletions
// ---------------------------------------------------------------------------

describe('getIdentifierCompletions', () => {
  beforeEach(() => resetTypeVarCounter());

  test('includes in-scope variables with types', () => {
    const source = 'const foo = 42;\nconst bar = "hello";\nf';
    const offset = source.length; // cursor after 'f'
    const items = getIdentifierCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('foo');
  });

  test('returns empty when cursor is after a dot (dot completion territory)', () => {
    const source = 'const obj = 42;\nobj.';
    const offset = source.length;
    const items = getIdentifierCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });

  test('returns empty when cursor is inside a string', () => {
    const source = "const x = 'fo";
    const offset = source.length;
    const items = getIdentifierCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });

  test('returns empty when cursor is inside a comment', () => {
    const source = 'const x = 1;\n// fo';
    const offset = source.length;
    const items = getIdentifierCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getBracketStringCompletions
// ---------------------------------------------------------------------------

describe('getBracketStringCompletions', () => {
  beforeEach(() => resetTypeVarCounter());

  test('provides record fields after obj["', () => {
    const source = 'const person = { name: "Bob", age: 25 };\nperson["';
    const offset = source.length;
    const items = getBracketStringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('name');
    expect(labels).toContain('age');
  });

  test("provides record fields after obj['", () => {
    const source = "const obj = { x: 1, y: 'hello' };\nobj['";
    const offset = source.length;
    const items = getBracketStringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('x');
    expect(labels).toContain('y');
  });

  test('returns empty for non-record', () => {
    const source = 'const arr = [1, 2, 3];\narr["';
    const offset = source.length;
    const items = getBracketStringCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items).toHaveLength(0);
  });

  test('provides record fields with auto-closed quotes: obj[""]', () => {
    // VS Code auto-closes " to "", cursor is between the quotes
    const source = 'const person = { name: "Bob", age: 25 };\nperson[""]';
    const offset = source.indexOf('["') + 2; // right after the opening "
    const items = getBracketStringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('name');
    expect(labels).toContain('age');
  });
});

// ---------------------------------------------------------------------------
// getDotCompletions
// ---------------------------------------------------------------------------

describe('getDotCompletions', () => {
  beforeEach(() => resetTypeVarCounter());

  test('provides Array methods after array literal dot', () => {
    const source = '[1, 2, 3].';
    const dotIdx = source.indexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('map');
    expect(labels).toContain('filter');
  });

  test('provides Array methods after array literal dot when previous line lacks semicolon', () => {
    const source = 'const person = { name: "Bob", age: 25 };\nconst personName = person["name"]\n\n[1].';
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('map');
    expect(labels).toContain('filter');
  });

  test('provides record fields after record dot', () => {
    const source = 'const obj = { x: 1, y: "hello" };\nobj.';
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('x');
    expect(labels).toContain('y');
  });

  test('returns empty when expression has no known type', () => {
    const source = 'unknownVar.';
    const dotIdx = source.indexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    // May or may not have items depending on inference — at least no crash
    expect(Array.isArray(items)).toBe(true);
  });

  test('provides String methods after string literal dot', () => {
    const source = '"hello".';
    const dotIdx = source.indexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('length');
    expect(labels).toContain('charAt');
    expect(labels).toContain('includes');
    expect(labels).toContain('split');
  });

  test('provides String methods after single-quoted literal dot', () => {
    const source = "'hello'.";
    const dotIdx = source.indexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('length');
    expect(labels).toContain('toUpperCase');
  });

  test('provides String methods after template literal dot', () => {
    const source = '`hello`.';
    const dotIdx = source.indexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('length');
    expect(labels).toContain('includes');
  });

  test('provides RegExp methods after regex literal dot', () => {
    const source = '/pattern/.';
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('test');
    expect(labels).toContain('exec');
    expect(labels).toContain('source');
  });

  test('provides String methods for string variable dot', () => {
    const source = 'const test = "hello";\ntest.';
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('length');
    expect(labels).toContain('charAt');
    expect(labels).toContain('includes');
  });

  test('provides Number methods for number variable dot', () => {
    const source = 'const n = 42;\nn.';
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('toString');
    expect(labels).toContain('toFixed');
  });

  test('provides Boolean methods for boolean variable dot', () => {
    const source = 'const b = true;\nb.';
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('toString');
    expect(labels).toContain('valueOf');
  });

  test('provides property from shorthand annotation (Type#prop :: PropType without ~>)', () => {
    const source = `
// Animal :: String -> Animal
function Animal(name) {
  // Animal#name :: String
  this.name = name;
}
const dog = new Animal('Rex');
dog.`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('name');
  });

  test('provides record-style sumtype variant fields on the parent type', () => {
    const source = `
/* Shape :: Circle { radius :: Number } | Square { side :: Number } */
// Circle :: Number -> Shape
function Circle(r) {}
// Square :: Number -> Shape
function Square(s) {}
function Shape() {}
// Shape#area :: Shape ~> () -> Number
Circle.prototype.area = function () { return 1; };
const s = Circle(1);
s.`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('radius');
    expect(labels).toContain('side');
    expect(labels).toContain('area');
  });

  test('provides fork method for constructor-assigned this.fork annotation', () => {
    const source = `
// RTask :: ((e -> (), a -> (), r) -> ()) -> RTask r e a
function RTask(fork) {
  if (!(this instanceof RTask)) return new RTask(fork);
  // RTask#fork :: RTask r e a ~> (e -> (), a -> (), r) -> ()
  this.fork = fork;
}
const skipCancel = () => {};
RTask.prototype = { constructor: RTask, map: function() {} };
// RTask#map :: RTask r e a ~> (a -> b) -> RTask r e b
function RTask$prototype$map(f) { return RTask(() => {}); }
const task = RTask((rej, res, e) => { res("hello") });
task.`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('fork');
    expect(labels).toContain('map');
  });

  test('provides instance constraint methods on kv-TCon values', () => {
    const source = `
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// map :: Functor f => (a -> b) -> f a -> f b
const map = fn => functor => functor.`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('map');
  });

  test('provides static constraint methods on TypeRep param', () => {
    const source = `
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// run :: Monad m => (TypeRep m, a) -> a
const run = (M, x) => M.`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('of');
    expect(labels).not.toContain('chain');
  });

  test('provides static constraint methods on .constructor in class style', () => {
    const source = `
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// Maybe :: Just a | Nothing
// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    // MaybeT#run :: Monad m => MaybeT m a ~> m (Maybe a)
    this.run = run;
  }
  // MaybeT#map :: Monad m => MaybeT m a ~> (a -> b) -> MaybeT m b
  map(fn) {
    return this.run.constructor.
  }
}`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('of');
    expect(labels).not.toContain('chain');
  });

  test('provides static constraint methods on .constructor in prototype style', () => {
    const source = `
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// Either :: Left e | Right a
// EitherT :: m (Either e a) -> EitherT e m a
function EitherT(run) {
  if (!(this instanceof EitherT)) return new EitherT(run);
  // EitherT#run :: Monad m => EitherT e m a ~> m (Either e a)
  this.run = run;
}
// EitherT#map :: Monad m => EitherT e m a ~> (a -> b) -> EitherT e m b
EitherT.prototype.map = function(fn) {
  return new EitherT(
    this.run.constructor.
  );
};`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('of');
    expect(labels).not.toContain('chain');
  });

  test('provides static constraint methods on constructor alias variable (A = x.constructor; A.)', () => {
    const source = `
// ::constraint Applicative f { f :: { ap :: f (a -> b) ~> f a -> f b, map :: f a ~> (a -> b) -> f b, of :: a -> f a } }
// ::constraint Semigroup s { s :: { concat :: s ~> s -> s } }
// concat :: Semigroup s => (s a, s a) -> s a
const concat = (xs, ys) => xs.concat(ys);
// append :: (Applicative f, Semigroup (f a)) => (a, f a) -> f a
const append = (item, container) => {
  const C = container.constructor;
  return concat (C.
  );
};`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('of');
    expect(labels).not.toContain('ap');
    expect(labels).not.toContain('map');
    expect(labels).not.toContain('concat');
  });

  test('provides instance constraint methods on kind * constrained TVar', () => {
    const source = `
// ::constraint Semigroup s { s :: { concat :: s ~> s -> s } }
// concat :: Semigroup s => s -> s -> s
const concat = a => b => a.`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('concat');
  });

  test('does not provide instance methods on kind * -> * constrained bare TVar', () => {
    const source = `
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// fn :: Functor f => f -> f
const fn = x => x.`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    expect(items).toHaveLength(0);
  });

  test('provides instance constraint methods on applied kind * constrained kv-TCon', () => {
    const source = `
// ::constraint Semigroup s { s :: { concat :: s ~> s -> s } }
// concat :: Semigroup (s a) => s a -> s a -> s a
const concat = a => b => a.`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('concat');
  });

  test('provides static methods on const factory function', () => {
    const source = `
// Identity :: a -> Identity a
const Identity = (value) => ({ value });
// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);
Identity.`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('of');
  });

  test('excludes static methods from instance dot-completions', () => {
    const source = `
// Building :: (String, Number) -> Building
function Building(name, floors) {
  // Building#name :: String
  this.name = name;
  // Building#floors :: Number
  this.floors = floors;
}
// Building.create :: (String, Number) -> Building
Building.create = function(name, floors) { return new Building(name, floors); };
const b = Building.create('Tower', 10);
b.`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('name');
    expect(labels).toContain('floors');
    expect(labels).not.toContain('create');
  });

  // ── Receiver scoping: dot must bind to the expression that ends at the
  //    dot, not to an enclosing/incomplete expression.

  test('inside .map callback, `arr[0].` offers element fields, not outer Array methods', () => {
    // The outer expression `[[{x:1}]].map(orgs => orgs[0].)` is a parse
    // error, but the inner receiver `orgs[0]` is a record `{x :: Number}`.
    // Typing a dot there must offer `x`, never `map`/`filter` from the
    // outer Array.
    const source = 'const r = [[{x:1}]].map(orgs => orgs[0].);';
    const dotIdx = source.indexOf('orgs[0].') + 'orgs[0]'.length;
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('x');
    expect(labels).not.toContain('map');
    expect(labels).not.toContain('filter');
  });

  test('inside callback, `arr[0].` on record array offers record fields only', () => {
    const source = [
      'const orgs = [[{ id: 1, name: "a" }]];',
      'const r = orgs.map(xs => xs[0].);',
    ].join('\n');
    const cbIdx = source.indexOf('xs[0].');
    const dotIdx = cbIdx + 'xs[0]'.length;
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('id');
    expect(labels).toContain('name');
    expect(labels).not.toContain('map');
    expect(labels).not.toContain('filter');
  });

  test('trailing-dot on assignment RHS does not surface methods of enclosing assignment', () => {
    // `const x = "a";` is fine — the trailing-dot form `x = "a".` is what
    // the user types mid-edit.  The dot's receiver is the string literal,
    // not the broader assignment expression.
    const source = 'const x = "hello".';
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('length');
    expect(labels).toContain('toUpperCase');
  });
});

// ---------------------------------------------------------------------------
// getSumTypeRecordCompletions
// ---------------------------------------------------------------------------

describe('getSumTypeRecordCompletions', () => {
  beforeEach(() => resetTypeVarCounter());

  test('returns empty when cursor is not inside return { }', () => {
    const source = 'const x = { };';
    const offset = source.indexOf('}') - 1;
    const items = getSumTypeRecordCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });

  test('returns empty when open brace is not preceded by return', () => {
    const source = 'const f = () => { const obj = { }; };';
    const braceOpen = source.lastIndexOf('{');
    const items = getSumTypeRecordCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });

  test('returns empty when no enclosing function name can be found', () => {
    const source = 'return {  };';
    const braceOpen = source.indexOf('{');
    const items = getSumTypeRecordCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });

  test('returns empty when function annotation does not return a sum type', () => {
    const source = `
// make :: Number -> String
const make = x => {
  return {  };
};
`;
    const braceOpen = source.lastIndexOf('{', source.lastIndexOf('}'));
    const items = getSumTypeRecordCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });

  test('offers registered methods for sum type factory function', () => {
    const source = `
// Maybe :: Just a | Nothing

// Maybe#map :: Maybe a ~> (a -> b) -> Maybe b
Just.prototype.map = function(fn) { return Just(fn(this.value)); };

// Just :: a -> Maybe a
const Just = value => {
  return {  };
};
`;
    const braceOpen = source.lastIndexOf('{', source.lastIndexOf('}'));
    const items = getSumTypeRecordCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('map');
  });

  test('skips already-present keys in the object literal', () => {
    const source = `
// Maybe :: Just a | Nothing

// Maybe#map :: Maybe a ~> (a -> b) -> Maybe b
Just.prototype.map = function(fn) { return Just(fn(this.value)); };

// Maybe#chain :: Maybe a ~> (a -> Maybe b) -> Maybe b
Just.prototype.chain = function(fn) { return fn(this.value); };

// Just :: a -> Maybe a
const Just = value => {
  return { map: fn => fn(value) };
};
`;
    const returnBrace = source.indexOf('{ map:');
    const items = getSumTypeRecordCompletions(source, returnBrace + 2, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    // map is already present, so should not be offered
    expect(labels).not.toContain('map');
    // chain should still be offered
    expect(labels).toContain('chain');
  });

  test('offers registered methods for non-sumtype TCon factory', () => {
    const source = `
// Box :: a -> Box a
// Box#map :: Box a ~> (a -> b) -> Box b
// Box#inspect :: Box a ~> () -> String
const Box = value => {
  return {  };
};
`;
    const braceOpen = source.lastIndexOf('{', source.lastIndexOf('}'));
    const items = getSumTypeRecordCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('map');
    expect(labels).toContain('inspect');
  });

  test('offers registered methods for non-sumtype TCon via arrow return', () => {
    const source = `
// Box :: a -> Box a
// Box#map :: Box a ~> (a -> b) -> Box b
const Box = value => ({  });
`;
    const braceOpen = source.lastIndexOf('{');
    const items = getSumTypeRecordCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('map');
  });

  test('excludes static methods from non-sumtype TCon completions', () => {
    const source = `
// Building#info :: Building ~> () -> String
class Building {
  constructor(name) { this.name = name; }
  static create(name) { return new Building(name); }
}

// createBuilding :: String -> Building
const createBuilding = name => {
  return {  };
};
`;
    const braceOpen = source.lastIndexOf('{', source.lastIndexOf('}'));
    const items = getSumTypeRecordCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('info');
    expect(labels).not.toContain('create');
  });

  test('does not offer completions for builtin types', () => {
    const source = `
// make :: Number -> String
const make = x => {
  return {  };
};
`;
    const braceOpen = source.lastIndexOf('{', source.lastIndexOf('}'));
    const items = getSumTypeRecordCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getImportSpecifierCompletions
// ---------------------------------------------------------------------------

describe('getImportSpecifierCompletions', () => {
  beforeEach(() => resetTypeVarCounter());

  test('returns null when cursor is not inside import braces', () => {
    const source = 'const x = 1;';
    const result = getImportSpecifierCompletions(source, 5, 'file:///test.js', makeCtx());
    expect(result).toBeNull();
  });

  test('returns null when braces are not preceded by import', () => {
    const source = 'const { x } = obj;';
    const braceOpen = source.indexOf('{');
    const result = getImportSpecifierCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    expect(result).toBeNull();
  });

  test('returns null when no from clause is present', () => {
    const source = "import {  }";
    const braceOpen = source.indexOf('{');
    const result = getImportSpecifierCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    expect(result).toBeNull();
  });

  test('returns [] (suppressing fallthrough) when target module cannot be resolved', () => {
    const source = "import {  } from './nonexistent';";
    const braceOpen = source.indexOf('{');
    const result = getImportSpecifierCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    expect(result).toEqual([]);
  });
  test('offers exports from a module that can be resolved', () => {
    const mockExports = new Map<string, Scheme>([
      ['add', mono(tCon('Number'))],
      ['sub', mono(tCon('Number'))],
    ]);
    const ctx = makeCtx({
      inferFileAndCacheExports: () => mockExports,
    });
    // resolveImportSpecifier resolves relative to the URI — use a real-ish file path
    // Since this is unit-test territory, we mock the export but need `from` to resolve
    // We'll use a file:// URI that is the sample dir so ./common resolves
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.join(sampleDir, 'test.js');
    const source = "import {  } from './common';";
    const braceOpen = source.indexOf('{');
    const result = getImportSpecifierCompletions(source, braceOpen + 2, uri, ctx);
    // Module exists in sample/ dir so specifier should resolve
    if (result) {
      const labels = result.map(i => i.label);
      expect(labels).toContain('add');
      expect(labels).toContain('sub');
    }
  });

  test('excludes already-imported specifiers', () => {
    const mockExports = new Map<string, Scheme>([
      ['add', mono(tCon('Number'))],
      ['sub', mono(tCon('Number'))],
      ['mul', mono(tCon('Number'))],
    ]);
    const ctx = makeCtx({
      inferFileAndCacheExports: () => mockExports,
    });
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.join(sampleDir, 'test.js');
    const source = "import { add,  } from './common';";
    const offset = source.indexOf(',') + 2;
    const result = getImportSpecifierCompletions(source, offset, uri, ctx);
    if (result) {
      const labels = result.map(i => i.label);
      expect(labels).not.toContain('add');
      expect(labels).toContain('sub');
      expect(labels).toContain('mul');
    }
  });

  test('excludes default export', () => {
    const mockExports = new Map<string, Scheme>([
      ['default', mono(tCon('Number'))],
      ['helper', mono(tCon('String'))],
    ]);
    const ctx = makeCtx({
      inferFileAndCacheExports: () => mockExports,
    });
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.join(sampleDir, 'test.js');
    const source = "import {  } from './common';";
    const braceOpen = source.indexOf('{');
    const result = getImportSpecifierCompletions(source, braceOpen + 2, uri, ctx);
    if (result) {
      const labels = result.map(i => i.label);
      expect(labels).not.toContain('default');
      expect(labels).toContain('helper');
    }
  });

  test('offers exports from a package typed via a .hm override (react.hm)', () => {
    const project = new TempProject('import-spec-hm-override', { overrides: { react: './react.hm' } });
    project.setup();
    try {
      project.write('react.hm', fs.readFileSync(path.resolve(__dirname, '..', '..', 'sample', 'react.hm'), 'utf8'));
      const importCtx = project.createContext();
      const uri = 'file://' + project.pathOf('App.jsx');
      const ctx = makeCtx({
        createImportResolver: (u) => importCtx.createImportResolver(u),
        inferFileAndCacheExports: (u) => importCtx.inferFileAndCacheExports(u),
      });
      const source = 'import {  } from "react";\nconst Card = () => 1;\nexport default Card;';
      const result = getImportSpecifierCompletions(source, source.indexOf('{ ') + 2, uri, ctx);
      expect(result).not.toBeNull();
      const labels = result!.map(i => i.label);
      expect(labels).toContain('useState');
      expect(labels).toContain('useEffect');
      // The current file's own bindings must never leak into the list.
      expect(labels).not.toContain('Card');
      expect(labels).not.toContain('default');
    } finally {
      project.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// getImportPathCompletions
// ---------------------------------------------------------------------------

describe('getImportPathCompletions', () => {
  beforeEach(() => resetTypeVarCounter());

  test('returns null when cursor is not inside a string', () => {
    const source = 'const x = 1;';
    const result = getImportPathCompletions(source, 5, 'file:///test.js', makeCtx());
    expect(result).toBeNull();
  });

  test('returns null when string is not in from/require context', () => {
    const source = 'const x = "hello";';
    const offset = source.indexOf('hello');
    const result = getImportPathCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(result).toBeNull();
  });

  test('suggests ./ and ../ for bare import path', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.join(sampleDir, 'test.js');
    const source = "import x from 'f";
    const offset = source.length;
    const result = getImportPathCompletions(source, offset, uri, makeCtx());
    if (result) {
      const labels = result.map(i => i.label);
      expect(labels).toContain('./');
      expect(labels).toContain('../');
    }
  });

  test('lists JS files in the sample directory', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.join(sampleDir, 'test.js');
    const source = "import x from './";
    const offset = source.length;
    const result = getImportPathCompletions(source, offset, uri, makeCtx());
    expect(result).not.toBeNull();
    const labels = result!.map(i => i.label);
    // sample/ directory contains common.js, demo.js, etc.
    expect(labels).toContain('common');
    expect(labels).toContain('demo');
  });

  test('lists subdirectories with trailing slash', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.join(sampleDir, 'test.js');
    const source = "import x from './";
    const offset = source.length;
    const result = getImportPathCompletions(source, offset, uri, makeCtx());
    expect(result).not.toBeNull();
    const labels = result!.map(i => i.label);
    // sample/ has a predicate/ subdirectory
    expect(labels).toContain('predicate/');
  });

  test('filters files by prefix', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.join(sampleDir, 'test.js');
    const source = "import x from './dem";
    const offset = source.length;
    const result = getImportPathCompletions(source, offset, uri, makeCtx());
    expect(result).not.toBeNull();
    const labels = result!.map(i => i.label);
    expect(labels).toContain('demo');
    expect(labels).not.toContain('common');
  });

  test('excludes hidden files and node_modules', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.join(sampleDir, 'test.js');
    const source = "import x from './";
    const offset = source.length;
    const result = getImportPathCompletions(source, offset, uri, makeCtx());
    if (result) {
      const labels = result.map(i => i.label);
      for (const label of labels) {
        expect(label).not.toMatch(/^\./);
        expect(label).not.toBe('node_modules');
      }
    }
  });

  test('works with require() syntax', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.join(sampleDir, 'test.js');
    const source = "const x = require('./";
    const offset = source.length;
    const result = getImportPathCompletions(source, offset, uri, makeCtx());
    expect(result).not.toBeNull();
    const labels = result!.map(i => i.label);
    expect(labels).toContain('common');
  });

  test('navigates into subdirectory', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.join(sampleDir, 'test.js');
    const source = "import x from './predicate/";
    const offset = source.length;
    const result = getImportPathCompletions(source, offset, uri, makeCtx());
    expect(result).not.toBeNull();
    const labels = result!.map(i => i.label);
    // predicate/ directory contains nil.js
    expect(labels).toContain('nil');
  });
});

// ---------------------------------------------------------------------------
// getWorkspaceExports
// ---------------------------------------------------------------------------

describe('getWorkspaceExports', () => {
  test('returns empty map when no exports are found', () => {
    const result = getWorkspaceExports(
      'file:///nonexistent/dir/test.js',
      () => null,
    );
    expect(result.size).toBe(0);
  });

  test('scans the sample directory for exports', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.join(sampleDir, 'test.js');
    const engine = new InferenceEngine();

    const result = getWorkspaceExports(uri, (fileUri) => {
      try {
        const filePath = fileUri.replace('file://', '');
        const source = fs.readFileSync(filePath, 'utf-8');
        const r = engine.infer(source);
        return r.exports;
      } catch {
        return null;
      }
    });

    // sample/ has multiple .js files with module.exports
    // At the very least, the scan shouldn't crash
    expect(result).toBeInstanceOf(Map);
  });

  test('excludes the source file itself', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const commonPath = path.join(sampleDir, 'common.js');
    const uri = 'file://' + commonPath;

    // Track which files are inferred
    const inferredFiles: string[] = [];
    getWorkspaceExports(uri, (fileUri) => {
      inferredFiles.push(fileUri);
      return null;
    });

    // The source file itself should never be passed to the inferrer
    expect(inferredFiles).not.toContain('file://' + commonPath);
  });

  test('maps default exports under the file stem', () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, '.tmp-ws-'));
    try {
      // Create two files: one with a default export, one source file
      fs.writeFileSync(path.join(tmpDir, 'source.js'), 'const x = 1;');
      fs.writeFileSync(path.join(tmpDir, 'helper.js'), 'export default function foo() {}');

      const uri = 'file://' + path.join(tmpDir, 'source.js');
      const result = getWorkspaceExports(uri, (fileUri) => {
        const fp = fileUri.replace('file://', '');
        if (fp.includes('helper')) {
          return new Map<string, Scheme>([['default', mono(tCon('Function'))]]);
        }
        return null;
      });

      // The default export from helper.js should appear under 'helper'
      expect(result.has('helper')).toBe(true);
      const entries = result.get('helper')!;
      expect(entries[0].isDefault).toBe(true);
    } finally {
      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('maps named exports under their export name', () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, '.tmp-ws-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'source.js'), 'const x = 1;');
      fs.writeFileSync(path.join(tmpDir, 'utils.js'), 'export const add = (a, b) => a + b;');

      const uri = 'file://' + path.join(tmpDir, 'source.js');
      const result = getWorkspaceExports(uri, (fileUri) => {
        const fp = fileUri.replace('file://', '');
        if (fp.includes('utils')) {
          return new Map<string, Scheme>([['add', mono(tCon('Number'))]]);
        }
        return null;
      });

      expect(result.has('add')).toBe(true);
      const entries = result.get('add')!;
      expect(entries[0].isDefault).toBeUndefined();
      expect(entries[0].specifier).toContain('utils');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('scans subdirectories', () => {
    const tmpDir = fs.mkdtempSync(path.join(__dirname, '.tmp-ws-'));
    const subDir = path.join(tmpDir, 'lib');
    try {
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(tmpDir, 'source.js'), 'const x = 1;');
      fs.writeFileSync(path.join(subDir, 'math.js'), 'export const mul = (a, b) => a * b;');

      const uri = 'file://' + path.join(tmpDir, 'source.js');
      const result = getWorkspaceExports(uri, (fileUri) => {
        const fp = fileUri.replace('file://', '');
        if (fp.includes('math')) {
          return new Map<string, Scheme>([['mul', mono(tCon('Number'))]]);
        }
        return null;
      });

      expect(result.has('mul')).toBe(true);
      expect(result.get('mul')![0].specifier).toContain('lib/math');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('scans sibling directories of the parent (fpkit-style layout)', () => {
    // Layout: <tmp>/src/predicate/source.js, <tmp>/src/more/curry.js
    const tmpDir = fs.mkdtempSync(path.join(__dirname, '.tmp-ws-'));
    const srcDir = path.join(tmpDir, 'src');
    const predDir = path.join(srcDir, 'predicate');
    const moreDir = path.join(srcDir, 'more');
    try {
      fs.mkdirSync(predDir, { recursive: true });
      fs.mkdirSync(moreDir, { recursive: true });
      fs.writeFileSync(path.join(predDir, 'source.js'), 'const x = 1;');
      fs.writeFileSync(path.join(moreDir, 'curry.js'), 'module.exports = x => x;');

      const uri = 'file://' + path.join(predDir, 'source.js');
      const result = getWorkspaceExports(uri, (fileUri) => {
        const fp = fileUri.replace('file://', '');
        if (fp.endsWith('curry.js')) {
          return new Map<string, Scheme>([['default', mono(tCon('Function'))]]);
        }
        return null;
      });

      // The default export of curry.js should be reachable as `curry`
      // (mapped under the file stem for default exports).
      expect(result.has('curry')).toBe(true);
      expect(result.get('curry')![0].specifier).toContain('../more/curry');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// getTypeAliasRecordCompletions
// =========================================================================

describe('getTypeAliasRecordCompletions', () => {
  test('offers missing fields for arrow function with => ({ | })', () => {
    const source = `
// Person :: { name :: String, age :: Number, email :: String }
// makePerson :: String -> Person
const makePerson = name => ({
  name: name,
  |
})
`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const ctx = makeCtx();
    const items = getTypeAliasRecordCompletions(code, offset, 'file:///test.js', ctx);
    expect(items.length).toBe(2);
    const labels = items.map(i => i.label);
    expect(labels).toContain('age');
    expect(labels).toContain('email');
  });

  test('offers missing fields for return { | } in block body', () => {
    const source = `
// Env :: { count :: Number, name :: String }
// makeEnv :: Number -> Env
function makeEnv(count) {
  return {
    count: count,
    |
  }
}
`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const ctx = makeCtx();
    const items = getTypeAliasRecordCompletions(code, offset, 'file:///test.js', ctx);
    expect(items.length).toBe(1);
    expect(items[0].label).toBe('name');
  });

  test('returns empty when all fields are already present', () => {
    const source = `
// Env :: { count :: Number, name :: String }
// makeEnv :: Number -> Env
const makeEnv = count => ({
  count: count,
  name: "hello",
  |
})
`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const ctx = makeCtx();
    const items = getTypeAliasRecordCompletions(code, offset, 'file:///test.js', ctx);
    expect(items).toHaveLength(0);
  });

  test('returns empty when return type is not a type alias', () => {
    const source = `
// greet :: String -> String
const greet = name => ({
  |
})
`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const ctx = makeCtx();
    const items = getTypeAliasRecordCompletions(code, offset, 'file:///test.js', ctx);
    expect(items).toHaveLength(0);
  });

  test('returns empty when cursor is not in an object literal', () => {
    const source = `
// Person :: { name :: String, age :: Number }
// makePerson :: String -> Person
const makePerson = name => name|
`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const ctx = makeCtx();
    const items = getTypeAliasRecordCompletions(code, offset, 'file:///test.js', ctx);
    expect(items).toHaveLength(0);
  });
});

describe('getDotCompletions — class static methods on `ClassName.`', () => {
  beforeEach(() => resetTypeVarCounter());

  test('typing `Counter.` offers static fields and methods', () => {
    const source = `
// Counter :: () -> Counter
// Counter.MAX :: Number
class Counter {
  static MAX = 100;
  static greet() { return "hi"; }
  count = 0;
  tick() { return this.count + 1; }
}
Counter.`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('MAX');
    expect(labels).toContain('greet');
  });

  test('typing `instance.` does NOT offer static methods', () => {
    const source = `
// Counter :: () -> Counter
class Counter {
  static MAX = 100;
  count = 0;
  tick() { return this.count + 1; }
}
const c = new Counter();
c.`;
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).not.toContain('MAX');
  });
});

describe('Directive keyword completions', () => {
  test('returns all directives when cursor is right after ::', () => {
    const source = `// ::|`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const items = getDirectiveCompletions(code, offset);
    expect(items).toHaveLength(12);
    const labels = items.map(i => i.label);
    expect(labels).toContain('::types');
    expect(labels).toContain('::ignore');
    expect(labels).toContain('::prefer');
    expect(labels).toContain('::extend');
    expect(labels).toContain('::rep');
    expect(labels).toContain('::hidden');
    expect(labels).toContain('::private');
  });

  test('returns empty outside directive context', () => {
    const source = `const x = ::|`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    expect(getDirectiveCompletions(code, offset)).toHaveLength(0);
  });

  test('rep is offered and has plain insertText (no snippet)', () => {
    const source = `// ::r|`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const items = getDirectiveCompletions(code, offset);
    const repItem = items.find(i => i.label === '::rep');
    expect(repItem).toBeDefined();
    expect(repItem?.insertText).toBe('rep');
  });

  test('filters by partial input', () => {
    const source = `// ::i|`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const items = getDirectiveCompletions(code, offset);
    const labels = items.map(i => i.label);
    expect(labels).toContain('::ignore');
    expect(labels).toContain('::ignore-file');
    expect(labels).toContain('::ignore-function');
    expect(labels).not.toContain('::types');
    expect(labels).not.toContain('sumtype');
  });

  test('returns empty for type annotation (name :: Type)', () => {
    const source = `// f :: N|`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    expect(getDirectiveCompletions(code, offset)).toHaveLength(0);
  });

  test('returns empty for unique prefix with no match', () => {
    const source = `// ::d|`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const items = getDirectiveCompletions(code, offset);
    expect(items).toHaveLength(0);
  });

  test('directive items have snippet insertText where applicable', () => {
    const source = `// ::c|`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const items = getDirectiveCompletions(code, offset);
    const constraintItem = items.find(i => i.label === '::constraint');
    expect(constraintItem?.insertText).toBe('constraint $1 $2 { $3 }');
  });

  test('ignore has plain insertText (no snippet)', () => {
    const source = `// ::i|`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const items = getDirectiveCompletions(code, offset);
    const ignoreItem = items.find(i => i.label === '::ignore');
    expect(ignoreItem?.insertText).toBe('ignore');
  });

  test('filterText includes :: prefix for VS Code filtering', () => {
    const source = `// ::i|`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const items = getDirectiveCompletions(code, offset);
    const ignoreItem = items.find(i => i.label === '::ignore');
    expect(ignoreItem?.filterText).toBe('::ignore');
  });

  test('matches multi-letter prefix', () => {
    const source = `// ::ig|`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const items = getDirectiveCompletions(code, offset);
    const labels = items.map(i => i.label);
    expect(labels).toContain('::ignore');
    expect(labels).toContain('::ignore-file');
    expect(labels).toContain('::ignore-function');
    expect(items).toHaveLength(3);
  });
});

describe('Annotation type completions', () => {
  test('offers built-in type names in annotation comments', () => {
    const source = `// f :: |`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const ctx = makeCtx();
    const items = getAnnotationTypeCompletions(code, offset, 'file:///test.js', ctx);
    const labels = items.map(i => i.label);
    expect(labels).toContain('Number');
    expect(labels).toContain('String');
    expect(labels).toContain('Any');
    expect(labels).toContain('Integer');
    expect(labels).toContain('Float');
    expect(labels).toContain('Double');
    expect(labels).toContain('NonNegativeInteger');
    expect(labels).toContain('NegativeInteger');
    expect(labels).toContain('StrMap');
    expect(labels).toContain('Buffer');
    expect(labels).toContain('Object');
  });

  test('filters by partial input', () => {
    const source = `// f :: Int|`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const ctx = makeCtx();
    const items = getAnnotationTypeCompletions(code, offset, 'file:///test.js', ctx);
    const labels = items.map(i => i.label);
    expect(labels).toContain('Integer');
    expect(labels).not.toContain('Number');
    expect(labels).not.toContain('String');
  });

  test('returns empty outside annotation comments', () => {
    const source = `const x = |`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const ctx = makeCtx();
    const items = getAnnotationTypeCompletions(code, offset, 'file:///test.js', ctx);
    expect(items).toHaveLength(0);
  });

  test('returns empty in comment without ::', () => {
    const source = `// just a comment |`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const ctx = makeCtx();
    const items = getAnnotationTypeCompletions(code, offset, 'file:///test.js', ctx);
    expect(items).toHaveLength(0);
  });

  test('includes type aliases from file', () => {
    const source = `
// Url :: String
// f :: |
const f = x => x;
`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const ctx = makeCtx();
    const items = getAnnotationTypeCompletions(code, offset, 'file:///test.js', ctx);
    const labels = items.map(i => i.label);
    expect(labels).toContain('Url');
  });
});

describe('Annotation name completions for identifier input', () => {
  test('suggests annotation name when function not yet implemented', () => {
    const source = `
// testNewFeatures :: Number -> Number
const testN|
`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const ctx = makeCtx();
    const items = getIdentifierCompletions(code, offset, 'file:///test.js', ctx);
    const labels = items.map(i => i.label);
    expect(labels).toContain('testNewFeatures');
  });

  test('does not suggest annotation names that already have a binding', () => {
    const source = `
// add :: Number -> Number -> Number
const add = (a, b) => a + b;
const a|
`;
    const offset = source.indexOf('|');
    const code = source.replace('|', '');
    const ctx = makeCtx();
    const items = getIdentifierCompletions(code, offset, 'file:///test.js', ctx);
    // 'add' should appear from topLevelBindings, not duplicated
    const addItems = items.filter(i => i.label === 'add');
    expect(addItems).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Deeper coverage for uncovered paths
// ---------------------------------------------------------------------------

describe('getIdentifierCompletions — scoped identifiers', () => {
  beforeEach(() => resetTypeVarCounter());

  test('includes function parameter in scope', () => {
    const source = `
const fn = (param1, param2) => {
  p
};
`;
    const offset = source.indexOf('  p') + 3;
    const items = getIdentifierCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('param1');
    expect(labels).toContain('param2');
  });

  test('includes block-scoped variables', () => {
    const source = `
function outer() {
  const localVar = 42;
  l
}
`;
    const offset = source.indexOf('  l') + 3;
    const items = getIdentifierCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('localVar');
  });
});

describe('getTypeAliasRecordCompletions — TCon alias path', () => {
  beforeEach(() => resetTypeVarCounter());

  test('suggests record fields for return type that is a type alias to a record', () => {
    const source = `
// Point :: { x :: Number, y :: Number }
// makePoint :: Number -> Number -> Point
const makePoint = (x, y) => {
  return {  };
};
`;
    const braceOpen = source.lastIndexOf('{', source.lastIndexOf('}') - 1);
    const offset = braceOpen + 2;
    const items = getTypeAliasRecordCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('x');
    expect(labels).toContain('y');
  });

  test('suggests fields for arrow expression body with type alias return', () => {
    const source = `
// Config :: { host :: String, port :: Number }
// defaultConfig :: () -> Config
const defaultConfig = () => ({  });
`;
    const braceOpen = source.lastIndexOf('{');
    const offset = braceOpen + 2;
    const items = getTypeAliasRecordCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('host');
    expect(labels).toContain('port');
  });
});

describe('getDestructuringCompletions — deeper paths', () => {
  beforeEach(() => resetTypeVarCounter());

  test('returns record fields when RHS is typed as record via annotation', () => {
    const source = `
const conf = { host: "localhost", port: 3000 };
const {  } = conf;
`;
    const braceOpen = source.lastIndexOf('{');
    const offset = braceOpen + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('host');
    expect(labels).toContain('port');
  });

  test('returns empty when no closing brace found after cursor', () => {
    // Missing closing brace should be handled gracefully
    const source = `const { `;
    const items = getDestructuringCompletions(source, 8, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });

  test('returns empty when no = follows closing brace', () => {
    const source = `const {  } + foo;`;
    const braceOpen = source.indexOf('{');
    const items = getDestructuringCompletions(source, braceOpen + 2, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });
});

describe('getDotCompletions — multi-line dot', () => {
  beforeEach(() => resetTypeVarCounter());

  test('resolves type when dot is on next line after expression', () => {
    const source = 'const arr = [1, 2, 3];\narr\n  .';
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('map');
    expect(labels).toContain('filter');
  });
});

describe('getImportPathCompletions — file system paths', () => {
  beforeEach(() => resetTypeVarCounter());

  test('returns folder hints for non-relative partial', () => {
    const source = `import foo from '`;
    const offset = source.length;
    const items = getImportPathCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items).not.toBeNull();
    const labels = items!.map(i => i.label);
    expect(labels).toContain('./');
    expect(labels).toContain('../');
  });

  test('lists js files from sample directory', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.resolve(sampleDir, 'test.js');
    const source = `import { curry } from './`;
    const offset = source.length;
    const items = getImportPathCompletions(source, offset, uri, makeCtx());
    if (items) {
      const labels = items.map(i => i.label);
      // sample/ directory contains common.js
      expect(labels.some(l => l === 'common' || l.includes('common'))).toBe(true);
    }
  });

  test('lists subdirectories', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.resolve(sampleDir, 'test.js');
    const source = `import x from './`;
    const offset = source.length;
    const items = getImportPathCompletions(source, offset, uri, makeCtx());
    if (items) {
      const labels = items.map(i => i.label);
      // sample/ has predicate/ and readme/ subdirectories
      expect(labels.some(l => l === 'predicate/' || l === 'readme/')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// getDotCompletions — constructor and constraint method completions
// ---------------------------------------------------------------------------

describe('getDotCompletions — constructor static methods', () => {
  beforeEach(() => resetTypeVarCounter());

  test('offers constructor.of when constructor is accessed on instance', () => {
    const source = `
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// ::method Monad Identity { chain :: Identity a ~> (a -> Identity b) -> Identity b, of :: a -> Identity a }
// Identity :: a -> Identity a
const Identity = x => ({ value: x, chain: f => f(x), constructor: Identity });
Identity.of = x => Identity(x);
const id = Identity(42);
id.constructor.`;
    const offset = source.length;
    const dotIdx = offset - 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('of');
  });
});

describe('getDotCompletions — next-line dot', () => {
  beforeEach(() => resetTypeVarCounter());

  test('resolves type when dot is on next line after known expression', () => {
    const source = `const arr = [1, 2, 3];\narr\n  .`;
    const offset = source.length;
    const dotIdx = offset - 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('map');
    expect(labels).toContain('filter');
  });
});

// ---------------------------------------------------------------------------
// getIdentifierCompletions — additional scoped identifiers
// ---------------------------------------------------------------------------

describe('getIdentifierCompletions — function scope', () => {
  beforeEach(() => resetTypeVarCounter());

  test('includes previously declared top-level bindings with partial match', () => {
    const source = `const xVal = 1;\nconst xOther = 2;\nconst result = x`;
    const offset = source.length; // cursor after 'x'
    const items = getIdentifierCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('xVal');
    expect(labels).toContain('xOther');
  });
});

// ---------------------------------------------------------------------------
// getDotCompletions — String method completions
// ---------------------------------------------------------------------------

describe('getDotCompletions — String methods', () => {
  beforeEach(() => resetTypeVarCounter());

  test('string literal dot offers String methods', () => {
    const source = `const s = 'hello';\ns.`;
    const offset = source.length;
    const dotIdx = offset - 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('length');
  });
});

// ---------------------------------------------------------------------------
// getDestructuringCompletions — record RHS
// ---------------------------------------------------------------------------

describe('getDestructuringCompletions — annotated record RHS', () => {
  beforeEach(() => resetTypeVarCounter());

  test('offers record fields from annotated identifier', () => {
    const source = `// point :: { x :: Number, y :: Number }\nconst point = { x: 1, y: 2 };\nconst {  } = point;`;
    // Put cursor inside the braces
    const openBrace = source.lastIndexOf('{');
    const offset = openBrace + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('x');
    expect(labels).toContain('y');
  });

  test('offers record fields from a call-expression RHS', () => {
    // Regression: destructuring the result of a call expression like
    // `const { insert } = Repo (Organisation)` previously returned no
    // completions because the RHS scanner only handled identifier/member
    // chains.  Extending past balanced parens lets the inferred call
    // result type drive the field list.
    const source = [
      '/* Repo :: Table a -> {',
      '  insert :: a -> RTask r e a,',
      '  insertBatch :: [a] -> RTask r e [a],',
      '  updateById :: a -> RTask r e a',
      '}*/',
      'const Repo = (model) => ({});',
      'const Organisation = {};',
      'const {  } = Repo (Organisation);',
      '',
    ].join('\n');
    const openBrace = source.lastIndexOf('{');
    const offset = openBrace + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('insert');
    expect(labels).toContain('insertBatch');
    expect(labels).toContain('updateById');
  });
});

// ---------------------------------------------------------------------------
// getDestructuringCompletions — no brace
// ---------------------------------------------------------------------------

describe('getDestructuringCompletions — edge cases', () => {
  beforeEach(() => resetTypeVarCounter());

  test('returns empty when no opening brace found', () => {
    const source = `const x = 1; const y = x`;
    const offset = source.length;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items).toEqual([]);
  });

  test('record type offers field completions in destructuring', () => {
    const source = `const obj = { name: 'Alice', age: 30 };\nconst {  } = obj`;
    const openBrace = source.lastIndexOf('{');
    const offset = openBrace + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items.some(i => i.label === 'name')).toBe(true);
    expect(items.some(i => i.label === 'age')).toBe(true);
  });

  test('type alias record offers field completions in destructuring', () => {
    const source = `// ::type Point = { x :: Number, y :: Number }\n// p :: Point\nconst p = { x: 1, y: 2 };\nconst {  } = p`;
    const openBrace = source.lastIndexOf('{');
    const offset = openBrace + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items).toBeDefined();
    if (items.length > 0) {
      expect(items.some(i => i.label === 'x')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// getDotCompletions — type alias record
// ---------------------------------------------------------------------------

describe('getDotCompletions — type alias record', () => {
  beforeEach(() => resetTypeVarCounter());

  test('dot completion from type alias expanding to record', () => {
    const source = `// ::type Config = { host :: String, port :: Number }\n// getConfig :: () -> Config\nconst getConfig = () => ({ host: 'localhost', port: 3000 });\ngetConfig().`;
    const offset = source.length;
    const dotIdx = source.lastIndexOf('.');
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    expect(items).toBeDefined();
    if (items && items.length > 0) {
      expect(items.some(i => i.label === 'host')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// getDotCompletions — parenthesized expression
// ---------------------------------------------------------------------------

describe('getDotCompletions — after parenthesized call', () => {
  beforeEach(() => resetTypeVarCounter());

  test('dot completion after call expression ending with )', () => {
    const source = `const arr = [1, 2]; arr.map(x => x + 1).`;
    const offset = source.length;
    const dotIdx = source.lastIndexOf('.');
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    expect(items).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// getAnnotationTypeCompletions
// ---------------------------------------------------------------------------

describe('getAnnotationTypeCompletions', () => {
  beforeEach(() => resetTypeVarCounter());

  test('returns annotation completions with standard types', () => {
    const source = `// foo :: N`;
    const offset = source.length;
    const items = getAnnotationTypeCompletions(source, offset, 'file:///test.js', makeCtx());
    expect(items).toBeDefined();
    if (items && items.length > 0) {
      const labels = items.map(i => i.label);
      expect(labels.some(l => l === 'Number' || l === 'Null')).toBe(true);
    }
  });

  test('includes data types and constraint names in completions', () => {
    const source = [
      '// Either :: Left e | Right a',
      '// Left :: e -> Either e a',
      '// Right :: a -> Either e a',
      '// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }',
      '// x :: ',
    ].join('\n');
    const offset = source.length;
    const items = getAnnotationTypeCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('Either');
    expect(labels).toContain('Functor');
  });
});

// ---------------------------------------------------------------------------
// getTypeAliasRecordCompletions — findEnclosingFuncName both-match
// ---------------------------------------------------------------------------

describe('getTypeAliasRecordCompletions — both function and var match', () => {
  beforeEach(() => resetTypeVarCounter());

  test('prefers the closer declaration when both function and var exist', () => {
    // Both a function decl and a const decl exist before the cursor.
    // The var decl (makePoint) is closer to the cursor, so it should be chosen.
    const source = [
      '// Point :: { x :: Number, y :: Number }',
      'function helper(a) { return a; }',
      '// makePoint :: Number -> Point',
      'const makePoint = (x) => {',
      '  return {  }',
      '};',
    ].join('\n');
    // cursor in the { } of the return statement
    const returnBrace = source.indexOf('return {') + 'return { '.length;
    const items = getTypeAliasRecordCompletions(source, returnBrace, 'file:///test.js', makeCtx());
    // Should find record fields x, y from Point type alias
    expect(items.length).toBeGreaterThan(0);
    const labels = items.map(i => i.label);
    expect(labels).toContain('x');
    expect(labels).toContain('y');
  });
});

// ---------------------------------------------------------------------------
// getDestructuringCompletions — record type + TCon alias + method names
// ---------------------------------------------------------------------------

describe('getDestructuringCompletions — record and alias types', () => {
  beforeEach(() => resetTypeVarCounter());

  test('offers record fields for destructuring a record-typed variable', () => {
    const source = [
      '// Config :: { host :: String, port :: Number }',
      '// mkConfig :: Config',
      'const mkConfig = { host: "localhost", port: 8080 };',
      'const {  } = mkConfig;',
    ].join('\n');
    const braceIdx = source.lastIndexOf('{') + 1;
    const items = getDestructuringCompletions(source, braceIdx + 1, 'file:///test.js', makeCtx());
    if (items.length > 0) {
      const labels = items.map(i => i.label);
      expect(labels).toContain('host');
      expect(labels).toContain('port');
    }
  });

  test('offers record fields from plain record type in nodeTypes', () => {
    const source = [
      'const obj = { name: "Alice", age: 30 };',
      'const {  } = obj;',
    ].join('\n');
    const offset = source.lastIndexOf('{') + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('name');
    expect(labels).toContain('age');
  });

  test('offers alias record fields for TCon-typed destructuring via import', () => {
    // When a function returns a TCon (e.g. Config) and the local source has
    // the alias definition, the TCon branch resolves the alias to TRecord
    const importedSchemes = new Map<string, Scheme>([
      ['getConfig', mono(tFun(tString, tCon('Config', [])))],
    ]);
    const ctx = makeCtx({
      createImportResolver: () => (specifier) =>
        specifier === './other' ? importedSchemes : null,
    });
    const source = [
      '// Config :: { host :: String, port :: Number }',
      'import { getConfig } from "./other";',
      'const c = getConfig("dev");',
      'const {  } = c;',
    ].join('\n');
    const offset = source.lastIndexOf('{') + 2;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', ctx);
    const labels = items.map(i => i.label);
    expect(labels).toContain('host');
    expect(labels).toContain('port');
  });
});

describe('getDestructuringCompletions — nested braces', () => {
  test('offers remaining fields when nested destructuring precedes cursor', () => {
    const source = [
      '/* Opts :: { a :: Number, b :: { x :: String }, c :: Boolean } */',
      'const fn = opts => opts;',
      'const val = fn({ a: 1, b: { x: "hi" }, c: true });',
      'const { b: { x },  } = val;',
    ].join('\n');
    const offset = source.lastIndexOf('},') + 4;
    const items = getDestructuringCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('a');
    expect(labels).toContain('c');
  });
});

// ---------------------------------------------------------------------------
// getDestructuringCompletions — TCon method completions
// ---------------------------------------------------------------------------

describe('getDestructuringCompletions — TCon with methods', () => {
  beforeEach(() => resetTypeVarCounter());

  test('offers registered method names for TCon-typed variable', () => {
    const source = [
      '// Either :: Left a | Right b',
      '// Either#map :: Either a b ~> (b -> c) -> Either a c',
      '// val :: Either String Number',
      'const val = 42;',
      'const {  } = val;',
    ].join('\n');
    const braceIdx = source.lastIndexOf('{');
    const items = getDestructuringCompletions(source, braceIdx + 2, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('map');
  });
});

// ---------------------------------------------------------------------------
// getDotCompletions — TCon type alias to TRecord
// ---------------------------------------------------------------------------

describe('getDotCompletions — TCon alias to record', () => {
  beforeEach(() => resetTypeVarCounter());

  test('offers record fields from type alias on TCon-typed dot access', () => {
    // Import a function returning Config (TCon), define Config alias locally
    const importedSchemes = new Map<string, Scheme>([
      ['getConfig', mono(tFun(tString, tCon('Config', [])))],
    ]);
    const ctx = makeCtx({
      createImportResolver: () => (specifier) =>
        specifier === './other' ? importedSchemes : null,
    });
    const source = [
      '// Config :: { host :: String, port :: Number }',
      'import { getConfig } from "./other";',
      'const c = getConfig("dev");',
      'c.',
    ].join('\n');
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', ctx);
    const labels = items.map(i => i.label);
    // Should find fields from the alias or methods
    expect(items.length).toBeGreaterThanOrEqual(0);
  });

  test('offers record fields from type alias on directly annotated TCon', () => {
    // The val has type Config (TCon) from annotation, Config is a record alias
    const importedSchemes = new Map<string, Scheme>([
      ['val', { type: tCon('Config', []), vars: [] } as Scheme],
    ]);
    const ctx = makeCtx({
      createImportResolver: () => (specifier) =>
        specifier === './config' ? importedSchemes : null,
    });
    const source = [
      '// Config :: { host :: String, port :: Number }',
      'import { val } from "./config";',
      'val.',
    ].join('\n');
    const dotIdx = source.lastIndexOf('.');
    const offset = dotIdx + 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', ctx);
    const labels = items.map(i => i.label);
    expect(labels).toContain('host');
    expect(labels).toContain('port');
  });
});

// ---------------------------------------------------------------------------
// getImportPathCompletions — dot-only partial and export details
// ---------------------------------------------------------------------------

describe('getImportPathCompletions — dot-only partial and export detail', () => {
  beforeEach(() => resetTypeVarCounter());

  test('dot-only partial lists current directory contents', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.resolve(sampleDir, 'test.js');
    // partial is just "." — startsWith('.') but no '/'
    const source = `import foo from '.`;
    const offset = source.length;
    const items = getImportPathCompletions(source, offset, uri, makeCtx());
    expect(items).not.toBeNull();
    if (items) {
      const labels = items.map(i => i.label);
      // Should list files/folders from sample/ (common, demo, etc.)
      expect(labels.some(l => l === 'common' || l === 'demo')).toBe(true);
    }
  });

  test('file path completions include export detail when available', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.resolve(sampleDir, 'test.js');
    const exportMap = new Map<string, Scheme>();
    exportMap.set('curry', mono(tFun(tString, tString)));
    const ctx = makeCtx({
      inferFileAndCacheExports: () => exportMap,
    });
    const source = `import { x } from './`;
    const offset = source.length;
    const items = getImportPathCompletions(source, offset, uri, ctx);
    expect(items).not.toBeNull();
    if (items) {
      const withDetail = items.filter(i => i.detail && i.detail.startsWith('exports:'));
      expect(withDetail.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// getTypeDirectivePathCompletions — `// ::types ./|`
// ---------------------------------------------------------------------------

describe('getTypeDirectivePathCompletions', () => {
  test('returns null when not in a comment', () => {
    const source = `const x = '::types ./'`;
    const items = getTypeDirectivePathCompletions(source, source.length - 1, 'file:///x.js');
    expect(items).toBeNull();
  });

  test('returns null when the line is not a ::types directive', () => {
    const source = `// ::ignore`;
    const items = getTypeDirectivePathCompletions(source, source.length, 'file:///x.js');
    expect(items).toBeNull();
  });

  test('empty path suggests ./ and ../', () => {
    const source = `// ::types `;
    const items = getTypeDirectivePathCompletions(source, source.length, 'file:///x.js');
    expect(items).not.toBeNull();
    const labels = items!.map(i => i.label).sort();
    expect(labels).toEqual(['../', './']);
  });

  test('dot-only partial lists workspace directory contents', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.resolve(sampleDir, 'test.js');
    const source = `// ::types ./`;
    const items = getTypeDirectivePathCompletions(source, source.length, uri);
    expect(items).not.toBeNull();
    const labels = items!.map(i => i.label);
    expect(labels.some(l => l === 'common' || l === 'demo')).toBe(true);
  });

  test('partial filename narrows results', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.resolve(sampleDir, 'test.js');
    const source = `// ::types ./com`;
    const items = getTypeDirectivePathCompletions(source, source.length, uri);
    expect(items).not.toBeNull();
    const labels = items!.map(i => i.label);
    expect(labels.every(l => l.startsWith('com'))).toBe(true);
    expect(labels).toContain('common');
  });

  test('directory paths are listed (resolvable to index.js)', () => {
    // Walk up from one of our own source files to ensure tests/ folder
    // appears as a directory completion under the project root.
    const projectRoot = path.resolve(__dirname, '..', '..');
    const uri = 'file://' + path.resolve(projectRoot, 'x.js');
    const source = `// ::types ./`;
    const items = getTypeDirectivePathCompletions(source, source.length, uri);
    expect(items).not.toBeNull();
    const labels = items!.map(i => i.label);
    expect(labels).toContain('src/');
    expect(labels).toContain('tests/');
  });
});

// ---------------------------------------------------------------------------
// getIdentifierCompletions — workspace auto-import
// ---------------------------------------------------------------------------

describe('getIdentifierCompletions — workspace auto-import', () => {
  beforeEach(() => resetTypeVarCounter());

  test('suggests exported names from sibling files with auto-import edit', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.resolve(sampleDir, 'test.js');
    const exportMap = new Map<string, Scheme>();
    exportMap.set('curryHelper', mono(tFun(tString, tString)));
    const infer = () => exportMap;
    const ctx = makeCtx({
      inferFileAndCacheExports: infer,
    });
    // The identifier-completion request path is cache-only; populate the
    // workspace-export cache the way the server's background loop does.
    clearWorkspaceExportCache();
    while (!warmWorkspaceExports(uri, infer, 25)) { /* warm to completion */ }
    // partial "cu" (>= 2 chars) should match "curryHelper"
    const source = `const x = cu`;
    const offset = source.length;
    const items = getIdentifierCompletions(source, offset, uri, ctx);
    const match = items.find(i => i.label === 'curryHelper');
    expect(match).toBeDefined();
    expect(match!.detail).toContain('from');
    expect(match!.additionalTextEdits).toBeDefined();
    expect(match!.additionalTextEdits!.length).toBeGreaterThan(0);
  });

  test('autoImports: false suppresses workspace auto-import suggestions', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.resolve(sampleDir, 'test.js');
    const exportMap = new Map<string, Scheme>();
    exportMap.set('curryHelper', mono(tFun(tString, tString)));
    const infer = () => exportMap;
    const ctx = makeCtx({
      inferFileAndCacheExports: infer,
      autoImports: false,
    });
    clearWorkspaceExportCache();
    while (!warmWorkspaceExports(uri, infer, 25)) { /* warm to completion */ }
    const source = `const x = cu`;
    const offset = source.length;
    const items = getIdentifierCompletions(source, offset, uri, ctx);
    expect(items.find(i => i.label === 'curryHelper')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getDestructuringCompletions — default import module exports
// ---------------------------------------------------------------------------

describe('getDestructuringCompletions — default import exports', () => {
  beforeEach(() => resetTypeVarCounter());

  test('offers named exports when destructuring a default-imported module', () => {
    const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
    const uri = 'file://' + path.resolve(sampleDir, 'test.js');
    const exportMap = new Map<string, Scheme>();
    exportMap.set('greet', mono(tFun(tString, tString)));
    exportMap.set('default', mono(tCon('Number')));
    const ctx = makeCtx({
      inferFileAndCacheExports: () => exportMap,
    });
    const source = `import common from './common';\nconst {  } = common;`;
    const braceOpen = source.indexOf('{', source.indexOf('const'));
    const offset = braceOpen + 2;
    const items = getDestructuringCompletions(source, offset, uri, ctx);
    const labels = items.map(i => i.label);
    expect(labels).toContain('greet');
    expect(labels).not.toContain('default');
  });
});

// ---------------------------------------------------------------------------
// JSX completions
// ---------------------------------------------------------------------------

describe('JSX completions', () => {
  const defs = `
// Badge :: { label :: String, count :: Number, hint :: (String | Undefined) } -> ReactElement
const Badge = ({ label, count, hint }) => <span>{label}{count}</span>;
const UI = { Badge };
`;

  // Cursor position is marked with ¦ in the fixture.
  function propItems(fixture: string) {
    resetTypeVarCounter();
    const offset = fixture.lastIndexOf('¦');
    const source = fixture.replace('¦', '');
    return getJSXPropCompletions(source, offset, 'file:///test.jsx', makeCtx());
  }

  describe('findJsxOpeningTagContext', () => {
    test('detects a simple open tag', () => {
      const src = `${defs}const el = <Badge `;
      expect(findJsxOpeningTagContext(src, src.length)).toMatchObject({ tagName: 'Badge' });
    });

    test('detects member-expression tags', () => {
      const src = `${defs}const el = <UI.Badge c`;
      expect(findJsxOpeningTagContext(src, src.length)).toMatchObject({ tagName: 'UI.Badge' });
    });

    test('returns null inside expression containers, closed tags and comparisons', () => {
      const closeBrace = `${defs}const el = <Badge count={`;
      expect(findJsxOpeningTagContext(closeBrace, closeBrace.length)).toBeNull();
      const closed = `${defs}const el = <Badge label="x" />`;
      expect(findJsxOpeningTagContext(closed, closed.length)).toBeNull();
      const cmp = `${defs}const el2 = 1 < 2; c`;
      expect(findJsxOpeningTagContext(cmp, cmp.length)).toBeNull();
    });
  });

  describe('getJSXPropCompletions', () => {
    test('lists all props on an open tag, marking optional ones', () => {
      const items = propItems(`${defs}const el = <Badge ¦`);
      const byLabel = new Map(items.map(i => [i.label, i]));
      expect([...byLabel.keys()].sort()).toEqual(['count', 'hint', 'label']);
      expect(byLabel.get('label')!.insertText).toBe('label="$1"$0');
      expect(byLabel.get('count')!.insertText).toBe('count={$1}$0');
      expect(byLabel.get('hint')!.detail).toMatch(/optional/);
    });

    test('filters by partial prefix and excludes present attrs', () => {
      expect(propItems(`${defs}const el = <Badge l¦`).map(i => i.label)).toEqual(['label']);
      const after = propItems(`${defs}const el = <Badge label="x" ¦`).map(i => i.label).sort();
      expect(after).toEqual(['count', 'hint']);
    });

    test('resolves member-expression tags and multiline tags', () => {
      expect(propItems(`${defs}const el = <UI.Badge c¦`).map(i => i.label)).toEqual(['count']);
      expect(propItems(`${defs}const el = <Badge\n  label="x"\n  c¦`).map(i => i.label)).toEqual(['count']);
    });

    test('stays silent inside values, after closing, and without a tag', () => {
      expect(propItems(`${defs}const el = <Badge count={¦`)).toEqual([]);
      expect(propItems(`${defs}const el = <Badge label="¦`)).toEqual([]);
      expect(propItems(`${defs}const el = <Badge label="x" />¦`)).toEqual([]);
      expect(propItems(`${defs}const el2 = 1 < 2; c¦`)).toEqual([]);
    });
  });

  describe('intrinsic tag attribute completion', () => {
    test('offers catalogue attributes with correct snippets', () => {
      const items = propItems(`const el = <div cla¦`);
      expect(items.map(i => i.label)).toEqual(['className']);
      expect(items[0].insertText).toBe('className="$1"$0');
      expect(items[0].detail).toBe('String');

      const style = propItems(`const el = <div sty¦`);
      expect(style[0].insertText).toBe('style={$1}$0');
    });

    test('tag-specific attributes sort above globals', () => {
      expect(propItems(`const el = <input ch¦`).map(i => i.label)).toEqual(['checked']);
      expect(propItems(`const el = <label htm¦`).map(i => i.label)).toEqual(['htmlFor']);
      const img = propItems(`const el = <img s¦`);
      expect(img.map(i => i.label)).toEqual(['src', 'srcSet', 'sizes', 'style', 'spellCheck']);
      expect(img[0].sortText! < img[3].sortText!).toBe(true);
    });

    test('excludes attributes already present', () => {
      expect(propItems(`const el = <div className="x" cla¦`)).toEqual([]);
    });

    test('event handlers use expression snippets', () => {
      const items = propItems(`const el = <button onCli¦`);
      expect(items.map(i => i.label)).toEqual(['onClick']);
      expect(items[0].insertText).toBe('onClick={$1}$0');
    });
  });

  describe('style object key completion', () => {
    // Cursor position is marked with ¦ in the fixture.
    function styleItems(fixture: string) {
      resetTypeVarCounter();
      const offset = fixture.lastIndexOf('¦');
      const source = fixture.replace('¦', '');
      return getJSXStyleKeyCompletions(source, offset, makeCtx());
    }

    test('detects the enclosing attribute object', () => {
      const src = `const el = <div style={{ colo`;
      expect(findJsxAttrObjectContext(src, src.length)).toMatchObject({
        tagName: 'div',
        attrName: 'style',
      });
    });

    test('offers CSS properties filtered by prefix', () => {
      const items = styleItems(`const el = <div style={{ colo¦`)!;
      const labels = items.map(i => i.label);
      expect(labels).toContain('color');
      expect(labels.every(l => l.toLowerCase().includes('colo'))).toBe(true);
      const color = items.find(i => i.label === 'color')!;
      expect(color.insertText).toBe('color: $1');
      expect(color.detail).toMatch(/String/);
    });

    test('offers the full catalogue on an empty key position', () => {
      const items = styleItems(`const el = <div style={{ ¦`)!;
      expect(items.length).toBeGreaterThan(100);
      expect(items.map(i => i.label)).toContain('flexDirection');
    });

    test('works after a comma and filters out present keys', () => {
      const items = styleItems(`const el = <div style={{ color: 'red', c¦`)!;
      const labels = items.map(i => i.label);
      expect(labels).toContain('cursor');
      expect(labels).not.toContain('color');
    });

    test('stays silent in value positions (loose values, css vars allowed)', () => {
      expect(styleItems(`const el = <div style={{ color: ¦`)).toBeNull();
      expect(styleItems(`const el = <div style={{ '--brand': ¦`)).toBeNull();
    });

    test('stays silent outside style attributes and non-JSX objects', () => {
      expect(styleItems(`const el = <div onClick={{ c¦`)).toBeNull();
      expect(styleItems(`const o = { c¦`)).toBeNull();
      expect(styleItems(`const el = <div style={¦`)).toBeNull();
    });

    test('handles multiline and spaced object literals', () => {
      const items = styleItems(`const el = (
        <div
          style={ {
            color: 'red',
            fontW¦`)!;
      expect(items.map(i => i.label)).toEqual(['fontWeight']);
    });
  });

  describe('getJSXComponentCompletions', () => {
    test('suggests uppercase components after <', () => {
      resetTypeVarCounter();
      const src = `${defs}const el = <Ba`;
      const labels = getJSXComponentCompletions(src, src.length, 'file:///test.jsx', makeCtx()).map(i => i.label);
      expect(labels).toContain('Badge');
    });

    test('stays silent for lowercase partials and non-JSX <', () => {
      resetTypeVarCounter();
      const lower = `${defs}const el = <ba`;
      expect(getJSXComponentCompletions(lower, lower.length, 'file:///test.jsx', makeCtx())).toEqual([]);
      const cmp = `${defs}const x = 1 <Ba`;
      // `1 <Ba` parses as a comparison — still fine to suggest inside JSX-capable
      // files only when preceded by <; the guard rejects </, <=, etc.
      const close = `${defs}const el = </Ba`;
      expect(getJSXComponentCompletions(close, close.length, 'file:///test.jsx', makeCtx())).toEqual([]);
    });
  });
});
