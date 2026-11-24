// ============================================================================
// Parser contract test
//
// The engine is coupled to its JavaScript parser ONLY through src/parsing.ts
// (parse functions) and src/estree.ts (AST types).  This suite pins down the
// exact behaviours the rest of the codebase relies on, and runs them against
// EVERY built-in backend (acorn and, when installed, @babel/parser).  If the
// parser library is ever swapped, the replacement is acceptable exactly when
// every test below still passes for it.
// ============================================================================

import { builtinBackends, setParserBackend } from '../src/parsing';
import {
  parseStrict,
  parseLoose,
  parseExpression,
  describeParseError,
} from '../src/parsing';
import type { Comment, Node, Program } from '../src/estree';

describe.each(builtinBackends().map(b => [b.name, b] as const))(
  'parser contract (backend: %s)',
  (_name, backend) => {
    let restore: ReturnType<typeof setParserBackend>;
    beforeAll(() => { restore = setParserBackend(backend); });
    afterAll(() => { setParserBackend(restore); });
  // -------------------------------------------------------------------------
  // 1. Absolute start/end offsets on every node
  //
  // The entire engine keys its per-node type maps (`nodeTypes`,
  // `nodeTypesByEnd`, annotation attachment, hover lookup, …) on absolute
  // character offsets.  A replacement parser MUST expose them as `start` /
  // `end` numeric properties on each node.
  // -------------------------------------------------------------------------
  test('nodes carry absolute start/end character offsets', () => {
    const source = 'const answer = 40 + 2;';
    const ast = parseStrict(source);

    expect(ast.type).toBe('Program');
    expect(ast.start).toBe(0);
    expect(ast.end).toBe(source.length);

    const decl = ast.body[0] as any;
    expect(decl.type).toBe('VariableDeclaration');
    expect(source.slice(decl.start, decl.end)).toBe('const answer = 40 + 2;');

    const id = decl.declarations[0].id;
    expect(source.slice(id.start, id.end)).toBe('answer');

    const init = decl.declarations[0].init;
    expect(init.type).toBe('BinaryExpression');
    expect(source.slice(init.start, init.end)).toBe('40 + 2');
  });

  // -------------------------------------------------------------------------
  // 2. ES-module syntax (sourceType: 'module')
  // -------------------------------------------------------------------------
  test('parses import/export syntax', () => {
    const source = "import { add } from './math';\nexport const two = add(1, 1);\n";
    const ast = parseStrict(source);
    expect(ast.body[0].type).toBe('ImportDeclaration');
    expect(ast.body[1].type).toBe('ExportNamedDeclaration');
  });

  // -------------------------------------------------------------------------
  // 3. Comment collection with offsets
  //
  // HM annotations (`// name :: Type`) live in comments; extraction depends
  // on receiving every comment with its exact source span.
  // -------------------------------------------------------------------------
  test('collects comments with exact source spans', () => {
    const source = '// add :: Number -> Number -> Number\nconst add = (a) => (b) => a + b;\n/* block */\n';
    const comments: Comment[] = [];
    parseStrict(source, comments);

    expect(comments).toHaveLength(2);
    const [line, block] = comments;
    expect(line.type).toBe('Line');
    expect(line.value).toBe(' add :: Number -> Number -> Number');
    expect(source.slice(line.start, line.end)).toBe('// add :: Number -> Number -> Number');
    expect(block.type).toBe('Block');
    expect(source.slice(block.start, block.end)).toBe('/* block */');
  });

  // -------------------------------------------------------------------------
  // 4. Strict parse failure + normalized error info
  //
  // infer() turns the parse exception into a tightly-scoped diagnostic; the
  // normalized span must point INSIDE the source at the offending token.
  // -------------------------------------------------------------------------
  test('parseStrict throws on broken source; describeParseError yields a sane span', () => {
    const source = 'const = 1;';
    let err: unknown = null;
    try {
      parseStrict(source);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();

    const info = describeParseError(err, source);
    expect(info.message.length).toBeGreaterThan(0);
    // No parser-specific "(line:col)" suffix — the LSP carries the location
    // in the diagnostic range instead.
    expect(info.message).not.toMatch(/\(\d+:\d+\)\s*$/);
    expect(info.start).toBeGreaterThanOrEqual(0);
    expect(info.end).toBeGreaterThan(info.start);
    expect(info.end).toBeLessThanOrEqual(source.length);
  });

  // -------------------------------------------------------------------------
  // 5. Error-tolerant parsing
  //
  // Files are broken most of the time while the user is typing.  The loose
  // parser must return a best-effort Program in which statements BEFORE and
  // AFTER the broken one are still intact, so hover/completion keep working.
  // -------------------------------------------------------------------------
  test('parseLoose recovers a usable tree from a half-typed source', () => {
    const source = 'const good = 1;\nconst broken = ;\nconst alsoGood = 2;\n';
    expect(() => parseStrict(source)).toThrow();

    const ast = parseLoose(source);
    expect(ast.type).toBe('Program');

    const names: string[] = [];
    for (const stmt of ast.body as any[]) {
      if (stmt.type === 'VariableDeclaration') {
        for (const d of stmt.declarations) {
          if (d.id?.type === 'Identifier') names.push(d.id.name);
        }
      }
    }
    expect(names).toContain('good');
    expect(names).toContain('alsoGood');
  });

  test('parseLoose also collects comments', () => {
    const source = '// x :: Number\nconst x = ;\n';
    const comments: Comment[] = [];
    parseLoose(source, comments);
    expect(comments.some(c => c.value.includes('x :: Number'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 6. Standalone expression parsing (new Function(...) support)
  // -------------------------------------------------------------------------
  test('parseExpression parses a synthesized function expression', () => {
    const node: Node = parseExpression('(function(a,b) { return a + b; })');
    expect(node.type).toBe('FunctionExpression');
    expect(() => parseExpression('][')).toThrow();
  });

  // -------------------------------------------------------------------------
  // 7. Program type is the shared ESTree vocabulary
  // -------------------------------------------------------------------------
  test('strict and loose parses produce the same Program shape', () => {
    const strict: Program = parseStrict('let a = 1;');
    const loose: Program = parseLoose('let a = 1;');
    expect(strict.type).toBe(loose.type);
    expect(strict.sourceType).toBe('module');
    expect(loose.sourceType).toBe('module');
  });
  },
);

// ============================================================================
// JSX dispatch (façade-level, not per-backend)
//
// JSX is handled by the parsing façade itself: acorn is tried first, and on
// failure the babel backend (which always enables the jsx plugin) takes over.
// These tests exercise the default dispatch, so they run outside the
// per-backend block.
// ============================================================================
describe('JSX dispatch', () => {
  test('parseStrict parses a JSX element with offsets', () => {
    const source = 'const el = <div className="x">hoi</div>;';
    const ast = parseStrict(source);
    const init = (ast.body[0] as any).declarations[0].init;
    expect(init.type).toBe('JSXElement');
    expect(source.slice(init.start, init.end)).toBe('<div className="x">hoi</div>');
    const attr = init.openingElement.attributes[0];
    expect(attr.type).toBe('JSXAttribute');
    expect(source.slice(attr.start, attr.end)).toBe('className="x"');
  });

  test('parseStrict parses fragments, spreads and self-closing elements', () => {
    const source = 'const el = <><App {...props} /><br /></>;';
    const ast = parseStrict(source);
    const init = (ast.body[0] as any).declarations[0].init;
    expect(init.type).toBe('JSXFragment');
    const [app, br] = init.children;
    expect(app.type).toBe('JSXElement');
    expect(app.openingElement.selfClosing).toBe(true);
    expect(app.openingElement.attributes[0].type).toBe('JSXSpreadAttribute');
    expect(br.openingElement.name.name).toBe('br');
  });

  test('parseStrict collects comments in JSX sources', () => {
    const source = '// App :: {} -> ReactElement\nconst App = () => <p>x</p>;\n';
    const comments: Comment[] = [];
    parseStrict(source, comments);
    expect(comments.some(c => c.value.includes('App :: {} -> ReactElement'))).toBe(true);
  });

  test('parseLoose recovers a broken JSX source', () => {
    const source = 'const el = <div>{oops</div>;\nconst x = 1;\n';
    const ast = parseLoose(source);
    expect(ast.type).toBe('Program');
    expect(ast.body.length).toBeGreaterThan(0);
  });

  test('plain-JS syntax errors still surface the original error', () => {
    // No JSX sniff hit -> the acorn error (not babel's) must be reported.
    expect(() => parseStrict('const = 1;')).toThrow();
    try {
      parseStrict('const = 1;');
    } catch (err) {
      const described = describeParseError(err, 'const = 1;');
      expect(described).not.toBeNull();
      expect(typeof described!.start).toBe('number');
    }
  });
});
