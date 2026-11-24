import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';

beforeEach(() => resetTypeVarCounter());

const preamble = `
// ::constraint Applicative f { f :: { of :: a -> f a } }
// Identity :: a -> Identity a
const Identity = (value) => ({ value, of: (a) => Identity(a) });
// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);
`;

describe('curried TypeRep witness application (issue 6)', () => {
  test('`of(A)(x)` resolves to `f a`, not a spurious `f a a`', () => {
    const src = preamble + `
// of :: Applicative f => TypeRep f -> a -> f a
const of = (TR) => (a) => TR.of(a);

const r = of(Identity)(42);
`;
    const engine = new InferenceEngine();
    const res = engine.infer(src);
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    const off = src.indexOf('const r = ') + 'const '.length;
    const entry = (res as any).nodeTypes.get(off);
    expect(entry).toBeDefined();
    expect(typeToString(entry.type)).toBe('Identity Number');
  });

  test('a `traverse`-style witness where `f` meets varying args still type-checks', () => {
    // `f` is applied to both `b` and `(t b)`; the TypeRep param must NOT be
    // baked to a single application form (that would be unsound).
    const src = `
// ::constraint Applicative f { f :: { of :: a -> f a } }
// traverse :: Applicative f => TypeRep f -> (a -> f b) -> [a] -> f [b]
const traverse = (TR) => (fn) => (xs) => TR.of(xs);
`;
    const engine = new InferenceEngine();
    const res = engine.infer(src);
    // No spurious "Cannot unify 'f b' with 'f'" cascade.
    expect(res.diagnostics.some(d => /Cannot unify 'f b'/.test(d.message))).toBe(false);
  });
});
