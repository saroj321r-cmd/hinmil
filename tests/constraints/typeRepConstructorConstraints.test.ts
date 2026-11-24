// TypeRep-as-constructor, constraint-body arity validation, and constructor /
// instance constraint-head forms.
//
//  - `TypeRep T` is the *constructor* of `T` (valid in constraint heads and
//    annotation positions; exposes static methods).
//  - A parametric type used bare in a `::constraint` body (e.g. `{ f :: Array }`)
//    must carry its mandatory children — the same arity diagnostic as ordinary
//    annotation positions, or `TypeRep Array` for a witness.
//  - Constraint heads: `Array k =>` binds `k` to the Array *constructor*
//    (`TypeRep Array`); `Array String k =>` binds `k` to the *instance*
//    `Array String` (`[String]`).
//  - The `omit` style signature `Array k => k String -> { [k] :: a, ...r } -> {r}`
//    parses (constructor application `k String` coexists with the `[k]` label).

import { resetTypeVarCounter, schemeToString } from '../../src/hm/types';
import { InferenceEngine } from '../../src/infer/index';
import { clearConstraints } from '../../src/registries/constraintRegistry';
import { getDotCompletions, CompletionContext } from '../../src/services/completion';

function makeCtx(): CompletionContext {
  return {
    engine: new InferenceEngine(),
    createImportResolver: () => () => null,
    createTypeDirectiveResolver: () => () => null,
    inferFileAndCacheExports: () => null,
    inferredTypeStyle: 'pretty',
  } as unknown as CompletionContext;
}

function dotLabels(src: string, before: string): string[] {
  const dotIdx = src.indexOf(before + '.') + before.length;
  return getDotCompletions(src, dotIdx + 1, dotIdx, 'file:///t.js', makeCtx())
    .map(i => i.label);
}

beforeEach(() => {
  resetTypeVarCounter();
  clearConstraints();
});

function infer(src: string) {
  return new InferenceEngine().infer(src);
}

function inferAndGet(src: string, names: string[]): Record<string, string> {
  const r = infer(src);
  const out: Record<string, string> = {};
  out.__diagnostics__ = r.diagnostics.map(d => d.message).join('\n');
  for (const n of names) {
    const sch = r.topLevelBindings.get(n);
    if (sch) out[n] = schemeToString(sch);
  }
  return out;
}

describe('TypeRep as constructor — annotation positions', () => {
  test('`TypeRep Array -> Null` is valid (no Unknown constraint, no arity error)', () => {
    const r = infer(`
// test :: TypeRep Array -> Null
const test = (t) => null;
`);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('`TypeRep Array k => k -> Null` is valid (TypeRep is a witness, not a class)', () => {
    const r = infer(`
// test :: TypeRep Array k => k -> Null
const test = (k) => null;
`);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });
});

describe('arity validation inside ::constraint bodies', () => {
  test('bare parametric type in a constraint body is flagged', () => {
    const r = infer(`
// ::constraint ArrayType f { f :: Array }
const x = 1;
`);
    expect(r.diagnostics.map(d => d.message)).toContain(
      "Type constructor 'Array' expects 1 type argument but got 0",
    );
  });

  test('`TypeRep Array` witness in a constraint body is accepted', () => {
    const r = infer(`
// ::constraint ArrayType f { f :: TypeRep Array }
const x = 1;
`);
    expect(r.diagnostics.map(d => d.message)).not.toContain(
      "Type constructor 'Array' expects 1 type argument but got 0",
    );
  });

  test('applied parametric type in a constraint body is accepted', () => {
    const r = infer(`
// ::constraint ArrayType f { f :: Array a }
const x = 1;
`);
    expect(r.diagnostics.map(d => d.message).join('\n')).not.toMatch(/expects 1 type argument/);
  });

  test('bare parametric type inside a method signature is flagged', () => {
    const r = infer(`
// ::constraint Buildable m { m :: { build :: m a ~> Array -> m a } }
const x = 1;
`);
    expect(r.diagnostics.map(d => d.message)).toContain(
      "Type constructor 'Array' expects 1 type argument but got 0",
    );
  });

  test('a valid Functor-style constraint produces no arity diagnostic', () => {
    const r = infer(`
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
const x = 1;
`);
    expect(r.diagnostics.map(d => d.message).join('\n')).not.toMatch(/expects \d+ type argument/);
  });
});

describe('constructor vs instance constraint heads', () => {
  test('`Array k =>` binds k to the Array constructor (TypeRep Array)', () => {
    const out = inferAndGet(`
// f :: Array k => k -> k
const f = (k) => k;
`, ['f']);
    expect(out.__diagnostics__).toBe('');
    expect(out.f).toContain('TypeRep Array');
  });

  test('`Array String k =>` binds k to the instance Array String ([String])', () => {
    const out = inferAndGet(`
// g :: Array String k => k -> k
const g = (k) => k;
`, ['g']);
    expect(out.__diagnostics__).toBe('');
    expect(out.g).toContain('[String]');
  });

  test('nullary scalar head `String s =>` still binds s to String', () => {
    const out = inferAndGet(`
// h :: String s => s -> s
const h = (s) => s;
`, ['h']);
    expect(out.__diagnostics__).not.toMatch(/Unknown constraint/);
    expect(out.h).toBe('String -> String');
  });
});

describe('omit-style row signature with constructor-applied key var', () => {
  test('`Array k => k String -> { [k] :: a, ...r } -> {r}` parses without error', () => {
    const out = inferAndGet(`
// omit :: Array k => k String -> { [k] :: a, ...r } -> {r}
const omit = (props) => (obj) => obj;
`, ['omit']);
    expect(out.__diagnostics__).not.toMatch(/Unexpected trailing token/);
    expect(out.__diagnostics__).not.toMatch(/Invalid type annotation/);
    // `k String` resolves to the instance `Array String` (= `[String]`),
    // while the `[k]` label and `...r` row are preserved in the record.
    expect(out.omit).toContain('[String]');
    expect(out.omit).toContain('[k]');
  });
});

describe('member completion on a TypeRep constructor parameter', () => {
  test('`Array k => k` (constructor) offers Array STATIC methods on `k.`', () => {
    const src = [
      '// omit :: Array k => k -> { [k] :: a, ...r } -> {r}',
      'const omit = props => obj => {',
      '  props.;',
      '  return obj;',
      '};',
    ].join('\n');
    const labels = dotLabels(src, 'props');
    expect(labels).toEqual(expect.arrayContaining(['of', 'from', 'isArray']));
    // Static-only: instance methods like `map` must NOT appear.
    expect(labels).not.toContain('map');
  });

  test('`Array String k => k` (instance) offers Array INSTANCE methods on `k.`', () => {
    const src = [
      '// f :: Array String k => k -> Number',
      'const f = props => {',
      '  props.;',
      '  return 1;',
      '};',
    ].join('\n');
    const labels = dotLabels(src, 'props');
    expect(labels).toEqual(expect.arrayContaining(['map', 'filter', 'reduce']));
  });
});

