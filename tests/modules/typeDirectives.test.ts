import { extractTypeDirectives, extractAnnotations, buildAnnotationMap, extractConstraintDirectives, extractPreferDirectives } from '../../src/commentParser';
import { InferenceEngine, defaultEnv, TypeDirectiveResolver } from '../../src/infer';
import { typeToString, prettyTypeToString, resetTypeVarCounter, schemeToString, parseKvName } from '../../src/hm/types';
import { lookupMethod, getMethodNames } from '../../src/registries/methodRegistry';
import { parseConstraintDirective, registerConstraint, clearConstraints, checkConstraint, lookupConstraint } from '../../src/registries/constraintRegistry';
import { parseTypeSignature } from '../../src/hm/typeParser';
import { collectConstraintInfo } from '../../src/services/hover';

beforeEach(() => {
  resetTypeVarCounter();
});

// ---------------------------------------------------------------------------
// extractTypeDirectives
// ---------------------------------------------------------------------------

describe('extractTypeDirectives', () => {
  test('extracts single ::types directive', () => {
    const source = `// ::types ./demo
const x = 42;`;
    const directives = extractTypeDirectives(source);
    expect(directives).toEqual(['./demo']);
  });

  test('extracts multiple ::types directives', () => {
    const source = `// ::types ./demo
// ::types ./other
const x = 42;`;
    const directives = extractTypeDirectives(source);
    expect(directives).toEqual(['./demo', './other']);
  });

  test('extracts package name directive', () => {
    const source = `// ::types fantasy-box
const x = 42;`;
    const directives = extractTypeDirectives(source);
    expect(directives).toEqual(['fantasy-box']);
  });

  test('extracts scoped package directive', () => {
    const source = `// ::types @scope/package
const x = 42;`;
    const directives = extractTypeDirectives(source);
    expect(directives).toEqual(['@scope/package']);
  });

  test('ignores regular comments', () => {
    const source = `// This is a regular comment
// :: Number -> Number
const double = x => x * 2;`;
    const directives = extractTypeDirectives(source);
    expect(directives).toEqual([]);
  });

  test('works alongside HM annotations', () => {
    const source = `// ::types ./demo
// boxOut :: Box a -> a
const boxOut = box => box.value;`;
    const directives = extractTypeDirectives(source);
    expect(directives).toEqual(['./demo']);
  });

  test('returns empty for source with no directives', () => {
    const source = `const x = 42;`;
    const directives = extractTypeDirectives(source);
    expect(directives).toEqual([]);
  });

  test('handles block comment directives', () => {
    const source = `/* ::types ./demo */
const x = 42;`;
    const directives = extractTypeDirectives(source);
    expect(directives).toEqual(['./demo']);
  });
});

// ---------------------------------------------------------------------------
// extractPreferDirectives
// ---------------------------------------------------------------------------

describe('extractPreferDirectives', () => {
  test('extracts a single-name directive', () => {
    const source = `// ::prefer Prop from sqlkit
const x = 1;`;
    const map = extractPreferDirectives(source);
    expect(map.get('Prop')).toBe('sqlkit');
    expect(map.size).toBe(1);
  });

  test('extracts multi-name directive (comma-separated)', () => {
    const source = `// ::prefer Prop, Table from sqlkit
const x = 1;`;
    const map = extractPreferDirectives(source);
    expect(map.get('Prop')).toBe('sqlkit');
    expect(map.get('Table')).toBe('sqlkit');
    expect(map.size).toBe(2);
  });

  test('tolerates extra whitespace around commas', () => {
    const source = `// ::prefer  Prop  ,   Table ,Selector from sqlkit
const x = 1;`;
    const map = extractPreferDirectives(source);
    expect(map.get('Prop')).toBe('sqlkit');
    expect(map.get('Table')).toBe('sqlkit');
    expect(map.get('Selector')).toBe('sqlkit');
  });

  test('multiple directives accumulate; later wins on collision', () => {
    const source = `// ::prefer Prop from sqlkit
// ::prefer Prop from other-lib
// ::prefer Table from sqlkit
const x = 1;`;
    const map = extractPreferDirectives(source);
    expect(map.get('Prop')).toBe('other-lib');
    expect(map.get('Table')).toBe('sqlkit');
  });

  test('accepts relative-path specifiers', () => {
    const source = `// ::prefer Prop from ./types
const x = 1;`;
    expect(extractPreferDirectives(source).get('Prop')).toBe('./types');
  });

  test('accepts scoped-package specifiers', () => {
    const source = `// ::prefer Prop from @scope/pkg
const x = 1;`;
    expect(extractPreferDirectives(source).get('Prop')).toBe('@scope/pkg');
  });

  test('block-comment form works', () => {
    const source = `/* ::prefer Prop, Table from sqlkit */
const x = 1;`;
    const map = extractPreferDirectives(source);
    expect(map.get('Prop')).toBe('sqlkit');
    expect(map.get('Table')).toBe('sqlkit');
  });

  test('lowercase names are rejected (must start with uppercase)', () => {
    const source = `// ::prefer prop from sqlkit
const x = 1;`;
    expect(extractPreferDirectives(source).size).toBe(0);
  });

  test('missing "from" clause is rejected', () => {
    const source = `// ::prefer Prop sqlkit
const x = 1;`;
    expect(extractPreferDirectives(source).size).toBe(0);
  });

  test('returns empty when source has no prefer directives', () => {
    const source = `// ::types ./demo
const x = 1;`;
    expect(extractPreferDirectives(source).size).toBe(0);
  });

  test('falls back to raw-source regex when source fails to parse', () => {
    // Deliberately unparseable JS — the regex fallback must still find the directive.
    const source = `// ::prefer Prop, Table from sqlkit
const ??? broken syntax !!!`;
    const map = extractPreferDirectives(source);
    expect(map.get('Prop')).toBe('sqlkit');
    expect(map.get('Table')).toBe('sqlkit');
  });
});

// ---------------------------------------------------------------------------
// Type directive integration with inference
// ---------------------------------------------------------------------------

describe('type directive integration', () => {
  const boxSource = `
// Box :: a -> Box a
// Box#value :: Box a ~> a
// Box#map :: Box a ~> (a -> b) -> Box b
const Box = (value) => ({
  map: (f) => Box(f(value)),
  value
});
`;

  test('registers methods from external file via ::types directive', () => {
    const engine = new InferenceEngine();

    const consumerSource = `// ::types ./box
// boxOut :: Box a -> a
const boxOut = box => box.value;`;

    const typeResolver: TypeDirectiveResolver = (specifier) => {
      if (specifier === './box') return boxSource;
      return null;
    };

    const result = engine.infer(consumerSource, undefined, undefined, typeResolver);

    // boxOut should be inferred as Box a -> a
    // box.value should resolve correctly because Box#value is registered
    expect(result.diagnostics).toHaveLength(0);
  });

  test('Box methods are available after ::types directive', () => {
    const engine = new InferenceEngine();

    const consumerSource = `// ::types ./box
// mapped :: Box Number -> Box Number
const mapped = box => box.map(n => n + 1);`;

    const typeResolver: TypeDirectiveResolver = (specifier) => {
      if (specifier === './box') return boxSource;
      return null;
    };

    const result = engine.infer(consumerSource, undefined, undefined, typeResolver);
    expect(result.diagnostics).toHaveLength(0);
  });

  test('static methods registered via ::types directive', () => {
    const engine = new InferenceEngine();

    const sourceWithStatic = `
// Pair :: (a, b) -> Pair a b
// Pair#fst :: Pair a b ~> a
// Pair#snd :: Pair a b ~> b
const Pair = (fst, snd) => ({ fst, snd });

// Box :: a -> Box a
// Box.fromPair :: Pair a c -> Box c
const Box = (value) => ({ value });
Box.fromPair = pair => Box(pair.snd);
`;

    const consumerSource = `// ::types ./lib
// Box :: a -> Box a
const Box = (value) => ({ value });
// test :: Pair Number String -> Box String
const test = pair => Box.fromPair(pair);`;

    const typeResolver: TypeDirectiveResolver = (specifier) => {
      if (specifier === './lib') return sourceWithStatic;
      return null;
    };

    const result = engine.infer(consumerSource, undefined, undefined, typeResolver);
    // Should have registered Box.fromPair as a static method
    expect(result.diagnostics).toHaveLength(0);
  });

  test('multiple ::types directives are processed', () => {
    const engine = new InferenceEngine();

    const pairSource = `
// Pair :: (a, b) -> Pair a b
// Pair#fst :: Pair a b ~> a
// Pair#snd :: Pair a b ~> b
const Pair = (fst, snd) => ({ fst, snd });
`;

    const consumerSource = `// ::types ./box
// ::types ./pair
// test :: Box Number -> Number
const test = box => box.value;`;

    const typeResolver: TypeDirectiveResolver = (specifier) => {
      if (specifier === './box') return boxSource;
      if (specifier === './pair') return pairSource;
      return null;
    };

    const result = engine.infer(consumerSource, undefined, undefined, typeResolver);
    expect(result.diagnostics).toHaveLength(0);
  });

  test('unresolvable ::types directive produces diagnostic', () => {
    const engine = new InferenceEngine();

    const source = `// ::types ./nonexistent
const x = 42;`;

    const typeResolver: TypeDirectiveResolver = () => null;
    const result = engine.infer(source, undefined, undefined, typeResolver);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("Cannot resolve ::types path './nonexistent'");
  });

  test('multiple unresolvable ::types directives produce multiple diagnostics', () => {
    const engine = new InferenceEngine();

    const source = `// ::types ./missing1
// ::types ./missing2
const x = 42;`;

    const typeResolver: TypeDirectiveResolver = () => null;
    const result = engine.infer(source, undefined, undefined, typeResolver);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics[0].message).toContain("Cannot resolve ::types path './missing1'");
    expect(result.diagnostics[1].message).toContain("Cannot resolve ::types path './missing2'");
  });

  test('mix of valid and invalid ::types directives only flags invalid ones', () => {
    const engine = new InferenceEngine();

    const source = `// ::types ./box
// ::types ./nonexistent
const x = 42;`;

    const typeResolver: TypeDirectiveResolver = (specifier) => {
      if (specifier === './box') return boxSource;
      return null;
    };

    const result = engine.infer(source, undefined, undefined, typeResolver);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("Cannot resolve ::types path './nonexistent'");
  });

  test('duplicate ::types specifiers are only processed once', () => {
    const engine = new InferenceEngine();
    let callCount = 0;

    const source = `// ::types ./box
// ::types ./box
const x = 42;`;

    const typeResolver: TypeDirectiveResolver = (specifier) => {
      callCount++;
      if (specifier === './box') return boxSource;
      return null;
    };

    engine.infer(source, undefined, undefined, typeResolver);
    expect(callCount).toBe(1);
  });

  test('without typeDirectiveResolver, ::types directives are ignored', () => {
    const engine = new InferenceEngine();

    const source = `// ::types ./box
const x = 42;`;

    // No typeResolver passed — should not crash
    const result = engine.infer(source);
    expect(result.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unknown type constructor validation
// ---------------------------------------------------------------------------

describe('unknown type constructor diagnostics', () => {
  const boxSource = `
// Box :: a -> Box a
// Box#value :: Box a ~> a
// Box#map :: Box a ~> (a -> b) -> Box b
const Box = (value) => ({
  map: (f) => Box(f(value)),
  value
});
`;

  test('reports unknown type constructor when ::types is missing', () => {
    const engine = new InferenceEngine();

    const source = `// boxOut :: Box a -> a
const boxOut = box => box.value;`;

    const result = engine.infer(source);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].message).toContain("Unknown type constructor 'Box'");
  });

  test('no error when ::types makes the type available', () => {
    const engine = new InferenceEngine();

    const source = `// ::types ./demo
// boxOut :: Box a -> a
const boxOut = box => box.value;`;

    const typeResolver: TypeDirectiveResolver = (specifier) => {
      if (specifier === './demo') return boxSource;
      return null;
    };

    const result = engine.infer(source, undefined, undefined, typeResolver);
    const unknownTypeErrors = result.diagnostics.filter(d => d.message.includes('Unknown type constructor'));
    expect(unknownTypeErrors).toHaveLength(0);
  });

  test('no error for built-in types', () => {
    const engine = new InferenceEngine();

    const source = `// add :: (Number, Number) -> Number
const add = (a, b) => a + b;`;

    const result = engine.infer(source);
    expect(result.diagnostics).toHaveLength(0);
  });

  test('no error for Array type', () => {
    const engine = new InferenceEngine();

    const source = `// head :: Array a -> a
const head = arr => arr[0];`;

    const result = engine.infer(source);
    const unknownTypeErrors = result.diagnostics.filter(d => d.message.includes('Unknown type constructor'));
    expect(unknownTypeErrors).toHaveLength(0);
  });

  test('no error when type is defined as constructor in same file', () => {
    const engine = new InferenceEngine();

    const source = `// Box :: a -> Box a
const Box = value => ({ value });

// boxOut :: Box a -> a
const boxOut = box => box.value;`;

    const result = engine.infer(source);
    const unknownTypeErrors = result.diagnostics.filter(d => d.message.includes('Unknown type constructor'));
    expect(unknownTypeErrors).toHaveLength(0);
  });

  test('reports error for type only in param, not return', () => {
    const engine = new InferenceEngine();

    const source = `// process :: Widget a -> Number
const process = w => 42;`;

    const result = engine.infer(source);
    expect(result.diagnostics.some(d => d.message.includes("Unknown type constructor 'Widget'"))).toBe(true);
  });

  test('error message suggests using ::types', () => {
    const engine = new InferenceEngine();

    const source = `// boxOut :: Box a -> a
const boxOut = box => box.value;`;

    const result = engine.infer(source);
    expect(result.diagnostics[0].message).toContain('::types');
  });

  test('no error for method annotations (#) that define types', () => {
    const engine = new InferenceEngine();

    const source = `// Box :: a -> Box a
// Box#value :: Box a ~> a
const Box = value => ({ value });`;

    const result = engine.infer(source);
    const unknownTypeErrors = result.diagnostics.filter(d => d.message.includes('Unknown type constructor'));
    expect(unknownTypeErrors).toHaveLength(0);
  });

  test('no mismatch diagnostic when type constructor is unknown (Either2 pattern)', () => {
    const engine = new InferenceEngine();

    // Either2 without sumtype — only "unknown type constructor" should appear,
    // NOT "Type mismatch" or "Cannot unify".
    const source = `// Left :: e -> Either2 e a
export function Left(value) {
  return leftOrRight(value, false)
}

// Right :: a -> Either2 e a
export function Right(value) {
  return leftOrRight(value, true)
}

// leftOrRight :: (a, boolean) -> Either2 a c
function leftOrRight(value, isRight) {
  // Either2#map :: Either2 e a ~> (a -> b) -> Either2 e b
  const map = fn =>
    isRight ? Right(fn(value)) : Left(value)

  // Either2#chain :: Either2 e a ~> (a -> Either2 e b) -> Either2 e b
  const chain = fn =>
    isRight ? fn(value) : Left(value)

  return {
    // Either2#value :: Either2 e a ~> (a | e)
    value,
    map,
    chain
  }
}`;

    const result = engine.infer(source);
    const unknownErrors = result.diagnostics.filter(d => d.message.includes("Unknown type constructor 'Either2'"));
    const mismatchErrors = result.diagnostics.filter(d =>
      d.message.includes('Type mismatch: implementation does not match annotation') ||
      d.message.includes('Cannot unify')
    );

    expect(unknownErrors.length).toBeGreaterThan(0);
    expect(mismatchErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractConstraintDirectives
// ---------------------------------------------------------------------------

describe('extractConstraintDirectives', () => {
  test('extracts single ::constraint directive', () => {
    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
const x = 42;`;
    const directives = extractConstraintDirectives(source);
    expect(directives).toHaveLength(1);
    expect(directives[0].text).toContain('::constraint Functor');
  });

  test('extracts multiple ::constraint directives', () => {
    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b } }
const x = 42;`;
    const directives = extractConstraintDirectives(source);
    expect(directives).toHaveLength(2);
  });

  test('ignores regular comments', () => {
    const source = `// This is a regular comment
const x = 42;`;
    const directives = extractConstraintDirectives(source);
    expect(directives).toHaveLength(0);
  });

  test('works alongside other directives', () => {
    const source = `// ::types ./demo
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// double :: Number -> Number
const double = x => x * 2;`;
    const directives = extractConstraintDirectives(source);
    expect(directives).toHaveLength(1);
    expect(directives[0].text).toContain('Functor');
  });
});

// ---------------------------------------------------------------------------
// parseConstraintDirective
// ---------------------------------------------------------------------------

describe('parseConstraintDirective', () => {
  test('parses single-method constraint', () => {
    const def = parseConstraintDirective('::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }');
    expect(def).not.toBeNull();
    expect(def!.name).toBe('Functor');
    expect(def!.typeVar).toBe('f');
    expect(def!.methods).toHaveLength(1);
    expect(def!.methods[0].name).toBe('map');
    expect(def!.methods[0].signature).toBe('f a ~> (a -> b) -> f b');
  });

  test('parses multi-method constraint', () => {
    const def = parseConstraintDirective('::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }');
    expect(def).not.toBeNull();
    expect(def!.name).toBe('Monad');
    expect(def!.typeVar).toBe('m');
    expect(def!.methods).toHaveLength(2);
    expect(def!.methods[0].name).toBe('chain');
    expect(def!.methods[1].name).toBe('of');
  });

  test('returns null for invalid input', () => {
    expect(parseConstraintDirective('not a constraint')).toBeNull();
    expect(parseConstraintDirective('::constraint')).toBeNull();
    expect(parseConstraintDirective('::constraint Functor')).toBeNull();
    expect(parseConstraintDirective('::constraint Functor f {}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkConstraint
// ---------------------------------------------------------------------------

describe('checkConstraint', () => {
  beforeEach(() => {
    clearConstraints();
  });

  test('reports satisfied when all methods exist', () => {
    // Box has map registered as a built-in method via methodRegistry
    registerConstraint({
      name: 'Mappable',
      typeVar: 'f',
      methods: [{ name: 'map', signature: 'f a ~> (a -> b) -> f b' }],
    });

    // 'Array' has .map in the default method registry
    const result = checkConstraint('Mappable', 'Array');
    expect(result.satisfied).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  test('reports missing methods', () => {
    registerConstraint({
      name: 'Chainable',
      typeVar: 'm',
      methods: [
        { name: 'chain', signature: 'm a ~> (a -> m b) -> m b' },
        { name: 'of', signature: 'a -> m a' },
      ],
    });

    // Array has no 'chain'; 'of' is now a built-in static method
    const result = checkConstraint('Chainable', 'Array');
    expect(result.satisfied).toBe(false);
    expect(result.missing).toContain('chain');
    expect(result.missing).not.toContain('of');
  });

  test('returns not satisfied for unknown constraint', () => {
    const result = checkConstraint('NonExistent', 'Array');
    expect(result.satisfied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Constraint parsing in type signatures
// ---------------------------------------------------------------------------

describe('constraint parsing in type signatures', () => {
  test('parses single constraint: Functor f => ...', () => {
    const scheme = parseTypeSignature('Functor f => (a -> b) -> f a -> f b');
    expect(scheme.constraints).toBeDefined();
    expect(scheme.constraints).toHaveLength(1);
    expect(scheme.constraints![0].className).toBe('Functor');
    expect(scheme.constraints![0].typeVarName).toBe('f');
  });

  test('parses multiple constraints: (Functor f, Monad m) => ...', () => {
    const scheme = parseTypeSignature('(Functor f, Monad m) => m (f a) -> f (m a)');
    expect(scheme.constraints).toBeDefined();
    expect(scheme.constraints).toHaveLength(2);
    expect(scheme.constraints![0].className).toBe('Functor');
    expect(scheme.constraints![0].typeVarName).toBe('f');
    expect(scheme.constraints![1].className).toBe('Monad');
    expect(scheme.constraints![1].typeVarName).toBe('m');
  });

  test('signature without constraints has no constraints field', () => {
    const scheme = parseTypeSignature('a -> b -> a');
    expect(scheme.constraints).toBeUndefined();
  });

  test('schemeToString includes constraints', () => {
    const scheme = parseTypeSignature('Functor f => (a -> b) -> f a -> f b');
    const str = schemeToString(scheme);
    expect(str).toContain('Functor');
    expect(str).toContain('=>');
  });
});

// ---------------------------------------------------------------------------
// Constraint integration with inference
// ---------------------------------------------------------------------------

describe('constraint integration', () => {
  const boxSource = `
// Box :: a -> Box a
// Box#value :: Box a ~> a
// Box#map :: Box a ~> (a -> b) -> Box b
const Box = (value) => ({
  map: (f) => Box(f(value)),
  value
});
`;

  test('constrained function infers correctly when constraint is satisfied', () => {
    const engine = new InferenceEngine();

    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::types ./box

// fmap :: Functor f => (a -> b) -> f a -> f b
const fmap = fn => functor => functor.map(fn);

// Box :: a -> Box a
const Box = value => ({ map: f => Box(f(value)), value });

// result :: Box Number
const result = fmap(n => n + 1)(Box(42));`;

    const typeResolver: TypeDirectiveResolver = (specifier) => {
      if (specifier === './box') return boxSource;
      return null;
    };

    const result = engine.infer(source, undefined, undefined, typeResolver);
    // Box has map, so Functor constraint is satisfied — no errors expected
    const constraintErrors = result.diagnostics.filter(d =>
      d.message.includes('constraint') || d.message.includes('satisfy')
    );
    expect(constraintErrors).toHaveLength(0);
  });

  test('reports error when constraint is not satisfied', () => {
    const engine = new InferenceEngine();

    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// Wrapper :: a -> Wrapper a
// Wrapper#value :: Wrapper a ~> a
const Wrapper = value => ({ value });

// fmap :: Functor f => (a -> b) -> f a -> f b
const fmap = fn => functor => functor.map(fn);

// broken :: Wrapper Number
const broken = fmap(n => n + 1)(Wrapper(42));`;

    const result = engine.infer(source);
    const constraintErrors = result.diagnostics.filter(d =>
      d.message.includes('does not satisfy') || d.message.includes('missing method')
    );
    expect(constraintErrors.length).toBeGreaterThan(0);
    expect(constraintErrors[0].message).toContain('Wrapper');
    expect(constraintErrors[0].message).toContain('Functor');
    expect(constraintErrors[0].message).toContain('map');
  });

  test('constraint definition loaded via ::types directive', () => {
    const engine = new InferenceEngine();

    const libSource = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// Box :: a -> Box a
// Box#value :: Box a ~> a 
// Box#map :: Box a ~> (a -> b) -> Box b
const Box = (value) => ({
  map: (f) => Box(f(value)),
  value
});
`;

    const consumerSource = `// ::types ./lib

// fmap :: Functor f => (a -> b) -> f a -> f b
const fmap = fn => functor => functor.map(fn);

// Box :: a -> Box a
const Box = value => ({ map: f => Box(f(value)), value });

// result :: Box Number
const result = fmap(n => n + 1)(Box(42));`;

    const typeResolver: TypeDirectiveResolver = (specifier) => {
      if (specifier === './lib') return libSource;
      return null;
    };

    const result = engine.infer(consumerSource, undefined, undefined, typeResolver);
    const constraintErrors = result.diagnostics.filter(d =>
      d.message.includes('constraint') || d.message.includes('satisfy')
    );
    expect(constraintErrors).toHaveLength(0);
  });

  test('constraint on unresolved type variable is silently skipped', () => {
    const engine = new InferenceEngine();

    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// fmap :: Functor f => (a -> b) -> f a -> f b
const fmap = fn => functor => functor.map(fn);`;

    const result = engine.infer(source);
    // 'f' never gets resolved to a concrete type, so constraint check is skipped
    const constraintErrors = result.diagnostics.filter(d =>
      d.message.includes('constraint') || d.message.includes('satisfy')
    );
    expect(constraintErrors).toHaveLength(0);
  });

  test('invalid ::constraint directive produces diagnostic', () => {
    const engine = new InferenceEngine();

    const source = `// ::constraint BadSyntax
const x = 42;`;

    const result = engine.infer(source);
    const directiveErrors = result.diagnostics.filter(d =>
      d.message.includes('Invalid ::constraint')
    );
    expect(directiveErrors).toHaveLength(1);
  });

  test('constraint names are registered for unknown-type validation', () => {
    const engine = new InferenceEngine();

    // Functor is used as a constraint name, not a type constructor — should not trigger "unknown type"
    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// fmap :: Functor f => (a -> b) -> f a -> f b
const fmap = fn => functor => functor.map(fn);`;

    const result = engine.infer(source);
    const unknownTypeErrors = result.diagnostics.filter(d =>
      d.message.includes('Unknown type constructor')
    );
    expect(unknownTypeErrors).toHaveLength(0);
  });

  test('constraint method lookup resolves through kind variable', () => {
    const engine = new InferenceEngine();

    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// fmap :: Functor f => (a -> b) -> f a -> f b
const fmap = fn => functor => functor.map(fn);`;

    const result = engine.infer(source);
    // functor.map should resolve via Functor constraint — no diagnostics
    expect(result.diagnostics).toHaveLength(0);

    // The method signature should reference [Functor]
    const sigs = Array.from(result.methodSignatures.values());
    const functorSig = sigs.find(s => s.includes('Functor') && s.includes('map'));
    expect(functorSig).toBeDefined();
  });

  test('kvConstraints maps kind-variable ids to constraint names', () => {
    const engine = new InferenceEngine();

    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// fmap :: Functor f => (a -> b) -> f a -> f b
const fmap = fn => functor => functor.map(fn);`;

    const result = engine.infer(source);
    // Should have at least one kvConstraints entry for 'Functor'
    let foundFunctor = false;
    for (const [, names] of result.kvConstraints) {
      if (names.includes('Functor')) foundFunctor = true;
    }
    expect(foundFunctor).toBe(true);
  });

  test('multiple constraints on different type vars track separately', () => {
    const engine = new InferenceEngine();

    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Show s { s :: { show :: s a ~> String } }

// convert :: (Functor f, Show s) => (a -> b) -> f a -> s b -> String
const convert = fn => fa => sb => sb.show;`;

    const result = engine.infer(source);
    // Both Functor and Show should be in kvConstraints
    const allConstraints = new Set<string>();
    for (const [, names] of result.kvConstraints) {
      names.forEach(n => allConstraints.add(n));
    }
    expect(allConstraints.has('Functor')).toBe(true);
    expect(allConstraints.has('Show')).toBe(true);
  });

  test('constraint imported via ::types enables method inference', () => {
    const engine = new InferenceEngine();

    const libSource = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// Box :: a -> Box a
// Box#value :: Box a ~> a
// Box#map :: Box a ~> (a -> b) -> Box b
const Box = (value) => ({
  map: (f) => Box(f(value)),
  value
});
`;

    const consumerSource = `// ::types ./lib

// fmap :: Functor f => (a -> b) -> f a -> f b
const fmap = fn => functor => functor.map(fn);`;

    const typeResolver: TypeDirectiveResolver = (specifier) => {
      if (specifier === './lib') return libSource;
      return null;
    };

    const result = engine.infer(consumerSource, undefined, undefined, typeResolver);
    expect(result.diagnostics).toHaveLength(0);
    // Method signature should exist for the constraint lookup
    expect(result.methodSignatures.size).toBeGreaterThan(0);
  });

  test('undefined constraint in signature produces diagnostic', () => {
    const engine = new InferenceEngine();

    // No ::constraint directive — Functor is not defined
    const source = `// fmap :: Functor f => (a -> b) -> f a -> f b
const fmap = fn => functor => functor.map(fn);`;

    const result = engine.infer(source);
    const unknownConstraint = result.diagnostics.filter(d =>
      d.message.includes("Unknown constraint 'Functor'")
    );
    expect(unknownConstraint).toHaveLength(1);
    expect(unknownConstraint[0].message).toContain('::constraint');
    // Diagnostic should point at the annotation name in the signature
    // (consistent with other signature-related diagnostics), not at the
    // whole comment and not at the JS declaration.
    const sigNameStart = source.indexOf('fmap'); // first `fmap` lives in the comment
    expect(unknownConstraint[0].start).toBe(sigNameStart);
    expect(unknownConstraint[0].end).toBe(sigNameStart + 'fmap'.length);
    expect(source.substring(unknownConstraint[0].start, unknownConstraint[0].end)).toBe('fmap');
  });

  test('defined constraint in signature produces no diagnostic', () => {
    const engine = new InferenceEngine();

    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// fmap :: Functor f => (a -> b) -> f a -> f b
const fmap = fn => functor => functor.map(fn);`;

    const result = engine.infer(source);
    const unknownConstraint = result.diagnostics.filter(d =>
      d.message.includes("Unknown constraint")
    );
    expect(unknownConstraint).toHaveLength(0);
  });

  test('kvConstraints enables hover constraint info for kind variables', () => {
    const engine = new InferenceEngine();

    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// fmap :: Functor f => (a -> b) -> f a -> f b
const fmap = fn => functor => functor.map(fn);`;

    const result = engine.infer(source);

    // Find the type for 'functor' parameter — should be a kv-TCon
    let functorType: import('../../src/hm/types').Type | null = null;
    for (const [start, { type }] of result.nodeTypes) {
      const resolved = result.substitution.apply(type);
      if (resolved.tag === 'TCon') {
        const kv = parseKvName(resolved.name);
        if (kv && kv.varName === 'f') {
          functorType = resolved;
        }
      }
    }
    expect(functorType).not.toBeNull();

    // kvConstraints should contain constraint info for this kv-TCon
    const kv = parseKvName(functorType!.name);
    expect(kv).not.toBeNull();
    const constraints = result.kvConstraints.get(kv!.varId);
    expect(constraints).toBeDefined();
    expect(constraints).toContain('Functor');
  });

  test('import resolution during inference does not corrupt constraint state', () => {
    // Simulates the startup scenario: the import resolver triggers a
    // separate inference mid-flight. Without proper isolation this
    // clears global registries and causes false "Type mismatch" errors.
    const demoSource = `// map :: ((a -> b), [a]) -> [b]
const map = (f, arr) => arr.map(f);

// Box :: a -> Box a
// Box#value :: Box a ~> a
// Box#map :: Box a ~> (a -> b) -> Box b
export const Box = (value) => ({
  map: (f) => Box(f(value)),
  value
});`;

    const consumerSource = `// ::types ./lib
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// fmap :: Functor f => (a -> b) -> f a -> f b
const fmap = fn => functor => functor.map(fn);`;

    // The import resolver infers the imported file using a fresh engine,
    // which would previously clear global method/constraint registries.
    const typeResolver: TypeDirectiveResolver = (specifier) => {
      if (specifier === './lib') return demoSource;
      return null;
    };

    const engine = new InferenceEngine();
    const result = engine.infer(consumerSource, undefined, undefined, typeResolver);

    // The Functor constraint must still be active after ::types processing
    const constraintErrors = result.diagnostics.filter(d =>
      d.message.includes('Unknown constraint') ||
      d.message.includes('Type mismatch')
    );
    expect(constraintErrors).toHaveLength(0);

    // Method signature for functor.map should be resolved
    const sigs = Array.from(result.methodSignatures.values());
    expect(sigs.some(s => s.includes('Functor') && s.includes('map'))).toBe(true);
  });

  test('display type for constrained function preserves kv names and constraints', () => {
    const engine = new InferenceEngine();

    const source = `// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Applicative f { f :: Functor, f :: { of :: a -> f a } }
// ::constraint Traversable t { t :: Functor, t :: { traverse :: Applicative f => t a ~> (TypeRep f, a -> f b) -> f (t b) } }

// traverse :: Applicative f, Traversable t => (TypeRep f, a -> f b, t a) -> f (t b)
const traverse = (of, fn, traversable) => traversable.traverse(of, fn)`;

    const result = engine.infer(source);

    // Find the display type for "traverse" declaration
    const traverseOffset = source.indexOf('const traverse');
    let bestType: import('../../src/hm/types').Type | null = null;
    for (const [start, { type, end }] of result.nodeTypes) {
      if (start >= traverseOffset && start < traverseOffset + 30) {
        bestType = result.substitution.apply(type);
      }
    }
    expect(bestType).not.toBeNull();

    // The displayed type should preserve constraint kv names consistently
    const typeStr = prettyTypeToString(bestType!);
    // f should appear consistently (not get renamed to c or another letter)
    expect(typeStr).toContain('f b');
    expect(typeStr).toContain('f (t b)');

    // Constraint info should be found for both f and t
    const constraintInfo = collectConstraintInfo(bestType!, result.kvConstraints);
    expect(constraintInfo).toContain('Applicative f');
    expect(constraintInfo).toContain('Traversable t');
  });
});

// ---------------------------------------------------------------------------
// ::narrow on sumtype getters works across ::types boundaries
// ---------------------------------------------------------------------------

describe('::narrow via ::types directive', () => {
  const eitherSource = `
// Either2 :: Left e | Right a
// Either2#value :: Either2 e a ~> (e | a)
// ::narrow Right
// Either2#isRight :: Either2 e a ~> Boolean

function leftOrRight(value, isRight) {
  return { value, isRight }
}
`;

  test('::narrow on member expression works when annotation comes from ::types file', () => {
    const engine = new InferenceEngine();
    const consumerSource = `// ::types ./Either2
// either :: (a -> c, b -> d, Either2 a b) -> (c | d)
const either = (f, g, e) => {
  return e.isRight ? g(e.value) : f(e.value)
}
`;
    const typeResolver: TypeDirectiveResolver = (specifier) => {
      if (specifier === './Either2') return eitherSource;
      return null;
    };
    const result = engine.infer(consumerSource, undefined, undefined, typeResolver);
    expect(result.diagnostics).toHaveLength(0);
  });
});
