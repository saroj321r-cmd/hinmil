// JavaScript hoists `function` declarations to the top of their enclosing
// function/block scope. Trampoline-style code (modeled on fpkit's
// RTask.chainRec) defines a callback closure first and the worker function
// below it — the two are mutually recursive:
//
//   const onResolve = s => { ... go (s.value); ... };
//   function go(acc) { ... onResolve ... }
//   go (value0);
//
// Previously `go` inside `onResolve` reported HM1007 "Unbound variable".

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

describe('hoisted function declarations in nested scopes', () => {
  test('closure defined before a sibling function declaration can call it', () => {
    const src = [
      '// trampoline :: Number -> Number',
      'const trampoline = start => {',
      '  let total = 0;',
      '  const onStep = n => {',
      '    if (n > 0) {',
      '      go (n - 1);',
      '    }',
      '  };',
      '  function go(acc) {',
      '    total = total + acc;',
      '    onStep (acc);',
      '  }',
      '  go (start);',
      '  return total;',
      '};',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('annotated hoisted function uses its annotation at the early call site', () => {
    const src = [
      '// run :: () -> Number',
      'const run = () => {',
      '  const first = step ("a");',
      '  // step :: String -> Number',
      '  function step(tag) { return tag.length; }',
      '  return first + step ("bb");',
      '};',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('wrong argument to a hoisted function is still reported', () => {
    const src = [
      '// run :: () -> Number',
      'const run = () => {',
      '  const first = step (5);',
      '  // step :: String -> Number',
      '  function step(tag) { return tag.length; }',
      '  return first;',
      '};',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});
