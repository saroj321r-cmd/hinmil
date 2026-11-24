// Scenario: class-based model code consumed by another module.
//
// src/Vector.js is a classic 2-D vector class written the way sample/
// classes are annotated: instance members via `Vector#field :: Vector ~> T`,
// instance methods via `Vector#method :: Vector ~> ...`, and static
// factories via `Vector.name :: ...`.
//
// src/physics.js consumes the class: constructs instances with `new`,
// uses the static factory, and chains instance methods.  We assert
// method/instance types, the static factory type, and one misuse.

import { TempProject } from '../helpers/project';
import { prettyTypeToString, Scheme } from '../../src/hm/types';

const project = new TempProject('scenario-class-model');

const VECTOR_JS = `// Vector :: (Number, Number) -> Vector
class Vector {
  constructor(x, y) {
    // Vector#x :: Vector ~> Number
    this.x = x;
    // Vector#y :: Vector ~> Number
    this.y = y;
  }

  // Vector#add :: Vector ~> Vector -> Vector
  add(other) {
    return new Vector(this.x + other.x, this.y + other.y);
  }

  // Vector#scale :: Vector ~> Number -> Vector
  scale(k) {
    return new Vector(this.x * k, this.y * k);
  }

  // Vector#length :: Vector ~> () -> Number
  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }

  // Vector.origin :: () -> Vector
  static origin() {
    return new Vector(0, 0);
  }

  // Vector.of :: (Number, Number) -> Vector
  static of(x, y) {
    return new Vector(x, y);
  }
}

export { Vector };
`;

const PHYSICS_JS = `import { Vector } from './Vector.js';

// A constructed instance and a factory-produced instance.
const velocity = new Vector(3, 4);
const start = Vector.origin();

// Chained instance methods stay in the Vector world…
const doubled = velocity.add(start).scale(2);

// …until a scalar-producing method is called.
const speed = velocity.length();

// displacement :: (Vector, Number) -> Vector
const displacement = (v, t) => v.scale(t);

export { velocity, start, doubled, speed, displacement };
`;

function exportType(res: { exports: Map<string, Scheme> }, name: string): string {
  const scheme = res.exports.get(name);
  expect(scheme).toBeDefined();
  return prettyTypeToString(scheme!.type);
}

beforeAll(() => {
  project.setup();
  project.write('src/Vector.js', VECTOR_JS);
  project.write('src/physics.js', PHYSICS_JS);
});

afterAll(() => project.cleanup());

describe('Vector.js in isolation', () => {
  it('infers cleanly', () => {
    const res = project.inferFile('src/Vector.js');
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
  });

  it('registers the annotated instance methods and static factories', () => {
    const res = project.inferFile('src/Vector.js');
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    // All annotations (instance methods, fields, statics) are recorded.
    const keys = [...res.annotations.keys()];
    expect(keys).toEqual(expect.arrayContaining([
      'Vector', 'Vector#x', 'Vector#y',
      'Vector#add', 'Vector#scale', 'Vector#length',
      'Vector.origin', 'Vector.of',
    ]));
    // Static factory signatures surface at their definition sites.
    const signatures = [...res.methodSignatures.values()];
    expect(signatures).toContain('Vector.origin :: () -> Vector');
    expect(signatures).toContain('Vector.of :: (Number, Number) -> Vector');
  });
});

describe('physics.js — the consumer', () => {
  it('produces zero diagnostics', () => {
    const res = project.inferFile('src/physics.js');
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
  });

  it('constructed and factory-produced values are Vector instances', () => {
    const res = project.inferFile('src/physics.js');
    expect(exportType(res, 'velocity')).toBe('Vector');
    expect(exportType(res, 'start')).toBe('Vector');
  });

  it('chained instance methods keep the instance type', () => {
    const res = project.inferFile('src/physics.js');
    expect(exportType(res, 'doubled')).toBe('Vector');
  });

  it('scalar-returning method produces Number', () => {
    const res = project.inferFile('src/physics.js');
    expect(exportType(res, 'speed')).toBe('Number');
  });

  it('functions over imported instances get precise types', () => {
    const res = project.inferFile('src/physics.js');
    expect(exportType(res, 'displacement')).toBe('(Vector, Number) -> Vector');
  });
});

describe('misuse is diagnosed', () => {
  // NOTE: primitive-argument mismatches against imported signatures (e.g.
  // `v.scale('big')`) are deliberately lenient — the engine auto-unions
  // simple TCon mismatches unless the callee is annotated in the current
  // file.  Vector itself is NOT unionable in these shapes, so the realistic
  // failures below all surface diagnostics.

  it('passing a Vector where a local annotated fn expects a Number is reported', () => {
    const res = project.inferSource('src/bad1.js', `import { Vector } from './Vector.js';

// double :: Number -> Number
const double = (n) => n * 2;

const v = new Vector(3, 4);
// Bug: passing the vector instead of its length.
const oops = double(v);
export { oops };
`);
    const msgs = res.diagnostics.map(d => d.message);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(m => m.includes('Vector') && m.includes('Number'))).toBe(true);
  });

  it('using a Vector instance in arithmetic is reported', () => {
    const res = project.inferSource('src/bad2.js', `import { Vector } from './Vector.js';
const v = new Vector(3, 4);
// Bug: forgot to call .length().
const oops = v * 2;
export { oops };
`);
    const msgs = res.diagnostics.map(d => d.message);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(m => m.includes('Vector') && m.includes('Number'))).toBe(true);
  });

  it('a consumer annotation that contradicts a method result is reported', () => {
    const res = project.inferSource('src/bad3.js', `import { Vector } from './Vector.js';
const v = new Vector(3, 4);
// label :: String
const label = v.length();
export { label };
`);
    const msgs = res.diagnostics.map(d => d.message);
    expect(msgs.some(m =>
      m.includes("'label' has type 'Number' but annotation expects 'String'"),
    )).toBe(true);
  });
});
