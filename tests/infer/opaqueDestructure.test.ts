// When destructuring from a fully opaque source (a property access on a
// value whose type is just an unbound type variable — typical when
// something like `tables :: c` is annotated and we read
// `tables.organisation`), the locals should be bound to `Any`, so that
// each call site is checked flexibly without the FIRST call pinning the
// local's type to a specific function shape.
//
// Likewise, an array literal whose expected type is `Any` (e.g. it is the
// argument to such a flexible-callee call) must not unify its elements
// against a single shared element variable: each element must be checked
// independently against `Any` so heterogeneous element shapes are accepted.

import { InferenceEngine } from '../../src/infer';

function diagMsgs(src: string): string[] {
  const eng = new InferenceEngine();
  return eng.infer(src).diagnostics
    .map(d => d.message)
    .filter(m => !m.startsWith('Unbound variable'));
}

describe('destructuring from an opaque source binds to Any', () => {
  it('a single call infers without errors', () => {
    const src = `
      // tables :: c
      const tables = getTables();
      const { Organisation } = tables.organisation;
      const r = Organisation([1, "two", { x: 3 }]);
    `;
    expect(diagMsgs(src)).toEqual([]);
  });

  it('multiple calls with differently-shaped argument arrays all succeed', () => {
    const src = `
      // tables :: c
      const tables = getTables();
      const { Organisation } = tables.organisation;
      const r1 = Organisation([1, 2, 3]);
      const r2 = Organisation(["a", "b"]);
      const r3 = Organisation([{ tag: 1 }]);
    `;
    expect(diagMsgs(src)).toEqual([]);
  });

  it('nested calls with mixed element shapes inside an array argument succeed', () => {
    const src = `
      // tables :: c
      const tables = getTables();
      const { Outer, Inner } = tables.t;
      const Limit = (n) => ({ tag: "Limit", n });
      const r = Outer([
        "id",
        Inner([Limit(5), "name"]),
        Limit(10),
      ]);
    `;
    expect(diagMsgs(src)).toEqual([]);
  });

  it('destructuring from a *known* record still uses the field type (no Any leak)', () => {
    // Sanity check: when the source is a TRecord with explicit fields,
    // we MUST keep the precise field types so that field-shape errors
    // are still reported.  Here `n` is bound to a Number — calling its
    // `.toFixed(...)` method works, but `.toUpperCase()` (a String
    // method) must produce a diagnostic.
    const src = `
      const makeRec = () => ({ n: 1 + 2 });
      const { n } = makeRec();
      const ok = n.toFixed(2);
      const bad = n.toUpperCase();
    `;
    const msgs = diagMsgs(src);
    expect(msgs.some(m => /toUpperCase/.test(m))).toBe(true);
  });
});

describe('array literal with expected type Any', () => {
  it('mixed primitive element types pass without unification errors', () => {
    const src = `
      // f :: Any
      const f = getF();
      const r = f([1, "two", true]);
    `;
    expect(diagMsgs(src)).toEqual([]);
  });

  it('mixed record element shapes pass without unification errors', () => {
    const src = `
      // f :: Any
      const f = getF();
      const r = f([{ a: 1 }, { b: 2, c: 3 }]);
    `;
    expect(diagMsgs(src)).toEqual([]);
  });
});
