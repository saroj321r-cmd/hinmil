import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import { getDotCompletions, CompletionContext } from '../../src/services/completion';
import type { Type } from '../../src/hm/types';

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
});

function makeCtx(): CompletionContext {
  return {
    engine: new InferenceEngine(),
    createImportResolver: () => () => null,
    createTypeDirectiveResolver: () => () => null,
    inferFileAndCacheExports: () => null,
    inferredTypeStyle: 'pretty',
  } as CompletionContext;
}

function typeAtToken(src: string, res: any, token: string): string | null {
  const off = src.indexOf(token);
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

// fpkit Arrow#second shape: a `~>` method whose return type uses a constructor
// constraint `Pair p => ... -> Arrow (p c a) (p c b)`.  The inner closure
// parameter `pair` must behave as a `Pair`: resolve to a `Pair` type, expose
// its instance methods, and offer them in completion.
const SRC = `"use strict";
// Pair :: (a, b) -> Pair a b
function Pair(fst, snd) { this.fst = fst; this.snd = snd; }
// Pair#swap :: Pair a b ~> () -> Pair b a
Pair.prototype.swap = function () { return new Pair(this.snd, this.fst); };

// Arrow :: (a -> b) -> Arrow a b
function Arrow(run) { this.run = run; }
// Arrow#second :: Pair p => Arrow a b ~> () -> Arrow (p c a) (p c b)
Arrow.prototype.second = function () {
  return new Arrow((pair) => pair.swap());
};
`;

describe('constructor-as-constraint method param behaves as the constructor (p9)', () => {
  test('inner `pair` param resolves to a `Pair`, not `p c a`', () => {
    const engine = new InferenceEngine();
    const res = engine.infer(SRC);
    const paramType = typeAtToken(SRC, res, 'pair');
    expect(paramType).toContain('Pair');
    expect(paramType).not.toMatch(/\bp c a\b/);
  });

  test('accessing a Pair instance method on `pair` does not raise a constraint error', () => {
    const engine = new InferenceEngine();
    const res = engine.infer(SRC);
    const offending = res.diagnostics.filter((d: any) =>
      /does not exist on constraint 'Pair'/.test(d.message),
    );
    expect(offending.map((d: any) => d.message)).toEqual([]);
  });

  test('completion on `pair.` offers Pair instance methods', () => {
    const dotIdx = SRC.indexOf('pair.swap()') + 'pair'.length;
    const items = getDotCompletions(SRC, dotIdx + 1, dotIdx, 'file:///t.js', makeCtx());
    expect(items.some((i: any) => i.label === 'swap')).toBe(true);
  });
});

// Now that the constructor-constrained method parameter behaves as a real
// `Pair`, MISUSING one of its components must be type-checked.  fpkit Arrow
// shape: `bimap :: Bifunctor f => (a -> c) -> (b -> d) -> f a b -> f c d`
// expects a bifunctor in its 3rd argument.  Passing the whole `pair` is
// correct; passing `pair.fst` (the first component, not a bifunctor) is an
// error that must surface.
function bifunctorSrc(thirdArg: string): string {
  return `"use strict";
// ::constraint Bifunctor f { f :: { bimap :: f a b ~> (a -> c) -> (b -> d) -> f c d } }
// Pair :: (a, b) -> Pair a b
function Pair(fst, snd) {
  // Pair#fst :: a
  this.fst = fst;
  // Pair#snd :: b
  this.snd = snd;
}
// Pair#bimap :: Pair a b ~> (a -> c) -> (b -> d) -> Pair c d
Pair.prototype.bimap = function (leftFn) { return rightFn => new Pair(leftFn(this.fst), rightFn(this.snd)); };
// identity :: a -> a
const identity = (x) => x;
// bimap :: Bifunctor f => (a -> c) -> (b -> d) -> f a b -> f c d
const bimap = leftFn => rightFn => bifunctor => bifunctor.bimap(leftFn)(rightFn);
// Arrow :: (a -> b) -> Arrow a b
function Arrow(run) { this.run = run; }
// Arrow#second :: Pair p => Arrow a b ~> () -> Arrow (p c a) (p c b)
Arrow.prototype.second = function () {
  return new Arrow(${thirdArg});
};
`;
}

describe('constructor-as-constraint param component misuse is type-checked (Wave 3)', () => {
  test('passing the whole `pair` (a Pair) to a Bifunctor slot is clean', () => {
    const engine = new InferenceEngine();
    const res = engine.infer(bifunctorSrc('pair => bimap(identity)(this.run)(pair)'));
    expect(res.diagnostics.map((d: any) => d.message)).toEqual([]);
  });

  test('passing `pair.fst` (a non-Bifunctor component) to a Bifunctor slot raises a diagnostic', () => {
    const engine = new InferenceEngine();
    const res = engine.infer(bifunctorSrc('pair => bimap(identity)(this.run)(pair.fst)'));
    expect(res.diagnostics.length).toBeGreaterThan(0);
  });

  test('the Pair constructor with shorthand `#fst`/`#snd` fields raises no spurious self-mismatch', () => {
    const engine = new InferenceEngine();
    const res = engine.infer(`"use strict";
// Pair :: (a, b) -> Pair a b
function Pair(fst, snd) {
  // Pair#fst :: a
  this.fst = fst;
  // Pair#snd :: b
  this.snd = snd;
}
`);
    expect(res.diagnostics.map((d: any) => d.message)).toEqual([]);
  });
});

