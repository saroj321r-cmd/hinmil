import { extractAnnotations, buildAnnotationMap, buildAnnotationByOffset, extractTypeDirectives, extractConstraintDirectives, hasIgnoreFileDirective, extractIgnoreLineDirectives, extractIgnoreFunctionDirectives, extractImportedNames, extractDataDirectives, isDataShorthand, parseDataShorthand } from '../../src/commentParser';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';

beforeEach(() => {
  resetTypeVarCounter();
});

describe('extractAnnotations — comment patterns', () => {
  test('single-line // :: annotation', () => {
    const source = `// :: Number -> Number
const double = (x) => x * 2;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].raw).toBe('Number -> Number');
    expect(anns[0].scheme).not.toBeNull();
    expect(anns[0].name).toBe('double');
  });

  test('block comment /* :: */ annotation', () => {
    const source = `/* :: String -> Number */
const length = (s) => s.length;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].raw).toBe('String -> Number');
    expect(anns[0].name).toBe('length');
  });

  test('JSDoc-style /** :: */ annotation', () => {
    const source = `/** :: Boolean -> Boolean */
const not = (b) => !b;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].raw).toBe('Boolean -> Boolean');
  });

  test('annotation on function declaration', () => {
    const source = `// :: Number -> Number -> Number
function add(a, b) {
  return a + b;
}`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('add');
    expect(anns[0].raw).toBe('Number -> Number -> Number');
  });

  test('no :: prefix is ignored', () => {
    const source = `// This is a regular comment
const x = 42;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(0);
  });

  test('multiple annotations', () => {
    const source = `// :: Number -> Number
const double = (x) => x * 2;
// :: String -> String
const upper = (s) => s.toUpperCase();`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(2);
    expect(anns[0].name).toBe('double');
    expect(anns[1].name).toBe('upper');
  });
});

describe('extractAnnotations — polymorphic', () => {
  test('polymorphic annotation with free vars', () => {
    const source = `// :: a -> a
const id = (x) => x;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].scheme).not.toBeNull();
    expect(anns[0].scheme!.vars).toHaveLength(1);
    expect(typeToString(anns[0].scheme!.type)).toBe('a -> a');
  });
});

describe('extractAnnotations — generics', () => {
  test('[Number] annotation', () => {
    const source = `// :: [Number] -> Number
const sum = (arr) => arr.reduce((a, b) => a + b, 0);`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].raw).toBe('[Number] -> Number');
    const t = anns[0].scheme!.type;
    expect(typeToString(t)).toBe('[Number] -> Number');
  });
});

describe('extractAnnotations — error handling', () => {
  test('invalid type signature sets error', () => {
    const source = `// :: ->
const x = 42;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].scheme).toBeNull();
    expect(anns[0].error).toBeDefined();
  });

  test('invalid syntax still extracts what it can', () => {
    const source = `// :: Number -> -> Number
const x = 42;
// :: String -> String
const y = "hello";`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(2);
    expect(anns[0].error).toBeDefined();
    expect(anns[1].scheme).not.toBeNull();
  });
});

describe('buildAnnotationMap', () => {
  test('creates name -> annotation mapping', () => {
    const source = `// double :: Number -> Number
const double = (x) => x * 2;
// len :: String -> Number
function len(s) { return s.length; }`;
    const map = buildAnnotationMap(source);
    expect(map.size).toBe(2);
    expect(map.has('double')).toBe(true);
    expect(map.has('len')).toBe(true);
    expect(map.get('double')!.raw).toBe('Number -> Number');
    expect(map.get('len')!.raw).toBe('String -> Number');
  });

  test('excludes annotations with parse errors', () => {
    const source = `// broken :: ->
const broken = 42;
// ok :: Number
const ok = 42;`;
    const map = buildAnnotationMap(source);
    expect(map.has('broken')).toBe(false);
    expect(map.has('ok')).toBe(true);
  });
});

describe('extractAnnotations — let declaration', () => {
  test('annotation on let', () => {
    const source = `// :: Number
let x = 42;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('x');
  });
});

describe('extractAnnotations — named annotations', () => {
  test('// name :: type extracts name from comment', () => {
    const source = `// add :: (Number, Number) -> Number
const add = (a, b) => a + b;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('add');
    expect(anns[0].raw).toBe('(Number, Number) -> Number');
    expect(anns[0].scheme).not.toBeNull();
    expect(typeToString(anns[0].scheme!.type)).toBe('(Number, Number) -> Number');
  });

  test('// :: type (without name) still works', () => {
    const source = `// :: String -> Boolean
const isEmpty = (s) => s === "";`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('isEmpty');
    expect(anns[0].raw).toBe('String -> Boolean');
  });

  test('named annotation name takes precedence over AST name', () => {
    const source = `// myFunc :: Number -> Number
const f = (x) => x + 1;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('myFunc');
  });

  test('$ in annotation names is supported', () => {
    const source = `// Either#$value :: Either e a ~> (e | a)
const x = 42;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('Either#$value');
  });
});

describe('extractAnnotations — node offsets', () => {
  test('nodeStart is set correctly', () => {
    const source = `// :: Number
const x = 42;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].nodeStart).toBeDefined();
    expect(anns[0].nodeStart).toBeGreaterThan(anns[0].commentEnd - 1);
  });
});
describe('extractAnnotations — error handling', () => {
  test('malformed annotation produces error not crash', () => {
    const source = `// foo :: ->
const foo = 42;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].error).toBeDefined();
  });

  test('annotation without following declaration uses annotationName', () => {
    const source = `// myFunc :: Number -> Number`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('myFunc');
  });
});

describe('extractAnnotations — declaration kinds', () => {
  test('annotation before class', () => {
    const source = `// Foo :: Number -> Foo
class Foo { constructor(x) { this.x = x; } }`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('Foo');
  });

  test('annotation before assignment expression (Box.fromPair)', () => {
    const source = `// Box.fromPair :: (Number, String) -> Number
Box.fromPair = (pair) => pair[0];`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('Box.fromPair');
  });
});

describe('extractAnnotations — ::narrow directive', () => {
  test('::narrow attaches a type predicate to the next annotation', () => {
    const source = `// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";`;

    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('isString');
    expect(anns[0].scheme).not.toBeNull();
    expect(anns[0].scheme!.typePredicate).toBeDefined();
    expect(anns[0].scheme!.typePredicate!.paramName).toBe('a');
    expect(typeToString(anns[0].scheme!.typePredicate!.narrowedType)).toBe('String');
  });

  test('::narrow on non-Boolean annotation produces error', () => {
    const source = `// ::narrow String
// isString :: a -> String
const isString = x => x;`;

    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].scheme).toBeNull();
    expect(anns[0].error).toContain('Boolean-returning functions');
  });
});

describe('buildAnnotationMap — offset keying', () => {
  test('map contains annotations by name', () => {
    const source = `// add :: Number -> Number -> Number
const add = (a, b) => a + b;
// inc :: Number -> Number
const inc = (x) => x + 1;`;
    const map = buildAnnotationMap(source);
    expect(map.has('add')).toBe(true);
    expect(map.has('inc')).toBe(true);
    expect(map.get('add')!.raw).toBe('Number -> Number -> Number');
  });
});

describe('extractTypeDirectives — fallback regex', () => {
  test('extracts ::types directive from source', () => {
    const source = `// ::types ./demo
const x = 42;`;
    const dirs = extractTypeDirectives(source);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe('./demo');
  });
});

describe('extractConstraintDirectives — fallback regex', () => {
  test('extracts ::constraint directive from source', () => {
    const source = `// ::constraint Num { add, mul }
const x = 42;`;
    const dirs = extractConstraintDirectives(source);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].text).toContain('Num');
  });
});

describe('extractAnnotations — ExportDefaultDeclaration first', () => {
  test('annotation before export default function extracts name', () => {
    const source = `// :: Number -> Number
export default function foo(x) { return x + 1; }`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('foo');
    expect(anns[0].raw).toBe('Number -> Number');
  });
});

describe('extractAnnotations — ExpressionStatement non-assignment', () => {
  test('annotation before plain expression statement not attached', () => {
    const source = `// :: Number
console.log("hello");`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    // console.log is ExpressionStatement with CallExpression, not assignment
    expect(anns[0].name).toBeUndefined();
  });
});

describe('extractAnnotations — ExportNamedDeclaration', () => {
  test('annotation before export const extracts name', () => {
    const source = `// :: Number
export const foo = 42;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('foo');
    expect(anns[0].raw).toBe('Number');
  });

  test('annotation before export function extracts name', () => {
    const source = `// :: Number -> Number
export function bar(x) { return x + 1; }`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('bar');
  });
});

describe('buildAnnotationByOffset', () => {
  test('maps node start offset to annotation', () => {
    const source = `// add1 :: Number -> Number
const add1 = (x) => x + 1;`;
    const map = buildAnnotationByOffset(source);
    expect(map.size).toBeGreaterThan(0);
    // The map should have an entry keyed by the nodeStart of the function
    const entries = [...map.entries()];
    expect(entries.length).toBe(1);
    expect(entries[0][1].raw).toBe('Number -> Number');
  });

  test('skips annotations without nodeStart', () => {
    const source = `// :: Number -> Number
// no declaration here, just comments`;
    const map = buildAnnotationByOffset(source);
    // Annotation isn't attached to a declaration, so it may be empty
    // (depends on whether the comment statement gets picked up)
  });
});

describe('extractAnnotations — ExportDefaultDeclaration', () => {
  test('annotation before export default function', () => {
    const source = `// :: Number -> Number
export default function inc(x) { return x + 1; }`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('inc');
  });
});

describe('extractAnnotations — ClassDeclaration', () => {
  test('annotation before class extracts name', () => {
    const source = `// :: Number -> Number
class Foo { }`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('Foo');
  });
});

describe('extractAnnotations — multi-line annotations', () => {
  test('huge generated multi-line record annotation joins in linear time', () => {
    // Regression: joining used to re-scan the FULL accumulated body per
    // appended line (isSignatureComplete/hasOpenDelimiters/global \s+
    // normalization), making a generated sidecar with a record annotation
    // spanning thousands of `//` lines (e.g. sqlkit's `Tables :: { … }`,
    // 11k lines) quadratic — ~4.5s of pure char-scanning per cold parse.
    // With incremental depth/tail state this joins in milliseconds; the
    // generous bound below still fails hard under O(n²) behaviour.
    const N = 4000;
    const fields: string[] = [];
    for (let i = 0; i < N; i++) {
      fields.push(`//   field${i} :: Prop SomeTag${i} String p,`);
    }
    const source = [
      '// Tables :: {',
      ...fields,
      '//   last :: Number }',
      'const tables = {};',
    ].join('\n');
    const t0 = Date.now();
    const anns = extractAnnotations(source);
    const elapsed = Date.now() - t0;
    const ann = anns.find(a => a.name === 'Tables');
    expect(ann).toBeDefined();
    expect(ann!.raw).toContain('field0 :: Prop SomeTag0 String p');
    expect(ann!.raw).toContain(`field${N - 1} :: Prop SomeTag${N - 1} String p`);
    expect(ann!.raw).toContain('last :: Number }');
    expect(elapsed).toBeLessThan(2000);
  });

  test('multi-line // comment continuation', () => {
    const source = `// Person :: { name :: String,
//   age :: Number,
//   friends :: [Person] }
const person = { name: "Alice", age: 30, friends: [] };`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('Person');
    expect(anns[0].scheme).not.toBeNull();
    // The raw should have all fields joined
    expect(anns[0].raw).toContain('name :: String');
    expect(anns[0].raw).toContain('age :: Number');
    expect(anns[0].raw).toContain('friends :: [Person]');
  });

  test('multi-line // without name', () => {
    const source = `// :: { name :: String,
//   age :: Number }
const person = { name: "Alice", age: 30 };`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('person');
    expect(anns[0].scheme).not.toBeNull();
    expect(anns[0].raw).toContain('name :: String');
    expect(anns[0].raw).toContain('age :: Number');
  });

  test('multi-line /* */ block comment', () => {
    const source = `/* Person :: { name :: String,
                  age :: Number,
                  friends :: [Person] } */
const person = { name: "Alice", age: 30, friends: [] };`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('Person');
    expect(anns[0].scheme).not.toBeNull();
    expect(anns[0].raw).toContain('name :: String');
    expect(anns[0].raw).toContain('age :: Number');
    expect(anns[0].raw).toContain('friends :: [Person]');
  });

  test('multi-line JSDoc-style block comment with * prefixes', () => {
    const source = `/** Person :: { name :: String,
  *   age :: Number,
  *   friends :: [Person] } */
const person = { name: "Alice", age: 30, friends: [] };`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('Person');
    expect(anns[0].scheme).not.toBeNull();
    expect(anns[0].raw).toContain('name :: String');
    expect(anns[0].raw).toContain('age :: Number');
    expect(anns[0].raw).toContain('friends :: [Person]');
  });

  test('multi-line // constraint arrow continuation (=>)', () => {
    const source = `// Maybe#traverse :: Applicative f
//                => Maybe a ~> TypeRep f -> (a -> f b) -> f (Maybe b)
const traverse = 1;`;
    const anns = extractAnnotations(source);
    const ann = anns.find(a => a.name === 'Maybe#traverse');
    expect(ann).toBeDefined();
    expect(ann!.raw).toContain('Applicative f');
    expect(ann!.raw).toContain('=> Maybe a ~> TypeRep f');
    expect(ann!.raw).toContain('f (Maybe b)');
  });

  test('multi-line // with trailing constraint arrow (=> at end of first line)', () => {
    const source = `// Maybe#traverse :: Applicative f =>
//                   Maybe a ~> TypeRep f -> (a -> f b) -> f (Maybe b)
const traverse = 1;`;
    const anns = extractAnnotations(source);
    const ann = anns.find(a => a.name === 'Maybe#traverse');
    expect(ann).toBeDefined();
    expect(ann!.raw).toContain('Applicative f =>');
    expect(ann!.raw).toContain('Maybe a ~> TypeRep f');
    expect(ann!.raw).toContain('f (Maybe b)');
  });

  test('continuation stops at new annotation', () => {
    const source = `// :: { name :: String,
//   age :: Number }
// :: Number -> Number
const f = (x) => x + 1;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(2);
    expect(anns[0].raw).toContain('name :: String');
    expect(anns[0].raw).toContain('age :: Number');
    expect(anns[1].raw).toBe('Number -> Number');
    expect(anns[1].name).toBe('f');
  });

  test('continuation stops at ::types directive', () => {
    const source = `// :: { name :: String }
// ::types ./demo
const x = 42;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].raw).toBe('{ name :: String }');
  });

  test('continuation stops at ::constraint directive', () => {
    const source = `// :: { name :: String }
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
const x = 42;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].raw).toBe('{ name :: String }');
  });

  test('single-line annotation still works unchanged', () => {
    const source = `// :: Number -> Number
const double = (x) => x * 2;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].raw).toBe('Number -> Number');
    expect(anns[0].name).toBe('double');
  });
});

describe('extractAnnotations — gap too large', () => {
  test('annotation far from declaration is not attached', () => {
    // Each line is "// padding\n" = 11 chars, need > 200 chars gap
    const lines = ['// :: Number -> Number'];
    for (let i = 0; i < 25; i++) lines.push('// padding line ' + i);
    lines.push('const foo = 42;');
    const source = lines.join('\n');
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    // The annotation should not be attached due to gap
    expect(anns[0].name).toBeUndefined();
  });
});

describe('extractAnnotations — non-TypeParseError', () => {
  // This tests the catch branch for non-TypeParseError exceptions
  // Hard to trigger without mocking, but we can test error messages
  test('malformed annotation returns error string', () => {
    const source = `// :: !!!
const foo = 42;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].error).toBeDefined();
  });
});

describe('extractTypeDirectives — parse failure fallback', () => {
  test('fallback regex for unparseable source', () => {
    // Source with a ::types directive but with syntax that breaks acorn
    const source = `// ::types ./myModule
const x = {;`; // invalid syntax
    const directives = extractTypeDirectives(source);
    expect(directives).toContain('./myModule');
  });
});

describe('extractConstraintDirectives — parse failure fallback', () => {
  test('fallback regex for unparseable source', () => {
    const source = `// ::constraint Functor f { f :: { map :: (a -> b) -> f a -> f b } }
const x = {;`; // invalid syntax
    const directives = extractConstraintDirectives(source);
    expect(directives.length).toBeGreaterThan(0);
    expect(directives[0].text).toContain('Functor');
  });
});

// ---------------------------------------------------------------------------
// ::ignore-file directive
// ---------------------------------------------------------------------------

describe('hasIgnoreFileDirective', () => {
  test('returns true when // ::ignore-file is present', () => {
    const source = `// ::ignore-file
// :: Number -> Number
const double = (x) => x * 2;`;
    expect(hasIgnoreFileDirective(source)).toBe(true);
  });

  test('returns true when /* ::ignore-file */ is present', () => {
    const source = `/* ::ignore-file */
const x = 1;`;
    expect(hasIgnoreFileDirective(source)).toBe(true);
  });

  test('returns false when no directive is present', () => {
    const source = `// :: Number -> Number
const double = (x) => x * 2;`;
    expect(hasIgnoreFileDirective(source)).toBe(false);
  });

  test('returns true anywhere in the file', () => {
    const source = `// :: Number -> Number
const double = (x) => x * 2;
// ::ignore-file`;
    expect(hasIgnoreFileDirective(source)).toBe(true);
  });

  test('fallback regex for unparseable source', () => {
    const source = `// ::ignore-file
const x = {;`;
    expect(hasIgnoreFileDirective(source)).toBe(true);
  });

  test('does not match partial directive names', () => {
    const source = `// ::ignore-file-extra
const x = 1;`;
    expect(hasIgnoreFileDirective(source)).toBe(false);
  });

  test('recognizes ::ignore-file alias', () => {
    const source = `// ::ignore-file
const x = 1;`;
    expect(hasIgnoreFileDirective(source)).toBe(true);
  });

  test('recognizes /* ::ignore-file */ alias', () => {
    const source = `/* ::ignore-file */
const x = 1;`;
    expect(hasIgnoreFileDirective(source)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ::ignore directive
// ---------------------------------------------------------------------------

describe('extractIgnoreLineDirectives', () => {
  test('returns the next line (0-based) after // ::ignore', () => {
    const source = `const a = 1;
// ::ignore
const b = 2;
const c = 3;`;
    const ignored = extractIgnoreLineDirectives(source);
    expect(ignored.has(2)).toBe(true);   // line 2 (0-based) = "const b = 2;"
    expect(ignored.has(0)).toBe(false);
    expect(ignored.has(3)).toBe(false);
  });

  test('handles multiple ::ignore directives', () => {
    const source = `// ::ignore
const a = 1;
const b = 2;
// ::ignore
const c = 3;`;
    const ignored = extractIgnoreLineDirectives(source);
    expect(ignored.has(1)).toBe(true);  // "const a = 1;"
    expect(ignored.has(4)).toBe(true);  // "const c = 3;"
    expect(ignored.has(2)).toBe(false);
  });

  test('returns empty set when no directives present', () => {
    const source = `const a = 1;
const b = 2;`;
    const ignored = extractIgnoreLineDirectives(source);
    expect(ignored.size).toBe(0);
  });

  test('fallback regex for unparseable source', () => {
    const source = `// ::ignore
const x = {;`;
    const ignored = extractIgnoreLineDirectives(source);
    expect(ignored.has(1)).toBe(true);
  });

  test('does not match partial directive names', () => {
    const source = `// ::ignore-extra
const x = 1;`;
    const ignored = extractIgnoreLineDirectives(source);
    expect(ignored.size).toBe(0);
  });

  test('recognizes ::ignore alias for ::ignore', () => {
    const source = `const a = 1;
// ::ignore
const b = 2;
const c = 3;`;
    const ignored = extractIgnoreLineDirectives(source);
    expect(ignored.has(2)).toBe(true);   // "const b = 2;"
    expect(ignored.has(0)).toBe(false);
    expect(ignored.has(3)).toBe(false);
  });

  test('recognizes /* ::ignore */ alias', () => {
    const source = `/* ::ignore */
const x = 1;`;
    const ignored = extractIgnoreLineDirectives(source);
    expect(ignored.has(1)).toBe(true);
  });

  test('::ignore fallback regex for unparseable source', () => {
    const source = `// ::ignore
const x = {;`;
    const ignored = extractIgnoreLineDirectives(source);
    expect(ignored.has(1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ::ignore-function directive
// ---------------------------------------------------------------------------

describe('extractIgnoreFunctionDirectives', () => {
  test('ignores all lines of a function declaration', () => {
    const source = `// ::ignore-function
function foo() {
  const x = 1;
  return x;
}
const y = 2;`;
    const ignored = extractIgnoreFunctionDirectives(source);
    // Lines 1-4 (0-based) = the function declaration
    expect(ignored.has(1)).toBe(true);  // function foo() {
    expect(ignored.has(2)).toBe(true);  //   const x = 1;
    expect(ignored.has(3)).toBe(true);  //   return x;
    expect(ignored.has(4)).toBe(true);  // }
    expect(ignored.has(5)).toBe(false); // const y = 2;
    expect(ignored.has(0)).toBe(false); // the directive itself
  });

  test('ignores all lines of an arrow function const', () => {
    const source = `// ::ignore-function
const foo = x => {
  return x + 1;
}
const y = 2;`;
    const ignored = extractIgnoreFunctionDirectives(source);
    expect(ignored.has(1)).toBe(true);
    expect(ignored.has(2)).toBe(true);
    expect(ignored.has(3)).toBe(true);
    expect(ignored.has(4)).toBe(false);
  });

  test('works with annotation between directive and function', () => {
    const source = `// ::ignore-function
// foo :: Number -> Number
const foo = x => {
  return x + 1;
}
const y = 2;`;
    const ignored = extractIgnoreFunctionDirectives(source);
    expect(ignored.has(2)).toBe(true);  // const foo = ...
    expect(ignored.has(3)).toBe(true);  // return x + 1
    expect(ignored.has(4)).toBe(true);  // }
    expect(ignored.has(5)).toBe(false); // const y = 2;
  });

  test('returns empty set when no directives present', () => {
    const source = `const a = 1;
const b = 2;`;
    const ignored = extractIgnoreFunctionDirectives(source);
    expect(ignored.size).toBe(0);
  });

  test('does not match partial directive names', () => {
    const source = `// ::ignore-function-extra
const foo = x => x;`;
    const ignored = extractIgnoreFunctionDirectives(source);
    expect(ignored.size).toBe(0);
  });

  test('fallback regex for unparseable source', () => {
    const source = `// ::ignore-function
const x = {;`;
    const ignored = extractIgnoreFunctionDirectives(source);
    expect(ignored.has(1)).toBe(true);
  });

  test('recognizes ::ignore-function alias', () => {
    const source = `// ::ignore-function
function foo() {
  const x = 1;
  return x;
}
const y = 2;`;
    const ignored = extractIgnoreFunctionDirectives(source);
    expect(ignored.has(1)).toBe(true);
    expect(ignored.has(2)).toBe(true);
    expect(ignored.has(3)).toBe(true);
    expect(ignored.has(4)).toBe(true);
    expect(ignored.has(5)).toBe(false);
  });

  test('ignores a bare FunctionExpression', () => {
    const source = `// ::ignore-function
foo(function(x) {
  return x + 1;
});`;
    const ignored = extractIgnoreFunctionDirectives(source);
    expect(ignored.has(1)).toBe(true);  // foo(function(x) {
    expect(ignored.has(2)).toBe(true);  //   return x + 1;
    expect(ignored.has(3)).toBe(true);  // });
  });
});

// ---------------------------------------------------------------------------
// ::narrow + method annotation (line 200 in annotations.ts)
// ---------------------------------------------------------------------------

describe('extractAnnotations — ::narrow with method annotation', () => {
  test('::narrow on non-Boolean method type (~>) produces an error', () => {
    // ::narrow is only valid on Boolean-returning methods.
    const source = `// ::narrow String
// :: Array a ~> (a -> Boolean) -> Array a
const filterArr = x => x;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].error).toBe('::narrow can only be used with regular function annotations or Boolean-returning methods');
    // The method type is still parsed; receiver and methodType should be set.
    expect(anns[0].receiver).toBeDefined();
    expect(anns[0].methodType).toBeDefined();
  });

  test('::narrow on Boolean-returning method type (~> () -> Boolean) produces narrowVariant', () => {
    const source = `// ::narrow Left
// Either#isLeft :: Either e a ~> () -> Boolean
const isLeft = x => x;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].error).toBeUndefined();
    expect(anns[0].narrowVariant).toBe('Left');
    expect(anns[0].receiver).toBeDefined();
    expect(anns[0].methodType).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ::narrow where the return is Boolean and the narrowed param is a concrete
// (non-TVar) type.  Multi-param / non-TVar predicates are supported: the LAST
// curried parameter is narrowed to `narrowedType` and may be any type.
// ---------------------------------------------------------------------------

describe('extractAnnotations — ::narrow on a concrete-typed parameter', () => {
  test('::narrow on Number -> Boolean narrows the parameter to the directive type', () => {
    // returnType IS Boolean; type.param is TCon(Number).  This is now allowed
    // and records a typePredicate narrowing the (only) parameter to String.
    const source = `// ::narrow String
// :: Number -> Boolean
const isPositive = x => x > 0;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].error).toBeUndefined();
    expect(anns[0].scheme).not.toBeNull();
    expect(anns[0].scheme!.typePredicate).toBeDefined();
    expect(anns[0].scheme!.typePredicate!.paramIndex).toBe(0);
    expect(anns[0].scheme!.typePredicate!.narrowedType).toEqual({ tag: 'TCon', name: 'String', args: [] });
  });
});

// ---------------------------------------------------------------------------
// findNextFunctionExpressionNode — non-whitespace gap (line 687)
// ---------------------------------------------------------------------------

describe('extractAnnotations — inline function with non-whitespace gap', () => {
  test('annotation inside call with non-whitespace between comment and arrow fn', () => {
    // 'bar, ' is non-whitespace between the comment end and the arrow fn start.
    // findNextFunctionExpressionNode should return null → annotation has no nodeStart.
    const source = `foo(
  someValue,
  // :: Number -> Number
  bar, x => x + 1
);`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].nodeStart).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findNextFunctionExpressionNode — fn expression too far away (line 692)
// ---------------------------------------------------------------------------

describe('extractAnnotations — inline function too far away', () => {
  test('annotation inside call where arrow fn is >200 chars away', () => {
    // The gap is pure whitespace but > 200 characters long.
    const padding = '\n'.repeat(202);
    const source = `foo(\n  // :: Number -> Number\n${padding}  x => x + 1\n);`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].nodeStart).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractDeclName — VariableDeclaration with destructuring (line 712)
// ---------------------------------------------------------------------------

describe('extractAnnotations — VariableDeclaration with destructuring', () => {
  test('annotation before destructuring const attaches to the first binding', () => {
    // Destructuring is now supported: ObjectPattern walks its bindings and
    // returns the first one (`x`) when no annotation name is present.
    const source = `// :: Number
const { x } = obj;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('x');
    // Nameless annotation on a named declaration → namelessOnNamed flag set.
    expect(anns[0].namelessOnNamed).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// extractDeclName — ExportNamedDeclaration without inner declaration (line 718)
// ---------------------------------------------------------------------------

describe('extractAnnotations — ExportNamedDeclaration re-export', () => {
  test('annotation before export { foo } has no attached name', () => {
    // `export { foo }` has no .declaration → extractDeclName returns null.
    const source = `const foo = x => x;
// :: Number -> Number
export { foo };`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractDeclName — ExportDefaultDeclaration with anonymous export (line 724)
// ---------------------------------------------------------------------------

describe('extractAnnotations — ExportDefaultDeclaration anonymous', () => {
  test('annotation before export default literal has no attached name', () => {
    // `export default 42` — declaration is a Literal with no .id.name.
    const source = `// :: Number
export default 42;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBeUndefined();
  });

  test('annotation before export default arrow function has no attached name', () => {
    // `export default x => x` — declaration is ArrowFunctionExpression with no id.
    const source = `// :: Number -> Number
export default x => x;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractDeclName — default switch case (line 755)
// ---------------------------------------------------------------------------

describe('extractAnnotations — unsupported declaration type', () => {
  test('annotation before if statement is not attached', () => {
    // IfStatement hits the `default: return null` branch of extractDeclName.
    const source = `let result;
// :: Number
if (true) { result = 1; }`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multi-line continuation: branch misses in the continuation loop
// These all require an INCOMPLETE first line (unbalanced `{`) so the loop runs
// ---------------------------------------------------------------------------

describe('extractAnnotations — multi-line continuation branch coverage', () => {
  test('continuation stops when next comment is a block comment', () => {
    // Line 166: `if (next.type !== 'Line') break` — true branch
    const source = `// :: { name :: String,
/* not a continuation */
const x = {};`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    // The block comment is not consumed as continuation — raw stays incomplete
    expect(anns[0].raw).toBe('{ name :: String,');
  });

  test('continuation stops when there is non-whitespace between lines', () => {
    // Line 170: `if (!/^\s*$/.test(gap)) break` — true branch
    // Code between the two comments creates a non-whitespace gap.
    const source = `// :: { name :: String,
const intermediate = 1;
//   age :: Number }
const x = {};`;
    const anns = extractAnnotations(source);
    // Two annotations: the incomplete one and the second line treated separately
    const incomplete = anns.find(a => a.raw.includes('name :: String'));
    expect(incomplete).toBeDefined();
    expect(incomplete!.raw).toBe('{ name :: String,');
  });

  test('continuation stops at new annotation even when first is incomplete', () => {
    // Line 174: `if (HM_PATTERN.test(nextText)) break` — true branch
    // with an INCOMPLETE first line so the loop body is actually entered
    const source = `// :: { name :: String,
// :: Number -> Number
const f = (x) => x + 1;`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(2);
    expect(anns[0].raw).toBe('{ name :: String,');
    expect(anns[1].raw).toBe('Number -> Number');
  });

  test('continuation stops at ::types when first line is incomplete', () => {
    // Line 175: TYPES_DIRECTIVE_PATTERN — true branch with incomplete first line
    const source = `// :: { name :: String,
// ::types ./myModule
const x = {};`;
    const anns = extractAnnotations(source);
    const incomplete = anns.find(a => a.raw.includes('name :: String'));
    expect(incomplete).toBeDefined();
    expect(incomplete!.raw).toBe('{ name :: String,');
  });

  test('continuation stops at ::constraint when first line is incomplete', () => {
    // Line 176: CONSTRAINT_DIRECTIVE_PATTERN — true branch with incomplete first line
    const source = `// :: { name :: String,
// ::constraint Eq a { a :: { eq :: a -> a -> Boolean } }
const x = {};`;
    const anns = extractAnnotations(source);
    const incomplete = anns.find(a => a.raw.includes('name :: String'));
    expect(incomplete).toBeDefined();
    expect(incomplete!.raw).toBe('{ name :: String,');
  });

  test('continuation stops at empty comment when first line is incomplete', () => {
    // Line 180: `if (continuationText.length === 0) break` — true branch
    const source = `// :: { name :: String,
//
//   age :: Number }
const x = {};`;
    const anns = extractAnnotations(source);
    const incomplete = anns.find(a => a.raw.includes('name :: String'));
    expect(incomplete).toBeDefined();
    expect(incomplete!.raw).toBe('{ name :: String,');
  });
});

// ---------------------------------------------------------------------------
// hasIgnoreFileDirective: block comment ::ignore-file in invalid source (line 409)
// ---------------------------------------------------------------------------

describe('hasIgnoreFileDirective — block comment fallback', () => {
  test('block /* ::ignore-file */ in unparseable source returns true', () => {
    // First regex (// ::ignore-file) does not match; second regex (/* ::ignore-file */) does.
    const source = `/* ::ignore-file */
const x = {;`; // invalid JS
    expect(hasIgnoreFileDirective(source)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Annotation inside a class body (lines 603-617)
// ---------------------------------------------------------------------------

describe('extractAnnotations — annotation inside class body', () => {
  test('annotation inside class body — exported class (ExportNamedDeclaration wrapping class)', () => {
    // Lines 603-605: the ExportNamed branch of the class condition
    const source = `export class Box {
  // :: (a -> b) -> Box a -> Box b
  map(f) { return new Box(f(this.value)); }
}`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('Box#map');
  });

  test('annotation inside class body — export default class (ExportDefaultDeclaration wrapping class)', () => {
    // Lines 603-605: the ExportDefault branch of the class condition
    const source = `export default class Box {
  // :: Number -> Box
  getValue() { return this.value; }
}`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('Box#getValue');
  });

  test('annotation before a class method is attached with ClassName#method name', () => {
    // Lines 603-605: class body branch entered
    const source = `class Box {
  // :: (a -> b) -> Box a -> Box b
  map(f) { return new Box(f(this.value)); }
}`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBe('Box#map');
    expect(anns[0].raw).toBe('(a -> b) -> Box a -> Box b');
  });

  test('annotation inside class before constructor is not attached', () => {
    // Line 617: `if (methodName !== "constructor")` — false branch
    const source = `class Box {
  // :: Number -> Box
  constructor(x) { this.x = x; }
}`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    // constructor is skipped — no name attached from class body traversal
    expect(anns[0].name).toBeUndefined();
  });

  test('annotation inside class, method too far away, is not attached', () => {
    // Line 611: `if (gap > 200) break` — true branch
    const padding = '\n'.repeat(202);
    const source = `class Box {
  // :: Number -> Number${padding}  map(f) { return f(this.value); }
}`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Annotation above this.<prop> = <expr> inside constructor body
// ---------------------------------------------------------------------------

describe('extractAnnotations — this.<prop> assignment in constructor', () => {
  test('annotation above this.fork = fork attaches with property name', () => {
    const source = `
// RTask :: ((e -> (), a -> (), r) -> ()) -> RTask r e a
function RTask(fork) {
  if (!(this instanceof RTask)) return new RTask(fork);
  // RTask#fork :: RTask r e a ~> (e -> (), a -> (), r) -> ()
  this.fork = fork;
}
`;
    const anns = extractAnnotations(source);
    const forkAnn = anns.find(a => a.name === 'RTask#fork');
    expect(forkAnn).toBeDefined();
    expect(forkAnn!.methodNameMismatch).toBeUndefined();
    expect(forkAnn!.receiver).toBeDefined();
    expect(forkAnn!.methodType).toBeDefined();
  });

  test('annotation above this.value = value attaches with property name', () => {
    const source = `
// Box :: a -> Box a
function Box(value) {
  if (!(this instanceof Box)) return new Box(value);
  // Box#value :: Box a ~> a
  this.value = value;
}
`;
    const anns = extractAnnotations(source);
    const valueAnn = anns.find(a => a.name === 'Box#value');
    expect(valueAnn).toBeDefined();
    expect(valueAnn!.methodNameMismatch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multiple inline fn expressions — second not updating bestStart (line 670)
// ---------------------------------------------------------------------------

describe('extractAnnotations — multiple inline fn expressions', () => {
  test('annotation before two arrow fns in a call: first one is attached', () => {
    // Line 670: `if (bestStart === null || node.start < bestStart)` — false branch
    // First `x => x` sets bestStart; `y => y` comes later, so the inner `if` is
    // false (no update). The annotation is still attached to the first fn.
    const source = `foo(
  // :: Number -> Number
  x => x, y => y
);`;
    const anns = extractAnnotations(source);
    expect(anns).toHaveLength(1);
    expect(anns[0].nodeStart).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// extractImportedNames
// ---------------------------------------------------------------------------

describe('extractImportedNames', () => {
  test('extracts default import with uppercase name', () => {
    const source = `import Maybe from './maybe';`;
    expect(extractImportedNames(source)).toContain('Maybe');
  });

  test('ignores default import with lowercase name', () => {
    const source = `import util from './util';`;
    expect(extractImportedNames(source)).not.toContain('util');
  });

  test('extracts named import with uppercase name', () => {
    const source = `import { Just, nothing } from './maybe';`;
    const names = extractImportedNames(source);
    expect(names).toContain('Just');
    expect(names).not.toContain('nothing');
  });

  test('extracts alias target if it is uppercase', () => {
    const source = `import { foo as Foo } from './mod';`;
    expect(extractImportedNames(source)).toContain('Foo');
  });

  test('extracts uppercase names from require destructuring', () => {
    const source = `const { Either, left } = require('./either');`;
    const names = extractImportedNames(source);
    expect(names).toContain('Either');
    expect(names).not.toContain('left');
  });

  test('handles multiple import statements', () => {
    const source = [
      `import Maybe from './maybe';`,
      `import { Just, Nothing } from './maybe';`,
    ].join('\n');
    const names = extractImportedNames(source);
    expect(names).toContain('Maybe');
    expect(names).toContain('Just');
    expect(names).toContain('Nothing');
  });

  test('returns empty array when no imports', () => {
    expect(extractImportedNames('const x = 1;')).toEqual([]);
  });
});

// ============================================================================
// Sum type declaration parsing
// ============================================================================

describe('extractDataDirectives', () => {
  test('extracts shorthand from line comments', () => {
    const source = `// Maybe :: Just a | Nothing\nconst x = 1;`;
    const directives = extractDataDirectives(source);
    expect(directives).toHaveLength(1);
    expect(directives[0].name).toBe('Maybe');
  });

  test('extracts multiple shorthand directives', () => {
    const source = `// Maybe :: Just a | Nothing\n// Either :: Left e | Right a\nconst x = 1;`;
    const directives = extractDataDirectives(source);
    expect(directives).toHaveLength(2);
    expect(directives[0].name).toBe('Maybe');
    expect(directives[1].name).toBe('Either');
  });

  test('returns empty when no sum type declarations', () => {
    const source = `// :: Number -> Number\nconst f = x => x;`;
    expect(extractDataDirectives(source)).toHaveLength(0);
  });
});

describe('shorthand data type syntax', () => {
  describe('isDataShorthand', () => {
    test('recognises simple shorthand', () => {
      expect(isDataShorthand('Either', 'Left e | Right a')).toBe(true);
    });

    test('recognises nullary variant', () => {
      expect(isDataShorthand('Maybe', 'Just a | Nothing')).toBe(true);
    });

    test('rejects lowercase annotation name', () => {
      expect(isDataShorthand('either', 'Left e | Right a')).toBe(false);
    });

    test('rejects method annotations', () => {
      expect(isDataShorthand('Either#map', 'Left e | Right a')).toBe(false);
      expect(isDataShorthand('Either.of', 'Left e | Right a')).toBe(false);
    });

    test('rejects single variant (no pipe)', () => {
      expect(isDataShorthand('Maybe', 'Just a')).toBe(false);
    });

    test('a union of built-in types is an alias, not a sum type', () => {
      // Built-in names can never be new variants: `Cell :: String | Number`
      // names a union of existing types.
      expect(isDataShorthand('Foo', 'Number | String')).toBe(false);
      expect(isDataShorthand('Node', 'ReactElement | String | Null')).toBe(false);
      expect(isDataShorthand('Outcome', 'Won | Lost | Pending')).toBe(true);
    });

    test('recognises shorthand with concrete type fields', () => {
      expect(isDataShorthand('Result', 'Ok Number | Err String')).toBe(true);
    });

    test('recognises shorthand with mixed concrete and var fields', () => {
      expect(isDataShorthand('Container', 'Wrap a Number | Empty')).toBe(true);
    });
  });

  describe('parseDataShorthand', () => {
    test('parses Either2 shorthand', () => {
      const decl = parseDataShorthand('Either2', 'Left e | Right a', 0, 40);
      expect(decl).not.toBeNull();
      expect(decl!.name).toBe('Either2');
      expect(decl!.typeVars).toEqual(['e', 'a']);
      expect(decl!.variants).toEqual([
        { name: 'Left', fields: ['e'] },
        { name: 'Right', fields: ['a'] },
      ]);
    });

    test('parses Maybe shorthand', () => {
      const decl = parseDataShorthand('Maybe', 'Just a | Nothing', 0, 30);
      expect(decl).not.toBeNull();
      expect(decl!.name).toBe('Maybe');
      expect(decl!.typeVars).toEqual(['a']);
      expect(decl!.variants).toEqual([
        { name: 'Just', fields: ['a'] },
        { name: 'Nothing', fields: [] },
      ]);
    });

    test('deduplicates shared type vars', () => {
      const decl = parseDataShorthand('Pair', 'MkPair a a | Empty', 0, 40);
      expect(decl).not.toBeNull();
      expect(decl!.typeVars).toEqual(['a']);
    });

    test('preserves order of first appearance', () => {
      const decl = parseDataShorthand('T', 'A b a | B a', 0, 20);
      expect(decl!.typeVars).toEqual(['b', 'a']);
    });

    test('supports concrete types in variant fields', () => {
      const decl = parseDataShorthand('Result', 'Ok Int | Err String', 0, 40);
      expect(decl).not.toBeNull();
      expect(decl!.name).toBe('Result');
      expect(decl!.typeVars).toEqual([]);  // no type variables
      expect(decl!.variants).toEqual([
        { name: 'Ok', fields: ['Int'] },
        { name: 'Err', fields: ['String'] },
      ]);
    });

    test('supports mixed concrete types and type variables', () => {
      const decl = parseDataShorthand('Container', 'Wrap a Int | Empty', 0, 40);
      expect(decl).not.toBeNull();
      expect(decl!.typeVars).toEqual(['a']);  // only lowercase vars
      expect(decl!.variants).toEqual([
        { name: 'Wrap', fields: ['a', 'Int'] },
        { name: 'Empty', fields: [] },
      ]);
    });
  });

  describe('extractDataDirectives with shorthand', () => {
    test('extracts shorthand from line comments', () => {
      const source = `// Either2 :: Left e | Right a\nconst x = 1;`;
      const directives = extractDataDirectives(source);
      expect(directives).toHaveLength(1);
      expect(directives[0].name).toBe('Either2');
      expect(directives[0].typeVars).toEqual(['e', 'a']);
      expect(directives[0].variants).toHaveLength(2);
    });

    test('extracts multiple shorthand declarations', () => {
      const source = [
        '// Maybe :: Just a | Nothing',
        '// Either :: Left e | Right a',
        'const x = 1;',
      ].join('\n');
      const directives = extractDataDirectives(source);
      expect(directives).toHaveLength(2);
      expect(directives[0].name).toBe('Maybe');
      expect(directives[1].name).toBe('Either');
    });

    test('shorthand is not treated as a type annotation', () => {
      const source = `// Either2 :: Left e | Right a\nconst x = 1;`;
      const annotations = extractAnnotations(source);
      const dataAnn = annotations.find(a => a.name === 'Either2');
      expect(dataAnn).toBeUndefined();
    });
  });

  describe('complex variant fields (parens + records)', () => {
    test('isDataShorthand accepts parenthesized type applications', () => {
      expect(isDataShorthand(
        'Response',
        'Redirect Number String | Render String (Object String a) | Send Number (Object String a) Body',
      )).toBe(true);
    });

    test('isDataShorthand accepts record variants', () => {
      expect(isDataShorthand(
        'Response',
        'Redirect { status :: Number, url :: String } | Render { view :: String, options :: Object String a }',
      )).toBe(true);
    });

    test('isDataShorthand rejects a leading non-variant group', () => {
      expect(isDataShorthand('Bad', '(a -> b) | Nothing')).toBe(false);
    });

    test('isDataShorthand rejects unbalanced delimiters', () => {
      expect(isDataShorthand('Bad', 'Foo (Object String a | Bar')).toBe(false);
    });

    test('parseDataShorthand keeps a parenthesized field as one field', () => {
      const decl = parseDataShorthand(
        'Response',
        'Redirect Number String | Render String (Object String a) | Send Number (Object String a) Body',
        0, 120,
      );
      expect(decl).not.toBeNull();
      expect(decl!.typeVars).toEqual(['a']);
      expect(decl!.variants).toEqual([
        { name: 'Redirect', fields: ['Number', 'String'] },
        { name: 'Render', fields: ['String', '(Object String a)'] },
        { name: 'Send', fields: ['Number', '(Object String a)', 'Body'] },
      ]);
    });

    test('parseDataShorthand treats a record as one field and skips labels', () => {
      const decl = parseDataShorthand(
        'Response',
        'Redirect { status :: Number, url :: String } | Render { view :: String, options :: Object String a }',
        0, 120,
      );
      expect(decl).not.toBeNull();
      // Labels (status, url, view, options) are NOT type vars; only `a` is.
      expect(decl!.typeVars).toEqual(['a']);
      expect(decl!.variants[0]).toEqual({
        name: 'Redirect',
        fields: ['{ status :: Number, url :: String }'],
      });
      expect(decl!.variants[1]).toEqual({
        name: 'Render',
        fields: ['{ view :: String, options :: Object String a }'],
      });
    });

    test('extractDataDirectives: multi-line block with parenthesized fields', () => {
      const source = [
        '/* Response ::',
        '     Redirect Number String',
        '   | Render String (Object String a)',
        '   | Send Number (Object String a) Body */',
        'function Response() {}',
      ].join('\n');
      const directives = extractDataDirectives(source);
      expect(directives).toHaveLength(1);
      expect(directives[0].name).toBe('Response');
      expect(directives[0].typeVars).toEqual(['a']);
      expect(directives[0].variants.map(v => v.name)).toEqual([
        'Redirect', 'Render', 'Send',
      ]);
    });

    test('extractDataDirectives: multi-line block with record variants spanning lines', () => {
      const source = [
        '/* Response ::',
        '     Redirect { status :: Number, url :: String }',
        '   | Render { view :: String, options :: Object String a }',
        '   | Send { status :: Number, headers :: Object String a, body :: Body } */',
        'function Response() {}',
      ].join('\n');
      const directives = extractDataDirectives(source);
      expect(directives).toHaveLength(1);
      expect(directives[0].name).toBe('Response');
      expect(directives[0].typeVars).toEqual(['a']);
      expect(directives[0].variants.map(v => v.name)).toEqual([
        'Redirect', 'Render', 'Send',
      ]);
    });

    test('record/paren declaration is not treated as a plain annotation', () => {
      const source = [
        '/* Response ::',
        '     Redirect { status :: Number, url :: String }',
        '   | Render String (Object String a) */',
        'function Response() {}',
      ].join('\n');
      const annotations = extractAnnotations(source);
      expect(annotations.find(a => a.name === 'Response')).toBeUndefined();
    });
  });
});