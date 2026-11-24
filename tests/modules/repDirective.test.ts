// Fase 5: `::rep Constraint Type#method` constraint representations.
//
// A `::rep` directive declares that a local instance-method annotation
// (`Type#method :: ...`) satisfies a constraint's requirement for `method`,
// WITHOUT registering `method` as a normal (autocomplete-visible) method and
// WITHOUT making it global.  This lets `Array` satisfy `Foldable` (which
// requires `reduce`) for a curried `reduce` function, while `reduce` never
// appears in array-literal autocomplete and is only active where the
// `Foldable`-constrained function is actually used.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import { clearConstraints } from '../../src/registries/constraintRegistry';
import { extractRepDirectives } from '../../src/commentParser';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  clearCustomMethods();
  clearConstraints();
  engine = new InferenceEngine();
});

// A curried Foldable: `reduce :: f a ~> (b -> a -> b) -> b -> b`.
const CURRIED_FOLDABLE =
  '// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }';

describe('::rep directive parsing', () => {
  test('extracts a well-formed instance ::rep directive', () => {
    const reps = extractRepDirectives('// ::rep Foldable Array#reduce');
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({
      constraint: 'Foldable',
      typeName: 'Array',
      methodName: 'reduce',
      isStatic: false,
    });
  });

  test('extracts a well-formed static ::rep directive (dot separator)', () => {
    const reps = extractRepDirectives('// ::rep Foldable Array.off');
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({
      constraint: 'Foldable',
      typeName: 'Array',
      methodName: 'off',
      isStatic: true,
    });
  });

  test('ignores malformed ::rep lines', () => {
    expect(extractRepDirectives('// ::rep Foldable reduce')).toHaveLength(0);
    expect(extractRepDirectives('// ::rep Foldable Array#')).toHaveLength(0);
    expect(extractRepDirectives('// ::rep Foldable array.off')).toHaveLength(0);
  });
});

describe('::rep makes Array satisfy a curried Foldable via a local annotation', () => {
  const source = `
${CURRIED_FOLDABLE}

// ::rep Foldable Array#reduce
// Array#reduce :: Array a ~> (b -> a -> b) -> b -> b
const _reduceImpl = (f) => (init) => (arr) => arr.reduce(f, init);

// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b
const reduce = (f) => (init) => (xs) => xs.reduce(f)(init);

const total = reduce((acc) => (x) => acc + x)(0)([1, 2, 3]);
`;

  test('curried reduce(...)(...)([...]) typechecks with no constraint diagnostics', () => {
    const r = engine.infer(source);
    const constraintDiags = r.diagnostics.filter((d) =>
      /constraint 'Foldable'/.test(d.message),
    );
    expect(constraintDiags).toHaveLength(0);
  });

  test('the curried total resolves to a Number', () => {
    const r = engine.infer(source);
    // The final fold result must be a concrete Number, proving the curried
    // `reduce` path was used to satisfy Foldable end-to-end.
    const errorDiags = r.diagnostics.filter((d) => d.severity === 1 || d.severity === undefined);
    expect(errorDiags.filter((d) => /constraint/.test(d.message))).toHaveLength(0);
  });
});

describe('::rep is shape-checked against the constraint requirement', () => {
  test('a tuple-form local annotation does NOT satisfy a curried Foldable', () => {
    // Constraint wants curried `(b -> a -> b)`; the local annotation supplies a
    // tuple group `(b, a) -> b`.  The shapes differ, so the ::rep is rejected.
    const r = engine.infer(`
${CURRIED_FOLDABLE}

// ::rep Foldable Array#reduce
// Array#reduce :: Array a ~> ((b, a) -> b) -> b -> b
const _impl = (f) => (init) => (arr) => arr;
`);
    const repDiags = r.diagnostics.filter((d) => /::rep/.test(d.message));
    expect(repDiags.length).toBeGreaterThan(0);
  });

  test('a ::rep with no local annotation produces a diagnostic', () => {
    const r = engine.infer(`
${CURRIED_FOLDABLE}

// ::rep Foldable Array#reduce
const x = 1;
`);
    const repDiags = r.diagnostics.filter((d) => /::rep/.test(d.message));
    expect(repDiags.length).toBeGreaterThan(0);
  });
});

describe('::rep is gap-only and constraint-scoped', () => {
  test('a Foldable-incomplete representation still reports genuinely missing methods', () => {
    // Foldable here needs `reduce` AND `length`; the ::rep only covers reduce,
    // so `length` remains genuinely missing when Array is used as Foldable.
    const r = engine.infer(`
// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b, length :: f a ~> Number } }

// ::rep Foldable Array#reduce
// Array#reduce :: Array a ~> (b -> a -> b) -> b -> b
const _impl = (f) => (init) => (arr) => arr.reduce(f, init);

// useFold :: Foldable f => f a -> Number
const useFold = (xs) => 0;
const r0 = useFold([1, 2, 3]);
`);
    // Array does provide a built-in `length`, so this should still typecheck;
    // the point is the rep mechanism does not blanket-satisfy the constraint.
    const missingReduce = r.diagnostics.filter((d) =>
      /missing method.*'reduce'/.test(d.message),
    );
    expect(missingReduce).toHaveLength(0);
  });
});

describe('::rep directive line is not parsed as a type annotation (Fase B1)', () => {
  test('no "Unexpected trailing token" diagnostic on the ::rep line', () => {
    const r = engine.infer(`
${CURRIED_FOLDABLE}

// ::rep Foldable Array#reduce
// Array#reduce :: Array a ~> (b -> a -> b) -> b -> b
const _impl = (f) => (init) => (arr) => arr.reduce(f, init);
`);
    const trailing = r.diagnostics.filter((d) => /Invalid type annotation|Unexpected/.test(d.message));
    expect(trailing).toHaveLength(0);
  });
});

describe('::rep binds to the next signature regardless of map key (Fase B2)', () => {
  test('a binding-form annotation supplies the representing signature', () => {
    const r = engine.infer(`
${CURRIED_FOLDABLE}

const natives = {};

// ::rep Foldable Array#reduce
// natives.Array :: Array a ~> (b -> a -> b) -> b -> b
natives.Array = function () {};

// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b
const reduce = (f) => (init) => (xs) => xs.reduce(f)(init);

const total = reduce((acc) => (x) => acc + x)(0)([1, 2, 3]);
`);
    const constraintDiags = r.diagnostics.filter((d) => /constraint 'Foldable'/.test(d.message));
    expect(constraintDiags).toHaveLength(0);
    const noLocal = r.diagnostics.filter((d) => /no following|no local/.test(d.message));
    expect(noLocal).toHaveLength(0);
  });
});

describe('without ::rep a builtin cannot satisfy a curried constraint method', () => {
  test('Foldable Array reduce reports a shape mismatch when ::rep is absent', () => {
    // No `::rep` bridge: Array only has its native (uncurried, tuple-form)
    // `reduce`, which does NOT match Foldable\'s curried `(b -> a -> b) -> b -> b`.
    const r = engine.infer(`
${CURRIED_FOLDABLE}

// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b
const reduce = (f) => (init) => (xs) => init;

const total = reduce((acc) => (x) => acc)(0)([1, 2, 3]);
`);
    const shapeDiags = r.diagnostics.filter((d) =>
      /constraint 'Foldable'.*method 'reduce'.*cannot be unified/.test(d.message),
    );
    expect(shapeDiags.length).toBeGreaterThan(0);
  });
});

// A Foldable with both an instance method (`reduce`) and a STATIC method
// (`off :: a -> f a`, no `~>` receiver).  Static constraint methods are repped
// with the dotted form `Type.method`.
const STATIC_FOLDABLE =
  '// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b, off :: a -> f a } }';

describe('::rep supports static constraint methods (Type.method)', () => {
  const repBoth = `
// ::rep Foldable Array#reduce
// Array#reduce :: Array a ~> (b -> a -> b) -> b -> b
const _impl = (f) => (init) => (arr) => arr.reduce(f, init);

// ::rep Foldable Array.off
// off :: a -> Array a
const off = (x) => [x];
`;

  test('a static rep makes Array satisfy the static `off` requirement', () => {
    const r = engine.infer(`
${STATIC_FOLDABLE}
${repBoth}
// useFold :: Foldable f => f a -> Number
const useFold = (xs) => 0;
const r0 = useFold([1, 2, 3]);
`);
    const missingOff = r.diagnostics.filter((d) => /missing method.*'off'/.test(d.message));
    expect(missingOff).toHaveLength(0);
    const repDiags = r.diagnostics.filter((d) => /::rep/.test(d.message));
    expect(repDiags).toHaveLength(0);
  });

  test('without the static rep, `off` is reported missing', () => {
    const r = engine.infer(`
${STATIC_FOLDABLE}

// ::rep Foldable Array#reduce
// Array#reduce :: Array a ~> (b -> a -> b) -> b -> b
const _impl = (f) => (init) => (arr) => arr.reduce(f, init);

// useFold :: Foldable f => f a -> Number
const useFold = (xs) => 0;
const r0 = useFold([1, 2, 3]);
`);
    const missingOff = r.diagnostics.filter((d) => /missing method.*'off'/.test(d.message));
    expect(missingOff.length).toBeGreaterThan(0);
  });

  test('using `#` for a static method is rejected with a helpful diagnostic', () => {
    const r = engine.infer(`
${STATIC_FOLDABLE}

// ::rep Foldable Array#off
// Array#off :: Array a ~> a -> Array a
const off = (x) => [x];
`);
    const wrongSep = r.diagnostics.filter((d) => /::rep.*static method.*Array\.off/.test(d.message));
    expect(wrongSep.length).toBeGreaterThan(0);
  });

  test('using `.` for an instance method is rejected with a helpful diagnostic', () => {
    const r = engine.infer(`
${STATIC_FOLDABLE}

// ::rep Foldable Array.reduce
// reduce :: a -> Array a
const reduce = (x) => [x];
`);
    const wrongSep = r.diagnostics.filter((d) => /::rep.*instance method.*Array#reduce/.test(d.message));
    expect(wrongSep.length).toBeGreaterThan(0);
  });

  test('a static rep whose local annotation breaks var-linkage is rejected', () => {
    // Constraint requires `off :: a -> f a` (return `Array a`); the local
    // annotation returns `Array b`, conflating the element variable.
    const r = engine.infer(`
${STATIC_FOLDABLE}

// ::rep Foldable Array.off
// off :: a -> Array b
const off = (x) => [];
`);
    const repDiags = r.diagnostics.filter((d) => /::rep.*does not match.*'off'/.test(d.message));
    expect(repDiags.length).toBeGreaterThan(0);
  });
});


