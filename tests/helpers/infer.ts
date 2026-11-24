// Shared inference helpers for the test suite.
//
// `engine.infer()` clears all registries (methods, constraints, data types)
// at the start of every run, so a fresh engine plus a type-var counter reset
// is enough for a deterministic, isolated inference.

import { InferenceEngine, defaultEnv } from '../../src/infer';
import { InferenceResult } from '../../src/infer/types';
import {
  resetTypeVarCounter,
  typeToString,
  prettyTypeToString,
} from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

export { InferenceEngine, defaultEnv };
export type { InferenceResult };

/** Reset global registries + type-var counter and return a fresh engine. */
export function freshEngine(): InferenceEngine {
  clearCustomMethods();
  resetTypeVarCounter();
  return new InferenceEngine();
}

/** Infer a source string with a fresh engine (deterministic type vars). */
export function inferSource(source: string): InferenceResult {
  return freshEngine().infer(source);
}

/** Diagnostic messages produced for a source string. */
export function diags(source: string): string[] {
  return inferSource(source).diagnostics.map(d => d.message);
}

/** `typeToString` of the program's top-level inferred type. */
export function typeOf(source: string): string {
  return typeToString(inferSource(source).type);
}

/** `prettyTypeToString` of the program's top-level inferred type. */
export function prettyTypeOf(source: string): string {
  return prettyTypeToString(inferSource(source).type);
}

/** Assert-friendly shorthand: true when the source infers without diagnostics. */
export function isClean(source: string): boolean {
  return inferSource(source).diagnostics.length === 0;
}
