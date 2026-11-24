// A bare alias name and the record expanded from that alias are one type.
//
// An alias name can reach unify unexpanded when it travels inside another
// module's type (a sidecar's `Promise Error (Toast -> ())`, a library's
// `Component` in a list of routes) while the local side was expanded to a
// record tagged with that alias.  They met as "Cannot unify 'Toast' with
// 'Toast'".

import { unify } from '../../src/hm/unify';
import { tCon, tRecord, tString, tNumber, tFun, tVoid } from '../../src/hm/types';

const toast = tRecord({ message: tString, timeout: tNumber }, 'Toast');

describe('alias name and its expanded record', () => {
  test('unify in both orders', () => {
    expect(() => unify(tCon('Toast', []), toast)).not.toThrow();
    expect(() => unify(toast, tCon('Toast', []))).not.toThrow();
  });

  test('also nested in a function type', () => {
    expect(() => unify(tFun(tCon('Toast', []), tVoid), tFun(toast, tVoid))).not.toThrow();
  });

  test('a record of another alias does not', () => {
    expect(() => unify(tCon('Snackbar', []), toast)).toThrow();
  });

  test('a record without an alias does not', () => {
    expect(() => unify(tCon('Toast', []), tRecord({ message: tString, timeout: tNumber }))).toThrow();
  });
});
