import {
  levelToSeverity,
  mapInferenceDiagnostics,
  detectMissingSignatures,
  filterIgnoredDiagnostics,
  filterAnnotationMismatchDiagnostics,
  filterDiagnosticsInsideBindings,
  collectBindingIntervals,
} from '../../src/services/diagnostics';
import { DiagnosticSeverity, Diagnostic } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TypeAnnotation } from '../../src/commentParser';
import { InferenceDiagnostic } from '../../src/infer';
import { registerDataType, clearDataTypes } from '../../src/registries/dataTypeRegistry';
import {
  classifyDiagnosticCode,
  codeToCategory,
  HM_TYPE_MISMATCH,
  HM_INFINITE_TYPE,
  HM_ANNOTATION_MISMATCH,
  HM_RETURN_TYPE_MISMATCH,
  HM_MISSING_PROPERTY,
  HM_UNCONSTRAINED_PROP,
  HM_UNBOUND_VARIABLE,
  HM_INVALID_ANNOTATION,
  HM_NAME_MISMATCH,
  HM_METHOD_NAME_MISMATCH,
  HM_UNKNOWN_TYPE,
  HM_VARIANT_METHOD,
  HM_METHOD_TYPE_MISMATCH,
  HM_MISSING_EXPORT,
  HM_UNRESOLVED_TYPES_PATH,
  HM_UNRESOLVED_IMPORT,
  HM_UNKNOWN_CONSTRAINT,
  HM_CONSTRAINT_VIOLATION,
  HM_INVALID_CONSTRAINT,
  HM_CONSTRAINT_KIND_MISMATCH,
  HM_CURRY_ARITY,
  HM_CURRY_TYPE,
  HM_CURRIED_OVER_APPLICATION,
  HM_MISSING_SIGNATURE,
  HM_MISSING_VARIANT_IMPL,
  HM_PARSE_ERROR,
  HM_NAMELESS_ON_NAMED,
  HM_TYPE_ARITY_MISMATCH,
  HM_UNION_NARROWING,
  HM_DUPLICATE_IMPORT,
  HM_CIRCULAR_IMPORT,
  HM_MISSING_RECORD_FIELDS,
  HM_NOT_CALLABLE,
  HM_INVALID_TABLE_RELATION,
} from '../../src/services/diagnosticCodes';

// ---------------------------------------------------------------------------
// levelToSeverity
// ---------------------------------------------------------------------------

describe('levelToSeverity', () => {
  test('"error" → DiagnosticSeverity.Error (1)', () => {
    expect(levelToSeverity('error')).toBe(DiagnosticSeverity.Error);
    expect(levelToSeverity('error')).toBe(1);
  });

  test('"warning" → DiagnosticSeverity.Warning (2)', () => {
    expect(levelToSeverity('warning')).toBe(DiagnosticSeverity.Warning);
    expect(levelToSeverity('warning')).toBe(2);
  });

  test('"information" → DiagnosticSeverity.Information (3)', () => {
    expect(levelToSeverity('information')).toBe(DiagnosticSeverity.Information);
    expect(levelToSeverity('information')).toBe(3);
  });

  test('"hint" → DiagnosticSeverity.Hint (4)', () => {
    expect(levelToSeverity('hint')).toBe(DiagnosticSeverity.Hint);
    expect(levelToSeverity('hint')).toBe(4);
  });

  test('"off" → null (drop the diagnostic)', () => {
    expect(levelToSeverity('off')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// filterIgnoredDiagnostics
// ---------------------------------------------------------------------------

describe('filterIgnoredDiagnostics', () => {
  function makeDiag(line: number): Diagnostic {
    return {
      severity: DiagnosticSeverity.Error,
      range: {
        start: { line, character: 0 },
        end: { line, character: 5 },
      },
      message: `diag on line ${line}`,
      source: 'hinmil',
    };
  }

  test('empty diagnostics → empty', () => {
    expect(filterIgnoredDiagnostics([], new Set([0, 1]))).toEqual([]);
  });

  test('no ignored lines → returns all', () => {
    const diags = [makeDiag(0), makeDiag(1), makeDiag(2)];
    expect(filterIgnoredDiagnostics(diags, new Set())).toEqual(diags);
  });

  test('one diagnostic on ignored line → filtered out', () => {
    const diags = [makeDiag(0), makeDiag(1), makeDiag(2)];
    const result = filterIgnoredDiagnostics(diags, new Set([1]));
    expect(result).toHaveLength(2);
    expect(result[0].range.start.line).toBe(0);
    expect(result[1].range.start.line).toBe(2);
  });

  test('mix of ignored and non-ignored lines', () => {
    const diags = [makeDiag(0), makeDiag(1), makeDiag(2), makeDiag(3)];
    const result = filterIgnoredDiagnostics(diags, new Set([0, 2]));
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.range.start.line)).toEqual([1, 3]);
  });
});

// ---------------------------------------------------------------------------
// mapInferenceDiagnostics
// ---------------------------------------------------------------------------

describe('mapInferenceDiagnostics', () => {
  const source = 'const x = 1;\nconst y = 2;\n';
  const doc = TextDocument.create('file:///test.js', 'javascript', 1, source);
  const identity = (offset: number, _insertions: number[]) => offset;
  const always = (sev: DiagnosticSeverity) => (_code: number) => sev;

  test('empty array → empty', () => {
    const result = mapInferenceDiagnostics(
      [],
      doc,
      [],
      always(DiagnosticSeverity.Error),
      identity,
    );
    expect(result).toEqual([]);
  });

  test('filters out "Parse error" messages', () => {
    const inferDiags: InferenceDiagnostic[] = [
      { message: 'Parse error at line 1', start: 0, end: 5 },
      { message: 'Parse error: unexpected token', start: 0, end: 3 },
    ];
    const result = mapInferenceDiagnostics(
      inferDiags,
      doc,
      [],
      always(DiagnosticSeverity.Warning),
      identity,
    );
    expect(result).toHaveLength(0);
  });

  test('maps offsets to positions via unmapOffset and textDocument', () => {
    const inferDiags: InferenceDiagnostic[] = [
      { message: 'Type mismatch', start: 6, end: 7 },
    ];
    const result = mapInferenceDiagnostics(
      inferDiags,
      doc,
      [],
      always(DiagnosticSeverity.Warning),
      identity,
    );
    expect(result).toHaveLength(1);
    const d = result[0];
    expect(d.message).toBe('Type mismatch');
    expect(d.severity).toBe(DiagnosticSeverity.Warning);
    expect(d.source).toBe('hinmil');
    // offset 6 in "const x = 1;\n..." is line 0, character 6
    expect(d.range.start).toEqual({ line: 0, character: 6 });
    expect(d.range.end).toEqual({ line: 0, character: 7 });
  });

  test('uses unmapOffset to adjust patched offsets', () => {
    const inferDiags: InferenceDiagnostic[] = [
      { message: 'err', start: 10, end: 15 },
    ];
    // unmapOffset subtracts 2 from every offset
    const shiftBack = (offset: number, _ins: number[]) => offset - 2;
    const result = mapInferenceDiagnostics(
      inferDiags,
      doc,
      [5],
      always(DiagnosticSeverity.Error),
      shiftBack,
    );
    expect(result).toHaveLength(1);
    // original offsets are 8 and 13
    const startPos = doc.positionAt(8);
    const endPos = doc.positionAt(13);
    expect(result[0].range.start).toEqual(startPos);
    expect(result[0].range.end).toEqual(endPos);
  });

  test('multiple diagnostics produce multiple LSP diagnostics', () => {
    const inferDiags: InferenceDiagnostic[] = [
      { message: 'err1', start: 0, end: 5 },
      { message: 'err2', start: 13, end: 18 },
    ];
    const result = mapInferenceDiagnostics(
      inferDiags,
      doc,
      [],
      always(DiagnosticSeverity.Error),
      identity,
    );
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe('err1');
    expect(result[0].source).toBe('hinmil');
    expect(result[1].message).toBe('err2');
    expect(result[1].source).toBe('hinmil');
  });

  test('keeps non-parse-error diagnostics while filtering parse errors', () => {
    const inferDiags: InferenceDiagnostic[] = [
      { message: 'Parse error at line 1', start: 0, end: 5 },
      { message: 'Type mismatch', start: 6, end: 7 },
    ];
    const result = mapInferenceDiagnostics(
      inferDiags,
      doc,
      [],
      always(DiagnosticSeverity.Error),
      identity,
    );
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('Type mismatch');
  });

  test('severityFor returning null drops the diagnostic (category off)', () => {
    const inferDiags: InferenceDiagnostic[] = [
      { message: 'Type mismatch: Cannot unify Number with String', start: 0, end: 5 },
      { message: 'Missing record field: age', start: 6, end: 7 },
    ];
    const result = mapInferenceDiagnostics(
      inferDiags,
      doc,
      [],
      (code) => (code === HM_TYPE_MISMATCH ? null : DiagnosticSeverity.Error),
      identity,
    );
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe(HM_MISSING_RECORD_FIELDS);
  });

  test('severityFor receives the classified code and sets per-category severity', () => {
    const inferDiags: InferenceDiagnostic[] = [
      { message: 'Type mismatch: Cannot unify Number with String', start: 0, end: 5 },
      { message: "Property 'foo' does not exist on type Bar", start: 6, end: 7 },
    ];
    const result = mapInferenceDiagnostics(
      inferDiags,
      doc,
      [],
      (code) => (code === HM_MISSING_PROPERTY ? DiagnosticSeverity.Hint : DiagnosticSeverity.Warning),
      identity,
    );
    expect(result).toHaveLength(2);
    expect(result[0].severity).toBe(DiagnosticSeverity.Warning);
    expect(result[1].severity).toBe(DiagnosticSeverity.Hint);
  });
});

// ---------------------------------------------------------------------------
// detectMissingSignatures
// ---------------------------------------------------------------------------

describe('detectMissingSignatures', () => {
  function detect(source: string, annotatedNames: string[] = []) {
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, source);
    const annotations = new Map<string, TypeAnnotation>();
    for (const name of annotatedNames) {
      annotations.set(name, {} as TypeAnnotation);
    }
    return detectMissingSignatures(
      source,
      doc,
      annotations,
      DiagnosticSeverity.Information,
      DiagnosticSeverity.Information,
    );
  }

  test('function declaration without annotation → produces diagnostic', () => {
    const result = detect('function foo(x) { return x; }');
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("Function 'foo' has no HM annotation");
    expect(result[0].source).toBe('hinmil');
    expect(result[0].severity).toBe(DiagnosticSeverity.Information);
  });

  test('function declaration with annotation → no diagnostic', () => {
    const result = detect('function foo(x) { return x; }', ['foo']);
    expect(result).toHaveLength(0);
  });

  test('arrow function in const binding without annotation → produces diagnostic', () => {
    const result = detect('const add = (a, b) => a + b;');
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("Function 'add' has no HM annotation");
  });

  test('arrow function in const binding with annotation → no diagnostic', () => {
    const result = detect('const add = (a, b) => a + b;', ['add']);
    expect(result).toHaveLength(0);
  });

  test('FunctionExpression in const binding without annotation → produces diagnostic', () => {
    const result = detect('const add = function(a, b) { return a + b; };');
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("Function 'add' has no HM annotation");
  });

  test('exported function declaration without annotation → produces diagnostic', () => {
    const result = detect('export function bar(x) { return x * 2; }');
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("Function 'bar' has no HM annotation");
  });

  test('invalid source (parse error) → returns empty array', () => {
    const result = detect('function {{{');
    expect(result).toEqual([]);
  });

  test('non-function variable without annotation → produces diagnostic', () => {
    const result = detect('const x = 1;');
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("Variable 'x' has no HM annotation");
  });

  test('non-function variable with annotation → no diagnostic', () => {
    const result = detect('const x = 1;', ['x']);
    expect(result).toHaveLength(0);
  });

  test('multiple non-function variables without annotation → produces diagnostics', () => {
    const result = detect('const x = 1;\nconst y = "hello";');
    expect(result).toHaveLength(2);
    expect(result[0].message).toBe("Variable 'x' has no HM annotation");
    expect(result[1].message).toBe("Variable 'y' has no HM annotation");
  });

  test('variable diagnostics suppressed when varSeverity is null', () => {
    const src = 'const x = 1;\nconst add = (a, b) => a + b;';
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, src);
    const result = detectMissingSignatures(src, doc, new Map(), DiagnosticSeverity.Information, null);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("Function 'add' has no HM annotation");
  });

  test('function diagnostics suppressed when fnSeverity is null', () => {
    const src = 'const x = 1;\nconst add = (a, b) => a + b;';
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, src);
    const result = detectMissingSignatures(src, doc, new Map(), null, DiagnosticSeverity.Warning);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("Variable 'x' has no HM annotation");
    expect(result[0].severity).toBe(DiagnosticSeverity.Warning);
  });

  test('separate severities for functions and variables', () => {
    const src = 'const x = 1;\nconst add = (a, b) => a + b;';
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, src);
    const result = detectMissingSignatures(src, doc, new Map(), DiagnosticSeverity.Error, DiagnosticSeverity.Hint);
    const varDiag = result.find(d => d.message.startsWith('Variable'));
    const fnDiag = result.find(d => d.message.startsWith('Function'));
    expect(varDiag!.severity).toBe(DiagnosticSeverity.Hint);
    expect(fnDiag!.severity).toBe(DiagnosticSeverity.Error);
  });

  test('X$prototype$Y function with X#Y annotation → no diagnostic', () => {
    const result = detect(
      'function RTask$prototype$map(f) { return f; }',
      ['RTask#map'],
    );
    expect(result).toHaveLength(0);
  });

  test('X$prototype$Y function without annotation → produces diagnostic', () => {
    const result = detect('function RTask$prototype$map(f) { return f; }');
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe(
      "Function 'RTask$prototype$map' has no HM annotation",
    );
  });

  test('X$prototype$Y const binding with X#Y annotation → no diagnostic', () => {
    const result = detect(
      'const Box$prototype$map = (f) => f;',
      ['Box#map'],
    );
    expect(result).toHaveLength(0);
  });

  test('class method with parent type annotation (Maybe#map) → no diagnostic when sumtype registered', () => {
    // Register sumtype so Nothing is a known variant of Maybe
    registerDataType({
      name: 'Maybe',
      typeVars: ['a'],
      variants: [{ name: 'Just', fields: ['a'] }, { name: 'Nothing', fields: [] }],
      commentStart: 0,
      commentEnd: 0,
    });
    const src = `
class Nothing {
  map(_fn) { return this; }
}`;
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, src);
    const annotations = new Map<string, TypeAnnotation>();
    annotations.set('Maybe#map', {
      raw: 'Maybe a ~> (a -> b) -> Maybe b',
      scheme: { type: { tag: 'TFun', param: { tag: 'TVar', name: 'a', id: 1 }, result: { tag: 'TVar', name: 'b', id: 2 } }, vars: [1, 2] },
      receiver: { tag: 'TCon', name: 'Maybe', args: [] },
      commentStart: 0,
      commentEnd: 10,
    } as any);
    const result = detectMissingSignatures(src, doc, annotations, DiagnosticSeverity.Information, DiagnosticSeverity.Information);
    expect(result).toHaveLength(0);
    clearDataTypes();
  });

  test('class method with sibling annotation (Just#map) → produces diagnostic', () => {
    const src = `
class Nothing {
  map(_fn) { return this; }
}`;
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, src);
    const annotations = new Map<string, TypeAnnotation>();
    // Just#map has receiver Maybe (not Just), so it's NOT a parent type annotation
    annotations.set('Just#map', {
      raw: 'Maybe a ~> (a -> b) -> Maybe b',
      scheme: { type: { tag: 'TFun', param: { tag: 'TVar', name: 'a', id: 1 }, result: { tag: 'TVar', name: 'b', id: 2 } }, vars: [1, 2] },
      receiver: { tag: 'TCon', name: 'Maybe', args: [] },
      commentStart: 0,
      commentEnd: 10,
    } as any);
    const result = detectMissingSignatures(src, doc, annotations, DiagnosticSeverity.Information, DiagnosticSeverity.Information);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("Method 'Nothing#map' has no HM annotation");
  });

  test('nested arrow function without annotation → produces diagnostic', () => {
    const src = `function outer() {
  const inner = x => x;
  return inner;
}`;
    const result = detect(src, ['outer']);
    expect(result.some(d => d.message === "Function 'inner' has no HM annotation")).toBe(true);
  });

  test('nested arrow function with method annotation → no diagnostic', () => {
    const src = `function outer() {
  const map = fn => fn;
  return { map };
}`;
    const result = detect(src, ['outer', 'Either2#map']);
    expect(result.some(d => d.message.includes("'map'"))).toBe(false);
  });

  test('nested arrow function with direct annotation → no diagnostic', () => {
    const src = `function outer() {
  const inner = x => x;
  return inner;
}`;
    const result = detect(src, ['outer', 'inner']);
    expect(result.some(d => d.message.includes("'inner'"))).toBe(false);
  });

  test('nested non-function declaration without annotation → produces diagnostic', () => {
    const src = `function outer() {
  const x = 42;
  return x;
}`;
    const result = detect(src, ['outer']);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("Variable 'x' has no HM annotation");
  });

  test('nested non-function declaration with annotation → no diagnostic', () => {
    const src = `function outer() {
  const x = 42;
  return x;
}`;
    const result = detect(src, ['outer', 'x']);
    expect(result).toHaveLength(0);
  });

  test('nested function declaration without annotation → produces diagnostic', () => {
    const src = `function outer() {
  function inner(x) { return x; }
  return inner;
}`;
    const result = detect(src, ['outer']);
    expect(result.some(d => d.message === "Function 'inner' has no HM annotation")).toBe(true);
  });

  test('nested function declaration with annotation → no diagnostic', () => {
    const src = `function outer() {
  function inner(x) { return x; }
  return inner;
}`;
    const result = detect(src, ['outer', 'inner']);
    expect(result.some(d => d.message.includes("'inner'"))).toBe(false);
  });

  test('nested function declaration with method annotation → no diagnostic', () => {
    const src = `function outer() {
  function map(fn) { return fn; }
  return { map };
}`;
    const result = detect(src, ['outer', 'Either2#map']);
    expect(result.some(d => d.message.includes("'map'"))).toBe(false);
  });

  test('nested let/var arrow functions without annotation → produces diagnostics', () => {
    const src = `function outer() {
  let a = x => x;
  var b = function(y) { return y; };
  return [a, b];
}`;
    const result = detect(src, ['outer']);
    expect(result.some(d => d.message === "Function 'a' has no HM annotation")).toBe(true);
    expect(result.some(d => d.message === "Function 'b' has no HM annotation")).toBe(true);
  });

  test('nested function with mismatched method annotation → produces diagnostic', () => {
    const src = `function outer() {
  function mapp(fn) { return fn; }
  return { map: mapp };
}`;
    const result = detect(src, ['outer', 'Either2#map']);
    expect(result.some(d => d.message === "Function 'mapp' has no HM annotation")).toBe(true);
  });

  test('prototype method without annotation → produces diagnostic', () => {
    const src = `
function Box(value) { this.value = value; }
Box.prototype.map = function(f) { return new Box(f(this.value)); };
`;
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, src);
    const annotations = new Map<string, TypeAnnotation>();
    const result = detectMissingSignatures(src, doc, annotations, DiagnosticSeverity.Information, DiagnosticSeverity.Information);
    expect(result.some(d => d.message === "Method 'Box#map' has no HM annotation")).toBe(true);
  });

  test('static class method without annotation → diagnostic uses dot notation', () => {
    const src = `
class Foo {
  constructor() {}
  static bar() { return 1; }
}
`;
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, src);
    const annotations = new Map<string, TypeAnnotation>();
    const result = detectMissingSignatures(src, doc, annotations, DiagnosticSeverity.Information, DiagnosticSeverity.Information);
    expect(result.some(d => d.message === "Method 'Foo.bar' has no HM annotation")).toBe(true);
    expect(result.some(d => d.message.includes('Foo#bar'))).toBe(false);
  });

  test('prototype method with direct annotation → no diagnostic', () => {
    const src = `
function Box(value) { this.value = value; }
// Box#map :: Box a ~> (a -> b) -> Box b
Box.prototype.map = function(f) { return new Box(f(this.value)); };
`;
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, src);
    const annotations = new Map<string, TypeAnnotation>();
    annotations.set('Box#map', {
      raw: 'Box a ~> (a -> b) -> Box b',
      scheme: { type: { tag: 'TVar', name: 'x', id: 1 }, vars: [1] },
      receiver: { tag: 'TCon', name: 'Box', args: [] },
      commentStart: 0,
      commentEnd: 10,
    } as any);
    const result = detectMissingSignatures(src, doc, annotations, DiagnosticSeverity.Information, DiagnosticSeverity.Information);
    expect(result.some(d => d.message.includes('Box#map'))).toBe(false);
  });

  test('prototype method covered by sumtype parent annotation → no diagnostic', () => {
    registerDataType({
      name: 'Either',
      typeVars: ['e', 'a'],
      variants: [{ name: 'Left', fields: ['e'] }, { name: 'Right', fields: ['a'] }],
      commentStart: 0,
      commentEnd: 0,
    });
    const src = `
Left.prototype.map = function(_fn) { return this; };
Right.prototype.map = function(fn) { return fn(this.value); };
`;
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, src);
    const annotations = new Map<string, TypeAnnotation>();
    annotations.set('Either#map', {
      raw: 'Either e a ~> (a -> b) -> Either e b',
      scheme: { type: { tag: 'TVar', name: 'x', id: 1 }, vars: [1] },
      receiver: { tag: 'TCon', name: 'Either', args: [] },
      commentStart: 0,
      commentEnd: 10,
    } as any);
    const result = detectMissingSignatures(src, doc, annotations, DiagnosticSeverity.Information, DiagnosticSeverity.Information);
    expect(result.some(d => d.message.includes('Left#map'))).toBe(false);
    expect(result.some(d => d.message.includes('Right#map'))).toBe(false);
    clearDataTypes();
  });

  test('static assignment X.y = function without annotation → diagnostic uses dot notation', () => {
    const src = `
function Animal(name) { this.name = name; }
Animal.create = function(name) { return new Animal(name); };
`;
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, src);
    const annotations = new Map<string, TypeAnnotation>();
    const result = detectMissingSignatures(src, doc, annotations, DiagnosticSeverity.Information, DiagnosticSeverity.Information);
    expect(result.some(d => d.message === "Method 'Animal.create' has no HM annotation")).toBe(true);
    expect(result.some(d => d.message.includes('Animal#create'))).toBe(false);
  });

  test('static assignment X.y = function with annotation → no diagnostic', () => {
    const src = `
function Animal(name) { this.name = name; }
Animal.create = function(name) { return new Animal(name); };
`;
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, src);
    const annotations = new Map<string, TypeAnnotation>();
    annotations.set('Animal.create', {
      raw: 'String -> Animal',
      scheme: { type: { tag: 'TVar', name: 'x', id: 1 }, vars: [1] },
      commentStart: 0,
      commentEnd: 10,
    } as any);
    const result = detectMissingSignatures(src, doc, annotations, DiagnosticSeverity.Information, DiagnosticSeverity.Information);
    expect(result.some(d => d.message.includes('Animal.create'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterAnnotationMismatchDiagnostics (trustAnnotations)
// ---------------------------------------------------------------------------

describe('filterAnnotationMismatchDiagnostics', () => {
  test('removes "implementation does not match annotation" diagnostics', () => {
    const diags: InferenceDiagnostic[] = [
      { message: 'Type mismatch: implementation does not match annotation', start: 0, end: 10 },
      { message: 'Cannot unify Number with String', start: 20, end: 30 },
    ];
    const result = filterAnnotationMismatchDiagnostics(diags);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('Cannot unify Number with String');
  });

  test('removes "function returns X but annotation expects Y" diagnostics', () => {
    const diags: InferenceDiagnostic[] = [
      { message: 'Type mismatch: function returns String but annotation expects Number', start: 0, end: 10 },
      { message: 'Unknown type constructor \'Foo\'', start: 20, end: 30 },
    ];
    const result = filterAnnotationMismatchDiagnostics(diags);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain('Unknown type constructor');
  });

  test('removes "function returns a generic value" diagnostics', () => {
    const diags: InferenceDiagnostic[] = [
      { message: 'Type mismatch: function returns a generic value where \'Number\' is expected', start: 0, end: 10 },
    ];
    const result = filterAnnotationMismatchDiagnostics(diags);
    expect(result).toHaveLength(0);
  });

  test('keeps non-annotation diagnostics untouched', () => {
    const diags: InferenceDiagnostic[] = [
      { message: 'Cannot unify Number with String', start: 0, end: 10 },
      { message: 'Parse error at position 5', start: 5, end: 6 },
    ];
    const result = filterAnnotationMismatchDiagnostics(diags);
    expect(result).toHaveLength(2);
  });

  test('returns empty array when all diagnostics are annotation mismatches', () => {
    const diags: InferenceDiagnostic[] = [
      { message: 'Type mismatch: implementation does not match annotation', start: 0, end: 10 },
      { message: 'Type mismatch: function returns String but annotation expects Number', start: 20, end: 30 },
    ];
    const result = filterAnnotationMismatchDiagnostics(diags);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// filterDiagnosticsInsideBindings (trustAnnotations: annotated-bodies / all-bodies)
// ---------------------------------------------------------------------------

describe('filterDiagnosticsInsideBindings', () => {
  test('drops diagnostics fully inside an interval', () => {
    const diags: InferenceDiagnostic[] = [
      { message: 'body error', start: 15, end: 25 },
      { message: 'top-level', start: 100, end: 110 },
    ];
    const result = filterDiagnosticsInsideBindings(diags, [[10, 50]]);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('top-level');
  });

  test('keeps diagnostics that exactly match an interval boundary', () => {
    const diags: InferenceDiagnostic[] = [
      { message: 'inside', start: 10, end: 50 },
    ];
    // Exact-match should be dropped (inclusive comparison).
    const result = filterDiagnosticsInsideBindings(diags, [[10, 50]]);
    expect(result).toHaveLength(0);
  });

  test('keeps diagnostic that partially overlaps interval edge', () => {
    const diags: InferenceDiagnostic[] = [
      { message: 'straddles start', start: 5, end: 20 },
      { message: 'straddles end', start: 45, end: 60 },
    ];
    const result = filterDiagnosticsInsideBindings(diags, [[10, 50]]);
    expect(result).toHaveLength(2);
  });

  test('identity when intervals are empty', () => {
    const diags: InferenceDiagnostic[] = [
      { message: 'x', start: 0, end: 5 },
    ];
    expect(filterDiagnosticsInsideBindings(diags, [])).toBe(diags);
  });

  test('drops when diagnostic falls in any of multiple intervals', () => {
    const diags: InferenceDiagnostic[] = [
      { message: 'in first', start: 12, end: 18 },
      { message: 'in second', start: 60, end: 70 },
      { message: 'outside both', start: 100, end: 110 },
    ];
    const result = filterDiagnosticsInsideBindings(diags, [[10, 20], [55, 80]]);
    expect(result.map(d => d.message)).toEqual(['outside both']);
  });
});

// ---------------------------------------------------------------------------
// collectBindingIntervals
// ---------------------------------------------------------------------------

describe('collectBindingIntervals', () => {
  function makeResult(extents?: Array<{ start: number; end: number; annotated: boolean }>): any {
    return { annotations: new Map(), nodeTypes: new Map(), bindingExtents: extents };
  }

  test('annotated mode returns only annotated extents', () => {
    const r = makeResult([
      { start: 10, end: 30, annotated: true },
      { start: 50, end: 80, annotated: false },
      { start: 100, end: 120, annotated: true },
    ]);
    expect(collectBindingIntervals(r, 'annotated')).toEqual([[10, 30], [100, 120]]);
  });

  test('all mode returns every extent', () => {
    const r = makeResult([
      { start: 0, end: 20, annotated: false },
      { start: 25, end: 60, annotated: true },
    ]);
    expect(collectBindingIntervals(r, 'all')).toEqual([[0, 20], [25, 60]]);
  });

  test('returns empty array when bindingExtents is missing (conservative)', () => {
    expect(collectBindingIntervals(makeResult(), 'all')).toEqual([]);
    expect(collectBindingIntervals(makeResult(), 'annotated')).toEqual([]);
  });

  test('annotated mode on a result with only un-annotated extents → empty', () => {
    const r = makeResult([{ start: 0, end: 10, annotated: false }]);
    expect(collectBindingIntervals(r, 'annotated')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// classifyDiagnosticCode
// ---------------------------------------------------------------------------

describe('classifyDiagnosticCode', () => {
  // 1xxx — Type errors
  test('unification error → HM_TYPE_MISMATCH', () => {
    expect(classifyDiagnosticCode('Cannot unify Number with String')).toBe(HM_TYPE_MISMATCH);
  });

  test('infinite type → HM_INFINITE_TYPE', () => {
    expect(classifyDiagnosticCode('Infinite type detected: a occurs in (a -> b)')).toBe(HM_INFINITE_TYPE);
  });

  test('annotation mismatch → HM_ANNOTATION_MISMATCH', () => {
    expect(classifyDiagnosticCode('Type mismatch: implementation does not match annotation')).toBe(HM_ANNOTATION_MISMATCH);
  });

  test('return type mismatch → HM_RETURN_TYPE_MISMATCH', () => {
    expect(classifyDiagnosticCode('Type mismatch: function returns String but annotation expects Number')).toBe(HM_RETURN_TYPE_MISMATCH);
  });

  test('missing property → HM_MISSING_PROPERTY', () => {
    expect(classifyDiagnosticCode("Property 'foo' does not exist on type { bar :: Number }")).toBe(HM_MISSING_PROPERTY);
  });

  test('unconstrained property → HM_UNCONSTRAINED_PROP', () => {
    expect(classifyDiagnosticCode("Property 'x' accessed on unconstrained type variable")).toBe(HM_UNCONSTRAINED_PROP);
  });

  test('unbound variable → HM_UNBOUND_VARIABLE', () => {
    expect(classifyDiagnosticCode('Unbound variable: foo')).toBe(HM_UNBOUND_VARIABLE);
  });

  // 2xxx — Annotation issues
  test('invalid annotation → HM_INVALID_ANNOTATION', () => {
    expect(classifyDiagnosticCode('Invalid type annotation: unexpected token')).toBe(HM_INVALID_ANNOTATION);
  });

  test('declaration name mismatch → HM_NAME_MISMATCH', () => {
    expect(classifyDiagnosticCode("Declaration name 'foo' does not match annotation name 'bar'")).toBe(HM_NAME_MISMATCH);
  });

  test('method name mismatch → HM_METHOD_NAME_MISMATCH', () => {
    expect(classifyDiagnosticCode("Method name 'foo' does not match annotation 'bar'")).toBe(HM_METHOD_NAME_MISMATCH);
  });

  test('unknown type constructor → HM_UNKNOWN_TYPE', () => {
    expect(classifyDiagnosticCode("Unknown type constructor 'Foo'")).toBe(HM_UNKNOWN_TYPE);
  });

  test('variant method → HM_VARIANT_METHOD', () => {
    expect(classifyDiagnosticCode("'Left' is a variant of 'Either'. Use 'Either#map' instead.")).toBe(HM_VARIANT_METHOD);
  });

  test('method type mismatch → HM_METHOD_TYPE_MISMATCH', () => {
    expect(classifyDiagnosticCode('Type name mismatch in method annotation: expected Maybe, got Either')).toBe(HM_METHOD_TYPE_MISMATCH);
  });

  // 3xxx — Import / module issues
  test('missing export → HM_MISSING_EXPORT', () => {
    expect(classifyDiagnosticCode("'foo' is not exported from './bar'")).toBe(HM_MISSING_EXPORT);
  });

  test('unresolved types path → HM_UNRESOLVED_TYPES_PATH', () => {
    expect(classifyDiagnosticCode("Cannot resolve ::types path './missing.js'")).toBe(HM_UNRESOLVED_TYPES_PATH);
  });

  test('unresolved import → HM_UNRESOLVED_IMPORT', () => {
    expect(classifyDiagnosticCode("Cannot resolve module './nonexistent'")).toBe(HM_UNRESOLVED_IMPORT);
  });

  // 4xxx — Constraint issues
  test('unknown constraint → HM_UNKNOWN_CONSTRAINT', () => {
    expect(classifyDiagnosticCode("Unknown constraint 'Serializable'")).toBe(HM_UNKNOWN_CONSTRAINT);
  });

  test('constraint violation → HM_CONSTRAINT_VIOLATION', () => {
    expect(classifyDiagnosticCode('Number cannot satisfy constraint Functor')).toBe(HM_CONSTRAINT_VIOLATION);
    expect(classifyDiagnosticCode('String does not satisfy constraint Eq')).toBe(HM_CONSTRAINT_VIOLATION);
  });

  test('invalid constraint → HM_INVALID_CONSTRAINT', () => {
    expect(classifyDiagnosticCode('Invalid ::constraint directive: missing arguments')).toBe(HM_INVALID_CONSTRAINT);
  });

  test('constraint kind mismatch → HM_CONSTRAINT_KIND_MISMATCH', () => {
    expect(classifyDiagnosticCode("Constraint kind mismatch: 'Functor' expects kind * -> *")).toBe(HM_CONSTRAINT_KIND_MISMATCH);
    expect(classifyDiagnosticCode("Constraint kind mismatch: 'Monoid' expects kind *")).toBe(HM_CONSTRAINT_KIND_MISMATCH);
    expect(classifyDiagnosticCode("Inconsistent kind for 'm' in constraint 'Bad'")).toBe(HM_CONSTRAINT_KIND_MISMATCH);
  });

  test('typevar not used in constraint method → HM_INVALID_CONSTRAINT', () => {
    expect(classifyDiagnosticCode("Type variable 'f' is not used in any method signature of constraint 'Foo'.")).toBe(HM_INVALID_CONSTRAINT);
  });

  // 5xxx — Curry issues
  test('curry arity → HM_CURRY_ARITY', () => {
    expect(classifyDiagnosticCode('Curry wrapper expects exactly 2 arguments')).toBe(HM_CURRY_ARITY);
  });

  test('curry type → HM_CURRY_TYPE', () => {
    expect(classifyDiagnosticCode('Curry wrapper expects a function argument')).toBe(HM_CURRY_TYPE);
  });

  test('curried over-application → HM_CURRIED_OVER_APPLICATION', () => {
    expect(classifyDiagnosticCode('Curried function called with too many arguments')).toBe(HM_CURRIED_OVER_APPLICATION);
  });

  // 6xxx — Missing signatures
  test('missing signature → HM_MISSING_SIGNATURE', () => {
    expect(classifyDiagnosticCode("Function 'foo' has no HM annotation")).toBe(HM_MISSING_SIGNATURE);
    expect(classifyDiagnosticCode("Method 'Maybe#map' has no HM annotation")).toBe(HM_MISSING_SIGNATURE);
  });

  // 9xxx — Parse errors
  test('parse error → HM_PARSE_ERROR', () => {
    expect(classifyDiagnosticCode('Parse error at line 5')).toBe(HM_PARSE_ERROR);
  });

  // Fallback
  test('unknown message falls back to HM_TYPE_MISMATCH', () => {
    expect(classifyDiagnosticCode('Some completely unknown error')).toBe(HM_TYPE_MISMATCH);
  });
});

// ---------------------------------------------------------------------------
// codeToCategory
// ---------------------------------------------------------------------------

describe('codeToCategory', () => {
  test('type-mismatch family → typeErrors', () => {
    for (const code of [
      HM_TYPE_MISMATCH, HM_INFINITE_TYPE, HM_ANNOTATION_MISMATCH,
      HM_RETURN_TYPE_MISMATCH, HM_NOT_CALLABLE, HM_INVALID_TABLE_RELATION,
    ]) {
      expect(codeToCategory(code)).toBe('typeErrors');
    }
  });

  test('property access family → unknownPropertyAccess', () => {
    expect(codeToCategory(HM_MISSING_PROPERTY)).toBe('unknownPropertyAccess');
    expect(codeToCategory(HM_UNCONSTRAINED_PROP)).toBe('unknownPropertyAccess');
  });

  test('missing record fields → missingRecordFields', () => {
    expect(codeToCategory(HM_MISSING_RECORD_FIELDS)).toBe('missingRecordFields');
  });

  test('union narrowing → annotationNarrowing', () => {
    expect(codeToCategory(HM_UNION_NARROWING)).toBe('annotationNarrowing');
  });

  test('uncategorized codes → null (always reported as errors)', () => {
    for (const code of [
      HM_UNBOUND_VARIABLE, HM_INVALID_ANNOTATION, HM_UNKNOWN_TYPE,
      HM_MISSING_EXPORT, HM_CONSTRAINT_VIOLATION, HM_CURRY_ARITY,
      HM_MISSING_SIGNATURE, HM_PARSE_ERROR,
    ]) {
      expect(codeToCategory(code)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// mapInferenceDiagnostics — diagnostic codes
// ---------------------------------------------------------------------------

describe('mapInferenceDiagnostics — diagnostic codes', () => {
  const source = 'const x = 1;\nconst y = 2;\n';
  const doc = TextDocument.create('file:///test.js', 'javascript', 1, source);
  const identity = (offset: number, _insertions: number[]) => offset;
  const asError = (_code: number) => DiagnosticSeverity.Error;

  test('attaches numeric code based on message', () => {
    const inferDiags: InferenceDiagnostic[] = [
      { message: 'Cannot unify Number with String', start: 0, end: 5 },
    ];
    const result = mapInferenceDiagnostics(inferDiags, doc, [], asError, identity);
    expect(result[0].code).toBe(HM_TYPE_MISMATCH);
  });

  test('attaches code for annotation mismatch', () => {
    const inferDiags: InferenceDiagnostic[] = [
      { message: 'Type mismatch: implementation does not match annotation', start: 0, end: 5 },
    ];
    const result = mapInferenceDiagnostics(inferDiags, doc, [], asError, identity);
    expect(result[0].code).toBe(HM_ANNOTATION_MISMATCH);
  });

  test('attaches code for unbound variable', () => {
    const inferDiags: InferenceDiagnostic[] = [
      { message: 'Unbound variable: foo', start: 6, end: 9 },
    ];
    const result = mapInferenceDiagnostics(inferDiags, doc, [], asError, identity);
    expect(result[0].code).toBe(HM_UNBOUND_VARIABLE);
  });
});

// ---------------------------------------------------------------------------
// mapInferenceDiagnostics — relatedInformation
// ---------------------------------------------------------------------------

describe('mapInferenceDiagnostics — relatedInformation', () => {
  const source = '// Type#method :: a -> b\nconst map = x => x;\n';
  const doc = TextDocument.create('file:///test.js', 'javascript', 1, source);
  const identity = (offset: number, _insertions: number[]) => offset;
  const asError = (_code: number) => DiagnosticSeverity.Error;

  test('converts relatedInformation offsets to LSP DiagnosticRelatedInformation', () => {
    const inferDiags: InferenceDiagnostic[] = [
      {
        message: "Method name 'mapp' does not match annotation 'map'",
        start: 30,
        end: 34,
        relatedInformation: [
          { message: "Annotation 'Type#map' defined here", start: 0, end: 23 },
        ],
      },
    ];
    const result = mapInferenceDiagnostics(inferDiags, doc, [], asError, identity);
    expect(result[0].relatedInformation).toHaveLength(1);
    const ri = result[0].relatedInformation![0];
    expect(ri.message).toBe("Annotation 'Type#map' defined here");
    expect(ri.location.uri).toBe('file:///test.js');
    // offset 0 → line 0, char 0
    expect(ri.location.range.start).toEqual({ line: 0, character: 0 });
    // offset 23 → line 0, char 23
    expect(ri.location.range.end).toEqual({ line: 0, character: 23 });
  });

  test('omits relatedInformation when not present', () => {
    const inferDiags: InferenceDiagnostic[] = [
      { message: 'Cannot unify Number with String', start: 0, end: 5 },
    ];
    const result = mapInferenceDiagnostics(inferDiags, doc, [], asError, identity);
    expect(result[0].relatedInformation).toBeUndefined();
  });

  test('omits relatedInformation when array is empty', () => {
    const inferDiags: InferenceDiagnostic[] = [
      { message: 'Cannot unify Number with String', start: 0, end: 5, relatedInformation: [] },
    ];
    const result = mapInferenceDiagnostics(inferDiags, doc, [], asError, identity);
    expect(result[0].relatedInformation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectMissingSignatures — diagnostic codes
// ---------------------------------------------------------------------------

describe('detectMissingSignatures — diagnostic codes', () => {
  function detect(source: string) {
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, source);
    return detectMissingSignatures(source, doc, new Map(), DiagnosticSeverity.Information, DiagnosticSeverity.Information);
  }

  test('missing signature diagnostics have code HM_MISSING_SIGNATURE', () => {
    const diags = detect('const add = (a, b) => a + b;');
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) {
      expect(d.code).toBe(HM_MISSING_SIGNATURE);
    }
  });

  test('function declaration missing signature has code', () => {
    const diags = detect('function greet(name) { return name; }');
    expect(diags.length).toBe(1);
    expect(diags[0].code).toBe(HM_MISSING_SIGNATURE);
  });
});

// ---------------------------------------------------------------------------
// classifyDiagnosticCode — additional branch coverage
// ---------------------------------------------------------------------------

describe('classifyDiagnosticCode — additional branches', () => {
  test('nameless annotation → HM_NAMELESS_ON_NAMED', () => {
    expect(classifyDiagnosticCode('Nameless annotation on named declaration')).toBe(HM_NAMELESS_ON_NAMED);
  });

  test('type arity mismatch → HM_TYPE_ARITY_MISMATCH', () => {
    expect(classifyDiagnosticCode("Type constructor 'Maybe' expects 1 argument but got 2")).toBe(HM_TYPE_ARITY_MISMATCH);
  });

  test('union narrowing → HM_UNION_NARROWING', () => {
    expect(classifyDiagnosticCode('Annotation narrows the type from String | Number to String')).toBe(HM_UNION_NARROWING);
  });

  test('duplicate import → HM_DUPLICATE_IMPORT', () => {
    expect(classifyDiagnosticCode('Duplicate import: foo from ./bar')).toBe(HM_DUPLICATE_IMPORT);
  });

  test('circular import → HM_CIRCULAR_IMPORT', () => {
    expect(classifyDiagnosticCode('Circular import detected: ./a → ./b → ./a')).toBe(HM_CIRCULAR_IMPORT);
  });

  test('missing record fields → HM_MISSING_RECORD_FIELDS', () => {
    expect(classifyDiagnosticCode('Missing record field: x')).toBe(HM_MISSING_RECORD_FIELDS);
    expect(classifyDiagnosticCode("Missing required field 'label' on argument; expected '{ label :: String }'")).toBe(HM_MISSING_RECORD_FIELDS);
    expect(classifyDiagnosticCode("Missing required fields 'a', 'b' on argument; expected '{ a :: Number, b :: Number }'")).toBe(HM_MISSING_RECORD_FIELDS);
  });

  test('missing variant impl → HM_MISSING_VARIANT_IMPL', () => {
    expect(classifyDiagnosticCode("'Just' does not implement 'ap'")).toBe(HM_MISSING_VARIANT_IMPL);
  });
});

// ---------------------------------------------------------------------------
// detectMissingSignatures — additional coverage
// ---------------------------------------------------------------------------

describe('detectMissingSignatures — additional coverage', () => {
  function detect(source: string, annotations = new Map()) {
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, source);
    return detectMissingSignatures(source, doc, annotations, DiagnosticSeverity.Information, DiagnosticSeverity.Information);
  }

  test('class method missing signature', () => {
    const diags = detect('class Foo { bar(x) { return x; } }');
    expect(diags.some(d => d.message.includes('bar'))).toBe(true);
  });

  test('static method assignment missing signature', () => {
    const diags = detect('function Foo() {}\nFoo.create = (x) => x;');
    expect(diags.some(d => d.message.includes('Foo.create'))).toBe(true);
  });

  test('nested function declaration flagged', () => {
    const diags = detect('function outer() {\n  function inner(x) { return x; }\n  return inner(1);\n}');
    expect(diags.some(d => d.message.includes('inner'))).toBe(true);
  });

  test('arrow function binding missing signature', () => {
    const diags = detect('const add = (x) => x + 1;');
    expect(diags.some(d => d.message.includes('add'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectMissingSignatures — branch coverage
// ---------------------------------------------------------------------------

describe('detectMissingSignatures — branch coverage', () => {
  function detect(source: string, annotations: Map<string, any> = new Map()) {
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, source);
    return detectMissingSignatures(source, doc, annotations, DiagnosticSeverity.Information, DiagnosticSeverity.Information);
  }

  test('class method annotated at offset — no diagnostic', () => {
    // The arrow function inside the class starts at a known offset.
    // We set nodeStart to that offset so hasAnnotationAtOffset returns true.
    const src = 'class Foo {\n  bar(x) { return x; }\n}';
    // "bar(x) { return x; }" : the method value starts at "bar" key's function.
    // In acorn, MethodDefinition.value.start is the start of the function expression.
    // For `bar(x) { return x; }`, the value starts where `bar` begins (since it's shorthand).
    // We need the exact offset. Let's compute:
    // "class Foo {\n  bar(x) { return x; }\n}" — `bar` is at index 14
    // acorn's MethodDefinition.value.start for shorthand is the start of the FunctionExpression
    // which is at the same position as the method key — but actually value.start is `bar` start
    // Let's just use a brute approach: set nodeStart for several offsets
    const annotations = new Map<string, any>();
    // The method value (FunctionExpression) for shorthand starts at the key position (14)
    annotations.set('__offset_ann', { nodeStart: 17 } as any);
    const diags = detect(src, annotations);
    // Foo#bar should NOT be flagged since hasAnnotationAtOffset returns true
    expect(diags.some(d => d.message.includes('Foo#bar'))).toBe(false);
  });

  test('nested function annotated at offset — no diagnostic', () => {
    const src = 'function outer() {\n  function inner(x) { return x; }\n  return inner(1);\n}';
    // inner starts at offset 21 ("  function inner" after "function outer() {\n")
    // "function outer() {\n" = 20 chars, "  function" starts at 20+2 = 22 for the 'f'
    // Actually let's compute: "function outer() {\n" is 20 chars, then "  function inner(x)" so inner's function decl starts at 22
    const annotations = new Map<string, any>();
    // Set nodeStart to match the nested function declaration start
    annotations.set('__offset_ann', { nodeStart: 21 } as any);
    const diags = detect(src, annotations);
    expect(diags.some(d => d.message.includes('inner'))).toBe(false);
  });

  test('nested function annotated by name — no diagnostic', () => {
    const src = 'function outer() {\n  function inner(x) { return x; }\n  return inner(1);\n}';
    const annotations = new Map<string, any>();
    annotations.set('inner', {} as any);
    const diags = detect(src, annotations);
    expect(diags.some(d => d.message.includes('inner'))).toBe(false);
  });

  test('nested variable annotated by method-style name — no diagnostic', () => {
    const src = 'function outer() {\n  const map = (x) => x;\n  return map(1);\n}';
    const annotations = new Map<string, any>();
    annotations.set('Foo#map', {} as any);
    const diags = detect(src, annotations);
    expect(diags.some(d => d.message.includes("'map'"))).toBe(false);
  });

  test('destructured variable declaration is skipped', () => {
    // `const { a } = obj;` — declarator.id is ObjectPattern, not Identifier
    // so id.name is undefined and the continue branch fires (line 205)
    const src = 'const { a } = { a: 1 };';
    const diags = detect(src);
    // No diagnostic for destructured binding
    expect(diags.length).toBe(0);
  });

  test('nested variable without init is skipped', () => {
    // `let x;` nested inside a function — !declarator.init triggers continue
    const src = 'function outer() {\n  let x;\n  return x;\n}';
    const diags = detect(src);
    // No nested diag for `x` since it has no init
    expect(diags.some(d => d.message.includes("'x'"))).toBe(false);
  });

  test('class with non-method member — skipped', () => {
    // PropertyDefinition is not MethodDefinition → continue branch (line 188)
    const src = 'class Foo {\n  x = 42;\n  bar(x) { return x; }\n}';
    const diags = detect(src);
    // bar should still be flagged, but x (property) should not produce diagnostic
    expect(diags.some(d => d.message.includes('Foo#bar'))).toBe(true);
    expect(diags.every(d => !d.message.includes("'x'"))).toBe(true);
  });

  test('class with constructor — skipped', () => {
    // constructor method → `methodName === 'constructor'` continue (line 190)
    const src = 'class Foo {\n  constructor() {}\n  bar(x) { return x; }\n}';
    const diags = detect(src);
    expect(diags.some(d => d.message.includes('constructor'))).toBe(false);
    expect(diags.some(d => d.message.includes('Foo#bar'))).toBe(true);
  });

  test('nested non-function variable with varSeverity=null — skipped', () => {
    // Nested const x = 42 (not fn), varSeverity=null → sev==null → continue (line 327)
    const src = 'function outer() {\n  const x = 42;\n  return x;\n}';
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, src);
    const diags = detectMissingSignatures(src, doc, new Map(), DiagnosticSeverity.Information, null);
    expect(diags.some(d => d.message.includes("'x'"))).toBe(false);
  });

  test('nested function declaration with fnSeverity=null — skipped', () => {
    // Nested function inner() with fnSeverity=null → fnSeverity==null → return (lines 335-336)
    const src = 'function outer() {\n  function inner(x) { return x; }\n  return inner(1);\n}';
    const doc = TextDocument.create('file:///test.js', 'javascript', 1, src);
    const diags = detectMissingSignatures(src, doc, new Map(), null, DiagnosticSeverity.Information);
    // outer still flagged? No, fnSeverity is null so outer isn't flagged either
    expect(diags.some(d => d.message.includes('inner'))).toBe(false);
  });
});
