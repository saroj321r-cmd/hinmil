// A locally-declared value SHADOWS an ambient global of the same name.  A
// project's globals (e.g. Jest's `test :: (String, () -> ()) -> ()` seeded from
// a `.hm` globals file) must NOT be applied as a declared-type annotation to a
// user's own same-named `const test = ...` binding.  Regression for
// fpkit/src/object/propOrElse.js line 10 emitting
//   Type mismatch: Cannot unify 'Either String a' with '(String, () -> ()) -> ()'
// because the local `const test = propOrElse (...) (...) (...)` collided with
// the Jest `test` global.
import { InferenceEngine } from '../../src/infer';
import { Type } from '../../src/hm/types';
import { buildHover } from '../../src/services/hover';

// Mirrors how the server wraps a `.hm` globals file: bare `name :: sig` lines
// become `// name :: sig` comment annotations tagged with origin 'globals'.
const JEST_GLOBAL = '// test :: (String, () -> ()) -> ()';

function diagnostics(globalsSource: string, source: string): string[] {
  const eng = new InferenceEngine();
  eng.globalsSource = globalsSource;
  return eng.infer(source).diagnostics.map(d => d.message);
}

function hoverValue(globalsSource: string, source: string, needle: string): string | null {
  const eng = new InferenceEngine();
  eng.globalsSource = globalsSource;
  const r = eng.infer(source);
  const offset = source.indexOf(needle);
  let bestStart = -1, bestEnd = -1, best: Type | null = null;
  for (const [s, info] of r.nodeTypes) {
    const end = (info as { end: number }).end;
    if (s <= offset && offset < end && s > bestStart) {
      bestStart = s; bestEnd = end; best = r.substitution.apply((info as { type: Type }).type);
    }
  }
  const h = buildHover({
    source, offset, result: r, bestType: best, bestStart, bestEnd, scopeType: null, arrayShift: 0,
    inferredTypeStyle: 'pretty', uri: 'file:///t.js',
    resolveImportSpecifier: () => null,
    extractImportSpecifiers: () => new Map(),
  } as Parameters<typeof buildHover>[0]);
  return h ? (h.contents as { value: string }).value : null;
}

describe('local const shadows a same-named global free-function annotation', () => {
  test('a monomorphic local binding is not rejected by the global signature', () => {
    expect(diagnostics(JEST_GLOBAL, 'const test = 5;\nmodule.exports = test;')).toEqual([]);
  });

  test('a function-valued local binding of a different shape is not rejected', () => {
    expect(diagnostics(JEST_GLOBAL, 'const test = x => x;\nmodule.exports = test;')).toEqual([]);
  });

  test('the shadowing works even without any export', () => {
    expect(diagnostics(JEST_GLOBAL, 'const test = 5;')).toEqual([]);
  });
});

describe('the global remains usable where it is NOT shadowed', () => {
  test('calling the global with correct arguments type-checks', () => {
    expect(diagnostics(JEST_GLOBAL, 'test("name", () => {});')).toEqual([]);
  });

  test('calling the global with a wrong argument still errors', () => {
    const ds = diagnostics(JEST_GLOBAL, 'test(42, () => {});');
    expect(ds.length).toBeGreaterThan(0);
    expect(ds.join('\n')).toMatch(/Cannot unify 'Number' with 'String'/);
  });
});

describe('a genuine file-local annotation is still validated', () => {
  test('a local annotation mismatch is reported', () => {
    const ds = diagnostics(JEST_GLOBAL, '// foo :: Number\nconst foo = "x";');
    expect(ds.join('\n')).toMatch(/'foo' has type 'String' but annotation expects 'Number'/);
  });
});

describe('hover reflects the local binding, not the shadowed global', () => {
  const SRC = [
    'const mk = e => a => ({ tag: "R", err: e, val: a });',
    'const test = mk ("Missing") (undefined);',
    'module.exports = test;',
  ].join('\n');

  test('hovering the local `test` shows its inferred type, not the global signature', () => {
    const v = hoverValue(JEST_GLOBAL, SRC, 'test = mk');
    expect(v).not.toBeNull();
    expect(v).not.toMatch(/\(String, \(\) -> \(\)\) -> \(\)/);
    expect(v).toMatch(/test :: \{ tag :: String, err :: String, val :: Undefined \}/);
  });

  test('hovering a genuine global usage still shows the global signature', () => {
    const v = hoverValue(JEST_GLOBAL, 'test("name", () => {});', 'test');
    expect(v).toMatch(/test :: \(String, \(\) -> \(\)\) -> \(\)/);
  });
});
