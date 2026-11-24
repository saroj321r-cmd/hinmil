// Tests for extensible record property assignment.
// When a user adds a property to an object (via `obj.prop = value`),
// the LSP should not emit a "Property does not exist" diagnostic and
// the new property should be visible for subsequent reads / intellisense.

import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

describe('Extensible record — property assignment', () => {
  test('adding a property to an empty object produces no diagnostic', () => {
    const r = engine.infer(`
      const obj = {};
      obj.foo = 42;
    `);
    const propErrors = r.diagnostics.filter(d => d.message.includes('does not exist'));
    expect(propErrors).toHaveLength(0);
  });

  test('adding a property to a non-empty object produces no diagnostic', () => {
    const r = engine.infer(`
      const obj = { x: 1 };
      obj.y = "hello";
    `);
    const propErrors = r.diagnostics.filter(d => d.message.includes('does not exist'));
    expect(propErrors).toHaveLength(0);
  });

  test('newly added property is accessible without diagnostic', () => {
    const r = engine.infer(`
      const obj = {};
      obj.key = "world";
      const v = obj.key;
    `);
    const propErrors = r.diagnostics.filter(d => d.message.includes('does not exist'));
    expect(propErrors).toHaveLength(0);
  });

  test('Param.js pattern — namespace object extended with constructors', () => {
    const r = engine.infer(`
      const Param = {};
      Param.Path = (key) => ({ key });
      Param.Query = (key) => ({ key });
      const p = Param.Path("id");
    `);
    const propErrors = r.diagnostics.filter(d => d.message.includes('does not exist'));
    expect(propErrors).toHaveLength(0);
  });

  test('Object.create pattern — extending prototype object with properties', () => {
    const r = engine.infer(`
      const proto = { greet: () => "hi" };
      const x = Object.create(proto);
      x.key = "myKey";
      x.rules = [];
      x.defaultValue = null;
    `);
    const propErrors = r.diagnostics.filter(d => d.message.includes('does not exist'));
    expect(propErrors).toHaveLength(0);
  });

  test('existing record field still type-checked on assignment', () => {
    // Assigning to an EXISTING field should still unify types.
    // Number vs String should produce a diagnostic.
    const r = engine.infer(`
      const obj = { x: 1 };
      obj.x = "oops";
    `);
    const unifyErrors = r.diagnostics.filter(d =>
      d.message.includes('Cannot unify') || d.message.includes('cannot unify'),
    );
    expect(unifyErrors.length).toBeGreaterThan(0);
  });

  test('multiple sequential property additions on same object', () => {
    const r = engine.infer(`
      const Namespace = {};
      Namespace.A = 1;
      Namespace.B = "two";
      Namespace.C = true;
    `);
    const propErrors = r.diagnostics.filter(d => d.message.includes('does not exist'));
    expect(propErrors).toHaveLength(0);
  });

  test('this-property assignments inside constructor are not affected', () => {
    // this.prop = ... is handled separately and should continue to work.
    const r = engine.infer(`
      class Box {
        constructor(val) {
          this.val = val;
        }
      }
      const b = new Box(42);
    `);
    expect(r.diagnostics).toHaveLength(0);
  });
});
