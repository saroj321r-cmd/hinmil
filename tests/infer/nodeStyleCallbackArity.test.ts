// Node-style variadic wrappers: `fromNode :: ((..., (e, a) -> ()) -> *) -> * -> Task r e a`
// (modeled on fpkit's RTask.fromNode).  Two JS-isms must hold when a node-style
// function is passed as a non-literal argument:
//
//   1. The `...` spread in the expected parameter tuple absorbs any number of
//      leading parameters of the actual function (nodeAdd takes (a, b, cb)).
//   2. A provided function may declare FEWER callback parameters than the slot
//      supplies (nodeFail's `cb` is only ever called with the error — JS simply
//      leaves the value parameter undefined).  This tolerance must hold for the
//      NESTED callback parameter too, not just the top level.

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
  '// fromNode :: ((..., (e, a) -> ()) -> *) -> * -> Task r e a',
  'const fromNode = fn => (...args) =>',
  '  new Task ((rej, res, _env) => {',
  '    fn (...args, (err, val) => err ? rej (err) : res (val));',
  '  });',
  '',
].join('\n');

describe('node-style callbacks through a variadic (..., cb) annotation', () => {
  test('multi-arg node function: spread absorbs the leading params', () => {
    const src = TASK + [
      'const nodeAdd = (a, b, cb) => cb (null, a + b);',
      'const t = fromNode (nodeAdd) (1, 2);',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('callback declared with fewer params than the slot supplies', () => {
    const src = TASK + [
      'const nodeFail = cb => cb ("err");',
      'const t = fromNode (nodeFail) ();',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('a non-function argument still errors', () => {
    const src = TASK + [
      'const t = fromNode (42) ();',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});
