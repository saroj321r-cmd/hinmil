// Built-in methods whose trailing argument(s) are optional in JS must be
// callable WITHOUT those arguments — e.g. `arr.sort()` (no comparator),
// `arr.reduce(fn)` (no seed), `str.split(",")` (no limit).  These are modelled
// by typing the optional slot(s) as `T | Undefined` in the method registry.
//
// Each row asserts the short call shape type-checks (no error diagnostics),
// while the full call shape keeps working and the result type is unchanged.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString } from '../../src/hm/types';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  clearCustomMethods();
  engine = new InferenceEngine();
});

// Ignore non-error severities (hints/unused) — we only care about hard errors.
const errors = (r: ReturnType<InferenceEngine['infer']>) =>
  r.diagnostics.filter(d => d.severity !== 3 && !d.message.includes('Unused'));

interface Case {
  desc: string;
  src: string;
  /** optional [binding, expectedPrettyType] check */
  binding?: [string, string];
}

const runOk = ({ src, binding }: Case) => {
  const r = engine.infer(src);
  expect(errors(r).map(d => d.message)).toEqual([]);
  if (binding) {
    const [name, ty] = binding;
    expect(prettyTypeToString(r.topLevelBindings.get(name)!.type)).toBe(ty);
  }
};

const asEach = (cases: Case[]): [string, Case][] => cases.map(c => [c.desc, c]);

describe('optional-argument built-in methods', () => {

  describe('Array — optional trailing arguments may be omitted', () => {
    test.each(asEach([
      // sort: comparator optional
      { desc: 'sort() without comparator',  src: 'const a = [3, 1, 2]; const r = a.sort();',                 binding: ['r', '[Number]'] },
      { desc: 'sort(fn) with comparator',   src: 'const a = [3, 1, 2]; const r = a.sort((x, y) => x - y);',  binding: ['r', '[Number]'] },

      // reduce / reduceRight: initial value optional
      { desc: 'reduce(fn) without seed',        src: 'const a = [1, 2, 3]; const r = a.reduce((acc, x) => acc + x);',       binding: ['r', 'Number'] },
      { desc: 'reduce(fn, init) with seed',     src: 'const a = [1, 2, 3]; const r = a.reduce((acc, x) => acc + x, 0);',    binding: ['r', 'Number'] },
      { desc: 'reduceRight(fn) without seed',   src: 'const a = [1, 2, 3]; const r = a.reduceRight((acc, x) => acc + x);',  binding: ['r', 'Number'] },

      // indexOf / lastIndexOf / includes: fromIndex optional
      { desc: 'indexOf(x)',            src: 'const a = [1, 2, 3]; const r = a.indexOf(2);',     binding: ['r', 'Number'] },
      { desc: 'indexOf(x, fromIndex)', src: 'const a = [1, 2, 3]; const r = a.indexOf(2, 1);',  binding: ['r', 'Number'] },
      { desc: 'lastIndexOf(x)',        src: 'const a = [1, 2, 3]; const r = a.lastIndexOf(2);', binding: ['r', 'Number'] },
      { desc: 'includes(x)',           src: 'const a = [1, 2, 3]; const r = a.includes(2);',    binding: ['r', 'Boolean'] },
      { desc: 'includes(x, from)',     src: 'const a = [1, 2, 3]; const r = a.includes(2, 1);', binding: ['r', 'Boolean'] },

      // splice: deleteCount optional
      { desc: 'splice(start)',              src: 'const a = [1, 2, 3]; const r = a.splice(1);',    binding: ['r', '[Number]'] },
      { desc: 'splice(start, deleteCount)', src: 'const a = [1, 2, 3]; const r = a.splice(1, 2);', binding: ['r', '[Number]'] },

      // fill / copyWithin: start & end optional
      { desc: 'fill(value)',            src: 'const a = [1, 2, 3]; const r = a.fill(0);',      binding: ['r', '[Number]'] },
      { desc: 'fill(value, start)',     src: 'const a = [1, 2, 3]; const r = a.fill(0, 1);',   binding: ['r', '[Number]'] },
      { desc: 'fill(value, start, end)', src: 'const a = [1, 2, 3]; const r = a.fill(0, 1, 2);', binding: ['r', '[Number]'] },
      { desc: 'copyWithin(target)',     src: 'const a = [1, 2, 3]; const r = a.copyWithin(0);', binding: ['r', '[Number]'] },

      // join: separator optional
      { desc: 'join()',     src: 'const a = [1, 2, 3]; const r = a.join();',    binding: ['r', 'String'] },
      { desc: 'join(sep)',  src: 'const a = [1, 2, 3]; const r = a.join("-");', binding: ['r', 'String'] },
    ]))('%s', (_d, c) => runOk(c));
  });

  describe('String — optional trailing arguments may be omitted', () => {
    test.each(asEach([
      // split: separator & limit optional
      { desc: 'split()',           src: 'const s = "a,b"; const r = s.split();',      binding: ['r', '[String]'] },
      { desc: 'split(sep)',        src: 'const s = "a,b"; const r = s.split(",");',   binding: ['r', '[String]'] },
      { desc: 'split(sep, limit)', src: 'const s = "a,b"; const r = s.split(",", 1);', binding: ['r', '[String]'] },

      // indexOf / includes / startsWith / endsWith: position optional
      { desc: 'indexOf(x)',         src: 'const s = "abc"; const r = s.indexOf("b");',       binding: ['r', 'Number'] },
      { desc: 'indexOf(x, pos)',    src: 'const s = "abc"; const r = s.indexOf("b", 1);',    binding: ['r', 'Number'] },
      { desc: 'includes(x)',        src: 'const s = "abc"; const r = s.includes("b");',      binding: ['r', 'Boolean'] },
      { desc: 'startsWith(x)',      src: 'const s = "abc"; const r = s.startsWith("a");',    binding: ['r', 'Boolean'] },
      { desc: 'startsWith(x, pos)', src: 'const s = "abc"; const r = s.startsWith("b", 1);', binding: ['r', 'Boolean'] },
      { desc: 'endsWith(x)',        src: 'const s = "abc"; const r = s.endsWith("c");',      binding: ['r', 'Boolean'] },

      // padStart / padEnd: padString optional
      { desc: 'padStart(len)',       src: 'const s = "a"; const r = s.padStart(3);',      binding: ['r', 'String'] },
      { desc: 'padStart(len, pad)',  src: 'const s = "a"; const r = s.padStart(3, "x");', binding: ['r', 'String'] },
      { desc: 'padEnd(len)',         src: 'const s = "a"; const r = s.padEnd(3);',        binding: ['r', 'String'] },

      // normalize: form optional
      { desc: 'normalize()',      src: 'const s = "a"; const r = s.normalize();',      binding: ['r', 'String'] },
      { desc: 'normalize(form)',  src: 'const s = "a"; const r = s.normalize("NFC");', binding: ['r', 'String'] },

      // charAt: index optional
      { desc: 'charAt()',   src: 'const s = "abc"; const r = s.charAt();',  binding: ['r', 'String'] },
      { desc: 'charAt(i)',  src: 'const s = "abc"; const r = s.charAt(1);', binding: ['r', 'String'] },
    ]))('%s', (_d, c) => runOk(c));
  });

  describe('chaining keeps working after an omitted optional argument', () => {
    test('sort().map(...) chains', () => {
      const r = engine.infer('const a = [3, 1, 2]; const r = a.sort().map(n => n + 1);');
      expect(errors(r).map(d => d.message)).toEqual([]);
      expect(prettyTypeToString(r.topLevelBindings.get('r')!.type)).toBe('[Number]');
    });

    test('split(",") then join() chains', () => {
      const r = engine.infer('const s = "a,b,c"; const r = s.split(",").join();');
      expect(errors(r).map(d => d.message)).toEqual([]);
      expect(prettyTypeToString(r.topLevelBindings.get('r')!.type)).toBe('String');
    });
  });
});
