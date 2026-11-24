// A chained static assignment `_Task.ask = Task.ask = fn` annotates only the
// OUTER dotted name (`_Task.ask`).  The inner target (`Task.ask`) used to be
// registered with the *inferred implementation type*, so call sites reaching
// the static through the inner constructor name (which is how a module's
// default export resolves statics) saw `(r -> a) -> Task (a | r) e a` instead
// of the annotated overload union — making `Task.ask ()` fail with
// "Cannot unify 'Undefined' with 'r -> a'" (fpkit's RTask.ask via require).
//
// The annotation must propagate to every chained inner dotted target.

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

const TASK = [
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
  '// _Task.ask :: () -> Task r e r',
  '// _Task.ask :: (r -> a) -> Task r e a',
  '_Task.ask = Task.ask = function (fn) {',
  '  if (fn == null) {',
  '    return _Task ((_rej, res, env) => res (env));',
  '  }',
  '  return _Task ((_rej, res, env) => res (fn (env)));',
  '};',
  '',
].join('\n');

describe('chained static assignment propagates the annotation to inner names', () => {
  test('zero-arg overload works through the inner constructor name', () => {
    const src = TASK + [
      'const t1 = Task.ask ();',
      'const t2 = Task.ask (env => env.base);',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('zero-arg overload works through the outer name too', () => {
    const src = TASK + [
      'const t1 = _Task.ask ();',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('wrong arguments still error through the inner name', () => {
    const src = TASK + [
      'const bad = Task.ask (1);',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});
