// Fan-out combinators (converge / combine), spread-arrow chains and the
// mixed-arity union soundness gate.  These exercise the functional-pattern
// recognition centralised in `src/infer/functionPatterns.ts` plus the
// supporting unification rules.
//
//   converge :: Foldable f => f (x1 -> x2 -> ... -> z, a -> x1, a -> x2, ...) -> a -> z
//   combine  :: (Foldable f, Applicative m) => f (x1 -> ... -> z, a -> m x1, ...) -> a -> m z
//
// A fan-out call links each branch positionally to one parameter of the HEAD
// combiner: branch k must produce combiner-param k from the shared input `a`.

import { InferenceEngine } from '../../src/infer';
import { prettyTypeToString, Type } from '../../src/hm/types';

function run(src: string, bindName: string): { type: Type | null; diags: string[] } {
  const r = new InferenceEngine().infer(src);
  const needle = `const ${bindName} = `;
  const off = src.indexOf(needle) + 'const '.length;
  const entry = r.nodeTypes.get(off);
  // Filter the unresolved-`require` / unknown-constraint noise the harness has
  // no bindings for; keep every real type diagnostic.
  const diags = r.diagnostics
    .map((d) => d.message)
    .filter((m) => !/require|Unknown constraint/.test(m));
  return { type: entry ? r.substitution.apply(entry.type) : null, diags };
}

const CONVERGE = `
// coerce :: a -> b
const coerce = v => v;
// converge :: Foldable f => f (x1 -> x2 -> ... -> z, a -> x1, a -> x2, ...) -> a -> z
const converge = fns => value => coerce(value);
// add :: Number -> Number -> Number -> Number
const add = x => y => z => x + y + z;
`;

const COMBINE = `
// coerce :: a -> b
const coerce = v => v;
// combine :: (Foldable f, Applicative m) => f (x1 -> x2 -> ... -> z, a -> m x1, a -> m x2, ...) -> a -> m z
const combine = fns => value => coerce(value);
// add :: Number -> Number -> Number -> Number
const add = x => y => z => x + y + z;
// Id :: a -> Id a
const Id = v => ({ value: v });
`;

describe('fan-out combinator — converge', () => {
  test('the annotated signature alone parses without diagnostics', () => {
    const { diags } = run(CONVERGE, 'converge');
    expect(diags).toEqual([]);
  });

  test('heterogeneous fan-out with matching arity yields the terminal result', () => {
    const src = `${CONVERGE}\nconst n = converge([add, x => x + 1, x => x + 2, x => x + 3])(1);\n`;
    const { type, diags } = run(src, 'n');
    expect(prettyTypeToString(type!)).toBe('Number');
    expect(diags).toEqual([]);
  });

  test('too few branches for the combiner arity is reported', () => {
    const src = `${CONVERGE}\nconst bad = converge([add, x => x + 1, x => x + 2])(1);\n`;
    const { diags } = run(src, 'bad');
    expect(diags.some((m) => /fan-out combiner takes 3 arguments, but 2 branches/.test(m))).toBe(true);
  });

  test('too many branches for the combiner arity is reported', () => {
    const src = `${CONVERGE}\nconst bad = converge([add, x => x + 1, x => x + 2, x => x + 3, x => x + 4])(1);\n`;
    const { diags } = run(src, 'bad');
    expect(diags.some((m) => /fan-out combiner takes 3 arguments, but 4 branches/.test(m))).toBe(true);
  });
});

describe('fan-out combinator — combine (Applicative lifting)', () => {
  test('branches producing `m xk` yield an `m z` result', () => {
    const src = `${COMBINE}\nconst c = combine([add, x => Id(x + 1), x => Id(x + 2), x => Id(x + 3)])(1);\n`;
    const { type, diags } = run(src, 'c');
    expect(prettyTypeToString(type!)).toBe('Id Number');
    expect(diags).toEqual([]);
  });
});

// The fan-out path bypasses ordinary parameter/argument unification, so the
// Foldable container `f` is bound to `Array` explicitly (the argument is an
// array literal).  This keeps the container's declared constraints —
// `Monoid (f a)` here — enforced, exactly as they are for a simple `f a`
// parameter such as `tail :: (Foldable f, Monoid (f a)) => f a -> Maybe (f a)`.
const CONVERGE_MONOID = `
// coerce :: a -> b
const coerce = v => v;
// ::constraint Monoid m { m :: { empty :: () -> m } }
// converge :: (Foldable f, Monoid (f a)) => f (x1 -> x2 -> ... -> z, a -> x1, a -> x2, ...) -> a -> z
const converge = fns => value => coerce(value);
// add :: Number -> Number -> Number -> Number
const add = x => y => z => x + y + z;
`;

describe('fan-out combinator — container constraint enforcement', () => {
  test('Monoid constraint on the container fires when Array lacks `empty`', () => {
    const src = `${CONVERGE_MONOID}\nconst n = converge([add, x => x + 1, x => x + 2, x => x + 3])(1);\n`;
    const { diags } = run(src, 'n');
    expect(
      diags.some((m) => /Type 'Array' does not satisfy constraint 'Monoid'/.test(m)),
    ).toBe(true);
  });

  test('Monoid constraint is satisfied when a `::rep` supplies Array#empty', () => {
    const REP = '// Array.empty :: () -> Array a\n// ::rep Monoid Array.empty\n';
    const src = `${REP}${CONVERGE_MONOID}\nconst n = converge([add, x => x + 1, x => x + 2, x => x + 3])(1);\n`;
    const { diags } = run(src, 'n');
    expect(diags.some((m) => /does not satisfy constraint 'Monoid'/.test(m))).toBe(false);
  });
});

describe('mixed-arity function-array union — soundness gate', () => {
  const RUN1 = `
// runAll :: Array (Number -> Number) -> Number
const runAll = fns => 0;
`;

  test('a widened array of differing arities is rejected where one arity is expected', () => {
    const src = `${RUN1}\nconst arr = [x => x + 1, x => y => x + y];\nconst r = runAll(arr);\n`;
    const { diags } = run(src, 'r');
    expect(diags.some((m) => /Cannot unify/.test(m))).toBe(true);
  });

  test('a same-arity function array is still accepted', () => {
    const src = `${RUN1}\nconst arr = [x => x + 1, x => x * 2];\nconst r = runAll(arr);\n`;
    const { diags } = run(src, 'r');
    expect(diags).toEqual([]);
  });
});
