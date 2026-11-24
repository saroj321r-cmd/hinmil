// Let-generalization must not over-generalize a `const` whose type shares a
// type variable with an enclosing binding that has already been unified.
//
// Regression for the bug where `const result = f(arg)` — inside a lambda whose
// param `f` was unified to `arg -> result` — was generalized to `∀a. a`.  Each
// usage of `result` then instantiated a FRESH variable, so hover showed
// `result :: a` while `f :: a -> b` (should be `result :: b`), and the memoiser
// body inferred a spurious union return.  Root cause: `generalize` /
// `env.freeTypeVars()` collected free vars from the RAW scheme types without
// resolving them through the current substitution, so `f`'s resolved return
// variable was invisible and wrongly considered generalizable.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString } from '../../src/hm/types';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  clearCustomMethods();
  engine = new InferenceEngine();
});

const errs = (r: ReturnType<InferenceEngine['infer']>) =>
  r.diagnostics.filter(d => d.severity !== 3 && !/Unused/.test(d.message));

// the type-variable id backing a node (after full substitution)
function varIdAt(r: ReturnType<InferenceEngine['infer']>, off: number): number | null {
  const entry = r.nodeTypes.get(off);
  if (!entry) return null;
  const t = engine.subst.apply(entry.type);
  return t.tag === 'TVar' ? t.id : null;
}

describe('let-generalization respects substitution-resolved env free vars', () => {
  test('`const result = f(arg)` in a lambda is NOT generalized (decl id === use id)', () => {
    const src = [
      'const wrap = (f) => (arg) => {',
      '  const result = f(arg);',
      '  return result;',
      '};',
    ].join('\n');
    const r = engine.infer(src);
    expect(errs(r)).toHaveLength(0);

    const declId = varIdAt(r, src.indexOf('const result') + 'const '.length);
    const useId = varIdAt(r, src.indexOf('return result') + 'return '.length);
    expect(declId).not.toBeNull();
    // A generalized `const` would instantiate a fresh var at the use site.
    expect(useId).toBe(declId);
  });

  test('the shared variable is f\'s RETURN, so f :: a -> b implies result :: b', () => {
    const src = [
      'const wrap = (f) => (arg) => {',
      '  const result = f(arg);',
      '  return result;',
      '};',
    ].join('\n');
    const r = engine.infer(src);

    // f's node type is `arg_var -> result_var`; result must be that same var.
    const fEntry = r.nodeTypes.get(src.indexOf('result = f(arg)') + 'result = '.length);
    expect(fEntry).toBeDefined();
    const fType = engine.subst.apply(fEntry!.type);
    expect(fType.tag).toBe('TFun');
    const retId = fType.tag === 'TFun' && fType.result.tag === 'TVar' ? fType.result.id : null;
    const resultId = varIdAt(r, src.indexOf('const result') + 'const '.length);
    expect(retId).not.toBeNull();
    expect(resultId).toBe(retId);
  });

  test('a genuinely independent inner const is STILL generalized (let-polymorphism preserved)', () => {
    // `id` shares no variable with the enclosing scope, so it must remain
    // polymorphic and be usable at two different types.
    const src = [
      'const outer = (x) => {',
      '  const id = (y) => y;',
      '  const a = id(1);',
      '  const b = id("s");',
      '  return x;',
      '};',
    ].join('\n');
    const r = engine.infer(src);
    // If `id` were monomorphic, `id(1)` then `id("s")` would clash.
    expect(errs(r)).toHaveLength(0);
  });

  test('memoiser body: cache value, f\'s return and result all share one variable', () => {
    const src = [
      'const memoized = (cacheNode, f) => (arg) => {',
      '  if (cacheNode.has(arg)) { return cacheNode.get(arg); }',
      '  const result = f(arg);',
      '  cacheNode.set(arg, result);',
      '  return result;',
      '};',
    ].join('\n');
    const r = engine.infer(src);
    expect(errs(r)).toHaveLength(0);
    // memoized :: (Map a b, a -> b) -> a -> b  — one key var, one value var.
    const t = prettyTypeToString(engine.subst.apply(r.topLevelBindings.get('memoized')!.type));
    expect(t).toContain('Map');
    // the intuitive shape has no spurious union in the return position
    expect(t).not.toContain('|');
  });
});
