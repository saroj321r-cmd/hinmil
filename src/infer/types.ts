// ============================================================================
// Inference Engine — Public type definitions
//
// Plain language: the shared "vocabulary" of the inference engine — the
// shape of a diagnostic (one warning/error with its location), of the final
// inference result handed to the editor services, and of the options the
// engine accepts.  No logic lives here, only definitions.
// ============================================================================

import { Type, Scheme, AstNode } from '../hm/types';
import { Substitution } from '../hm/substitution';
import { TypeAnnotation } from '../commentParser';

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface InferenceDiagnosticRelated {
  message: string;
  start: number;
  end: number;
}

export interface InferenceDiagnostic {
  message: string;
  start: number;   // offset in source
  end: number;      // offset in source
  /** Optional related location(s) that provide additional context. */
  relatedInformation?: InferenceDiagnosticRelated[];
  /** Optional severity override (LSP DiagnosticSeverity values: 1=Error, 2=Warning, 3=Information, 4=Hint).
   *  When set, takes precedence over the default severity passed to mapInferenceDiagnostics. */
  severity?: number;
}

// ---------------------------------------------------------------------------
// Narrow engine-context interfaces
//
// The InferenceEngine implements all of these.  Helper functions should
// declare the NARROWEST interface they actually need instead of the full
// engine, which documents their true dependencies and keeps them testable
// in isolation.  (See also `SpeculativeState` in ./helpers.ts.)
// ---------------------------------------------------------------------------

/** Emitting diagnostics: the error/warning collection side of the engine. */
export interface DiagnosticSink {
  diagnostics: InferenceDiagnostic[];
  addDiag(
    message: string,
    loc: { start: number; end: number },
    relatedInformation?: InferenceDiagnosticRelated[],
    severity?: number,
  ): void;
}

/** Resolving types against the live substitution and alias table. */
export interface TypeResolutionContext {
  subst: Substitution;
  /** Apply the substitution (and any display normalisation) to a type. */
  resolve(t: Type): Type;
  /** Expand a registered type alias when `t` refers to one. */
  maybeExpandAlias(t: Type): Type;
}

/** Recording inferred node types for hover/completion consumers. */
export interface NodeTypeRecorder {
  nodeTypes: Map<number, { type: Type; end: number }>;
  nodeTypesByEnd: Map<number, { type: Type; start: number }>;
  recordNodeType(node: AstNode, type: Type): void;
}

/** Unification with diagnostic reporting on failure. */
export interface UnifierContext extends DiagnosticSink {
  subst: Substitution;
  unifyWithDiagnostic(t1: Type, t2: Type, node: AstNode): void;
}

// ---------------------------------------------------------------------------
// Resolver callbacks
// ---------------------------------------------------------------------------

/**
 * Sentinel returned by an `ImportResolver` to indicate that the module
 * was located but is intentionally untyped (e.g. an `npm` package without
 * an `.hm` sidecar). Imports from such modules bind every requested name
 * to a fresh type variable and produce no diagnostics.
 */
export const UNTYPED_MODULE = { kind: 'untyped' as const };
export type UntypedModule = typeof UNTYPED_MODULE;

/** Type guard for the {@link UNTYPED_MODULE} sentinel. */
export function isUntypedModule(x: unknown): x is UntypedModule {
  return typeof x === 'object' && x !== null && (x as UntypedModule).kind === 'untyped';
}

/**
 * Marker for export maps backed by the extension's BUNDLED typings
 * (`hm-types-builtin/`).  Import names missing from such a map bind to
 * `Any` instead of producing a "not exported" diagnostic: the bundled
 * catalogue may lag behind the installed package version, and an outdated
 * builtin must never be worse than no typings at all.
 */
const OPEN_WORLD_EXPORTS = Symbol.for('hinmil.openWorldExports');

type MaybeOpenWorld = Map<string, Scheme> & { [OPEN_WORLD_EXPORTS]?: true };

/** Mark an export map as open-world (unknown names → `Any`, no diagnostic). */
export function markOpenWorldExports(m: Map<string, Scheme>): Map<string, Scheme> {
  (m as MaybeOpenWorld)[OPEN_WORLD_EXPORTS] = true;
  return m;
}

/** True when the export map was marked via {@link markOpenWorldExports}. */
export function isOpenWorldExports(m: Map<string, Scheme>): boolean {
  return (m as MaybeOpenWorld)[OPEN_WORLD_EXPORTS] === true;
}

/**
 * Callback to resolve an import specifier to its exported bindings.
 * Returns:
 *   - a map from export name to Scheme when the module is fully typed,
 *   - {@link UNTYPED_MODULE} when the module exists but should not be inferred,
 *   - `null` when the module cannot be resolved at all.
 */
export type ImportResolver = (specifier: string) => Map<string, Scheme> | UntypedModule | null;

/**
 * Callback to resolve a `// ::types <specifier>` directive to the source code
 * of the target file. Returns the source string, or null if unresolvable.
 */
export type TypeDirectiveResolver = (specifier: string) => string | null;

/**
 * Callback to resolve an import specifier to the type aliases declared in
 * its `.hm` sidecar / override.  Returned aliases are merged into the
 * importing engine's own alias map so that uppercase non-constructor type
 * names (e.g. `Selector :: (String | Prop a | QueryTag a)`) used inside an
 * imported scheme are expanded at unification sites.  `constructors`
 * carries TFun-bodied (or union-of-TFun) annotations for uppercase type
 * names — these power the "constructor as callable" bridge so that a
 * value of type `QueryTag a` can be invoked when the sidecar declares
 * `QueryTag :: a -> RTask r e [b]`.  Returns null when the module is
 * unresolved or has no aliases / constructors.
 */
export type ImportTypeAliasResolver = (specifier: string) => {
  aliases: Map<string, Type>;
  aliasVars: Map<string, string[]>;
  constructors?: Map<string, Scheme>;
  /** Instance-callable annotations (`Name() :: T`) declared in the
   *  resolved sidecar / project override.  Multiple overloads per name
   *  are preserved in declaration order. */
  instanceCallables?: Map<string, Scheme[]>;
  /** `::extend <AliasName> <typeExpr>` directives collected from the
   *  resolved sidecar(s) / project override(s).  Applied by the
   *  consuming engine after all aliases have been merged so that a
   *  user-side override can extend an alias defined in the base
   *  sidecar. */
  aliasExtensions?: ReadonlyArray<{ name: string; raw: string; start: number; end: number }>;
} | null;

// ---------------------------------------------------------------------------
// Inference result
// ---------------------------------------------------------------------------

export interface InferenceResult {
  /** Top-level inferred type (of the last expression / full program). */
  type: Type;
  /** Substitution produced. */
  substitution: Substitution;
  /** Any errors encountered during inference. */
  diagnostics: InferenceDiagnostic[];
  /** Map from AST node start offset to its inferred type and end offset. */
  nodeTypes: Map<number, { type: Type, end: number }>;
  /** Map from a top-level binding declaration's start offset to its
   *  generalized scheme. Hover displays the generic type here so a
   *  polymorphic binding (e.g. `getPath`) is not shown specialized to a
   *  downstream call site's concrete type. */
  declaredSchemes?: Map<number, Scheme>;
  /** Map from declaration name to its HM annotation. */
  annotations: Map<string, TypeAnnotation>;
  /** Map from node start offset to its HM annotation. */
  annotationsByOffset: Map<number, TypeAnnotation>;
  /** Map from node start offset to method signature string (e.g. "Box#map :: Box a ~> (a -> b) -> Box b") */
  methodSignatures: Map<number, string>;
  /** Top-level exported bindings (name -> Scheme) for cross-file usage. */
  exports: Map<string, Scheme>;
  /** Map from kind-variable id to constraint names that apply to it. */
  kvConstraints: Map<number, string[]>;
  /** Map from kind-variable id to applied/constructor-level constraint names (e.g. Monoid from Monoid (f a)). */
  kvConstructorConstraints: Map<number, string[]>;
  /** Type alias definitions: name → { type, commentStart, commentEnd }. */
  typeAliases: Map<string, { type: Type, commentStart: number, commentEnd: number }>;
  /** Map from AST node end offset to its inferred type. Used for completion after call expressions. */
  nodeTypesByEnd: Map<number, { type: Type, start: number }>;
  /** Map from an arrow/function-expression node's start offset to its inferred
   *  function type. Used by hover to pick the tightest enclosing function scope
   *  when seeding display-letter assignment (the function's own `nodeTypes`
   *  entry is suppressed in favour of its first parameter identifier). */
  functionNodeTypes: Map<number, { type: Type, end: number }>;
  /** Set of node start offsets that are curried functions (produced by curry wrappers). */
  curriedNodes: Set<number>;
  /** Maps a call's callee start offset to the index (among the annotation's
   *  TFun overload branches) of the branch that matched the actual arguments.
   *  Used by hover / signature help to surface only the selected overload. */
  callSiteOverloadIndex?: Map<number, number>;
  /** Top-level bindings from the final environment (name → Scheme), for identifier completion. */
  topLevelBindings: Map<string, Scheme>;
  /** Set of variant names that belong to a sumtype sum type (for hover). */
  dataVariantNames: Set<string>;
  /** Map from a `.constructor` property-node start offset to the parent
   *  sumtype name (e.g. `Maybe`).  Used by hover to surface the parent
   *  sumtype declaration alongside the constructor type. */
  constructorParentSumtype?: Map<number, string>;
  /** Map from a property-node start offset to a pre-computed pretty-printed
   *  type string captured at inference time, before any later unification
   *  could poison its TVars to `$error`.  Used by hover as a fallback when
   *  the substituted bestType is error-polluted. */
  frozenPropertyTypeStr?: Map<number, string>;
  /** Map from a parameter identifier's start offset to its **annotated**
   *  type, captured at binding time.  A parameter's declared type is the
   *  annotation the user wrote (`{ a }`, `{ ...a }`, `{ [k] :: a }`, …); body
   *  inference may bind the annotation's row/value vars while typing the body
   *  (e.g. `Object.keys(obj)` closing an open row to `{}`), which would poison
   *  the live-substituted hover type.  Hover prefers this frozen annotation so
   *  the parameter always displays the signature form the user wrote. */
  frozenParamType?: Map<number, Type>;
  /** Set of offsets where property access occurred on an unconstrained type variable.
   *  Used to suppress hover at these locations. */
  unconstrainedPropAccesses: Set<number>;
  /** Constructor / callable-value annotations imported from sidecars or
   *  project overrides.  Used by hover/signature help to surface the
   *  callable overloads of an uppercase TCon-typed value. */
  importedConstructors?: Map<string, Scheme>;
  /** Instance-callable schemes (`Name() :: T`) declared locally or in
   *  imported sidecars.  Used by hover / signature help to surface the
   *  callable overloads of an uppercase TCon-typed value. */
  instanceCallables?: Map<string, Scheme[]>;
  /** Set of node start offsets where an unbound-variable diagnostic was
   *  raised.  Used by hover to suppress rendering a parent expression's
   *  type under an unbound identifier name (e.g. a typo `wrong` inside a
   *  selector array would otherwise show the array's element-union). */
  unboundIdentifiers?: Set<number>;
  /** `[start, end]` source ranges of every binding the engine recognizes —
   *  top-level `VariableDeclarator`, `FunctionDeclaration`, and
   *  `ClassDeclaration` nodes.  Each entry carries an `annotated` flag
   *  indicating whether the binding has a matching `::` annotation.
   *  Consumed by `collectBindingIntervals` in the diagnostics service to
   *  power the `trustAnnotations: 'all-bodies'` setting. */
  bindingExtents?: Array<{ start: number; end: number; annotated: boolean }>;
  /** Maps every rigid skolem name (`§N`) minted while checking an annotated
   *  function body back to the annotation's display letter.  Used by hover to
   *  scrub skolems out of displayed types. */
  skolemDisplayNames?: Map<string, string>;
}
