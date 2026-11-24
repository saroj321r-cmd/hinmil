// A `catch (e)` binding must be the same `Error` type the builtin Error
// constructors produce, so `rej (e)` type-checks against an annotation slot
// declared as `Error` (modeled on fpkit's `RTask.try`):
//
//   // _Task.try :: (() -> a) -> Task r Error a
//   _Task.try = thunk => _Task ((rej, res, _env) => {
//     try { res (thunk ()); } catch (thrown) { rej (thrown); }
//   });
//
// Previously catch typed `e` as a structural record tagged 'Error', which
// printed identically but failed rigid unification with TCon('Error').

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
].join('\n');

describe('catch parameter unifies with annotated Error slots', () => {
  test('rej(e) in catch matches a `Task r Error a` annotation', () => {
    const src = TASK + [
      '// _Task.try :: (() -> a) -> Task r Error a',
      '_Task.try = function (thunk) {',
      '  return _Task ((rej, res, _env) => {',
      '    try { res (thunk ()); } catch (thrown) { rej (thrown); }',
      '  });',
      '};',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('catch parameter still exposes message/name/stack', () => {
    const src = [
      '// describe_ :: (() -> a) -> String',
      'const describe_ = thunk => {',
      '  try { thunk (); return "ok"; } catch (e) { return e.message + e.name; }',
      '};',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('wrong use of the error slot is still rejected', () => {
    const src = TASK + [
      '// _Task.try :: (() -> a) -> Task r String a',
      '_Task.try = function (thunk) {',
      '  return _Task ((rej, res, _env) => {',
      '    try { res (thunk ()); } catch (thrown) { rej (thrown); }',
      '  });',
      '};',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});
