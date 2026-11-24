import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

describe('`new`-strictness diagnostics', () => {
  test('warns on calling a `function`-style constructor without `new`', () => {
    const r = engine.infer(`
// Pair :: (a, b) -> Pair a b
function Pair(fst, snd) {
  this.fst = fst;
  this.snd = snd;
}
const p = Pair(1, 2);
    `);
    expect(r.diagnostics.some(d =>
      d.message.includes("Constructor 'Pair' must be called with 'new'")
    )).toBe(true);
  });

  test('does NOT warn on `new` for function-this constructor', () => {
    const r = engine.infer(`
// Pair :: (a, b) -> Pair a b
function Pair(fst, snd) {
  this.fst = fst;
  this.snd = snd;
}
const p = new Pair(1, 2);
    `);
    expect(r.diagnostics.filter(d => d.message.includes("must be called with 'new'"))).toHaveLength(0);
  });

  test('warns on `new` for arrow-function factory', () => {
    const r = engine.infer(`
// Pair :: (a, b) -> { fst :: a, snd :: b }
const Pair = (fst, snd) => ({ fst, snd });
const p = new Pair(1, 2);
    `);
    expect(r.diagnostics.some(d =>
      d.message.includes("Cannot use 'new' with arrow-function factory 'Pair'")
    )).toBe(true);
  });

  test('does NOT warn on plain call of arrow factory', () => {
    const r = engine.infer(`
// Pair :: (a, b) -> { fst :: a, snd :: b }
const Pair = (fst, snd) => ({ fst, snd });
const p = Pair(1, 2);
    `);
    expect(r.diagnostics.filter(d =>
      d.message.includes("Cannot use 'new'") || d.message.includes("must be called with 'new'")
    )).toHaveLength(0);
  });

  test('sumtype variant calls without `new` are exempt', () => {
    const r = engine.infer(`
// Either :: Left e | Right a
function Left(value) { this.value = value; }
function Right(value) { this.value = value; }
// Left :: e -> Either e a
// Right :: a -> Either e a

const r1 = Right(42);
const l1 = Left("err");
    `);
    expect(r.diagnostics.filter(d => d.message.includes("must be called with 'new'"))).toHaveLength(0);
  });

  test("arrow-factory's `.constructor` is typed as Object, not the factory", () => {
    const r = engine.infer(`
// Pair :: (a, b) -> Pair a b
const Pair = (fst, snd) => ({ fst, snd });
const p = Pair(1, 2);
const c = p.constructor;
    `);
    const scheme = r.topLevelBindings.get('c');
    expect(scheme).toBeDefined();
    expect(scheme!.type).toMatchObject({ tag: 'TCon', name: 'Object' });
  });
});
