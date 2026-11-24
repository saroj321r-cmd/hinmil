// `$error` (T_ERROR) sentinel scrubbing invariants — consolidated suite.
//
//   1. Export scrub — no `$error` poison sentinel leaks into the exported
//      scheme across ALL export paths handled by buildExportMap (ESM named /
//      default identifier / default expression, CommonJS named / default),
//      even when a SIBLING binding fails unification and poisons free TVars.
//   2. Rendering — the sentinel must never leak into user-visible
//      pretty-printed types; T_ERROR renders as `_`.

import { TempProject } from '../helpers/project';
import {
  tCon,
  tFun,
  tVar,
  T_ERROR,
  typeToString,
  prettyTypeToString,
  resetTypeVarCounter,
  containsErrorType,
  Scheme,
} from '../../src/hm/types';

// ---------------------------------------------------------------------------
// 1. Invariant: no `$error` poison sentinel leaks into the exported scheme
//    across ALL export paths handled by buildExportMap.  Each path:
//
//      1. ESM named export    (`export { x }`)              — applySubst/scrub path
//      2. ESM default export  (`export default X`)          — Identifier ann-auth or scrub fallback
//      3. ESM default export  (`export default expr`)       — scrub path
//      4. CommonJS named expr (`exports.x = ...`)           — cjsExportTypes scrub path
//      5. CommonJS default    (`module.exports = X`)        — ann-auth or scrub fallback
//
//    In each case we deliberately introduce a unification error in a
//    SIBLING binding (so `poisonFreeVars` writes `$error` into free TVars
//    of the export target) and assert containsErrorType on the exported
//    scheme returns false.
// ---------------------------------------------------------------------------

describe('error-scrub invariant: no $error in exported schemes', () => {
  const project = new TempProject('error-scrub-invariant');

  beforeAll(() => project.setup());
  afterAll(() => project.cleanup());

  const inferOnly = (fileRel: string, source: string) =>
    project.inferSource(fileRel, source);

  test('ESM named export with sibling poison', () => {
    const r = inferOnly('p1.js', [
      'const id = x => x;',
      'const broken = "s" - 1;', // unification error → poison
      'export { id };',
    ].join('\n'));
    const s = r.exports.get('id') as Scheme | undefined;
    expect(s).toBeDefined();
    expect(containsErrorType(s!.type)).toBe(false);
  });

  test('ESM default export of identifier with sibling poison', () => {
    const r = inferOnly('p2.js', [
      'const id = x => x;',
      'const broken = "s" - 1;',
      'export default id;',
    ].join('\n'));
    const s = r.exports.get('default') as Scheme | undefined;
    expect(s).toBeDefined();
    expect(containsErrorType(s!.type)).toBe(false);
  });

  test('ESM default export of expression with sibling poison', () => {
    const r = inferOnly('p3.js', [
      'const broken = "s" - 1;',
      'export default x => x;',
    ].join('\n'));
    const s = r.exports.get('default') as Scheme | undefined;
    expect(s).toBeDefined();
    expect(containsErrorType(s!.type)).toBe(false);
  });

  test('CommonJS exports.x with sibling poison', () => {
    const r = inferOnly('p4.js', [
      'const id = x => x;',
      'const broken = "s" - 1;',
      'exports.id = id;',
    ].join('\n'));
    const s = r.exports.get('id') as Scheme | undefined;
    expect(s).toBeDefined();
    expect(containsErrorType(s!.type)).toBe(false);
  });

  test('CommonJS module.exports = X with sibling poison', () => {
    const r = inferOnly('p5.js', [
      'const id = x => x;',
      'const broken = "s" - 1;',
      'module.exports = id;',
    ].join('\n'));
    const s = r.exports.get('default') as Scheme | undefined;
    expect(s).toBeDefined();
    expect(containsErrorType(s!.type)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The `$error` (T_ERROR) sentinel is used internally by `poisonFreeVars`
//    to stop diagnostic cascades after a unification failure.  It must never
//    leak into user-visible pretty-printed types (hover / signature-help /
//    completion detail).
//
//    Regression for: calling a constrained function like
//      // chain :: Chain m => (a -> m b) -> m a -> m b
//    with a wrong-typed argument would render the inferred signature as
//      chain($error -> m $error) -> m $error -> m $error
// ---------------------------------------------------------------------------

describe('$error sentinel rendering', () => {
  beforeEach(() => resetTypeVarCounter());

  test('typeToString renders T_ERROR TCon as "_"', () => {
    expect(typeToString(tCon(T_ERROR, []))).toBe('_');
  });

  test('prettyTypeToString renders T_ERROR TCon as "_"', () => {
    expect(prettyTypeToString(tCon(T_ERROR, []))).toBe('_');
  });

  test('$error never appears anywhere in a rendered composite type', () => {
    const m = tVar('m');
    const errT = tCon(T_ERROR, []);
    // (($error -> m $error) -> m $error -> m $error)
    const composite = tFun(
      tFun(errT, tCon('m', [errT])),
      tFun(tCon('m', [errT]), tCon('m', [errT])),
    );
    void m;
    const rendered = prettyTypeToString(composite);
    expect(rendered).not.toMatch(/\$error/);
    expect(rendered).toContain('_');
  });
});
