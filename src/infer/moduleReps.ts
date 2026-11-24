// moduleReps — the `::rep` representatives VISIBLE in a module, carried
// alongside its export map.
//
// A `::rep` normally travels attached to the exported scheme of a function
// whose constraints mention the repped constraint (see `repsForConstraints`
// in results.ts).  That breaks across an UNANNOTATED intermediate module:
// an FP library's `more/foldMap` calls `fl/reduce` (which carries
// `::rep Foldable Array#reduce`) but has no annotation, so its inferred export
// has no constraints and therefore no reps.  `more/mconcatMap` — annotated
// `Foldable f => …` — imports only `foldMap`, so the rep was invisible there
// and every `mconcatMap (Sum) (f) ([1, 2, 3])` call failed with HM4002
// "Array does not satisfy Foldable".
//
// Each module therefore also publishes every rep it can see (its own
// `fileReps` plus its `importedReps`), keyed by the export-map object, and
// importers merge those into their `importedReps`.  Keyed weakly so cached
// export maps keep their reps exactly as long as they live.

import type { RepEntry, Scheme } from '../hm/types';

const visibleReps = new WeakMap<Map<string, Scheme>, RepEntry[]>();

export function sameRep(a: RepEntry, b: RepEntry): boolean {
  return a.constraint === b.constraint
    && a.typeName === b.typeName
    && a.methodName === b.methodName
    && a.signature === b.signature
    && !!a.isStatic === !!b.isStatic;
}

/** Append `rep` to `into` unless an identical rep is already present. */
export function addRepUnique(into: RepEntry[], rep: RepEntry): void {
  if (!into.some((r) => sameRep(r, rep))) into.push(rep);
}

export function setModuleReps(exports: Map<string, Scheme>, reps: readonly RepEntry[]): void {
  if (reps.length === 0) return;
  const unique: RepEntry[] = [];
  for (const rep of reps) addRepUnique(unique, rep);
  visibleReps.set(exports, unique);
}

export function getModuleReps(exports: Map<string, Scheme>): readonly RepEntry[] {
  return visibleReps.get(exports) ?? [];
}
