import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString } from '../../src/hm/types';
import { getDotCompletions, CompletionContext } from '../../src/services/completion';
import { buildHover } from '../../src/services/hover';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

function makeCtx(): CompletionContext {
  return {
    engine,
    createImportResolver: () => () => null,
    createTypeDirectiveResolver: () => () => null,
    inferFileAndCacheExports: () => null,
    inferredTypeStyle: 'pretty',
  };
}

const MAYBE_SRC = `
// Maybe :: Just a | Nothing
class Just {
  constructor(value) { this.value = value; }
  // Maybe.of :: a -> Maybe a
  static of(value) { return new Just(value); }
}
class Nothing {
  static of(value) { return new Just(value); }
}

// Just :: a -> Maybe a
// Nothing :: () -> Maybe a
`;

describe('.constructor on sumtype receiver returns the variant union', () => {
  test('justFive.constructor has type Just a | Nothing (variant union)', () => {
    const r = engine.infer(`
// Maybe :: Just a | Nothing
class Just {
  constructor(value) { this.value = value; }
}
class Nothing {}

// Just :: a -> Maybe a
// Nothing :: () -> Maybe a

const justFive = new Just(5);
const ctorRef = justFive.constructor;
    `);
    expect(r.diagnostics).toHaveLength(0);
    const scheme = r.topLevelBindings.get('ctorRef');
    expect(scheme).toBeDefined();
    // The .constructor on a sumtype receiver yields the union of the
    // variant constructor types — `Just a | Nothing`.
    const str = prettyTypeToString(scheme!.type);
    expect(str).toMatch(/^Just [a-z] \| Nothing$/);
  });

  test('exposes parent sumtype name for hover augmentation', () => {
    const r = engine.infer(`
// Maybe :: Just a | Nothing
class Just { constructor(value) { this.value = value; } }
class Nothing {}

// Just :: a -> Maybe a
// Nothing :: () -> Maybe a

const m = new Just(5);
const c = m.constructor;
    `);
    expect(r.constructorParentSumtype).toBeDefined();
    const values = Array.from(r.constructorParentSumtype!.values());
    expect(values).toContain('Maybe');
  });
});

describe('.constructor on sumtype: callability + completion', () => {
  test("`new ctorRef(...)` reports 'Just a | Nothing is not callable' (no $error)", () => {
    const r = engine.infer(`${MAYBE_SRC}
const justFive = new Just(5);
const ctorRef = justFive.constructor;
const x = new ctorRef("hi");
    `);
    const callableDiag = r.diagnostics.find(d => d.message.includes('is not callable'));
    expect(callableDiag).toBeDefined();
    expect(callableDiag!.message).not.toMatch(/\$error/);
    expect(callableDiag!.message).toMatch(/Just [a-z] \| Nothing/);
  });

  test('completion on variant-union ctor reference offers parent static methods (.of)', () => {
    const source = `${MAYBE_SRC}
const justFive = new Just(5);
const ctorRef = justFive.constructor;
ctorRef.`;
    engine.infer(source);
    const offset = source.length;
    const items = getDotCompletions(source, offset, offset - 1, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('of');
  });

  test('hover on `.constructor` shows variant union even after failed `new` call', () => {
    const source = `${MAYBE_SRC}
const justFive = new Just(5);
const ctor = new justFive.constructor("3");
`;
    const r = engine.infer(source);
    const idx = source.indexOf('new justFive.constructor');
    const off = idx + 'new justFive.'.length + 4;
    let bestStart = -1;
    let bestType: import('../../src/hm/types').Type | null = null;
    for (const [s, { type, end }] of r.nodeTypes) {
      if (s <= off && off < end && s > bestStart) {
        bestStart = s;
        bestType = r.substitution.apply(type);
      }
    }
    const hover = buildHover({
      source, offset: off, result: r, bestType, bestStart, arrayShift: 0,
      inferredTypeStyle: 'pretty', uri: 'file:///t.js',
      resolveImportSpecifier: () => null,
      extractImportSpecifiers: () => new Map(),
    });
    expect(hover).not.toBeNull();
    const value = (hover!.contents as { value: string }).value;
    expect(value).toMatch(/Just [a-z] \| Nothing/);
    expect(value).not.toMatch(/\$error/);
  });
});

describe('sumtype identifier override (matching JS twin)', () => {
  test('`function Maybe` typed as `Just a | Nothing`', () => {
    const r = engine.infer(`
// Maybe :: Just a | Nothing
function Maybe() { throw new TypeError("nope"); }
class Just { constructor(v) { this.value = v; } }
class Nothing {}
// Just :: a -> Maybe a
// Nothing :: () -> Maybe a
`);
    const b = r.topLevelBindings.get('Maybe');
    expect(b).toBeDefined();
    expect(prettyTypeToString(b!.type)).toMatch(/^Just [a-z] \| Nothing$/);
  });

  test('`class Either` typed as `Left e | Right a`', () => {
    const r = engine.infer(`
// Either :: Left e | Right a
class Either { constructor(x) { this.$value = x; } static of(x) { return new Right(x); } }
class Left extends Either {}
class Right extends Either {}
// Left :: e -> Either e a
// Right :: a -> Either e a
`);
    const b = r.topLevelBindings.get('Either');
    expect(b).toBeDefined();
    expect(prettyTypeToString(b!.type)).toMatch(/^Left [a-z] \| Right [a-z]$/);
  });

  test('`const Param = {}` typed as `Path | Query`', () => {
    const r = engine.infer(`
// Param :: Path | Query
const Param = {};
// Path :: (String, [a], b) -> Param
const Path = Param.Path = (k, r = [], d) => ({ key: k, rules: r, defaultValue: d });
// Query :: (String, [a], b) -> Param
const Query = Param.Query = (k, r = [], d) => ({ key: k, rules: r, defaultValue: d });
`);
    const b = r.topLevelBindings.get('Param');
    expect(b).toBeDefined();
    expect(prettyTypeToString(b!.type)).toBe('Path | Query');
  });

  test('static methods on sumtype identifier still resolve (Either.of)', () => {
    const r = engine.infer(`
// Either :: Left e | Right a
class Either { constructor(x) { this.$value = x; } static of(x) { return new Right(x); } }
class Left extends Either {}
class Right extends Either {}
// Left :: e -> Either e a
// Right :: a -> Either e a
const r = Either.of(5);
`);
    const callableDiag = r.diagnostics.find(d => d.message.includes('not callable'));
    expect(callableDiag).toBeUndefined();
  });

  test('completion on `Either.` shows static-only (no instance methods)', () => {
    const source = `
// Either :: Left e | Right a
// Either#map :: Either e a ~> (a -> b) -> Either e b
// Either.of :: a -> Either e a
class Either { constructor(x) { this.$value = x; } static of(x) { return new Right(x); } }
class Left extends Either { map(_fn) { return this; } }
class Right extends Either { map(fn) { return Either.of(fn(this.$value)); } }
// Left :: e -> Either e a
// Right :: a -> Either e a
Either.
`;
    engine.infer(source);
    const offset = source.length - 1;
    const items = getDotCompletions(source, offset, offset - 1, 'file:///t.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('of');
    expect(labels).not.toContain('map');
  });
});
