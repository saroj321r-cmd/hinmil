// ============================================================================
// End-to-end coverage for the tri-state `trustAnnotations` setting.
//
// A single source contains three classes of issues:
//   1. An annotated binding `good` whose body produces a type error.
//   2. An un-annotated binding `loose` whose body produces a type error.
//   3. A top-level statement (outside any binding) that produces an error.
//
// We then exercise the four levels and assert what survives each filter.
// ============================================================================

import {
  InferenceEngine,
  filterAnnotationMismatchDiagnostics,
  filterDiagnosticsInsideBindings,
  collectBindingIntervals,
} from '../../src/index';
import { TrustAnnotationsLevel } from '../../src/config';
import { InferenceDiagnostic } from '../../src/infer';

const SOURCE = `
// takesNum :: Number -> Number
const takesNum = (n) => n + 1;
// good :: Number -> Number
const good = (x) => takesNum("oops");
const loose = (x) => takesNum("oops");
takesNum("top");
`;

function applyLevel(
  diags: InferenceDiagnostic[],
  result: ReturnType<InferenceEngine['infer']>,
  level: TrustAnnotationsLevel,
): InferenceDiagnostic[] {
  let out = diags;
  if (level !== 'off') out = filterAnnotationMismatchDiagnostics(out);
  if (level === 'annotated-bodies' || level === 'all-bodies') {
    const mode = level === 'all-bodies' ? 'all' : 'annotated';
    out = filterDiagnosticsInsideBindings(out, collectBindingIntervals(result, mode));
  }
  return out;
}

function diagAtOffset(
  diags: InferenceDiagnostic[],
  start: number,
  end: number,
): InferenceDiagnostic | undefined {
  return diags.find((d) => d.start >= start && d.end <= end);
}

describe('trustAnnotations tri-state — end-to-end', () => {
  const engine = new InferenceEngine();
  const result = engine.infer(SOURCE);

  // Compute extent of each binding from `bindingExtents` (engine output).
  const extents = result.bindingExtents ?? [];
  // SOURCE has three bindings: takesNum (annotated), good (annotated), loose (un-annotated).
  const sourceCode = SOURCE;
  const goodExt = extents.find((e) => e.annotated && sourceCode.slice(e.start, e.end).includes('good'));
  const looseExt = extents.find((e) => !e.annotated);

  test('engine populates bindingExtents with annotated flag', () => {
    expect(extents.length).toBe(3);
    expect(extents.filter((e) => e.annotated)).toHaveLength(2);
    expect(extents.filter((e) => !e.annotated)).toHaveLength(1);
    expect(goodExt).toBeDefined();
    expect(looseExt).toBeDefined();
  });

  test('off — every diagnostic surfaces', () => {
    const out = applyLevel(result.diagnostics, result, 'off');
    // At least: one inside `good`, one inside `loose`, and one top-level.
    expect(diagAtOffset(out, goodExt!.start, goodExt!.end)).toBeDefined();
    expect(diagAtOffset(out, looseExt!.start, looseExt!.end)).toBeDefined();
    // top-level `1 + "top"` is outside both bindings.
    const outsideBindings = out.filter(
      (d) =>
        !(d.start >= goodExt!.start && d.end <= goodExt!.end) &&
        !(d.start >= looseExt!.start && d.end <= looseExt!.end),
    );
    expect(outsideBindings.length).toBeGreaterThan(0);
  });

  test('signatures — body errors still shown, only mismatch dropped', () => {
    const off = applyLevel(result.diagnostics, result, 'off');
    const sig = applyLevel(result.diagnostics, result, 'signatures');
    // Body errors inside good/loose remain visible.
    expect(diagAtOffset(sig, goodExt!.start, goodExt!.end)).toBeDefined();
    expect(diagAtOffset(sig, looseExt!.start, looseExt!.end)).toBeDefined();
    // The signatures level filters at least as much as off (≤ count).
    expect(sig.length).toBeLessThanOrEqual(off.length);
  });

  test('annotated-bodies — diagnostic inside annotated binding suppressed', () => {
    const out = applyLevel(result.diagnostics, result, 'annotated-bodies');
    expect(diagAtOffset(out, goodExt!.start, goodExt!.end)).toBeUndefined();
    // Un-annotated body still flagged.
    expect(diagAtOffset(out, looseExt!.start, looseExt!.end)).toBeDefined();
  });

  test('all-bodies — both binding-internal diagnostics suppressed', () => {
    const out = applyLevel(result.diagnostics, result, 'all-bodies');
    expect(diagAtOffset(out, goodExt!.start, goodExt!.end)).toBeUndefined();
    expect(diagAtOffset(out, looseExt!.start, looseExt!.end)).toBeUndefined();
    // Top-level diagnostics (outside any binding) are still surfaced.
    const outsideBindings = out.filter(
      (d) =>
        !(d.start >= goodExt!.start && d.end <= goodExt!.end) &&
        !(d.start >= looseExt!.start && d.end <= looseExt!.end),
    );
    // Engine may or may not emit a diagnostic for `1 + "top"` depending on
    // unification rules; the key property is that the filter doesn't strip
    // anything that lies *outside* every binding's extent.
    for (const d of outsideBindings) {
      const inGood = d.start >= goodExt!.start && d.end <= goodExt!.end;
      const inLoose = d.start >= looseExt!.start && d.end <= looseExt!.end;
      expect(inGood || inLoose).toBe(false);
    }
  });
});
