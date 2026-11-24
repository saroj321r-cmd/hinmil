// A function body that can only exit by throwing never produces a value, so
// its return type must stay unconstrained (bottom) instead of `()`.
// Modeled on fpkit's RTask.try spec:
//
//   await expect (fork (RTask.try (() => { throw "boom"; }))).rejects.toBe (...)
//
// Previously the throw-only thunk inferred `() -> ()`, which failed against
// `try :: (() -> a) -> RTask r Error a` once `a` was pinned elsewhere.

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
  '// Task.try :: (() -> a) -> Task r Error a',
  'Task.try = function (thunk) {',
  '  return new Task ((rej, res, _env) => {',
  '    try { res (thunk ()); } catch (e) { rej (e); }',
  '  });',
  '};',
  '',
].join('\n');

describe('throw-only function bodies are bottom-typed', () => {
  test('throw-only thunk satisfies a pinned `() -> a` slot', () => {
    const src = TASK + [
      '// t :: Task r Error Number',
      'const t = Task.try (() => { throw "boom"; });',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('if/else where both branches throw is also bottom', () => {
    const src = TASK + [
      '// t :: Task r Error String',
      'const t = Task.try (() => {',
      '  if (Math.random () > 0.5) { throw "left"; } else { throw "right"; }',
      '});',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('a body that merely MAY throw still returns ()', () => {
    const src = [
      '// f :: Number -> ()',
      'const f = n => {',
      '  if (n > 0) { throw "positive"; }',
      '};',
      '// bad :: Number -> Number',
      'const bad = n => {',
      '  if (n > 0) { throw "positive"; }',
      '};',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});
