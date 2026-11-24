// ============================================================================
// Destructuring-pattern inference: object/array patterns, computed-key
// (label-polymorphic) destructures (extracted from statements.ts)
//
// Plain language: *destructuring* unpacks a value into several names at
// once: `const { name, age } = person` or `const [first, ...rest] = list`.
// This file gives each unpacked name its correct piece of the whole — `name`
// gets the type of person's name field, `rest` gets "the remaining list".
// ============================================================================

import type { InferenceEngine } from './index';

import {
  Type,
  Scheme,
  tVar,
  tVoid,
  tArray,
  tCon,
  tRecord,
  tOpenRecord,
  tLabelVar,
  tRow,
  TVar,
  TRow,
  TLabelVar,
  tAnyType,
  isAnyType,
  mono,
  monoFrozen,
  AstNode,
  prettyTypeToString,
  T_ARRAY,
  T_TUPLE,
  T_SPREAD_ARRAY,
  isSpread,
} from '../hm/types';
import { TypeEnv, instantiate, generalize } from '../hm/env';
import { computeRestType} from './helpers';
import { isUntypedModule } from './types';
import type * as estree from '../estree';

/**
 * Infer a top-level object-pattern declarator: `const { a, b: c, ...rest } = init`.
 *
 * Handles:
 * - Rest elements (`...rest`)
 * - Simple identifier bindings (`{ a }`, `{ a: b }`) — generalized for `const`
 * - Default-value bindings (`{ x = 5 }`)
 * - Nested destructuring patterns (delegates to `inferDestructuringPattern`)
 * - Module-export static-member lookup when destructuring a default import
 *
 * Returns the updated environment and the type of the last processed binding.
 */
export function inferObjectDestructuring(
  engine: InferenceEngine,
  decl: estree.VariableDeclarator,
  env: TypeEnv,
  kind: string,
): { env: TypeEnv; lastType: Type } {
  const objPat = decl.id as estree.ObjectPattern;
  let currentEnv = env;
  let lastType: Type = tVoid;

  const initType = engine.inferExpression(decl.init!, currentEnv);
  let resolved = engine.subst.apply(initType);

  // Union with a TRecord member (e.g. `Table | (a -> b) | { props :: … }`):
  // pick the record branch for destructuring so its fields drive the
  // pattern. Other branches (function overloads, TCon metadata) carry no
  // structural fields and are silently skipped at the destructuring site.
  if (resolved.tag === 'TCon' && resolved.name === 'Union') {
    const recordBranch = resolved.args.find(a => a.tag === 'TRecord');
    if (recordBranch) resolved = recordBranch;
  }

  // If destructuring from a default-imported binding, resolve the
  // source module's named exports so we can look up property types
  // that are static members (e.g. `const { fromPromise } = RTask`).
  let moduleExports: Map<string, Scheme> | null = null;
  if (decl.init?.type === 'Identifier' && engine.importResolver) {
    const specifier = engine.defaultImportSources.get(decl.init.name as string);
    if (specifier) {
      const r = engine.importResolver(specifier);
      moduleExports = isUntypedModule(r) ? null : r;
    }
  }

  // ── Computed-key destructure path ────────────────────────────────────────
  // Handles patterns like `const { [k]: value, ...rest } = obj` where `[k]`
  // is a label-polymorphic key. This drives label-polymorphism inference:
  // the source object is constrained to `{ [k] :: a, ...r }` and the
  // destructured value is bound to `a`.
  const hasComputedKey = (objPat.properties ?? []).some(
    p => p.type === 'Property' && (p as estree.Property).computed === true
        && p.key?.type === 'Identifier',
  );
  if (hasComputedKey) {
    const result = inferComputedKeyDestructure(
      engine, objPat, decl.init!, resolved, currentEnv, kind,
    );
    return result;
  }

  for (const prop of objPat.properties ?? []) {
    if (prop.type === 'RestElement') {
      // Rest element: const { a, ...rest } = obj
      const restIdent = prop.argument;
      if (restIdent?.type === 'Identifier') {
        const restType = computeRestType(resolved, objPat.properties ?? []);
        currentEnv = currentEnv.extend(restIdent.name, mono(restType));
        engine.recordNodeType(restIdent, restType);
        lastType = restType;
      }
    } else if (prop.type === 'Property' && prop.key?.type === 'Identifier') {
      const keyName = prop.key.name as string;
      const value = prop.value;

      // Determine the field type from the source object
      let fieldType: Type | null = null;
      if (resolved.tag === 'TRecord' && resolved.fields[keyName]) {
        fieldType = resolved.fields[keyName];
      } else if (moduleExports && moduleExports.has(keyName)) {
        // Static member from a default-imported module
        const scheme = moduleExports.get(keyName)!;
        fieldType = instantiate(scheme);
        currentEnv = currentEnv.extend(
          value?.type === 'Identifier' ? value.name : keyName,
          scheme,
        );
        if (value) engine.recordNodeType(value, fieldType);
        lastType = fieldType;
        continue;
      } else if (
        resolved.tag === 'TCon' && resolved.name === 'TypeRep' && resolved.args.length === 1
        && decl.init?.type === 'Identifier' && value?.type === 'Identifier'
      ) {
        // Statics of a type representative (`const { of, lift } = StateEither`,
        // FP-library transformer specs): type each key exactly like the member
        // access `StateEither.of` (static lookup bound to the witness), and
        // generalize so `of` stays usable at several element types.
        const member = {
          type: 'MemberExpression', object: decl.init, property: prop.key,
          computed: false, optional: false, start: prop.key.start, end: prop.key.end,
        } as unknown as estree.MemberExpression;
        const staticType = engine.subst.apply(engine.inferExpression(member, currentEnv));
        const localName = value.name as string;
        currentEnv = currentEnv.extend(
          localName,
          kind === 'const' ? generalize(currentEnv, staticType) : mono(staticType),
        );
        engine.recordNodeType(value, staticType);
        lastType = staticType;
        continue;
      } else if (resolved.tag === 'TRecord' && value?.type !== 'AssignmentPattern') {
        // Unknown destructured key on a known record — emit diagnostic
        // (subject to the `unknownPropertyAccess` config setting).
        // Skip when a default value is supplied (`const { x = 0 } = obj`).
        engine.addDiag(
          `Property '${keyName}' does not exist on type '${prettyTypeToString(resolved)}'`,
          prop.key,
        );
      }
      if (!fieldType) {
        // When destructuring from a completely opaque source (a bare TVar
        // — typical when an imported value's type is `c` and we read a
        // property off it, e.g. `const { Organisation } = tables.organisation`
        // when `tables :: c`), binding each local to a fresh TVar pins
        // its type at the first use site (the first `Organisation([...])`
        // call), causing all subsequent calls with differently-shaped
        // arguments to fail.  Bind to `Any` instead so each use site is
        // checked flexibly without locking the type.
        fieldType = resolved.tag === 'TVar' ? tAnyType : tVar();
      }

      if (value?.type === 'Identifier') {
        // Simple: const { a } = obj  or  const { a: b } = obj
        const localName = value.name as string;
        // If the local name has a top-level annotation in scope, prefer
        // it over the field type inferred from the source — but ONLY
        // when the field type is opaque (a fresh TVar or `Any`).  When
        // the source record provides a concrete field type (TRecord,
        // TCon, Union, etc.), that type is more specific than any
        // top-level annotation that might happen to share the local
        // name (e.g. globals declaring `Organisation :: Table …` while
        // the destructured `tables.organisation.Organisation` field is
        // a richer Union containing a `{ props :: … }` arm).  Letting
        // the global annotation win would silently strip the extra arms.
        let bindType = fieldType;
        const ann = engine.annotationMap.get(localName);
        const fieldOpaque = fieldType.tag === 'TVar'
          || (fieldType.tag === 'TCon' && fieldType.name === 'Any');
        if (ann?.scheme && fieldOpaque) {
          const annType = engine.instantiateWithConstraints(ann.scheme, decl, ann);
          engine.unifyWithDiagnostic(fieldType, annType, value);
          bindType = annType;
        }
        const scheme = (ann?.scheme && fieldOpaque)
          ? ann.scheme
          : (kind === 'const' ? generalize(currentEnv, bindType) : mono(bindType));
        currentEnv = currentEnv.extend(localName, scheme);
        engine.recordNodeType(value, bindType);
        lastType = bindType;
      } else if (value?.type === 'AssignmentPattern') {
        // Default value: const { x = 5 } = obj
        const ident = value.left;
        if (ident?.type === 'Identifier') {
          const defaultType = engine.inferExpression(value.right, currentEnv);
          engine.unifyWithDiagnostic(fieldType, defaultType, value.right);
          const resolvedField = engine.subst.apply(fieldType);
          currentEnv = currentEnv.extend(ident.name, mono(resolvedField));
          engine.recordNodeType(ident, resolvedField);
          lastType = resolvedField;
        }
      } else if (value?.type === 'ObjectPattern' || value?.type === 'ArrayPattern') {
        // Nested destructuring: const { a: { b } } = obj  or  const { a: [b] } = obj
        engine.recordNodeType(value, fieldType);
        const nestedResult = engine.inferDestructuringPattern(value, fieldType, currentEnv, kind);
        currentEnv = nestedResult.env;
        lastType = fieldType;
      }
    }
  }

  return { env: currentEnv, lastType };
}

/**
 * Handle ObjectPattern destructuring containing one or more computed-key
 * properties (`{ [k]: value, ...rest }`).  This is the row-polymorphic
 * destructure path: each computed key gets a fresh label variable that's
 * unified with the key identifier's type, the source object is constrained
 * to a row-poly record `{ [k] :: a, ...r }`, and the destructured value is
 * bound to the field type `a`.
 */
function inferComputedKeyDestructure(
  engine: InferenceEngine,
  objPat: estree.ObjectPattern,
  unifyNode: AstNode,
  sourceType: Type,
  env: TypeEnv,
  kind: string,
): { env: TypeEnv; lastType: Type } {
  let currentEnv = env;
  let lastType: Type = tVoid;

  type LabelEntry = {
    label: TLabelVar;
    type: Type;
    valueNode: AstNode | null;
    bindName: string | null;
  };

  const labelEntries: LabelEntry[] = [];
  const staticFieldTypes: Record<string, Type> = {};
  let restIdent: estree.Identifier | null = null;

  for (const prop of objPat.properties ?? []) {
    if (prop.type === 'RestElement') {
      if (prop.argument?.type === 'Identifier') {
        restIdent = prop.argument as estree.Identifier;
      }
      continue;
    }
    if (prop.type !== 'Property' || prop.key?.type !== 'Identifier') continue;
    const isComputed = (prop as estree.Property).computed === true;
    if (isComputed) {
      const lv = tLabelVar(prop.key.name as string);
      const ft = tVar();
      const value = prop.value;
      const bindName = value?.type === 'Identifier' ? (value.name as string) : null;
      labelEntries.push({ label: lv, type: ft, valueNode: value ?? null, bindName });
      // Constrain the key identifier's type to be the fresh label variable.
      // (For an unbound `k`, inferExpression reports the diagnostic itself.)
      const keyType = engine.inferExpression(prop.key, currentEnv);
      engine.unifyWithDiagnostic(keyType, lv, prop.key);
    } else {
      staticFieldTypes[prop.key.name as string] = tVar();
    }
  }

  // Build the expected source shape: { static-fields, [labelvars] :: types, ...row }
  const restRow = tRow();
  const expectedSource = {
    tag: 'TRecord' as const,
    fields: { ...staticFieldTypes },
    rest: restRow,
    labelFields: labelEntries.map(e => ({ label: e.label, type: e.type })),
  };
  engine.unifyWithDiagnostic(sourceType, expectedSource, unifyNode);

  // After unification, propagate substitutions into our local copies.
  for (const e of labelEntries) {
    e.type = engine.subst.apply(e.type);
  }
  for (const k in staticFieldTypes) {
    staticFieldTypes[k] = engine.subst.apply(staticFieldTypes[k]);
  }

  // Bind label-key destructured values.
  for (const e of labelEntries) {
    if (e.bindName) {
      // Use mono: these fresh vars must remain linked to the source
      // record's labelFields entry (premature generalize inside a function
      // body would quantify them and lose the link at use sites).
      currentEnv = currentEnv.extend(e.bindName, mono(e.type));
      if (e.valueNode) engine.recordNodeType(e.valueNode, e.type);
      lastType = e.type;
    }
  }

  // Bind static-key destructured values (simple Identifier targets only;
  // nested patterns / defaults inside computed-key destructure are uncommon).
  for (const prop of objPat.properties ?? []) {
    if (prop.type !== 'Property') continue;
    if ((prop as estree.Property).computed === true) continue;
    if (prop.key?.type !== 'Identifier') continue;
    const ft = staticFieldTypes[prop.key.name as string];
    const value = prop.value;
    if (value?.type === 'Identifier') {
      currentEnv = currentEnv.extend(value.name as string, mono(ft));
      engine.recordNodeType(value, ft);
      lastType = ft;
    }
  }

  // Bind `...rest` to an open record sharing the residual row variable.
  if (restIdent) {
    const restType = tOpenRecord({}, restRow);
    currentEnv = currentEnv.extend(restIdent.name as string, mono(restType));
    engine.recordNodeType(restIdent, restType);
    lastType = restType;
  }

  return { env: currentEnv, lastType };
}

/**
 * Infer bindings for a destructuring pattern applied to a given source type.
 * Handles nested ObjectPattern and ArrayPattern recursively.
 * Used for nested destructuring and destructuring assignments.
 */
export function inferDestructuringPattern(
  engine: InferenceEngine,
  pattern: AstNode,
  sourceType: Type,
  env: TypeEnv,
  kind: string,
  freezeLeaves = false,
): { env: TypeEnv } {
  let currentEnv = env;
  const resolved = engine.subst.apply(sourceType);
  // For an annotated destructured *parameter*, each leaf's declared type is the
  // annotation sub-type; freeze it so hover renders the signature form rather
  // than a body-poisoned substitution.  `bindLeaf` attaches the frozen display
  // and records it for the leaf's reference sites (via the binding scheme).
  const bindLeaf = (e: TypeEnv, name: string, t: Type, leafNode: AstNode): TypeEnv => {
    if (freezeLeaves) engine.frozenParamType.set(leafNode.start, t);
    return e.extend(name, freezeLeaves ? monoFrozen(t) : mono(t));
  };

  if (pattern.type === 'ObjectPattern') {
    // ── Computed-key destructure path (mirrors top-level handler) ─────────
    const hasComputedKey = (pattern.properties ?? []).some(
      (p: AstNode) => p.type === 'Property' && (p as estree.Property).computed === true
          && p.key?.type === 'Identifier',
    );
    if (hasComputedKey) {
      const r = inferComputedKeyDestructure(
        engine, pattern as estree.ObjectPattern, pattern, sourceType, currentEnv, kind,
      );
      return { env: r.env };
    }

    const fieldTypes: Record<string, Type> = {};
    // Locate a `...rest` element up front so we can decide whether the
    // parameter (when its source is still a TVar) needs an open record
    // with a row variable shared between source and rest binding.
    const restProp = (pattern.properties ?? []).find(p => p.type === 'RestElement');
    const restIdent = restProp && (restProp as estree.RestElement).argument?.type === 'Identifier'
      ? (restProp as estree.RestElement).argument as estree.Identifier
      : null;
    // Allocate the shared row variable lazily — only when both the source
    // is unknown (a TVar) AND a rest pattern exists.  This keeps closed
    // records closed and avoids gratuitous fresh vars on the common path.
    const useRowVar = restIdent !== null && resolved.tag === 'TVar';
    const sharedRow: TRow | null = useRowVar ? tRow() : null;

    for (const prop of (pattern.properties ?? [])) {
      if (prop.type === 'RestElement') {
        const ident = prop.argument;
        if (ident?.type === 'Identifier') {
          // When the source is unknown, `rest` shares a row variable with
          // the source so it captures any extra fields the caller passes.
          // When the source is a known record, fall back to the literal
          // leftover-fields computation.
          const restType = sharedRow
            ? tOpenRecord({}, sharedRow)
            : computeRestType(resolved, pattern.properties ?? []);
          currentEnv = bindLeaf(currentEnv, ident.name, restType, ident);
          engine.recordNodeType(ident, restType);
        }
      } else if (prop.type === 'Property' && prop.key?.type === 'Identifier') {
        const keyName = prop.key.name as string;
        let fieldType: Type = tVar();
        if (resolved.tag === 'TRecord' && resolved.fields[keyName]) {
          fieldType = resolved.fields[keyName];
        } else if (resolved.tag === 'TRecord' && prop.value?.type !== 'AssignmentPattern') {
          // Unknown destructured key on a known record — emit diagnostic
          // (subject to the `unknownPropertyAccess` config setting).
          // Skip when a default value is supplied (`{ x = 0 } = obj`).
          engine.addDiag(
            `Property '${keyName}' does not exist on type '${prettyTypeToString(resolved)}'`,
            prop.key,
          );
        }
        fieldTypes[keyName] = fieldType;

        const value = prop.value;
        if (value?.type === 'Identifier') {
          currentEnv = bindLeaf(currentEnv, value.name, fieldType, value);
          engine.recordNodeType(value, fieldType);
        } else if (value?.type === 'AssignmentPattern' && value.left?.type === 'Identifier') {
          const defaultType = engine.inferExpression(value.right, currentEnv);
          engine.unifyWithDiagnostic(fieldType, defaultType, value.right);
          const resolvedField = engine.subst.apply(fieldType);
          currentEnv = bindLeaf(currentEnv, value.left.name, resolvedField, value.left);
          engine.recordNodeType(value.left, resolvedField);
        } else if (value?.type === 'ObjectPattern' || value?.type === 'ArrayPattern') {
          // Record the nested pattern's type so completion/hover can resolve it.
          engine.recordNodeType(value, fieldType);
          const nestedResult = engine.inferDestructuringPattern(value, fieldType, currentEnv, kind, freezeLeaves);
          currentEnv = nestedResult.env;
        }
      }
    }
    // When the source is a TVar (e.g. function parameter), build a TRecord
    // and unify so destructured bindings get connected to the caller's arg.
    // With a `...rest`, the record is open (row-polymorphic) and shares a
    // row variable with the rest binding, so callers may pass extra fields
    // and they will flow into `rest`'s type at the callsite.
    if (resolved.tag === 'TVar' && Object.keys(fieldTypes).length > 0) {
      // Destructured-with-default fields are optional at the call site
      // (e.g. `({ name = 'World' }) => …` accepts `f({})`).  When any
      // property carries an AssignmentPattern default, make the inferred
      // parameter record open so callers can omit the defaulted fields.
      const hasDefault = (pattern.properties ?? []).some(
        p => p.type === 'Property' && p.value?.type === 'AssignmentPattern',
      );
      const openForDefaults = hasDefault && !sharedRow;
      const paramShape = sharedRow
        ? tOpenRecord(fieldTypes, sharedRow)
        : openForDefaults
          ? tOpenRecord(fieldTypes, tVar() as TVar)
          : tRecord(fieldTypes);
      engine.unifyWithDiagnostic(sourceType, paramShape, pattern);
    }
  } else if (pattern.type === 'ArrayPattern') {
    let elemType: Type = tVar();
    if (resolved.tag === 'TCon' && resolved.name === T_ARRAY && resolved.args.length === 1) {
      elemType = resolved.args[0];
    }
    // An untyped source (`const [params, setParams] = useSearchParams ()`
    // from a library without types): every element is `Any` on its own.
    // A shared fresh variable tied the elements together, so using one as
    // a Map made the other "not callable".
    if (isAnyType(resolved)) elemType = tAnyType;

    // Tuple-like sources from annotations: [a, b, c, ..., d] (SpreadArray)
    // or fixed (a, b, c) tuples carry positional element types that should
    // flow into the destructured bindings rather than collapsing to a single
    // shared element type.
    let beforeArr: Type[] = [];
    let afterArr: Type[] = [];
    let hasSpread = false;
    // An unknown source (an unannotated callback parameter, e.g. the
    // `[action, state]` pair an operator passes) destructures positionally:
    // each element its own type.  Unified with a fixed tuple below; a real
    // list passed later still fits (a tuple flows into `[e]` when every
    // element is an `e`, see unify).  The positional form is `[a, b]`
    // (SpreadArray), not the parameter tuple: that would mean two arguments.
    const patternElements = pattern.elements ?? [];
    const tvarSource = resolved.tag === 'TVar'
      && !patternElements.some(e => e?.type === 'RestElement')
      && patternElements.filter(e => e).length >= 2;
    const isPositionalSrc =
      tvarSource ||
      (resolved.tag === 'TCon' &&
      (resolved.name === T_SPREAD_ARRAY || resolved.name === T_TUPLE));
    if (isPositionalSrc && !tvarSource) {
      const args = (resolved as import('../hm/types').TCon).args;
      const spreadIdx = args.findIndex(isSpread);
      if (spreadIdx >= 0) {
        hasSpread = true;
        beforeArr = args.slice(0, spreadIdx);
        afterArr = args.slice(spreadIdx + 1);
      } else {
        beforeArr = args.slice();
      }
    }

    const elements = pattern.elements ?? [];
    const restIdx = elements.findIndex(e => e?.type === 'RestElement');
    const totalPositional = restIdx >= 0 ? restIdx : elements.length;

    const tvarPositions: Type[] = [];
    const positionalTypeAt = (i: number): Type => {
      if (!isPositionalSrc) return elemType;
      if (tvarSource) {
        while (tvarPositions.length <= i) tvarPositions.push(tVar());
        return tvarPositions[i];
      }
      if (i < beforeArr.length) return beforeArr[i];
      if (!hasSpread) return tVar();
      // In spread region: try to align trailing elements with afterArr
      const idxFromEnd = totalPositional - 1 - i;
      if (idxFromEnd >= 0 && idxFromEnd < afterArr.length) {
        return afterArr[afterArr.length - 1 - idxFromEnd];
      }
      return tVar();
    };

    for (let i = 0; i < elements.length; i++) {
      const elem = elements[i];
      if (!elem) continue;

      if (elem.type === 'RestElement' && elem.argument?.type === 'Identifier') {
        const restElem = isPositionalSrc ? tVar() : elemType;
        const arrayType = tArray(restElem);
        currentEnv = bindLeaf(currentEnv, elem.argument.name, arrayType, elem.argument);
        engine.recordNodeType(elem.argument, arrayType);
      } else if (elem.type === 'Identifier') {
        const t = positionalTypeAt(i);
        currentEnv = bindLeaf(currentEnv, elem.name, t, elem);
        engine.recordNodeType(elem, t);
      } else if (elem.type === 'AssignmentPattern' && elem.left?.type === 'Identifier') {
        const t = positionalTypeAt(i);
        const defaultType = engine.inferExpression(elem.right, currentEnv);
        engine.unifyWithDiagnostic(t, defaultType, elem.right);
        const resolvedElem = engine.subst.apply(t);
        currentEnv = bindLeaf(currentEnv, elem.left.name, resolvedElem, elem.left);
        engine.recordNodeType(elem.left, resolvedElem);
      } else if (elem.type === 'ObjectPattern' || elem.type === 'ArrayPattern') {
        const t = positionalTypeAt(i);
        engine.recordNodeType(elem, t);
        const nestedResult = engine.inferDestructuringPattern(elem, t, currentEnv, kind, freezeLeaves);
        currentEnv = nestedResult.env;
      }
    }
    // When the source is a TVar: the positional tuple (two or more
    // positions, no rest), otherwise a list of one element type.
    if (tvarSource) {
      for (let i = 0; i < totalPositional; i++) positionalTypeAt(i);
      engine.unifyWithDiagnostic(sourceType, tCon(T_SPREAD_ARRAY, tvarPositions), pattern);
    } else if (resolved.tag === 'TVar') {
      engine.unifyWithDiagnostic(sourceType, tArray(elemType), pattern);
    }
  }

  return { env: currentEnv };
}

