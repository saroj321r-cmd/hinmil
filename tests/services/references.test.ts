import { collectReferences, findReferencesAtOffset, collectScopeBindings, ReferenceGroup } from '../../src/services/references';
import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

// ---------------------------------------------------------------------------
// collectReferences — basic scope resolution
// ---------------------------------------------------------------------------

describe('collectReferences', () => {
  test('single variable declaration and usage', () => {
    const source = `const x = 1;\nconst y = x + 2;`;
    const groups = collectReferences(source);
    // Find the group for 'x'
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(2);
    expect(xGroup!.locations[0].isDefinition).toBe(true);
    expect(xGroup!.locations[1].isDefinition).toBe(false);
  });

  test('multiple usages of the same variable', () => {
    const source = `const x = 1;\nconst a = x;\nconst b = x;\nconst c = x;`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(4); // 1 def + 3 usages
    expect(xGroup!.locations.filter(l => l.isDefinition)).toHaveLength(1);
  });

  test('shadowed variables get separate groups', () => {
    const source = `const x = 1;\nconst f = () => { const x = 2; return x; };\nconst y = x;`;
    const groups = collectReferences(source);
    // There should be two separate groups for 'x'
    const xGroups = findAllGroupsByName(groups, 'x');
    expect(xGroups).toHaveLength(2);
    // Outer x: definition + usage in `const y = x`
    const outerX = xGroups.find(g => g.locations.length === 2);
    expect(outerX).toBeDefined();
    // Inner x: definition + usage in `return x`
    const innerX = xGroups.find(g =>
      g.locations.length === 2 && g.locations !== outerX!.locations
    );
    expect(innerX).toBeDefined();
  });

  test('function parameters are declarations', () => {
    const source = `const add = (a, b) => a + b;`;
    const groups = collectReferences(source);
    const aGroup = findGroupByName(groups, 'a');
    expect(aGroup).not.toBeNull();
    expect(aGroup!.locations).toHaveLength(2); // param decl + usage
    expect(aGroup!.locations[0].isDefinition).toBe(true);
    const bGroup = findGroupByName(groups, 'b');
    expect(bGroup).not.toBeNull();
    expect(bGroup!.locations).toHaveLength(2);
  });

  test('function declaration is a definition', () => {
    const source = `function foo() { return 1; }\nconst x = foo();`;
    const groups = collectReferences(source);
    const fooGroup = findGroupByName(groups, 'foo');
    expect(fooGroup).not.toBeNull();
    expect(fooGroup!.locations).toHaveLength(2); // def + call
    expect(fooGroup!.locations[0].isDefinition).toBe(true);
  });

  test('import declaration is a definition', () => {
    const source = `import { map } from './utils';\nconst r = map(x => x + 1);`;
    const groups = collectReferences(source);
    const mapGroup = findGroupByName(groups, 'map');
    expect(mapGroup).not.toBeNull();
    expect(mapGroup!.locations[0].isDefinition).toBe(true);
  });

  test('for-loop variable scoped to loop', () => {
    const source = `for (let i = 0; i < 10; i++) { console.log(i); }`;
    const groups = collectReferences(source);
    const iGroup = findGroupByName(groups, 'i');
    expect(iGroup).not.toBeNull();
    // i is declared once, used 3 times (test, update, body)
    expect(iGroup!.locations.length).toBeGreaterThanOrEqual(3);
    expect(iGroup!.locations[0].isDefinition).toBe(true);
  });

  test('destructuring introduces separate bindings', () => {
    const source = `const { a, b } = obj;\nconst x = a + b;`;
    const groups = collectReferences(source);
    const aGroup = findGroupByName(groups, 'a');
    expect(aGroup).not.toBeNull();
    expect(aGroup!.locations).toHaveLength(2); // destructure decl + usage
    const bGroup = findGroupByName(groups, 'b');
    expect(bGroup).not.toBeNull();
    expect(bGroup!.locations).toHaveLength(2);
  });

  test('try-catch param is scoped', () => {
    const source = `try { throw 1; } catch(e) { console.log(e); }`;
    const groups = collectReferences(source);
    const eGroup = findGroupByName(groups, 'e');
    expect(eGroup).not.toBeNull();
    expect(eGroup!.locations[0].isDefinition).toBe(true);
  });

  test('class declaration is a definition', () => {
    const source = `class Foo { constructor() {} }\nconst x = new Foo();`;
    const groups = collectReferences(source);
    const fooGroup = findGroupByName(groups, 'Foo');
    expect(fooGroup).not.toBeNull();
    expect(fooGroup!.locations).toHaveLength(2);
    expect(fooGroup!.locations[0].isDefinition).toBe(true);
  });

  test('export named uses existing binding', () => {
    const source = `const x = 1;\nexport { x };`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(2); // decl + export usage
  });

  test('unused variable has only definition', () => {
    const source = `const x = 1;\nconst y = 2;`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(1);
    expect(xGroup!.locations[0].isDefinition).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findReferencesAtOffset
// ---------------------------------------------------------------------------

describe('findReferencesAtOffset', () => {
  test('finds group when cursor is on declaration', () => {
    const source = `const foo = 1;\nconst bar = foo;`;
    const offset = source.indexOf('foo');
    const group = findReferencesAtOffset(source, offset);
    expect(group).not.toBeNull();
    expect(group!.name).toBe('foo');
    expect(group!.locations).toHaveLength(2);
  });

  test('finds group when cursor is on usage', () => {
    const source = `const foo = 1;\nconst bar = foo;`;
    const offset = source.lastIndexOf('foo');
    const group = findReferencesAtOffset(source, offset);
    expect(group).not.toBeNull();
    expect(group!.name).toBe('foo');
    expect(group!.locations).toHaveLength(2);
  });

  test('returns null when cursor is on whitespace', () => {
    const source = `const foo = 1;`;
    const offset = source.indexOf(' ');
    const group = findReferencesAtOffset(source, offset);
    expect(group).toBeNull();
  });

  test('returns null for string literal offsets', () => {
    const source = `const x = "hello";`;
    const offset = source.indexOf('hello');
    const group = findReferencesAtOffset(source, offset);
    expect(group).toBeNull();
  });

  test('cursor at end of identifier still matches', () => {
    const source = `const abc = 1;\nconst y = abc;`;
    // offset at the 'c' of the second 'abc' (inclusive end)
    const offset = source.lastIndexOf('abc') + 3;
    const group = findReferencesAtOffset(source, offset);
    expect(group).not.toBeNull();
    expect(group!.name).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// Annotation name tracking
// ---------------------------------------------------------------------------

describe('annotation name in references', () => {
  test('annotation name offsets are tracked', () => {
    const source = `// add :: Number -> Number -> Number\nconst add = (a, b) => a + b;`;
    const result = engine.infer(source);
    const groups = collectReferences(source, result);
    const addGroup = findGroupByName(groups, 'add');
    expect(addGroup).not.toBeNull();
    expect(addGroup!.annotationNameStart).toBeDefined();
    expect(addGroup!.annotationNameEnd).toBeDefined();
    // The annotation name should be "add" in the comment
    const annText = source.slice(addGroup!.annotationNameStart!, addGroup!.annotationNameEnd!);
    expect(annText).toBe('add');
  });

  test('annotation name offsets for declarations without annotation are undefined', () => {
    const source = `const x = 1;`;
    const result = engine.infer(source);
    const groups = collectReferences(source, result);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.annotationNameStart).toBeUndefined();
  });

  test('rename includes annotation name edit', () => {
    const source = `// double :: Number -> Number\nconst double = x => x * 2;\nconst r = double(5);`;
    const result = engine.infer(source);
    // Use indexOf('const double') + 6 to land on the JS identifier, not the comment
    const declOffset = source.indexOf('const double') + 6;
    const group = findReferencesAtOffset(source, declOffset, result);
    expect(group).not.toBeNull();
    expect(group!.annotationNameStart).toBeDefined();
    // Check that annotation is tracked
    const annText = source.slice(group!.annotationNameStart!, group!.annotationNameEnd!);
    expect(annText).toBe('double');
    // Total locations: declaration + usage (annotation name is tracked separately)
    expect(group!.locations).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Complex scoping patterns
// ---------------------------------------------------------------------------

describe('complex scoping', () => {
  test('nested functions with parameter reuse', () => {
    const source = `const f = x => {\n  const g = x => x + 1;\n  return x;\n};`;
    const groups = collectReferences(source);
    const xGroups = findAllGroupsByName(groups, 'x');
    expect(xGroups).toHaveLength(2);
    // Outer x: param + return
    // Inner x: param + x+1
    for (const g of xGroups) {
      expect(g.locations).toHaveLength(2);
    }
  });

  test('if-else branches reference outer variable', () => {
    const source = `const x = 1;\nif (true) { const y = x; } else { const z = x; }`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(3); // decl + 2 usages
  });

  test('ternary expression references', () => {
    const source = `const x = 1;\nconst y = x > 0 ? x : -x;`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    // x: decl + test + consequent + alternate
    expect(xGroup!.locations).toHaveLength(4);
  });

  test('array destructuring', () => {
    const source = `const [a, b, ...rest] = [1, 2, 3];\nconst sum = a + b;`;
    const groups = collectReferences(source);
    const aGroup = findGroupByName(groups, 'a');
    expect(aGroup).not.toBeNull();
    expect(aGroup!.locations).toHaveLength(2);
    const restGroup = findGroupByName(groups, 'rest');
    expect(restGroup).not.toBeNull();
    expect(restGroup!.locations).toHaveLength(1); // definition only
  });

  test('assignment expression is a usage, not a declaration', () => {
    const source = `let x = 1;\nx = 2;\nconst y = x;`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    // x: decl (let x) + assign (x = 2) + usage (y = x)
    expect(xGroup!.locations).toHaveLength(3);
  });

  test('template literal references', () => {
    const source = 'const name = "world";\nconst greeting = `hello ${name}!`;';
    const groups = collectReferences(source);
    const nameGroup = findGroupByName(groups, 'name');
    expect(nameGroup).not.toBeNull();
    expect(nameGroup!.locations).toHaveLength(2);
  });

  test('switch statement references', () => {
    const source = `const x = 1;\nswitch (x) {\n  case 1: break;\n}`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(2);
  });

  test('for-of loop variable', () => {
    const source = `const arr = [1, 2, 3];\nfor (const item of arr) {\n  console.log(item);\n}`;
    const groups = collectReferences(source);
    const arrGroup = findGroupByName(groups, 'arr');
    expect(arrGroup).not.toBeNull();
    expect(arrGroup!.locations).toHaveLength(2);
    const itemGroup = findGroupByName(groups, 'item');
    expect(itemGroup).not.toBeNull();
    expect(itemGroup!.locations).toHaveLength(2);
  });

  test('member expression does not create reference for property', () => {
    const source = `const obj = {};\nconst x = obj.foo;`;
    const groups = collectReferences(source);
    // 'foo' should NOT be in any group (it's a property, not a variable)
    const fooGroup = findGroupByName(groups, 'foo');
    expect(fooGroup).toBeNull();
    // 'obj' should have 2 references
    const objGroup = findGroupByName(groups, 'obj');
    expect(objGroup).not.toBeNull();
    expect(objGroup!.locations).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('empty source returns empty map', () => {
    const groups = collectReferences('');
    expect(groups.size).toBe(0);
  });

  test('syntax error returns empty map', () => {
    const groups = collectReferences('const = ;; {{');
    expect(groups.size).toBe(0);
  });

  test('object shorthand property creates a usage', () => {
    const source = `const x = 1;\nconst obj = { x };`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    // shorthand { x } is equivalent to { x: x }, so x is used
    expect(xGroup!.locations).toHaveLength(2);
  });

  test('spread element creates a usage', () => {
    const source = `const arr = [1, 2];\nconst arr2 = [...arr, 3];`;
    const groups = collectReferences(source);
    const arrGroup = findGroupByName(groups, 'arr');
    expect(arrGroup).not.toBeNull();
    expect(arrGroup!.locations).toHaveLength(2);
  });

  test('arrow function with expression body', () => {
    const source = `const id = x => x;`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(2); // param + body
  });

  test('default parameter', () => {
    const source = `const f = (x = 0) => x + 1;`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(2);
  });

  test('go-to-definition for function called from nested scope', () => {
    const source = `const reduce = (fn, acc, xs) => xs.reduce(fn, acc);\nconst tail = xs => {\n  return reduce (fn, init, xs);\n};`;
    const callOffset = source.lastIndexOf('reduce');
    const group = findReferencesAtOffset(source, callOffset);
    expect(group).not.toBeNull();
    expect(group!.name).toBe('reduce');
    const defLoc = group!.locations.find(l => l.isDefinition);
    expect(defLoc).toBeDefined();
    // Definition should point to the const declaration, not the call site
    expect(defLoc!.start).toBe(source.indexOf('reduce'));
    expect(defLoc!.isDefinition).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectReferences — advanced AST patterns
// ---------------------------------------------------------------------------

describe('collectReferences — advanced patterns', () => {
  test('conditional (ternary) expression references', () => {
    const source = `const a = 1;\nconst b = 2;\nconst c = true ? a : b;`;
    const groups = collectReferences(source);
    const aGroup = findGroupByName(groups, 'a');
    expect(aGroup!.locations).toHaveLength(2);
    const bGroup = findGroupByName(groups, 'b');
    expect(bGroup!.locations).toHaveLength(2);
  });

  test('tagged template literal references', () => {
    const source = 'const tag = s => s;\nconst x = 1;\nconst r = tag`hello ${x}`;';
    const groups = collectReferences(source);
    const tagGroup = findGroupByName(groups, 'tag');
    expect(tagGroup!.locations).toHaveLength(2);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup!.locations).toHaveLength(2);
  });

  test('class declaration with method using outer variable', () => {
    const source = `const val = 42;\nclass Foo {\n  bar() { return val; }\n}`;
    const groups = collectReferences(source);
    const fooGroup = findGroupByName(groups, 'Foo');
    expect(fooGroup).not.toBeNull();
    expect(fooGroup!.locations[0].isDefinition).toBe(true);
    const valGroup = findGroupByName(groups, 'val');
    expect(valGroup!.locations).toHaveLength(2);
  });

  test('class expression with named identifier', () => {
    const source = `const MyClass = class InternalName {\n  method() { return 1; }\n};`;
    const groups = collectReferences(source);
    const myGroup = findGroupByName(groups, 'MyClass');
    expect(myGroup).not.toBeNull();
    expect(myGroup!.locations[0].isDefinition).toBe(true);
  });

  test('try-catch-finally scoping', () => {
    const source = `const x = 1;\ntry {\n  const y = x;\n} catch (e) {\n  const z = e;\n} finally {\n  const w = x;\n}`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    // x: decl + usage in try block + usage in finally
    expect(xGroup!.locations).toHaveLength(3);
    const eGroup = findGroupByName(groups, 'e');
    expect(eGroup).not.toBeNull();
    expect(eGroup!.locations).toHaveLength(2); // catch param + usage
  });

  test('for-in loop variable', () => {
    const source = `const obj = { a: 1 };\nfor (const key in obj) {\n  const v = key;\n}`;
    const groups = collectReferences(source);
    const objGroup = findGroupByName(groups, 'obj');
    expect(objGroup!.locations).toHaveLength(2);
    const keyGroup = findGroupByName(groups, 'key');
    expect(keyGroup).not.toBeNull();
    expect(keyGroup!.locations).toHaveLength(2);
  });

  test('function declaration hoisting at top level', () => {
    const source = `const x = foo();\nfunction foo() { return 1; }`;
    const groups = collectReferences(source);
    const fooGroup = findGroupByName(groups, 'foo');
    expect(fooGroup).not.toBeNull();
    // Hoisted function: a single group with definition + call
    // (hoisting creates one declaration, the block walk skips re-declaring)
    expect(fooGroup!.locations.filter(l => !l.isDefinition)).toHaveLength(1);
  });

  test('function declaration hoisting inside block', () => {
    const source = `function outer() {\n  const x = inner();\n  function inner() { return 1; }\n  return x;\n}`;
    const groups = collectReferences(source);
    const innerGroup = findGroupByName(groups, 'inner');
    expect(innerGroup).not.toBeNull();
    // inner: hoisted def + call usage
    expect(innerGroup!.locations.filter(l => l.isDefinition).length).toBeGreaterThanOrEqual(1);
  });

  test('export named declaration tracks references', () => {
    const source = `const foo = 1;\nexport { foo };`;
    const groups = collectReferences(source);
    const fooGroup = findGroupByName(groups, 'foo');
    expect(fooGroup).not.toBeNull();
    // def + export usage
    expect(fooGroup!.locations).toHaveLength(2);
  });

  test('export default function declaration', () => {
    const source = `export default function main() { return 1; }`;
    const groups = collectReferences(source);
    const mainGroup = findGroupByName(groups, 'main');
    expect(mainGroup).not.toBeNull();
    expect(mainGroup!.locations[0].isDefinition).toBe(true);
  });

  test('export default expression', () => {
    const source = `const x = 1;\nexport default x;`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(2);
  });

  test('while loop references', () => {
    const source = `let x = 10;\nwhile (x > 0) {\n  x = x - 1;\n}`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations.length).toBeGreaterThanOrEqual(4);
  });

  test('computed member expression tracks property expression', () => {
    const source = `const obj = {};\nconst key = 'a';\nconst val = obj[key];`;
    const groups = collectReferences(source);
    const keyGroup = findGroupByName(groups, 'key');
    expect(keyGroup!.locations).toHaveLength(2);
  });

  test('new expression references', () => {
    const source = `const Cls = class {};\nconst obj = new Cls();`;
    const groups = collectReferences(source);
    const clsGroup = findGroupByName(groups, 'Cls');
    expect(clsGroup!.locations).toHaveLength(2);
  });

  test('sequence expression references', () => {
    const source = `const a = 1;\nconst b = 2;\nconst c = (a, b);`;
    const groups = collectReferences(source);
    const aGroup = findGroupByName(groups, 'a');
    expect(aGroup!.locations).toHaveLength(2);
    const bGroup = findGroupByName(groups, 'b');
    expect(bGroup!.locations).toHaveLength(2);
  });

  test('unary and update expressions', () => {
    const source = `let x = 1;\nconst y = -x;\nx++;`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(3); // decl + unary + update
  });

  test('logical expression references', () => {
    const source = `const a = true;\nconst b = false;\nconst c = a && b;`;
    const groups = collectReferences(source);
    const aGroup = findGroupByName(groups, 'a');
    expect(aGroup!.locations).toHaveLength(2);
    const bGroup = findGroupByName(groups, 'b');
    expect(bGroup!.locations).toHaveLength(2);
  });

  test('labeled statement body is walked', () => {
    const source = `const x = 1;\nouter: for (let i = 0; i < 10; i++) {\n  const y = x;\n}`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup!.locations).toHaveLength(2);
  });

  test('class with superclass and computed property', () => {
    const source = `const Base = class {};\nconst key = 'method';\nclass Child extends Base {\n  [key]() { return 1; }\n}`;
    const groups = collectReferences(source);
    const baseGroup = findGroupByName(groups, 'Base');
    expect(baseGroup!.locations).toHaveLength(2); // decl + extends
    const keyGroup = findGroupByName(groups, 'key');
    expect(keyGroup!.locations).toHaveLength(2); // decl + computed prop
  });

  test('annotation info is attached when InferenceResult is passed', () => {
    const source = `// add :: Number -> Number -> Number\nconst add = (a, b) => a + b;`;
    const r = engine.infer(source);
    const groups = collectReferences(source, r);
    const addGroup = findGroupByName(groups, 'add');
    expect(addGroup).not.toBeNull();
    expect(addGroup!.annotationNameStart).toBeDefined();
    expect(addGroup!.annotationNameEnd).toBeDefined();
    // The annotation name should point within the comment
    expect(addGroup!.annotationNameStart!).toBeLessThan(source.indexOf('\n'));
  });
});

// ---------------------------------------------------------------------------
// collectScopeBindings
// ---------------------------------------------------------------------------

describe('collectScopeBindings', () => {
  test('top-level const declarations are visible', () => {
    const source = `const x = 1;\nconst y = 2;`;
    const names = collectScopeBindings(source, source.length);
    expect(names.has('x')).toBe(true);
    expect(names.has('y')).toBe(true);
  });

  test('function params are visible inside function body', () => {
    const source = `const add = (a, b) => a + b;`;
    // Place cursor inside the arrow body (at 'a + b')
    const offset = source.indexOf('a + b');
    const names = collectScopeBindings(source, offset);
    expect(names.has('a')).toBe(true);
    expect(names.has('b')).toBe(true);
  });

  test('function params are not visible outside function', () => {
    const source = `const f = (inner) => inner;\nconst x = 1;`;
    // Cursor at `const x = 1`
    const offset = source.indexOf('const x');
    const names = collectScopeBindings(source, offset);
    expect(names.has('f')).toBe(true);
    expect(names.has('inner')).toBe(false);
  });

  test('imports are visible at module scope', () => {
    const source = `import { map } from './utils';\nconst x = map([1]);`;
    const offset = source.indexOf('map([');
    const names = collectScopeBindings(source, offset);
    expect(names.has('map')).toBe(true);
  });

  test('for-of loop variable is visible inside loop body', () => {
    const source = `const arr = [1];\nfor (const item of arr) {\n  const y = item;\n}`;
    const offset = source.indexOf('const y');
    const names = collectScopeBindings(source, offset);
    expect(names.has('item')).toBe(true);
    expect(names.has('arr')).toBe(true);
  });

  test('for-in loop variable is visible inside loop body', () => {
    const source = `const obj = {};\nfor (const key in obj) {\n  const v = key;\n}`;
    const offset = source.indexOf('const v');
    const names = collectScopeBindings(source, offset);
    expect(names.has('key')).toBe(true);
    expect(names.has('obj')).toBe(true);
  });

  test('catch parameter is visible inside catch block', () => {
    const source = `try {\n  throw 1;\n} catch (err) {\n  const x = err;\n}`;
    const offset = source.indexOf('const x');
    const names = collectScopeBindings(source, offset);
    expect(names.has('err')).toBe(true);
  });

  test('if-statement nested variable is visible at cursor', () => {
    const source = `const x = 1;\nif (true) {\n  const y = 2;\n  const z = y;\n}`;
    const offset = source.indexOf('const z');
    const names = collectScopeBindings(source, offset);
    expect(names.has('x')).toBe(true);
    expect(names.has('y')).toBe(true);
  });

  test('function declaration is hoisted and visible before definition', () => {
    const source = `const x = foo();\nfunction foo() { return 1; }`;
    const offset = source.indexOf('foo()');
    const names = collectScopeBindings(source, offset);
    expect(names.has('foo')).toBe(true);
  });

  test('class declaration is visible', () => {
    const source = `class Foo {\n  bar() { return 1; }\n}\nconst x = new Foo();`;
    const offset = source.indexOf('new Foo');
    const names = collectScopeBindings(source, offset);
    expect(names.has('Foo')).toBe(true);
  });

  test('switch statement body bindings are visible', () => {
    const source = `const x = 1;\nswitch (x) {\n  case 1:\n    const y = 2;\n    break;\n}`;
    const offset = source.indexOf('const y');
    const names = collectScopeBindings(source, offset);
    expect(names.has('x')).toBe(true);
  });

  test('while loop body bindings', () => {
    const source = `const flag = true;\nwhile (flag) {\n  const inner = 1;\n}`;
    const offset = source.indexOf('const inner');
    const names = collectScopeBindings(source, offset);
    expect(names.has('flag')).toBe(true);
  });

  test('for loop variable is visible inside body', () => {
    const source = `for (let i = 0; i < 10; i++) {\n  const x = i;\n}`;
    const offset = source.indexOf('const x');
    const names = collectScopeBindings(source, offset);
    expect(names.has('i')).toBe(true);
  });

  test('nested arrow function params are visible', () => {
    const source = `const outer = (a) => {\n  const inner = (b) => a + b;\n  return inner;\n};`;
    const offset = source.indexOf('a + b');
    const names = collectScopeBindings(source, offset);
    expect(names.has('a')).toBe(true);
    expect(names.has('b')).toBe(true);
  });

  test('export named declaration binding is visible', () => {
    const source = `export const foo = 1;\nconst bar = foo;`;
    const offset = source.indexOf('const bar');
    const names = collectScopeBindings(source, offset);
    expect(names.has('foo')).toBe(true);
  });

  test('destructured import bindings are visible', () => {
    const source = `import { Left, Right } from './Either';\nconst x = Left(1);`;
    const offset = source.indexOf('Left(1)');
    const names = collectScopeBindings(source, offset);
    expect(names.has('Left')).toBe(true);
    expect(names.has('Right')).toBe(true);
  });

  test('syntax error returns empty map', () => {
    const names = collectScopeBindings('const = ;; {{', 0);
    expect(names.size).toBe(0);
  });

  test('return statement expression is walked', () => {
    const source = `const x = 1;\nfunction f() {\n  return x + 1;\n}`;
    const offset = source.indexOf('return x');
    const names = collectScopeBindings(source, offset);
    expect(names.has('x')).toBe(true);
  });

  test('class body method walker finds bindings', () => {
    const source = `const x = 1;\nclass Foo {\n  method() {\n    const y = x;\n  }\n}`;
    const offset = source.indexOf('const y');
    const names = collectScopeBindings(source, offset);
    expect(names.has('x')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectReferences — destructuring patterns
// ---------------------------------------------------------------------------

describe('collectReferences — destructuring patterns', () => {
  test('object destructuring declaration', () => {
    const source = `const { a, b } = obj;\nconst c = a + b;`;
    const groups = collectReferences(source);
    const aGroup = findGroupByName(groups, 'a');
    expect(aGroup).not.toBeNull();
    expect(aGroup!.locations.length).toBeGreaterThanOrEqual(2); // decl + usage
  });

  test('array destructuring declaration', () => {
    const source = `const [first, second] = arr;\nconst x = first;`;
    const groups = collectReferences(source);
    const firstGroup = findGroupByName(groups, 'first');
    expect(firstGroup).not.toBeNull();
    expect(firstGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });

  test('rest element in destructuring', () => {
    const source = `const [head, ...rest] = arr;\nconst x = rest;`;
    const groups = collectReferences(source);
    const restGroup = findGroupByName(groups, 'rest');
    expect(restGroup).not.toBeNull();
    expect(restGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });

  test('nested object destructuring', () => {
    const source = `const { a: { b } } = obj;\nconst x = b;`;
    const groups = collectReferences(source);
    const bGroup = findGroupByName(groups, 'b');
    expect(bGroup).not.toBeNull();
  });

  test('destructuring with default value', () => {
    const source = `const { x = 10 } = obj;\nconst y = x;`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// collectReferences — class and function expressions
// ---------------------------------------------------------------------------

describe('collectReferences — class and function expression patterns', () => {
  test('class expression assigned to variable', () => {
    const source = `const MyClass = class { method() { return 1; } };\nconst obj = new MyClass();`;
    const groups = collectReferences(source);
    const classGroup = findGroupByName(groups, 'MyClass');
    expect(classGroup).not.toBeNull();
    expect(classGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });

  test('named function expression', () => {
    const source = `const fn = function myFn(x) { return myFn; };\nfn(1);`;
    const groups = collectReferences(source);
    const fnGroup = findGroupByName(groups, 'fn');
    expect(fnGroup).not.toBeNull();
    expect(fnGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });

  test('class with static methods and constructor', () => {
    const source = `class Point {\n  constructor(x, y) { this.x = x; this.y = y; }\n  static origin() { return new Point(0, 0); }\n}\nconst p = new Point(1, 2);`;
    const groups = collectReferences(source);
    const pointGroup = findGroupByName(groups, 'Point');
    expect(pointGroup).not.toBeNull();
    expect(pointGroup!.locations.length).toBeGreaterThanOrEqual(3); // declaration + origin() + new Point
  });
});

// ---------------------------------------------------------------------------
// collectReferences — switch, labeled, and with statements
// ---------------------------------------------------------------------------

describe('collectReferences — switch and labeled statements', () => {
  test('switch statement references', () => {
    const source = `const x = 1;\nswitch (x) {\n  case 1: const a = x; break;\n  default: const b = x;\n}`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations.length).toBeGreaterThanOrEqual(3); // decl + switch + case usage(s)
  });

  test('labeled statement references', () => {
    const source = `const x = 0;\nouter: for (let i = 0; i < 5; i++) {\n  for (let j = 0; j < 5; j++) {\n    if (i === j) break outer;\n  }\n}`;
    const groups = collectReferences(source);
    const iGroup = findGroupByName(groups, 'i');
    expect(iGroup).not.toBeNull();
    expect(iGroup!.locations.length).toBeGreaterThanOrEqual(4); // let i, i < 5, i++, i === j
  });
});

// ---------------------------------------------------------------------------
// collectReferences — export specifiers and re-exports
// ---------------------------------------------------------------------------

describe('collectReferences — exports', () => {
  test('export { name } counts as usage', () => {
    const source = `const x = 1;\nexport { x };`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations.length).toBeGreaterThanOrEqual(2); // decl + export
  });

  test('export { name as alias } counts as usage', () => {
    const source = `const x = 1;\nexport { x as y };`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });

  test('export default function declaration', () => {
    const source = `export default function main() { return 1; }\nconst x = main();`;
    const groups = collectReferences(source);
    const mainGroup = findGroupByName(groups, 'main');
    expect(mainGroup).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// collectReferences — spread and computed properties
// ---------------------------------------------------------------------------

describe('collectReferences — spread and computed properties', () => {
  test('spread element in object expression', () => {
    const source = `const a = { x: 1 };\nconst b = { ...a, y: 2 };`;
    const groups = collectReferences(source);
    const aGroup = findGroupByName(groups, 'a');
    expect(aGroup).not.toBeNull();
    expect(aGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });

  test('spread element in array expression', () => {
    const source = `const arr = [1, 2];\nconst arr2 = [...arr, 3];`;
    const groups = collectReferences(source);
    const arrGroup = findGroupByName(groups, 'arr');
    expect(arrGroup).not.toBeNull();
    expect(arrGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });

  test('computed property access', () => {
    const source = `const x = 1;\nconst key = "foo";\nconst obj = { [key]: x };`;
    const groups = collectReferences(source);
    const keyGroup = findGroupByName(groups, 'key');
    expect(keyGroup).not.toBeNull();
    expect(keyGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// collectReferences — for-in with expression left, export all, with statement
// ---------------------------------------------------------------------------

describe('collectReferences — for-in expression and export all', () => {
  test('for-in with pre-declared variable references the variable', () => {
    const source = `let key;\nconst obj = { a: 1 };\nfor (key in obj) { const x = key; }`;
    const groups = collectReferences(source);
    const keyGroup = findGroupByName(groups, 'key');
    expect(keyGroup).not.toBeNull();
    expect(keyGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });

  test('export all declaration does not crash', () => {
    const source = `export * from './other';`;
    const groups = collectReferences(source);
    expect(groups).toBeDefined();
  });

  test('spread argument in function call references the spread variable', () => {
    const source = `const args = [1, 2, 3];\nfunction sum(a, b, c) { return a + b + c; }\nconst r = sum(...args);`;
    const groups = collectReferences(source);
    const argsGroup = findGroupByName(groups, 'args');
    expect(argsGroup).not.toBeNull();
    expect(argsGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// collectScopeBindings — for-statement expression init, export default fn
// ---------------------------------------------------------------------------

describe('collectScopeBindings — expression init and export default', () => {
  test('for loop with expression init includes variables from body', () => {
    const source = `let i = 0;\nfor (i = 0; i < 10; i++) {\n  const x = i;\n}\n`;
    const offset = source.indexOf('const x');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('i')).toBe(true);
  });

  test('export default function declaration is visible in scope', () => {
    const source = `export default function greet() {\n  const x = 1;\n  return x;\n}\n`;
    const offset = source.indexOf('return');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('x')).toBe(true);
  });

  test('import declaration names visible in scope', () => {
    const source = `import { foo, bar } from './mod';\nconst x = foo;\n`;
    const offset = source.indexOf('const x');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('foo')).toBe(true);
    expect(bindings.has('bar')).toBe(true);
  });

  test('export default function visible inside its body', () => {
    const source = `export default function myFunc() {\n  const x = 1;\n  return x;\n}\n`;
    const offset = source.indexOf('return');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('x')).toBe(true);
  });

  test('export default expression — arrow inside export default', () => {
    const source = `const y = 2;\nexport default (x) => x + y;\n`;
    const offset = source.indexOf('x + y');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('x')).toBe(true);
    expect(bindings.has('y')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectScopeBindings — for-of / for-in loops
// ---------------------------------------------------------------------------

describe('collectScopeBindings — additional loop patterns', () => {
  test('for-of loop variable is scoped', () => {
    const source = `for (const item of items) {\n  use(item);\n}`;
    const bindings = collectScopeBindings(source, 30); // inside loop body
    expect(bindings.has('item')).toBe(true);
  });

  test('for-in loop variable is scoped', () => {
    const source = `for (const key in obj) {\n  use(key);\n}`;
    const bindings = collectScopeBindings(source, 28); // inside loop body
    expect(bindings.has('key')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectReferences — tagged template expressions
// ---------------------------------------------------------------------------

describe('collectReferences — tagged template expressions', () => {
  test('tag function in tagged template is referenced', () => {
    const source = `const html = (strings) => strings.join('');\nconst result = html\`<div>\${1}</div>\`;`;
    const groups = collectReferences(source);
    const htmlGroup = findGroupByName(groups, 'html');
    expect(htmlGroup).not.toBeNull();
    expect(htmlGroup!.locations).toHaveLength(2); // decl + tag usage
  });

  test('interpolated variables in tagged template are referenced', () => {
    const source = `const tag = (s) => s;\nconst x = 1;\nconst r = tag\`value: \${x}\`;`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(2); // decl + interpolation
  });
});

// ---------------------------------------------------------------------------
// collectReferences — destructuring patterns (object, array, rest, default)
// ---------------------------------------------------------------------------

describe('collectReferences — destructuring patterns', () => {
  test('object destructuring with rest element', () => {
    const source = `const obj = { a: 1, b: 2, c: 3 };\nconst { a, ...rest } = obj;\nconst x = rest;`;
    const groups = collectReferences(source);
    const restGroup = findGroupByName(groups, 'rest');
    expect(restGroup).not.toBeNull();
    expect(restGroup!.locations).toHaveLength(2); // decl + usage
  });

  test('array destructuring tracks each element', () => {
    const source = `const [first, second] = [1, 2];\nconst sum = first + second;`;
    const groups = collectReferences(source);
    const firstGroup = findGroupByName(groups, 'first');
    expect(firstGroup).not.toBeNull();
    expect(firstGroup!.locations).toHaveLength(2);
    const secondGroup = findGroupByName(groups, 'second');
    expect(secondGroup).not.toBeNull();
    expect(secondGroup!.locations).toHaveLength(2);
  });

  test('default value in destructuring pattern', () => {
    const source = `const x = 10;\nconst { a = x } = {};\nconst b = a;`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(2); // decl + default value
    const aGroup = findGroupByName(groups, 'a');
    expect(aGroup).not.toBeNull();
    expect(aGroup!.locations).toHaveLength(2); // decl + usage
  });

  test('nested object destructuring', () => {
    const source = `const { a: { b } } = { a: { b: 1 } };\nconst x = b;`;
    const groups = collectReferences(source);
    const bGroup = findGroupByName(groups, 'b');
    expect(bGroup).not.toBeNull();
    expect(bGroup!.locations).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// collectReferences — for-statement with init expression
// ---------------------------------------------------------------------------

describe('collectReferences — for-statement details', () => {
  test('for-loop with expression init references variables', () => {
    const source = `let i = 0;\nfor (i = 0; i < 10; i++) {\n  const x = i;\n}`;
    const groups = collectReferences(source);
    const iGroup = findGroupByName(groups, 'i');
    expect(iGroup).not.toBeNull();
    expect(iGroup!.locations.length).toBeGreaterThanOrEqual(4); // let, i=0, i<10, i++, i inside
  });

  test('for-of with destructuring pattern', () => {
    const source = `const arr = [[1, 2]];\nfor (const [a, b] of arr) {\n  const sum = a + b;\n}`;
    const groups = collectReferences(source);
    const aGroup = findGroupByName(groups, 'a');
    expect(aGroup).not.toBeNull();
    expect(aGroup!.locations).toHaveLength(2);
    const bGroup = findGroupByName(groups, 'b');
    expect(bGroup).not.toBeNull();
    expect(bGroup!.locations).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// collectReferences — class expression (assigned to variable)
// ---------------------------------------------------------------------------

describe('collectReferences — class expressions', () => {
  test('class expression with named id and superclass', () => {
    const source = `const Base = class {};\nconst Child = class MyChild extends Base {\n  method() { return 1; }\n};`;
    const groups = collectReferences(source);
    const baseGroup = findGroupByName(groups, 'Base');
    expect(baseGroup).not.toBeNull();
    expect(baseGroup!.locations).toHaveLength(2); // decl + extends
  });

  test('class expression with internal name reference', () => {
    const source = `const Foo = class FooInner {\n  clone() { return new FooInner(); }\n};`;
    const groups = collectReferences(source);
    const fooInnerGroups = findAllGroupsByName(groups, 'FooInner');
    expect(fooInnerGroups.length).toBeGreaterThanOrEqual(1);
    const innerGroup = fooInnerGroups.find(g => g.locations.some(l => l.isDefinition));
    expect(innerGroup).toBeDefined();
    expect(innerGroup!.locations.length).toBeGreaterThanOrEqual(2); // decl + new usage
  });
});

// ---------------------------------------------------------------------------
// collectReferences — yield and await expressions
// ---------------------------------------------------------------------------

describe('collectReferences — yield and await', () => {
  test('yield expression references the yielded value', () => {
    const source = `const x = 1;\nfunction* gen() { yield x; }`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(2); // decl + yield
  });

  test('await expression references the awaited value', () => {
    const source = `const p = Promise.resolve(1);\nasync function run() { const r = await p; }`;
    const groups = collectReferences(source);
    const pGroup = findGroupByName(groups, 'p');
    expect(pGroup).not.toBeNull();
    expect(pGroup!.locations).toHaveLength(2); // decl + await
  });
});

// ---------------------------------------------------------------------------
// collectReferences — with / labeled statements
// ---------------------------------------------------------------------------

describe('collectReferences — labeled statement', () => {
  test('labeled for-loop body variables are tracked', () => {
    const source = `const x = 0;\nouter: for (let i = 0; i < 5; i++) {\n  const y = x + i;\n}`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations).toHaveLength(2); // decl + usage inside loop
  });
});

// ---------------------------------------------------------------------------
// collectReferences — try/catch
// ---------------------------------------------------------------------------

describe('collectReferences — try/catch', () => {
  test('catch param is scoped to catch block', () => {
    const source = `try { throw 1; } catch (err) { const x = err; }`;
    const groups = collectReferences(source);
    const errGroup = findGroupByName(groups, 'err');
    expect(errGroup).not.toBeNull();
    expect(errGroup!.locations).toHaveLength(2); // param decl + usage
  });
});

// ---------------------------------------------------------------------------
// collectReferences — switch statements
// ---------------------------------------------------------------------------

describe('collectReferences — switch statement', () => {
  test('variables in switch case bodies are collected', () => {
    const source = `const status = 'ok';\nswitch (status) {\n  case 'ok':\n    const msg = 'good';\n    break;\n  case 'err':\n    const err = 'bad';\n    break;\n}`;
    const groups = collectReferences(source);
    const statusGroup = findGroupByName(groups, 'status');
    expect(statusGroup).not.toBeNull();
    expect(statusGroup!.locations.length).toBeGreaterThanOrEqual(2); // decl + switch test
  });
});

// ---------------------------------------------------------------------------
// collectReferences — for-in / for-of variable declarations
// ---------------------------------------------------------------------------

describe('collectReferences — for-in/for-of bindings', () => {
  test('for-of variable declaration is collected', () => {
    const source = `const arr = [1, 2, 3];\nfor (const item of arr) {\n  const x = item;\n}`;
    const groups = collectReferences(source);
    const itemGroup = findGroupByName(groups, 'item');
    expect(itemGroup).not.toBeNull();
    expect(itemGroup!.locations.length).toBeGreaterThanOrEqual(2); // decl + usage
  });

  test('for-in variable declaration is collected', () => {
    const source = `const obj = { a: 1 };\nfor (const key in obj) {\n  const x = key;\n}`;
    const groups = collectReferences(source);
    const keyGroup = findGroupByName(groups, 'key');
    expect(keyGroup).not.toBeNull();
    expect(keyGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// collectReferences — function declarations & arrow function scope
// ---------------------------------------------------------------------------

describe('collectReferences — function scope names', () => {
  test('function declaration name is reference-collected', () => {
    const source = `function helper() { return 1; }\nconst x = helper();`;
    const groups = collectReferences(source);
    const hGroup = findGroupByName(groups, 'helper');
    expect(hGroup).not.toBeNull();
    expect(hGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });

  test('arrow function assigned to const collects references', () => {
    const source = `const process = (x) => x * 2;\nconst result = process(5);`;
    const groups = collectReferences(source);
    const pGroup = findGroupByName(groups, 'process');
    expect(pGroup).not.toBeNull();
    expect(pGroup!.locations.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// collectReferences — class expression
// ---------------------------------------------------------------------------

describe('collectReferences — class expression', () => {
  test('class expression name tracked', () => {
    const source = `const Foo = class Foo { method() { return Foo; } };`;
    const groups = collectReferences(source);
    const fooGroup = findGroupByName(groups, 'Foo');
    expect(fooGroup).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// collectReferences — try-catch-finally
// ---------------------------------------------------------------------------

describe('collectReferences — try-catch-finally', () => {
  test('references in try/catch/finally blocks', () => {
    const source = `const x = 1; try { const a = x; } catch(e) { const b = x; } finally { const c = x; }`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations.length).toBeGreaterThanOrEqual(4); // def + 3 usages
  });
});

// ---------------------------------------------------------------------------
// collectReferences — export specifiers
// ---------------------------------------------------------------------------

describe('collectReferences — export specifiers', () => {
  test('export { x } counts as usage', () => {
    const source = `const x = 1;\nconst y = 2;\nexport { x, y };`;
    const groups = collectReferences(source);
    const xGroup = findGroupByName(groups, 'x');
    expect(xGroup).not.toBeNull();
    expect(xGroup!.locations.length).toBeGreaterThanOrEqual(2); // def + export usage
  });
});

// ---------------------------------------------------------------------------
// collectScopeBindings — for loop, labeled block, exports, class expression
// ---------------------------------------------------------------------------

describe('collectScopeBindings — additional coverage', () => {
  test('for loop variable visible inside body', () => {
    const source = `for (let i = 0; i < 10; i++) { const x = i; }`;
    const offset = source.indexOf('const x');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('i')).toBe(true);
  });

  test('labeled block — variable visible inside', () => {
    const source = `outer: { const x = 1; const y = x; }`;
    const offset = source.indexOf('const y');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('x')).toBe(true);
  });

  test('export declarations visible as scope bindings', () => {
    const source = `export const x = 1;\nexport default function foo() { return 1; }\nconst y = x;`;
    const offset = source.indexOf('const y');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('x')).toBe(true);
  });

  test('class expression id visible inside body', () => {
    const source = `const C = class MyClass { method() { return 1; } }`;
    const offset = source.indexOf('return');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('MyClass')).toBe(true);
  });

  test('includes for-in loop variable at offset inside loop body', () => {
    const source = `const obj = { a: 1 };\nfor (const key in obj) {\n  console.log(key);\n}\n`;
    const offset = source.indexOf('console');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('key')).toBe(true);
    expect(bindings.has('obj')).toBe(true);
  });

  test('includes switch-case scope bindings', () => {
    const source = `const x = 1;\nswitch (x) {\n  case 1:\n    const y = 2;\n    break;\n}\n`;
    const offset = source.indexOf('break');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('x')).toBe(true);
    expect(bindings.has('y')).toBe(true);
  });

  test('includes array destructured names in scope', () => {
    const source = `const [a, b, ...rest] = [1, 2, 3, 4];\nconst x = a;\n`;
    const offset = source.indexOf('const x');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('a')).toBe(true);
    expect(bindings.has('b')).toBe(true);
    expect(bindings.has('rest')).toBe(true);
  });

  test('includes object destructured names with rest and defaults in scope', () => {
    const source = `const { a, b = 5, ...rest } = { a: 1, b: 2, c: 3 };\nconst x = a;\n`;
    const offset = source.indexOf('const x');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('a')).toBe(true);
    expect(bindings.has('b')).toBe(true);
    expect(bindings.has('rest')).toBe(true);
  });

  test('includes for-of with destructuring pattern', () => {
    const source = `const arr = [[1, "a"]];\nfor (const [num, str] of arr) {\n  const x = num;\n}\n`;
    const offset = source.indexOf('const x');
    const bindings = collectScopeBindings(source, offset);
    expect(bindings.has('num')).toBe(true);
    expect(bindings.has('str')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findGroupByName(
  groups: Map<number, ReferenceGroup>,
  name: string,
): ReferenceGroup | null {
  for (const [, g] of groups) {
    if (g.name === name) return g;
  }
  return null;
}

function findAllGroupsByName(
  groups: Map<number, ReferenceGroup>,
  name: string,
): ReferenceGroup[] {
  const result: ReferenceGroup[] = [];
  for (const [, g] of groups) {
    if (g.name === name) result.push(g);
  }
  return result;
}
