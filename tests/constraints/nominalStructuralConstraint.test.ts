import { resetTypeVarCounter, schemeToString } from '../../src/hm/types';
import { InferenceEngine } from '../../src/infer/index';
import {
  parseConstraintDirective,
  validateConstraintDef,
  clearConstraints,
} from '../../src/registries/constraintRegistry';

beforeEach(() => {
  resetTypeVarCounter();
  clearConstraints();
});

// ===========================================================================
// Directive parsing
// ===========================================================================

describe('parser — `::constraint Name p1 ... pN = self is body` directive', () => {
  test('arity-1 single self-clause parses into selfClauses', () => {
    const def = parseConstraintDirective('::constraint Runnable r { r :: (a -> r) | r }');
    expect(def).not.toBeNull();
    expect(def!.name).toBe('Runnable');
    expect(def!.headerParams).toEqual(['r']);
    expect(def!.typeVar).toBe('r');
    expect(def!.methods).toHaveLength(0);
    expect(def!.selfClauses).toHaveLength(1);
    expect(def!.selfClauses![0].selfParam).toBe('r');
    expect(def!.selfClauses![0].body.tag).toBe('TCon');
    expect((def!.selfClauses![0].body as any).name).toBe('Union');
    expect((def!.selfClauses![0].body as any).args).toHaveLength(2);
  });

  test('arity-2 with extra header param parses', () => {
    const def = parseConstraintDirective('::constraint NumLike a r { r :: (a -> Number) | Number }');
    expect(def).not.toBeNull();
    expect(def!.headerParams).toEqual(['a', 'r']);
    expect(def!.typeVar).toBe('r');
    expect(def!.selfClauses).toHaveLength(1);
    expect(def!.selfClauses![0].selfParam).toBe('r');
  });

  test('single-type body (no union) parses', () => {
    const def = parseConstraintDirective('::constraint Producer r { r :: a -> r }');
    expect(def).not.toBeNull();
    expect(def!.selfClauses![0].body.tag).toBe('TFun');
  });

  test('multiple self-clauses on one line parse', () => {
    const def = parseConstraintDirective(
      '::constraint Indexed r e s { r :: [e] | Map s e, s :: Number | String }'
    );
    expect(def).not.toBeNull();
    expect(def!.headerParams).toEqual(['r', 'e', 's']);
    expect(def!.selfClauses).toHaveLength(2);
    expect(def!.selfClauses![0].selfParam).toBe('r');
    expect(def!.selfClauses![1].selfParam).toBe('s');
  });

  test('rejects when self-param is not a header param', () => {
    const def = parseConstraintDirective('::constraint Bad r { q :: (a -> r) | r }');
    expect(def).toBeNull();
  });

  test('rejects malformed body', () => {
    const def = parseConstraintDirective('::constraint Bad r { r :: ((( }');
    expect(def).toBeNull();
  });

  test('original `{ ... }` form still parses', () => {
    const def = parseConstraintDirective('::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }');
    expect(def).not.toBeNull();
    expect(def!.selfClauses).toBeUndefined();
    expect(def!.methods).toHaveLength(1);
  });

  test('validateConstraintDef accepts any structural body', () => {
    const a = parseConstraintDirective('::constraint StringOrNum v { v :: String | Number }');
    const b = parseConstraintDirective('::constraint Runnable r { r :: (a -> r) | r }');
    expect(validateConstraintDef(a!)).toEqual([]);
    expect(validateConstraintDef(b!)).toEqual([]);
  });
});

// ===========================================================================
// Multi-line `//` continuation (commentParser)
// ===========================================================================

describe('multi-line `::constraint` directives via line-continuation', () => {
  function inferDiags(src: string): string {
    const eng = new InferenceEngine();
    const r = eng.infer(src);
    return r.diagnostics.map(d => d.message).join('\n');
  }

  test('multi-line definition with brace continuation registers correctly', () => {
    const diags = inferDiags(`
// ::constraint Indexed r e s {
//   r :: [e] | Map s e,
//   s :: Number | String
// }

// f :: Indexed [Number] Number Number => [Number] -> Number
const f = (xs) => xs[0];
`);
    expect(diags).not.toMatch(/does not satisfy/);
    expect(diags).not.toMatch(/Unknown constraint/);
  });
});

// ===========================================================================
// Inference — single self-clause forms
// ===========================================================================

describe('inference — single self-clause structural constraints', () => {
  function inferAndGet(src: string, names: string[]): Record<string, string> {
    const eng = new InferenceEngine();
    const r = eng.infer(src);
    const out: Record<string, string> = {};
    out.__diagnostics__ = r.diagnostics.map(d => d.message).join('\n');
    for (const n of names) {
      const sch = r.topLevelBindings.get(n);
      if (sch) out[n] = schemeToString(sch);
    }
    return out;
  }

  test('Runnable union constraint resolves both branches', () => {
    const out = inferAndGet(`
// ::constraint Runnable r { r :: (a -> r) | r }
// Limit :: Runnable r => r -> Limit r
const Limit = (x) => x;

// getLimit :: { limit :: Number } -> Number
const getLimit = p => p.limit;

const a = Limit(5);
const b = Limit(getLimit);
`, ['a', 'b']);
    expect(out.a).toBe('Limit Number');
    expect(out.b).toBe('Limit ({ limit :: Number } -> Number)');
  });

  test('StringOrNum accepts matching primitives', () => {
    const out = inferAndGet(`
// ::constraint StringOrNum v { v :: String | Number }
// pick :: StringOrNum v => v -> v
const pick = x => x;

const s = pick("hello");
const n = pick(42);
`, ['s', 'n']);
    expect(out.s).toBe('String');
    expect(out.n).toBe('Number');
    expect(out.__diagnostics__).not.toMatch(/does not satisfy/);
  });

  test('StringOrNum rejects a Boolean argument', () => {
    const out = inferAndGet(`
// ::constraint StringOrNum v { v :: String | Number }
// pick :: StringOrNum v => v -> v
const pick = x => x;

const b = pick(true);
`, ['b']);
    expect(out.__diagnostics__).toMatch(/does not satisfy union constraint 'StringOrNum'/);
  });

  test('multiple use sites get fresh existentials (no leakage)', () => {
    const out = inferAndGet(`
// ::constraint StringOrNum v { v :: String | Number }
// pick :: StringOrNum v => v -> v
const pick = x => x;

const a = pick("hi");
const b = pick(42);
`, ['a', 'b']);
    expect(out.a).toBe('String');
    expect(out.b).toBe('Number');
    expect(out.__diagnostics__).not.toMatch(/does not satisfy/);
  });

  test('unknown constraint name still produces diagnostic', () => {
    const out = inferAndGet(`
// f :: Bogus x => x -> x
const f = x => x;
`, ['f']);
    expect(out.__diagnostics__).toMatch(/Unknown constraint 'Bogus'/);
  });
});

// ===========================================================================
// Inference — concrete-type self-arg (eager check)
// ===========================================================================

describe('inference — concrete self position (`Runnable Number =>`)', () => {
  function inferAndGet(src: string, names: string[]): Record<string, string> {
    const eng = new InferenceEngine();
    const r = eng.infer(src);
    const out: Record<string, string> = {};
    out.__diagnostics__ = r.diagnostics.map(d => d.message).join('\n');
    for (const n of names) {
      const sch = r.topLevelBindings.get(n);
      if (sch) out[n] = schemeToString(sch);
    }
    return out;
  }

  test('matching concrete type produces no diagnostic', () => {
    const out = inferAndGet(`
// ::constraint Runnable r { r :: (a -> r) | r }
// f :: Runnable Number => Number -> Number
const f = x => x;
const v = f(3);
`, ['f', 'v']);
    expect(out.__diagnostics__).not.toMatch(/does not satisfy/);
    expect(out.f).toBe('Runnable Number => Number -> Number');
    expect(out.v).toBe('Number');
  });

  test('compound concrete type works', () => {
    const out = inferAndGet(`
// ::constraint Listable r { r :: [a] }
// f :: Listable [Number] => [Number] -> Number
const f = (xs) => xs[0];
`, ['f']);
    expect(out.__diagnostics__).not.toMatch(/does not satisfy/);
  });

  test('compound concrete mismatch fails', () => {
    const out = inferAndGet(`
// ::constraint Listable r { r :: [a] }
// f :: Listable Number => Number -> Number
const f = x => x;
`, ['f']);
    expect(out.__diagnostics__).toMatch(/does not satisfy constraint 'Listable'/);
  });
});

// ===========================================================================
// Inference — multi-param header (mixed positional + bound var)
// ===========================================================================

describe('inference — multi-param header (`NumLike String r =>`)', () => {
  function inferAndGet(src: string, names: string[]): Record<string, string> {
    const eng = new InferenceEngine();
    const r = eng.infer(src);
    const out: Record<string, string> = {};
    out.__diagnostics__ = r.diagnostics.map(d => d.message).join('\n');
    for (const n of names) {
      const sch = r.topLevelBindings.get(n);
      if (sch) out[n] = schemeToString(sch);
    }
    return out;
  }

  test('extra header param substitutes positionally; bound var stays polymorphic', () => {
    const out = inferAndGet(`
// ::constraint NumLike a r { r :: (a -> Number) | Number }
// firstNum :: NumLike String r => r -> r
const firstNum = x => x;

const a = firstNum(7);                    // Number -> matches second alt
const b = firstNum((s) => s.length);      // String -> Number -> matches first
`, ['firstNum', 'a', 'b']);
    expect(out.firstNum).toBe('NumLike String r => r -> r');
    expect(out.a).toBe('Number');
    expect(out.b).toBe('String -> Number');
    expect(out.__diagnostics__).not.toMatch(/does not satisfy/);
  });

  test('mismatch on substituted body is rejected', () => {
    const out = inferAndGet(`
// ::constraint NumLike a r { r :: (a -> Number) | Number }
// firstNum :: NumLike String r => r -> r
const firstNum = x => x;

// fn :: Boolean -> Number
const fn = (b) => b ? 1 : 0;
const c = firstNum(fn);
`, ['c']);
    expect(out.__diagnostics__).toMatch(/does not satisfy union constraint 'NumLike'/);
  });

  test('wrong arity at use site produces diagnostic', () => {
    const out = inferAndGet(`
// ::constraint NumLike a r { r :: (a -> Number) | Number }
// f :: NumLike String Number r => r -> r
const f = x => x;
`, ['f']);
    expect(out.__diagnostics__).toMatch(/expects 2 positional type argument.*got 3/);
  });

  test('fully concrete tail also works', () => {
    const out = inferAndGet(`
// ::constraint NumLike a r { r :: (a -> Number) | Number }
// f :: NumLike String Number => Number -> Number
const f = x => x;
const v = f(2);
`, ['f', 'v']);
    expect(out.__diagnostics__).not.toMatch(/does not satisfy/);
    expect(out.v).toBe('Number');
  });
});

// ===========================================================================
// Inference — multiple self-clauses
// ===========================================================================

describe('inference — multiple self-clauses', () => {
  function inferAndGet(src: string, names: string[]): Record<string, string> {
    const eng = new InferenceEngine();
    const r = eng.infer(src);
    const out: Record<string, string> = {};
    out.__diagnostics__ = r.diagnostics.map(d => d.message).join('\n');
    for (const n of names) {
      const sch = r.topLevelBindings.get(n);
      if (sch) out[n] = schemeToString(sch);
    }
    return out;
  }

  test('both clauses must hold; both fully concrete and matching => no error', () => {
    const out = inferAndGet(`
// ::constraint Pair a b { a :: String | Number, b :: Boolean | Number }
// f :: Pair String Number => String -> Number
const f = (s) => s.length;
`, ['f']);
    expect(out.__diagnostics__).not.toMatch(/does not satisfy/);
  });

  test('first clause violated => diagnostic', () => {
    const out = inferAndGet(`
// ::constraint Pair a b { a :: String | Number, b :: Boolean | Number }
// f :: Pair Boolean Number => Boolean -> Number
const f = (b) => b ? 1 : 0;
`, ['f']);
    expect(out.__diagnostics__).toMatch(/does not satisfy constraint 'Pair'/);
  });

  test('second clause violated => diagnostic', () => {
    const out = inferAndGet(`
// ::constraint Pair a b { a :: String | Number, b :: Boolean | Number }
// f :: Pair String String => String -> String
const f = x => x;
`, ['f']);
    expect(out.__diagnostics__).toMatch(/does not satisfy constraint 'Pair'/);
  });
});
