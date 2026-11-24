import {
  lookupMethod,
  getMethodNames,
  registerMethod,
  clearCustomMethods,
  getTypeArity,
  getRegisteredTypeNames,
  findMethodCandidates,
  snapshotMethodRegistry,
  restoreMethodRegistry,
  mergeMethodRegistry,
} from '../../src/registries/methodRegistry';
import {
  registerConstraint,
  lookupConstraint,
  clearConstraints,
  snapshotConstraintRegistry,
  restoreConstraintRegistry,
  mergeConstraintRegistry,
  checkConstraint,
  checkConstraintMethodShape,
  matchesConstraintShape,
  parseConstraintDirective,
  getEffectiveMethods,
  inferExpectedKind,
  validateConstraintDef,
} from '../../src/registries/constraintRegistry';
import {
  registerDataType,
  getParentTypeName,
  isVariant,
  isDataType,
  getDataType,
  getVariant,
  getDataTypeNames,
  getVariantNames,
  getDataTypeDisplayString,
  clearDataTypes,
  snapshotDataTypeRegistry,
  restoreDataTypeRegistry,
  mergeDataTypeRegistry,
} from '../../src/registries/dataTypeRegistry';
import { tVar, tFun, tNumber, tString, tCon, resetTypeVarCounter } from '../../src/hm/types';

beforeEach(() => {
  resetTypeVarCounter();
  clearCustomMethods();
  clearConstraints();
  clearDataTypes();
});

// =========================================================================
// Method Registry
// =========================================================================

describe('getMethodNames', () => {
  test('returns known Array methods', () => {
    const names = getMethodNames('Array');
    expect(names).toContain('map');
    expect(names).toContain('filter');
    expect(names).toContain('forEach');
    expect(names).toContain('flatMap');
    expect(names).toContain('reverse');
    expect(names).toContain('slice');
    expect(names).toContain('join');
  });

  test('returns known String methods', () => {
    const names = getMethodNames('String');
    expect(names).toContain('replace');
    expect(names).toContain('concat');
  });

  test('returns empty array for unknown type', () => {
    const names = getMethodNames('UnknownType');
    expect(names).toEqual([]);
  });
});

describe('registerMethod and lookupMethod', () => {
  test('register and lookup custom method', () => {
    registerMethod('MyType', 'doSomething', {
      signature: 'MyType a ~> Number -> String',
      factory: () => tFun(tNumber, tString),
    });
    const entry = lookupMethod('MyType', 'doSomething');
    expect(entry).toBeDefined();
  });
});

describe('getTypeArity', () => {
  test('Array has arity 1', () => {
    expect(getTypeArity('Array')).toBe(1);
  });
});

describe('getRegisteredTypeNames', () => {
  test('includes built-in type names', () => {
    const names = getRegisteredTypeNames();
    expect(names.has('Array')).toBe(true);
    expect(names.has('String')).toBe(true);
  });
});

describe('findMethodCandidates', () => {
  test('finds types that have a given method', () => {
    const candidates = findMethodCandidates('map');
    const typeNames = candidates.map(([name]) => name);
    expect(typeNames).toContain('Array');
  });

  test('returns empty for unknown method', () => {
    const candidates = findMethodCandidates('nonExistentMethod');
    expect(candidates).toHaveLength(0);
  });
});

describe('snapshot / restore / merge — method registry', () => {
  test('snapshot and restore custom method', () => {
    registerMethod('Foo', 'bar', {
      signature: 'Foo ~> Number',
      factory: () => tNumber,
    });
    const snap = snapshotMethodRegistry();
    // Register another method
    registerMethod('Foo', 'baz', {
      signature: 'Foo ~> String',
      factory: () => tString,
    });
    // baz should exist
    expect(lookupMethod('Foo', 'baz')).toBeDefined();
    // Restore — baz should be gone
    restoreMethodRegistry(snap);
    expect(lookupMethod('Foo', 'baz')).toBeNull();
    // bar should still exist
    expect(lookupMethod('Foo', 'bar')).toBeDefined();
  });

  test('merge method registry adds missing entries', () => {
    registerMethod('Foo', 'bar', {
      signature: 'Foo ~> Number',
      factory: () => tNumber,
    });
    const snap = snapshotMethodRegistry();
    clearCustomMethods();
    registerMethod('Foo', 'baz', {
      signature: 'Foo ~> String',
      factory: () => tString,
    });
    // Merge — both should exist
    mergeMethodRegistry(snap);
    expect(lookupMethod('Foo', 'bar')).toBeDefined();
    expect(lookupMethod('Foo', 'baz')).toBeDefined();
  });

  test('snapshot captures custom type arity; restore reinstates it', () => {
    // registerMethod with arity=1 sets typeArityRegistry['Box'] = 1
    registerMethod('Box', 'unwrap', {
      signature: 'Box a ~> a',
      factory: () => tVar('a'),
    }, 1);
    // snapshotMethodRegistry arities loop (line 703) is now exercised
    const snap = snapshotMethodRegistry();
    expect(snap.arities['Box']).toBe(1);

    clearCustomMethods();
    expect(getTypeArity('Box')).toBe(0); // gone after clear

    // restoreMethodRegistry arities loop (line 717) is now exercised
    restoreMethodRegistry(snap);
    expect(getTypeArity('Box')).toBe(1);
  });

  test('merge creates new type group when type is absent from registry', () => {
    // Register 'Bar' and snapshot it
    registerMethod('Bar', 'run', {
      signature: 'Bar ~> Number',
      factory: () => tNumber,
    }, 1); // with arity so arities path is also covered
    const snap = snapshotMethodRegistry();

    // Clear so Bar is gone from the registry
    clearCustomMethods();
    expect(lookupMethod('Bar', 'run')).toBeNull();

    // mergeMethodRegistry must create the 'Bar' group (line 725)
    // and must set the arity (lines 734-735)
    mergeMethodRegistry(snap);
    expect(lookupMethod('Bar', 'run')).toBeDefined();
    expect(getTypeArity('Bar')).toBe(1);
  });
});

// =========================================================================
// Constraint Registry
// =========================================================================

describe('constraint registry — basic', () => {
  test('register and lookup constraint', () => {
    registerConstraint({
      name: 'Eq',
      typeVar: 'a',
      methods: [{ name: 'eq', signature: 'a -> a -> Boolean' }],
    });
    const c = lookupConstraint('Eq');
    expect(c).not.toBeNull();
    expect(c!.name).toBe('Eq');
  });

  test('lookup unknown constraint returns null', () => {
    expect(lookupConstraint('NonExistent')).toBeNull();
  });
});

describe('constraint registry — snapshot / restore / merge', () => {
  test('snapshot and restore', () => {
    registerConstraint({
      name: 'Num',
      typeVar: 'a',
      methods: [{ name: 'add', signature: 'a -> a -> a' }],
    });
    const snap = snapshotConstraintRegistry();
    registerConstraint({
      name: 'Ord',
      typeVar: 'a',
      methods: [{ name: 'compare', signature: 'a -> a -> Number' }],
    });
    expect(lookupConstraint('Ord')).not.toBeNull();
    restoreConstraintRegistry(snap);
    expect(lookupConstraint('Ord')).toBeNull();
    expect(lookupConstraint('Num')).not.toBeNull();
  });

  test('merge adds missing entries', () => {
    registerConstraint({
      name: 'Num',
      typeVar: 'a',
      methods: [{ name: 'add', signature: 'a -> a -> a' }],
    });
    const snap = snapshotConstraintRegistry();
    clearConstraints();
    registerConstraint({
      name: 'Ord',
      typeVar: 'a',
      methods: [{ name: 'compare', signature: 'a -> a -> Number' }],
    });
    mergeConstraintRegistry(snap);
    expect(lookupConstraint('Num')).not.toBeNull();
    expect(lookupConstraint('Ord')).not.toBeNull();
  });
});

describe('checkConstraint', () => {
  test('satisfied when type has required methods', () => {
    registerConstraint({
      name: 'Mappable',
      typeVar: 'f',
      methods: [{ name: 'map', signature: 'f a ~> (a -> b) -> f b' }],
    });
    const result = checkConstraint('Mappable', 'Array');
    expect(result.satisfied).toBe(true);
  });

  test('missing methods reported', () => {
    registerConstraint({
      name: 'Showable',
      typeVar: 'a',
      methods: [{ name: 'show', signature: 'a -> String' }],
    });
    const result = checkConstraint('Showable', 'Number');
    expect(result.satisfied).toBe(false);
    expect(result.missing).toContain('show');
  });
});

describe('parseConstraintDirective — nested commas', () => {
  test('preserves commas inside parenthesized signatures', () => {
    const def = parseConstraintDirective(
      '::constraint Foldable f { f :: { reduce :: f a ~> ((b, a) -> b, b) -> b } }',
    );
    expect(def).not.toBeNull();
    expect(def!.methods).toHaveLength(1);
    expect(def!.methods[0].name).toBe('reduce');
    expect(def!.methods[0].signature).toBe('f a ~> ((b, a) -> b, b) -> b');
  });
});

// =========================================================================
// Built-in method factory coverage
// =========================================================================

describe('Promise method factories', () => {
  test('then factory produces correct type', () => {
    const entry = lookupMethod('Promise', 'then');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tNumber]);
    expect(t.tag).toBe('TFun');
  });

  test('catch factory produces correct type', () => {
    const entry = lookupMethod('Promise', 'catch');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tNumber]);
    expect(t.tag).toBe('TFun');
  });

  test('finally factory produces correct type', () => {
    const entry = lookupMethod('Promise', 'finally');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tNumber]);
    expect(t.tag).toBe('TFun');
  });
});

describe('Map method factories', () => {
  test('get factory', () => {
    const entry = lookupMethod('Map', 'get');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tString, tNumber]);
    expect(t.tag).toBe('TFun');
  });

  test('set factory', () => {
    const entry = lookupMethod('Map', 'set');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tString, tNumber]);
    expect(t.tag).toBe('TFun');
  });

  test('has factory', () => {
    const entry = lookupMethod('Map', 'has');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tString, tNumber]);
    expect(t.tag).toBe('TFun');
  });

  test('delete factory', () => {
    const entry = lookupMethod('Map', 'delete');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tString, tNumber]);
    expect(t.tag).toBe('TFun');
  });

  test('clear factory', () => {
    const entry = lookupMethod('Map', 'clear');
    expect(entry).not.toBeNull();
    const t = entry!.factory([]);
    expect(t.tag).toBe('TCon');
  });

  test('size factory', () => {
    const entry = lookupMethod('Map', 'size');
    expect(entry).not.toBeNull();
    const t = entry!.factory([]);
    expect(t.tag).toBe('TCon');
  });

  test('forEach factory', () => {
    const entry = lookupMethod('Map', 'forEach');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tString, tNumber]);
    expect(t.tag).toBe('TFun');
  });

  test('keys factory', () => {
    const entry = lookupMethod('Map', 'keys');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tString, tNumber]);
    expect(t.tag).toBe('TCon');
  });

  test('values factory', () => {
    const entry = lookupMethod('Map', 'values');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tString, tNumber]);
    expect(t.tag).toBe('TCon');
  });

  test('entries factory', () => {
    const entry = lookupMethod('Map', 'entries');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tString, tNumber]);
    expect(t.tag).toBe('TCon');
  });
});

describe('Set method factories', () => {
  test('add factory', () => {
    const entry = lookupMethod('Set', 'add');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tNumber]);
    expect(t.tag).toBe('TFun');
  });

  test('has factory', () => {
    const entry = lookupMethod('Set', 'has');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tNumber]);
    expect(t.tag).toBe('TFun');
  });

  test('delete factory', () => {
    const entry = lookupMethod('Set', 'delete');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tNumber]);
    expect(t.tag).toBe('TFun');
  });

  test('clear factory', () => {
    const entry = lookupMethod('Set', 'clear');
    expect(entry).not.toBeNull();
    const t = entry!.factory([]);
    expect(t.tag).toBe('TCon');
  });

  test('size factory', () => {
    const entry = lookupMethod('Set', 'size');
    expect(entry).not.toBeNull();
    const t = entry!.factory([]);
    expect(t.tag).toBe('TCon');
  });

  test('forEach factory', () => {
    const entry = lookupMethod('Set', 'forEach');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tNumber]);
    expect(t.tag).toBe('TFun');
  });

  test('values factory', () => {
    const entry = lookupMethod('Set', 'values');
    expect(entry).not.toBeNull();
    const t = entry!.factory([tNumber]);
    expect(t.tag).toBe('TCon');
  });
});

describe('RegExp method factories', () => {
  test('test factory', () => {
    expect(lookupMethod('RegExp', 'test')).not.toBeNull();
    expect(lookupMethod('RegExp', 'test')!.factory([]).tag).toBe('TFun');
  });

  test('exec factory', () => {
    expect(lookupMethod('RegExp', 'exec')).not.toBeNull();
    expect(lookupMethod('RegExp', 'exec')!.factory([]).tag).toBe('TFun');
  });

  test('source factory', () => {
    expect(lookupMethod('RegExp', 'source')!.factory([]).tag).toBe('TCon');
  });

  test('flags factory', () => {
    expect(lookupMethod('RegExp', 'flags')!.factory([]).tag).toBe('TCon');
  });

  test('global factory', () => {
    expect(lookupMethod('RegExp', 'global')!.factory([]).tag).toBe('TCon');
  });

  test('lastIndex factory', () => {
    expect(lookupMethod('RegExp', 'lastIndex')!.factory([]).tag).toBe('TCon');
  });
});

describe('Number method factories', () => {
  test('toString factory', () => {
    expect(lookupMethod('Number', 'toString')!.factory([]).tag).toBe('TFun');
  });

  test('toFixed factory', () => {
    expect(lookupMethod('Number', 'toFixed')!.factory([]).tag).toBe('TFun');
  });

  test('toPrecision factory', () => {
    expect(lookupMethod('Number', 'toPrecision')!.factory([]).tag).toBe('TFun');
  });

  test('toExponential factory', () => {
    expect(lookupMethod('Number', 'toExponential')!.factory([]).tag).toBe('TFun');
  });

  test('valueOf factory', () => {
    expect(lookupMethod('Number', 'valueOf')!.factory([]).tag).toBe('TFun');
  });
});

describe('Boolean method factories', () => {
  test('toString factory', () => {
    expect(lookupMethod('Boolean', 'toString')!.factory([]).tag).toBe('TFun');
  });

  test('valueOf factory', () => {
    expect(lookupMethod('Boolean', 'valueOf')!.factory([]).tag).toBe('TFun');
  });
});

describe('Error method factories', () => {
  test('Error.message factory', () => {
    expect(lookupMethod('Error', 'message')!.factory([]).tag).toBe('TCon');
  });

  test('Error.name factory', () => {
    expect(lookupMethod('Error', 'name')!.factory([]).tag).toBe('TCon');
  });

  test('Error.stack factory', () => {
    expect(lookupMethod('Error', 'stack')!.factory([]).tag).toBe('TCon');
  });

  test('TypeError inherits Error methods', () => {
    expect(lookupMethod('TypeError', 'message')).not.toBeNull();
  });
});

describe('Function method factories', () => {
  test('length factory', () => {
    expect(lookupMethod('Function', 'length')!.factory([]).tag).toBe('TCon');
  });

  test('name factory', () => {
    expect(lookupMethod('Function', 'name')!.factory([]).tag).toBe('TCon');
  });

  test('bind factory', () => {
    expect(lookupMethod('Function', 'bind')!.factory([]).tag).toBe('TFun');
  });

  test('call factory', () => {
    expect(lookupMethod('Function', 'call')!.factory([]).tag).toBe('TFun');
  });

  test('apply factory', () => {
    expect(lookupMethod('Function', 'apply')!.factory([]).tag).toBe('TFun');
  });
});

describe('factory functions — all built-ins called with type arguments', () => {
  // Calling every built-in method factory with [tNumber, tString] covers the
  // non-nullish side of `typeArgs[0] ?? tVar('a')` expressions (branch coverage).
  test('every registered method factory runs without throwing when given type args', () => {
    const typeNames = getRegisteredTypeNames();
    for (const typeName of typeNames) {
      const methods = getMethodNames(typeName);
      for (const methodName of methods) {
        const entry = lookupMethod(typeName, methodName);
        if (!entry) continue;
        // Call with type args — exercises the non-fallback side of `??`
        expect(() => entry.factory([tNumber, tString])).not.toThrow();
        // Call with empty args — exercises the fallback side of `??`
        expect(() => entry.factory([])).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// matchesConstraintShape
// ---------------------------------------------------------------------------

describe('matchesConstraintShape', () => {
  // matchesConstraintShape works on parsed Type values; we test via
  // checkConstraintMethodShape which parses signatures and delegates.

  test('TVar in constraint matches anything (pattern variable)', () => {
    // TVar a matches Number
    expect(matchesConstraintShape(tVar(), tNumber, 'f', 'MyType')).toBe(true);
  });

  test('concrete types must match by name', () => {
    expect(matchesConstraintShape(tNumber, tNumber, 'f', 'MyType')).toBe(true);
    expect(matchesConstraintShape(tNumber, tString, 'f', 'MyType')).toBe(false);
  });

  test('TFun: both sides must match', () => {
    expect(
      matchesConstraintShape(
        tFun(tNumber, tString),
        tFun(tNumber, tString),
        'f', 'MyType',
      ),
    ).toBe(true);
    expect(
      matchesConstraintShape(
        tFun(tNumber, tString),
        tFun(tNumber, tNumber),
        'f', 'MyType',
      ),
    ).toBe(false);
  });

  test('TFun: registered must also be TFun', () => {
    expect(
      matchesConstraintShape(
        tFun(tNumber, tString),
        tNumber,
        'f', 'MyType',
      ),
    ).toBe(false);
  });

  test('TCon-to-TCon: matching constructors and args', () => {
    expect(
      matchesConstraintShape(
        tCon('Array', [tVar()]),
        tCon('Array', [tNumber]),
        'f', 'MyType',
      ),
    ).toBe(true);
  });

  test('TCon-to-TCon: mismatched constructor names', () => {
    expect(
      matchesConstraintShape(
        tCon('Array', [tVar()]),
        tCon('Maybe', [tNumber]),
        'f', 'MyType',
      ),
    ).toBe(false);
  });

  test('TCon-to-TCon: mismatched arg counts', () => {
    expect(
      matchesConstraintShape(
        tCon('Either', [tVar(), tVar()]),
        tCon('Either', [tNumber]),
        'f', 'MyType',
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkConstraintMethodShape
// ---------------------------------------------------------------------------

describe('checkConstraintMethodShape', () => {
  test('shape-checks a registered method even without a ~> receiver', () => {
    // A registered signature without `~>` is still structurally validated
    // against the constraint (e.g. built-in methods like Array#reduce).  Here
    // the shape matches the constraint, so the check passes.
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (a -> b) -> f b',
      'MyType',
      { signature: '(a -> b) -> MyType b', factory: () => tNumber },
    );
    expect(result).toBeNull();
  });

  test('reports a mismatch for a no-~> method whose shape differs', () => {
    // `Number -> String` cannot satisfy `(a -> b) -> f b` — generic structural
    // mismatch, reported without referencing currying.
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (a -> b) -> f b',
      'MyType',
      { signature: 'Number -> String', factory: () => tNumber },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('cannot be unified with the required');
  });

  test('returns null when shapes match (functor map)', () => {
    // Functor constraint: f a ~> (a -> b) -> f b
    // Registered method:  MyType a ~> (a -> b) -> MyType b  (shape matches)
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (a -> b) -> f b',
      'MyType',
      { signature: 'MyType a ~> (a -> b) -> MyType b', factory: () => tNumber },
    );
    expect(result).toBeNull();
  });

  test('returns error string when shapes do not match', () => {
    // Constraint wants f b as return, but registered returns Number
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (a -> b) -> f b',
      'MyType',
      { signature: 'MyType a ~> (a -> b) -> Number', factory: () => tNumber },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('shape');
  });

  test('returns null on parse error (graceful fallback)', () => {
    const result = checkConstraintMethodShape(
      'f',
      '%%invalid%%',
      'MyType',
      { signature: 'MyType a ~> (a -> b) -> MyType b', factory: () => tNumber },
    );
    expect(result).toBeNull();
  });

  test('tuple constraint does NOT match curried registered method', () => {
    // Foldable (tuple form): f a ~> ((b, a) -> b, b) -> b
    // Registered (curried):  Arr a ~> (b -> a -> b) -> b -> b
    // The parameter grouping differs (tuple group vs curried arrows), so the
    // shapes must be reported as a mismatch.
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> ((b, a) -> b, b) -> b',
      'Arr',
      { signature: 'Arr a ~> (b -> a -> b) -> b -> b', factory: () => tNumber },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('shape');
  });

  test('curried constraint does NOT match tuple registered method', () => {
    // Reverse direction: curried constraint, tuple-form registered method.
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (b -> a -> b) -> b -> b',
      'Arr',
      { signature: 'Arr a ~> ((b, a) -> b, b) -> b', factory: () => tNumber },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('shape');
  });

  test('tuple constraint matches an exactly-tuple registered method', () => {
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> ((b, a) -> b, b) -> b',
      'Arr',
      { signature: 'Arr a ~> ((b, a) -> b, b) -> b', factory: () => tNumber },
    );
    expect(result).toBeNull();
  });

  // -- inner constructor-variable linkage (method-local constraint prefix) -----
  // Both the constraint's method signature and the registered annotation may
  // declare their OWN inner HKT var (`Applicative f => … f b …`).  The two
  // `f`s parse to kv-TCons with unrelated ids, so they can never be equal by
  // name — they must be paired by consistent co-occurrence instead.

  test('inner HKT var in both signatures matches by linkage (Traversable traverse)', () => {
    // fpkit Either#traverse: binary container + method-local `Applicative f =>`.
    const result = checkConstraintMethodShape(
      't',
      'Applicative f => t a ~> TypeRep f -> (a -> f b) -> f (t b)',
      'Either',
      { signature: 'Applicative f => Either e a ~> TypeRep f -> (a -> f b) -> f (Either e b)', factory: () => tNumber },
    );
    expect(result).toBeNull();
  });

  test('inner HKT var linkage still rejects inconsistent heads', () => {
    // The registered side uses TWO different constructor vars where the
    // constraint uses one `f` — linkage must reject.
    const result = checkConstraintMethodShape(
      't',
      'Applicative f => t a ~> TypeRep f -> (a -> f b) -> f (t b)',
      'Either',
      { signature: '(Applicative f, Applicative g) => Either e a ~> TypeRep f -> (a -> f b) -> g (Either e b)', factory: () => tNumber },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('shape');
  });

  // -- bare-parameter surplus-arity tolerance ---------------------------------
  // A constraint callback written as a SINGLE bare parameter (`a -> Boolean`)
  // must be satisfied by a registered callback that declares extra trailing
  // parameters (`(a, Number, [a]) -> Boolean`, native Array#filter): a 1-arg
  // JS callback simply ignores the extra arguments it is passed.

  test('bare 1-param constraint callback matches wider native callback (Filterable filter)', () => {
    // Filterable: f a ~> (a -> Boolean) -> f a
    // Native Array#filter (no ~> receiver): ((a, Number, [a]) -> Boolean) -> [a]
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (a -> Boolean) -> f a',
      'Array',
      { signature: '((a, Number, [a]) -> Boolean) -> [a]', factory: () => tNumber },
    );
    expect(result).toBeNull();
  });

  test('tuple constraint callback matches bare 1-param registered callback (reverse direction)', () => {
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> ((a, Number) -> Boolean) -> f a',
      'Arr',
      { signature: 'Arr a ~> (a -> Boolean) -> Arr a', factory: () => tNumber },
    );
    expect(result).toBeNull();
  });

  test('bare-param tolerance still enforces the leading parameter type', () => {
    // First callback parameter disagrees (String vs required a linked to f a's
    // element) — surplus tolerance must not mask a genuine mismatch.
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (a -> Boolean) -> f a',
      'Array',
      { signature: '((String, Number, [a]) -> Boolean) -> [Number]', factory: () => tNumber },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('cannot be unified with the required');
  });

  // -- nullary constraint vs fully-optional registered params ------------------
  // A method whose parameters are ALL optional (`X | Undefined`, the registry's
  // `opt()` encoding) is callable with zero arguments, so it satisfies a
  // constraint method required as `() -> r`.

  test('nullary constraint method satisfied by fully-optional registered param (Number#toString)', () => {
    // Showable: s ~> () -> String; native Number#toString: (Number | Undefined) -> String
    const result = checkConstraintMethodShape(
      's',
      's ~> () -> String',
      'Number',
      { signature: '(Number | Undefined) -> String', factory: () => tNumber },
    );
    expect(result).toBeNull();
  });

  test('nullary constraint method satisfied by all-optional parameter group', () => {
    const result = checkConstraintMethodShape(
      's',
      's ~> () -> String',
      'Number',
      { signature: '(Number | Undefined, String | Undefined) -> String', factory: () => tNumber },
    );
    expect(result).toBeNull();
  });

  test('nullary constraint method NOT satisfied by a mandatory registered param', () => {
    const result = checkConstraintMethodShape(
      's',
      's ~> () -> String',
      'Number',
      { signature: 'Number -> String', factory: () => tNumber },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('cannot be unified with the required');
  });

  // -- type-variable linkage -------------------------------------------------
  // Beyond curried-vs-tuple structure, the registered method must respect the
  // *linkage* of the constraint's inner type variables: a method that returns
  // `f a` where `f b` is required does NOT satisfy the constraint, even though
  // every position is individually shape-compatible.

  test('linkage: Functor map returning f a (instead of f b) is rejected', () => {
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (a -> b) -> f b',
      'Arr',
      // returns `Arr a` — conflates the result var `b` with the input var `a`
      { signature: 'Arr a ~> (a -> b) -> Arr a', factory: () => tNumber },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('shape');
  });

  test('linkage: Functor map returning f b is accepted', () => {
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (a -> b) -> f b',
      'Arr',
      { signature: 'Arr a ~> (a -> b) -> Arr b', factory: () => tNumber },
    );
    expect(result).toBeNull();
  });

  test('linkage: swapped argument variables in a curried param are rejected', () => {
    // Constraint threads (a -> b) then expects b; registered method swaps the
    // mapping by consuming `a` in the position the constraint reserves for `b`.
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (a -> b) -> b',
      'Arr',
      { signature: 'Arr a ~> (a -> b) -> a', factory: () => tNumber },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('shape');
  });

  test('linkage: higher-kinded partial application (RTask) still matches', () => {
    // The constraint var `f` binds to the partially-applied `RTask r e`; the
    // inner `a`/`b` linkage is consistent, so this must be accepted.
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (a -> b) -> f b',
      'RTask',
      { signature: 'RTask r e a ~> (a -> b) -> RTask r e b', factory: () => tNumber },
    );
    expect(result).toBeNull();
  });

  // -- non-rightmost operated slot (variance) --------------------------------
  // A constraint's kind variable `f` is unary, but a concrete type may be
  // multi-parameter and different constraints operate on different parameters:
  // Functor's `map` transforms the RIGHTMOST parameter of `Arrow a b`, while
  // Contravariant's `contramap` transforms the LEFTMOST.  The shape matcher
  // must accept whichever single slot alignment is linkage-consistent.

  test('slot: Contravariant contramap on the LEFT parameter of Arrow is accepted', () => {
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (b -> a) -> f b',
      'Arrow',
      { signature: 'Arrow a b ~> (c -> a) -> Arrow c b', factory: () => tNumber },
    );
    expect(result).toBeNull();
  });

  test('slot: Functor map on the RIGHT parameter of Arrow is still accepted', () => {
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (a -> b) -> f b',
      'Arrow',
      { signature: 'Arrow a b ~> (b -> c) -> Arrow a c', factory: () => tNumber },
    );
    expect(result).toBeNull();
  });

  test('slot: a genuinely inconsistent contramap on Arrow is still rejected', () => {
    // Function input `a` (should be the result var `b`) makes no slot alignment
    // linkage-consistent, so the mismatch must still be reported.
    const result = checkConstraintMethodShape(
      'f',
      'f a ~> (b -> a) -> f b',
      'Arrow',
      { signature: 'Arrow a b ~> (a -> c) -> Arrow c b', factory: () => tNumber },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('shape');
  });
});

// =========================================================================
// Constraint inheritance (extends)
// =========================================================================

describe('parseConstraintDirective — extends', () => {
  test('parses single extends', () => {
    const def = parseConstraintDirective(
      '::constraint Apply f { f :: Functor, f :: { ap :: f a ~> f (a -> b) -> f b } }',
    );
    expect(def).not.toBeNull();
    expect(def!.name).toBe('Apply');
    expect(def!.extends).toEqual(['Functor']);
    expect(def!.methods).toHaveLength(1);
    expect(def!.methods[0].name).toBe('ap');
  });

  test('parses multiple extends', () => {
    const def = parseConstraintDirective(
      '::constraint Monad m { m :: Applicative, m :: Chain, m :: { bind :: m a ~> (a -> m b) -> m b } }',
    );
    expect(def).not.toBeNull();
    expect(def!.extends).toEqual(['Applicative', 'Chain']);
    expect(def!.methods).toHaveLength(1);
  });

  test('no extends clause leaves extends undefined', () => {
    const def = parseConstraintDirective(
      '::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }',
    );
    expect(def).not.toBeNull();
    expect(def!.extends).toBeUndefined();
  });
});

describe('parseConstraintDirective — unified syntax edge cases', () => {
  test('combines super + method-record + structural clauses in one directive', () => {
    const def = parseConstraintDirective(
      '::constraint Mix m { m :: Functor, m :: { foo :: m a ~> m a }, m :: Number | String }',
    );
    expect(def).not.toBeNull();
    expect(def!.extends).toEqual(['Functor']);
    expect(def!.methods).toHaveLength(1);
    expect(def!.methods[0].name).toBe('foo');
    expect(def!.selfClauses).toHaveLength(1);
  });

  test('record body with only static methods (no ~>) parses as methods', () => {
    const def = parseConstraintDirective(
      '::constraint HasUnit u { u :: { unit :: () -> u, zero :: u } }',
    );
    expect(def).not.toBeNull();
    expect(def!.methods.map(m => m.name)).toEqual(['unit', 'zero']);
    expect(def!.expectedKind).toBe('*');
  });

  test('arity-N: typeVar is the LAST header param', () => {
    const def = parseConstraintDirective(
      '::constraint Indexed r e s { r :: [e] | Map s e, s :: Number | String }',
    );
    expect(def).not.toBeNull();
    expect(def!.headerParams).toEqual(['r', 'e', 's']);
    expect(def!.typeVar).toBe('s');
    expect(def!.selfClauses).toHaveLength(2);
  });

  test('rejects clause whose param is not in headerParams', () => {
    const def = parseConstraintDirective(
      '::constraint Bad a { z :: Number }',
    );
    expect(def).toBeNull();
  });

  test('rejects directive without a body', () => {
    const def = parseConstraintDirective('::constraint Empty a');
    expect(def).toBeNull();
  });

  test('tolerates extra whitespace and newlines inside the body', () => {
    const def = parseConstraintDirective(
      '::constraint Functor f {\n  f ::  {  map  ::  f a ~> (a -> b) -> f b  }\n}',
    );
    expect(def).not.toBeNull();
    expect(def!.methods).toHaveLength(1);
    expect(def!.methods[0].name).toBe('map');
  });
});

describe('getEffectiveMethods — inheritance', () => {
  test('returns own methods when no extends', () => {
    registerConstraint({
      name: 'Functor', typeVar: 'f',
      methods: [{ name: 'map', signature: 'f a ~> (a -> b) -> f b' }],
    });
    const methods = getEffectiveMethods('Functor');
    expect(methods).toHaveLength(1);
    expect(methods[0].name).toBe('map');
  });

  test('inherits parent methods', () => {
    registerConstraint({
      name: 'Functor', typeVar: 'f',
      methods: [{ name: 'map', signature: 'f a ~> (a -> b) -> f b' }],
    });
    registerConstraint({
      name: 'Apply', typeVar: 'f',
      methods: [{ name: 'ap', signature: 'f a ~> f (a -> b) -> f b' }],
      extends: ['Functor'],
    });
    const methods = getEffectiveMethods('Apply');
    expect(methods).toHaveLength(2);
    expect(methods.map(m => m.name).sort()).toEqual(['ap', 'map']);
  });

  test('child methods override parent methods of same name', () => {
    registerConstraint({
      name: 'Parent', typeVar: 'f',
      methods: [{ name: 'foo', signature: 'a -> b' }],
    });
    registerConstraint({
      name: 'Child', typeVar: 'f',
      methods: [{ name: 'foo', signature: 'a -> a' }],
      extends: ['Parent'],
    });
    const methods = getEffectiveMethods('Child');
    expect(methods).toHaveLength(1);
    expect(methods[0].signature).toBe('a -> a');
  });

  test('diamond inheritance collects each method once', () => {
    registerConstraint({
      name: 'Base', typeVar: 'f',
      methods: [{ name: 'base', signature: 'a -> a' }],
    });
    registerConstraint({
      name: 'Left', typeVar: 'f',
      methods: [{ name: 'left', signature: 'a -> b' }],
      extends: ['Base'],
    });
    registerConstraint({
      name: 'Right', typeVar: 'f',
      methods: [{ name: 'right', signature: 'b -> a' }],
      extends: ['Base'],
    });
    registerConstraint({
      name: 'Diamond', typeVar: 'f',
      methods: [{ name: 'diamond', signature: 'a -> a' }],
      extends: ['Left', 'Right'],
    });
    const methods = getEffectiveMethods('Diamond');
    expect(methods.map(m => m.name).sort()).toEqual(['base', 'diamond', 'left', 'right']);
  });

  test('deep chain: grandchild inherits from grandparent', () => {
    registerConstraint({
      name: 'Functor', typeVar: 'f',
      methods: [{ name: 'map', signature: 'f a ~> (a -> b) -> f b' }],
    });
    registerConstraint({
      name: 'Apply', typeVar: 'f',
      methods: [{ name: 'ap', signature: 'f a ~> f (a -> b) -> f b' }],
      extends: ['Functor'],
    });
    registerConstraint({
      name: 'Applicative', typeVar: 'f',
      methods: [{ name: 'of', signature: 'a -> f a' }],
      extends: ['Apply'],
    });
    const methods = getEffectiveMethods('Applicative');
    expect(methods).toHaveLength(3);
    expect(methods.map(m => m.name).sort()).toEqual(['ap', 'map', 'of']);
  });

  test('returns empty for unknown constraint', () => {
    expect(getEffectiveMethods('Unknown')).toEqual([]);
  });
});

describe('checkConstraint — with inheritance', () => {
  test('checks inherited methods too', () => {
    registerConstraint({
      name: 'Semigroup', typeVar: 's',
      methods: [{ name: 'concat', signature: 's ~> s -> s' }],
    });
    registerConstraint({
      name: 'Monoid', typeVar: 'm',
      methods: [{ name: 'empty', signature: 'm' }],
      extends: ['Semigroup'],
    });
    // MyType has empty but not concat — should fail Monoid check
    registerMethod('MyType', 'empty', { signature: 'MyType', factory: () => tNumber });
    const result = checkConstraint('Monoid', 'MyType');
    expect(result.satisfied).toBe(false);
    expect(result.missing).toContain('concat');
  });
});

// ---------------------------------------------------------------------------
// inferExpectedKind
// ---------------------------------------------------------------------------

describe('inferExpectedKind', () => {
  test('returns * -> * when typevar appears applied in method signatures', () => {
    expect(inferExpectedKind('f', [
      { name: 'map', signature: 'f a ~> (a -> b) -> f b' },
    ])).toBe('* -> *');
  });

  test('returns * when typevar appears bare in method signatures', () => {
    expect(inferExpectedKind('m', [
      { name: 'empty', signature: '() -> m' },
      { name: 'concat', signature: 'm ~> m -> m' },
    ])).toBe('*');
  });

  test('returns * -> * when typevar applied with paren arg', () => {
    expect(inferExpectedKind('f', [
      { name: 'ap', signature: 'f a ~> f (a -> b) -> f b' },
    ])).toBe('* -> *');
  });

  test('returns * -> * for Foldable-style constraint', () => {
    expect(inferExpectedKind('f', [
      { name: 'reduce', signature: 'f a ~> ((b, a) -> b, b) -> b' },
    ])).toBe('* -> *');
  });

  test('returns * for Semigroup-style constraint', () => {
    expect(inferExpectedKind('s', [
      { name: 'concat', signature: 's ~> s -> s' },
    ])).toBe('*');
  });

  test('returns * -> * for multi-method constraint with at least one applied usage', () => {
    expect(inferExpectedKind('m', [
      { name: 'chain', signature: 'm a ~> (a -> m b) -> m b' },
      { name: 'of', signature: 'a -> m a' },
    ])).toBe('* -> *');
  });
});

// ---------------------------------------------------------------------------
// parseConstraintDirective — expectedKind
// ---------------------------------------------------------------------------

describe('parseConstraintDirective — expectedKind', () => {
  test('Functor: expectedKind is * -> *', () => {
    const def = parseConstraintDirective('::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }');
    expect(def!.expectedKind).toBe('* -> *');
  });

  test('Monoid: expectedKind is *', () => {
    const def = parseConstraintDirective('::constraint Monoid m { m :: { empty :: () -> m, concat :: m ~> m -> m } }');
    expect(def!.expectedKind).toBe('*');
  });

  test('Semigroup: expectedKind is *', () => {
    const def = parseConstraintDirective('::constraint Semigroup s { s :: { concat :: s ~> s -> s } }');
    expect(def!.expectedKind).toBe('*');
  });

  test('Foldable: expectedKind is * -> *', () => {
    const def = parseConstraintDirective('::constraint Foldable f { f :: { reduce :: f a ~> ((b, a) -> b, b) -> b } }');
    expect(def!.expectedKind).toBe('* -> *');
  });

  test('Monad: expectedKind is * -> *', () => {
    const def = parseConstraintDirective('::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }');
    expect(def!.expectedKind).toBe('* -> *');
  });

  test('register auto-computes expectedKind when not provided', () => {
    registerConstraint({
      name: 'TestFunctor', typeVar: 'f',
      methods: [{ name: 'map', signature: 'f a ~> (a -> b) -> f b' }],
    });
    const def = lookupConstraint('TestFunctor');
    expect(def!.expectedKind).toBe('* -> *');

    registerConstraint({
      name: 'TestMonoid', typeVar: 'm',
      methods: [{ name: 'empty', signature: '() -> m' }],
    });
    const def2 = lookupConstraint('TestMonoid');
    expect(def2!.expectedKind).toBe('*');
  });
});

// ---------------------------------------------------------------------------
// validateConstraintDef
// ---------------------------------------------------------------------------

describe('validateConstraintDef', () => {
  test('valid Functor — no errors', () => {
    const errors = validateConstraintDef({
      name: 'Functor', typeVar: 'f',
      methods: [{ name: 'map', signature: 'f a ~> (a -> b) -> f b' }],
    });
    expect(errors).toHaveLength(0);
  });

  test('valid Monoid — no errors', () => {
    const errors = validateConstraintDef({
      name: 'Monoid', typeVar: 'm',
      methods: [
        { name: 'empty', signature: '() -> m' },
        { name: 'concat', signature: 'm ~> m -> m' },
      ],
    });
    expect(errors).toHaveLength(0);
  });

  test('typevar not used in any method signature', () => {
    const errors = validateConstraintDef({
      name: 'Bad', typeVar: 'f',
      methods: [{ name: 'foo', signature: 'a -> b' }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("'f' is not used");
  });

  test('inconsistent kind — typevar used bare and applied', () => {
    const errors = validateConstraintDef({
      name: 'Bad', typeVar: 'm',
      methods: [
        { name: 'empty', signature: '() -> m' },
        { name: 'chain', signature: 'm a ~> (a -> m b) -> m b' },
      ],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Inconsistent kind');
  });

  test('Monad-style: all applied — no inconsistency', () => {
    const errors = validateConstraintDef({
      name: 'Monad', typeVar: 'm',
      methods: [
        { name: 'chain', signature: 'm a ~> (a -> m b) -> m b' },
        { name: 'of', signature: 'a -> m a' },
      ],
    });
    expect(errors).toHaveLength(0);
  });

  test('Semigroup-style: all bare — no inconsistency', () => {
    const errors = validateConstraintDef({
      name: 'Semigroup', typeVar: 's',
      methods: [{ name: 'concat', signature: 's ~> s -> s' }],
    });
    expect(errors).toHaveLength(0);
  });
});

// =========================================================================
// Data Type Registry
// =========================================================================

describe('data type registry — registration and lookup', () => {
  const maybeDecl = {
    name: 'Maybe',
    typeVars: ['a'],
    variants: [
      { name: 'Just', fields: ['a'] },
      { name: 'Nothing', fields: [] as string[] },
    ],
    commentStart: 0,
    commentEnd: 30,
  };

  test('registerDataType makes type available via isDataType', () => {
    registerDataType(maybeDecl);
    expect(isDataType('Maybe')).toBe(true);
    expect(isDataType('Either')).toBe(false);
  });

  test('variants are registered and discoverable via isVariant', () => {
    registerDataType(maybeDecl);
    expect(isVariant('Just')).toBe(true);
    expect(isVariant('Nothing')).toBe(true);
    expect(isVariant('Maybe')).toBe(false);
  });

  test('getParentTypeName returns correct parent', () => {
    registerDataType(maybeDecl);
    expect(getParentTypeName('Just')).toBe('Maybe');
    expect(getParentTypeName('Nothing')).toBe('Maybe');
    expect(getParentTypeName('Unknown')).toBeNull();
  });

  test('getDataType returns full registration', () => {
    registerDataType(maybeDecl);
    const reg = getDataType('Maybe');
    expect(reg).not.toBeNull();
    expect(reg!.decl.name).toBe('Maybe');
    expect(reg!.variantMap.size).toBe(2);
    expect(reg!.variantMap.get('Just')).toBeDefined();
    expect(reg!.variantMap.get('Nothing')).toBeDefined();
  });

  test('getDataType returns null for unknown type', () => {
    expect(getDataType('NonExistent')).toBeNull();
  });

  test('getVariant returns variant definition', () => {
    registerDataType(maybeDecl);
    const just = getVariant('Just');
    expect(just).not.toBeNull();
    expect(just!.name).toBe('Just');
    expect(just!.fields).toEqual(['a']);
    const nothing = getVariant('Nothing');
    expect(nothing).not.toBeNull();
    expect(nothing!.fields).toEqual([]);
  });

  test('getVariant returns null for unknown variant', () => {
    expect(getVariant('Unknown')).toBeNull();
  });

  test('getDataTypeNames returns all registered type names', () => {
    registerDataType(maybeDecl);
    registerDataType({
      name: 'Either',
      typeVars: ['e', 'a'],
      variants: [
        { name: 'Left', fields: ['e'] },
        { name: 'Right', fields: ['a'] },
      ],
      commentStart: 0,
      commentEnd: 40,
    });
    const names = getDataTypeNames();
    expect(names.has('Maybe')).toBe(true);
    expect(names.has('Either')).toBe(true);
    expect(names.size).toBe(2);
  });

  test('getVariantNames returns all variant names', () => {
    registerDataType(maybeDecl);
    const names = getVariantNames();
    expect(names.has('Just')).toBe(true);
    expect(names.has('Nothing')).toBe(true);
  });
});

describe('data type registry — display string', () => {
  test('getDataTypeDisplayString for type with type vars', () => {
    registerDataType({
      name: 'Maybe',
      typeVars: ['a'],
      variants: [
        { name: 'Just', fields: ['a'] },
        { name: 'Nothing', fields: [] },
      ],
      commentStart: 0,
      commentEnd: 30,
    });
    expect(getDataTypeDisplayString('Maybe')).toBe('Maybe :: Just a | Nothing');
  });

  test('getDataTypeDisplayString for type without type vars', () => {
    registerDataType({
      name: 'Bool',
      typeVars: [],
      variants: [
        { name: 'True', fields: [] },
        { name: 'False', fields: [] },
      ],
      commentStart: 0,
      commentEnd: 20,
    });
    expect(getDataTypeDisplayString('Bool')).toBe('Bool :: True | False');
  });

  test('getDataTypeDisplayString for multi-field variant', () => {
    registerDataType({
      name: 'Either',
      typeVars: ['e', 'a'],
      variants: [
        { name: 'Left', fields: ['e'] },
        { name: 'Right', fields: ['a'] },
      ],
      commentStart: 0,
      commentEnd: 40,
    });
    expect(getDataTypeDisplayString('Either')).toBe('Either :: Left e | Right a');
  });

  test('getDataTypeDisplayString returns null for unknown type', () => {
    expect(getDataTypeDisplayString('NonExistent')).toBeNull();
  });

  test('getDataTypeDisplayString for variants with concrete type fields', () => {
    registerDataType({
      name: 'Result',
      typeVars: [],
      variants: [
        { name: 'Ok', fields: ['Number'] },
        { name: 'Err', fields: ['String'] },
      ],
      commentStart: 0,
      commentEnd: 40,
    });
    expect(getDataTypeDisplayString('Result')).toBe('Result :: Ok Number | Err String');
  });

  test('getDataTypeDisplayString for variants with mixed concrete and var fields', () => {
    registerDataType({
      name: 'Container',
      typeVars: ['a'],
      variants: [
        { name: 'Wrap', fields: ['a', 'Number'] },
        { name: 'Empty', fields: [] },
      ],
      commentStart: 0,
      commentEnd: 40,
    });
    expect(getDataTypeDisplayString('Container')).toBe('Container :: Wrap a Number | Empty');
  });
});

describe('data type registry — clear', () => {
  test('clearDataTypes removes all registrations', () => {
    registerDataType({
      name: 'Maybe',
      typeVars: ['a'],
      variants: [
        { name: 'Just', fields: ['a'] },
        { name: 'Nothing', fields: [] },
      ],
      commentStart: 0,
      commentEnd: 30,
    });
    expect(isDataType('Maybe')).toBe(true);
    expect(isVariant('Just')).toBe(true);

    clearDataTypes();

    expect(isDataType('Maybe')).toBe(false);
    expect(isVariant('Just')).toBe(false);
    expect(getDataType('Maybe')).toBeNull();
    expect(getVariant('Just')).toBeNull();
  });
});

describe('data type registry — snapshot / restore / merge', () => {
  const maybeDecl = {
    name: 'Maybe',
    typeVars: ['a'],
    variants: [
      { name: 'Just', fields: ['a'] },
      { name: 'Nothing', fields: [] as string[] },
    ],
    commentStart: 0,
    commentEnd: 30,
  };

  test('snapshot captures current state and restore reverts to it', () => {
    registerDataType(maybeDecl);
    const snap = snapshotDataTypeRegistry();

    // Register another type
    registerDataType({
      name: 'Either',
      typeVars: ['e', 'a'],
      variants: [
        { name: 'Left', fields: ['e'] },
        { name: 'Right', fields: ['a'] },
      ],
      commentStart: 0,
      commentEnd: 40,
    });
    expect(isDataType('Either')).toBe(true);

    // Restore — Either should be gone
    restoreDataTypeRegistry(snap);
    expect(isDataType('Maybe')).toBe(true);
    expect(isDataType('Either')).toBe(false);
    expect(isVariant('Left')).toBe(false);
  });

  test('merge adds missing types without overwriting existing', () => {
    registerDataType(maybeDecl);
    const snap = snapshotDataTypeRegistry();

    clearDataTypes();
    registerDataType({
      name: 'Either',
      typeVars: ['e', 'a'],
      variants: [
        { name: 'Left', fields: ['e'] },
        { name: 'Right', fields: ['a'] },
      ],
      commentStart: 0,
      commentEnd: 40,
    });

    // Merge snap (Maybe) into current (Either)
    mergeDataTypeRegistry(snap);
    expect(isDataType('Maybe')).toBe(true);
    expect(isDataType('Either')).toBe(true);
  });

  test('merge does not overwrite existing type', () => {
    registerDataType(maybeDecl);

    // Create a different Maybe in a snapshot
    clearDataTypes();
    registerDataType({
      name: 'Maybe',
      typeVars: ['x'],
      variants: [{ name: 'Some', fields: ['x'] }],
      commentStart: 0,
      commentEnd: 20,
    });
    const altSnap = snapshotDataTypeRegistry();

    // Restore original Maybe
    clearDataTypes();
    registerDataType(maybeDecl);

    // Merge — should keep original Maybe (Just/Nothing), not overwrite with Some
    mergeDataTypeRegistry(altSnap);
    const reg = getDataType('Maybe');
    expect(reg!.variantMap.has('Just')).toBe(true);
    expect(reg!.variantMap.has('Some')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Method registry — built-in type custom method snapshot/restore
// ---------------------------------------------------------------------------

describe('methodRegistry — built-in type custom methods', () => {
  afterEach(() => clearCustomMethods());

  test('snapshot captures custom methods on built-in Array and restore reinstates them', () => {
    // Add a custom method to the built-in Array type
    registerMethod('Array', 'customSum', {
      signature: '[Number] ~> Number',
      factory: () => tNumber,
    });
    expect(lookupMethod('Array', 'customSum')).toBeDefined();

    // Snapshot should include custom method but not built-in map/filter etc
    const snap = snapshotMethodRegistry();
    expect(snap.methods['Array']).toBeDefined();
    expect(snap.methods['Array']['customSum']).toBeDefined();

    // Clear custom methods
    clearCustomMethods();
    expect(lookupMethod('Array', 'customSum')).toBeNull();
    // Built-in methods should still exist
    expect(lookupMethod('Array', 'map')).toBeDefined();

    // Restore — custom method should be back
    restoreMethodRegistry(snap);
    expect(lookupMethod('Array', 'customSum')).toBeDefined();
    // Built-in methods should still exist
    expect(lookupMethod('Array', 'map')).toBeDefined();
  });
});
