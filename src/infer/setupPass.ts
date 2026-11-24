// ============================================================================
// Annotation & directive setup pass
//
// Plain language: before the engine reads any actual code, it first reads
// ALL the comments — collecting annotations, processing directives, loading
// imports and type aliases — like reading a recipe's ingredient list before
// starting to cook.  This file is that preparation step.
//
// Extracted from the InferenceEngine class.  Runs at the start of `infer()`,
// before the AST walk: builds the annotation maps, processes all `::`
// directives, resolves imports/sidecars into aliases and constructors,
// validates annotations, and bakes constructor-style constraints.
// ============================================================================

import type { InferenceEngine } from './index';
import {
  canonicalSchemeKey,
  setActiveAllocator,
  collectVarNames,
  T_TYPEREP,
} from '../hm/types';
import type { TypeAnnotation } from '../commentParser';
import {
  buildAnnotationMap,
  buildAnnotationsByDeclaration,
  declarationStarts,
  buildAnnotationByOffset,
  extractAnnotations,
  extractStandaloneHiddenMarkers,
  extractStandalonePrivateMarkers,
  extractInstanceCallables,
  extractImportModuleSpecifiers,
  extractAliasExtensions,
  extractTypeDirectives,
} from '../commentParser';
import { isBuiltinType, markMethodHidden, markMethodPrivate, markHiddenPropertyOffset } from '../registries/methodRegistry';
import { lookupConstraint } from '../registries/constraintRegistry';
import { addRepUnique, getModuleReps } from './moduleReps';
import { isDataType } from '../registries/dataTypeRegistry';
import {
  processMethodAnnotations,
  processTypeDirectives,
  buildTypeAliases,
  buildTypeAliasVars,
  applyAliasExtensions,
  expandAllAnnotationAliases,
  expandAnnotationAliases,
  registerDirectiveMethodsExpanded,
  processConstraintDirectives,
  processRepDirectives,
  processCurryDirectives,
  processDataDirectives,
  validateDataVariantFields,
  validateAnnotationTypes,
  validateVariantMethodAnnotations,
  validateVariantMethodImplementations,
  buildTypeArities,
  applyArityHKGrouping,
  type AnnotationContext,
} from './annotations';
import { UNTYPED_MODULE } from './types';
import { typeConstructorArity, registerKvConstraint, bakeCtorConstraintsOnAnnotation } from './constraints';

/**
 * Run the pre-inference annotation/directive setup pass: build annotation
 * maps (merging project globals), report annotation parse errors, process
 * `::constraint` / `::data` / `::types` / `::rep` / curry directives,
 * pre-resolve imports (aliases, constructors, instance-callables, reps),
 * validate orphan/duplicate/unknown annotations, and bake constructor-style
 * constraints into the annotation types.  Mutates engine state in place.
 */
export function runAnnotationSetup(engine: InferenceEngine, source: string): void {
  // Extract HM annotations from comments
  engine.annotationMap = buildAnnotationMap(source);
  engine.annotationsByDeclaration = buildAnnotationsByDeclaration(source);
  engine.annotationByOffset = buildAnnotationByOffset(source);

  // Merge annotations from the project globals file (if provided), so that
  // project-wide aliases like `Selector :: ...` and value annotations like
  // `tables :: { ... }` are visible to every file the engine infers without
  // requiring an explicit `// ::types` directive in each consumer.  The
  // file's own annotations always win on collision.
  if (engine.globalsSource) {
    const globalAnns = buildAnnotationMap(engine.globalsSource);
    for (const [name, ann] of globalAnns) {
      if (!engine.annotationMap.has(name)) {
        // Tag the merged entry so downstream consumers that must be
        // file-local-only (export schemes, dotted-name constraint
        // injection, prototype receivers, bare-binding lookups) can
        // skip globals via `isLocalAnnotation`.
        engine.annotationMap.set(name, { ...ann, origin: 'globals' });
      }
    }
  }

  // Report parse errors in annotations (including those without a name)
  const allAnnotations = extractAnnotations(source);
  // Apply standalone `// ::hidden` markers to method registry so completion
  // can suppress them.  Markers are dropped on every `clearCustomMethods`,
  // so they are scoped per inference run.
  for (const m of extractStandaloneHiddenMarkers(source)) {
    if (m.typeName) markMethodHidden(m.typeName, m.methodName);
    markHiddenPropertyOffset(m.memberStart);
  }
  // Apply standalone `// ::private` markers (privacy implies hidden).
  for (const m of extractStandalonePrivateMarkers(source)) {
    if (m.typeName) {
      markMethodPrivate(m.typeName, m.methodName);
      markMethodHidden(m.typeName, m.methodName);
    }
    markHiddenPropertyOffset(m.memberStart);
  }
  // Apply `private: true` annotation flags to the registry.  This covers
  // member annotations like `// Type#name :: ...` with `// ::private`
  // directly above them — regardless of which inference path registers
  // the method later (class method, prototype assignment, constructor body).
  for (const ann of allAnnotations) {
    if (!ann.private || !ann.name) continue;
    const name = ann.name;
    // Member annotations are `Type#name`, `Type##name`, or `Type.name`.
    const m = /^([A-Za-z_$][\w$]*)(?:##|[#.])([A-Za-z_$][\w$]*)$/.exec(name);
    if (!m) continue;
    markMethodPrivate(m[1], m[2]);
    markMethodHidden(m[1], m[2]);
  }
  for (const ann of allAnnotations) {
    if (ann.error) {
      const message = ann.name
        ? `Invalid type annotation for '${ann.name}': ${ann.error}`
        : `Invalid type annotation: ${ann.error}`;
      // Signature-related diagnostics underline the annotation name in the
      // comment itself (e.g. the `getTwo` in `// getTwo :: ...`) so the user
      // sees the issue exactly where the signature lives.  Fall back to the
      // whole comment when no annotation name is available.
      const diagLoc: { start: number; end: number } =
        ann.signatureNameStart !== undefined && ann.signatureNameEnd !== undefined
          ? { start: ann.signatureNameStart, end: ann.signatureNameEnd }
          : { start: ann.commentStart, end: ann.commentEnd };
      engine.addDiag(message, diagLoc);
    }
    // Report name mismatches (e.g. `// memoize :: ...` above `const memoizee = ...`)
    // The diagnostic points at the declaration name so the user sees the
    // problem at the implementation site.
    if (ann.nameMismatch && ann.nodeStart !== undefined) {
      const nameIdx = source.indexOf(ann.nameMismatch, ann.nodeStart);
      const start = nameIdx >= 0 ? nameIdx : ann.nodeStart;
      const end = start + ann.nameMismatch.length;
      engine.addDiag(
        `Declaration name '${ann.nameMismatch}' does not match annotation name '${ann.name}'`,
        { start, end },
        [{ message: `Annotation '${ann.name}' defined here`, start: ann.commentStart, end: ann.commentEnd }],
      );
    }
    // Report nameless annotations above named declarations
    // (e.g. `// :: Number -> Boolean` above `const getValue = ...`)
    if (ann.namelessOnNamed) {
      engine.addDiag(
        `Nameless annotation '// :: ...' is only allowed for anonymous functions. Use '// ${ann.namelessOnNamed} :: ...' instead`,
        { start: ann.commentStart, end: ann.commentEnd },
      );
    }
  }

  // Detect duplicate overload signatures.  Two value-level annotations that
  // share a declaration name are merged into one overloaded scheme by
  // `buildAnnotationMap`; if a later one is alpha-equivalent to an earlier
  // one it adds nothing, so flag it.  Method (`Type#m`) / dotted names are
  // excluded — they follow a different (non-overload-merge) path.
  {
    const seenKeysByName = new Map<string, Set<string>>();
    const declOf = declarationStarts(allAnnotations);
    for (const ann of allAnnotations) {
      if (!ann.name || !ann.scheme || ann.namelessOnNamed) continue;
      if (ann.name.endsWith('()')) continue;
      if (ann.name.includes('#') || ann.name.includes('.')) continue;
      const key = canonicalSchemeKey(ann.scheme);
      // Per declaration: a same-named helper in another scope is no overload.
      const declKey = `${ann.name}@${declOf.get(ann) ?? ''}`;
      let seen = seenKeysByName.get(declKey);
      if (!seen) { seen = new Set(); seenKeysByName.set(declKey, seen); }
      if (seen.has(key)) {
        const diagLoc: { start: number; end: number } =
          ann.signatureNameStart !== undefined && ann.signatureNameEnd !== undefined
            ? { start: ann.signatureNameStart, end: ann.signatureNameEnd }
            : { start: ann.commentStart, end: ann.commentEnd };
        engine.addDiag(
          `Duplicate overload signature for '${ann.name}': '${ann.raw.trim()}'`,
          diagLoc,
        );
      } else {
        seen.add(key);
      }
    }
  }

  // Build annotation context for the processing pipeline
  const annCtx: AnnotationContext = {
    annotationMap: engine.annotationMap,
    annotationByOffset: engine.annotationByOffset,
    typeAliases: new Map(),
    typeAliasVars: new Map(),
    typeDirectiveResolver: engine.typeDirectiveResolver,
    curryFunctionNames: engine.curryFunctionNames,
    instanceCallablesFromDirectives: new Map(),
    // `::global` members first: `::types` methods re-registered later win.
    directiveMethods: [...engine.globalDirectiveMethods],
    directiveRepSources: [],
    addDiag: (msg, loc, severity?) => engine.addDiag(msg, loc, undefined, severity),
  };

  // Process ::constraint directives
  processConstraintDirectives(source, (msg, loc) => engine.addDiag(msg, loc));

  // Process sumtype directives (sum type declarations)
  // Must run before processMethodAnnotations so auto-generated constructor
  // annotations are in place, and before validateAnnotationTypes so sumtype
  // types are recognized as known.
  processDataDirectives(annCtx, source);

  // Process curry wrapper auto-detection
  processCurryDirectives(allAnnotations, engine.curryFunctionNames, engine.curryNFunctionNames);

  // Process ::types directives (load external type annotations)
  processTypeDirectives(annCtx, source);

  // Pre-resolve imports so that data types, method registrations, and
  // constraint registrations from imported files are available before
  // annotation validation.  The import resolver caches results, so the
  // actual AST-walk import processing later will simply hit the cache.
  if (engine.importResolver) {
    for (const specifier of extractImportModuleSpecifiers(source)) {
      const resolved = engine.importResolver(specifier);
      // Collect `::rep` representatives carried by imported schemes so the
      // importing file can discharge the same constraint for the same
      // container type (and propagate them further on re-export).
      if (resolved && resolved !== UNTYPED_MODULE && resolved instanceof Map) {
        for (const sch of resolved.values()) {
          if (sch.reps && sch.reps.length > 0) {
            for (const rep of sch.reps) addRepUnique(engine.importedReps, rep);
          }
        }
        // Reps visible in the imported module itself (its own + its
        // imports'), so they also cross unannotated intermediates.
        for (const rep of getModuleReps(resolved)) addRepUnique(engine.importedReps, rep);
      }
    }
    // Import engines switch the global active allocator to their own.
    // Restore this engine's allocator so TVars created during the main
    // inference belong to the correct allocator.
    setActiveAllocator(engine.allocator);
  }

  // Build type alias map from standalone type annotations
  engine.typeAliases = buildTypeAliases(engine.annotationMap);
  engine.typeAliasVars = buildTypeAliasVars(engine.annotationMap, engine.typeAliases);
  engine.importedConstructors = new Map();
  engine.instanceCallables = new Map();
  engine.bindingExtents = [];
  // Populate instance-callables from the local source first.  Local
  // declarations always win over sidecar entries on name collision.
  for (const [name, schemes] of extractInstanceCallables(source)) {
    engine.instanceCallables.set(name, [...schemes]);
  }
  // Merge in type aliases declared in imported `.hm` files (sidecars and
  // overrides).  Local aliases take precedence on name collision so the
  // consumer can override an upstream definition.  This is what makes
  // bare type names like `Selector` appearing inside an imported scheme
  // expand to their union body at unification sites.
  if (engine.importTypeAliasResolver) {
    // A relative `// ::types ./module` names the same types as importing
    // from that module: its own aliases (already in the annotation map via
    // `processTypeDirectives`) plus its `::types` closure and its imports.
    // Without this, `::types ./a` where `a` has `::types ./b` left the
    // names of `b` unexpanded inside `a`'s aliases, and the consumer then
    // met the same alias as a bare constructor and as a record ("Cannot
    // unify 'X' with 'X'").
    const relativeDirectives = extractTypeDirectives(source)
      .filter((spec) => spec.startsWith('.') || spec.startsWith('/'));
    for (const specifier of [...extractImportModuleSpecifiers(source), ...relativeDirectives]) {
      const imported = engine.importTypeAliasResolver(specifier);
      if (!imported) continue;
      for (const [name, type] of imported.aliases) {
        if (!engine.typeAliases.has(name)) engine.typeAliases.set(name, type);
      }
      for (const [name, vars] of imported.aliasVars) {
        if (!engine.typeAliasVars.has(name)) engine.typeAliasVars.set(name, vars);
      }
      if (imported.constructors) {
        for (const [name, scheme] of imported.constructors) {
          // Local annotations always win; otherwise first imported wins.
          if (engine.annotationMap.has(name)) continue;
          if (!engine.importedConstructors.has(name)) {
            engine.importedConstructors.set(name, scheme);
          }
        }
      }
      if (imported.instanceCallables) {
        for (const [name, schemes] of imported.instanceCallables) {
          // Local declarations win on name collision.
          if (engine.instanceCallables.has(name)) continue;
          engine.instanceCallables.set(name, [...schemes]);
        }
      }
      // Apply `::extend <Name> <typeExpr>` directives collected from
      // this specifier's sidecar(s) / override(s).  Done per-specifier
      // so each import sees its own augmented alias map; ordering
      // mirrors the merge order (sidecar first, override last).
      if (imported.aliasExtensions && imported.aliasExtensions.length > 0) {
        applyAliasExtensions(engine.typeAliases, imported.aliasExtensions, engine.typeAliasVars);
      }
    }
    setActiveAllocator(engine.allocator);
  }

  // Apply `::extend` directives declared in the local source.  Local
  // extensions are applied after imported ones so they can further
  // augment an alias that an imported sidecar (or its override)
  // already extended.
  const localAliasExtensions = extractAliasExtensions(source);
  if (localAliasExtensions.length > 0) {
    applyAliasExtensions(
      engine.typeAliases,
      localAliasExtensions,
      engine.typeAliasVars,
      (message, loc) => engine.diagnostics.push({ message, start: loc.start, end: loc.end }),
    );
  }

  // Merge instance-callables loaded via `// ::types <pkg>` directives.
  // Local source wins; previously-set imported entries also win since
  // they are typically more specific (the consumer chose to import the
  // module).  Otherwise add the directive-loaded scheme so values of
  // type `Name` from a sidecar can be invoked at the call site.
  if (annCtx.instanceCallablesFromDirectives) {
    for (const [name, schemes] of annCtx.instanceCallablesFromDirectives) {
      if (engine.instanceCallables.has(name)) continue;
      engine.instanceCallables.set(name, [...schemes]);
    }
  }

  // Drop orphan imported instance-callables: a `Name() :: ...` from a
  // sidecar / override only makes sense when a constructor `Name :: ...`
  // exists somewhere in scope (local annotation OR imported from any
  // sidecar — which is the override scenario where the constructor
  // lives in the base package sidecar and only `Name()` is overridden).
  // This is the import-time mirror of the local orphan diagnostic below.
  for (const name of [...engine.instanceCallables.keys()]) {
    // Skip locals; they are validated (and possibly diagnosed) below.
    if (engine.annotationMap.has(name + '()')) continue;
    if (!engine.annotationMap.has(name) && !engine.importedConstructors.has(name)) {
      engine.instanceCallables.delete(name);
    }
  }

  // Enforce: every `Name() :: ...` (instance-callable) requires a
  // matching constructor `Name :: ...` (locally defined or imported
  // via a sidecar).  An instance-callable describes how a value of
  // type `Name` is invoked; it is meaningless if `Name` itself has
  // no value-level definition.  Orphan local entries are diagnosed
  // and dropped here.  (Sidecar orphans are dropped silently in
  // `parseHmTypeAliases`.)
  {
    const allAnnotations = extractAnnotations(source);
    for (const ann of allAnnotations) {
      if (!ann.name || !ann.scheme) continue;
      if (!ann.name.endsWith('()')) continue;
      const baseName = ann.name.slice(0, -2);
      if (!baseName) continue;
      const hasConstructor =
        engine.annotationMap.has(baseName) || engine.importedConstructors.has(baseName);
      if (!hasConstructor) {
        engine.addDiag(
          `Instance-callable annotation '${baseName}() :: ...' has no constructor '${baseName} :: ...' in scope. Declare a constructor for '${baseName}' first.`,
          { start: ann.commentStart, end: ann.commentEnd },
        );
        engine.instanceCallables.delete(baseName);
      }
    }
  }

  // Enforce: every `Name#method` / `Name.method` annotation requires a
  // corresponding `Name` to exist as a value-level definition.  A method
  // or static annotation is meaningless when its receiver type does not
  // exist as a constructor / class / sumtype in scope.  Orphan local
  // entries are diagnosed and removed from the annotation map so they
  // are never registered into the method registry.
  //
  // `Name` is considered to exist when ANY of:
  //   - `Name :: ...` annotation exists locally (`annotationMap`)
  //   - `Name :: ...` is imported via a sidecar (`importedConstructors`)
  //   - `Name` is a sumtype registered via `data Name = ...` (`isDataType`)
  //   - `Name` is declared as an ES `class Name { ... }` in the source
  {
    // Cheap pre-scan for class declarations.  We only need NAMES here;
    // running a full AST walk would be premature (the AST is parsed a
    // few steps later).  Matches `class Foo`, `export class Foo`, and
    // `export default class Foo`.
    const classNames = new Set<string>();
    const classDeclRe = /\b(?:export\s+(?:default\s+)?)?class\s+([A-Z][\w$]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = classDeclRe.exec(source)) !== null) {
      classNames.add(m[1]);
    }
    // Plain-object hosts: `const/let/var X = { ... }` used as a dictionary
    // that later gets extended via `X.Y = function (...) { ... }`.  Such
    // hosts are valid binding-side bases for member-binding annotations
    // (`// X.Y :: T` or chained `// X.Y :: SomeType#method :: T`).
    const plainObjectHosts = new Set<string>();
    const plainObjRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
    while ((m = plainObjRe.exec(source)) !== null) {
      plainObjectHosts.add(m[1]);
    }
    const hasConstructor = (name: string): boolean =>
      engine.annotationMap.has(name)
      || engine.importedConstructors.has(name)
      || isDataType(name)
      || classNames.has(name)
      // Built-in types (String, Number, Array, ...) are first-class
      // receivers: the method registry already serves their methods
      // and `customMethods` accepts user-added entries (used by
      // ::global/::types).  Allow prototype-extension annotations
      // like `String#equals :: String ~> String -> Boolean` to pass.
      || isBuiltinType(name)
      // Plain-object hosts (`let builtIn = {}; builtIn.X = ...`) are
      // valid binding-side bases for `Host.Member :: T` annotations
      // (the binding is processed by the annotated member-assignment
      // path).  Skip the orphan check for them.
      || plainObjectHosts.has(name);

    const orphanMethodKeys: string[] = [];
    for (const [key, ann] of engine.annotationMap) {
      if (!ann.scheme) continue;
      // Chained-secondary entries (`// A :: B.x :: T`) are binding
      // annotations under the second name, not static-method
      // declarations on a constructor `B`.  Skip the orphan check
      // for them so e.g. `// Array#chain :: builtIn.Array :: T` does
      // not require `builtIn` to be a declared constructor.
      if (ann.chainedSecondary) continue;
      const hashIdx = key.indexOf('#');
      const dotIdx  = key.indexOf('.');
      let baseName: string | null = null;
      let kind: 'method' | 'static' | null = null;
      if (hashIdx > 0) {
        baseName = key.slice(0, hashIdx);
        kind = 'method';
      } else if (dotIdx > 0) {
        baseName = key.slice(0, dotIdx);
        kind = 'static';
      }
      if (!baseName || !kind) continue;
      if (hasConstructor(baseName)) continue;
      const label = kind === 'method' ? 'Method' : 'Static';
      engine.addDiag(
        `${label} annotation '${key} :: ...' has no constructor '${baseName} :: ...' in scope. Declare a constructor / class / sumtype for '${baseName}' first.`,
        { start: ann.commentStart, end: ann.commentEnd },
      );
      orphanMethodKeys.push(key);
    }
    for (const key of orphanMethodKeys) engine.annotationMap.delete(key);
  }

  annCtx.typeAliases = engine.typeAliases;
  annCtx.typeAliasVars = engine.typeAliasVars;

  // Expand type aliases in all parsed annotation types
  expandAllAnnotationAliases(annCtx);
  // Same expansion for each declaration's own annotation (same-named
  // helpers in other scopes); the cached map itself stays untouched.
  if (annCtx.typeAliases.size > 0 && engine.annotationsByDeclaration.size > 0) {
    const expanded = new Map<number, TypeAnnotation>();
    for (const [at, ann] of engine.annotationsByDeclaration) {
      expanded.set(at, expandAnnotationAliases(annCtx.typeAliases, ann, annCtx.typeAliasVars));
    }
    engine.annotationsByDeclaration = expanded;
  }
  registerDirectiveMethodsExpanded(annCtx);

  // Process method annotations (Name#method :: ReceiverType ~> MethodType)
  processMethodAnnotations(engine.annotationMap);

  // Process ::rep directives (constraint representations). Must run after
  // processMethodAnnotations so the local `Type#method :: ...` annotation is
  // present in this.annotationMap and after processConstraintDirectives so
  // the named constraint is registered.
  engine.fileReps = processRepDirectives(source, engine.annotationMap, (msg, loc) =>
    engine.addDiag(msg, loc),
  );
  // Instances from `::types` targets: validated in their own file, so no
  // diagnostics here.
  for (const targetSource of annCtx.directiveRepSources ?? []) {
    engine.fileReps.push(...processRepDirectives(targetSource, buildAnnotationMap(targetSource), () => {}));
  }

  // Register kv constraints from method annotations so that factory results
  // (which retain the annotation's parser-local kv ids) can look up constraint
  // methods via lookupConstraintMethod.
  for (const [, ann] of engine.annotationMap) {
    if (ann.scheme?.constraints && ann.receiver && ann.methodType) {
      const varNames = new Map<number, string>();
      collectVarNames(ann.receiver, varNames);
      collectVarNames(ann.methodType, varNames);
      for (const constraint of ann.scheme.constraints) {
        // Validate that the constraint is defined
        const def = lookupConstraint(constraint.className);
        if (!def) {
          // `TypeRep` is a witness marker, not a `::constraint` class. It is
          // baked into the type (`var := TypeRep <arg>`) by
          // bakeCtorConstraintsOnAnnotation, so it is never "unknown".
          if (constraint.className === T_TYPEREP) {
            continue;
          }
          // Constructor-style constraint (`Pair p => ...`): the className
          // names a known type constructor rather than a ::constraint
          // class.  These are resolved during instantiation (the var is
          // bound to the named constructor), so they are not "unknown".
          const namesKnownConstructor =
            isBuiltinType(constraint.className) ||
            isDataType(constraint.className) ||
            engine.annotationMap.has(constraint.className) ||
            engine.importedConstructors.has(constraint.className) ||
            typeConstructorArity(constraint.className) > 0;
          if (namesKnownConstructor) {
            continue;
          }
          const diagLoc =
            ann.signatureNameStart !== undefined && ann.signatureNameEnd !== undefined
              ? { start: ann.signatureNameStart, end: ann.signatureNameEnd }
              : { start: ann.commentStart, end: ann.commentEnd };
          engine.addDiag(
            `Unknown constraint '${constraint.className}'. Define it with \`// ::constraint ${constraint.className} ${constraint.typeVarName} { ... }\``,
            diagLoc,
          );
          continue;
        }
        for (const [varId, name] of varNames) {
          if (name === constraint.typeVarName) {
            registerKvConstraint(engine, varId, constraint);
            break;
          }
        }
      }
    }
  }

  // Bake constructor-style constraints (`Pair p => ... -> p c a`) into the
  // annotation types once, centrally: when a constraint names a known type
  // constructor rather than a `::constraint` class, the constrained var IS
  // that constructor.  Rewriting `p`/`p c a` to `Pair`/`Pair c a` (and
  // dropping the constraint) here keeps instantiation, the rigid check,
  // hover, and completion all consistent.
  for (const [, ann] of engine.annotationMap) {
    bakeCtorConstraintsOnAnnotation(engine, ann);
  }
  // The skolemizing prototype-method body path reads its `~>` signature from
  // `annotationByOffset` (a SEPARATE set of annotation objects), so the bake
  // must reach those too — otherwise an inner closure parameter typed `p c a`
  // under a `Pair p =>` constructor constraint never resolves to `Pair c a`.
  for (const [, ann] of engine.annotationByOffset) {
    bakeCtorConstraintsOnAnnotation(engine, ann);
  }

  // Validate variant#method annotations (suggest Type#method instead)
  validateVariantMethodAnnotations(engine.annotationMap, (msg, loc) => engine.addDiag(msg, loc));

  // Detect sum type variants missing method implementations
  validateVariantMethodImplementations(engine.annotationMap, source, (msg, loc, related, severity) => engine.addDiag(msg, loc, related, severity));

  // Apply arity-aware HK grouping to annotations that have constraint
  // variables and reference constructors with known arity.  This is a
  // structural transform (no re-parse) so TVar IDs are preserved.
  // Must run after sumtype + method registration so arities are known.
  const typeArities = buildTypeArities(engine.annotationMap);
  if (typeArities.size > 0) {
    applyArityHKGrouping(engine.annotationMap, engine.annotationByOffset, typeArities);
  }

  // Validate sumtype variant field types now that `::types` directives and
  // imports have been resolved (so imported field types are known).  Runs
  // late — the same stage as validateAnnotationTypes — because
  // processDataDirectives runs early (before ::types) only to register.
  validateDataVariantFields(annCtx, source);

  // Validate type constructors in annotations against known types
  validateAnnotationTypes(allAnnotations, source, engine.annotationMap, engine.typeAliases, (msg, loc, severity?) => engine.addDiag(msg, loc, undefined, severity));
}
