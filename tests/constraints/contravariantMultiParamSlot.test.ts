// Contravariant (and other constraints) may operate on a NON-rightmost type
// parameter of a multi-parameter ADT.  For `Arrow a b`, Functor's `map`
// transforms the rightmost parameter `b` while Contravariant's `contramap`
// transforms the leftmost parameter `a`.  The constraint-shape matcher must
// accept the leftmost-slot alignment instead of only the Functor-style
// rightmost one — otherwise a valid `Arrow#contramap` is wrongly reported as
// "does not satisfy constraint 'Contravariant': method 'contramap' signature
// does not match constraint shape".

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

function diagsOf(src: string): string[] {
  return engine.infer(src).diagnostics.map(d => d.message);
}

const CONTRAVARIANT =
  '// ::constraint Contravariant f { f :: { contramap :: f a ~> (b -> a) -> f b } }\n';

const ARROW =
  '// Arrow :: (a -> b) -> Arrow a b\n' +
  'function Arrow(run) { this.run = run; }\n' +
  '// Arrow#map :: Arrow a b ~> (b -> c) -> Arrow a c\n' +
  'Arrow.prototype.map = function (fn) { return this; };\n' +
  '// Arrow#contramap :: Arrow a b ~> (c -> a) -> Arrow c b\n' +
  'Arrow.prototype.contramap = function (fn) { return this; };\n';

describe('Contravariant contramap on a multi-parameter ADT (left slot)', () => {
  test('Arrow satisfies Contravariant via its leftmost-parameter contramap', () => {
    const src = CONTRAVARIANT + ARROW +
      '// contramap :: Contravariant f => (b -> a) -> f a -> f b\n' +
      'const contramap = fn => c => c;\n' +
      'const arr = new Arrow(x => x);\n' +
      'const r = contramap(x => x)(arr);\n';
    const diags = diagsOf(src);
    expect(diags.some(m => /does not satisfy constraint 'Contravariant'/.test(m))).toBe(false);
  });

  test('an inconsistent Arrow#contramap is still rejected', () => {
    // Function input `a` instead of the required result var makes no slot
    // alignment linkage-consistent, so the shape mismatch must still fire.
    const src = CONTRAVARIANT +
      '// Arrow :: (a -> b) -> Arrow a b\n' +
      'function Arrow(run) { this.run = run; }\n' +
      '// Arrow#contramap :: Arrow a b ~> (a -> d) -> Arrow d b\n' +
      'Arrow.prototype.contramap = function (fn) { return this; };\n' +
      '// contramap :: Contravariant f => (b -> a) -> f a -> f b\n' +
      'const contramap = fn => c => c;\n' +
      'const arr = new Arrow(x => x);\n' +
      'const r = contramap(x => x)(arr);\n';
    const diags = diagsOf(src);
    expect(diags.some(m => /does not satisfy constraint 'Contravariant'.*constraint shape/.test(m))).toBe(true);
  });
});
