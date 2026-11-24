// ============================================================================
// Module-related inference functions extracted from InferenceEngine
//
// Plain language: the cross-file glue.  Handles `import`/`export` (and
// `require`) statements: figuring out what another file provides, bringing
// those types into the current file's scope, and recording what the current
// file offers to others.  Class declarations and their methods are also
// registered here so they can be used across files.
// ============================================================================

import type { InferenceEngine } from './index';
import { exportsToRecord } from './helpers';
import { Type, Scheme, AstNode, tVar, tAnyType, tFun, tVoid, tCon, mono, getReturnType, prettyTypeToString, decomposeFunParams, collectVarNames } from '../hm/types';
import { TypeEnv, instantiate, generalize } from '../hm/env';
import { Substitution } from '../hm/substitution';
import { getParentTypeName, isVariant } from '../registries/dataTypeRegistry';
import { registerMethod } from '../registries/methodRegistry';
import { findConstructor, variantThisScheme } from './helpers';
import { expandAliases, methodNameMismatchMessage } from './annotations';
import { debugLog } from '../debugLog';
import { isUntypedModule, isOpenWorldExports } from './types';
import type * as estree from '../estree';

// -----------------------------------------------------------------------
// Import / Export declarations
// -----------------------------------------------------------------------

/**
 * Recursively collect every local binding name introduced by a destructuring
 * pattern (Identifier, ObjectPattern, ArrayPattern, RestElement, AssignmentPattern).
 */
function collectPatternNames(pattern: estree.Pattern | null | undefined, out: Set<string>): void {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      out.add(pattern.name);
      return;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') {
          collectPatternNames(prop.argument as estree.Pattern, out);
        } else {
          // Property — `value` holds the local binding (may itself be a pattern)
          collectPatternNames(prop.value as estree.Pattern, out);
        }
      }
      return;
    case 'ArrayPattern':
      for (const elem of pattern.elements) {
        if (elem) collectPatternNames(elem as estree.Pattern, out);
      }
      return;
    case 'RestElement':
      collectPatternNames(pattern.argument as estree.Pattern, out);
      return;
    case 'AssignmentPattern':
      collectPatternNames(pattern.left as estree.Pattern, out);
      return;
  }
}

/** The closed aliases of this file (no free type variables, no
 *  parameters), such as a props record `Toast :: { message :: String, … }`. */
const closedAliasCache = new WeakMap<Map<string, Type>, Map<string, Type>>();

function closedAliases(engine: InferenceEngine): Map<string, Type> {
  // Per alias table (set once per `infer`): every import declaration of a
  // file shares it.
  const cached = closedAliasCache.get(engine.typeAliases);
  if (cached) return cached;
  const closed = new Map<string, Type>();
  for (const [name, body] of engine.typeAliases) {
    if ((engine.typeAliasVars.get(name) ?? []).length > 0) continue;
    const vars = new Map<number, string>();
    collectVarNames(body, vars);
    if (vars.size === 0) closed.set(name, body);
  }
  closedAliasCache.set(engine.typeAliases, closed);
  return closed;
}

const expandedSchemeCache = new WeakMap<Map<string, Type>, WeakMap<Scheme, Scheme>>();

/** An imported scheme with its closed aliases expanded, as local
 *  annotations are.  A name deep inside an imported type
 *  (`makeToaster :: … -> Promise Error (Toast -> ())`) otherwise stayed a
 *  bare constructor, and met the expanded record of a local annotation as
 *  "Cannot unify 'Toast' with 'Toast'".  Aliases with free variables are
 *  left alone: they get fresh variables per use site. */
function expandImportedScheme(scheme: Scheme, closed: Map<string, Type>): Scheme {
  if (closed.size === 0) return scheme;
  let perTable = expandedSchemeCache.get(closed);
  if (!perTable) {
    perTable = new WeakMap<Scheme, Scheme>();
    expandedSchemeCache.set(closed, perTable);
  }
  const hit = perTable.get(scheme);
  if (hit) return hit;
  const type = expandAliases(closed, scheme.type);
  const out = type === scheme.type ? scheme : { ...scheme, type };
  perTable.set(scheme, out);
  return out;
}

export function inferImportDeclaration(engine: InferenceEngine, node: estree.ImportDeclaration, env: TypeEnv): TypeEnv {
  if (!engine.importResolver) return env;

  const specifier = node.source?.value as string | undefined;
  if (!specifier) return env;

  const resolverResult = engine.importResolver(specifier);
  if (!resolverResult) {
    // Module could not be resolved — emit a diagnostic on the specifier string
    engine.addDiag(`Cannot resolve module '${specifier}'`, node.source ?? node);
    return env;
  }

  // Untyped module (e.g. an npm package without a `.hm` sidecar): bind every
  // imported name to the opaque `Any` type. Unlike a fresh tvar, `Any` does
  // not get unified into specific types by downstream usage — it propagates
  // as `Any`, preventing usage-driven hallucinated signatures.
  if (isUntypedModule(resolverResult)) {
    let currentEnv = env;
    for (const spec of node.specifiers ?? []) {
      const localName = spec.local?.name as string;
      if (!localName) continue;
      const scheme = mono(tAnyType);
      currentEnv = currentEnv.extend(localName, scheme);
      engine.recordNodeType(spec.local, instantiate(scheme));
      if (spec.type === 'ImportDefaultSpecifier') {
        engine.defaultImportSources.set(localName, specifier);
      }
    }
    return currentEnv;
  }

  const exportedBindings = resolverResult;
  let currentEnv = env;
  let closed: Map<string, Type> | undefined;
  const expanded = (scheme: Scheme): Scheme => {
    if (!closed) closed = closedAliases(engine);
    return expandImportedScheme(scheme, closed);
  };

  for (const spec of node.specifiers ?? []) {
    if (spec.type === 'ImportSpecifier') {
      // import { Box } from './demo'  or  import { Box as B } from './demo'
      const importedName = (spec.imported as estree.Identifier)?.name as string;
      const localName = spec.local?.name as string;
      const exportedScheme = exportedBindings.get(importedName);
      const scheme = exportedScheme && expanded(exportedScheme);
      if (scheme && localName) {
        currentEnv = currentEnv.extend(localName, scheme);
        engine.recordNodeType(spec.local, instantiate(scheme));
        engine.propagateCurryFlags(scheme, localName, spec.local.start);
      } else if (!scheme && importedName && isOpenWorldExports(exportedBindings)) {
        // Bundled (builtin) typings may lag behind the installed package
        // version — bind unknown names to `Any` instead of erroring.
        if (localName) {
          const anyScheme = mono(tAnyType);
          currentEnv = currentEnv.extend(localName, anyScheme);
          engine.recordNodeType(spec.local, instantiate(anyScheme));
        }
      } else if (!scheme && importedName) {
        // The name does not exist in the module's exports — emit a diagnostic
        engine.addDiag(`'${importedName}' is not exported from '${specifier}'`, spec.imported ?? spec);
      }
    } else if (spec.type === 'ImportDefaultSpecifier') {
      // import Box from './demo'
      const localName = spec.local?.name as string;
      const defaultScheme = exportedBindings.get('default');
      const scheme = (defaultScheme && expanded(defaultScheme))
        ?? (isOpenWorldExports(exportedBindings) ? mono(tAnyType) : undefined);
      if (scheme && localName) {
        currentEnv = currentEnv.extend(localName, scheme);
        engine.recordNodeType(spec.local, instantiate(scheme));
        engine.defaultImportSources.set(localName, specifier);
        engine.propagateCurryFlags(scheme, localName, spec.local.start);
      } else if (localName) {
        // No default export: report it at the import instead of leaving the
        // name unbound (which surfaced later as a misleading
        // "Unbound variable" at every use site).
        engine.addDiag(`Module '${specifier}' has no default export`, spec.local ?? spec);
        const anyScheme = mono(tAnyType);
        currentEnv = currentEnv.extend(localName, anyScheme);
        engine.recordNodeType(spec.local, instantiate(anyScheme));
      }
    } else if (spec.type === 'ImportNamespaceSpecifier') {
      // import * as Demo from './demo'  — create a record of all exports
      const localName = spec.local?.name as string;
      if (localName) {
        currentEnv = currentEnv.extend(localName, mono(exportsToRecord(exportedBindings)));
      }
    }
  }

  return currentEnv;
}

export function inferExportNamedDeclaration(engine: InferenceEngine, node: estree.ExportNamedDeclaration, env: TypeEnv): [TypeEnv, Type] {
  if (node.declaration) {
    // export const x = ...; export function f() {}
    const [newEnv, type] = engine.inferStatement(node.declaration, env);
    // Mark declared names as exported
    if (node.declaration.type === 'VariableDeclaration') {
      for (const decl of node.declaration.declarations) {
        collectPatternNames(decl.id as estree.Pattern, engine.exportedNames);
      }
    } else if ((node.declaration.type === 'FunctionDeclaration' || node.declaration.type === 'ClassDeclaration')
               && node.declaration.id?.name) {
      engine.exportedNames.add(node.declaration.id.name);
    }
    return [newEnv, type];
  }

  if (node.specifiers) {
    // Re-export from another module: `export { x, y as z } from './other'`
    const sourceSpec = node.source?.value as string | undefined;
    if (sourceSpec && engine.importResolver) {
      const resolved = engine.importResolver(sourceSpec);
      if (isUntypedModule(resolved)) {
        // Re-exporting from an untyped npm module — surface the names as
        // exports bound to fresh TVars without inspecting the source.
        for (const spec of node.specifiers) {
          const localName = (spec.local as estree.Identifier)?.name as string;
          const exportedName = (spec.exported as estree.Identifier)?.name as string;
          const targetName = exportedName || localName;
          if (!targetName) continue;
          engine.exportedNames.add(targetName);
          engine.cjsExportTypes.set(targetName, tAnyType);
        }
        return [env, tVoid];
      }
      if (resolved) {
        for (const spec of node.specifiers) {
          const localName = (spec.local as estree.Identifier)?.name as string;
          const exportedName = (spec.exported as estree.Identifier)?.name as string;
          const targetName = exportedName || localName;
          if (!localName || !targetName) continue;
          const scheme = resolved.get(localName);
          if (scheme) {
            engine.exportedNames.add(targetName);
            engine.cjsExportTypes.set(targetName, instantiate(scheme));
          } else if (isOpenWorldExports(resolved)) {
            // Bundled typings — unknown re-exported names stay usable as Any.
            engine.exportedNames.add(targetName);
            engine.cjsExportTypes.set(targetName, tAnyType);
          } else {
            engine.addDiag(`'${localName}' is not exported from '${sourceSpec}'`, spec.local ?? spec);
          }
        }
      } else {
        engine.addDiag(`Cannot resolve module '${sourceSpec}'`, node.source ?? node);
      }
      return [env, tVoid];
    }

    // Plain named export specifier: `export { x, y as z }`
    for (const spec of node.specifiers) {
      const localName = (spec.local as estree.Identifier)?.name as string;
      const exportedName = (spec.exported as estree.Identifier)?.name as string;
      if (localName) {
        engine.exportedNames.add(exportedName || localName);
      }
    }
  }

  return [env, tVoid];
}

export function inferExportAllDeclaration(engine: InferenceEngine, node: estree.ExportAllDeclaration, env: TypeEnv): [TypeEnv, Type] {
  // export * from './other'              — re-export all named (excluding 'default')
  // export * as ns from './other'        — re-export all under namespace
  const specifier = node.source?.value as string | undefined;
  if (!specifier || !engine.importResolver) return [env, tVoid];

  const resolved = engine.importResolver(specifier);
  if (!resolved) {
    engine.addDiag(`Cannot resolve module '${specifier}'`, node.source ?? node);
    return [env, tVoid];
  }
  if (isUntypedModule(resolved)) {
    // Untyped npm module: nothing to re-export with concrete types.
    // For `export * as ns from ...` bind ns to a fresh TVar.
    const exportedAs = (node.exported as estree.Identifier | null | undefined)?.name;
    if (exportedAs) {
      engine.exportedNames.add(exportedAs);
      engine.cjsExportTypes.set(exportedAs, tAnyType);
    }
    return [env, tVoid];
  }

  const exportedAs = (node.exported as estree.Identifier | null | undefined)?.name;
  if (exportedAs) {
    // export * as ns from './other'  — bundle into a single namespace export
    const recType = exportsToRecord(resolved);
    engine.exportedNames.add(exportedAs);
    engine.cjsExportTypes.set(exportedAs, recType);
    return [env, tVoid];
  }

  for (const [name, scheme] of resolved) {
    if (name === 'default') continue;
    engine.exportedNames.add(name);
    engine.cjsExportTypes.set(name, instantiate(scheme));
  }
  return [env, tVoid];
}

/**
 * Copy the metadata that shapes calls of a binding (optional trailing
 * parameters from JS defaults, type predicates, conditional-return
 * narrowing) onto the rebuilt `default` scheme.  Without it a default import
 * asked for every argument of `(key, url, pollMs = 0) => …`.
 */
function copyCallSiteMetadata(from: Scheme | undefined, to: Scheme): void {
  if (!from) return;
  if (from.optionalParamSlots && from.optionalParamSlots.length > 0) to.optionalParamSlots = from.optionalParamSlots.slice();
  if (from.typePredicate && !to.typePredicate) to.typePredicate = from.typePredicate;
  if (from.conditionalReturn && !to.conditionalReturn) to.conditionalReturn = from.conditionalReturn;
}

export function inferExportDefaultDeclaration(engine: InferenceEngine, node: estree.ExportDefaultDeclaration, env: TypeEnv): [TypeEnv, Type] {
  if (node.declaration) {
    if (node.declaration.type === 'FunctionDeclaration' || node.declaration.type === 'ClassDeclaration') {
      const [newEnv, type] = engine.inferStatement(node.declaration, env);
      const name = node.declaration.id?.name;
      if (name) {
        engine.exportedNames.add(name);
      }
      // Bind 'default' in the env so export collection — and default imports in
      // other files (`import name from './f'`) — can find it. This also covers
      // anonymous `export default function () {}` / `export default class {}`,
      // which have no name of their own: the importer supplies the name.
      engine.exportedNames.add('default');
      const resolved = engine.subst.apply(type);
      const scheme = generalize(newEnv, resolved);
      // The rebuilt scheme must carry the call-site metadata of the
      // declaration (JS default parameters, narrowing), like a named export.
      if (name) copyCallSiteMetadata(newEnv.lookup(name), scheme);
      const envWithDefault = newEnv.extend('default', scheme);
      return [envWithDefault, type];
    }
    // export default <expression>
    if (node.declaration.type === 'Identifier') {
      engine.defaultExportName = node.declaration.name as string;
    }
    const type = engine.inferExpression(node.declaration, env);
    // Consume pendingIsCurriedResult set by curry wrapper calls (e.g. export default curry(fn))
    const pendingCurried = engine.pendingIsCurriedResult;
    engine.pendingIsCurriedResult = false;
    // Store as 'default' export
    const resolved = engine.subst.apply(type);
    const scheme = generalize(env, resolved);
    // Propagate isCurriedResult / isCurryWrapper flags
    if (pendingCurried) scheme.isCurriedResult = true;
    if (node.declaration.type === 'Identifier') {
      const identScheme = env.lookup(node.declaration.name as string);
      if (identScheme?.isCurriedResult) scheme.isCurriedResult = true;
      if (identScheme?.isCurryWrapper) scheme.isCurryWrapper = true;
      if (identScheme?.curryLeadingArgs) scheme.curryLeadingArgs = identScheme.curryLeadingArgs;
      copyCallSiteMetadata(identScheme, scheme);
    }
    const newEnv = env.extend('default', scheme);
    engine.exportedNames.add('default');
    return [newEnv, type];
  }
  return [env, tVoid];
}

// -----------------------------------------------------------------------
// Class declarations
// -----------------------------------------------------------------------

export function inferClassDeclaration(engine: InferenceEngine, node: estree.ClassDeclaration | estree.AnonymousClassDeclaration, env: TypeEnv): [TypeEnv, Type] {
  const name = node.id?.name;
  if (!name) return [env, tVar()];

  // Track that `name` is a class-style constructor (used for `new`
  // strictness diagnostics and `.constructor` provenance).  Variants of
  // a registered sum type get a more specific marker.
  engine.constructorProvenance.set(
    name,
    isVariant(name) ? 'sumtype-variant' : 'class',
  );

  const annotation = engine.annotationMap.get(name);
  const classBody: AstNode[] = node.body?.body ?? [];

  // Find the constructor MethodDefinition
  const constructorMethod = findConstructor(classBody);

  // A class is a constructor, so its annotation must be a function type
  // (`() -> Foo` or `(A, B) -> Foo`).  A bare `Foo :: Foo` is almost
  // certainly a mistake — flag it and fall through to the unannotated
  // inference path so downstream type-checking can still proceed.
  //
  // Exception: nullary variant classes of a registered sum type are
  // legitimately annotated with the parent type directly
  // (e.g. `Nothing :: Maybe a` for `Maybe :: Just a | Nothing`).
  if (annotation?.scheme && annotation.scheme.type.tag !== 'TFun' && !isVariant(name)) {
    engine.addDiag(
      `Invalid type annotation for class '${name}': a class is a constructor, ` +
      `so its annotation must be a function type like '() -> ${name}' ` +
      `(or '(A, B) -> ${name}' when the constructor takes parameters), ` +
      `got '${prettyTypeToString(annotation.scheme.type)}'`,
      node.id ?? node,
    );
    // Treat as unannotated from here on.
  } else if (annotation?.scheme) {
    const expectedType = engine.instantiateWithConstraints(annotation.scheme, node, annotation);

    // The return type of the constructor annotation is the instance type
    // (e.g. for `Just :: a -> Maybe a` the instance type is `Maybe a`).
    const instanceType = getReturnType(expectedType);

    // --- Infer constructor body ---
    if (constructorMethod) {
      const ctorEnv = env
        .extend('this', mono(instanceType))
        .extend(name, annotation.scheme);
      const ctorFuncType = engine.inferFunctionExpression(
        (constructorMethod as estree.MethodDefinition).value, ctorEnv, expectedType,
      );
      const diagsBefore = engine.diagnostics.length;
      engine.checkRigid(ctorFuncType, annotation.scheme, node);
      if (engine.diagnostics.length === diagsBefore) {
        engine.unifyWithDiagnostic(ctorFuncType, expectedType, constructorMethod);
      }
    }

    // Bind the class in env so method bodies can reference it (e.g. `new Just(...)`)
    const classEnv = env.extend(name, annotation.scheme);

    // --- Infer instance methods and getters/setters ---
    for (const member of classBody) {
      // --- Class fields: `x = 1;`, `#y = 2;`, `static z = 3;` ---
      if (member.type === 'PropertyDefinition') {
        inferClassPropertyDefinition(engine, member, classEnv, instanceType, name);
        continue;
      }
      // --- Static initialisation block: `static { ... }` ---
      if (member.type === 'StaticBlock') {
        const staticEnv = classEnv;
        for (const stmt of (member.body ?? [])) {
          engine.inferStatement(stmt, staticEnv);
        }
        continue;
      }
      if (member.type !== 'MethodDefinition') continue;
      // PrivateIdentifier method names (e.g. `#priv() { ... }`) are accepted;
      // we treat them like regular methods but skip registry lookups (they
      // are not callable from outside the class).
      if (member.key?.type !== 'Identifier' && member.key?.type !== 'PrivateIdentifier') continue;
      if (member.key.type === 'PrivateIdentifier') {
        // Private method: infer the body so completion / hover work inside
        // it; don't register publicly. Honour `// Class##name :: T`
        // annotations and stash the resolved type for `this.#name` lookups.
        const fieldName = member.key.name;
        const annKey = `${name}##${fieldName}`;
        const annotation = engine.annotationMap.get(annKey);
        const methodEnv = classEnv.extend('this', mono(instanceType));
        const inferredType = engine.inferFunctionExpression(member.value, methodEnv);
        if (annotation?.scheme) {
          const expectedType = instantiate(annotation.scheme);
          engine.unifyWithDiagnostic(inferredType, expectedType, member.key);
        }
        const resolved = engine.subst.apply(inferredType);
        engine.privateClassMembers.set(`${name}##${fieldName}`, resolved);
        engine.recordNodeType(member.key, resolved);
        engine.methodSignatures.set(
          member.key.start,
          `${name}##${fieldName} :: ${prettyTypeToString(resolved)}`,
        );
        continue;
      }

      if (member.kind === 'constructor') continue; // already handled above

      const methodName = member.key.name;

      if (member.kind === 'get') {
        inferClassGetter(engine, member, classEnv, instanceType, name, methodName);
        continue;
      }

      if (member.kind === 'set') {
        // Setter: treat as a single-arg function returning void
        const setterEnv = classEnv.extend('this', mono(instanceType));
        const setterType = engine.inferFunctionExpression(member.value, setterEnv);
        engine.recordNodeType(member.key, setterType);
        continue;
      }

      // Regular method — resolve annotation
      const methodAnn = resolveMethodAnnotation(engine, member, name, methodName);
      const isStatic = !!member.static;

      if (methodAnn?.receiver && methodAnn?.methodType && methodAnn?.scheme) {
        const { thisType: methodThisType, expectedType: expectedMethodType } = engine.coordinateInstantiate(methodAnn);

        let methodEnv = classEnv.extend('this', variantThisScheme(name, methodThisType) ?? mono(methodThisType));
        methodEnv = methodEnv.extend('__signatureThis', mono(tVoid));
        if (isVariant(name)) {
          methodEnv = methodEnv.extend('__sumtypeVariant', mono(tCon(name, [])));
        }
        engine.annotationMethodNode = member;
        const methodType = engine.inferFunctionExpression(
          member.value, methodEnv, expectedMethodType,
        );
        engine.annotationMethodNode = null;

        const diagsBefore = engine.diagnostics.length;
        engine.checkRigid(methodType, methodAnn.scheme, member);
        // Save and restore the substitution around unification so that
        // parameter types recorded during inferFunctionExpression are not
        // corrupted.  e.g. Nothing.map returns `this` (Maybe a) but the
        // annotation expects Maybe b — unification would bind a=b, turning
        // the parameter type `a -> b` into `b -> b`.
        const savedSubst = new Substitution(engine.subst.entries());
        if (engine.diagnostics.length === diagsBefore) {
          engine.unifyWithDiagnostic(methodType, expectedMethodType, member);
        }
        engine.subst = savedSubst;
        engine.recordNodeType(member.key, methodType);

        // Re-record parameter nodeTypes using uncorrupted annotation types.
        // Body inference may have corrupted the TVars created by coordinateInstantiate
        // (e.g. `of` with type `f` gets unified to `Either e a -> f (Either e b)`
        // when the body calls `of(this)`).  The annotation is the source of truth.
        // We call coordinateInstantiate again to get a second set of fresh TVars
        // that are not in the current substitution.
        const fnNode = member.value;
        if (fnNode && fnNode.params) {
          const { expectedType: displayMethodType } = engine.coordinateInstantiate(methodAnn);
          const decomposed = decomposeFunParams(displayMethodType, fnNode.params.length);
          if (decomposed) {
            for (let i = 0; i < fnNode.params.length && i < decomposed.paramTypes.length; i++) {
              const param = fnNode.params[i] as AstNode;
              if (param.type === 'Identifier') {
                engine.recordNodeType(param, decomposed.paramTypes[i]);
              }
            }
          }
        }

        // Register annotation at method key offset so hover can find it
        engine.annotationByOffset.set(member.key.start, methodAnn);
      } else if (isStatic && methodAnn?.scheme) {
        // Static method with annotation (no ~> receiver).
        // Infer the body normally but DON'T re-register the method — the
        // annotation-based registration from registerStaticMethod is used
        // at call sites (which creates fresh TVars, preventing bleeding).
        const methodEnv = classEnv;
        const inferredType = engine.inferFunctionExpression(member.value, methodEnv);
        const methodType = inferredType.tag === 'TFun' ? inferredType : tFun(tVoid, inferredType);
        engine.recordNodeType(member.key, methodType);
        engine.annotationByOffset.set(member.key.start, methodAnn);
        engine.methodSignatures.set(
          member.key.start,
          `${name}.${methodName} :: ${methodAnn.raw}`,
        );

        // Register constraint info for body parameter TVars so that hover
        // and autocomplete work on constraint-typed parameters.
        if (methodAnn.scheme.constraints) {
          engine.registerStaticMethodConstraints(methodAnn.scheme, methodType);
        }
      } else {
        inferUnannotatedClassMethod(engine, member, classEnv, instanceType, name, methodName, isStatic);
      }
    }

    const newEnv = env.extend(name, annotation.scheme);
    const displayType = instantiate(annotation.scheme);
    engine.recordNodeType(node.id!, displayType);
    return [newEnv, engine.subst.apply(expectedType)];
  }

  // --- No annotation: infer constructor from body ---
  let constructorType: Type;
  if (constructorMethod) {
    constructorType = engine.inferFunctionExpression((constructorMethod as estree.MethodDefinition).value, env);
  } else {
    constructorType = tVar();
  }

  // Walk class fields and static blocks even without an annotation so that
  // their initialisers are type-checked and recorded.
  for (const member of classBody) {
    if (member.type === 'PropertyDefinition' && (member as estree.PropertyDefinition).value) {
      try {
        engine.inferExpression((member as estree.PropertyDefinition).value!, env);
      } catch (e) { debugLog('modules.classFieldInit', e); }
    } else if (member.type === 'StaticBlock') {
      for (const stmt of (member.body ?? [])) {
        try { engine.inferStatement(stmt, env); } catch (e) { debugLog('modules.staticBlock', e); }
      }
    }
  }

  const resolved = engine.subst.apply(constructorType);
  const scheme = generalize(env, resolved);
  const newEnv = env.extend(name, scheme);
  engine.recordNodeType(node.id!, resolved);
  return [newEnv, constructorType];
}

// -----------------------------------------------------------------------
// inferClassDeclaration helpers
// -----------------------------------------------------------------------

/**
 * Infer a class field declaration: `x = 1;`, `#priv = 2;`, `static z = 3;`.
 * The initialiser is type-checked in the class environment.  Instance fields
 * are recorded as constructor properties so hover and dotted access work.
 * Static fields are registered on the class registry.
 */
function inferClassPropertyDefinition(
  engine: InferenceEngine,
  member: estree.PropertyDefinition,
  classEnv: TypeEnv,
  instanceType: Type,
  className: string,
): void {
  const isStatic = !!member.static;
  const isPrivate = member.key?.type === 'PrivateIdentifier';
  const fieldName = (member.key as estree.Identifier | estree.PrivateIdentifier)?.name;

  // Infer the initialiser.  Instance fields run with `this` bound to the
  // instance type so `this.other` references work; static fields run in the
  // class env directly.
  let valueType: Type = tVar();
  if (member.value) {
    const initEnv = isStatic ? classEnv : classEnv.extend('this', mono(instanceType));
    valueType = engine.inferExpression(member.value, initEnv);
  }

  if (!fieldName) return;
  engine.recordNodeType(member.key, valueType);

  // Look for an explicit annotation: `// ClassName#field :: T` for instance
  // fields, `// ClassName.field :: T` for static fields, and
  // `// ClassName##field :: T` for private fields (only visible inside the
  // class body — JS only allows `obj.#field` from within the class).
  const annKey = isPrivate
    ? `${className}##${fieldName}`
    : isStatic ? `${className}.${fieldName}` : `${className}#${fieldName}`;
  const annotation = engine.annotationMap.get(annKey);
  if (annotation?.scheme) {
    const expected = instantiate(annotation.scheme);
    if (member.value) engine.unifyWithDiagnostic(valueType, expected, member);
    valueType = expected;
  }

  if (isPrivate) {
    // Record the private member on the engine so `this.#field` lookups in
    // the member's own class can return the inferred / annotated type.
    const resolved = engine.subst.apply(valueType);
    engine.privateClassMembers.set(`${className}##${fieldName}`, resolved);
    engine.methodSignatures.set(
      member.key.start,
      `${className}##${fieldName} :: ${prettyTypeToString(resolved)}`,
    );
  } else if (isStatic) {
    // Register as a static property on the class so `ClassName.field` works.
    const resolved = engine.subst.apply(valueType);
    registerMethod(className, fieldName, {
      signature: `${className}.${fieldName} :: ${prettyTypeToString(resolved)}`,
      factory: (_typeArgs: Type[]) => resolved,
      isStatic: true,
    });
    engine.methodSignatures.set(
      member.key.start,
      `${className}.${fieldName} :: ${prettyTypeToString(resolved)}`,
    );
  } else {
    // Mark as an instance property assigned in the (implicit) constructor.
    engine.constructorProperties.add(`${className}#${fieldName}`);
    const resolved = engine.subst.apply(valueType);
    engine.methodSignatures.set(
      member.key.start,
      `${className}#${fieldName} :: ${prettyTypeToString(instanceType)} ~> ${prettyTypeToString(resolved)}`,
    );
  }
}

/** Infer a getter as a property (not a method). */
function inferClassGetter(
  engine: InferenceEngine, member: estree.MethodDefinition, classEnv: TypeEnv,
  instanceType: Type, className: string, methodName: string,
): void {
  // Remove annotation at offset so inferFunctionExpression doesn't try to
  // unify the getter body (a function) with the annotation's property type.
  const savedAnn = engine.annotationByOffset.get(member.value?.start ?? member.start);
  if (savedAnn) {
    engine.annotationByOffset.delete(member.value?.start ?? member.start);
  }

  const getterEnv = classEnv.extend('this', mono(instanceType));
  const getterType = engine.inferFunctionExpression(member.value, getterEnv);
  const returnType = getReturnType(getterType);

  // Validate return type against annotation
  let getterAnn = savedAnn;
  if (!getterAnn) {
    getterAnn = engine.annotationMap.get(`${className}#${methodName}`);
    if (!getterAnn) {
      const parentName = getParentTypeName(className);
      if (parentName) {
        getterAnn = engine.annotationMap.get(`${parentName}#${methodName}`);
      }
    }
  }
  if (getterAnn?.methodNameMismatch && getterAnn.name) {
    engine.addDiag(
      methodNameMismatchMessage(methodName, getterAnn.name),
      member.key,
      [{ message: `Annotation '${getterAnn.name}' defined here`, start: getterAnn.commentStart, end: getterAnn.commentEnd }],
    );
  } else if (getterAnn?.receiver && getterAnn?.methodType && getterAnn?.scheme) {
    const { expectedType: expectedMethodType } = engine.coordinateInstantiate(getterAnn);
    engine.unifyWithDiagnostic(returnType, expectedMethodType, member.key);
  }

  const resolvedReturn = engine.subst.apply(returnType);
  engine.recordNodeType(member.key, resolvedReturn);

  // Register getter as a property in the method registry
  const resolvedInstance = engine.subst.apply(instanceType);
  registerMethod(className, methodName, {
    signature: `${className}#${methodName} :: ${prettyTypeToString(resolvedInstance)} ~> ${prettyTypeToString(resolvedReturn)}`,
    factory: (_typeArgs: Type[]) => resolvedReturn,
  });
  const parentName = getParentTypeName(className);
  if (parentName) {
    registerMethod(parentName, methodName, {
      signature: `${parentName}#${methodName} :: ${prettyTypeToString(resolvedInstance)} ~> ${prettyTypeToString(resolvedReturn)}`,
      factory: (_typeArgs: Type[]) => resolvedReturn,
    });
  }
  engine.methodSignatures.set(
    member.key.start,
    `${className}#${methodName} :: ${prettyTypeToString(resolvedInstance)} ~> ${prettyTypeToString(resolvedReturn)}`,
  );

  if (savedAnn) {
    engine.annotationByOffset.set(member.key.start, savedAnn);
  }
}

/** Look up the method annotation for a class member, checking ClassName#method,
 *  offset-based lookup, sumtype parent type, and static annotations. */
function resolveMethodAnnotation(
  engine: InferenceEngine, member: estree.MethodDefinition, className: string, methodName: string,
): import('../commentParser').TypeAnnotation | undefined {
  let methodAnn = engine.annotationMap.get(`${className}#${methodName}`);
  if (!methodAnn) {
    const offsetAnn = engine.annotationByOffset.get(member.value?.start ?? member.start);
    if (offsetAnn?.receiver) {
      if (offsetAnn.methodNameMismatch) {
        engine.addDiag(
          methodNameMismatchMessage(methodName, offsetAnn.name ?? ''),
          member.key,
          [{ message: `Annotation '${offsetAnn.name}' defined here`, start: offsetAnn.commentStart, end: offsetAnn.commentEnd }],
        );
      } else {
        const annName = offsetAnn.name;
        if (annName && annName.includes('#')) {
          if (annName.split('#')[1] === methodName) methodAnn = offsetAnn;
        } else {
          methodAnn = offsetAnn;
        }
      }
    }
  }

  if (!methodAnn) {
    const parentName = getParentTypeName(className);
    if (parentName) {
      const parentAnn = engine.annotationMap.get(`${parentName}#${methodName}`);
      if (parentAnn?.receiver && parentAnn?.methodType && parentAnn?.scheme && !parentAnn.methodNameMismatch) {
        methodAnn = parentAnn;
      }
    }
  }

  const isStatic = !!member.static;
  if (!methodAnn && isStatic) {
    const staticAnn = engine.annotationMap.get(`${className}.${methodName}`);
    if (staticAnn?.scheme && !staticAnn.methodNameMismatch) {
      methodAnn = staticAnn;
    }
  }

  return methodAnn;
}

/** Infer an unannotated class method (no type annotation). */
function inferUnannotatedClassMethod(
  engine: InferenceEngine, member: estree.MethodDefinition, classEnv: TypeEnv,
  instanceType: Type, className: string, methodName: string, isStatic: boolean,
): void {
  let methodEnv = isStatic
    ? classEnv
    : classEnv.extend('this', mono(instanceType));
  if (!isStatic && isVariant(className)) {
    methodEnv = methodEnv.extend('__sumtypeVariant', mono(tCon(className, [])));
  }
  const inferredType = engine.inferFunctionExpression(member.value, methodEnv);
  const methodType = inferredType.tag === 'TFun' ? inferredType : tFun(tVoid, inferredType);
  engine.recordNodeType(member.key, methodType);

  const resolvedMethod = engine.subst.apply(methodType);
  if (isStatic) {
    registerMethod(className, methodName, {
      signature: `${className}.${methodName} :: ${prettyTypeToString(resolvedMethod)}`,
      factory: (_typeArgs: Type[]) => resolvedMethod,
      isStatic: true,
    });
    engine.methodSignatures.set(
      member.key.start,
      `${className}.${methodName} :: ${prettyTypeToString(resolvedMethod)}`,
    );
  } else {
    const resolvedInstance = engine.subst.apply(instanceType);
    engine.methodSignatures.set(
      member.key.start,
      `${className}#${methodName} :: ${prettyTypeToString(resolvedInstance)} ~> ${prettyTypeToString(resolvedMethod)}`,
    );
  }
}
