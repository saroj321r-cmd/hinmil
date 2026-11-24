// Container-identity method back-constraining.
//
// A single BUILT-IN owner for a *generic* method name (e.g. `reduce` → Array)
// must NOT coerce an unconstrained receiver (see builtinSoleOwnerNoCoerce).  But
// container-IDENTITY methods — `Map#get`, `Set#add` — are strong enough signals
// to coerce: `x.get(k)` / `x.add(v)` on an otherwise-unknown `x` back-constrains
// `x` to `Map` / `Set`.  This makes bodies that thread a Map/Set through an
// unannotated local (e.g. a memoiser's cache) infer intuitive receiver types
// instead of a bare type variable.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString } from '../../src/hm/types';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { clearCustomMethods, isContainerIdentityMethod } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  clearCustomMethods();
  engine = new InferenceEngine();
});

const errs = (r: ReturnType<InferenceEngine['infer']>) =>
  r.diagnostics.filter(d => d.severity !== 3 && !/Unused/.test(d.message));

describe('container-identity method back-constraining', () => {
  test('isContainerIdentityMethod allowlists Map.get / Set.add only', () => {
    expect(isContainerIdentityMethod('Map', 'get')).toBe(true);
    expect(isContainerIdentityMethod('Set', 'add')).toBe(true);
    // generic / multi-owner names are NOT identity methods
    expect(isContainerIdentityMethod('Array', 'reduce')).toBe(false);
    expect(isContainerIdentityMethod('Array', 'map')).toBe(false);
    expect(isContainerIdentityMethod('Map', 'has')).toBe(false);
  });

  test('`m => m.get(1)` back-constrains the receiver to Map', () => {
    const r = engine.infer('const f = (m) => m.get(1);');
    expect(errs(r)).toHaveLength(0);
    expect(prettyTypeToString(r.topLevelBindings.get('f')!.type)).toContain('Map');
  });

  test('`s => s.add(1)` back-constrains the receiver to Set', () => {
    const r = engine.infer('const f = (s) => s.add(1);');
    expect(errs(r)).toHaveLength(0);
    expect(prettyTypeToString(r.topLevelBindings.get('f')!.type)).toContain('Set');
  });

  test('negative control: `x => x.reduce` stays polymorphic (no Array coercion)', () => {
    const r = engine.infer('const g = (x) => x.reduce;');
    const t = prettyTypeToString(r.topLevelBindings.get('g')!.type);
    expect(t).not.toContain('Array');
    expect(t).not.toContain('[');
    expect(t).not.toContain('Map');
  });

  test('cache threaded through an unannotated local infers Map, no new diagnostics', () => {
    // Mirrors sample/demo3.js memoizeCurried: `cacheNode` is a Map param of a
    // local helper; `.get`/`.set`/`.has` should pin it to Map.
    const src = [
      '// memoizeCurried :: (a -> b -> ... -> z) -> a -> b -> ... -> z',
      'const memoizeCurried = (fn) => {',
      '  const cache = new Map();',
      '  const memoized = (cacheNode, f) => (arg) => {',
      '    if (cacheNode.has(arg)) { return cacheNode.get(arg); }',
      '    const result = f(arg);',
      '    cacheNode.set(arg, result);',
      '    return result;',
      '  };',
      '  return memoized(cache, fn);',
      '};',
    ].join('\n');
    const r = engine.infer(src);
    expect(errs(r)).toHaveLength(0);
    // the `cacheNode` parameter node (first occurrence in the arrow header)
    // should have a Map receiver type.
    const idx = src.indexOf('cacheNode, f');
    const nt = r.nodeTypes.get(idx);
    expect(nt).toBeDefined();
    expect(prettyTypeToString(engine.subst.apply(nt!.type))).toContain('Map');
  });
});
