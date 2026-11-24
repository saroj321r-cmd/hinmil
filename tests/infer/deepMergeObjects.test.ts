// Regression: merging objects with `{ ...a, ...b }` (and the label-polymorphic
// spread form) must DEEP-merge overlapping keys — combining nested records
// field-wise and same-constructor containers arg-wise — rather than dropping
// one side or producing a shallow union of the whole values.

import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

describe('deep object merge (spread)', () => {
  test('overlapping array-valued keys merge element-wise into a union', () => {
    const src = `
const a = { age: 30, likedTypes: ["x"] };
const b = { likedTypes: [1], name: "n" };
const merged = { ...a, ...b };
`;
    const ts = typeToString(engine.infer(src).type);
    expect(ts).toContain('likedTypes :: [Number | String]');
    expect(ts).toContain('age :: Number');
    expect(ts).toContain('name :: String');
  });

  test('overlapping record-valued keys merge field-wise recursively', () => {
    const src = `
const a = { friends: [{ name: "x", likedTypes: [true] }] };
const b = { friends: [{ name: 1, likedTypes: [2] }] };
const merged = { ...a, ...b };
`;
    const ts = typeToString(engine.infer(src).type);
    expect(ts).toContain('name :: Number | String');
    expect(ts).toContain('likedTypes :: [Boolean | Number]');
  });

  test('scalar overlapping keys union (no deep recursion)', () => {
    const src = `
const a = { x: 1 };
const b = { x: "s" };
const merged = { ...a, ...b };
`;
    const ts = typeToString(engine.infer(src).type);
    expect(ts).toContain('x :: Number | String');
  });
});

describe('deep merge through annotated label-polymorphic merge functions', () => {
  test('two label-group params `({ [k]::a }, { [i]::b }) -> { [k]::a, [i]::b }`', () => {
    const src = `
// concatObjects :: ({ [k] :: a }, { [i] :: b }) -> { [k] :: a, [i] :: b }
const concatObjects = (x, y) => x;
const objects = concatObjects(
  {age: 1, likedTypes: ["String"], friends: [{ name: "Jane", likedTypes: [true]}] },
  {name: "John", likedTypes: [2], friends: [{name: 16, likedTypes: [1]}]});
`;
    const ts = typeToString(engine.infer(src).type);
    expect(ts).toContain('likedTypes :: [Number | String]');
    expect(ts).toContain('name :: Number | String');
    expect(ts).toContain('likedTypes :: [Boolean | Number]');
    expect(ts).toContain('age :: Number');
    expect(ts).toContain('name :: String');
  });

  test('label-group + open row `({ [k]::a }, {...b}) -> { [k]::a, ...b }`', () => {
    const src = `
// concatObjectsAlt :: ({ [k] :: a }, {...b}) -> { [k] :: a, ...b }
const concatObjectsAlt = (x, y) => x;
const objects = concatObjectsAlt(
  {age: 1, likedTypes: ["String"] },
  {name: "John", likedTypes: [2]});
`;
    const ts = typeToString(engine.infer(src).type);
    expect(ts).toMatch(/likedTypes :: \[(String \| Number|Number \| String)\]/);
    expect(ts).toContain('age :: Number');
    expect(ts).toContain('name :: String');
  });
});

describe('deep merge through annotated spread/row merge functions', () => {
  // Asserts the merged RESULT type only.  (Some of these forms also surface an
  // unrelated body-vs-annotation diagnostic when the literal impl `(x,y)=>x`
  // does not itself perform the merge the annotation promises — that is a
  // separate concern from the merge-result consistency verified here.)
  const O1 = `{age: 1, likedTypes: ["String"] }`;
  const O2 = `{name: "John", likedTypes: [2]}`;

  test('plain tuple annotation `({...a}, {...b}) -> { ...a, ...b }`', () => {
    const src = `
// f :: ({...a}, {...b}) -> { ...a, ...b }
const f = (x, y) => x;
const merged = f(${O1}, ${O2});
`;
    const ts = typeToString(engine.infer(src).type);
    expect(ts).toMatch(/likedTypes :: \[(String \| Number|Number \| String)\]/);
    expect(ts).toContain('age :: Number');
    expect(ts).toContain('name :: String');
  });

  test('prototype-method form `{ ...a } ~> { ...b } -> { ...a, ...b }`', () => {
    const src = `
// Object#concat :: { ...a } ~> { ...b } -> { ...a, ...b }
// concat :: { ...a } -> { ...b } -> { ...a, ...b }
const concat = a => b => a.concat(b);
const merged = concat(${O1})(${O2});
`;
    const ts = typeToString(engine.infer(src).type);
    expect(ts).toMatch(/likedTypes :: \[(String \| Number|Number \| String)\]/);
    expect(ts).toContain('age :: Number');
    expect(ts).toContain('name :: String');
  });
});


