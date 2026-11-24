// Two annotations for the same dotted static form an overload union, the
// same way repeated plain-name annotations do (modeled on fpkit's RTask.ask):
//
//   // _RTask.ask :: () -> RTask r e r
//   // _RTask.ask :: (r -> a) -> RTask r e a
//
// Previously the LAST dotted annotation silently replaced the first, so a
// zero-arg call `RTask.ask ()` was checked against `(r -> a) -> ...` and
// errored "Cannot unify 'Undefined' with 'r -> a'".

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
  '// Task.ask :: () -> Task r e r',
  '// Task.ask :: (r -> a) -> Task r e a',
  'Task.ask = function (fn) {',
  '  if (fn == null) {',
  '    return new Task ((_rej, res, env) => res (env));',
  '  }',
  '  return new Task ((_rej, res, env) => res (fn (env)));',
  '};',
  '',
].join('\n');

describe('dotted static annotations merge into overloads', () => {
  test('zero-arg overload is picked for ask ()', () => {
    const src = TASK + [
      'const t1 = Task.ask ();',
      'const t2 = Task.ask (env => env.base);',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('zero-arg call result is a real Task, not the leftover overload union', () => {
    // `Task.ask ()` used as an argument with an expected type: the call must
    // DISPATCH (zero-arg => the `() -> Task r e r` branch) instead of
    // returning the whole overload union as a "partial application".
    const src = TASK + [
      '// forkWith :: r -> Task r e a -> Promise e r',
      'const forkWith = env => task =>',
      '  new Promise ((res, rej) => res (env));',
      'const p1 = forkWith ({ base: 3 }) (Task.ask ());',
      'const p2 = forkWith ({ base: 3 }) (Task.ask (env => env.base + 1));',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('wrong argument against every overload still errors', () => {
    const src = TASK + [
      'const bad = Task.ask (1, 2);',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});
