/**
 * W4 verification — destructure with row-aware typing.
 *
 * Confirms that `const { a, ...rest } = obj` patterns allocate a TRow
 * (not a TVar) for the rest binding, and that annotations like
 * `stripId :: { id :: Number, ...r } -> { ...r }` work end-to-end.
 */

import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

describe('W4 — destructure row-aware typing', () => {
  test('stripId :: { id :: Number, ...r } -> { ...r } end-to-end', () => {
    const src = `
// stripId :: { id :: Number, ...r } -> { ...r }
const stripId = ({ id, ...rest }) => rest;
const out = stripId({ id: 1, name: "Ada", age: 36 });
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const ts = typeToString(r.type);
    expect(ts).toContain('name :: String');
    expect(ts).toContain('age :: Number');
    expect(ts).not.toContain('id :: ');
  });

  test('rest-row is re-instantiated per call (no leaking shape)', () => {
    const src = `
const strip = ({ k, ...rest }) => rest;
const a = strip({ k: 1, x: "s" });
const b = strip({ k: 1, y: true });
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const tsA = typeToString(engine.subst.apply(r.type));
    // `b` should not carry `x :: String` from the earlier call.
    expect(tsA).not.toContain('x :: ');
  });
});
