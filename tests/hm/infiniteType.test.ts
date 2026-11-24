// Phase A: occurs-check ("infinite type") diagnostics.
//
// `reduce(apply)` is a genuine type-changing fold whose accumulator is
// invariant, so unifying `apply :: (a -> b) -> a -> b` against reduce's
// accumulator function `(b -> a -> b)` forces `b ~ a -> b` — an infinite
// type.  When the resulting binding is UNSIGNED we surface a clear,
// actionable diagnostic attributed to the binding name.  When the binding
// carries an explicit signature, the signature is authoritative and the
// infinite-type diagnostic is dropped (mirrors the server post-pass).

import { InferenceEngine } from '../../src/infer';
import { InferenceDiagnostic } from '../../src/infer';
import {
  classifyDiagnosticCode,
  HM_INFINITE_TYPE,
} from '../../src/services/diagnosticCodes';
import { collectBindingIntervals } from '../../src/services/diagnostics';

function infer(src: string) {
  return new InferenceEngine().infer(src);
}

// Replicates the server.ts "signature overrules infinite type" post-pass.
function dropInfiniteInsideAnnotated(
  result: ReturnType<InferenceEngine['infer']>,
): InferenceDiagnostic[] {
  const intervals = collectBindingIntervals(result, 'annotated');
  if (intervals.length === 0) return result.diagnostics;
  return result.diagnostics.filter((d) => {
    if (classifyDiagnosticCode(d.message) !== HM_INFINITE_TYPE) return true;
    return !intervals.some(([s, e]) => d.start >= s && d.end <= e);
  });
}

const PRELUDE = `
// apply :: (a -> b) -> a -> b
const apply = (f) => (x) => f(x);
// reduce :: (b -> a -> b) -> b -> Array a -> b
const reduce = (f) => (acc) => (xs) => acc;
`;

describe('infinite type (occurs check) diagnostics', () => {
  test('unsigned binding surfaces an infinite-type diagnostic naming the binding', () => {
    const result = infer(`${PRELUDE}
const applyArgs = reduce(apply);
`);
    const infinite = result.diagnostics.filter(
      (d) => classifyDiagnosticCode(d.message) === HM_INFINITE_TYPE,
    );
    expect(infinite).toHaveLength(1);
    expect(infinite[0].message).toMatch(/^applyArgs has an infinite type/);
    expect(infinite[0].message).toContain('occurs in');
    expect(infinite[0].message).toContain('Add a type signature.');
  });

  test('explicit signature overrules the infinite-type diagnostic', () => {
    const result = infer(`${PRELUDE}
// applyArgs :: (a -> b -> c) -> Array a -> c
const applyArgs = reduce(apply);
`);
    const filtered = dropInfiniteInsideAnnotated(result);
    const infinite = filtered.filter(
      (d) => classifyDiagnosticCode(d.message) === HM_INFINITE_TYPE,
    );
    expect(infinite).toHaveLength(0);
  });
});
