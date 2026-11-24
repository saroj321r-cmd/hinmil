// ============================================================================
// Statement-level and declaration inference
// Extracted from InferenceEngine – each method takes `engine` as first arg.
//
// Plain language: *statements* are the sentences of a program — `const x =
// …`, `if (…) { … }`, `return …`, `for (…)`, class declarations.  This file
// walks them one by one: declarations add names to the environment (the
// "phone book"), `if`/`else` branches are checked with narrowed types, and
// `return` statements collect the function's result type.
// ============================================================================

import type { InferenceEngine } from './index';

import {
  Type,
  tVar,
  tCon,
  tVoid,
  tBool,
  tString,
  tTuple,
  tUnion,
  tRecord,
  tAnyType,
  mono,
  AstNode,
  isTuple,
  T_ARRAY,
  T_STRING,
  parseKvName,
  kvName,
} from '../hm/types';
import { TypeEnv, instantiate} from '../hm/env';
import { unify, UnificationError } from '../hm/unify';
import { debugLog } from '../debugLog';
import { computeNarrowedEnvs, blockHasThisAssignment, hasSelfNewGuard, isRequireCall, resolveRequire, keyPresentAfter, leavesBlock } from './narrowing';
import { exportsToRecord} from './helpers';
import { isVariant } from '../registries/dataTypeRegistry';
import { isUntypedModule } from './types';
import { isLocalAnnotation } from '../commentParser';
import type * as estree from '../estree';

// Re-exports: these families moved to sibling modules; existing importers
// (src/infer/index.ts) keep importing them from './statements'.
export { inferNamedBinding, inferFunctionDeclaration } from './stmt-bindings';
export { inferObjectDestructuring, inferDestructuringPattern } from './stmt-destructure';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/**
 * Detect the constructor-flavour of a `const Name = <init>` binding so that
 * `.constructor` access and `new` strictness diagnostics can be applied.
 *
 * Records:
 *  - `'arrow-factory'` for `(...) => ({...})` or `(...) => { return {...}; }`
 *    — at runtime these return `Object`, NOT a `Name` instance.
 *  - `'function-this'` for `function(){ this.x = ... }` style ctors.
 *  - `'class'` for class expressions.
 *  - `'sumtype-variant'` overrides the above when the binding is a registered
 *    sum-type variant (e.g. `const Just = value => Object.create(...)`).
 */
function detectConstructorProvenance(
  engine: InferenceEngine,
  name: string,
  init: AstNode,
): void {
  if (isVariant(name)) {
    engine.constructorProvenance.set(name, 'sumtype-variant');
    return;
  }
  if (init.type === 'ClassExpression') {
    engine.constructorProvenance.set(name, 'class');
    return;
  }
  if (init.type === 'ArrowFunctionExpression') {
    const body = (init as estree.ArrowFunctionExpression).body;
    // `(...) => ({...})` — expression body wrapped in parens.
    if (body.type === 'ObjectExpression') {
      if (!objectExpressionHasOwnConstructor(body as estree.ObjectExpression)) {
        engine.constructorProvenance.set(name, 'arrow-factory');
      }
      return;
    }
    // `(...) => { return {...}; }` — single-statement block returning object.
    if (body.type === 'BlockStatement') {
      const stmts = (body as estree.BlockStatement).body;
      if (stmts.length === 1
          && stmts[0].type === 'ReturnStatement'
          && (stmts[0] as estree.ReturnStatement).argument?.type === 'ObjectExpression') {
        const obj = (stmts[0] as estree.ReturnStatement).argument as estree.ObjectExpression;
        if (!objectExpressionHasOwnConstructor(obj)) {
          engine.constructorProvenance.set(name, 'arrow-factory');
        }
        return;
      }
    }
    return;
  }
  if (init.type === 'FunctionExpression') {
    const fn = init as estree.FunctionExpression;
    if (fn.body?.type === 'BlockStatement' && blockHasThisAssignment(fn.body)
        && !hasSelfNewGuard(fn.body as AstNode, name)) {
      engine.constructorProvenance.set(name, 'function-this');
    }
  }
}

function objectExpressionHasOwnConstructor(obj: estree.ObjectExpression): boolean {
  return obj.properties.some(p =>
    p.type === 'Property'
    && p.key?.type === 'Identifier'
    && (p.key as estree.Identifier).name === 'constructor',
  );
}

// -----------------------------------------------------------------------
// Program & Statement level
// -----------------------------------------------------------------------

/**
 * Pre-bind `function` declarations in a statement list: JavaScript hoists
 * them to the top of their scope, so closures defined textually earlier may
 * reference them (e.g. trampoline code where `const onResolve = s => go(s)`
 * precedes `function go(acc) { … onResolve … }`). Annotated declarations use
 * their annotation; unannotated ones get a fresh type variable that the
 * later declaration unifies with.
 */
export function hoistFunctionDeclarations(engine: InferenceEngine, body: AstNode[], env: TypeEnv): TypeEnv {
  let currentEnv = env;
  for (const stmt of body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id?.name) {
      const name = stmt.id.name as string;
      if (currentEnv.lookup(name)) continue;
      const annotation = engine.lookupAnnotation(name, stmt.start);
      currentEnv = currentEnv.extend(name, annotation?.scheme ?? mono(tVar()));
    }
  }
  return currentEnv;
}

/**
 * Reconcile forward-referenced top-level bindings declared by `stmt`: the
 * placeholder that earlier closures used is unified with a FRESH
 * instantiation of the declared scheme, so the uses flow into the real type
 * while later uses keep the binding's full polymorphism.
 *
 * Lenient on conflict, like self-recursion (`selfRecTv` in stmt-bindings.ts):
 * the use-site type of an UNANNOTATED forward reference is a guess (computed
 * access `fallbacks[method]` on an unknown receiver infers an Array), so a
 * mismatch here is not evidence of a bug.  Annotated bindings are hoisted
 * with their annotation and checked normally.
 */
function reconcileForwardDecls(
  engine: InferenceEngine,
  stmt: AstNode,
  env: TypeEnv,
  forwardDecls: Map<string, Type>,
): void {
  const decl = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt;
  if (decl.type !== 'VariableDeclaration') return;
  for (const d of decl.declarations) {
    if (d.id?.type !== 'Identifier') continue;
    const name = d.id.name as string;
    const placeholder = forwardDecls.get(name);
    if (!placeholder) continue;
    forwardDecls.delete(name);
    const declared = env.lookup(name);
    if (!declared) continue;
    const used = engine.subst.apply(placeholder);
    // Never referenced before its declaration: nothing to reconcile.
    if (used.tag === 'TVar' && placeholder.tag === 'TVar' && used.id === placeholder.id) continue;
    try {
      engine.subst = engine.subst.compose(unify(used, instantiate(declared)));
    } catch (e) {
      if (!(e instanceof UnificationError)) throw e;
      debugLog('statements.forwardDeclReconcile', e);
    }
  }
}

export function inferProgramWithEnv(engine: InferenceEngine, program: estree.Program, env: TypeEnv): [TypeEnv, Type] {
  let currentEnv = env;
  let lastType: Type = tVoid;
  const forwardDecls = new Map<string, Type>();

  // Hoist function declarations: JavaScript hoists `function` declarations
  // to the top of their scope, so they should be available before their
  // textual position. Pre-extend the environment with annotated types or
  // fresh type variables.
  for (const stmt of program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration :
                 stmt.type === 'ExportDefaultDeclaration' && stmt.declaration ? stmt.declaration :
                 stmt;
    if (decl.type === 'FunctionDeclaration' && decl.id?.name) {
      const name = decl.id.name as string;
      const annotation = engine.lookupAnnotation(name, decl.start);
      if (annotation?.scheme) {
        currentEnv = currentEnv.extend(name, annotation.scheme);
      } else {
        const tv = tVar();
        currentEnv = currentEnv.extend(name, mono(tv));
      }
    }
    // Also hoist top-level `const`/`let`/`var` bindings so that closures
    // defined earlier in the file (e.g. `Param.of = function() { return
    // Path(...) }`) can reference names declared textually later.  Annotated
    // bindings are hoisted with their annotation (checked normally);
    // unannotated `const`/`let` get a placeholder reconciled after the
    // declaration (see reconcileForwardDecls).
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id?.type === 'Identifier') {
          const name = d.id.name as string;
          if (currentEnv.lookup(name)) continue;
          const annotation = engine.lookupAnnotation(name, d.start);
          if (annotation?.scheme) {
            currentEnv = currentEnv.extend(name, annotation.scheme);
          } else if ((decl.kind === 'const' || decl.kind === 'let') && d.init) {
            // Unannotated top-level `const`/`let`: a closure defined
            // textually EARLIER may reference it (FP-library Free: `const fallback
            // = … => fallbacks[method] …` above `const fallbacks = { … }`) —
            // valid JS, the closure runs later.  Bind a placeholder that is
            // reconciled with the declared type right after the declaration.
            const tv = tVar();
            forwardDecls.set(name, tv);
            currentEnv = currentEnv.extend(name, mono(tv));
          }
        }
      }
    }
  }

  for (const stmt of program.body) {
    const [newEnv, type] = engine.inferStatement(stmt, currentEnv);
    currentEnv = newEnv;
    lastType = type;
    if (forwardDecls.size > 0) reconcileForwardDecls(engine, stmt, currentEnv, forwardDecls);
  }

  return [currentEnv, lastType];
}

/** True when a branch statement's value IS a returned value: the statement
 * (or the last statement of its block) is a `return` with an argument. */
function endsInReturn(node: AstNode): boolean {
  if (node.type === 'ReturnStatement') return !!node.argument;
  if (node.type === 'BlockStatement') {
    const body = node.body ?? [];
    const last = body[body.length - 1];
    return !!last && endsInReturn(last);
  }
  return false;
}

export function inferStatement(engine: InferenceEngine, node: AstNode, env: TypeEnv): [TypeEnv, Type] {
  switch (node.type) {
    case 'VariableDeclaration':
      return engine.inferVariableDeclaration(node, env);

    case 'ExpressionStatement':
      return [env, engine.inferExpression(node.expression, env)];

    case 'ReturnStatement':
      if (node.argument) {
        const t = engine.inferExpression(node.argument, env);
        // Record the type of THIS return (re-expressed under a local kind
        // equality when one is in force); the block's return collection
        // reads it back instead of guessing from source offsets.
        const recorded = engine.localKindEqs.length > 0 ? liftUnderLocalKindEqs(engine, t) : t;
        engine.returnTypeOverrides.set(node, recorded);
        return [env, recorded];
      }
      return [env, tVoid];

    case 'FunctionDeclaration':
      return engine.inferFunctionDeclaration(node, env);

    case 'BlockStatement': {
      let currentEnv = hoistFunctionDeclarations(engine, node.body, env);
      let lastType: Type = tVoid;
      for (const stmt of node.body) {
        const [newEnv, type] = engine.inferStatement(stmt, currentEnv);
        currentEnv = newEnv;
        lastType = type;
        // `if (!m.has (k)) m.set (k, …);` / `… return;`: `k` is in `m` now.
        const present = keyPresentAfter(stmt);
        if (present) currentEnv = currentEnv.extend(present, mono(tBool));
        // A guard clause (`if (a == null || b == null) continue;`, `… return`,
        // `break`, `throw`): the rest of the block runs only when the test was
        // false — the else-side narrowing, as after a guard in a function body.
        else if (stmt.type === 'IfStatement' && !stmt.alternate && leavesBlock(stmt.consequent as AstNode)) {
          currentEnv = computeNarrowedEnvs(engine.subst, stmt.test as AstNode, currentEnv, engine.annotationMap).altEnv;
        }
      }
      return [env, lastType]; // block doesn't leak bindings in let/const
    }

    case 'IfStatement': {
      engine.inferExpression(node.test, env);

      // Compute narrowed environments for consequent and alternate branches
      const narrowed = computeNarrowedEnvs(engine.subst, node.test, env, engine.annotationMap);
      const { altEnv } = narrowed;
      // A `::narrow C` guard on a value of abstract type `f a` proves `f ≡ C`
      // inside the true branch only (see `localKindEqs`).
      const local = localKindEqsForGuard(engine, node.test, env, narrowed.consEnv);
      const consEnv = local.env;

      // Save substitution state before branches so that side-effects
      // from one branch (e.g. res("foemp") constraining a TVar to String)
      // don't leak into the other branch (e.g. making e.leader = String).
      const substSnapshot = engine.subst.snapshot();

      engine.localKindEqs.push(...local.eqs);
      let consType: Type;
      try {
        [, consType] = engine.inferStatement(node.consequent, consEnv);
      } finally {
        engine.localKindEqs.length -= local.eqs.length;
      }

      if (node.alternate) {
        // Capture bindings added by the consequent branch
        const consBindings = engine.subst.diff(substSnapshot);
        // Restore pre-branch state for the alternate
        engine.subst.restore(substSnapshot);
        const [, altType] = engine.inferStatement(node.alternate, altEnv);
        const altBindings = engine.subst.diff(substSnapshot);
        // Merge: re-apply bindings from both branches.
        // For TVars bound in both branches to different concrete types,
        // create a union.  Otherwise just restore the binding.
        engine.subst.mergeBranches(consBindings, altBindings);
        // Only unify the branch "values" when both branches actually END in
        // a `return` — then the types feed the function's return type and a
        // mismatch is meaningful.  For ordinary statement branches (e.g.
        // `if (flag) { x = s; } else { notify (ok); }`) the trailing
        // expression value is discarded in JS, so unifying them produces
        // spurious errors (FP-library chainRec: 'Step b a' vs '()').
        if (endsInReturn(node.consequent) && endsInReturn(node.alternate)) {
          engine.unifyWithDiagnostic(consType, altType, node);
        }
      }
      return [env, consType];
    }

    case 'ImportDeclaration':
      return [engine.inferImportDeclaration(node, env), tVoid];

    case 'ExportNamedDeclaration':
      return engine.inferExportNamedDeclaration(node, env);

    case 'ExportDefaultDeclaration':
      return engine.inferExportDefaultDeclaration(node, env);

    case 'ExportAllDeclaration':
      return engine.inferExportAllDeclaration(node, env);

    case 'ClassDeclaration':
      return engine.inferClassDeclaration(node, env);

    case 'WhileStatement':
      return engine.inferWhileStatement(node, env);

    case 'DoWhileStatement':
      return engine.inferDoWhileStatement(node, env);

    case 'ForStatement':
      return engine.inferForStatement(node, env);

    case 'ForInStatement':
      return engine.inferForInStatement(node, env);

    case 'ForOfStatement':
      return engine.inferForOfStatement(node, env);

    case 'SwitchStatement':
      return engine.inferSwitchStatement(node, env);

    case 'TryStatement':
      return engine.inferTryStatement(node, env);

    case 'ThrowStatement': {
      if (node.argument) {
        engine.inferExpression(node.argument, env);
      }
      return [env, tVoid];
    }

    case 'LabeledStatement':
      return engine.inferStatement(node.body, env);

    case 'BreakStatement':
    case 'ContinueStatement':
    case 'DebuggerStatement':
    case 'EmptyStatement':
      return [env, tVoid];

    default:
      return [env, tVoid];
  }
}

// -----------------------------------------------------------------------
// Declarations
// -----------------------------------------------------------------------

export function inferVariableDeclaration(engine: InferenceEngine, node: estree.VariableDeclaration, env: TypeEnv): [TypeEnv, Type] {
  let currentEnv = env;
  let lastType: Type = tVoid;

  for (const decl of node.declarations) {
    // Handle destructured require: const { Box, Pair } = require('./demo')
    if (decl.id?.type === 'ObjectPattern' && isRequireCall(decl.init)) {
      const resolved = resolveRequire(engine.importResolver, decl.init! as estree.CallExpression);
      if (isUntypedModule(resolved)) {
        // Untyped npm module — bind every local name to opaque `Any`
        // (does not propagate via unification, unlike a fresh tvar).
        for (const prop of decl.id.properties ?? []) {
          if (prop.type === 'Property' && prop.value?.type === 'Identifier') {
            const localName = prop.value.name as string;
            const scheme = mono(tAnyType);
            currentEnv = currentEnv.extend(localName, scheme);
            engine.recordNodeType(prop.value, instantiate(scheme));
          }
        }
        continue;
      }
      if (resolved) {
        const specifier = (decl.init as estree.CallExpression)?.arguments?.[0]?.type === 'Literal'
          ? ((decl.init as estree.CallExpression).arguments[0] as estree.Literal).value as string | undefined
          : undefined;
        for (const prop of decl.id.properties ?? []) {
          if (prop.type === 'Property' && prop.key?.type === 'Identifier' && prop.value?.type === 'Identifier') {
            const importedName = prop.key.name as string;
            const localName = prop.value.name as string;
            const scheme = resolved.get(importedName);
            if (scheme) {
              currentEnv = currentEnv.extend(localName, scheme);
              engine.recordNodeType(prop.value, instantiate(scheme));
              engine.propagateCurryFlags(scheme, localName, prop.value.start);
            } else if (specifier) {
              engine.addDiag(`'${importedName}' is not exported from '${specifier}'`, prop.key);
            }
          }
        }
        continue;
      }
    }

    // Handle plain require: const demo = require('./demo')
    if (decl.id?.type === 'Identifier' && isRequireCall(decl.init)) {
      const resolved = resolveRequire(engine.importResolver, decl.init! as estree.CallExpression);
      if (isUntypedModule(resolved)) {
        const name = decl.id.name as string;
        const scheme = mono(tAnyType);
        currentEnv = currentEnv.extend(name, scheme);
        engine.recordNodeType(decl, instantiate(scheme));
        lastType = instantiate(scheme);
        continue;
      }
      if (resolved) {
        const name = decl.id.name as string;
        // CommonJS `module.exports = X` pattern: the resolved exports map
        // contains a `default` entry whose type IS the module's runtime
        // value.  A plain require should bind to that value directly
        // (e.g. `const nil = require('./nil')` where nil.js does
        // `module.exports = nil` makes `nil` callable), not to a
        // synthetic `{ default, nil }` record.
        const defaultScheme = resolved.get('default');
        if (defaultScheme) {
          currentEnv = currentEnv.extend(name, defaultScheme);
          const t = instantiate(defaultScheme);
          engine.recordNodeType(decl, t);
          engine.propagateCurryFlags(defaultScheme, name, (decl.id as estree.Identifier).start);
          // Mirror the ES `import X from '...'` default-import path: remember
          // the source specifier so a later `const { A, B } = X` destructure
          // can resolve the module's static-member exports (e.g. `List.Cons`)
          // instead of falling back to a fresh type variable.
          const specifier = (decl.init as estree.CallExpression)?.arguments?.[0]?.type === 'Literal'
            ? ((decl.init as estree.CallExpression).arguments[0] as estree.Literal).value as string | undefined
            : undefined;
          if (specifier) engine.defaultImportSources.set(name, specifier);
          lastType = t;
          continue;
        }
        const recType = exportsToRecord(resolved);
        currentEnv = currentEnv.extend(name, mono(recType));
        engine.recordNodeType(decl, recType);
        lastType = recType;
        continue;
      }
    }

    // Handle general object destructuring: const { Right } = Either
    if (decl.id?.type === 'ObjectPattern' && decl.init) {
      const result = engine.inferObjectDestructuring(decl, currentEnv, node.kind);
      currentEnv = result.env;
      lastType = result.lastType;
      continue;
    }

    // Handle array destructuring: const [first, ...rest] = arr;
    if (decl.id?.type === 'ArrayPattern' && decl.init) {
      const initType = engine.inferExpression(decl.init, currentEnv);
      const resolved = engine.subst.apply(initType);
      const { env: newEnv } = engine.inferDestructuringPattern(decl.id, initType, currentEnv, node.kind);
      currentEnv = newEnv;
      lastType = resolved.tag === 'TCon' && resolved.name === T_ARRAY && resolved.args.length === 1
        ? resolved.args[0]
        : initType;
      continue;
    }

    const name = decl.id.type === 'Identifier' ? decl.id.name : undefined;
    if (!name) continue;

    if (decl.init) {
      // Provenance detection for `.constructor` typing & `new` strictness.
      detectConstructorProvenance(engine, name, decl.init);
      const named = engine.inferNamedBinding(name, decl, currentEnv, node.kind, node.start);
      const { displayType } = named;
      let { scheme } = named;
      // `const k = "id"` holds exactly that text: keep it on its `String`.
      if (node.kind === 'const' && decl.init.type === 'Literal' && typeof (decl.init as estree.Literal).value === 'string'
          && scheme.vars.length === 0) {
        const bound = engine.subst.apply(scheme.type);
        if (bound.tag === 'TCon' && bound.name === 'String' && bound.args.length === 0) {
          scheme = { ...scheme, type: { ...bound, stringLiteral: String((decl.init as estree.Literal).value) } };
        }
      }
      currentEnv = currentEnv.extend(name, scheme);
      engine.recordNodeType(decl, displayType);
      // Remember the generalized scheme of a polymorphic binding so hover can
      // show its generic type at the declaration site rather than a type
      // polluted by a downstream call site's specialization.
      if (scheme.vars.length > 0) {
        engine.declaredSchemes.set(decl.start, scheme);
      }
      lastType = displayType;
      // Propagate built-in `.constructor` marker by variable name so
      // `const ac = [].constructor; ac(1, 2)` can specialise at the
      // call site (e.g. widen Array(args) to [union]).
      if (decl.init.type === 'MemberExpression' && !decl.init.computed
          && (decl.init.property as estree.Identifier)?.name === 'constructor') {
        const kind = engine.builtinCtorKind.get((decl.init.property as AstNode).start);
        if (kind) engine.builtinCtorByVarName.set(name, kind);
      }
    } else {
      // No initializer: check for annotation (scope-checked via nodeStart)
      let annotation = engine.annotationMap.get(name);
      // Drop non-local annotations: a sidecar / globals / `::types` entry
      // for `name` must not silently type a user's bare `let name;`
      // declaration as if it were the file's own annotated binding.
      if (annotation && !isLocalAnnotation(annotation)) annotation = undefined;
      if (annotation && annotation.nodeStart !== undefined
          && (annotation.nodeStart < node.start || annotation.nodeStart > decl.end)) {
        annotation = undefined;
      }
      if (annotation?.scheme) {
        const annotatedType = instantiate(annotation.scheme);
        currentEnv = currentEnv.extend(name, annotation.scheme);
        engine.recordNodeType(decl, annotatedType);
        lastType = annotatedType;
      } else {
        const tv = tVar();
        currentEnv = currentEnv.extend(name, mono(tv));
        engine.recordNodeType(decl, tv);
        lastType = tv;
      }
    }
  }

  return [currentEnv, lastType];
}

// -----------------------------------------------------------------------
// Loop statements
// -----------------------------------------------------------------------

export function inferWhileStatement(engine: InferenceEngine, node: estree.WhileStatement, env: TypeEnv): [TypeEnv, Type] {
  engine.inferExpression(node.test, env);
  engine.inferStatement(node.body, env);
  return [env, tVoid];
}

export function inferDoWhileStatement(engine: InferenceEngine, node: estree.DoWhileStatement, env: TypeEnv): [TypeEnv, Type] {
  engine.inferStatement(node.body, env);
  engine.inferExpression(node.test, env);
  return [env, tVoid];
}

export function inferForStatement(engine: InferenceEngine, node: estree.ForStatement, env: TypeEnv): [TypeEnv, Type] {
  let loopEnv = env;
  // init: may be a VariableDeclaration or ExpressionStatement
  if (node.init) {
    if (node.init.type === 'VariableDeclaration') {
      const [newEnv] = engine.inferVariableDeclaration(node.init, env);
      loopEnv = newEnv;
    } else {
      engine.inferExpression(node.init, env);
    }
  }
  if (node.test) {
    engine.inferExpression(node.test, loopEnv);
  }
  if (node.update) {
    engine.inferExpression(node.update, loopEnv);
  }
  engine.inferStatement(node.body, loopEnv);
  return [env, tVoid];
}

export function inferForInStatement(engine: InferenceEngine, node: estree.ForInStatement, env: TypeEnv): [TypeEnv, Type] {
  let loopEnv = env;
  if (node.left.type === 'VariableDeclaration') {
    // for (const key in obj) — key is always String
    const decl = (node.left as estree.VariableDeclaration).declarations?.[0];
    if (decl?.id?.type === 'Identifier') {
      loopEnv = env.extend(decl.id.name, mono(tString));
      engine.recordNodeType(decl.id, tString);
    }
  }
  if (node.right) {
    engine.inferExpression(node.right, loopEnv);
  }
  engine.inferStatement(node.body, loopEnv);
  return [env, tVoid];
}

export function inferForOfStatement(engine: InferenceEngine, node: estree.ForOfStatement, env: TypeEnv): [TypeEnv, Type] {
  let loopEnv = env;
  if (node.right) {
    const iterableType = engine.inferExpression(node.right, env);
    let resolved = engine.subst.apply(iterableType);

    // For `for await (... of ...)`, unwrap Promise e (Array T) or Promise e T
    if (node.await && resolved.tag === 'TCon' && resolved.name === 'Promise' && resolved.args.length === 2) {
      resolved = resolved.args[1];
    }

    // If iterating over an Array, the loop variable gets the element type
    let elemType: Type = tVar();
    if (resolved.tag === 'TCon' && (resolved.name === T_ARRAY || resolved.name === 'Set') && resolved.args.length > 0) {
      elemType = resolved.args[0];
    } else if (resolved.tag === 'TCon' && resolved.name === 'Map' && resolved.args.length > 0) {
      // for-of on Map<k, v> → [k, v] (tuple)
      const k = resolved.args[0] ?? tVar();
      const v = resolved.args[1] ?? tVar();
      elemType = tTuple([k, v]);
    } else if (resolved.tag === 'TCon' && resolved.name === T_STRING) {
      elemType = tString;
    } else if (isTuple(resolved) && resolved.args.length > 0) {
      elemType = resolved.args.length === 1 ? resolved.args[0] : tUnion(resolved.args);
    }
    // For `for await ... of`, unwrap any per-element Promise so the loop
    // variable receives the resolved value type (matches JS semantics: each
    // iteration awaits the yielded value).
    if (node.await && elemType.tag === 'TCon' && elemType.name === 'Promise' && elemType.args.length === 2) {
      elemType = elemType.args[1];
    }
    if (node.left.type === 'VariableDeclaration') {
      const decl = (node.left as estree.VariableDeclaration).declarations?.[0];
      if (decl?.id?.type === 'Identifier') {
        loopEnv = env.extend(decl.id.name, mono(elemType));
        engine.recordNodeType(decl.id, elemType);
      } else if (decl?.id?.type === 'ObjectPattern' || decl?.id?.type === 'ArrayPattern') {
        const { env: newEnv } = engine.inferDestructuringPattern(decl.id, elemType, env, 'const');
        loopEnv = newEnv;
      }
    }
  }
  engine.inferStatement(node.body, loopEnv);
  return [env, tVoid];
}

// -----------------------------------------------------------------------
// Switch statement
// -----------------------------------------------------------------------

export function inferSwitchStatement(engine: InferenceEngine, node: estree.SwitchStatement, env: TypeEnv): [TypeEnv, Type] {
  const discriminant = engine.inferExpression(node.discriminant, env);
  let resultType: Type = tVoid;

  for (const switchCase of (node.cases ?? [])) {
    if (switchCase.test) {
      const testType = engine.inferExpression(switchCase.test, env);
      engine.unifyWithDiagnostic(testType, discriminant, switchCase.test);
    }
    // Infer the statements in each case
    let caseEnv = env;
    for (const stmt of (switchCase.consequent ?? [])) {
      const [newEnv, stmtType] = engine.inferStatement(stmt, caseEnv);
      caseEnv = newEnv;
      resultType = stmtType;
    }
  }

  return [env, resultType];
}

// -----------------------------------------------------------------------
// Try/catch/finally statement
// -----------------------------------------------------------------------

export function inferTryStatement(engine: InferenceEngine, node: estree.TryStatement, env: TypeEnv): [TypeEnv, Type] {
  let resultType: Type = tVoid;

  // Infer the try block
  if (node.block) {
    const [, tryType] = engine.inferStatement(node.block, env);
    resultType = tryType;
  }

  // Infer the catch clause
  if (node.handler) {
    let catchEnv = env;
    const param = node.handler.param;
    if (param) {
      if (param.type === 'Identifier') {
        // Catch parameter: type as the same `Error` constructor the builtin
        // error constructors produce (`new Error(...) :: Error`), so the
        // binding unifies with annotation slots declared as `Error` (e.g.
        // an FP library's `try :: (() -> a) -> RTask r Error a` calling `rej (e)`).
        // Member access `e.message` / `e.name` / `e.stack` resolves through
        // the builtin Error property support, same as constructed errors.
        const errorType = tCon('Error');
        catchEnv = catchEnv.extend(param.name, mono(errorType));
        engine.recordNodeType(param, errorType);
      }
    }
    // Optional catch binding: catch { } — no param
    if (node.handler.body) {
      engine.inferStatement(node.handler.body, catchEnv);
    }
  }

  // Infer the finally block
  if (node.finalizer) {
    engine.inferStatement(node.finalizer, env);
  }

  return [env, resultType];
}


// ---------------------------------------------------------------------------
// Local kind equalities under a `::narrow` guard
// ---------------------------------------------------------------------------

/**
 * For `if (isArray (xs))` with `isArray` carrying `::narrow Array` and
 * `xs :: f a` (an abstract, constraint-bound constructor), the true branch
 * may treat `xs` as `[a]` — its OWN element type, not a fresh one — and
 * knows `f ≡ Array` there.  Returns the branch env (with `xs :: Array a`)
 * and the equalities to push while inferring the branch.  A no-op unless the
 * guard narrows an argument from a kind-variable application to a concrete
 * constructor of the same arity.
 */
function localKindEqsForGuard(
  engine: InferenceEngine,
  test: AstNode,
  env: TypeEnv,
  consEnv: TypeEnv,
): { env: TypeEnv; eqs: InferenceEngine['localKindEqs'] } {
  const eqs: InferenceEngine['localKindEqs'] = [];
  if (consEnv === env || test.type !== 'CallExpression') return { env: consEnv, eqs };
  let outEnv = consEnv;
  for (const arg of (test.arguments ?? []) as AstNode[]) {
    if (arg.type !== 'Identifier') continue;
    const name = arg.name as string;
    const before = env.lookup(name);
    const after = consEnv.lookup(name);
    if (!before || !after || before === after) continue;
    const orig = engine.subst.apply(before.type);
    const narrowedT = engine.subst.apply(after.type);
    if (orig.tag !== 'TCon' || orig.args.length === 0) continue;
    const kv = parseKvName(orig.name);
    if (!kv) continue;
    if (narrowedT.tag !== 'TCon' || parseKvName(narrowedT.name) || narrowedT.args.length !== orig.args.length) continue;
    eqs.push({ varId: kv.varId, varName: kv.varName, con: narrowedT.name, arity: orig.args.length });
    outEnv = outEnv.extend(name, { vars: [], type: tCon(narrowedT.name, orig.args) });
  }
  return { env: outEnv, eqs };
}

/** Re-express a branch result `C x…` as `f x…` under a local `f ≡ C`. */
function liftUnderLocalKindEqs(engine: InferenceEngine, t: Type): Type {
  const r = engine.subst.apply(t);
  if (r.tag !== 'TCon' || parseKvName(r.name)) return t;
  for (let i = engine.localKindEqs.length - 1; i >= 0; i--) {
    const eq = engine.localKindEqs[i];
    if (eq.con === r.name && eq.arity === r.args.length) {
      // Resolve the kv through the substitution: if `f` has meanwhile been
      // bound to a concrete constructor, there is nothing abstract to lift.
      const head = engine.subst.apply({ tag: 'TVar', id: eq.varId, name: eq.varName });
      if (head.tag !== 'TVar') return t;
      return tCon(kvName(eq.varName, head.id), r.args);
    }
  }
  return t;
}
