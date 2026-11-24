// Task-library fork/cancel idioms (modeled on fpkit's RTask):
//
//   1. A method annotated `-> * | (() -> ())` — the bare wildcard absorbs
//      the union, so the returned cancel handle is callable.
//   2. `new Promise (res => setTimeout (res, 15))` — the executor's return
//      value is ignored at runtime, so a non-`()` return must not error.
//   3. The forkWith bridge `env => task => new Promise ((res, rej) =>
//      task.fork (rej, res, env))` checks against its annotation.

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
  '  // Task#fork :: Task r e a ~> (e -> (), a -> (), r) -> * | (() -> ())',
  '  this.fork = fork;',
  '}',
  '',
  '// Task.of :: a -> Task r e a',
  'Task.of = function (x) { return new Task ((_rej, res, _env) => res (x)); };',
  '',
].join('\n');

describe('task fork/cancel idioms', () => {
  test('cancel handle from a `* | (() -> ())` fork is callable (idempotent cancel)', () => {
    const src = TASK + [
      '// delay :: Number -> a -> Task r e a',
      'const delay = ms => x => new Task ((_rej, res, _env) => {',
      '  const t = setTimeout (() => res (x), ms);',
      '  return () => clearTimeout (t);',
      '});',
      '',
      'const task = delay (5) (1);',
      'const cancel = task.fork (e => {}, v => {}, undefined);',
      'cancel ();',
      'cancel ();',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('Promise executor may return a non-() value (setTimeout handle)', () => {
    const src = [
      '// sleep :: Number -> Promise e ()',
      'const sleep = ms => new Promise (res => setTimeout (res, ms));',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('forkWith bridge checks against its annotation', () => {
    const src = TASK + [
      '// forkWith :: r -> Task r e a -> Promise e a',
      'const forkWith = env => task => new Promise ((res, rej) => task.fork (rej, res, env));',
      '',
      'const p = forkWith (undefined) (Task.of (3));',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });
});
