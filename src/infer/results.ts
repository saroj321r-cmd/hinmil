// ============================================================================
// Result construction — export maps, top-level bindings, display cleanup
//
// Plain language: after all inference is done, this file packs up the
// answers: which names the file exports (and their final types), the type of
// every top-level binding, all with internal artefacts cleaned out so hover
// popups show polished results.
//
// Extracted from the InferenceEngine class.  These functions run at the end
// of `engine.infer()` to assemble the InferenceResult: building the export
// map and top-level binding table, scrubbing `$error` poison, normalizing
// kv-constraints for display, and post-processing constraint rewrites.
// ============================================================================

import { exportsToRecord } from './helpers';
import type { InferenceEngine } from './index';
import {
  Type,
  Scheme,
  tVar,
  tCon,
  tRecord,
  tUnion,
  typeToString,
  T_ERROR,
  parseKvName,
  RepEntry,
  isAppliedFunction,
} from '../hm/types';
import { TypeEnv, instantiate, generalize, applySubstToScheme } from '../hm/env';
import { isLocalAnnotation, fieldTypeVars } from '../commentParser';
import { lookupConstraint, constraintSuperclassClosure } from '../registries/constraintRegistry';
import { getVariantNames, isDataType, getDataType } from '../registries/dataTypeRegistry';
import { buildTypeAliasResult } from './annotations';
import { scrubSkolems, someType } from '../hm/typeUtils';
import { isSkolem } from '../hm/types';
import { InferenceDiagnostic, InferenceResult } from './types';

/**
 * Post-inference normalization of `kvConstraints` for hover/completion
 * display.
 *
 * Higher-kinded (functor) constraint fragments are registered under each
 * fresh per-instantiation kv id — every `of`/`ap`/... call gets its own
 * functor variable.  When those variables later unify onto a shared
 * representative, their constraint fragments stay scattered under the
 * original ids and are never merged.  As a result the *same* expression can
 * display an arbitrary, often weaker, subset (e.g. `Apply f` leaking from an
 * `ap` call instead of the `Applicative f` that `of` requires), and two
 * identical expressions can disagree.
 *
 * This pass resolves every kv id to its representative (chasing both
 * `TVar -> TVar` links and kv-`TCon` bindings), unions the *functor-kind*
 * (`* -> *`) constraints across each representative group, applies superclass
 * subsumption (dropping any constraint that is a proper superclass of another
 * present one — keeping the strongest), and writes the reconciled set back so
 * a lookup by any contributing id returns the same set.
 *
 * Only `* -> *` constraints are merged: kind-`*` constraints such as
 * `Setoid (f b)` must never migrate onto the `* -> *` functor variable.
 */
function normalizeKvConstraintsForDisplay(engine: InferenceEngine): void {
  const map = engine.kvConstraints;
  if (map.size === 0) return;

  const resolveRep = (id: number): number => {
    let cur = id;
    const seen = new Set<number>();
    for (;;) {
      if (seen.has(cur)) return cur;
      seen.add(cur);
      const bound = engine.subst.lookup(cur);
      if (!bound) return cur;
      if (bound.tag === 'TVar') {
        if (bound.id === cur) return cur;
        cur = bound.id;
        continue;
      }
      if (bound.tag === 'TCon') {
        const kv = parseKvName(bound.name);
        if (kv && kv.varId !== cur) { cur = kv.varId; continue; }
      }
      return cur;
    }
  };

  const isFunctorKind = (name: string): boolean =>
    lookupConstraint(name)?.expectedKind === '* -> *';

  // Union functor-kind constraint names per representative.
  const groupFunctor = new Map<number, Set<string>>();
  for (const [id, names] of map) {
    const rep = resolveRep(id);
    let set = groupFunctor.get(rep);
    if (!set) { set = new Set<string>(); groupFunctor.set(rep, set); }
    for (const n of names) if (isFunctorKind(n)) set.add(n);
  }

  // Superclass subsumption: drop any name that is a proper superclass
  // (transitive `extends` ancestor) of another present name.
  const subsume = (names: Set<string>): string[] => {
    const arr = [...names];
    return arr.filter(n =>
      !arr.some(other => other !== n && constraintSuperclassClosure(other).has(n)));
  };
  const repFunctor = new Map<number, string[]>();
  for (const [rep, set] of groupFunctor) repFunctor.set(rep, subsume(set));

  const dedupe = (xs: string[]): string[] => [...new Set(xs)];

  // Write back onto every id that already carries a functor-kind constraint,
  // preserving its non-functor constraints.  Do not inject a functor
  // constraint onto ids that only hold kind-`*` constraints.
  for (const [id, names] of map) {
    const reconciled = repFunctor.get(resolveRep(id));
    if (!reconciled || reconciled.length === 0) continue;
    if (!names.some(isFunctorKind)) continue;
    const nonFunctor = names.filter(n => !isFunctorKind(n));
    map.set(id, dedupe([...reconciled, ...nonFunctor]));
  }
  // Ensure each representative itself carries the reconciled set (it may not
  // have had a direct entry of its own).
  for (const [rep, reconciled] of repFunctor) {
    if (reconciled.length === 0) continue;
    const existing = map.get(rep) ?? [];
    const nonFunctor = existing.filter(n => !isFunctorKind(n));
    map.set(rep, dedupe([...reconciled, ...nonFunctor]));
  }
}

export function buildResult(engine: InferenceEngine, opts: {
  type: Type;
  diagnostics: InferenceDiagnostic[];
  exports: Map<string, Scheme>;
  topLevelBindings: Map<string, Scheme>;
}): InferenceResult {
  normalizeKvConstraintsForDisplay(engine);
  return {
    type: opts.type,
    substitution: engine.subst,
    diagnostics: opts.diagnostics,
    nodeTypes: engine.nodeTypes,
    declaredSchemes: engine.declaredSchemes,
    nodeTypesByEnd: engine.nodeTypesByEnd,
    functionNodeTypes: engine.functionNodeTypes,
    annotations: engine.annotationMap,
    annotationsByOffset: engine.annotationByOffset,
    methodSignatures: engine.methodSignatures,
    exports: opts.exports,
    kvConstraints: engine.kvConstraints,
    kvConstructorConstraints: engine.kvConstructorConstraints,
    typeAliases: buildTypeAliasResult(engine.typeAliases, engine.annotationMap),
    curriedNodes: engine.curriedNodes,
    callSiteOverloadIndex: engine.callSiteOverloadIndex,
    unboundIdentifiers: engine.unboundIdentifiers,
    topLevelBindings: opts.topLevelBindings,
    dataVariantNames: getVariantNames(),
    unconstrainedPropAccesses: engine.unconstrainedPropAccesses,
    importedConstructors: engine.importedConstructors,
    instanceCallables: engine.instanceCallables,
    constructorParentSumtype: engine.constructorParentSumtype,
    frozenPropertyTypeStr: engine.frozenPropertyTypeStr,
    frozenParamType: scrubFrozenParamSkolems(engine),
    bindingExtents: engine.bindingExtents,
    skolemDisplayNames: engine.skolemDisplayNames,
  };
}

/**
 * Annotated parameters of bodies checked against rigid skolems are frozen
 * with those skolems; render them with the annotation's letters so no result
 * consumer (hover, signature help, tests) ever sees a `§N` constant.
 */
function scrubFrozenParamSkolems(engine: InferenceEngine): Map<number, Type> {
  const frozen = engine.frozenParamType;
  if (engine.skolemDisplayNames.size === 0) return frozen;
  for (const [offset, t] of frozen) {
    if (someType(t, isSkolem)) frozen.set(offset, scrubSkolems(t, engine.skolemDisplayNames));
  }
  return frozen;
}

/**
 * Replace every `$error` sentinel in a type with a fresh type variable.
 * `poisonFreeVars` binds free TVars to `$error` after a unification
 * failure to stop cascading diagnostics — but if such a binding survives
 * into `buildExportMap`, it would bake `$error` into the exported scheme
 * (and `generalize` then produces `vars=[]` because `$error` has no free
 * vars, collapsing polymorphism for the consumer).  Scrubbing restores
 * polymorphism so consumers continue to see a usable signature even when
 * the producing module's body had a unification error.
 */
function scrubErrorWithFreshVars(t: Type): Type {
  if (t.tag === 'TCon') {
    if (t.name === T_ERROR) return tVar();
    if (!t.args || t.args.length === 0) return t;
    const newArgs = t.args.map(a => scrubErrorWithFreshVars(a));
    let changed = false;
    for (let i = 0; i < newArgs.length; i++) {
      if (newArgs[i] !== t.args[i]) { changed = true; break; }
    }
    return changed ? { ...t, args: newArgs } : t;
  }
  if (t.tag === 'TFun') {
    const p = scrubErrorWithFreshVars(t.param);
    const r = scrubErrorWithFreshVars(t.result);
    return (p === t.param && r === t.result) ? t : { tag: 'TFun', param: p, result: r };
  }
  if (t.tag === 'TRecord') {
    const newFields: Record<string, Type> = {};
    let changed = false;
    for (const [k, v] of Object.entries(t.fields)) {
      const nv = scrubErrorWithFreshVars(v);
      newFields[k] = nv;
      if (nv !== v) changed = true;
    }
    return changed ? { ...t, fields: newFields } : t;
  }
  return t;
}

/**
 * Select the `::rep` entries from this file that apply to the given
 * constraints.  Used to attach call-scoped constraint representations to an
 * exported scheme so they travel to import sites.
 */
function repsForConstraints(
  engine: InferenceEngine,
  constraints: { className: string }[] | undefined,
): RepEntry[] {
  const allReps = [...engine.fileReps, ...engine.importedReps];
  if (!constraints || constraints.length === 0 || allReps.length === 0) {
    return [];
  }
  // Superclasses too: a `Plus f` scheme needs `f`'s Alt and Functor
  // instances to be discharged at the call site.
  const names = new Set<string>();
  for (const c of constraints) {
    names.add(c.className);
    for (const sup of constraintSuperclassClosure(c.className)) names.add(sup);
  }
  return allReps.filter((r) => names.has(r.constraint));
}

/**
 * Copy narrowing-related metadata (type predicate, conditional-return
 * narrowing, optional-parameter slots) from one scheme onto another so it
 * travels with an exported scheme to the import site.  Used uniformly by all
 * `buildExportMap` branches.
 */
function copyNarrowingMetadata(from: Scheme, to: Scheme): void {
  if (from.typePredicate) to.typePredicate = from.typePredicate;
  if (from.conditionalReturn) to.conditionalReturn = from.conditionalReturn;
  if (from.optionalParamSlots && from.optionalParamSlots.length > 0) {
    to.optionalParamSlots = from.optionalParamSlots.slice();
  }
}

export function buildExportMap(engine: InferenceEngine, finalEnv: TypeEnv, baseEnv: TypeEnv): Map<string, Scheme> {
  const exportMap = new Map<string, Scheme>();
  for (const name of engine.exportedNames) {
    // `module.exports = { key: <expr> }`: the export IS the property value.
    if (engine.cjsValueExports.has(name)) {
      const cjsType = engine.cjsExportTypes.get(name)!;
      const resolvedType = scrubErrorWithFreshVars(engine.subst.apply(cjsType));
      exportMap.set(name, generalize(baseEnv, resolvedType));
      continue;
    }
    const scheme = finalEnv.lookup(name);
    if (scheme) {
      // Annotation-authoritative export: when a top-level binding has an
      // explicit user annotation, export the annotation scheme verbatim.
      // Body inference may have unified the annotation's type variables
      // with concrete types from the body; applying `engine.subst` to the
      // scheme would leak those bindings into the consumer's view of the
      // signature.  The body is still inferred (and validated against
      // the annotation) — only the *exported* scheme is held authoritative
      // to the user's declared signature.
      const ann = engine.annotationMap.get(name);
      if (ann && ann.scheme && !ann.receiver && isLocalAnnotation(ann)) {
        const annScheme = ann.scheme;
        const exportedScheme: Scheme = {
          vars: annScheme.vars.slice(),
          type: annScheme.type,
        };
        if (annScheme.constraints && annScheme.constraints.length > 0) {
          exportedScheme.constraints = annScheme.constraints.slice();
          const reps = repsForConstraints(engine, exportedScheme.constraints);
          if (reps.length > 0) exportedScheme.reps = reps;
        }
        if (scheme.optionalParamSlots && scheme.optionalParamSlots.length > 0) {
          exportedScheme.optionalParamSlots = scheme.optionalParamSlots.slice();
        }
        if (scheme.typePredicate) exportedScheme.typePredicate = scheme.typePredicate;
        if (scheme.conditionalReturn) exportedScheme.conditionalReturn = scheme.conditionalReturn;
        if (engine.curryFunctionNames.has(name)) exportedScheme.isCurryWrapper = true;
        if (engine.curryNFunctionNames.has(name)) exportedScheme.curryLeadingArgs = engine.curryNFunctionNames.get(name);
        if (scheme.isCurriedResult) exportedScheme.isCurriedResult = true;
        exportMap.set(name, exportedScheme);
        continue;
      }
      const applied = applySubstToScheme(engine.subst, scheme);
      // Scrub `$error` poison before generalize: free TVars that were
      // bound to `$error` by error recovery would otherwise collapse the
      // polymorphism of the exported scheme (generalize sees no free
      // vars in `$error`).  Replace each `$error` with a fresh TVar so
      // generalize re-quantifies them and consumers see a usable
      // signature even when the body had a unification error.
      const scrubbedType = scrubErrorWithFreshVars(applied.type);
      const resolvedScheme = generalize(baseEnv, scrubbedType);
      const boundSet = new Set(resolvedScheme.vars);
      for (const v of scheme.vars) {
        if (!boundSet.has(v)) resolvedScheme.vars.push(v);
      }
      // `generalize` produces a fresh Scheme with only `vars` and `type` —
      // preserve the original scheme's metadata (constraints, narrowing
      // predicates, conditional-return narrowing, curry markers) so the
      // exported scheme behaves identically at the import site.
      if (applied.constraints && applied.constraints.length > 0) {
        resolvedScheme.constraints = applied.constraints;
        const reps = repsForConstraints(engine, applied.constraints);
        if (reps.length > 0) resolvedScheme.reps = reps;
      }
      if (applied.typePredicate) resolvedScheme.typePredicate = applied.typePredicate;
      if (applied.conditionalReturn) resolvedScheme.conditionalReturn = applied.conditionalReturn;
      if (applied.optionalParamSlots && applied.optionalParamSlots.length > 0) {
        resolvedScheme.optionalParamSlots = applied.optionalParamSlots.slice();
      }
      if (engine.curryFunctionNames.has(name)) resolvedScheme.isCurryWrapper = true;
      if (engine.curryNFunctionNames.has(name)) resolvedScheme.curryLeadingArgs = engine.curryNFunctionNames.get(name);
      if (scheme.isCurriedResult) resolvedScheme.isCurriedResult = true;
      exportMap.set(name, resolvedScheme);
      continue;
    }
    // Fallback: `exports.X = expr` (CommonJS) where X is not bound in env
    const cjsType = engine.cjsExportTypes.get(name);
    // Annotation-authoritative, same as declarations above: `// X :: T`
    // followed by `exports.X = expr` exports T verbatim (with its
    // constraints), not the inferred implementation type.
    const cjsAnn = cjsType ? engine.annotationMap.get(name) : undefined;
    if (cjsType && cjsAnn && cjsAnn.scheme && !cjsAnn.receiver && isLocalAnnotation(cjsAnn)) {
      const annScheme = cjsAnn.scheme;
      const exportedScheme: Scheme = { vars: annScheme.vars.slice(), type: annScheme.type };
      if (annScheme.constraints && annScheme.constraints.length > 0) {
        exportedScheme.constraints = annScheme.constraints.slice();
        const reps = repsForConstraints(engine, exportedScheme.constraints);
        if (reps.length > 0) exportedScheme.reps = reps;
      }
      copyNarrowingMetadata(annScheme, exportedScheme);
      exportMap.set(name, exportedScheme);
      continue;
    }
    if (cjsType) {
      const resolvedType = scrubErrorWithFreshVars(engine.subst.apply(cjsType));
      exportMap.set(name, generalize(baseEnv, resolvedType));
    }
  }

  if (engine.defaultExportName) {
    const fields: Record<string, Type> = {};
    const prefix = engine.defaultExportName + '.';
    for (const [annName, ann] of engine.annotationMap) {
      if (annName.startsWith(prefix) && ann.scheme) {
        if (ann.receiver) continue;
        const propName = annName.slice(prefix.length);
        fields[propName] = instantiate(ann.scheme);
        if (!exportMap.has(propName)) exportMap.set(propName, ann.scheme);
      }
    }
    // Unannotated static factories assigned to the default export
    // (e.g. `Response.Redirect = _Redirect;` with no `// Response.Redirect ::`
    // annotation).  Export the inferred function type so a consumer that
    // destructures `const { Redirect } = Response` sees the real signature
    // instead of falling back to a fresh type variable.  Explicit
    // annotations (collected above) take precedence.
    const staticMembers = engine.staticMemberTypes.get(engine.defaultExportName);
    if (staticMembers) {
      for (const [propName, propType] of staticMembers) {
        if (propName in fields || exportMap.has(propName)) continue;
        const resolved = scrubErrorWithFreshVars(engine.subst.apply(propType));
        const memberScheme = generalize(baseEnv, resolved);
        fields[propName] = instantiate(memberScheme);
        exportMap.set(propName, memberScheme);
      }
    }
    // Is the default identifier itself callable?  A default export like
    // `module.exports = _Id` where `_Id :: a -> Id a` PLUS static props
    // `_Id.of` / `_Id.chainRec` must stay callable in the consumer —
    // exporting a bare `{ of, chainRec, name }` record would make the
    // importer's `Id(x)` call fail ("not callable").  The static props
    // remain reachable via their own named exports (set above) and the
    // static-method registry, so we drop the record and fall through to
    // the callable annotation-authoritative branch below.
    let defaultIsCallable = false;
    const defAnn = engine.annotationMap.get(engine.defaultExportName);
    if (defAnn && defAnn.scheme && !defAnn.receiver && isLocalAnnotation(defAnn)) {
      const t = defAnn.scheme.type;
      defaultIsCallable = t.tag === 'TFun' || isAppliedFunction(t);
    }
    if (!defaultIsCallable) {
      const envScheme = finalEnv.lookup(engine.defaultExportName);
      if (envScheme) {
        const t = engine.subst.apply(envScheme.type);
        defaultIsCallable = t.tag === 'TFun' || isAppliedFunction(t);
      }
    }
    if (Object.keys(fields).length > 0 && !defaultIsCallable) {
      const recordType = tRecord(fields);
      const scheme = generalize(baseEnv, recordType);
      exportMap.set('default', scheme);
    } else if (!exportMap.has('default')) {
      const identScheme = finalEnv.lookup(engine.defaultExportName);
      if (identScheme) {
        // Annotation-authoritative default export: when the chosen
        // identifier has an explicit user annotation IN THIS FILE,
        // export the annotation scheme verbatim (mirrors the named-
        // export branch above).  Applying `engine.subst` to the
        // identScheme.type would leak body unification bindings into
        // the consumer's view — and `generalize` then drops the
        // polymorphic vars because the body bound them, producing a
        // monomorphic scheme that exposes raw scheme TVar ids (e.g.
        // chain's `m@6`) to the importer.  The `isLocalAnnotation`
        // guard prevents merged sidecar / globals / `::types`
        // annotations (e.g. query-builder.hm's `default :: ...`) from
        // accidentally overwriting an unrelated default export.
        const ann = engine.annotationMap.get(engine.defaultExportName);
        if (ann && ann.scheme && !ann.receiver && isLocalAnnotation(ann)) {
          const annScheme = ann.scheme;
          const exportedScheme: Scheme = {
            vars: annScheme.vars.slice(),
            type: annScheme.type,
          };
          if (annScheme.constraints && annScheme.constraints.length > 0) {
            exportedScheme.constraints = annScheme.constraints.slice();
            const reps = repsForConstraints(engine, exportedScheme.constraints);
            if (reps.length > 0) exportedScheme.reps = reps;
          }
          copyNarrowingMetadata(identScheme, exportedScheme);
          if (identScheme.isCurriedResult) exportedScheme.isCurriedResult = true;
          if (identScheme.isCurryWrapper || engine.curryFunctionNames.has(engine.defaultExportName)) {
            exportedScheme.isCurryWrapper = true;
          }
          {
            const n = identScheme.curryLeadingArgs ?? engine.curryNFunctionNames.get(engine.defaultExportName);
            if (n) exportedScheme.curryLeadingArgs = n;
          }
          exportMap.set('default', exportedScheme);
        } else {
          const appliedDefault = applySubstToScheme(engine.subst, identScheme);
          const resolvedType = scrubErrorWithFreshVars(appliedDefault.type);
          const resolvedScheme = generalize(baseEnv, resolvedType);
          if (appliedDefault.constraints && appliedDefault.constraints.length > 0) {
            resolvedScheme.constraints = appliedDefault.constraints;
            const reps = repsForConstraints(engine, appliedDefault.constraints);
            if (reps.length > 0) resolvedScheme.reps = reps;
          }
          copyNarrowingMetadata(appliedDefault, resolvedScheme);
          if (identScheme.isCurriedResult) resolvedScheme.isCurriedResult = true;
          if (identScheme.isCurryWrapper || engine.curryFunctionNames.has(engine.defaultExportName!)) {
            resolvedScheme.isCurryWrapper = true;
          }
          {
            const n = identScheme.curryLeadingArgs ?? engine.curryNFunctionNames.get(engine.defaultExportName!);
            if (n) resolvedScheme.curryLeadingArgs = n;
          }
          exportMap.set('default', resolvedScheme);
        }
      }
    }
  }
  // CommonJS `module.exports = { … }`: for ESM interop (Node, Babel) the
  // default import IS the module.exports object — `import nr from "FP-library";
  // nr.RTask` — so expose the object's record type as `default`.
  if (!exportMap.has('default') && engine.cjsObjectExportType) {
    const resolvedType = scrubErrorWithFreshVars(engine.subst.apply(engine.cjsObjectExportType));
    if (resolvedType.tag === 'TRecord') exportMap.set('default', generalize(baseEnv, resolvedType));
  }
  // Same for `exports.X = …` / `module.exports.X = …` modules: the default
  // import is the exports object, i.e. the record of the named exports.
  if (!exportMap.has('default') && engine.usesCjsExports && exportMap.size > 0) {
    exportMap.set('default', generalize(baseEnv, exportsToRecord(exportMap)));
  }
  return exportMap;
}

export function buildTopLevelBindings(engine: InferenceEngine, finalEnv: TypeEnv, baseEnv: TypeEnv): Map<string, Scheme> {
  const topLevelBindings = new Map<string, Scheme>();
  for (const [name, sch] of finalEnv.entries()) {
    if (!baseEnv.lookup(name)) {
      topLevelBindings.set(name, {
        ...sch,
        type: engine.applyConstraintConstructorRewrites(engine.subst.apply(sch.type)),
      });
    }
  }
  return topLevelBindings;
}

/**
 * For every JS identifier whose name matches a registered sumtype
 * (e.g. `function Maybe`, `class Either`, `const Param = {}`), override
 * its type with the variant union (`Just a | Nothing`, `Left e | Right a`,
 * `Path | Query`).  This makes hover surface the sumtype's variant union
 * instead of the inferred class/object/function shape.  Static methods
 * (e.g. `Either.of`) keep working because static lookup resolves by
 * identifier name through the method registry, not by env binding type.
 */
export function overrideSumtypeIdentifierTypes(
  engine: InferenceEngine,
  source: string,
  topLevelBindings: Map<string, Scheme>,
): void {
  const buildUnion = (typeName: string): Type | null => {
    const dt = getDataType(typeName);
    if (!dt) return null;
    const args = dt.decl.typeVars.map(() => tVar());
    const variantTypes = dt.decl.variants.map(v => {
      const vArgs = v.fields.map(f => {
        // Fast path: a bare type-variable field maps directly to its slot.
        const idx = dt.decl.typeVars.indexOf(f);
        if (idx >= 0) return args[idx];
        // Complex field (record `{...}` or parenthesized application):
        // map it to the first parent type variable it references so the
        // sum type's parametricity surfaces in hover.  Falls back to a
        // fresh var when the field is fully concrete.
        for (const ref of fieldTypeVars(f)) {
          const refIdx = dt.decl.typeVars.indexOf(ref);
          if (refIdx >= 0) return args[refIdx];
        }
        return tVar();
      });
      return tCon(v.name, vArgs);
    });
    return tUnion(variantTypes);
  };

  for (const [name] of topLevelBindings) {
    if (!isDataType(name)) continue;
    const overrideType = buildUnion(name);
    if (!overrideType) continue;
    topLevelBindings.set(name, { vars: [], type: overrideType });
    // Override every nodeTypes entry whose start offset begins with the
    // identifier `name` as a complete word.  This captures both bare
    // identifier nodes (`Param` in `Param.Path = ...`) and binding
    // declaration nodes (`const Param = {}`, `function Maybe() {...}`,
    // `class Either {...}`) which all start at the identifier token.
    const re = new RegExp(`\\b${name}\\b`, 'g');
    const ids = new Set<number>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) ids.add(m.index);
    for (const [s, entry] of engine.nodeTypes) {
      if (!ids.has(s)) continue;
      // Only override when the existing entry doesn't already represent
      // a TFun that returns the parent sumtype's variant — those are
      // legitimate variant constructors (e.g. `Just :: a -> Maybe a`)
      // that happen to live next to a bare identifier of the parent
      // name.  Identifier text starts at `name` exactly: skip variant
      // names, which are guarded above by `isDataType` (variants are
      // not data types themselves).
      engine.nodeTypes.set(s, { type: overrideType, end: entry.end });
    }
  }
}

export function postProcessConstraintRewrites(engine: InferenceEngine): void {
  if (engine.constraintConstructorRewrites.length === 0) return;

  for (const [offset, entry] of engine.nodeTypes) {
    const resolved = engine.subst.apply(entry.type);
    const rewritten = engine.applyConstraintConstructorRewrites(resolved);
    if (rewritten !== resolved) {
      engine.nodeTypes.set(offset, { type: rewritten, end: entry.end });
    }
  }

  const stringRewrites = engine.constraintConstructorRewrites.map(rw => ({
    from: typeToString(rw.from),
    to: typeToString(rw.to),
  }));
  for (const diag of engine.diagnostics) {
    for (const sr of stringRewrites) {
      const paren = `(${sr.from})`;
      if (diag.message.includes(paren)) {
        diag.message = diag.message.split(paren).join(sr.to);
      }
      if (diag.message.includes(sr.from)) {
        diag.message = diag.message.split(sr.from).join(sr.to);
      }
    }
  }
}
