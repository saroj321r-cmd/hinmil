import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter, tRecord, tNumber, tString } from '../../src/hm/types';
import { parseTypeSignature, parseMethodTypeSignature } from '../../src/hm/typeParser';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

// =========================================================================
// TRecord basics
// =========================================================================

describe('Record type basics', () => {
  test('tRecord typeToString', () => {
    const r = tRecord({ name: tString, age: tNumber });
    expect(typeToString(r)).toBe('{ name :: String, age :: Number }');
  });

  test('empty record typeToString', () => {
    const r = tRecord({});
    expect(typeToString(r)).toBe('{}');
  });
});

// =========================================================================
// Object expression inference
// =========================================================================

describe('Object expression inference', () => {
  test('object literal infers record type', () => {
    const r = engine.infer(`const obj = { x: 1, y: 2 };`);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('{ x :: Number, y :: Number }');
  });

  test('object literal with mixed types', () => {
    const r = engine.infer(`const obj = { name: "hello", age: 42 };`);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('{ name :: String, age :: Number }');
  });

  test('object literal with boolean', () => {
    const r = engine.infer(`const obj = { active: true, count: 0 };`);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('{ active :: Boolean, count :: Number }');
  });

  test('empty object literal', () => {
    const r = engine.infer(`const obj = {};`);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('{}');
  });

  test('nested object literal', () => {
    const r = engine.infer(`const obj = { inner: { x: 1 } };`);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('{ inner :: { x :: Number } }');
  });
});

// =========================================================================
// Record field access
// =========================================================================

describe('Record field access', () => {
  test('access field of object literal', () => {
    const r = engine.infer(`
const obj = { x: 1, y: "hello" };
const val = obj.x;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Number');
  });

  test('access string field of object literal', () => {
    const r = engine.infer(`
const obj = { x: 1, name: "hello" };
const val = obj.name;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('String');
  });

  test('access method field of object literal', () => {
    const r = engine.infer(`
const obj = { greet: (name) => "hello " + name };
const fn = obj.greet;
    `);
    expect(r.diagnostics).toHaveLength(0);
    // JS string concat doesn't constrain the param type
    const resolved = r.substitution.apply(r.type);
    expect(resolved.tag).toBe('TFun');
    if (resolved.tag === 'TFun') {
      expect(typeToString(resolved.result)).toBe('String');
    }
  });
});

// =========================================================================
// Type parser: juxtaposition type application
// =========================================================================

describe('Type parser — juxtaposition', () => {
  test('Box a parses as TCon("Box", [a])', () => {
    const t = parseTypeSignature('Box a');
    expect(typeToString(t.type)).toBe('Box a');
    expect(t.vars.length).toBe(1);
  });

  test('a -> Box a parses correctly', () => {
    const t = parseTypeSignature('a -> Box a');
    expect(typeToString(t.type)).toBe('a -> Box a');
  });

  test('Box a -> Box b parses as two applications', () => {
    const t = parseTypeSignature('Box a -> Box b');
    expect(typeToString(t.type)).toBe('Box a -> Box b');
    expect(t.vars.length).toBe(2);
  });

  test('Map k v parses as TCon("Map", [k, v])', () => {
    const t = parseTypeSignature('Map k v');
    expect(typeToString(t.type)).toBe('Map k v');
    expect(t.vars.length).toBe(2);
  });

  test('Either a b -> c parses correctly', () => {
    const t = parseTypeSignature('Either a b -> c');
    expect(typeToString(t.type)).toBe('Either a b -> c');
  });

  test('Box without args still works', () => {
    const t = parseTypeSignature('Box');
    expect(typeToString(t.type)).toBe('Box');
  });

  test('Box a with angle bracket input still works', () => {
    const t = parseTypeSignature('Box<a>');
    expect(typeToString(t.type)).toBe('Box a');
  });
});

// =========================================================================
// Type parser: ~> method type signature
// =========================================================================

describe('Type parser — ~> method signatures', () => {
  test('parseMethodTypeSignature with simple receiver', () => {
    const r = parseMethodTypeSignature('Box a ~> a');
    expect(typeToString(r.receiver)).toBe('Box a');
    expect(typeToString(r.methodType)).toBe('a');
  });

  test('parseMethodTypeSignature with function method', () => {
    const r = parseMethodTypeSignature('Box a ~> (a -> b) -> Box b');
    expect(typeToString(r.receiver)).toBe('Box a');
    expect(typeToString(r.methodType)).toBe('(a -> b) -> Box b');
  });

  test('shared vars between receiver and method', () => {
    const r = parseMethodTypeSignature('Box a ~> (a -> b) -> Box b');
    // The 'a' in receiver and method should share the same var id
    if (r.receiver.tag === 'TCon' && r.receiver.args[0]?.tag === 'TVar') {
      const receiverA = r.receiver.args[0].id;
      // Find 'a' in method type
      if (r.methodType.tag === 'TFun' && r.methodType.param.tag === 'TFun') {
        const methodA = r.methodType.param.param;
        if (methodA.tag === 'TVar') {
          expect(methodA.id).toBe(receiverA);
        }
      }
    }
    expect(r.scheme.vars.length).toBe(2); // a and b
  });
});

// =========================================================================
// Box pattern — full end-to-end
// =========================================================================

describe('Box pattern — user-defined type constructor', () => {
  test('Box constructor with annotation infers Box type', () => {
    const r = engine.infer(`
// Box :: a -> Box a
const Box = (value) => ({
  value
});
const b = Box(5);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Box Number');
  });

  test('Box#value method annotation enables field access', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#value :: Box a ~> a
const Box = (value) => ({
  value
});
const b = Box(5);
const v = b.value;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Number');
  });

  test('Box#map method annotation enables method call', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#map :: Box a ~> (a -> b) -> Box b
const Box = (value) => ({
  map: (f) => Box(f(value)),
  value
});
const b = Box(5);
const mapped = b.map((x) => x + 1);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Box Number');
  });

  test('Box#map changes element type', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#map :: Box a ~> (a -> b) -> Box b
const Box = (value) => ({
  map: (f) => Box(f(value)),
  value
});
const b = Box(5);
const mapped = b.map((x) => "hello");
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Box String');
  });

  test('Box full pattern with value and map', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#value :: Box a ~> a
// Box#map :: Box a ~> (a -> b) -> Box b
const Box = (value) => ({
  map: (f) => Box(f(value)),
  value
});
const boxedNumber = Box(5);
const v = boxedNumber.value;
const mapped = boxedNumber.map((x) => x > 0);
    `);
    expect(r.diagnostics).toHaveLength(0);
    // v should be Number
    const vType = r.nodeTypes.get(
      [...r.nodeTypes.entries()].find(([_, { type: t }]) => typeToString(r.substitution.apply(t)) === 'Number')?.[0] ?? -1
    );
    expect(typeToString(r.substitution.apply(r.type))).toBe('Box Boolean');
  });

  test('Box with string value', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#value :: Box a ~> a
const Box = (value) => ({
  value
});
const b = Box("hello");
const v = b.value;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('String');
  });

  test('chained map on Box', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#map :: Box a ~> (a -> b) -> Box b
const Box = (value) => ({
  map: (f) => Box(f(value)),
  value
});
const result = Box(5).map((x) => x > 0).map((b) => "yes");
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Box String');
  });
});

// =========================================================================
// Annotations: # name syntax
// =========================================================================

describe('Annotations — # method syntax', () => {
  test('annotations with # names are extracted', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#value :: Box a ~> a
const Box = (a) => a;
const x = 1;
    `);
    expect(r.annotations.has('Box#value')).toBe(true);
    const ann = r.annotations.get('Box#value')!;
    expect(ann.receiver).toBeDefined();
    expect(ann.methodType).toBeDefined();
  });

  test('# annotation does not interfere with regular annotations', () => {
    const r = engine.infer(`
// add :: (Number, Number) -> Number
const add = (a, b) => a + b;
// Box :: a -> Box a
// Box#value :: Box a ~> a
const Box = (a) => a;
const x = add(1, 2);
    `);
    expect(r.diagnostics).toHaveLength(0);
    // The regular add annotation still works
    expect(typeToString(r.type)).toBe('Number');
  });

  test('orphan Name#method annotation (no Name constructor) is diagnosed and dropped', () => {
    const r = engine.infer(`
// Box#value :: Box a ~> a
const x = 1;
    `);
    // The orphan-method check produces a diagnostic…
    expect(r.diagnostics.some(d =>
      d.message.startsWith("Method annotation 'Box#value :: ...'")
      && d.message.includes('has no constructor')
    )).toBe(true);
    // …and the annotation is removed from the registered map.
    expect(r.annotations.has('Box#value')).toBe(false);
  });
});

// =========================================================================
// Custom type: Pair
// =========================================================================

describe('Custom type — Pair', () => {
  test('Pair constructor and field access', () => {
    const r = engine.infer(`
// Pair :: (a, b) -> Pair a b
// Pair#fst :: Pair a b ~> a
// Pair#snd :: Pair a b ~> b
const Pair = (fst, snd) => ({ fst, snd });
const p = Pair(1, "hello");
const first = p.fst;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Number');
  });

  test('Pair second field', () => {
    const r = engine.infer(`
// Pair :: (a, b) -> Pair a b
// Pair#fst :: Pair a b ~> a
// Pair#snd :: Pair a b ~> b
const Pair = (fst, snd) => ({ fst, snd });
const p = Pair(1, "hello");
const second = p.snd;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('String');
  });
});

// =========================================================================
// Method signatures for hover
// =========================================================================

describe('Method signatures for hover', () => {
  test('methodSignatures map records method access signature', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#map :: Box a ~> (a -> b) -> Box b
const Box = (value) => ({
  map: (f) => Box(f(value)),
  value
});
const b = Box(5);
const mapped = b.map((x) => x + 1);
    `);
    expect(r.diagnostics).toHaveLength(0);
    // methodSignatures should contain the concrete map signature
    const sigs = [...r.methodSignatures.values()];
    expect(sigs).toContain('Box#map :: Box Number ~> (Number -> b) -> Box b');
  });

  test('Array method signatures are recorded', () => {
    const r = engine.infer(`
const nums = [1, 2, 3];
const doubled = nums.map((n) => n * 2);
    `);
    expect(r.diagnostics).toHaveLength(0);
    const sigs = [...r.methodSignatures.values()];
    expect(sigs).toContain('Array#map :: [Number] ~> ((Number, Number, [Number]) -> b) -> [b]');
  });

  test('String method signatures are recorded', () => {
    const r = engine.infer(`
const s = "hello";
const upper = s.toUpperCase;
    `);
    expect(r.diagnostics).toHaveLength(0);
    const sigs = [...r.methodSignatures.values()];
    expect(sigs).toContain('String#toUpperCase :: String ~> String');
  });
});

// =========================================================================
// Static methods (dot annotations)
// =========================================================================

describe('Static method annotations (dot syntax)', () => {
  test('Box.fromPair annotation is extracted', () => {
    const r = engine.infer(`
// Box :: a -> Box a
const Box = (value) => ({ value });
// Box.fromPair :: Pair a b -> Box a
Box.fromPair = pair => Box(pair.fst);
    `);
    expect(r.annotations.has('Box.fromPair')).toBe(true);
  });

  test('Box.fromPair is registered as method and callable', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#value :: Box a ~> a
const Box = (value) => ({ value });
// Pair :: (a, b) -> Pair a b
// Pair#fst :: Pair a b ~> a
const Pair = (fst, snd) => ({ fst, snd });
// Box.fromPair :: Pair a b -> Box a
Box.fromPair = pair => Box(pair.fst);
const p = Pair(1, "hello");
const boxFromPair = Box.fromPair(p);
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Box Number');
  });

  test('Box.fromPair mismatched annotation produces diagnostic', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#value :: Box a ~> a
const Box = (value) => ({ value });
// Pair :: (a, b) -> Pair a b
// Pair#fst :: Pair a b ~> a
const Pair = (fst, snd) => ({ fst, snd });
// Box.fromPair :: Pair a b -> Box b
Box.fromPair = pair => Box(pair.fst);
    `);
    // Implementation returns Box(pair.fst) = Box a, but annotation says Box b
    // Rigid check detects that distinct vars a and b would be collapsed
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('Box.of static constructor', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#value :: Box a ~> a
const Box = (value) => ({ value });
// Box.of :: a -> Box a
Box.of = (x) => Box(x);
const b = Box.of(42);
const v = b.value;
    `);
    expect(r.diagnostics).toHaveLength(0);
    expect(typeToString(r.type)).toBe('Number');
  });
});

// =========================================================================
// Object spread
// =========================================================================

describe('Object spread', () => {
  test('spread in object expression merges fields', () => {
    const r = engine.infer(`
      const base = { x: 1, y: 2 };
      const extended = { ...base, z: 3 };
    `);
    expect(r.diagnostics).toHaveLength(0);
    const extType = Array.from(r.nodeTypes.values()).find(v =>
      v.type.tag === 'TRecord' && 'z' in v.type.fields && 'x' in v.type.fields
    );
    expect(extType).toBeDefined();
  });

  test('spread overrides existing fields', () => {
    const r = engine.infer(`
      const defaults = { color: "red", size: 10 };
      const custom = { ...defaults, color: "blue" };
    `);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('object spread with destructuring', () => {
    const r = engine.infer(`
      const defaults = { x: 1, y: 2 };
      const overrides = { y: 3, z: 4 };
      const merged = { ...defaults, ...overrides };
      const { x, y, z } = merged;
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// Computed property names
// =========================================================================

describe('Computed property names', () => {
  test('computed property name in object literal', () => {
    const r = engine.infer(`
      const key = "name";
      const obj = { [key]: "value", fixed: 42 };
    `);
    expect(r.diagnostics).toHaveLength(0);
    const objType = Array.from(r.nodeTypes.values()).find(v =>
      v.type.tag === 'TRecord' && 'fixed' in v.type.fields
    );
    expect(objType).toBeDefined();
  });
});

// =========================================================================
// Missing record fields validation
// =========================================================================

describe('Missing record fields', () => {
  test('function returning partial record reports missing fields', () => {
    const r = engine.infer(`
// Person :: { name :: String, age :: Number }
// makePerson :: String -> Person
const makePerson = name => ({ name: name })
    `);
    const missing = r.diagnostics.filter(d => d.message.startsWith('Missing record field'));
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain("'age'");
    expect(missing[0].message).toContain('Person');
  });

  test('function returning complete record produces no missing fields diagnostic', () => {
    const r = engine.infer(`
// Person :: { name :: String, age :: Number }
// makePerson :: String -> Person
const makePerson = name => ({ name: name, age: 42 })
    `);
    const missing = r.diagnostics.filter(d => d.message.startsWith('Missing record field'));
    expect(missing).toHaveLength(0);
  });

  test('missing fields with Maybe type works correctly', () => {
    const r = engine.infer(`
// Maybe :: Just a | Nothing
// Just :: a -> Maybe a
const Just = x => ({ value: x })

// Person :: { name :: String, age :: Number, email :: Maybe Number }
// convertEmailToPerson :: Number -> Person
const convertEmailToPerson = email => ({
  name: "hello",
  email: Just(email)
})
    `);
    // Should have missing fields for 'age', but NO type mismatch for email
    const missing = r.diagnostics.filter(d => d.message.startsWith('Missing record field'));
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain("'age'");
    const typeMismatch = r.diagnostics.filter(d => d.message.startsWith('Cannot unify'));
    expect(typeMismatch).toHaveLength(0);
  });

  test('function declaration with missing fields reports diagnostic', () => {
    const r = engine.infer(`
// Env :: { count :: Number, name :: String }
// makeEnv :: Number -> Env
function makeEnv(count) { return { count: count } }
    `);
    const missing = r.diagnostics.filter(d => d.message.startsWith('Missing record field'));
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain("'name'");
  });

  test('non-record return type does not trigger missing fields check', () => {
    const r = engine.infer(`
// greet :: String -> String
const greet = name => "Hello " + name
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// Zero-param arrow functions in object literals
// =========================================================================

describe('Zero-param arrow functions in object literals', () => {
  test('zero-param arrow in object literal is inferred as () -> T', () => {
    const r = engine.infer(`
const obj = { greet: () => "hello" };
const fn = obj.greet;
    `);
    expect(r.diagnostics).toHaveLength(0);
    const resolved = r.substitution.apply(r.type);
    expect(resolved.tag).toBe('TFun');
    if (resolved.tag === 'TFun') {
      expect(typeToString(resolved.result)).toBe('String');
    }
  });

  test('zero-param method in factory record matches registered method type', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#inspect :: Box a ~> () -> String
const Box = value => ({
  inspect: () => "Box(" + value + ")"
});
    `);
    const unify = r.diagnostics.filter(d => d.message.includes('Cannot unify'));
    expect(unify).toHaveLength(0);
  });

  test('mixed zero-param and one-param methods in factory produce no errors', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#map :: Box a ~> (a -> b) -> Box b
// Box#inspect :: Box a ~> () -> String
const Box = value => ({
  value: value,
  map: fn => Box(fn(value)),
  inspect: () => "Box"
});
    `);
    const unify = r.diagnostics.filter(d => d.message.includes('Cannot unify'));
    expect(unify).toHaveLength(0);
  });
});

// =========================================================================
// Missing record fields for non-sumtype TCon with registered methods
// =========================================================================

describe('Missing record fields for non-sumtype TCon', () => {
  test('reports missing fields for non-sumtype TCon factory', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#map :: Box a ~> (a -> b) -> Box b
// Box#inspect :: Box a ~> () -> String
const Box = value => ({
  value: value
});
    `);
    const missing = r.diagnostics.filter(d => d.message.startsWith('Missing record field'));
    expect(missing.length).toBeGreaterThanOrEqual(1);
    const msgs = missing.map(d => d.message).join(', ');
    expect(msgs).toContain('map');
    expect(msgs).toContain('inspect');
  });

  test('no missing fields when all methods are present', () => {
    const r = engine.infer(`
// Box :: a -> Box a
// Box#map :: Box a ~> (a -> b) -> Box b
// Box#inspect :: Box a ~> () -> String
const Box = value => ({
  value: value,
  map: fn => Box(fn(value)),
  inspect: () => "Box"
});
    `);
    const missing = r.diagnostics.filter(d => d.message.startsWith('Missing record field'));
    expect(missing).toHaveLength(0);
  });

  test('class-based factory reports missing fields', () => {
    const r = engine.infer(`
// Building#info :: Building ~> () -> String
class Building {
  constructor(name, floors) {
    this.name = name;
    this.floors = floors;
  }
}

// createBuilding :: String -> Number -> Building
const createBuilding = (name) => (floors) => ({
  name: name,
  floors: floors
});
    `);
    const missing = r.diagnostics.filter(d => d.message.startsWith('Missing record field'));
    expect(missing.length).toBeGreaterThanOrEqual(1);
    expect(missing.map(d => d.message).join(', ')).toContain('info');
  });

  test('class-based factory with all fields produces no missing diagnostic', () => {
    const r = engine.infer(`
// Building#info :: Building ~> () -> String
class Building {
  constructor(name, floors) {
    this.name = name;
    this.floors = floors;
  }
}

// createBuilding :: String -> Number -> Building
const createBuilding = (name) => (floors) => ({
  name: name,
  floors: floors,
  info: () => "building info"
});
    `);
    const missing = r.diagnostics.filter(d => d.message.startsWith('Missing record field'));
    expect(missing).toHaveLength(0);
    const unify = r.diagnostics.filter(d => d.message.includes('Cannot unify'));
    expect(unify).toHaveLength(0);
  });
});