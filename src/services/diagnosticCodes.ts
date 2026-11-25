// ============================================================================
// Diagnostic Codes — stable numeric identifiers for each diagnostic category
// ============================================================================

/**
 * Every diagnostic emitted by hinmil carries a numeric `code` that uniquely
 * identifies its category.  These codes are:
 *
 * - Shown in the Problems panel (e.g. `hinmil(1001)`)
 * - Useful for `::ignore` extensions in the future (ignore by code)
 * - Stable across releases so external tooling can rely on them
 */

// ---------------------------------------------------------------------------
// Code constants
// ---------------------------------------------------------------------------

// 1xxx — Type errors
export const HM_TYPE_MISMATCH            = 1001;
export const HM_INFINITE_TYPE            = 1002;
export const HM_ANNOTATION_MISMATCH      = 1003;
export const HM_RETURN_TYPE_MISMATCH     = 1004;
export const HM_MISSING_PROPERTY         = 1005;
export const HM_UNCONSTRAINED_PROP       = 1006;
export const HM_UNBOUND_VARIABLE         = 1007;
export const HM_MISSING_RECORD_FIELDS    = 1008;
export const HM_NOT_CALLABLE             = 1009;
export const HM_EXCESS_RECORD_FIELDS     = 1010;

// 2xxx — Annotation issues
export const HM_INVALID_ANNOTATION       = 2001;
export const HM_NAME_MISMATCH            = 2002;
export const HM_METHOD_NAME_MISMATCH     = 2003;
export const HM_UNKNOWN_TYPE             = 2004;
export const HM_VARIANT_METHOD           = 2005;
export const HM_METHOD_TYPE_MISMATCH     = 2006;
export const HM_NAMELESS_ON_NAMED        = 2007;
export const HM_TYPE_ARITY_MISMATCH      = 2008;
export const HM_UNION_NARROWING           = 2009;
export const HM_TYPEREP_MISSING_ARG      = 2010;
export const HM_BARE_TVAR_VALUE_ANNOTATION = 2011;
export const HM_METHOD_ON_BARE_VALUE_TYPE  = 2012;
export const HM_ORPHAN_INSTANCE_CALLABLE   = 2013;
export const HM_ORPHAN_METHOD_ANNOTATION   = 2014;
export const HM_INVALID_NARROW             = 2015;

// 3xxx — Import / module issues
export const HM_MISSING_EXPORT           = 3001;
export const HM_UNRESOLVED_TYPES_PATH    = 3002;
export const HM_UNRESOLVED_IMPORT        = 3003;
export const HM_DUPLICATE_IMPORT         = 3004;
export const HM_CIRCULAR_IMPORT          = 3005;

// 4xxx — Constraint issues
export const HM_UNKNOWN_CONSTRAINT       = 4001;
export const HM_CONSTRAINT_VIOLATION     = 4002;
export const HM_INVALID_CONSTRAINT       = 4003;
export const HM_CONSTRAINT_KIND_MISMATCH = 4004;

// 5xxx — Curry issues
export const HM_CURRY_ARITY              = 5001;
export const HM_CURRY_TYPE               = 5002;
export const HM_CURRIED_OVER_APPLICATION = 5003;
export const HM_FANOUT_ARITY             = 5004;

// 6xxx — Missing signatures (informational)
export const HM_MISSING_SIGNATURE        = 6001;
export const HM_MISSING_VARIANT_IMPL     = 6002;

// 7xxx — Relation / Picked-projection issues
export const HM_INVALID_TABLE_RELATION   = 7001;

// 9xxx — Other / parse errors
export const HM_PARSE_ERROR              = 9001;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Diagnostic categories that can be configured (severity-or-off) through
 * the `hinmil.diagnostics.*` settings.  Keys match the corresponding
 * `HinMilSettings['diagnostics']` fields.
 */
export type ConfigurableDiagnosticCategory =
  | 'typeErrors'
  | 'unknownPropertyAccess'
  | 'missingRecordFields'
  | 'excessRecordFields'
  | 'annotationNarrowing';

/**
 * Map a diagnostic code to its configurable category, or `null` when the
 * code has no user-facing severity setting (those always report as errors,
 * unless the engine attached an explicit severity).
 */
export function codeToCategory(code: number): ConfigurableDiagnosticCategory | null {
  switch (code) {
    case HM_TYPE_MISMATCH:
    case HM_INFINITE_TYPE:
    case HM_ANNOTATION_MISMATCH:
    case HM_RETURN_TYPE_MISMATCH:
    case HM_NOT_CALLABLE:
    case HM_INVALID_TABLE_RELATION:
      return 'typeErrors';
    case HM_MISSING_PROPERTY:
    case HM_UNCONSTRAINED_PROP:
      return 'unknownPropertyAccess';
    case HM_MISSING_RECORD_FIELDS:
      return 'missingRecordFields';
    case HM_EXCESS_RECORD_FIELDS:
      return 'excessRecordFields';
    case HM_UNION_NARROWING:
      return 'annotationNarrowing';
    default:
      return null;
  }
}

/**
 * Map a diagnostic message to a numeric code.
 *
 * Uses prefix matching to classify messages into categories.  Order matters:
 * more specific patterns are checked before general ones.
 */
export function classifyDiagnosticCode(message: string): number {
  // Parse errors (filtered by mapInferenceDiagnostics, but classify anyway)
  if (message.startsWith('Parse error')) return HM_PARSE_ERROR;

  // Invalid `::narrow` directive (non-function / non-Boolean target, unmatched
  // label, etc.).  Parse-time narrow errors are wrapped in an
  // "Invalid type annotation for 'X': …" prefix, so match anywhere.
  if (message.includes('::narrow ')) return HM_INVALID_NARROW;

  // Annotation parse errors
  if (message.startsWith('Invalid type annotation')) return HM_INVALID_ANNOTATION;
  if (message.startsWith('Invalid ::constraint')) return HM_INVALID_CONSTRAINT;

  // Name mismatches
  if (message.startsWith("Declaration name '") && message.includes('does not match annotation name')) return HM_NAME_MISMATCH;
  if (message.startsWith("Method name '") && message.includes('does not match annotation')) return HM_METHOD_NAME_MISMATCH;

  // Nameless annotation on named declaration
  if (message.startsWith("Nameless annotation")) return HM_NAMELESS_ON_NAMED;

  // Type name mismatch in method annotation (e.g. "Type name mismatch in method annotation: ...")
  if (message.startsWith('Type name mismatch in method annotation')) return HM_METHOD_TYPE_MISMATCH;

  // Variant method annotation misuse (e.g. "'Left' is a variant of 'Either'. Use ...")
  if (message.includes('is a variant of') && message.includes('Use ')) return HM_VARIANT_METHOD;

  // Unknown type constructor
  if (message.startsWith("Unknown type constructor '")) return HM_UNKNOWN_TYPE;

  // Type constructor arity mismatch
  if (message.startsWith("Type constructor '") && message.includes('expects')) return HM_TYPE_ARITY_MISMATCH;

  // Bare type variable value annotation (e.g. `Tag :: a`)
  if (message.includes('annotated as an unconstrained type variable')) return HM_BARE_TVAR_VALUE_ANNOTATION;

  // Instance method declared on a type whose value annotation is a bare TVar
  if (message.includes('annotates') && message.includes('as a plain type variable rather than a type constructor')) return HM_METHOD_ON_BARE_VALUE_TYPE;

  // Orphan instance-callable: `Name()` declared without a constructor `Name :: ...`
  if (message.startsWith("Instance-callable annotation '") && message.includes('has no constructor')) return HM_ORPHAN_INSTANCE_CALLABLE;

  // Orphan method/static annotation: `Name#m` / `Name.m` without a constructor / class / sumtype `Name`
  if ((message.startsWith("Method annotation '") || message.startsWith("Static annotation '")) && message.includes('has no constructor')) return HM_ORPHAN_METHOD_ANNOTATION;

  // Union narrowing
  if (message.startsWith('Annotation narrows')) return HM_UNION_NARROWING;

  // Unresolvable ::types path
  if (message.startsWith('Cannot resolve ::types path')) return HM_UNRESOLVED_TYPES_PATH;

  // Missing export
  if (message.includes('is not exported from') || message.includes('has no default export')) return HM_MISSING_EXPORT;

  // Unresolved import
  if (message.startsWith('Cannot resolve module')) return HM_UNRESOLVED_IMPORT;

  // Duplicate import
  if (message.startsWith('Duplicate import')) return HM_DUPLICATE_IMPORT;

  // Circular import
  if (message.startsWith('Circular import')) return HM_CIRCULAR_IMPORT;

  // Constraint issues
  if (message.startsWith("Unknown constraint '")) return HM_UNKNOWN_CONSTRAINT;
  if (message.includes('cannot satisfy constraint')) return HM_CONSTRAINT_VIOLATION;
  if (message.includes('does not satisfy constraint')) return HM_CONSTRAINT_VIOLATION;
  if (message.includes('kind mismatch')) return HM_CONSTRAINT_KIND_MISMATCH;
  if (message.includes('Inconsistent kind')) return HM_CONSTRAINT_KIND_MISMATCH;
  if (message.includes('is not used in any method signature')) return HM_INVALID_CONSTRAINT;

  // Curry issues
  if (message.startsWith('Curry wrapper expects exactly')) return HM_CURRY_ARITY;
  if (message === 'Curry wrapper expects a function argument') return HM_CURRY_TYPE;
  if (message.startsWith('::curried only works in .hm files')) return HM_CURRY_TYPE;
  if (message.includes('Curried function called with')) return HM_CURRIED_OVER_APPLICATION;

  // Fan-out combinator (converge/combine): branch count vs combiner arity
  if (message.includes('fan-out combiner')) return HM_FANOUT_ARITY;

  // Annotation mismatch (rigid check / unified format)
  if (message === 'Type mismatch: implementation does not match annotation') return HM_ANNOTATION_MISMATCH;
  if (/^Type mismatch: ('[^']+'|value) has (return )?type /.test(message)) return HM_ANNOTATION_MISMATCH;

  // Return type mismatch (legacy union-return wording)
  if (message.startsWith('Type mismatch: function returns')) return HM_RETURN_TYPE_MISMATCH;

  // Property access
  if (message.startsWith("Property '") && message.includes('does not exist on type')) return HM_MISSING_PROPERTY;
  if (message.startsWith("Property '") && message.includes('accessed on unconstrained')) return HM_UNCONSTRAINED_PROP;

  // Missing record fields
  if (message.startsWith('Missing record field')) return HM_MISSING_RECORD_FIELDS;
  if (message.startsWith('Missing required field')) return HM_MISSING_RECORD_FIELDS;
  if (message.startsWith('Unknown field')) return HM_EXCESS_RECORD_FIELDS;

  // Unbound variable
  if (message.startsWith('Unbound variable:')) return HM_UNBOUND_VARIABLE;

  // Infinite type
  if (message.startsWith('Infinite type')) return HM_INFINITE_TYPE;
  if (message.includes('has an infinite type')) return HM_INFINITE_TYPE;

  // Picked-union mismatch — emitted when a value's projected record's row
  // (`pickedFrom`) does not match any `Picked R …` branch in the expected
  // union (typical query-builder / DSL-style "X is not a relation of Y" case).
  if (/ is not a valid relation here\b/.test(message)) return HM_INVALID_TABLE_RELATION;
  if (/ has no relation with /.test(message)) return HM_INVALID_TABLE_RELATION;

  // General unification error (fallback)
  if (message.startsWith('Type mismatch: Cannot unify') || message.startsWith('Cannot unify')) return HM_TYPE_MISMATCH;

  // Missing signature (generated by detectMissingSignatures, not inference)
  if (message.includes('has no HM annotation')) return HM_MISSING_SIGNATURE;

  // Missing variant method implementation
  if (message.includes('does not implement')) return HM_MISSING_VARIANT_IMPL;

  // Default fallback
  return HM_TYPE_MISMATCH;
}
