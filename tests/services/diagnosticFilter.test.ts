// ============================================================================
// Diagnostic filtering helpers (services/diagnostics.ts)
//
// Three pure filter functions:
//   - filterIgnoredDiagnostics: drops diagnostics on ignored lines
//   - filterAnnotationMismatchDiagnostics: drops annotation-vs-inferred mismatches
//   - filterDiagnosticsInsideBindings: drops diagnostics fully inside any interval
// ============================================================================

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import {
  filterIgnoredDiagnostics,
  filterAnnotationMismatchDiagnostics,
  filterDiagnosticsInsideBindings,
} from '../../src/services/diagnostics';
import { InferenceDiagnostic } from '../../src/infer';

function lspDiag(line: number, message = 'x'): Diagnostic {
  return {
    severity: DiagnosticSeverity.Error,
    range: {
      start: { line, character: 0 },
      end: { line, character: 1 },
    },
    message,
    source: 'hinmil',
  };
}

function inferDiag(start: number, end: number, message: string): InferenceDiagnostic {
  return { start, end, message };
}

// ---------------------------------------------------------------------------

describe('filterIgnoredDiagnostics', () => {
  test('removes diagnostics whose start line is ignored', () => {
    const diags = [lspDiag(0), lspDiag(2), lspDiag(5)];
    const out = filterIgnoredDiagnostics(diags, new Set([2]));
    expect(out.map((d) => d.range.start.line)).toEqual([0, 5]);
  });

  test('returns input unchanged when ignored set is empty', () => {
    const diags = [lspDiag(0), lspDiag(1)];
    expect(filterIgnoredDiagnostics(diags, new Set())).toEqual(diags);
  });

  test('returns empty array when all lines are ignored', () => {
    const diags = [lspDiag(3), lspDiag(4)];
    expect(filterIgnoredDiagnostics(diags, new Set([3, 4]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('filterAnnotationMismatchDiagnostics', () => {
  test('drops "implementation does not match annotation" diagnostics', () => {
    const diags = [
      inferDiag(0, 5, 'Type mismatch: implementation does not match annotation'),
      inferDiag(10, 15, 'Other error'),
    ];
    const out = filterAnnotationMismatchDiagnostics(diags);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe('Other error');
  });

  test('drops "function returns" mismatch diagnostics', () => {
    const diags = [
      inferDiag(0, 5, 'Type mismatch: function returns Number but annotation says String'),
      inferDiag(10, 15, 'Unbound variable: foo'),
    ];
    const out = filterAnnotationMismatchDiagnostics(diags);
    expect(out.map((d) => d.message)).toEqual(['Unbound variable: foo']);
  });

  test('drops unified mismatch format ("value has type ...")', () => {
    const diags = [
      inferDiag(0, 5, "Type mismatch: 'foo' has type Number"),
      inferDiag(10, 15, 'Type mismatch: value has return type String'),
      inferDiag(20, 25, 'Unrelated diagnostic'),
    ];
    const out = filterAnnotationMismatchDiagnostics(diags);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe('Unrelated diagnostic');
  });

  test('preserves diagnostics that do not start with a mismatch prefix', () => {
    const diags = [
      inferDiag(0, 5, 'Unbound variable: x'),
      inferDiag(10, 15, 'Cannot resolve module ./foo'),
    ];
    expect(filterAnnotationMismatchDiagnostics(diags)).toEqual(diags);
  });
});

// ---------------------------------------------------------------------------

describe('filterDiagnosticsInsideBindings', () => {
  test('drops diagnostics fully inside an interval', () => {
    const diags = [
      inferDiag(5, 10, 'inside'),
      inferDiag(50, 60, 'outside'),
    ];
    const out = filterDiagnosticsInsideBindings(diags, [[0, 20]]);
    expect(out.map((d) => d.message)).toEqual(['outside']);
  });

  test('keeps diagnostics that overhang an interval boundary', () => {
    const diags = [
      inferDiag(5, 25, 'overhangs right'),
      inferDiag(0, 10, 'overhangs left'),
    ];
    // both extend outside [0,20] / [10,30]? Use one interval [10, 20].
    const out = filterDiagnosticsInsideBindings(diags, [[10, 20]]);
    expect(out).toHaveLength(2);
  });

  test('inclusive at both ends — exact-coincident diagnostic is dropped', () => {
    const diags = [inferDiag(10, 20, 'exact')];
    const out = filterDiagnosticsInsideBindings(diags, [[10, 20]]);
    expect(out).toEqual([]);
  });

  test('returns input unchanged when interval list is empty', () => {
    const diags = [inferDiag(0, 5, 'a'), inferDiag(10, 15, 'b')];
    expect(filterDiagnosticsInsideBindings(diags, [])).toEqual(diags);
  });

  test('drops diagnostic if it falls inside any of multiple intervals', () => {
    const diags = [
      inferDiag(5, 8, 'in first'),
      inferDiag(105, 108, 'in second'),
      inferDiag(200, 210, 'outside both'),
    ];
    const out = filterDiagnosticsInsideBindings(diags, [[0, 20], [100, 120]]);
    expect(out.map((d) => d.message)).toEqual(['outside both']);
  });
});
