// `let x = null` followed by `x = <value>` is a standard JS initialisation
// idiom (modeled on fpkit's RTask.chainRec sync/async bookkeeping):
//
//   let isSync = null;        // not yet known
//   isSync = true;            // sync step observed
//   if (isSync === null) …    // still pending?
//
// Previously the second line errored: Cannot unify 'Null' with 'Boolean'.
// A null-initialised `let`/`var` now widens to `Null | a`, where `a` is
// pinned by the first non-null assignment; later conflicting assignments
// are still rejected.

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

describe('null-initialised let widening', () => {
  test('tri-state flag: null → true/false with === null guard', () => {
    const src = [
      '// step :: (Boolean -> ()) -> Boolean',
      'const step = notify => {',
      '  let isSync = null;',
      '  const onResolve = ok => {',
      '    if (isSync === null) {',
      '      isSync = true;',
      '    } else {',
      '      notify (ok);',
      '    }',
      '  };',
      '  onResolve (true);',
      '  isSync = false;',
      '  return isSync === null;',
      '};',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('conflicting non-null assignments are still rejected', () => {
    const src = [
      'let current = null;',
      'current = "pending";',
      'current = 42;',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('resetting back to null stays allowed', () => {
    const src = [
      'let handle = null;',
      'handle = "h1";',
      'handle = null;',
      'handle = "h2";',
    ].join('\n');
    const r = infer(src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });
});
