// A zero-arg call on a parameter whose type is still a free type variable
// must constrain it to a thunk `() -> r` (modeled on fpkit's RTask.try in a
// chained static assignment, where no annotation pre-binds the parameter):
//
//   // _Task.try :: (() -> a) -> Task r Error a
//   _Task.try = Task.try = function (thunk) { ... res (thunk ()) ... };
//
// Previously `tMultiFun([], result)` produced a bare TVar, so `thunk ()`
// left `thunk` unconstrained and the inferred type `a -> ...` failed the
// rigid check against `(() -> a) -> ...`.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

function infer(src: string) {
  return new InferenceEngine().infer(src);
}

beforeEach(() => {
  resetTypeVarCounter();
  clearCustomMethods();
});

describe('zero-arg call constrains a free-TVar callee to a thunk', () => {
  test('chained static assignment with thunk call matches its annotation', () => {
    const src = [
      '// A.go :: (() -> a) -> a',
      'const A = {};',
      'const B = {};',
      'A.go = B.go = function (thunk) { return thunk (); };',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('task.try idiom: thunk () inside an executor, chained assignment', () => {
    const src = [
      '// Task :: ((e -> (), a -> (), r) -> *) -> Task r e a',
      'function Task(fork) {',
      '  this.fork = fork;',
      '}',
      '',
      '// _Task :: ((e -> (), a -> (), r) -> *) -> Task r e a',
      'function _Task(fork) {',
      '  return new Task (fork);',
      '}',
      '',
      '// _Task.try :: (() -> a) -> Task r Error a',
      '_Task.try = Task.try = function (thunk) {',
      '  return _Task ((rej, res, _env) => {',
      '    try { res (thunk ()); } catch (e) { rej (e); }',
      '  });',
      '};',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('zero-arg call on a non-function value still errors', () => {
    const src = [
      'const n = 5;',
      'const x = n ();',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});
