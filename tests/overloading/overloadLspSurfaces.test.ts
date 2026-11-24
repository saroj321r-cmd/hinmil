// Overload behaviour surfaced through the LSP surfaces (hover + signature
// help), consolidated regressions:
//
//   1. Curried call-site hover (P5) — hovering an overloaded curried function
//      at a CALL SITE surfaces every overload, not just the first branch.
//   2. Curried signature help (P6/P3/P4) — each overload renders as a single
//      fully-curried signature `name(p0)(p1)(p2) -> ret` with every curried
//      parameter its own highlightable segment; the active parameter advances
//      through `)(` frames; literal arguments narrow the overload menu; and
//      already-applied arguments are substituted into params/return.
//   3. Matched-overload narrowing (P4) — at an overloaded call site, hover and
//      signature help show ONLY the overload branch matching the actual
//      arguments, while the declaration hover still shows every overload.
//   4. Partially-applied curried calls — hover shows the FULL curried type
//      with applied arguments substituted (mirroring signature help), and
//      signature help recovers the ROOT callee's complete curried form instead
//      of collapsing to the remainder type.

import { InferenceEngine } from '../../src/infer';
import { freshEngine } from '../helpers/infer';
import { provideSignatureHelp } from '../../src/services/signatureHelp';
import { buildHover } from '../../src/services/hover';
import type { Type } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  engine = freshEngine();
});

// Shared hover harness (identical across the original files).
function hoverAt(src: string, offset: number): string | null {
  const r = engine.infer(src);
  let bestStart = -1;
  let bestType: Type | null = null;
  for (const [s, { type, end }] of r.nodeTypes) {
    if (s <= offset && offset < end && s > bestStart) {
      bestStart = s;
      bestType = r.substitution.apply(type);
    }
  }
  const h = buildHover({
    source: src, offset, result: r, bestType, bestStart, arrayShift: 0,
    inferredTypeStyle: 'pretty', uri: 'file:///t.js',
    resolveImportSpecifier: () => null,
    extractImportSpecifiers: () => new Map(),
  });
  return h ? (h.contents as { value: string }).value : null;
}

/** The substring each ParameterInformation range highlights, per signature. */
function paramSegments(label: string, parameters: { label: string | [number, number] }[]): string[] {
  return parameters.map(p => {
    const range = p.label;
    if (typeof range === 'string') return range;
    return label.slice(range[0], range[1]);
  });
}

// ---------------------------------------------------------------------------
// Regression for P5: hovering an overloaded curried function at a CALL SITE
// surfaces every overload (matching the declaration hover), not just the first
// branch.  Previously the call site collapsed to a single overload line.
// ---------------------------------------------------------------------------

describe('curried overloaded call-site hover (P5)', () => {
  const SRC = `
// reducer :: f -> (b -> a -> b) -> b -> b
const reducer = foldable => fn => init => init;
// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b
// reduce :: (b -> a -> b) -> b -> Array a -> b
// reduce :: (b -> a -> b) -> b -> { [k] :: a } -> b
const reduce = fn => init => foldable => reducer (foldable) (fn) (init);
const reducedArr = reduce(acc => value => value)(1)([1, 2]);
`;

  test('hovering the call-site reduce shows all overloads', () => {
    // Offset on the `reduce` identifier of the call site (not the declaration).
    const callIdx = SRC.indexOf('reduce(acc =>');
    const value = hoverAt(SRC, callIdx + 1);
    expect(value).not.toBeNull();
    expect(value).toContain('Foldable f => (b -> a -> b) -> b -> f a -> b');
    expect(value).toContain('(b -> a -> b) -> b -> Array a -> b');
    expect(value).toContain('(b -> a -> b) -> b -> { [k] :: a } -> b');
  });
});

// ---------------------------------------------------------------------------
// Regression (P6): signature help for a curried, overloaded callee (e.g.
// `reduce`) must render EACH overload as a single fully-curried signature
// `name(p0)(p1)(p2) -> ret`, with every curried parameter as its own
// highlightable segment, and advance the highlighted (active) parameter as the
// user enters successive curried applications `)(`.
//
// Before this fix the menu showed `reduce(b) -> b -> [a] -> b` (only the first
// parameter segmented, the function parameter collapsed to a bare `b`) and the
// highlight never moved past the first parameter for chained calls.
// ---------------------------------------------------------------------------

describe('signature help — curried overloaded callee', () => {
  // Three curried overloads sharing the first two parameters and differing only
  // in the foldable parameter (Foldable / Array / record).
  const SRC = `
// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b
// reduce :: (b -> a -> b) -> b -> Array a -> b
// reduce :: (b -> a -> b) -> b -> { [k] :: a } -> b
const reduce = fn => init => foldable => foldable;
`;

  function help(tail: string) {
    const src = SRC + tail;
    return provideSignatureHelp({
      source: src,
      offset: src.length,
      engine,
      resolver: () => null,
      typeResolver: () => null,
      reinferWithArrayASI: () => null,
    });
  }

  test('every overload renders as a single fully-curried signature with all params segmented', () => {
    const h = help('const r = reduce(');
    expect(h).not.toBeNull();
    const labels = h!.signatures.map(s => s.label);
    // Declaration order (README › Overloading): Foldable, Array, record.
    expect(labels).toEqual([
      'reduce(b -> a -> b)(b)(f a) -> b',
      'reduce(b -> a -> b)(b)([a]) -> b',
      'reduce(b -> a -> b)(b)({ [k] :: a }) -> b',
    ]);
    // Each signature exposes one segment per curried parameter.
    for (const s of h!.signatures) {
      expect(s.parameters).toHaveLength(3);
    }
    // The function parameter is shown in full — NOT collapsed to a bare `b`.
    expect(paramSegments(h!.signatures[0].label, h!.signatures[0].parameters!))
      .toEqual(['b -> a -> b', 'b', 'f a']);
  });

  test('the first curried frame highlights the function parameter', () => {
    // Cursor inside the first argument (still typing the lambda).
    const h = help('const r = reduce(acc => value => acc');
    expect(h).not.toBeNull();
    expect(h!.activeParameter).toBe(0);
  });

  test('the second curried frame highlights the init parameter', () => {
    const h = help('const r = reduce(acc => value => acc)(');
    expect(h).not.toBeNull();
    expect(h!.activeParameter).toBe(1);
  });

  test('the third curried frame highlights the foldable parameter', () => {
    const h = help('const r = reduce(acc => value => acc)(1)(');
    expect(h).not.toBeNull();
    expect(h!.activeParameter).toBe(2);
  });

  test('the active parameter never runs past the last curried parameter', () => {
    const h = help('const r = reduce(acc => value => acc)(1)([1, 2]');
    expect(h).not.toBeNull();
    const paramCount = h!.signatures[h!.activeSignature ?? 0].parameters!.length;
    expect(h!.activeParameter).toBeLessThan(paramCount);
    expect(h!.activeParameter).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// P3 (overload narrowing across curried frames) + P4 (substitution of already-
// applied curried arguments into the rendered parameters / return type).
// ---------------------------------------------------------------------------

describe('signature help — curried overload narrowing (P3) and substitution (P4)', () => {
  // Four overloads matching the user's real `reduce`: an abstract Foldable, the
  // concrete Array, a pure open record `{ [k] :: a }`, and the catch-all Object.
  const SRC2 = `
// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }
// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b
// reduce :: (b -> a -> b) -> b -> Array a -> b
// reduce :: (b -> a -> b) -> b -> { [k] :: a } -> b
// reduce :: (b -> a -> b) -> b -> Object -> b
const reduce = fn => init => foldable => foldable;
`;

  function help2(tail: string) {
    const src = SRC2 + tail;
    return provideSignatureHelp({
      source: src,
      offset: src.length,
      engine,
      resolver: () => null,
      typeResolver: () => null,
      reinferWithArrayASI: () => null,
    });
  }

  /** The foldable (3rd) parameter segment for every rendered overload. */
  function foldableSegments(h: NonNullable<ReturnType<typeof help2>>): string[] {
    return h.signatures.map(s => paramSegments(s.label, s.parameters!)[2]);
  }

  test('opening an object literal in the final frame narrows to object overloads only', () => {
    const h = help2('const r = reduce(acc => value => value)(1)({');
    expect(h).not.toBeNull();
    const segs = foldableSegments(h!);
    // Only the open-record and Object overloads survive.
    expect(segs).toEqual(['{ [k] :: a }', 'Object']);
    // The Array and abstract Foldable overloads are filtered out.
    expect(segs).not.toContain('[a]');
    expect(segs).not.toContain('f a');
  });

  test('opening an array literal in the final frame narrows to list overloads only', () => {
    const h = help2('const r = reduce(acc => value => value)(1)([');
    expect(h).not.toBeNull();
    const segs = foldableSegments(h!);
    // Array (and the Foldable branch specialised to `[a]`) collapse to a single
    // `[a]` entry; the object overloads are filtered out.
    expect(segs).toEqual(['[a]']);
    expect(segs).not.toContain('Object');
    expect(segs).not.toContain('{ [k] :: a }');
  });

  test('already-applied curried arguments specialise the seed and return type (P4)', () => {
    const h = help2('const r = reduce(acc => value => value)(1)({');
    expect(h).not.toBeNull();
    for (const s of h!.signatures) {
      const segs = paramSegments(s.label, s.parameters!);
      // Seed parameter and the return type are now `Number` (init was `1`).
      expect(segs[1]).toBe('Number');
      expect(s.label.endsWith('-> Number')).toBe(true);
      // The callback's seed positions are specialised too, while the element
      // type `a` stays abstract until the foldable is supplied.
      expect(segs[0]).toBe('Number -> a -> Number');
    }
  });

  test('a typed object field specialises the record overload (P4)', () => {
    const h = help2('const r = reduce(acc => value => value)(1)({ a: 1');
    expect(h).not.toBeNull();
    const labels = h!.signatures.map(s => s.label);
    // The open-record overload reflects the concrete field type.
    expect(labels).toContain('reduce(Number -> Number -> Number)(Number)({ a :: Number }) -> Number');
  });
});

// ---------------------------------------------------------------------------
// Two DISTINCT object overloads must BOTH remain available while the user is
// still typing an object literal in the final curried frame — an incomplete
// `({` must not reject a record overload merely because its required fields
// are not present yet.
// ---------------------------------------------------------------------------

describe('signature help — two object overloads stay live while typing `({`', () => {
  const SRC3 = `
// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }
// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b
// reduce :: (b -> a -> b) -> b -> { [k] :: a } -> b
// reduce :: (b -> a -> b) -> b -> { k :: a } -> b
const reduce = fn => init => foldable => foldable;
`;

  function help3(tail: string) {
    const src = SRC3 + tail;
    return provideSignatureHelp({
      source: src,
      offset: src.length,
      engine,
      resolver: () => null,
      typeResolver: () => null,
      reinferWithArrayASI: () => null,
    });
  }

  test('an empty object frame keeps BOTH record overloads and drops the abstract foldable', () => {
    const h = help3('const reducedObj = reduce(acc => value => acc)(1)({');
    expect(h).not.toBeNull();
    const segs = h!.signatures.map(s => paramSegments(s.label, s.parameters!)[2]);
    // Both concrete record overloads survive; the abstract `f a` is dropped.
    expect(segs).toEqual(['{ [k] :: a }', '{ k :: a }']);
    expect(segs).not.toContain('f a');
  });

  test('both record overloads expose the substituted seed/return type', () => {
    const h = help3('const reducedObj = reduce(acc => value => acc)(1)({');
    expect(h).not.toBeNull();
    for (const s of h!.signatures) {
      const segs = paramSegments(s.label, s.parameters!);
      expect(segs[1]).toBe('Number');
      expect(s.label.endsWith('-> Number')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Regression (P4): at an overloaded CALL SITE, signature help and hover must
// surface ONLY the overload branch that matched the actual arguments — not the
// full set of overloads.  Hovering the declaration itself still shows every
// overload.
// ---------------------------------------------------------------------------

{
  const SRC = `
// concat :: ([a], [b]) -> [a | b]
// concat :: (String, String) -> String
const concat = (x, y) => x;
`;

  function sigLabels(src: string, offset: number): string[] {
    const help = provideSignatureHelp({
      source: src, offset, engine,
      resolver: () => null,
      typeResolver: () => null,
      reinferWithArrayASI: () => null,
    });
    return help ? help.signatures.map(s => s.label) : [];
  }

  describe('overloaded call-site shows only the matched overload (P4)', () => {
    test('signature help: a String call shows only the String overload', () => {
      const src = `${SRC}const r = concat("a", "b");\n`;
      const off = src.indexOf('concat("a"') + 'concat("a", '.length;
      expect(sigLabels(src, off)).toEqual(['concat(String, String) -> String']);
    });

    test('signature help: an Array call shows only the array overload', () => {
      const src = `${SRC}const r = concat([1], [2]);\n`;
      const off = src.indexOf('concat([1]') + 'concat([1], '.length;
      expect(sigLabels(src, off)).toEqual(['concat([Number], [Number]) -> [Number]']);
    });

    test('signature help: an incomplete String call narrows before the close paren', () => {
      const src = `${SRC}const r = concat("1", `;
      expect(sigLabels(src, src.length)).toEqual(['concat(String, String) -> String']);
    });

    test('signature help: an incomplete Array call narrows before the close paren', () => {
      const src = `${SRC}const r = concat([1], `;
      expect(sigLabels(src, src.length)).toEqual(['concat([Number], [b]) -> [b | Number]']);
    });

    test('signature help: no arguments yet shows every overload', () => {
      const src = `${SRC}const r = concat(`;
      expect(sigLabels(src, src.length)).toEqual([
        'concat([a], [b]) -> [a | b]',
        'concat(String, String) -> String',
      ]);
    });

    test('signature help: cursor inside the first String arg of a closed call narrows', () => {
      const src = `${SRC}const r = concat("");\n`;
      const off = src.indexOf('concat("') + 'concat("'.length; // between the quotes
      expect(sigLabels(src, off)).toEqual(['concat(String, String) -> String']);
    });

    test('signature help: cursor inside the first Array arg of a closed call narrows', () => {
      const src = `${SRC}const r = concat([1]);\n`;
      const off = src.indexOf('concat([1]') + 'concat([1]'.length; // after the array, before )
      expect(sigLabels(src, off)).toEqual(['concat([Number], [b]) -> [b | Number]']);
    });

    test('hover: a String call site shows only the String overload', () => {
      const src = `${SRC}const r = concat("a", "b");\n`;
      const off = src.lastIndexOf('concat("a"') + 2;
      const value = hoverAt(src, off)!;
      expect(value).toContain('(String, String) -> String');
      expect(value).not.toContain('[a | b]');
    });

    test('hover: the declaration still shows every overload', () => {
      const src = `${SRC}const r = concat("a", "b");\n`;
      const off = src.indexOf('const concat') + 'const '.length + 1;
      const value = hoverAt(src, off)!;
      expect(value).toContain('(String, String) -> String');
      expect(value).toContain('[a | b]');
    });
  });

  describe('signature help specialises params and return to the user input', () => {
    function help(src: string, offset: number) {
      return provideSignatureHelp({
        source: src, offset, engine,
        resolver: () => null,
        typeResolver: () => null,
        reinferWithArrayASI: () => null,
      });
    }

    test('a typed first arg specialises its own param AND the return type', () => {
      const src = `${SRC}const r = concat([1], `;
      expect(sigLabels(src, src.length)).toEqual(['concat([Number], [b]) -> [b | Number]']);
    });

    test('both typed args fully specialise the signature', () => {
      const src = `${SRC}const r = concat([1], [2]);\n`;
      const off = src.indexOf('concat([1]') + 'concat([1], '.length;
      expect(sigLabels(src, off)).toEqual(['concat([Number], [Number]) -> [Number]']);
    });

    test('activeParameter is 0 while the cursor is inside the first arg (an unclosed object literal)', () => {
      const src = `${SRC}const r = concat({ a: 1, b: 2`;
      const h = help(src, src.length)!;
      expect(h.activeParameter).toBe(0);
    });

    test('activeParameter is 1 after a top-level comma even past a closed nested literal', () => {
      const src = `${SRC}const r = concat([1, 2, 3], `;
      const h = help(src, src.length)!;
      expect(h.activeParameter).toBe(1);
    });

    test('editing the first arg still shows the second (already-typed) arg specialised', () => {
      const src = `${SRC}const r = concat([1], [2]);\n`;
      const off = src.indexOf('concat([1]') + 'concat([1'.length; // caret inside [1]
      const h = help(src, off)!;
      expect(h.signatures.map(s => s.label)).toEqual(['concat([Number], [Number]) -> [Number]']);
      expect(h.activeParameter).toBe(0);
    });
  });
}

// ---------------------------------------------------------------------------
// Hover parity for a PARTIALLY-APPLIED curried call.
//
// Hovering the callee identifier of a chained curried call (`equals(1)(2)`)
// must surface the callee's FULL curried type with the applied argument
// substituted in (`equals :: Number -> Number -> Boolean`) — NOT the bare
// remainder of the inner application.  This mirrors the signature-help
// behaviour for the same construct so the two surfaces stay consistent.
// ---------------------------------------------------------------------------

describe('hover — partially-applied curried call', () => {
  test('hovering the callee in a chained call shows the full curried type, substituted', () => {
    const src = 'const equals = a => b => a === b;\nconst r = equals(1)(2);\n';
    const idx = src.indexOf('equals(1)');
    const value = hoverAt(src, idx + 1);
    expect(value).not.toBeNull();
    expect(value).toContain('equals :: Number -> Number -> Boolean');
  });

  test('an annotated single curried callee hovers with the applied arg substituted', () => {
    const src = [
      '// equals :: Eq a => a -> a -> Boolean',
      'const equals = a => b => a === b;',
      'const r = equals("x")("y");',
      '',
    ].join('\n');
    const idx = src.indexOf('equals("x")');
    const value = hoverAt(src, idx + 1);
    expect(value).not.toBeNull();
    expect(value).toContain('String -> String -> Boolean');
  });
});

// ---------------------------------------------------------------------------
// Regression: signature help for a PARTIALLY-APPLIED curried call.
//
// When the user chains a curried application — e.g. `equals(Left("2"))(` — the
// inner call's type is the REMAINDER (`s -> Boolean`), which has already
// consumed the first argument and therefore hides it.  Signature help used to
// collapse the menu to that remainder, dropping the already-supplied first
// argument from view.  It must instead recover the ROOT callee's full curried
// type and render the COMPLETE form `equals(p0)(p1) -> ret` with the
// already-applied arguments substituted in and the active (current) frame
// highlighted — exactly like the annotated curried overloads (`reduce`).
// This applies to single curried bindings (auto-detected and annotated) as
// well as constraint-method style signatures, none of which carry a Union
// annotation.
// ---------------------------------------------------------------------------

{
  function help(src: string) {
    return provideSignatureHelp({
      source: src,
      offset: src.length,
      engine,
      resolver: () => null,
      typeResolver: () => null,
      reinferWithArrayASI: () => null,
    });
  }

  describe('signature help — partially-applied single curried callee', () => {
    test('auto-detected curried binding shows the FULL form with the applied arg substituted', () => {
      const src = 'const equals = a => b => a === b;\nconst r = equals(1)(';
      const h = help(src);
      expect(h).not.toBeNull();
      expect(h!.signatures.map(s => s.label)).toEqual(['equals(Number)(Number) -> Boolean']);
      // Both curried parameters are individually highlightable segments — the
      // already-applied first argument is NOT dropped.
      const sig = h!.signatures[0];
      expect(sig.parameters).toHaveLength(2);
      expect(paramSegments(sig.label, sig.parameters!)).toEqual(['Number', 'Number']);
      // The active (highlighted) parameter is the CURRENT frame: the 2nd.
      expect(h!.activeParameter).toBe(1);
    });

    test('annotated single curried binding (no Union) keeps the applied arg visible', () => {
      const src = [
        '// equals :: Eq a => a -> a -> Boolean',
        'const equals = a => b => a === b;',
        'const r = equals("x")(',
      ].join('\n');
      const h = help(src);
      expect(h).not.toBeNull();
      expect(h!.signatures.map(s => s.label)).toEqual(['equals(String)(String) -> Boolean']);
      expect(h!.activeParameter).toBe(1);
    });

    test('first frame (no application yet) shows the polymorphic full form, active 0', () => {
      const src = 'const equals = a => b => a === b;\nconst r = equals(';
      const h = help(src);
      expect(h).not.toBeNull();
      expect(h!.signatures.map(s => s.label)).toEqual(['equals(a)(a) -> Boolean']);
      expect(h!.activeParameter).toBe(0);
    });

    test('three-parameter curried binding advances through every applied frame', () => {
      const SRC = 'const add3 = a => b => c => a + b + c;\n';
      // After two applications the third frame is active; both applied args show.
      const h = help(SRC + 'const r = add3(1)(2)(');
      expect(h).not.toBeNull();
      expect(h!.signatures.map(s => s.label)).toEqual(['add3(Number)(Number)(Number) -> Number']);
      const sig = h!.signatures[0];
      expect(sig.parameters).toHaveLength(3);
      expect(h!.activeParameter).toBe(2);
    });

    test('a constraint-method-style curried signature surfaces both parameters', () => {
      // `equals` declared via a Setoid-like constraint, applied once then chained.
      const SRC = [
        '// ::constraint Setoid s { s :: { equals :: s ~> s -> Boolean } }',
        '// equals :: Setoid s => s -> s -> Boolean',
        'const equals = a => b => a === b;',
        'const r = equals(1)(',
      ].join('\n');
      const h = help(SRC);
      expect(h).not.toBeNull();
      const sig = h!.signatures[0];
      expect(sig.parameters).toHaveLength(2);
      // Full form: first (applied) param + active second param, both shown.
      expect(sig.label).toMatch(/^equals\(.*\)\(.*\) -> Boolean$/);
      expect(h!.activeParameter).toBe(1);
    });
  });

  // An OVERLOADED callee reached WITHOUT a local annotation (imported / global /
  // aliased) — the menu must still NARROW by the already-applied curried
  // argument instead of listing every overload.  This mirrors the real-world
  // `equals` case where a Union of concrete overloads comes from `globals.hm`.
  describe('signature help — partially-applied overloaded (un-annotated) callee', () => {
    // Three concrete curried overloads; `eq` aliases the annotated `equals`, so
    // the call site's name (`eq`) is NOT in the file's annotation map.
    const SRC = [
      '// equals :: Boolean -> Boolean -> Boolean',
      '// equals :: Number -> Number -> Boolean',
      '// equals :: [a] -> [a] -> Boolean',
      'const equals = a => b => a === b;',
      'const eq = equals;',
      '',
    ].join('\n');

    test('applying an Array argument narrows to the single matching overload', () => {
      const h = help(SRC + 'const r = eq([1])(');
      expect(h).not.toBeNull();
      expect(h!.signatures.map(s => s.label)).toEqual(['eq([Number])([Number]) -> Boolean']);
      expect(h!.activeParameter).toBe(1);
    });

    test('applying a Boolean argument narrows to the Boolean overload (not the first listed)', () => {
      const h = help(SRC + 'const r = eq(true)(');
      expect(h).not.toBeNull();
      expect(h!.signatures.map(s => s.label)).toEqual(['eq(Boolean)(Boolean) -> Boolean']);
    });

    test('before any application the full overload menu is offered', () => {
      const h = help(SRC + 'const r = eq(');
      expect(h).not.toBeNull();
      expect(h!.signatures).toHaveLength(3);
      expect(h!.activeParameter).toBe(0);
    });
  });
}
