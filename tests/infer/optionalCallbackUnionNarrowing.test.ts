// Optional-callback built-in slots are modelled as a union with `Undefined`
// (e.g. `Array#sort :: (((String, String) -> Number) | Undefined) -> [String]`).
// When a function LITERAL is supplied to such a slot, the union must be
// narrowed to its single callable branch BEFORE the arrow body is inferred, so
// the arrow's parameters pick up their contextual types (here `String`) even
// while the body is still incomplete / has the "wrong" return type.
//
// Without narrowing, the params stayed fresh vars and only got back-propagated
// by a whole-function unify against the union — which fails atomically while
// the user is still typing the comparator (e.g. `(a, b) => a`), wiping out all
// hover/completion help inside the body.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString, Type } from '../../src/hm/types';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  clearCustomMethods();
  engine = new InferenceEngine();
});

/** Resolve the recorded node type at `offset` to its pretty string. */
const typeAt = (offset: number): string | null => {
  const nt = (engine as unknown as { nodeTypes: Map<number, { type: Type }> }).nodeTypes;
  const hit = nt.get(offset);
  return hit ? prettyTypeToString(engine.subst.apply(hit.type)) : null;
};

describe('optional-callback union narrowing to a function literal', () => {
  // The comparator param `a` must be `String` even when the arrow body does not
  // (yet) return the expected `Number` — the situation while the user types.
  test.each([
    ['expression body returning the param', `const o = {}; const r = Object.keys(o).sort((a, b) => a);`],
    ['bare param (still typing)',            `const o = {}; const r = Object.keys(o).sort((a, b) => a )`],
    ['member access (completion trigger)',   `const o = {}; const r = Object.keys(o).sort((a, b) => a.length);`],
    ['correct comparator',                   `const o = {}; const r = Object.keys(o).sort((a, b) => a.localeCompare(b));`],
  ])('param `a` is String — %s', (_desc, src) => {
    engine.infer(src);
    const paramAOffset = src.indexOf('(a, b)') + 1;
    expect(typeAt(paramAOffset)).toBe('String');
  });

  test('correct comparator produces no diagnostics and keeps [String] result', () => {
    const src = `const o = {}; const r = Object.keys(o).sort((a, b) => a.localeCompare(b));`;
    const r = engine.infer(src);
    const hard = r.diagnostics.filter(d => d.severity !== 3 && !d.message.includes('Unused'));
    expect(hard.map(d => d.message)).toEqual([]);
    expect(prettyTypeToString(r.topLevelBindings.get('r')!.type)).toBe('[String]');
  });

  test('numeric array comparator params narrow to Number', () => {
    const src = `const a = [3, 1, 2]; const r = a.sort((x, y) => x);`;
    engine.infer(src);
    const paramXOffset = src.indexOf('(x, y)') + 1;
    expect(typeAt(paramXOffset)).toBe('Number');
  });
});
