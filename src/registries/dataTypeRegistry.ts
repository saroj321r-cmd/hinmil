// ============================================================================
// Data Type Registry — sum type declarations
//
// Plain language: a *sum type* is a type declared as a fixed menu of
// alternatives (its *variants*) — e.g. "a Maybe is EITHER a Just holding a
// value OR a Nothing".  This file is the notebook where all declared sum
// types are written down, with quick lookups in both directions:
// "which variants does Maybe have?" and "which type does Just belong to?".
//
// Tracks the relationship between sum types and their variants.
// Example: `// Maybe :: Just a | Nothing` registers:
//   - Maybe has variants [Just, Nothing]
//   - Just is a variant of Maybe (carrying field 'a')
//   - Nothing is a variant of Maybe (carrying no fields)
//
// This enables:
//   1. Warning when users write variant#method instead of Type#method
//   2. Automatic method inheritance from parent type to variants
//   3. Hover display of sum type definitions
// ============================================================================

import { DataTypeDecl, DataVariant, recordFields } from '../commentParser';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisteredDataType {
  /** The sum type declaration */
  decl: DataTypeDecl;
  /** Map from variant name to its definition */
  variantMap: Map<string, DataVariant>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Map from sum type name → registered data type. */
const dataTypes = new Map<string, RegisteredDataType>();

/** Reverse map from variant name → parent sum type name. */
const variantToParent = new Map<string, string>();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a sum type declaration.
 * Updates both the forward (type → variants) and reverse (variant → type) maps.
 */
export function registerDataType(decl: DataTypeDecl): void {
  const variantMap = new Map<string, DataVariant>();
  for (const v of decl.variants) {
    variantMap.set(v.name, v);
    variantToParent.set(v.name, decl.name);
  }
  dataTypes.set(decl.name, { decl, variantMap });
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** Get the parent sum type name for a variant, or null if not a registered variant. */
export function getParentTypeName(variantName: string): string | null {
  return variantToParent.get(variantName) ?? null;
}

/** Check if a name is a registered variant of any sum type. */
export function isVariant(name: string): boolean {
  return variantToParent.has(name);
}

/** Check if a name is a registered sum type. */
export function isDataType(name: string): boolean {
  return dataTypes.has(name);
}

/** Get the full data type declaration by sum type name. */
export function getDataType(name: string): RegisteredDataType | null {
  return dataTypes.get(name) ?? null;
}

/** Get the variant definition for a variant name. */
export function getVariant(variantName: string): DataVariant | null {
  const parentName = variantToParent.get(variantName);
  if (!parentName) return null;
  return dataTypes.get(parentName)?.variantMap.get(variantName) ?? null;
}

/**
 * Collect the record-style field labels (and their raw type text) declared
 * across all variants of a sumtype.  A declaration such as
 *   `Component :: | Engine { ext :: String, handler :: EngineFn } | ...`
 * contributes `ext` and `handler`.  Positional variants (`Redirect Number
 * String`) have no labelled fields and contribute nothing.  When two variants
 * declare the same label, the first occurrence wins.
 *
 * These labels are the properties a `Parent ~>` method can read off `this`
 * (e.g. inside a `matchWith` implementation), so member-access checking uses
 * them to accept `this.ext` without a hand-written `Component#ext` annotation
 * or a constructor that assigns the field.
 */
export function getVariantRecordFields(parentName: string): Map<string, string> {
  const out = new Map<string, string>();
  const reg = dataTypes.get(parentName);
  if (!reg) return out;
  for (const v of reg.decl.variants) {
    for (const f of v.fields) {
      for (const { name, type } of recordFields(f)) {
        if (!out.has(name)) out.set(name, type);
      }
    }
  }
  return out;
}

/** Get all registered data type names. */
export function getDataTypeNames(): Set<string> {
  return new Set(dataTypes.keys());
}

/** Get all registered variant names. */
export function getVariantNames(): Set<string> {
  return new Set(variantToParent.keys());
}

/**
 * Get the full sum type declaration string for display (e.g. in hover).
 * Returns something like "Maybe :: Just a | Nothing".
 */
export function getDataTypeDisplayString(typeName: string): string | null {
  const reg = dataTypes.get(typeName);
  if (!reg) return null;
  const { decl } = reg;
  const rhs = decl.variants.map(v =>
    v.fields.length > 0 ? `${v.name} ${v.fields.join(' ')}` : v.name,
  ).join(' | ');
  return `${decl.name} :: ${rhs}`;
}

/**
 * Get just the right-hand side variant union for a registered sumtype
 * (e.g. "Just a | Nothing" for Maybe).  Returns null when not registered.
 */
export function getDataTypeVariantUnion(typeName: string): string | null {
  const reg = dataTypes.get(typeName);
  if (!reg) return null;
  return reg.decl.variants.map(v =>
    v.fields.length > 0 ? `${v.name} ${v.fields.join(' ')}` : v.name,
  ).join(' | ');
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Clear all data type registrations (called at the start of each inference run). */
export function clearDataTypes(): void {
  dataTypes.clear();
  variantToParent.clear();
}

// ---------------------------------------------------------------------------
// Snapshot / Restore / Merge — for cross-file import support
// ---------------------------------------------------------------------------

export type DataTypeRegistrySnapshot = {
  dataTypes: Map<string, RegisteredDataType>;
  variantToParent: Map<string, string>;
};

/** Save a snapshot of all data type registrations. */
export function snapshotDataTypeRegistry(): DataTypeRegistrySnapshot {
  return {
    dataTypes: new Map(dataTypes),
    variantToParent: new Map(variantToParent),
  };
}

/** Restore data type registrations from a snapshot. */
export function restoreDataTypeRegistry(snap: DataTypeRegistrySnapshot): void {
  dataTypes.clear();
  variantToParent.clear();
  for (const [k, v] of snap.dataTypes) dataTypes.set(k, v);
  for (const [k, v] of snap.variantToParent) variantToParent.set(k, v);
}

/** Merge a snapshot's registrations into the current registry (non-destructive). */
export function mergeDataTypeRegistry(snap: DataTypeRegistrySnapshot): void {
  for (const [k, v] of snap.dataTypes) {
    if (!dataTypes.has(k)) dataTypes.set(k, v);
  }
  for (const [k, v] of snap.variantToParent) {
    if (!variantToParent.has(k)) variantToParent.set(k, v);
  }
}
