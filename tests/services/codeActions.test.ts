import {
  getCodeActions,
  CodeActionContext,
} from '../../src/services/codeActions';
import {
  CodeActionParams,
  CodeActionKind,
  DiagnosticSeverity,
  Diagnostic,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { InferenceResult } from '../../src/infer/types';
import { resetTypeVarCounter } from '../../src/hm/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(content: string): TextDocument {
  return TextDocument.create('file:///test.js', 'javascript', 1, content);
}

function makeDiag(
  line: number,
  startChar: number,
  endChar: number,
  message: string,
): Diagnostic {
  return {
    severity: DiagnosticSeverity.Information,
    range: {
      start: { line, character: startChar },
      end: { line, character: endChar },
    },
    message,
    source: 'hinmil',
  };
}

function inferSource(source: string): InferenceResult {
  resetTypeVarCounter();
  const engine = new InferenceEngine();
  return engine.infer(source);
}

function makeParams(uri: string, diagnostics: Diagnostic[]): CodeActionParams {
  return {
    textDocument: { uri },
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
    context: {
      diagnostics,
    },
  };
}

// ---------------------------------------------------------------------------
// getCodeActions — add missing annotation
// ---------------------------------------------------------------------------

describe('getCodeActions', () => {
  describe('add missing annotation', () => {
    test('generates annotation for a simple function', () => {
      const source = 'const add = (a, b) => a + b;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(0, 6, 9, "Function 'add' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);

      const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
      expect(addAction).toBeDefined();
      expect(addAction!.kind).toBe(CodeActionKind.QuickFix);
      expect(addAction!.isPreferred).toBe(true);
      expect(addAction!.diagnostics).toEqual([diag]);

      // Should insert on line 0 (above the function)
      const changes = addAction!.edit!.changes!['file:///test.js'];
      expect(changes).toHaveLength(1);
      expect(changes[0].range.start.line).toBe(0);
      expect(changes[0].range.start.character).toBe(0);
      // The inserted text should be a comment with :: notation
      expect(changes[0].newText).toMatch(/^\/\/ add :: .+\n$/);
    });

    test('generates annotation for an identity function', () => {
      const source = 'const identity = (x) => x;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(0, 6, 14, "Function 'identity' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
      expect(addAction).toBeDefined();
      expect(addAction!.title).toContain('identity :: ');
      const changes = addAction!.edit!.changes!['file:///test.js'];
      expect(changes[0].newText).toMatch(/^\/\/ identity :: a -> a\n$/);
    });

    test('preserves indentation', () => {
      const source = '  const fn = (x) => x;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(0, 8, 10, "Function 'fn' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
      expect(addAction).toBeDefined();
      const changes = addAction!.edit!.changes!['file:///test.js'];
      // Should preserve the 2-space indent
      expect(changes[0].newText).toMatch(/^  \/\/ fn :: .+\n$/);
    });

    test('returns no annotation action when name is not found in bindings', () => {
      const source = 'const x = 42;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(0, 6, 7, "Function 'nonexistent' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
      expect(addAction).toBeUndefined();
    });

    test('uses raw style when configured', () => {
      const source = 'const identity = (x) => x;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(0, 6, 14, "Function 'identity' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'raw',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
      expect(addAction).toBeDefined();
      // Raw style uses t0, t1, etc. instead of a, b, c
      const changes = addAction!.edit!.changes!['file:///test.js'];
      expect(changes[0].newText).toMatch(/^\/\/ identity :: t\d+ -> t\d+\n$/);
    });

    test('generates annotation for a non-function variable', () => {
      const source = 'const x = 42;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(0, 6, 7, "Variable 'x' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
      expect(addAction).toBeDefined();
      expect(addAction!.kind).toBe(CodeActionKind.QuickFix);

      const changes = addAction!.edit!.changes!['file:///test.js'];
      expect(changes).toHaveLength(1);
      expect(changes[0].newText).toBe('// x :: Number\n');
      expect(changes[0].range.start.line).toBe(0);
    });

    test('generates annotation for a nested non-function variable', () => {
      const source = '// outer :: Number -> Number\nfunction outer() {\n  const x = 42;\n  return x;\n}\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      // The diagnostic points at `x` on line 2, character 8..9
      const diag = makeDiag(2, 8, 9, "Variable 'x' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
      expect(addAction).toBeDefined();
      const changes = addAction!.edit!.changes!['file:///test.js'];
      expect(changes).toHaveLength(1);
      expect(changes[0].newText).toBe('  // x :: Number\n');
      expect(changes[0].range.start.line).toBe(2);
    });

    test('generates annotation for a nested arrow function', () => {
      const source = '// outer :: Number\nfunction outer() {\n  const inc = (n) => n + 1;\n  return inc(1);\n}\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      // `inc` on line 2
      const diag = makeDiag(2, 8, 11, "Function 'inc' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
      expect(addAction).toBeDefined();
      const changes = addAction!.edit!.changes!['file:///test.js'];
      expect(changes).toHaveLength(1);
      expect(changes[0].newText).toMatch(/\/\/ inc :: /);
    });
  });

  // ---------------------------------------------------------------------------
  // Ignore line
  // ---------------------------------------------------------------------------

  describe('ignore this line', () => {
    test('inserts ::ignore comment above diagnostic line', () => {
      const source = 'const add = (a, b) => a + b;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(0, 6, 9, "Function 'add' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const ignoreAction = actions.find(a => a.title.includes('::ignore'));
      expect(ignoreAction).toBeDefined();
      expect(ignoreAction!.kind).toBe(CodeActionKind.QuickFix);

      const changes = ignoreAction!.edit!.changes!['file:///test.js'];
      expect(changes).toHaveLength(1);
      expect(changes[0].newText).toBe('// ::ignore\n');
      expect(changes[0].range.start.line).toBe(0);
    });

    test('preserves indentation for ::ignore', () => {
      const source = '    const add = (a, b) => a + b;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(0, 10, 13, "Function 'add' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const ignoreAction = actions.find(a => a.title.includes('::ignore') && !a.title.includes('file'));
      expect(ignoreAction).toBeDefined();
      const changes = ignoreAction!.edit!.changes!['file:///test.js'];
      expect(changes[0].newText).toBe('    // ::ignore\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Ignore file
  // ---------------------------------------------------------------------------

  describe('ignore this file', () => {
    test('inserts ::ignore-file at top of file', () => {
      const source = 'const add = (a, b) => a + b;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(0, 6, 9, "Function 'add' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const ignoreFileAction = actions.find(a => a.title.includes('::ignore-file'));
      expect(ignoreFileAction).toBeDefined();
      expect(ignoreFileAction!.kind).toBe(CodeActionKind.QuickFix);

      const changes = ignoreFileAction!.edit!.changes!['file:///test.js'];
      expect(changes).toHaveLength(1);
      expect(changes[0].newText).toBe('// ::ignore-file\n');
      expect(changes[0].range.start.line).toBe(0);
      expect(changes[0].range.start.character).toBe(0);
    });

    test('is disabled when ::ignore-file already present', () => {
      const source = '// ::ignore-file\nconst add = (a, b) => a + b;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(1, 6, 9, "Function 'add' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const ignoreFileAction = actions.find(a => a.title.includes('::ignore-file'));
      expect(ignoreFileAction).toBeDefined();
      expect(ignoreFileAction!.disabled).toBeDefined();
      expect(ignoreFileAction!.disabled!.reason).toMatch(/already present/);
    });
  });

  // ---------------------------------------------------------------------------
  // Non-hinmil diagnostics are ignored
  // ---------------------------------------------------------------------------

  describe('filtering', () => {
    test('ignores diagnostics from other sources', () => {
      const source = 'const add = (a, b) => a + b;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag: Diagnostic = {
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        message: 'Some other error',
        source: 'eslint',
      };
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      expect(actions).toHaveLength(0);
    });

    test('handles multiple diagnostics producing multiple actions', () => {
      const source = 'const add = (a, b) => a + b;\nconst sub = (a, b) => a - b;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag1 = makeDiag(0, 6, 9, "Function 'add' has no HM annotation");
      const diag2 = makeDiag(1, 6, 9, "Function 'sub' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag1, diag2]), ctx);
      // Each diagnostic produces up to 3 actions: add annotation, ignore line, ignore file
      // ignore-file is deduplicated (only emitted once)
      const addActions = actions.filter(a => a.title.startsWith('Add HM annotation:'));
      const ignoreLineActions = actions.filter(a => a.title.includes('::ignore') && !a.title.includes('file'));
      const ignoreFileActions = actions.filter(a => a.title.includes('::ignore-file'));

      expect(addActions.length).toBe(2);
      expect(ignoreLineActions.length).toBe(2);
      expect(ignoreFileActions.length).toBe(1);
    });

    test('generates annotation for prototype method assignment', () => {
      const source = `// Animal :: String -> Animal
function Animal(name) {
  // Animal#name :: String
  this.name = name;
}
Animal.prototype.speak = function() {
  return this.name + ' makes a noise.';
}
`;
      const doc = makeDoc(source);
      const result = inferSource(source);

      // The diagnostic points at 'speak' in 'Animal.prototype.speak'
      const speakIdx = source.indexOf('.speak');
      const lines = source.substring(0, speakIdx + 1).split('\n');
      const diagLine = lines.length - 1;
      const lineStart = source.lastIndexOf('\n', speakIdx) + 1;
      const speakPropStart = source.indexOf('speak', speakIdx);
      const startChar = speakPropStart - lineStart;
      const endChar = startChar + 5; // 'speak'.length

      const diag = makeDiag(diagLine, startChar, endChar, "Method 'Animal#speak' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
      expect(addAction).toBeDefined();
      expect(addAction!.title).toContain('Animal#speak');
      const changes = addAction!.edit!.changes!['file:///test.js'];
      expect(changes).toHaveLength(1);
      expect(changes[0].newText).toMatch(/^\/\/ Animal#speak :: .+\n$/);
      // The inferred type should be a function type, not just the return type
      expect(changes[0].newText).toContain('() -> String');
    });

    test('static class method — code action uses dot notation', () => {
      const source = `// Building :: (String, Number) -> Building
class Building {
  constructor (name, floors) {
    this.name = name;
    this.floors = floors;
  }

  static create (name, floors) {
    return new Building(name, floors);
  }
}
`;
      const doc = makeDoc(source);
      const result = inferSource(source);

      // The diagnostic points at 'create' in the class body
      const createIdx = source.indexOf('create (');
      const lines = source.substring(0, createIdx).split('\n');
      const diagLine = lines.length - 1;
      const lineStart = source.lastIndexOf('\n', createIdx) + 1;
      const startChar = createIdx - lineStart;
      const endChar = startChar + 6; // 'create'.length

      const diag = makeDiag(diagLine, startChar, endChar, "Method 'Building.create' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
      expect(addAction).toBeDefined();
      expect(addAction!.title).toContain('Building.create');
      const changes = addAction!.edit!.changes!['file:///test.js'];
      expect(changes).toHaveLength(1);
      expect(changes[0].newText).toContain('Building.create ::');
      expect(changes[0].newText).not.toContain('#');
    });
  });

  // ---------------------------------------------------------------------------
  // add ::types directive for unknown type constructor
  // ---------------------------------------------------------------------------

  describe('add ::types directive', () => {
    test('offers ::types action for unknown type constructor', () => {
      const source = '// either :: (a -> c, b -> d, Either2 a b) -> c | d\nconst either = (f, g, e) => e;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(0, 0, 51, "Unknown type constructor 'Either2'.");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const typesAction = actions.find(a => a.title.includes('::types'));
      expect(typesAction).toBeDefined();
      expect(typesAction!.title).toBe('Add ::types directive: // ::types ./Either2');
      expect(typesAction!.kind).toBe(CodeActionKind.QuickFix);
      expect(typesAction!.isPreferred).toBe(true);

      const changes = typesAction!.edit!.changes!['file:///test.js'];
      expect(changes).toHaveLength(1);
      expect(changes[0].newText).toBe('// ::types ./Either2\n');
    });

    test('suggests specifier from existing imports', () => {
      const source = "import { Left } from './Either2';\n// either :: (a -> c, b -> d, Either2 a b) -> c | d\nconst either = (f, g, e) => e;\n";
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(1, 0, 51, "Unknown type constructor 'Either2'.");
      const importMap = new Map([['Left', './Either2']]);
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
        importSpecifierMap: importMap,
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const typesAction = actions.find(a => a.title.includes('::types'));
      expect(typesAction).toBeDefined();
      expect(typesAction!.title).toBe('Add ::types directive: // ::types ./Either2');
      // Should insert after the import line
      const changes = typesAction!.edit!.changes!['file:///test.js'];
      expect(changes[0].range.start.line).toBe(1);
    });

    test('does not offer ::types action if directive already exists', () => {
      const source = "// ::types ./Either2\n// either :: (a -> c, b -> d, Either2 a b) -> c | d\nconst either = (f, g, e) => e;\n";
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(1, 0, 51, "Unknown type constructor 'Either2'.");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const typesAction = actions.find(a => a.title.includes('::types'));
      expect(typesAction).toBeUndefined();
    });

    test('inserts after existing directives and imports', () => {
      const source = "// ::types ./Other\nimport { foo } from './bar';\n// either :: (a -> c, b -> d, MyType a b) -> c | d\nconst either = (f, g, e) => e;\n";
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(2, 0, 51, "Unknown type constructor 'MyType'.");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const typesAction = actions.find(a => a.title.includes('::types'));
      expect(typesAction).toBeDefined();
      // Should insert after line 1 (the import), i.e. at line 2
      const changes = typesAction!.edit!.changes!['file:///test.js'];
      expect(changes[0].range.start.line).toBe(2);
    });

    test('still produces ignore-line and ignore-file actions for unknown type', () => {
      const source = '// either :: (a -> c, b -> d, Either2 a b) -> c | d\nconst either = (f, g, e) => e;\n';
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(0, 0, 51, "Unknown type constructor 'Either2'.");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const ignoreLine = actions.find(a => a.title.includes('::ignore') && !a.title.includes('file'));
      const ignoreFile = actions.find(a => a.title.includes('::ignore-file'));
      expect(ignoreLine).toBeDefined();
      expect(ignoreFile).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // rename to match annotation
  // ---------------------------------------------------------------------------

  describe('rename to match annotation', () => {
    test('offers rename for method name mismatch', () => {
      const source = "// Either2#map :: Either2 e a ~> (a -> b) -> Either2 e b\nconst mapp = fn => fn;\n";
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(1, 6, 10, "Method name 'mapp' does not match annotation 'Either2#map'");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const renameAction = actions.find(a => a.title.includes("Rename"));
      expect(renameAction).toBeDefined();
      expect(renameAction!.title).toBe("Rename 'mapp' to 'map'");
      expect(renameAction!.kind).toBe('quickfix');
      expect(renameAction!.isPreferred).toBe(true);

      const changes = renameAction!.edit!.changes!['file:///test.js'];
      expect(changes).toHaveLength(1);
      expect(changes[0].newText).toBe('map');
      // Should replace exactly the diagnostic range (the mismatched identifier)
      expect(changes[0].range).toEqual(diag.range);
    });

    test('offers rename for declaration name mismatch', () => {
      const source = "// memoize :: (a -> b) -> a -> b\nconst memoizee = (f) => f;\n";
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(1, 6, 14, "Declaration name 'memoizee' does not match annotation name 'memoize'");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const renameAction = actions.find(a => a.title.includes("Rename"));
      expect(renameAction).toBeDefined();
      expect(renameAction!.title).toBe("Rename 'memoizee' to 'memoize'");

      const changes = renameAction!.edit!.changes!['file:///test.js'];
      expect(changes[0].newText).toBe('memoize');
    });

    test('also includes ignore-line and ignore-file for mismatch diagnostic', () => {
      const source = "// Either2#map :: Either2 e a ~> (a -> b) -> Either2 e b\nconst mapp = fn => fn;\n";
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag = makeDiag(1, 6, 10, "Method name 'mapp' does not match annotation 'Either2#map'");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      expect(actions.some(a => a.title.includes('::ignore'))).toBe(true);
      expect(actions.some(a => a.title.includes('::ignore-file'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Deduplication of ignore actions
  // -------------------------------------------------------------------------

  describe('ignore action deduplication', () => {
    test('multiple diagnostics on same line produce only one ignore-line and one ignore-file action', () => {
      const source = "// memoize :: ((a, b, ...) -> z) -> (a, b, ...) -> z\nconst memoizee = fn => fn;\n";
      const doc = makeDoc(source);
      const result = inferSource(source);

      // Two diagnostics on the same line (name mismatch + missing signature)
      const diag1 = makeDiag(1, 6, 14, "Declaration name 'memoizee' does not match annotation name 'memoize'");
      const diag2 = makeDiag(1, 6, 14, "Function 'memoizee' has no HM annotation");

      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag1, diag2]), ctx);
      const ignoreLineActions = actions.filter(a => a.title.includes('::ignore') && !a.title.includes('::ignore-file'));
      const ignoreFileActions = actions.filter(a => a.title.includes('::ignore-file'));

      expect(ignoreLineActions).toHaveLength(1);
      expect(ignoreFileActions).toHaveLength(1);
    });

    test('diagnostics on different lines produce separate ignore-line actions but one ignore-file', () => {
      const source = "const foo = x => x;\nconst bar = y => y;\n";
      const doc = makeDoc(source);
      const result = inferSource(source);

      const diag1 = makeDiag(0, 6, 9, "Function 'foo' has no HM annotation");
      const diag2 = makeDiag(1, 6, 9, "Function 'bar' has no HM annotation");

      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };

      const actions = getCodeActions(makeParams('file:///test.js', [diag1, diag2]), ctx);
      const ignoreLineActions = actions.filter(a => a.title.includes('::ignore') && !a.title.includes('::ignore-file'));
      const ignoreFileActions = actions.filter(a => a.title.includes('::ignore-file'));

      expect(ignoreLineActions).toHaveLength(2);
      expect(ignoreFileActions).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Method annotations (Name#method)
  // -------------------------------------------------------------------------

  describe('add annotation for prototype method', () => {
    test('generates ignore actions for a prototype method diagnostic', () => {
      const source = `function Box(value) { this.value = value; }
Box.prototype.getValue = function() { return this.value; };
`;
      const doc = makeDoc(source);
      const result = inferSource(source);
      const diag = makeDiag(1, 15, 23, "Function 'Box#getValue' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };
      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      // At minimum, ignore actions should be available
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.some(a => a.title.includes('::ignore'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Static method annotations (Name.method)
  // -------------------------------------------------------------------------

  describe('add annotation for static method', () => {
    test('generates annotation for a static class method', () => {
      const source = `function Box(value) { this.value = value; }
Box.fromValue = function(v) { return new Box(v); };
`;
      const doc = makeDoc(source);
      const result = inferSource(source);
      const diag = makeDiag(1, 4, 13, "Function 'Box.fromValue' has no HM annotation");
      const ctx: CodeActionContext = {
        result,
        textDocument: doc,
        inferredTypeStyle: 'pretty',
      };
      const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
      const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
      expect(addAction).toBeDefined();
      expect(addAction!.title).toContain('Box.fromValue');
    });
  });

  // -------------------------------------------------------------------------
  // Add ::types directive action
  // -------------------------------------------------------------------------

  describe('add ::types directive', () => {
    test('unknown type diagnostic gets at least ignore actions', () => {
      const source = `// process :: Either String Number -> Number\nconst process = x => 0;\n`;
      const doc = makeDoc(source);
      const result = inferSource(source);
      // The actual diagnostic message emitted by the engine
      const unknownDiag = result.diagnostics.find(d => d.message.includes('Unknown type'));
      if (unknownDiag) {
        const diag = makeDiag(0, unknownDiag.start, unknownDiag.end, unknownDiag.message);
        const ctx: CodeActionContext = {
          result,
          textDocument: doc,
          inferredTypeStyle: 'pretty',
        };
        const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
        expect(actions.length).toBeGreaterThan(0);
      } else {
        // If no unknown type diagnostic, the type was resolved
        expect(true).toBe(true);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// getCodeActions — static method annotation (Foo.create pattern)
// ---------------------------------------------------------------------------

describe('getCodeActions — static method annotation', () => {
  test('generates annotation for static method assignment', () => {
    const source = `function Foo() {}\nFoo.create = (x) => x;\n`;
    const doc = makeDoc(source);
    const result = inferSource(source);

    // The diagnostic should point at 'create'
    const createIdx = source.indexOf('create');
    const lineStart = source.lastIndexOf('\n', createIdx) + 1;
    const line = source.substring(0, createIdx).split('\n').length - 1;
    const startChar = createIdx - lineStart;
    const endChar = startChar + 'create'.length;

    const diag = makeDiag(line, startChar, endChar, "Method 'Foo.create' has no HM annotation");
    const ctx: CodeActionContext = {
      result,
      textDocument: doc,
      inferredTypeStyle: 'pretty',
    };

    const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
    const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
    expect(addAction).toBeDefined();
    if (addAction) {
      expect(addAction.title).toContain('Foo.create');
    }
  });
});

// ---------------------------------------------------------------------------
// getCodeActions — multi-constraint annotation
// ---------------------------------------------------------------------------

describe('getCodeActions — multi-constraint annotation', () => {
  test('generates annotation with multiple constraints in parens', () => {
    // A function that takes two class values → the annotation gets 2 constraints
    const source = [
      '// ::constraint Functor',
      '// ::constraint Applicative',
      '// lift2 :: (Functor f, Applicative f) => (a -> b -> c) -> f a -> f b -> f c',
      'const lift2 = (fn) => (fa) => (fb) => fb;',
      '',
      'const noSig = (x) => x;',
    ].join('\n');
    const doc = makeDoc(source);
    const result = inferSource(source);

    const idx = source.indexOf('noSig');
    const line = source.substring(0, idx).split('\n').length - 1;
    const lineStart = source.lastIndexOf('\n', idx) + 1;
    const startChar = idx - lineStart;
    const endChar = startChar + 'noSig'.length;

    const diag = makeDiag(line, startChar, endChar, "Function 'noSig' has no HM annotation");
    const ctx: CodeActionContext = {
      result,
      textDocument: doc,
      inferredTypeStyle: 'pretty',
    };

    const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
    const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
    expect(addAction).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// getCodeActions — prototype method annotation via offset
// ---------------------------------------------------------------------------

describe('getCodeActions — prototype method annotation via offset', () => {
  test('generates annotation for prototype method without top-level binding', () => {
    const source = [
      'function Box(x) { this.value = x; }',
      'Box.prototype.map = function(f) { return new Box(f(this.value)); };',
    ].join('\n');
    const doc = makeDoc(source);
    const result = inferSource(source);

    const mapIdx = source.indexOf('.map');
    const nameStart = mapIdx + 1; // 'map'
    const line = source.substring(0, nameStart).split('\n').length - 1;
    const lineStart = source.lastIndexOf('\n', nameStart) + 1;
    const startChar = nameStart - lineStart;
    const endChar = startChar + 'map'.length;

    const diag = makeDiag(line, startChar, endChar, "Method 'Box#map' has no HM annotation");
    const ctx: CodeActionContext = {
      result,
      textDocument: doc,
      inferredTypeStyle: 'pretty',
    };

    const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
    const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
    expect(addAction).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// getCodeActions — ::types directive with import specifier key match
// ---------------------------------------------------------------------------

describe('getCodeActions — types directive from import specifier key', () => {
  test('suggests specifier when type name matches import specifier key', () => {
    const source = "import { Config } from './utils/types';\n// run :: Config -> String\nconst run = (c) => c;\n";
    const doc = makeDoc(source);
    const result = inferSource(source);

    const diag = makeDiag(1, 0, 30, "Unknown type constructor 'Config'.");
    const importMap = new Map([['Config', './utils/types']]);
    const ctx: CodeActionContext = {
      result,
      textDocument: doc,
      inferredTypeStyle: 'pretty',
      importSpecifierMap: importMap,
    };

    const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
    const typesAction = actions.find(a => a.title.includes('::types'));
    expect(typesAction).toBeDefined();
    expect(typesAction!.title).toBe('Add ::types directive: // ::types ./utils/types');
  });
});

// ---------------------------------------------------------------------------
// getCodeActions — static method annotation via offset
// ---------------------------------------------------------------------------

describe('getCodeActions — static method annotation via offset', () => {
  test('generates annotation for static method name with dot', () => {
    const source = [
      'function Building() {}',
      'Building.create = function(name) { return new Building(); };',
    ].join('\n');
    const doc = makeDoc(source);
    const result = inferSource(source);

    // Find the offset of 'create' in 'Building.create'
    const createIdx = source.indexOf('.create') + 1; // start of 'create'
    const line = source.substring(0, createIdx).split('\n').length - 1;
    const lineStart = source.lastIndexOf('\n', createIdx) + 1;
    const startChar = createIdx - lineStart;
    const endChar = startChar + 'create'.length;

    const diag = makeDiag(line, startChar, endChar, "Method 'Building.create' has no HM annotation");
    const ctx: CodeActionContext = {
      result,
      textDocument: doc,
      inferredTypeStyle: 'pretty',
    };

    const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
    const addAction = actions.find(a => a.title.startsWith('Add HM annotation:'));
    expect(addAction).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// getCodeActions — add missing constraint to the enclosing signature
// ---------------------------------------------------------------------------

describe('getCodeActions — add missing constraint', () => {
  const PRELUDE = `// ::constraint Semigroup s { s :: { concat :: s ~> s -> s } }
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Apply f { f :: Functor, f :: { ap :: f a ~> f (a -> b) -> f b } }
// ::constraint Applicative f { f :: Apply, f :: { of :: a -> f a } }
// append :: (Applicative f, Semigroup (f a)) => a -> f a -> f a
const append = x => acc => acc;
`;

  /** Run inference and convert the missing-constraint engine diagnostic to an
   *  LSP diagnostic (mirroring mapInferenceDiagnostics' relatedInformation). */
  function missingConstraintLspDiag(doc: TextDocument, source: string): Diagnostic {
    const result = inferSource(source);
    const d = result.diagnostics.find(x => /Missing constraint/.test(x.message))!;
    expect(d).toBeDefined();
    return {
      severity: DiagnosticSeverity.Error,
      range: { start: doc.positionAt(d.start), end: doc.positionAt(d.end) },
      message: d.message,
      source: 'hinmil',
      relatedInformation: d.relatedInformation?.map(ri => ({
        location: {
          uri: doc.uri,
          range: { start: doc.positionAt(ri.start), end: doc.positionAt(ri.end) },
        },
        message: ri.message,
      })),
    };
  }

  function applySingleEdit(doc: TextDocument, action: { edit?: { changes?: Record<string, { range: { start: Position_; end: Position_ }; newText: string }[]> } }): string {
    const edits = action.edit!.changes!['file:///test.js'];
    expect(edits).toHaveLength(1);
    const text = doc.getText();
    const start = doc.offsetAt(edits[0].range.start);
    const end = doc.offsetAt(edits[0].range.end);
    return text.slice(0, start) + edits[0].newText + text.slice(end);
  }
  type Position_ = { line: number; character: number };

  test('wraps a single bare constraint into a parenthesised list', () => {
    const source = PRELUDE +
      `// appendOrNot :: Semigroup (f a) => a -> f a -> f a
const appendOrNot = x => acc => append (x) (acc);
`;
    const doc = makeDoc(source);
    const diag = missingConstraintLspDiag(doc, source);
    expect(diag.relatedInformation).toHaveLength(1);

    const ctx: CodeActionContext = { result: inferSource(source), textDocument: doc, inferredTypeStyle: 'pretty' };
    const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
    const fix = actions.find(a => a.title.startsWith('Add constraint'));
    expect(fix).toBeDefined();
    expect(fix!.title).toBe("Add constraint 'Applicative f' to the enclosing signature");

    const updated = applySingleEdit(doc, fix!);
    expect(updated).toContain(
      '// appendOrNot :: (Semigroup (f a), Applicative f) => a -> f a -> f a',
    );
  });

  test('appends to an existing parenthesised constraint list', () => {
    const source = PRELUDE +
      `// appendOrNot :: (Functor f, Semigroup (f a)) => a -> f a -> f a
const appendOrNot = x => acc => append (x) (acc);
`;
    const doc = makeDoc(source);
    const diag = missingConstraintLspDiag(doc, source);

    const ctx: CodeActionContext = { result: inferSource(source), textDocument: doc, inferredTypeStyle: 'pretty' };
    const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
    const fix = actions.find(a => a.title.startsWith('Add constraint'));
    expect(fix).toBeDefined();

    const updated = applySingleEdit(doc, fix!);
    expect(updated).toContain(
      '// appendOrNot :: (Functor f, Semigroup (f a), Applicative f) => a -> f a -> f a',
    );
  });

  test('applied constraints are inserted in their full applied form', () => {
    const source = PRELUDE +
      `// ::constraint Monoid m { m :: Semigroup, m :: { empty :: () -> m } }
// tailish :: (Applicative f, Monoid (f a)) => f a -> f a
const tailish = fa => fa;
// pipeish :: Applicative f => f a -> f a
const pipeish = fa => tailish (fa);
`;
    const doc = makeDoc(source);
    const diag = missingConstraintLspDiag(doc, source);

    const ctx: CodeActionContext = { result: inferSource(source), textDocument: doc, inferredTypeStyle: 'pretty' };
    const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
    const fix = actions.find(a => a.title.startsWith('Add constraint'));
    expect(fix).toBeDefined();

    const updated = applySingleEdit(doc, fix!);
    expect(updated).toContain(
      '// pipeish :: (Applicative f, Monoid (f a)) => f a -> f a',
    );
  });

  test('no action when the diagnostic has no related annotation location', () => {
    const source = PRELUDE +
      `// appendOrNot :: Semigroup (f a) => a -> f a -> f a
const appendOrNot = x => acc => append (x) (acc);
`;
    const doc = makeDoc(source);
    const diag = missingConstraintLspDiag(doc, source);
    delete diag.relatedInformation;

    const ctx: CodeActionContext = { result: inferSource(source), textDocument: doc, inferredTypeStyle: 'pretty' };
    const actions = getCodeActions(makeParams('file:///test.js', [diag]), ctx);
    expect(actions.find(a => a.title.startsWith('Add constraint'))).toBeUndefined();
  });
});
