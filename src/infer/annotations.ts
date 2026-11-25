// ============================================================================
// Annotation processing — type directives, aliases, method registration,
//                         constraint directives, validation
//
// Plain language: users describe types in comments (`// add :: Number ->
// Number`).  This file takes everything the comment parser collected and
// puts it to work: registering type aliases and method annotations,
// processing sum-type shorthand / `::constraint` / `::narrow` directives, expanding
// aliases inside annotations, and checking that the annotations themselves
// are well-formed (known type names, correct argument counts).
// ============================================================================

import {
  Type,
  TVar,
  tVar,
  tCon,
  Scheme,
  RepEntry,
  prettyTypeToString,
  collectVarNames,
  getReturnType,
  T_UNION,
  T_FUNCTION,
  isAppliedFunction,
  T_TUPLE,
} from '../hm/types';
import { Substitution } from '../hm/substitution';
import { instantiate} from '../hm/env';
import {
  TypeAnnotation,
  buildAnnotationMap,
  extractInstanceCallables,
  extractTypeDirectivesWithLocations,
  extractConstraintDirectives,
  extractGlobalDirectives,
  extractDataDirectives,
  extractRepDirectives,
  isLocalAnnotation,
  TYPE_DIRECTIVE_PART_BOUNDARY,
} from '../commentParser';
import {
  registerMethod,
  MethodEntry,
  lookupMethod as lookupRegisteredMethod,
} from '../registries/methodRegistry';
import {
  registerConstraint,
  parseConstraintDirective,
  lookupConstraint,
  getEffectiveMethods,
  validateConstraintDef,
  checkConstraintMethodShape,
  checkStaticConstraintMethodShape,
  type ConstraintDef,
} from '../registries/constraintRegistry';
import {
  registerDataType,
  isVariant,
  isDataType,
} from '../registries/dataTypeRegistry';
import type { DataTypeDecl } from '../commentParser';
import { hasSpreadInArrowChain, isSpreadTupleOrArray, mapType, eachType} from '../hm/typeUtils';
import { parseTypeSignature, parseMethodTypeSignature, TypeParseError } from '../hm/typeParser';


// ---------------------------------------------------------------------------
// Context interface for methods that need engine state
// ---------------------------------------------------------------------------

export interface AnnotationContext {
  annotationMap: Map<string, TypeAnnotation>;
  annotationByOffset: Map<number, TypeAnnotation>;
  typeAliases: Map<string, Type>;
  typeAliasVars: Map<string, string[]>;
  typeDirectiveResolver: ((specifier: string) => string | null) | null;
  curryFunctionNames: Set<string>;
  /** Instance-callable schemes loaded via `// ::types <pkg>` directives.
   *  Mirrors the engine's local `instanceCallables` map; populated by
   *  `processTypeDirectives` so that `Name() :: ...` declarations from
   *  sidecars (e.g. a query builder's `QueryTag() :: p -> RTask r e [o]`) make values
   *  of type `Name` callable in the consumer file. */
  instanceCallablesFromDirectives?: Map<string, Scheme[]>;
  /** Method annotations (`Type#m`, `Type.m`) loaded via `// ::types`, kept so
   *  setup can re-register them once the consumer's type aliases are known
   *  (see `registerDirectiveMethodsExpanded`). */
  directiveMethods?: { name: string; ann: TypeAnnotation; declaredTypeParamNames?: string[] }[];
  /** `::rep` instances declared in `::types` targets (a type-only import
   *  brings the target's constraint instances along, as a runtime import
   *  does through the module's published reps). */
  directiveRepSources?: string[];
  addDiag: (message: string, loc: { start: number; end: number }, severity?: number) => void;
}

/** Engine state needed by rigid annotation checks. */
export interface RigidCheckContext {
  subst: Substitution;
  typeAliases: Map<string, Type>;
  diagnostics: { message: string }[];
  addDiag: (msg: string, loc: { start: number; end: number }) => void;
  aliasVars?: Map<string, string[]>;
  /** Maps rigid skolem names (`§N`) minted while checking annotated bodies
   *  back to their annotation display letters.  The inferred type may still
   *  carry these skolems when it reaches a downstream rigid check; scrubbing
   *  them to ordinary display variables keeps the comparison sound (a skolem
   *  from the body would otherwise never unify with a freshly minted rigid
   *  skolem from the annotation, producing a spurious self-mismatch). */
  skolemDisplayNames?: Map<string, string>;
}

/** True for instance (`Type#method`) or static (`Type.method`) annotation names. */
export function isMethodAnnotationName(name: string | undefined): boolean {
  return !!name && (name.includes('#') || name.includes('.'));
}

/**
 * Returns the meaningful Type bodies of an annotation: the scheme type plus
 * optional receiver and methodType (filtered to defined values).  Used to
 * walk every type appearing in an annotation for arity / unknown-ctor checks.
 */
export function annotationTypeParts(ann: TypeAnnotation): Type[] {
  const parts: Type[] = [];
  if (ann.scheme) parts.push(ann.scheme.type);
  if (ann.receiver) parts.push(ann.receiver);
  if (ann.methodType) parts.push(ann.methodType);
  return parts;
}

// ---------------------------------------------------------------------------
// Method registration
// ---------------------------------------------------------------------------

/**
 * Dispatch a single annotation by name to the appropriate registration method.
 * - Names with `#` → instance method
 * - Names with `.` → static method
 */
export function registerAnnotationMethod(name: string, ann: TypeAnnotation, declaredTypeParamNames?: string[]): void {
  if (name.includes('#')) {
    const typeName = name.split('#')[0];
    // Skip registration for variant#method — sumtype requires ParentType#method
    if (isVariant(typeName)) return;
    registerInstanceMethod(name, ann, declaredTypeParamNames);
    if (ann.narrowVariant) {
      const entry = lookupRegisteredMethod(typeName, name.split('#')[1]);
      if (entry) entry.narrowAnnotation = ann;
    }
    registerOnInstanceBase(typeName, name.split('#')[1], ann);
  } else if (name.includes('.')) {
    registerStaticMethod(name, ann);
  } else if (/^[A-Z]/.test(name) && ann.scheme && !ann.receiver) {
    // A constructor annotation (`FutureT :: … -> FutureT m e a`) is also kept
    // as the hidden static `T.@@new`, so a TYPE REPRESENTATIVE `TypeRep (T …)`
    // can be called like the constructor — monad-transformer instances
    // (`FutureEither (rej => res => …)`) — also across module boundaries
    // (the method registry travels with imports).
    const ret = getReturnType(ann.scheme.type);
    if (ann.scheme.type.tag === 'TFun' && ret.tag === 'TCon' && ret.name === name) {
      registerStaticMethod(`${name}.@@new`, { ...ann, hidden: true });
    }
  }
}

export function registerInstanceMethod(name: string, ann: TypeAnnotation, declaredTypeParamNames?: string[]): void {
  const [typeName, methodName] = name.split('#');
  if (!typeName || !methodName) return;

  // Shorthand property/method annotation: `// Animal#name :: String`
  // No `~>` receiver syntax — use the scheme type directly as the property type.
  if (!ann.receiver || !ann.methodType) {
    if (!ann.scheme) return;
    const storedScheme = ann.scheme;
    // When the owning type's declared type-parameter names are known (from its
    // constructor annotation, e.g. `Pair :: (a, b) -> Pair a b` → ['a','b']),
    // a shorthand field whose type mentions those parameters (e.g.
    // `Pair#fst :: a`) must be aligned to the RECEIVER's actual type arguments
    // at access time: `pair.fst` on `Pair c d` is `c`, not a fresh disconnected
    // variable.  Without this the field type floats free and a misuse (passing
    // `pair.fst` where the first component's type is required to be something
    // else) cannot be detected.
    const declaredNames = declaredTypeParamNames;
    registerMethod(typeName, methodName, {
      signature: ann.raw,
      factory: (typeArgs: Type[]) => {
        if (!declaredNames || declaredNames.length === 0 || typeArgs.length === 0) {
          return instantiate(storedScheme);
        }
        const varNames = new Map<number, string>();
        collectVarNames(storedScheme.type, varNames);
        const nameToArg = new Map<string, Type>();
        for (let i = 0; i < declaredNames.length && i < typeArgs.length; i++) {
          if (declaredNames[i]) nameToArg.set(declaredNames[i], typeArgs[i]);
        }
        const subst = new Substitution();
        for (const id of storedScheme.vars) {
          const nm = varNames.get(id);
          if (nm && nameToArg.has(nm)) subst.set(id, nameToArg.get(nm)!);
          else subst.set(id, tVar(nm));
        }
        return subst.apply(storedScheme.type);
      },
      ...(ann.hidden ? { hidden: true } : {}),
    });
    return;
  }

  // Plan v6.3: allow TRecord receivers for `Object#method` style annotations.
  // A record receiver carries no kind-parameter, so registration uses an
  // empty receiver-var list (Object has arity 0).
  if (ann.receiver.tag !== 'TCon' && ann.receiver.tag !== 'TRecord') return;

  // Receiver type variables BY POSITION (`undefined` where the receiver
  // names a concrete argument).  They are matched positionally against the
  // value's type arguments, so a concrete argument must keep its slot: for
  // `Tuple#parts :: Tuple Number a ~> [a]` the `a` is the SECOND argument.
  // Filtering out non-variables shifted `a` onto the first argument (Number).
  const receiverVarSlots: (number | undefined)[] =
    ann.receiver.tag === 'TCon'
      ? ann.receiver.args.map((a) => (a.tag === 'TVar' ? a.id : undefined))
      : [];
  const receiverVarIds: number[] = receiverVarSlots.filter((id): id is number => id !== undefined);

  // The registered type-constructor arity is the number of receiver type
  // arguments, NOT just the substitutable `TVar` ones.  For `Object k a` the
  // key `k` is normalized to a label var (`TLabel`), so it is excluded from
  // `receiverVarIds` above — but `Object` still takes two type arguments.
  // Using `receiverVarIds.length` here would mis-register `Object` as arity 1
  // and produce a spurious "expects 1 type argument but got 2" diagnostic.
  const receiverArity =
    ann.receiver.tag === 'TCon' ? ann.receiver.args.length : receiverVarIds.length;

  const allVarIds = ann.scheme?.vars ?? [];
  const storedMethodType = ann.methodType;

  const varNames = new Map<number, string>();
  collectVarNames(ann.receiver!, varNames);
  collectVarNames(storedMethodType, varNames);

  const methodEntry: MethodEntry = {
    signature: ann.raw,
    factory: (typeArgs: Type[]) => {
      const subst = new Substitution();
      for (let i = 0; i < receiverVarSlots.length && i < typeArgs.length; i++) {
        const id = receiverVarSlots[i];
        if (id !== undefined) subst.set(id, typeArgs[i]);
      }
      const freeVarIds = allVarIds.filter((id) => !receiverVarIds.includes(id));
      for (const id of freeVarIds) {
        subst.set(id, tVar(varNames.get(id)));
      }
      return subst.apply(storedMethodType);
    },
    ...(ann.hidden ? { hidden: true } : {}),
  };

  // When the instance method carries constraints (e.g. `Runnable a r => ...`),
  // expose the scheme + receiver var names so the call site can register
  // pending constraints with the receiver vars pre-bound to the actual
  // container type arguments.
  if (ann.scheme?.constraints && ann.scheme.constraints.length > 0) {
    methodEntry.scheme = ann.scheme;
    // Positional; '' marks a concrete slot.  Left empty when the receiver has
    // no variable argument at all, so such methods keep using the factory.
    if (receiverVarIds.length > 0) {
      methodEntry.receiverVarNames = receiverVarSlots.map((id) => (id === undefined ? '' : varNames.get(id) ?? ''));
    }
  }

  // Record receiver (`{…}#method`, e.g. `Object#concat :: {a} ~> {b} -> {…}`):
  // retain the receiver shape, full method type, and scheme so member access
  // can resolve the method on *any* record form by unifying the receiver row
  // with the actual record at the call site.  (See expressions.ts TRecord
  // member-access branch + the label↔row bridge in unify.ts.)
  if (ann.receiver.tag === 'TRecord' && ann.scheme) {
    methodEntry.recordReceiver = ann.receiver;
    methodEntry.recordMethodType = storedMethodType;
    methodEntry.recordScheme = ann.scheme;
  }

  registerMethod(typeName, methodName, methodEntry, receiverArity);
}

/**
 * A method annotated on a named transformer INSTANCE
 * (`FutureEither#matchWith :: FutureT (Either l) e a ~> …`, with
 * `FutureEither :: TypeRep (FutureT (Either l) e)`) only exists on values of
 * that instance — whose type is the BASE `FutureT (Either l) e a`.  When the
 * base type has no such method, register a dispatching entry on it that
 * picks, per value, the instance whose concrete receiver arguments match
 * (`FutureT (Either l) …` vs `FutureT Maybe …`).
 */
function registerOnInstanceBase(instanceName: string, methodName: string, ann: TypeAnnotation): void {
  const receiver = ann.receiver;
  if (!receiver || receiver.tag !== 'TCon' || receiver.name === instanceName || !ann.methodType) return;
  const base = receiver.name;
  const existing = lookupRegisteredMethod(base, methodName);
  if (existing && !existing.instanceCandidates) return;  // the base defines it itself
  const candidates = existing?.instanceCandidates ?? [];
  if (candidates.some(c => c.raw === ann.raw)) return;
  candidates.push({ receiver, methodType: ann.methodType, raw: ann.raw ?? '' });
  if (existing) return;
  registerMethod(base, methodName, {
    signature: ann.raw ?? '',
    instanceCandidates: candidates,
    factory: (typeArgs: Type[]) => instanceMethodType(candidates, typeArgs),
  });
}

/** Head constructor name of a (possibly applied) type. */
function headName(t: Type): string | undefined {
  return t.tag === 'TCon' ? t.name : undefined;
}

function instanceMethodType(
  candidates: { receiver: Type & { tag: 'TCon' }; methodType: Type }[],
  typeArgs: Type[],
): Type {
  const matches = (c: { receiver: Type & { tag: 'TCon' } }) =>
    c.receiver.args.every((arg, i) => {
      const want = headName(arg);
      const got = typeArgs[i] ? headName(typeArgs[i]) : undefined;
      return want === undefined || got === undefined || want === got;
    });
  const chosen = candidates.find(matches) ?? candidates[0];
  // Bind the receiver's variables to the value's arguments (one level into
  // applied arguments: `Either l` against `Either String`), freshen the rest.
  const subst = new Substitution();
  const bound = new Set<number>();
  const bind = (id: number, t: Type) => { subst.set(id, t); bound.add(id); };
  chosen.receiver.args.forEach((arg, i) => {
    const actual = typeArgs[i];
    if (!actual) return;
    if (arg.tag === 'TVar') bind(arg.id, actual);
    else if (arg.tag === 'TCon' && actual.tag === 'TCon' && arg.name === actual.name) {
      arg.args.forEach((inner, j) => {
        if (inner.tag === 'TVar' && actual.args[j]) bind(inner.id, actual.args[j]);
      });
    }
  });
  // Freshen the method's own variables (those not bound to the receiver).
  const fresh = new Map<number, Type>();
  return mapType(chosen.methodType, t => {
    if (t.tag !== 'TVar') return undefined;
    if (bound.has(t.id)) return subst.apply(t);
    if (!fresh.has(t.id)) fresh.set(t.id, tVar(t.name));
    return fresh.get(t.id);
  });
}

export function registerStaticMethod(name: string, ann: TypeAnnotation): void {
  if (!ann.scheme) return;

  const [typeName, methodName] = name.split('.');
  if (!typeName || !methodName) return;

  const entry: MethodEntry = {
    signature: ann.raw,
    // Static methods don't depend on the container's type args — just freshen all vars
    factory: (_typeArgs: Type[]) => instantiate(ann.scheme!),
    isStatic: true,
    ...(ann.hidden ? { hidden: true } : {}),
  };
  // Store the scheme when it has constraints so the call site can use
  // instantiateWithConstraints and track constrained type variables.
  if (ann.scheme.constraints && ann.scheme.constraints.length > 0) {
    entry.scheme = ann.scheme;
  }
  registerMethod(typeName, methodName, entry);
}

// ---------------------------------------------------------------------------
// Method annotation processing
// ---------------------------------------------------------------------------

/**
 * Process all annotations from the annotation map and register method/static annotations.
 */
export function processMethodAnnotations(annotationMap: Map<string, TypeAnnotation>): void {
  // Build a map from data-type name → ordered declared type-parameter names,
  // taken from each type's constructor annotation (`Pair :: (a, b) -> Pair a b`
  // → ['a','b']).  Shorthand field annotations (`Pair#fst :: a`) use these to
  // align their type variables to a receiver's actual type arguments.
  const declaredTypeParams = buildDeclaredTypeParamMap(annotationMap);
  for (const [name, ann] of annotationMap) {
    if (ann.methodNameMismatch) continue; // skip mismatched annotations
    const typeName = name.includes('#') ? name.split('#')[0] : undefined;
    registerAnnotationMethod(name, ann, typeName ? declaredTypeParams.get(typeName) : undefined);
  }
}

/**
 * Collect, for each constructor-style annotation `T :: ... -> T p0 p1 …`, the
 * ordered names of its declared type parameters (the variable names in the
 * return type's argument positions).  Falls back to registered sum-type
 * declarations for types defined via `// data` / `T :: A | B`.
 */
export function buildDeclaredTypeParamMap(annotationMap: Map<string, TypeAnnotation>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [name, ann] of annotationMap) {
    if (!ann.scheme || isMethodAnnotationName(name)) continue;
    const ret = getReturnType(ann.scheme.type);
    if (ret.tag === 'TCon' && ret.name === name && ret.args.length > 0) {
      const names = ret.args.map((a) =>
        a.tag === 'TVar' ? a.name : (a.tag === 'TLabel' && a.kind === 'var' ? (a.name ?? '') : ''),
      );
      result.set(name, names);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// ::types directive processing
// ---------------------------------------------------------------------------

/**
 * Cache for {@link processTypeDirectives} parse work, keyed by the resolved
 * target source string.  Sidecar parsing (`buildAnnotationMap`, constraint /
 * data directive extraction, instance-callable extraction) is pure and the
 * heaviest part of `infer()`'s setup for files that load large sidecars via
 * `// ::types <pkg>`.  Caching the parse output here lets each `infer()`
 * call do only cheap registry registration, not re-parsing.  The cache key
 * is the source string itself, so any source change naturally yields a miss.
 */
interface CachedTypeDirectiveParse {
  annotations: Map<string, TypeAnnotation>;
  constraintDefs: ConstraintDef[];
  dataTypes: DataTypeDecl[];
  callablesByPart: Array<Map<string, Scheme[]>>;
}
interface CachedTypeDirectivePart {
  annotations: Map<string, TypeAnnotation>;
  constraintDefs: ConstraintDef[];
  dataTypes: DataTypeDecl[];
  callables: Map<string, Scheme[]>;
}
const TYPE_DIRECTIVE_PARSE_CACHE_MAX = 200;
const TYPE_DIRECTIVE_PART_CACHE_MAX = 400;
const __typeDirectiveParseCache = new Map<string, CachedTypeDirectiveParse>();
const __typeDirectivePartCache = new Map<string, CachedTypeDirectivePart>();

function parsePart(part: string): CachedTypeDirectivePart {
  const annotations = buildAnnotationMap(part);
  const constraintDefs: ConstraintDef[] = [];
  for (const d of extractConstraintDirectives(part)) {
    const def = parseConstraintDirective(d.text);
    if (def) {
      def.commentStart = d.start;
      def.commentEnd = d.end;
      constraintDefs.push(def);
    }
  }
  const dataTypes = extractDataDirectives(part);
  const callables = extractInstanceCallables(part);
  return { annotations, constraintDefs, dataTypes, callables };
}

function getCachedPart(part: string): CachedTypeDirectivePart {
  const hit = __typeDirectivePartCache.get(part);
  if (hit) {
    __typeDirectivePartCache.delete(part);
    __typeDirectivePartCache.set(part, hit);
    return hit;
  }
  const entry = parsePart(part);
  __typeDirectivePartCache.set(part, entry);
  if (__typeDirectivePartCache.size > TYPE_DIRECTIVE_PART_CACHE_MAX) {
    const oldest = __typeDirectivePartCache.keys().next().value;
    if (oldest !== undefined) __typeDirectivePartCache.delete(oldest);
  }
  return entry;
}

function getCachedTypeDirectiveParse(targetSource: string): CachedTypeDirectiveParse {
  const hit = __typeDirectiveParseCache.get(targetSource);
  if (hit) {
    // LRU touch: re-insert at tail
    __typeDirectiveParseCache.delete(targetSource);
    __typeDirectiveParseCache.set(targetSource, hit);
    return hit;
  }

  // Per-part caching: split the resolver's concatenated source on the
  // boundary marker and parse each part separately so that editing a
  // single sidecar file does not invalidate the parses of other parts
  // (e.g. a 3 KB project-override edit shouldn't force re-parsing of a
  // 370 KB generated client sidecar).
  const parts = targetSource.split(TYPE_DIRECTIVE_PART_BOUNDARY);
  const partResults = parts.map(getCachedPart);

  // Merge parts.  Mirrors `buildAnnotationMap` overload semantics:
  // walk all parts in declared order, for non-method names with multiple
  // entries we merge via `mergeOverloadSchemes`; method names (`Type#m`,
  // `Type.m`) take the first occurrence.
  const { mergeOverloadSchemes } = require('../hm/env') as typeof import('../hm/env');
  const annotations = new Map<string, TypeAnnotation>();
  for (const pr of partResults) {
    for (const [name, ann] of pr.annotations) {
      const existing = annotations.get(name);
      if (existing && existing.scheme && ann.scheme
          && !name.includes('#') && !name.includes('.')) {
        const merged = mergeOverloadSchemes(existing.scheme, ann.scheme);
        annotations.set(name, { ...existing, scheme: merged, origin: 'local' });
      } else if (!existing) {
        annotations.set(name, ann);
      }
    }
  }
  const constraintDefs: ConstraintDef[] = [];
  const dataTypes: DataTypeDecl[] = [];
  const callablesByPart: Array<Map<string, Scheme[]>> = [];
  for (const pr of partResults) {
    for (const c of pr.constraintDefs) constraintDefs.push(c);
    for (const d of pr.dataTypes) dataTypes.push(d);
    callablesByPart.push(pr.callables);
  }
  const entry: CachedTypeDirectiveParse = { annotations, constraintDefs, dataTypes, callablesByPart };
  __typeDirectiveParseCache.set(targetSource, entry);
  if (__typeDirectiveParseCache.size > TYPE_DIRECTIVE_PARSE_CACHE_MAX) {
    const oldest = __typeDirectiveParseCache.keys().next().value;
    if (oldest !== undefined) __typeDirectiveParseCache.delete(oldest);
  }
  return entry;
}

/**
 * Process `// ::types <specifier>` directives from source.
 * Loads each target file's source, extracts its annotations, and registers
 * any method/static annotations found there.
 */
export function processTypeDirectives(ctx: AnnotationContext, source: string): void {
  if (!ctx.typeDirectiveResolver) return;

  const directives = extractTypeDirectivesWithLocations(source);
  const processed = new Set<string>();

  for (const directive of directives) {
    const specifier = directive.specifier;
    if (processed.has(specifier)) continue;
    processed.add(specifier);

    const targetSource = ctx.typeDirectiveResolver(specifier);
    if (!targetSource) {
      ctx.addDiag(
        `Cannot resolve ::types path '${specifier}': file not found`,
        { start: directive.start, end: directive.end },
      );
      continue;
    }

    // Reuse parsed sidecar data across infer() calls when the resolved
    // source string is unchanged.  Parsing dominates setup for files that
    // load large `::types` sidecars (e.g. query-builder).  Registration calls
    // below are cheap (writes into registries that are cleared per infer).
    const cached = getCachedTypeDirectiveParse(targetSource);
    if (ctx.directiveRepSources && targetSource.includes('::rep')) ctx.directiveRepSources.push(targetSource);

    // Register any method annotations from the target
    const declaredTypeParams = buildDeclaredTypeParamMap(cached.annotations);
    for (const [name, ann] of cached.annotations) {
      const typeName = name.includes('#') ? name.split('#')[0] : undefined;
      registerAnnotationMethod(name, ann, typeName ? declaredTypeParams.get(typeName) : undefined);
      if (isMethodAnnotationName(name) && ctx.directiveMethods) {
        ctx.directiveMethods.push({ name, ann, declaredTypeParamNames: typeName ? declaredTypeParams.get(typeName) : undefined });
      }
      // Also collect type aliases AND value-level annotations into the
      // local annotationMap so they apply to consuming code.  Capital
      // names define type aliases; lowercase names define value
      // annotations (e.g. `tables :: { ... }` from a generated sidecar).
      // Method annotations with narrowVariant must also be added so
      // that ::narrow on member expressions works across ::types boundaries.
      if (!isMethodAnnotationName(name)) {
        if (!ctx.annotationMap.has(name)) {
          // Tag the merged entry so downstream consumers that must be
          // file-local-only can skip directive entries via
          // `isLocalAnnotation` (e.g. export-scheme construction).
          ctx.annotationMap.set(name, { ...ann, origin: 'directive' });
        }
      } else if (ann.narrowVariant && !ctx.annotationMap.has(name)) {
        ctx.annotationMap.set(name, { ...ann, origin: 'directive' });
      }
    }

    // Also process ::constraint directives from the target file
    for (const def of cached.constraintDefs) {
      registerConstraint(def);
    }

    // Also process sumtype directives from the target file
    for (const decl of cached.dataTypes) {
      registerDataType(decl);
    }

    // Surface instance-callable annotations (`Name() :: ...`) so values
    // typed as `Name` become callable in the consumer file.  Without
    // this an annotation like `// one :: QueryTag p a -> ...` followed by
    // `t(p)` would fail with "Type 'QueryTag p a' is not callable" even
    // though the loaded sidecar declares `QueryTag() :: p -> RTask r e [o]`.
    //
    // Override semantics: when the resolver merges multiple parts (e.g.
    // a base sidecar followed by a project-level `hinmil.overrides.<pkg>`
    // file) it joins them with `TYPE_DIRECTIVE_PART_BOUNDARY`.  We split
    // on that here and process parts in order; later parts that declare
    // `Name() :: ...` REPLACE the entries from earlier parts for that
    // same `Name`.  Within a single part, multiple declarations stay as
    // overloads.
    if (ctx.instanceCallablesFromDirectives) {
      for (const partCallables of cached.callablesByPart) {
        for (const [name, schemes] of partCallables) {
          // Override semantics: any declarations of `name` in a later
          // part replace those from earlier parts (or earlier directives
          // with the same name).
          ctx.instanceCallablesFromDirectives.set(name, [...schemes]);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Type alias processing
// ---------------------------------------------------------------------------

/**
 * Build type alias map from standalone type annotations.
 * A type alias is an annotation where:
 *   - The name starts with an uppercase letter
 *   - It's not a method annotation (no # or . in name)
 *   - The type is NOT a function returning a TCon with the same name (i.e. not a constructor)
 *
 * Example: `// Person :: { name: String, age: Number }` defines Person as a type alias.
 * Counter-example: `// Box :: a -> Box a` defines Box as a constructor, not an alias.
 */
export function buildTypeAliases(annotationMap: Map<string, TypeAnnotation>): Map<string, Type> {
  const typeAliases = new Map<string, Type>();

  for (const [name, ann] of annotationMap) {
    if (!ann.scheme) continue;
    if (isMethodAnnotationName(name)) continue;
    if (!/^[A-Z]/.test(name)) continue;

    // Check if this is a constructor pattern: a function returning TCon with the same name
    const returnType = getReturnType(ann.scheme.type);
    if (returnType.tag === 'TCon' && returnType.name === name) continue;

    // Skip sumtype variant names — they are constructors, not aliases
    // (e.g. Just :: a -> Maybe a is NOT an alias for Maybe)
    if (isVariant(name)) continue;

    // Skip sumtype type names — they are sum types, not aliases
    if (isDataType(name)) continue;

    // Skip overloaded value/factory annotations.  When the same uppercase
    // name is declared both as a bare value (`Tag :: a`) and as a callable
    // (`Tag :: a -> Wrapped a`), the merged scheme is a Union containing
    // at least one TFun branch.  Treating that as a type alias would
    // expand `Tag a` at use sites into the Union body, defeating the
    // constructor-as-callable bridge that lets `t()` resolve to the
    // callable overload.  Pure TFun aliases (e.g. `Predicate :: a -> Boolean`)
    // are still treated as aliases.
    const t = ann.scheme.type;
    if (t.tag === 'TCon' && t.name === T_UNION
        && t.args.some(a => a.tag === 'TFun')) continue;

    // This is a type alias
    typeAliases.set(name, ann.scheme.type);
  }

  return typeAliases;
}

/** Build the type alias result map with location info for the public API. */
export function buildTypeAliasResult(
  typeAliases: Map<string, Type>,
  annotationMap: Map<string, TypeAnnotation>,
): Map<string, { type: Type, commentStart: number, commentEnd: number }> {
  const result = new Map<string, { type: Type, commentStart: number, commentEnd: number }>();
  for (const [name, type] of typeAliases) {
    const ann = annotationMap.get(name);
    if (ann) {
      result.set(name, { type, commentStart: ann.commentStart, commentEnd: ann.commentEnd });
    }
  }
  return result;
}

/**
 * Build a map from alias name to its type variable names (in order).
 * Used for polymorphic alias expansion: `TypedArray Int String` with
 * `TypedArray :: (Array a | Array b)` substitutes a→Int, b→String.
 */
export function buildTypeAliasVars(
  annotationMap: Map<string, TypeAnnotation>,
  typeAliases: Map<string, Type>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const name of typeAliases.keys()) {
    const ann = annotationMap.get(name);
    if (ann?.scheme) {
      const vars = collectFreeVarNames(ann.scheme.type);
      result.set(name, vars);
    } else {
      result.set(name, []);
    }
  }
  return result;
}

/** Collect free TVar names from a type in depth-first order, deduplicated. */
export function collectFreeVarNames(t: Type): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  eachType(t, n => {
    if (n.tag === 'TVar' && !seen.has(n.name)) { seen.add(n.name); result.push(n.name); }
  });
  return result;
}

// ---------------------------------------------------------------------------
// `::extend <AliasName> <typeExpr>` directive processing
// ---------------------------------------------------------------------------

/** A parsed extension to be merged into a type alias by `applyAliasExtensions`. */
export interface AliasExtension {
  /** Target alias name (e.g. `UserSelector`). */
  name: string;
  /** Raw RHS of the directive, fed into `parseTypeSignature`. */
  raw: string;
  /** Source offset of the directive comment (for diagnostics). */
  start: number;
  /** Source end offset of the directive comment (for diagnostics). */
  end: number;
}

/**
 * Apply `::extend <Name> <typeExpr>` directives to a type-alias map.
 *
 * Semantics:
 *   - If `Name` already maps to a `Union` alias, the extension's branches
 *     are appended (flattening when `typeExpr` itself is a union).
 *   - If `Name` already maps to a non-union alias, it is wrapped into a
 *     `Union` containing the existing body plus the extension branches.
 *   - If `Name` is not yet an alias, a new alias is created (single
 *     extension → that type; multiple → union of all).
 *
 * Multiple extensions for the same name stack: each call appends.
 * Free type variables introduced by extensions are merged into
 * `aliasVars` so polymorphic expansion stays consistent.
 *
 * Errors during parsing are reported via `addDiag` (if provided) and the
 * offending extension is skipped.
 */
export function applyAliasExtensions(
  typeAliases: Map<string, Type>,
  extensions: ReadonlyArray<AliasExtension>,
  aliasVars?: Map<string, string[]>,
  addDiag?: (message: string, loc: { start: number; end: number }) => void,
): void {
  if (extensions.length === 0) return;
  const flattenUnion = (t: Type): Type[] => {
    if (t.tag === 'TCon' && t.name === T_UNION) {
      const out: Type[] = [];
      for (const a of t.args) out.push(...flattenUnion(a));
      return out;
    }
    return [t];
  };
  // Structural key for a single branch: pretty-prints with stable, renamed
  // type-variable letters so branches that only differ in fresh TVar ids
  // (e.g. `QueryTag a (Picked X b)` parsed twice into different `a`/`b`)
  // still collapse to one entry.  Used both within a single extension's
  // branch list and to dedupe against the alias's already-present body.
  const branchKey = (t: Type): string => prettyTypeToString(t);
  // Idempotency guard: per call, never apply the same (aliasName, raw)
  // directive twice.  Defends against duplicate `::extend` entries that
  // the resolver may stack from multiple sidecar paths.
  const appliedKeys = new Set<string>();
  for (const ext of extensions) {
    const directiveKey = `${ext.name}\u0000${ext.raw}`;
    if (appliedKeys.has(directiveKey)) continue;
    appliedKeys.add(directiveKey);
    let parsed: Type;
    try {
      parsed = parseTypeSignature(ext.raw).type;
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      if (addDiag) addDiag(`Invalid ::extend ${ext.name}: ${msg}`, { start: ext.start, end: ext.end });
      continue;
    }
    const existing = typeAliases.get(ext.name);
    const extBranchesRaw = flattenUnion(parsed);
    // Dedupe ext branches against each other and against the alias's
    // existing branches under structural equality.  Treats `::extend`
    // as set-union over branches — important because callers may emit
    // the same branch from multiple directives (or the introspect
    // generator may emit the same relation pair on multiple selectors).
    const seenKeys = new Set<string>();
    const existingBranches: Type[] = existing ? flattenUnion(existing) : [];
    for (const b of existingBranches) seenKeys.add(branchKey(b));
    const newBranches: Type[] = [];
    for (const b of extBranchesRaw) {
      const k = branchKey(b);
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      newBranches.push(b);
    }
    if (newBranches.length === 0) {
      // Nothing new — keep the alias as-is, but still merge alias vars
      // below in case this extension introduced a new free variable name
      // we hadn't recorded yet.
    } else {
      const allBranches = [...existingBranches, ...newBranches];
      const merged: Type = (!existing && allBranches.length === 1)
        ? allBranches[0]
        : tCon(T_UNION, allBranches);
      typeAliases.set(ext.name, merged);
    }
    if (aliasVars) {
      const before = aliasVars.get(ext.name) ?? [];
      const set = new Set(before);
      const merged2 = [...before];
      for (const v of collectFreeVarNames(parsed)) {
        if (!set.has(v)) { set.add(v); merged2.push(v); }
      }
      aliasVars.set(ext.name, merged2);
    }
  }
}

/** Substitute TVar nodes by name. Used for polymorphic alias expansion. */
function substituteVarsByName(t: Type, mapping: Map<string, Type>): Type {
  return mapType(t, n => n.tag === 'TVar' ? (mapping.get(n.name) ?? n) : undefined);
}

// ---------------------------------------------------------------------------
// Alias expansion
// ---------------------------------------------------------------------------

/**
 * Per-pass memo for `expandAliases`.  Keyed by alias name (with a
 * `\u0000bare` suffix for the bare-with-vars case).  Cached value is
 * the *pre-freshening* expanded body — per-use-site TVar freshening
 * still runs on every call so list elements stay polymorphically
 * independent.
 *
 * Only populated when the alias is reached as the outermost expansion
 * of that name (i.e. `expanding.size === 0` at entry); see comment in
 * `expandAliases` for why nested cache entries would be unsafe.
 */
export type AliasExpansionMemo = Map<string, Type>;

/**
 * Recursively expand type aliases in a type.
 * - Non-polymorphic: `TCon(aliasName, [])` → aliased type
 * - Polymorphic: `TCon(aliasName, [arg1, arg2])` → aliased type with vars substituted
 * Tracks expanding aliases to prevent infinite recursion on recursive types.
 *
 * Optional `memo`: when provided, the recursive expansion result of bare
 * (no-args) alias TCons is cached and reused across calls that share
 * the same memo.  The cache lifetime is the caller's responsibility —
 * typically scoped to one annotation-expansion pass.
 */
export function expandAliases(
  typeAliases: Map<string, Type>,
  t: Type,
  expanding = new Set<string>(),
  aliasVars?: Map<string, string[]>,
  memo?: AliasExpansionMemo,
  outerVars?: Map<string, TVar>,
): Type {
  return mapType(t, n => {
    if (n.tag !== 'TCon' || !typeAliases.has(n.name)) return undefined;
    if (expanding.has(n.name)) return n; // break the cycle
    const aliasedType = typeAliases.get(n.name)!;
    const vars = aliasVars?.get(n.name) ?? [];
    // Cacheable only when this is the outermost expansion of `n.name`
    // (nested expansions may capture raw TCons of names still in
    // `expanding`, which would be invalid to reuse elsewhere) and the
    // alias is used without concrete args (args bake into the body,
    // so a single name-keyed cache would over-share).  The bare-with-
    // vars branch caches under a separate `\u0000bare` key and
    // substitutes the declared vars to fresh TVars per call.
    const cacheable = !!memo && expanding.size === 0 && n.args.length === 0;

    if (n.args.length === 0 && vars.length === 0) {
      let aliased = cacheable ? memo!.get(n.name) : undefined;
      if (!aliased) {
        expanding.add(n.name);
        aliased = expandAliases(typeAliases, aliasedType, expanding, aliasVars, memo, outerVars);
        expanding.delete(n.name);
        if (cacheable) memo!.set(n.name, aliased);
      }
      // Implicit-polymorphism: if the alias body contains free type
      // variables that aren't declared parameters (e.g.
      // `OrganisationSelector :: (... | Prop a | QueryTag a | SQLTag a)`),
      // freshen them per use site so each occurrence gets its own
      // independent `a`.  Without this, multiple list elements that
      // expect the same `Selector` alias would share `a` — and the first
      // element pinning `a := String` would silently corrupt the
      // expected type for all later elements (e.g. `Location(...)`
      // returning `QueryTag LocationRow` would no longer match the now-
      // pinned `QueryTag String`).
      const idToName = new Map<number, string>();
      collectVarNames(aliased, idToName);
      if (idToName.size > 0) {
        const idMapping = new Map<number, Type>();
        // Capture-by-name: a free var whose name also appears in the
        // enclosing annotation refers to that same outer var (so e.g.
        // `Rej :: e -> ()` inside `Future :: (Rej -> ...) -> Future e a`
        // correlates its `e` with the return `e`).  All other free vars
        // freshen per use site as before.
        for (const [id, nm] of idToName) idMapping.set(id, outerVars?.get(nm) ?? tVar());
        const fresh = mapType(aliased, sub => {
          if (sub.tag === 'TVar' && idMapping.has(sub.id)) return idMapping.get(sub.id)!;
          return undefined;
        });
        return fresh.tag === 'TRecord' ? { ...fresh, alias: n.name } : fresh;
      }
      return aliased.tag === 'TRecord' ? { ...aliased, alias: n.name } : aliased;
    }

    if (n.args.length > 0 && n.args.length <= vars.length) {
      // Partial application is allowed: provided args bind the leading
      // alias parameters; any remaining parameters are freshened so each
      // use site gets independent existentials.  This matches how
      // generators like a query builder's introspect sidecar produce
      // `UserSelector :: GenericSelector UserTag` against an alias
      // `GenericSelector :: (Prop tag a | Limit l | Offset o | SQLTag p o)`
      // — the caller only pins `tag`, leaving the per-branch vars free.
      expanding.add(n.name);
      const mapping = new Map<string, Type>();
      for (let i = 0; i < n.args.length; i++) mapping.set(vars[i], n.args[i]);
      for (let i = n.args.length; i < vars.length; i++) mapping.set(vars[i], tVar());
      const substituted = substituteVarsByName(aliasedType, mapping);
      const result = expandAliases(typeAliases, substituted, expanding, aliasVars, memo, outerVars);
      expanding.delete(n.name);
      return result.tag === 'TRecord' ? { ...result, alias: n.name } : result;
    }

    // Bare alias use without type args (e.g. `[Selector]` where the alias
    // is `Selector :: (String | Prop a | QueryTag a | ...)`).  Treat the
    // alias's free variables as universal/existential at this use site by
    // freshening them — every occurrence of `Selector` gets its own
    // independent `a`.  Without this, the unexpanded TCon would surface
    // at unification and fail with a confusing "Cannot unify X with
    // Selector" message even when X is one of the union's branches.
    if (n.args.length === 0 && vars.length > 0) {
      // Cache the *pre-substitution* expansion of the alias body under
      // a `\u0000bare` key, then substitute the declared vars to fresh
      // TVars per call.  Behaviour-equivalent to the original "subst
      // then expand" because `expandAliases` does not transform TVar
      // nodes — they pass through `mapType` unchanged — so the relative
      // order of named-var substitution and alias expansion does not
      // matter.
      const cacheKey = n.name + '\u0000bare';
      let expandedBody = cacheable ? memo!.get(cacheKey) : undefined;
      if (!expandedBody) {
        expanding.add(n.name);
        expandedBody = expandAliases(typeAliases, aliasedType, expanding, aliasVars, memo, outerVars);
        expanding.delete(n.name);
        if (cacheable) memo!.set(cacheKey, expandedBody);
      }
      const mapping = new Map<string, Type>();
      // Capture-by-name (see no-vars branch): a free var whose name also
      // appears in the enclosing annotation is bound to that same outer
      // var so it correlates across the alias boundary; others freshen.
      for (const v of vars) mapping.set(v, outerVars?.get(v) ?? tVar());
      const result = substituteVarsByName(expandedBody, mapping);
      // Preserve alias name on a top-level record result so that nominal
      // record unification can distinguish e.g. `OrganisationRow` from
      // `CaregiverTodoRow` even when their fields overlap.  These rows
      // pick up a phantom var because the row body contains a free TVar
      // (e.g. `oldId :: a`), routing them through this branch instead of
      // the no-vars branch above which already preserves the alias.
      return result.tag === 'TRecord' ? { ...result, alias: n.name } : result;
    }

    // Arity mismatch — leave as-is for arity checker; let mapType recurse children
    return undefined;
  });
}

/**
 * Expand type aliases in a single annotation's scheme type, receiver, and methodType.
 *
 * Returns a NEW annotation object — never mutates `ann` in place.  The
 * input may come from a cached `extractAnnotations` result that is
 * shared across multiple inference passes; mutating it would compound
 * alias expansion on every subsequent pass and exponentially deepen any
 * recursive alias body (e.g. `Person :: { ..., friends :: [Person] }`).
 */
export function expandAnnotationAliases(typeAliases: Map<string, Type>, ann: TypeAnnotation, aliasVars?: Map<string, string[]>, memo?: AliasExpansionMemo): TypeAnnotation {
  if (!ann.scheme) return ann;
  const out: TypeAnnotation = { ...ann };
  // Collect the annotation's own free type vars (aliases are still TCons
  // here, so these are exactly the vars written *outside* any alias).  A
  // free var inside an expanded alias whose name matches one of these is
  // captured to the same outer var, correlating e.g. the `e` in
  // `Rej :: e -> ()` with the return `e` of `... -> Future e a`.
  const outerVars = new Map<string, TVar>();
  const collectOuter = (ty?: Type) => {
    if (!ty) return;
    eachType(ty, n => {
      if (n.tag === 'TVar' && !outerVars.has(n.name)) outerVars.set(n.name, n);
    });
  };
  collectOuter(ann.scheme.type);
  collectOuter(ann.receiver);
  collectOuter(ann.methodType);
  out.scheme = {
    ...ann.scheme,
    type: expandAliases(typeAliases, ann.scheme.type, undefined, aliasVars, memo, outerVars),
  };
  if (ann.receiver) {
    out.receiver = expandAliases(typeAliases, ann.receiver, undefined, aliasVars, memo, outerVars);
  }
  if (ann.methodType) {
    out.methodType = expandAliases(typeAliases, ann.methodType, undefined, aliasVars, memo, outerVars);
  }
  return out;
}

/**
 * Re-register the method annotations loaded via `// ::types` with the
 * consumer's type aliases expanded.  They are first registered raw while the
 * directive is processed (aliases are not known yet), so an alias used only
 * inside an imported method signature — FP-library `Component#matchWith ::
 * { Engine :: String -> EngineFn -> a, … }` — stayed an opaque `EngineFn`
 * and failed to unify with the function it names.  Local methods are
 * registered afterwards and still take precedence.
 */
export function registerDirectiveMethodsExpanded(ctx: AnnotationContext): void {
  if (!ctx.directiveMethods || ctx.directiveMethods.length === 0 || ctx.typeAliases.size === 0) return;
  const memo: AliasExpansionMemo = new Map();
  const aliases = ctx.typeAliases;
  const mentionsAlias = (t?: Type): boolean => {
    let found = false;
    if (t) eachType(t, (n) => { if (!found && n.tag === 'TCon' && aliases.has(n.name)) found = true; });
    return found;
  };
  for (const { name, ann, declaredTypeParamNames } of ctx.directiveMethods) {
    // Only methods that actually name an alias need re-registering (query-builder's
    // sidecar loads hundreds of methods per file).
    if (!mentionsAlias(ann.scheme?.type) && !mentionsAlias(ann.receiver) && !mentionsAlias(ann.methodType)) continue;
    registerAnnotationMethod(name, expandAnnotationAliases(aliases, ann, ctx.typeAliasVars, memo), declaredTypeParamNames);
  }
}

/**
 * Expand type aliases in all parsed annotation types.
 */
export function expandAllAnnotationAliases(ctx: AnnotationContext): void {
  if (ctx.typeAliases.size === 0) return;

  // One memo per pass — every annotation that mentions the same heavy
  // alias (e.g. `LocationSelector` referenced by N relation functions)
  // reuses the same pre-freshening expansion body.  Per-use-site TVar
  // freshening still happens inside `expandAliases`, so polymorphic
  // independence between call sites is preserved.
  const memo: AliasExpansionMemo = new Map();

  // Build a map from old ann reference -> new ann so that
  // annotationByOffset (which may reference the same ann objects as
  // annotationMap) gets the same expanded copy.
  const replaced = new Map<TypeAnnotation, TypeAnnotation>();
  for (const [name, ann] of ctx.annotationMap) {
    const next = expandAnnotationAliases(ctx.typeAliases, ann, ctx.typeAliasVars, memo);
    if (next !== ann) {
      ctx.annotationMap.set(name, next);
      replaced.set(ann, next);
    }
  }

  for (const [offset, ann] of ctx.annotationByOffset) {
    const cached = replaced.get(ann);
    if (cached) {
      ctx.annotationByOffset.set(offset, cached);
      continue;
    }
    const next = expandAnnotationAliases(ctx.typeAliases, ann, ctx.typeAliasVars, memo);
    if (next !== ann) {
      ctx.annotationByOffset.set(offset, next);
      replaced.set(ann, next);
    }
  }
}

// ---------------------------------------------------------------------------
// ::constraint directive processing
// ---------------------------------------------------------------------------

/**
 * Process `// ::constraint Name v { method :: sig, ... }` directives.
 *
 * `sourceUri` is the URI of the file the directives originated from; it
 * is attached to each registered `ConstraintDef` (along with the
 * directive's source offsets) so hover and go-to-definition can navigate
 * users back to the definition.
 */
export function processConstraintDirectives(
  source: string,
  addDiag: (message: string, loc: { start: number; end: number }) => void,
  sourceUri?: string,
): void {
  const directives = extractConstraintDirectives(source);

  for (const directive of directives) {
    const def = parseConstraintDirective(directive.text);
    if (def) {
      // Validate kind consistency and completeness before registering
      const warnings = validateConstraintDef(def);
      for (const msg of warnings) {
        addDiag(msg, directive);
      }
      def.uri = sourceUri;
      def.commentStart = directive.start;
      def.commentEnd = directive.end;
      registerConstraint(def);
    } else {
      addDiag(`Invalid ::constraint directive`, directive);
    }
  }
}

// ---------------------------------------------------------------------------
// ::rep directive processing
// ---------------------------------------------------------------------------

/**
 * Process `// ::rep Constraint Type#method` directives.
 *
 * A `::rep` directive declares that the local instance-method annotation
 * `Type#method :: ...` is sufficient to satisfy the named constraint's
 * requirement for `method`, even though that method is not registered as a
 * normal (autocomplete-visible) method on the type.  This lets a type such as
 * `Array` satisfy a constraint like `Foldable` (which requires `reduce`)
 * without making `reduce` appear in array-literal autocomplete and without
 * registering it globally.
 *
 * The returned `RepEntry[]` is scheme-scoped: it is only attached to schemes
 * whose constraints reference the named constraint, so the representation is
 * call-scoped (active only when the annotated function carrying the constraint
 * is used) rather than global.
 *
 * Validation:
 *  - The local `Type#method :: ...` annotation must exist in this file.
 *  - The constraint must be defined and must declare `method`.
 *  - The local annotation's shape must match the constraint's method shape
 *    (e.g. a tuple-form constraint requirement requires a tuple-form local
 *    annotation; a curried form does not match a tuple form).
 * Malformed/invalid directives produce a diagnostic and are skipped.
 */
export function processRepDirectives(
  source: string,
  annotationMap: Map<string, TypeAnnotation>,
  addDiag: (message: string, loc: { start: number; end: number }) => void,
): RepEntry[] {
  const directives = extractRepDirectives(source);
  const reps: RepEntry[] = [];

  for (const d of directives) {
    const loc = { start: d.start, end: d.end };
    const memberKey = d.isStatic
      ? `${d.typeName}.${d.methodName}`
      : `${d.typeName}#${d.methodName}`;

    const def = lookupConstraint(d.constraint);
    if (!def) {
      addDiag(`::rep references unknown constraint '${d.constraint}'`, loc);
      continue;
    }

    const methods = getEffectiveMethods(d.constraint);
    const req = methods.find((m) => m.name === d.methodName);
    if (!req) {
      addDiag(
        `::rep ${d.constraint} ${memberKey}: constraint '${d.constraint}' has no method '${d.methodName}'`,
        loc,
      );
      continue;
    }

    // The separator must agree with the constraint method's kind: instance
    // methods (carrying a `~>` receiver) are repped with `Type#method`, static
    // methods (no receiver, e.g. `off :: a -> f a`) with `Type.method`.
    const reqIsStatic = !req.signature.includes('~>');
    if (d.isStatic && !reqIsStatic) {
      addDiag(
        `::rep ${d.constraint} ${memberKey}: '${d.methodName}' is an instance method — use '${d.typeName}#${d.methodName}'`,
        loc,
      );
      continue;
    }
    if (!d.isStatic && reqIsStatic) {
      addDiag(
        `::rep ${d.constraint} ${memberKey}: '${d.methodName}' is a static method — use '${d.typeName}.${d.methodName}'`,
        loc,
      );
      continue;
    }

    // Sequence-based binding (Fase B2): a `::rep` directive binds to the
    // *next* local annotation in the file that represents the method —
    // regardless of the annotation's map key.  For an instance rep we pick
    // the next annotation whose `~>` receiver is the named type (so the
    // signature may live in a member-form `// Array#reduce :: Array a ~> ...`
    // or a binding-form `// builtIn.Array :: Array a ~> ...`).  For a static
    // rep there is no receiver, so we bind the next receiver-less annotation
    // whose name is the method (`off :: a -> Array a`) or the dotted static
    // form (`Array.off :: a -> Array a`).
    const dottedName = `${d.typeName}.${d.methodName}`;
    let chosen: TypeAnnotation | undefined;
    for (const ann of annotationMap.values()) {
      if (!isLocalAnnotation(ann) || !ann.raw || ann.error) continue;
      if (ann.commentStart < d.end) continue;
      if (d.isStatic) {
        if (ann.receiver) continue;
        // Accept three receiver-less forms: the bare method name
        // (`empty :: () -> Array a`), the dotted static form
        // (`Array.empty :: () -> Array a`), or the binding form whose member
        // name is the repped type (`builtIn.Array :: () -> Array a`, parsed
        // with `ann.name === 'builtIn.Array'`).  The binding form mirrors how
        // instance reps use `builtIn.Array :: Array a ~> ...`; its trailing
        // segment after the last `.` is the type name.
        const annLast = (ann.name ?? '').includes('.')
          ? (ann.name ?? '').slice((ann.name ?? '').lastIndexOf('.') + 1)
          : (ann.name ?? '');
        if (
          ann.name !== d.methodName &&
          ann.name !== dottedName &&
          annLast !== d.typeName
        )
          continue;
      } else {
        if (!ann.receiver) continue;
        // The receiver names the type being repped.  Normally it's a
        // constructor (`Array a ~> ...` → TCon 'Array'), but record-shaped
        // builtins like `Object` are written with a record/row receiver
        // (`{ [k] :: a } ~> ...` or `{ a } ~> ...`).  Accept a TRecord
        // receiver when the repped type is the record carrier `Object`.
        const recvMatchesCon =
          ann.receiver.tag === 'TCon' && ann.receiver.name === d.typeName;
        const recvMatchesRecord =
          ann.receiver.tag === 'TRecord' && d.typeName === 'Object';
        // A function-type receiver `(* -> a) ~> ...` (TFun, or the applied
        // `Function [..] a` TCon form) is the literal-syntax equivalent of the
        // named `Function` type — accept it for `::rep ... Function#method`,
        // mirroring how `[a]` is the literal equivalent of `Array a`.
        const recvMatchesFun =
          d.typeName === T_FUNCTION &&
          (ann.receiver.tag === 'TFun' || isAppliedFunction(ann.receiver));
        if (!recvMatchesCon && !recvMatchesRecord && !recvMatchesFun) continue;
      }
      if (!chosen || ann.commentStart < chosen.commentStart) chosen = ann;
    }
    if (!chosen) {
      addDiag(
        d.isStatic
          ? `::rep ${d.constraint} ${memberKey}: no following '${d.methodName} :: ...' (or '${dottedName} :: ...') signature found in this file`
          : `::rep ${d.constraint} ${memberKey}: no following '${d.typeName} ... ~> ...' signature found in this file`,
        loc,
      );
      continue;
    }

    const mismatch = d.isStatic
      ? checkStaticConstraintMethodShape(def.typeVar, req.signature, d.typeName, chosen.raw)
      : checkConstraintMethodShape(
          def.typeVar,
          req.signature,
          d.typeName,
          { signature: chosen.raw } as MethodEntry,
        );
    if (mismatch) {
      // Surface the constraint's own requirement definition (verbatim, with
      // its abstract type variable intact) rather than substituting the
      // concrete type name.  Substituting would produce nonsensical shapes
      // for record-carrier builtins (e.g. `Object a` — `Object` takes no
      // type argument), so we show the requirement exactly as declared in
      // the `::constraint` definition.
      addDiag(
        `::rep ${d.constraint} ${memberKey}: local annotation '${chosen.raw}' does not match the '${d.constraint}' requirement for '${d.methodName}' (required: '${d.methodName} :: ${req.signature}')`,
        loc,
      );
      continue;
    }

    reps.push({
      constraint: d.constraint,
      typeName: d.typeName,
      methodName: d.methodName,
      signature: chosen.raw,
      isStatic: d.isStatic,
    });
  }

  return reps;
}


// ---------------------------------------------------------------------------
// ::global directive processing
// ---------------------------------------------------------------------------

/** Regex to parse `::global Name#method :: sig`. */
const GLOBAL_PATTERN = /^::global\s+([\w]+[#.][\w]+)\s*::\s*(.+)$/;

/**
 * Process `// ::global Type#method :: sig` and `// ::global Type.method :: sig` directives.
 *
 * These register user-defined methods on built-in or custom types, allowing
 * users to declare prototype extensions (e.g. `Array.prototype.ap = ...`)
 * for the type checker without hardcoding them.
 */
export function processGlobalDirectives(
  source: string,
  addDiag: (message: string, loc: { start: number; end: number }) => void,
): { name: string; ann: TypeAnnotation }[] {
  const directives = extractGlobalDirectives(source);
  // Returned so setup can re-register them with the project's aliases
  // expanded (`registerDirectiveMethodsExpanded`): a `::global` member that
  // names a globals alias (`Error#errors :: Errors | Undefined`) otherwise
  // stays an opaque `Errors` and rejects `err.errors = { … }`.
  const registered: { name: string; ann: TypeAnnotation }[] = [];

  for (const directive of directives) {
    const match = GLOBAL_PATTERN.exec(directive.text);
    if (!match) {
      addDiag(`Invalid ::global directive. Expected: ::global Type#method :: signature`, directive);
      continue;
    }

    const name = match[1];  // e.g. "Array#ap" or "Array.empty"
    const raw = match[2].trim();  // e.g. "[a] ~> [a -> b] -> [b]"

    try {
      let ann: TypeAnnotation;

      if (raw.includes('~>')) {
        // Instance method: parse with receiver
        const parsed = parseMethodTypeSignature(raw);
        ann = {
          name,
          raw,
          scheme: parsed.scheme,
          receiver: parsed.receiver,
          methodType: parsed.methodType,
          commentStart: directive.start,
          commentEnd: directive.end,
        };
      } else {
        // Static method or property
        const scheme = parseTypeSignature(raw);
        ann = {
          name,
          raw,
          scheme,
          commentStart: directive.start,
          commentEnd: directive.end,
        };
      }

      registerAnnotationMethod(name, ann);
      registered.push({ name, ann });
    } catch (e) {
      const msg = e instanceof TypeParseError ? e.message : String(e);
      addDiag(`Invalid ::global type signature for '${name}': ${msg}`, directive);
    }
  }
  return registered;
}

// ---------------------------------------------------------------------------
// sumtype directive processing
// ---------------------------------------------------------------------------

/**
 * Process `// sumtype TypeName a b = Variant1 a | Variant2 b` directives.
 *
 * This does three things:
 * 1. Registers the data type in the data type registry
 * 2. Validates type variable usage
 * 3. Warns when a variant is missing an explicit constructor annotation
 */
export function processDataDirectives(
  ctx: AnnotationContext,
  source: string,
): void {
  const directives = extractDataDirectives(source);

  for (const decl of directives) {
    registerDataType(decl);

    // Warn for each variant that doesn't have an explicit constructor annotation.
    for (const variant of decl.variants) {
      if (ctx.annotationMap.has(variant.name)) continue;

      // Build expected signature for the suggestion message
      const returnSig = decl.typeVars.length > 0
        ? `${decl.name} ${decl.typeVars.join(' ')}`
        : decl.name;
      const expectedSig = variant.fields.length === 0
        ? returnSig
        : `${variant.fields.join(' -> ')} -> ${returnSig}`;

      // Find the variant name position within the comment text so only the
      // variant name (e.g. "Left") is underlined, not the entire comment.
      // Use word-boundary regex and search only after `::` to avoid
      // matching substrings (e.g. "Array" inside "TypedArray").
      const commentText = source.slice(decl.commentStart, decl.commentEnd);
      const bodyStart = commentText.indexOf('::');
      const offset = bodyStart >= 0 ? bodyStart : 0;
      const searchText = commentText.slice(offset);
      const variantMatch = new RegExp(`\\b${variant.name}\\b`).exec(searchText);
      const variantLoc = variantMatch
        ? { start: decl.commentStart + offset + variantMatch.index, end: decl.commentStart + offset + variantMatch.index + variant.name.length }
        : { start: decl.commentStart, end: decl.commentEnd };

      // DiagnosticSeverity.Information = 3 (blue underline)
      ctx.addDiag(
        `Variant '${variant.name}' is missing a constructor annotation. Add: // ${variant.name} :: ${expectedSig}`,
        variantLoc,
        3,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Curry directive auto-detection
// ---------------------------------------------------------------------------

/**
 * Auto-detect curry wrapper pattern from annotation type.
 *
 * Only match when the result type has spread in the arrow chain (curried output),
 * e.g. ((a, b, ...) -> z) -> a -> b -> ... -> z
 * NOT memoize/once patterns like ((a, b, ...) -> z) -> (a, b, ...) -> z
 */
export function processCurryDirectives(
  allAnnotations: TypeAnnotation[],
  curryFunctionNames: Set<string>,
  curryNFunctionNames?: Map<string, number>,
): void {
  for (const ann of allAnnotations) {
    if (ann.name && ann.scheme) {
      const leading = curryWrapperLeadingArgs(ann.scheme.type);
      if (leading === 0) curryFunctionNames.add(ann.name);
      else if (leading !== null) curryNFunctionNames?.set(ann.name, leading);
    }
  }
}

/**
 * The number of leading non-function arguments of a curry wrapper
 * (`curry :: ((a, b, ...) -> z) -> a -> b -> ... -> z` → 0,
 * `curryN :: Number -> ((a, b, ...) -> z) -> …` → 1), or `null` when the
 * type is not a curry wrapper.  Shared by JS annotations and `.hm` files.
 */
export function curryWrapperLeadingArgs(type: Type): number | null {
  let annType = type;
  let leading = 0;
  while (annType.tag === 'TFun' && annType.param.tag !== 'TFun' && annType.result.tag === 'TFun') {
    leading++;
    annType = annType.result;
  }
  return annType.tag === 'TFun' &&
    annType.param.tag === 'TFun' &&
    isSpreadTupleOrArray(annType.param.param) &&
    hasSpreadInArrowChain(annType.result)
    ? leading
    : null;
}

// ---------------------------------------------------------------------------
// Annotation type constructor validation
// ---------------------------------------------------------------------------

/** Built-in type constructor names that are always valid. */
export const BUILTIN_TYPE_NAMES = new Set([
  'Number', 'String', 'Boolean', 'Null', 'Undefined', 'Void',
  'Array', T_TUPLE, 'SpreadArray', 'Console', 'Math', 'Union', 'Promise',
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'URIError', 'EvalError', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'RegExp', 'Date', 'Symbol', 'BigInt', 'TypeRep',
  'Any', 'Object', 'StrMap', 'Buffer', 'JSON', 'Reflect', 'Process',
  // Typed-array views + binary buffers (arity-0 builtins).
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'ArrayBuffer', 'DataView',
  // Generator (arity-1): the result of calling a `function*`.
  'Generator',
  // `ReactElement` (arity-0): the nominal type every JSX expression
  // evaluates to (see src/infer/expr-jsx.ts).  Always valid so signatures
  // like `App :: { title :: String } -> ReactElement` need no `::types`.
  'ReactElement',
  // Timer handles returned by `setTimeout` (see src/hm/env.ts), so they can
  // be written in annotations too.
  'TimeoutId', 'IntervalId',
  'Integer', 'Float', 'Double', 'NonNegativeInteger', 'NegativeInteger',
  'PositiveNumber', 'NegativeNumber', 'ValidNumber', 'NonZeroValidNumber',
  'FiniteNumber', 'NonZeroFiniteNumber', 'PositiveFiniteNumber', 'NegativeFiniteNumber',
  'NonZeroInteger', 'PositiveInteger',
  // `Picked R a` is a reserved call-site projection marker — replaced by
  // the `applyPickedProjection` post-processor in `src/infer/calls.ts`.
  'Picked',
  // `Merge a b` is a reserved structural-union marker — replaced by the
  // `applyMergeReduction` post-processor in `src/infer/calls.ts`.  Used
  // to type combinators like `QueryTag#concat` whose result row + param
  // are the structural union of both operands.
  'Merge',
  // `Awaited a` is a reserved marker (like TypeScript's `Awaited<T>`):
  // reduced after a call to `x` when `a` is `Promise e x`, else to `a` —
  // see `applyAwaitedReduction` in `src/infer/call-rows.ts`.
  'Awaited',
]);

/** Built-in type constructors with a required arity. */
export const BUILTIN_TYPE_ARITIES: ReadonlyMap<string, number> = new Map([
  ['StrMap', 1],
  // `Function` and `Object` carry two mandatory children:
  //   Function [params] result   and   Object key value
  // A bare `Function`/`Object` (or any other arity) is an error.
  ['Function', 2],
  ['Object', 2],
]);

// ---------------------------------------------------------------------------
// Re-exports — annotation validation and rigid checking were split into
// sibling modules; re-exported here so consumers keep importing from
// './annotations' unchanged.
// ---------------------------------------------------------------------------

export {
  validateDataVariantFields,
  validateVariantMethodAnnotations,
  validateVariantMethodImplementations,
  buildTypeArities,
  applyArityHKGrouping,
  validateAnnotationTypes,
  findArityMismatches,
  annotationNameLoc,
} from './annotation-validation';

export {
  maybeRigidCheck,
  checkAnnotationRigid,
  narrowToIdentifier,
  hasUnknownTConDiagForScheme,
  bindingNameFromNode,
  annotationMismatchMessage,
  shouldSuppressMismatch,
  methodNameMismatchMessage,
} from './annotation-rigid';

