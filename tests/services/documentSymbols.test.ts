import { getDocumentSymbols, DocumentSymbolContext } from '../../src/services/documentSymbols';
import { InferenceEngine } from '../../src/infer';
import { InferenceResult } from '../../src/infer/types';
import { resetTypeVarCounter } from '../../src/hm/types';
import { SymbolKind } from 'vscode-languageserver/node';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferSource(source: string): InferenceResult {
  resetTypeVarCounter();
  const engine = new InferenceEngine();
  return engine.infer(source);
}

function getSymbols(source: string, style: 'pretty' | 'raw' = 'pretty') {
  const result = inferSource(source);
  const ctx: DocumentSymbolContext = { result, inferredTypeStyle: style };
  return getDocumentSymbols(source, ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getDocumentSymbols', () => {
  beforeEach(() => resetTypeVarCounter());

  // -----------------------------------------------------------------------
  // Basic declarations
  // -----------------------------------------------------------------------

  test('returns symbol for const declaration', () => {
    const symbols = getSymbols('const x = 42;\n');
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('x');
    expect(symbols[0].kind).toBe(SymbolKind.Variable);
  });

  test('returns symbol for function declaration', () => {
    const symbols = getSymbols('function add(a, b) { return a + b; }\n');
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('add');
    expect(symbols[0].kind).toBe(SymbolKind.Function);
  });

  test('returns symbol for arrow function', () => {
    const symbols = getSymbols('const add = (a, b) => a + b;\n');
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('add');
    expect(symbols[0].kind).toBe(SymbolKind.Function);
  });

  test('returns symbol for exported const', () => {
    const symbols = getSymbols('export const foo = 123;\n');
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('foo');
    expect(symbols[0].kind).toBe(SymbolKind.Variable);
  });

  test('returns symbol for exported function', () => {
    const symbols = getSymbols('export function bar(x) { return x; }\n');
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('bar');
    expect(symbols[0].kind).toBe(SymbolKind.Function);
  });

  test('returns multiple symbols for multiple declarations', () => {
    const source = 'const x = 1;\nconst y = 2;\nconst z = 3;\n';
    const symbols = getSymbols(source);
    expect(symbols).toHaveLength(3);
    expect(symbols.map(s => s.name)).toEqual(['x', 'y', 'z']);
  });

  // -----------------------------------------------------------------------
  // Symbol classification
  // -----------------------------------------------------------------------

  test('uppercase name with function type is Constructor', () => {
    const symbols = getSymbols('const Box = (value) => ({ value });\n');
    expect(symbols[0].kind).toBe(SymbolKind.Constructor);
  });

  test('lowercase name with function type is Function', () => {
    const symbols = getSymbols('const identity = (x) => x;\n');
    expect(symbols[0].kind).toBe(SymbolKind.Function);
  });

  test('non-function value is Variable', () => {
    const symbols = getSymbols('const x = 42;\n');
    expect(symbols[0].kind).toBe(SymbolKind.Variable);
  });

  // -----------------------------------------------------------------------
  // Type details
  // -----------------------------------------------------------------------

  test('includes inferred type as detail', () => {
    const symbols = getSymbols('const x = 42;\n');
    expect(symbols[0].detail).toBeDefined();
    expect(symbols[0].detail).toBe('Number');
  });

  test('includes function type as detail', () => {
    const source = '// add :: (Number, Number) -> Number\nconst add = (a, b) => a + b;\n';
    const symbols = getSymbols(source);
    expect(symbols[0].detail).toContain('Number');
  });

  test('raw style formats types differently', () => {
    const source = 'const identity = (x) => x;\n';
    const pretty = getSymbols(source, 'pretty');
    const raw = getSymbols(source, 'raw');
    // Both should have detail; the actual format may differ
    expect(pretty[0].detail).toBeDefined();
    expect(raw[0].detail).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Ranges
  // -----------------------------------------------------------------------

  test('selection range covers the identifier', () => {
    const symbols = getSymbols('const foo = 42;\n');
    const sel = symbols[0].selectionRange;
    expect(sel.start.line).toBe(0);
    expect(sel.start.character).toBe(6); // 'const ' = 6 chars
    expect(sel.end.character).toBe(9);   // 'foo' = 3 chars
  });

  test('full range covers the whole declaration', () => {
    const symbols = getSymbols('const foo = 42;\n');
    const range = symbols[0].range;
    expect(range.start.line).toBe(0);
    expect(range.start.character).toBe(0);
    // Should extend to end of the declaration
    expect(range.end.line).toBe(0);
  });

  test('full range extends to include annotation comment', () => {
    const source = '// foo :: Number\nconst foo = 42;\n';
    const symbols = getSymbols(source);
    // Full range should start at line 0 (the annotation comment)
    expect(symbols[0].range.start.line).toBe(0);
    expect(symbols[0].range.start.character).toBe(0);
    // But ends at the declaration end
    expect(symbols[0].range.end.line).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Method annotations as children
  // -----------------------------------------------------------------------

  test('method annotations are nested under constructor', () => {
    const source = `// Box :: a -> Box a
// Box#map :: Box a ~> (a -> b) -> Box b
const Box = (value) => ({
  map: (f) => Box(f(value)),
  value
});
`;
    const symbols = getSymbols(source);
    const box = symbols.find(s => s.name === 'Box');
    expect(box).toBeDefined();
    expect(box!.children).toBeDefined();
    expect(box!.children!.length).toBeGreaterThanOrEqual(1);
    const mapMethod = box!.children!.find(c => c.name === 'map');
    expect(mapMethod).toBeDefined();
    expect(mapMethod!.kind).toBe(SymbolKind.Method);
  });

  test('static method annotations are nested under parent', () => {
    const source = `// Box :: a -> Box a
const Box = (value) => ({ value });
// Box.fromValue :: a -> Box a
Box.fromValue = (v) => Box(v);
`;
    const symbols = getSymbols(source);
    const box = symbols.find(s => s.name === 'Box');
    expect(box).toBeDefined();
    expect(box!.children).toBeDefined();
    const fromValue = box!.children!.find(c => c.name === 'fromValue');
    expect(fromValue).toBeDefined();
    expect(fromValue!.kind).toBe(SymbolKind.Method);
  });

  // -----------------------------------------------------------------------
  // sumtype declarations
  // -----------------------------------------------------------------------

  test('sumtype becomes Enum with variant children', () => {
    const source = `// Maybe :: Just a | Nothing
const Just = (v) => ({ tag: 'Just', value: v });
const Nothing = { tag: 'Nothing' };
`;
    const symbols = getSymbols(source);
    const maybe = symbols.find(s => s.name === 'Maybe');
    expect(maybe).toBeDefined();
    expect(maybe!.kind).toBe(SymbolKind.Enum);
    expect(maybe!.children).toBeDefined();

    const variantNames = maybe!.children!.map(c => c.name);
    expect(variantNames).toContain('Just');
    expect(variantNames).toContain('Nothing');

    const justChild = maybe!.children!.find(c => c.name === 'Just');
    expect(justChild!.kind).toBe(SymbolKind.EnumMember);
  });

  test('sumtype with method annotations nests both variants and methods', () => {
    const source = `// Either :: Left e | Right a
// Either#map :: Either e a ~> (a -> b) -> Either e b
function Left(v) { return v; }
function Right(v) { return v; }
`;
    const symbols = getSymbols(source);
    const either = symbols.find(s => s.name === 'Either');
    expect(either).toBeDefined();
    expect(either!.children).toBeDefined();

    const childNames = either!.children!.map(c => c.name);
    expect(childNames).toContain('Left');
    expect(childNames).toContain('Right');
    expect(childNames).toContain('map');
  });

  // -----------------------------------------------------------------------
  // Type aliases
  // -----------------------------------------------------------------------

  test('type alias appears as Interface symbol', () => {
    const source = `// Predicate :: a -> Boolean
const isEven = (n) => n % 2 === 0;
`;
    const symbols = getSymbols(source);
    const predicate = symbols.find(s => s.name === 'Predicate');
    // "Predicate" is a standalone type alias — no matching declaration.
    // It should appear as an Interface.
    expect(predicate).toBeDefined();
    expect(predicate!.kind).toBe(SymbolKind.Interface);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  test('returns empty array for unparseable source', () => {
    const symbols = getDocumentSymbols('const = ???;', {
      result: inferSource('const x = 1;'),
      inferredTypeStyle: 'pretty',
    });
    expect(symbols).toEqual([]);
  });

  test('returns empty array for empty source', () => {
    const symbols = getSymbols('');
    expect(symbols).toEqual([]);
  });

  test('handles export default function', () => {
    const source = 'export default function main() { return 1; }\n';
    const symbols = getSymbols(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('main');
  });

  test('handles export default anonymous', () => {
    const source = 'export default (x) => x;\n';
    const symbols = getSymbols(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('default');
  });

  test('handles class declaration', () => {
    const source = 'class Foo { constructor() {} }\n';
    const symbols = getSymbols(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('Foo');
  });

  // -----------------------------------------------------------------------
  // Exported class declaration
  // -----------------------------------------------------------------------

  test('export named class declaration', () => {
    const source = 'export class Widget { render() { return ""; } }\n';
    const symbols = getSymbols(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('Widget');
  });

  // -----------------------------------------------------------------------
  // Constraint annotations in symbol detail
  // -----------------------------------------------------------------------

  test('function with constraint annotation shows constraint in detail', () => {
    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// lift :: Functor f => (a -> b) -> f a -> f b
const lift = f => fx => fx.map(f);
`;
    const symbols = getSymbols(source);
    const lift = symbols.find(s => s.name === 'lift');
    expect(lift).toBeDefined();
    expect(lift!.detail).toContain('Functor');
  });

  test('function with multiple constraints shows all in detail', () => {
    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Eq a { a :: { equals :: a -> a -> Boolean } }
// combine :: (Functor f, Eq a) => f a -> f a -> f a
const combine = (a, b) => a;
`;
    const symbols = getSymbols(source);
    const combine = symbols.find(s => s.name === 'combine');
    expect(combine).toBeDefined();
    expect(combine!.detail).toContain('Functor');
    expect(combine!.detail).toContain('Eq');
    // Multi-constraint format uses parentheses: (Functor f, Eq a) =>
    expect(combine!.detail).toMatch(/\(.*,.*\)\s*=>/);
  });

  // -----------------------------------------------------------------------
  // Class expression assigned to variable
  // -----------------------------------------------------------------------

  test('class expression assigned to const', () => {
    const source = `const Foo = class {\n  bar() { return 1; }\n};\n`;
    const symbols = getSymbols(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('Foo');
  });

  test('named class expression retains variable name', () => {
    const source = `const Foo = class FooImpl {\n  bar() { return 1; }\n};\n`;
    const symbols = getSymbols(source);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe('Foo');
  });

  // -----------------------------------------------------------------------
  // Multiple exports
  // -----------------------------------------------------------------------

  test('multiple exported declarations all appear', () => {
    const source = `export const x = 1;\nexport const y = 2;\nexport function z() { return 3; }\n`;
    const symbols = getSymbols(source);
    expect(symbols).toHaveLength(3);
    expect(symbols.map(s => s.name)).toEqual(['x', 'y', 'z']);
  });

  // -----------------------------------------------------------------------
  // Raw type style
  // -----------------------------------------------------------------------

  test('raw type style shows internal representation', () => {
    const source = `// id :: a -> a\nconst id = x => x;\n`;
    const prettySymbols = getSymbols(source, 'pretty');
    const rawSymbols = getSymbols(source, 'raw');
    expect(prettySymbols[0].detail).toBeDefined();
    expect(rawSymbols[0].detail).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Destructuring declaration (no symbol extracted)
  // -----------------------------------------------------------------------

  test('destructuring declaration does not produce a symbol', () => {
    const source = `const { x, y } = { x: 1, y: 2 };\n`;
    const symbols = getSymbols(source);
    expect(symbols).toHaveLength(0);
  });
});

describe('documentSymbols — private member annotations', () => {
  test('Class##name annotations produce non-empty Field symbols (regression: name must not be falsy)', () => {
    const source = `
// Counter :: () -> Counter
// Counter##history :: Array Number
// Counter##record :: Number -> Void
class Counter {
  #history = [];
  #record(snap) { this.#history = [...this.#history, snap]; }
}
`;
    const symbols = getSymbols(source);
    const counter = symbols.find(s => s.name === 'Counter');
    expect(counter).toBeDefined();
    expect(counter!.children).toBeDefined();
    // Every child symbol must have a non-empty name; the LSP client throws
    // "name must not be falsy" otherwise.
    for (const c of counter!.children!) {
      expect(c.name).toBeTruthy();
    }
    const childNames = counter!.children!.map(c => c.name);
    expect(childNames).toContain('#history');
    expect(childNames).toContain('#record');
  });
});

describe('documentSymbols — sumtype declarations', () => {
  test('sumtype type produces Enum with EnumMember children', () => {
    const source = `
// Either :: Left e | Right a
// Left :: e -> Either e a
// Right :: a -> Either e a
const Left = e => ({ isLeft: true, value: e });
const Right = a => ({ isRight: true, value: a });
`;
    const symbols = getSymbols(source);
    const either = symbols.find(s => s.name === 'Either');
    expect(either).toBeDefined();
    expect(either!.kind).toBe(SymbolKind.Enum);
    expect(either!.children).toBeDefined();
    const childNames = either!.children!.map(c => c.name);
    expect(childNames).toContain('Left');
    expect(childNames).toContain('Right');
  });
});

describe('documentSymbols — type alias symbols', () => {
  test('standalone type alias appears as Interface symbol', () => {
    const source = `
// Config :: { host :: String, port :: Number }
// getConfig :: String -> Config
const getConfig = env => ({ host: 'localhost', port: 8080 });
`;
    const result = inferSource(source);
    const aliases = [...result.typeAliases.keys()];
    expect(aliases).toContain('Config');

    const symbols = getSymbols(source);
    const config = symbols.find(s => s.name === 'Config');
    expect(config).toBeDefined();
    expect(config!.kind).toBe(SymbolKind.Interface);
  });

  test('type alias that matches a declaration is not duplicated', () => {
    const source = `
// Config :: { host :: String, port :: Number }
const Config = { host: 'localhost', port: 8080 };
`;
    const symbols = getSymbols(source);
    const configs = symbols.filter(s => s.name === 'Config');
    expect(configs).toHaveLength(1);
  });

  test('sumtype whose name matches a regular symbol is not duplicated', () => {
    const source = `
// Maybe :: Just a | Nothing
const Maybe = {};
`;
    const symbols = getSymbols(source);
    const maybes = symbols.filter(s => s.name === 'Maybe');
    expect(maybes).toHaveLength(1);
  });

  test('export default expression uses "default" as name', () => {
    const source = `export default 42;`;
    const symbols = getSymbols(source);
    const def = symbols.find(s => s.name === 'default');
    expect(def).toBeDefined();
    expect(def!.kind).toBe(SymbolKind.Variable);
  });
});
