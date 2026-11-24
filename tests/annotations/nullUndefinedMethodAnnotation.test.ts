// Verifies that `Null` and `Undefined` are accepted as method-annotation
// receivers (like `Array`, `String`, `Number`, …) so a prelude declaring
// e.g.
//
//   // Null#equals :: Null ~> Null -> Boolean
//   natives.Null = function (_other) { return true; };
//
// does not raise the orphan-method diagnostic
//   "Method annotation 'Null#equals :: ...' has no constructor 'Null :: ...'"
// and the registered method is visible to subsequent lookups.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { clearCustomMethods, getMethodNames } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  clearCustomMethods();
  engine = new InferenceEngine();
});

const SRC = `"use strict";

let natives = {};

// Null#equals :: Null ~> Null -> Boolean
natives.Null = function (_other) {
  return true;
};

// Undefined#equals :: Undefined ~> Undefined -> Boolean
natives.Undefined = function (_other) {
  return true;
};
`;

describe('Null / Undefined as method-annotation receivers', () => {
  test('no orphan-method diagnostic for Null#equals', () => {
    const r = engine.infer(SRC);
    const orphan = r.diagnostics.filter(d =>
      d.message.includes("has no constructor 'Null'"));
    expect(orphan).toEqual([]);
  });

  test('no orphan-method diagnostic for Undefined#equals', () => {
    const r = engine.infer(SRC);
    const orphan = r.diagnostics.filter(d =>
      d.message.includes("has no constructor 'Undefined'"));
    expect(orphan).toEqual([]);
  });

  test('Null#equals is registered in the method registry', () => {
    engine.infer(SRC);
    expect(getMethodNames('Null')).toContain('equals');
  });

  test('Undefined#equals is registered in the method registry', () => {
    engine.infer(SRC);
    expect(getMethodNames('Undefined')).toContain('equals');
  });
});
