import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import type { Type } from '../../src/hm/types';

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
});

function typeAtToken(src: string, res: any, token: string, fromIndex = 0): string | null {
  const off = src.indexOf(token, fromIndex);
  if (off < 0) return null;
  let best: { type: Type } | null = null;
  let bestStart = -1;
  for (const [start, entry] of res.nodeTypes.entries()) {
    const end = (entry as { end?: number }).end ?? start;
    if (start <= off && off < end && start > bestStart) {
      bestStart = start;
      best = entry as { type: Type };
    }
  }
  return best ? typeToString(res.substitution.apply(best.type)) : null;
}

// A shorthand field annotation (`Pair#fst :: a`) names a declared type
// parameter of its owning constructor (`Pair :: (a, b) -> Pair a b`).  Reading
// the field must align that parameter to the receiver's ACTUAL type argument
// rather than minting a fresh, disconnected variable.
describe('shorthand field annotations align to receiver type arguments', () => {
  const SRC = `"use strict";
// Pair :: (a, b) -> Pair a b
function Pair(fst, snd) {
  // Pair#fst :: a
  this.fst = fst;
  // Pair#snd :: b
  this.snd = snd;
}
// p :: Pair Number String
const p = new Pair(1, "x");
const first = p.fst;
const second = p.snd;
`;

  test('first component resolves to the first type argument (Number)', () => {
    const engine = new InferenceEngine();
    const res = engine.infer(SRC);
    expect(typeAtToken(SRC, res, 'first')).toBe('Number');
  });

  test('second component resolves to the second type argument (String)', () => {
    const engine = new InferenceEngine();
    const res = engine.infer(SRC);
    expect(typeAtToken(SRC, res, 'second')).toBe('String');
  });

  test('the constructor itself raises no spurious self-mismatch', () => {
    const engine = new InferenceEngine();
    const res = engine.infer(SRC);
    const mismatches = res.diagnostics.filter((d: any) =>
      /but annotation expects/.test(d.message),
    );
    expect(mismatches.map((d: any) => d.message)).toEqual([]);
  });
});
