// ============================================================================
// Analysis-pass session helpers
//
// Plain language: the checker keeps a few shared "notebooks" (registries)
// while analysing files — which methods each type has, which constraints and
// sum types exist — plus the ticket counter for fresh type variables.  This
// file offers save/restore/merge/clear operations on ALL of them at once, so
// each analysis pass starts clean and never corrupts another pass's notes.
//
// Bundles the global mutable state that every inference pass must manage:
// the method / constraint / data-type registries and the type-variable
// counter.  Before this module existed, every call site (engine.infer,
// ImportInferenceContext, server request handlers) manipulated the three
// registries and the counter individually, which made it easy to forget one
// of them and hard to reason about pass isolation.
// ============================================================================

import {
  snapshotMethodRegistry,
  restoreMethodRegistry,
  mergeMethodRegistry,
  clearCustomMethods,
  MethodRegistrySnapshot,
} from './methodRegistry';
import {
  snapshotConstraintRegistry,
  restoreConstraintRegistry,
  mergeConstraintRegistry,
  clearConstraints,
  ConstraintRegistrySnapshot,
} from './constraintRegistry';
import {
  snapshotDataTypeRegistry,
  restoreDataTypeRegistry,
  mergeDataTypeRegistry,
  clearDataTypes,
  DataTypeRegistrySnapshot,
} from './dataTypeRegistry';
import { saveTypeVarCounter, restoreTypeVarCounter } from '../hm/types';

/**
 * A combined snapshot of all global registries plus the type-variable
 * counter — everything an inference pass can mutate outside its own engine.
 */
export interface GlobalStateSnapshot {
  methods: MethodRegistrySnapshot;
  constraints: ConstraintRegistrySnapshot;
  dataTypes: DataTypeRegistrySnapshot;
  tvarCounter: number;
}

/** Capture all global registries and the current type-var counter. */
export function snapshotGlobalState(methodSnapshot?: MethodRegistrySnapshot): GlobalStateSnapshot {
  return {
    methods: methodSnapshot ?? snapshotMethodRegistry(),
    constraints: snapshotConstraintRegistry(),
    dataTypes: snapshotDataTypeRegistry(),
    tvarCounter: saveTypeVarCounter(),
  };
}

/**
 * Restore the three registries from a snapshot.  Deliberately does NOT
 * touch the type-var counter: the counter must never go backwards within
 * a request (fresh vars allocated after the snapshot must stay unique).
 * Use {@link bumpTypeVarCounterTo} for the monotonic counter reconcile.
 */
export function restoreGlobalRegistries(s: GlobalStateSnapshot): void {
  restoreMethodRegistry(s.methods);
  restoreConstraintRegistry(s.constraints);
  restoreDataTypeRegistry(s.dataTypes);
}

/**
 * Merge a snapshot's registrations into the current registries
 * (non-destructive) and bump the type-var counter so it is at least the
 * snapshot's value.  This is the cache-hit path for cross-file imports:
 * re-applying what a previously inferred file registered.
 */
export function mergeGlobalState(s: GlobalStateSnapshot): void {
  mergeMethodRegistry(s.methods);
  mergeConstraintRegistry(s.constraints);
  mergeDataTypeRegistry(s.dataTypes);
  bumpTypeVarCounterTo(s.tvarCounter);
}

/** Monotonic counter reconcile: never go backwards. */
export function bumpTypeVarCounterTo(min: number): void {
  if (saveTypeVarCounter() < min) restoreTypeVarCounter(min);
}

/**
 * Reset all global registries to their built-in baseline.  Called at the
 * start of every inference pass (engine.infer) so each pass starts from a
 * clean slate and re-registers only what its source (plus globals) declares.
 */
export function clearGlobalRegistries(): void {
  clearCustomMethods();
  clearConstraints();
  clearDataTypes();
}
