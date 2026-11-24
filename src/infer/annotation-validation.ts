// ============================================================================
// Annotation validation — sumtype variant fields, variant method
// implementations, annotation type/arity checking, unknown constructors
// (split from annotations.ts; verbatim moves)
//
// Plain language: before annotations are trusted, they are proof-read.  This
// file checks that annotations only mention type names that exist, apply
// each type to the right number of arguments, and that sum type variants and
// their method implementations line up with their declarations.  Mistakes
// become diagnostics pointing at the annotation itself.
// ============================================================================

import {
  Type,
  TVar,
  TCon,
  tCon,
  tFun,
  typeToString,
  collectVarNames,
  getReturnType,
  findUnknownTCons,
  isWildcard,
  isAnyType,
  T_UNION,
  T_TYPEREP,
  T_MERGE,
  T_FUNCTION,
  functionParamList,
  isTuple,
  parseKvName,
  kvName,
} from '../hm/types';
import {
  TypeAnnotation,
  extractConstraintDirectives,
  extractImportedNames,
  extractDataDirectives,
} from '../commentParser';
import {
  getRegisteredTypeNames,
  getTypeArity,
  isBuiltinType,
} from '../registries/methodRegistry';
import {
  parseConstraintDirective,
  getConstraintNames,
  lookupConstraint,
  getEffectiveMethods,
} from '../registries/constraintRegistry';
import {
  getParentTypeName,
  isVariant,
  isDataType,
  getDataTypeNames,
  getDataType,
} from '../registries/dataTypeRegistry';
import { eachType} from '../hm/typeUtils';
import { parseTypeSignature, parseMethodTypeSignature} from '../hm/typeParser';
import { extractPrototypeMethod } from '../commentParser';
import type * as estree from '../estree';
import { parseStrict } from '../parsing';


// ---------------------------------------------------------------------------
// Context interface for methods that need engine state
import { activeDomAnnotationTypeNames } from '../registries/domGlobals';
import {
  BUILTIN_TYPE_NAMES,
  BUILTIN_TYPE_ARITIES,
  isMethodAnnotationName,
  annotationTypeParts,
  collectFreeVarNames,
  expandAliases,
  type AnnotationContext,
} from './annotations';

/**
 * Validate the field types written directly in the `|` shorthand of a sumtype
 * declaration.  Each bare uppercase field must be a known type (built-in,
 * alias, data type, local constructor, or imported / `::types`-loaded), and
 * arity-bearing built-ins such as `Object`/`Function` cannot appear bare
 * because the shorthand has no way to supply their mandatory type arguments.
 *
 * Runs SEPARATELY from `processDataDirectives` (which registers the sumtype
 * early) so it can execute AFTER `::types` directives and imports have been
 * resolved — otherwise imported field types would be reported as unknown.
 * Parenthesized (`(Object String a)`) and record (`{ x :: T }`) fields are
 * skipped here: their inner types are validated through the variant's explicit
 * constructor annotation via `validateAnnotationTypes`.
 */
export function validateDataVariantFields(
  ctx: AnnotationContext,
  source: string,
): void {
  const directives = extractDataDirectives(source);
  if (directives.length === 0) return;
  const knownTypes = buildKnownTypeNames(ctx.annotationMap, ctx.typeAliases, source);

  for (const decl of directives) {
    const commentText = source.slice(decl.commentStart, decl.commentEnd);
    const bodyStart = commentText.indexOf('::');
    const bodyOffset = bodyStart >= 0 ? bodyStart : 0;

    let fieldSearch = bodyOffset;
    for (const variant of decl.variants) {
      // Advance the cursor past the variant name so field positions are local.
      const nameAt = commentText.indexOf(variant.name, fieldSearch);
      if (nameAt >= 0) fieldSearch = nameAt + variant.name.length;
      for (const field of variant.fields) {
        const fieldAt = commentText.indexOf(field, fieldSearch);
        const fieldLoc = fieldAt >= 0
          ? { start: decl.commentStart + fieldAt, end: decl.commentStart + fieldAt + field.length }
          : { start: decl.commentStart, end: decl.commentEnd };
        if (fieldAt >= 0) fieldSearch = fieldAt + field.length;

        if (!/^[A-Z]/.test(field)) continue; // type variable or paren/record field — fine

        const reqArity = BUILTIN_TYPE_ARITIES.get(field);
        if (reqArity !== undefined) {
          ctx.addDiag(
            `Type '${field}' requires ${reqArity} type argument${reqArity === 1 ? '' : 's'}; the '|' shorthand can't express them. Declare '${variant.name}' with an explicit constructor annotation (e.g. // ${variant.name} :: … ${field} k a … -> ${decl.name}).`,
            fieldLoc,
          );
          continue;
        }
        if (field === decl.name) continue; // recursive self-reference
        if (!knownTypes.has(field)) {
          ctx.addDiag(
            `Unknown type '${field}' in variant '${variant.name}'. Import it or declare it (e.g. add an import or a '// ${field} :: …' definition).`,
            fieldLoc,
          );
          continue;
        }
        // Known type used bare in the shorthand.  If it carries type
        // parameters (e.g. an imported `Body :: * -> *`), the space-separated
        // shorthand can't supply them — a bare `Body` is parsed as one field
        // and the following word as a *separate* field, which silently changes
        // the variant's arity.  Flag it the same way the annotation context
        // rejects `Future Any Response a`; the fix is to parenthesize, e.g.
        // `(Body a)`.
        const knownDecl = getDataType(field);
        const knownArity = knownDecl ? knownDecl.decl.typeVars.length : 0;
        if (knownArity > 0) {
          const sampleArgs = Array.from(
            { length: knownArity },
            (_, i) => String.fromCharCode(97 + i),
          ).join(' ');
          ctx.addDiag(
            `Type '${field}' requires ${knownArity} type argument${knownArity === 1 ? '' : 's'}; a bare '${field}' in the '|' shorthand is read as a field on its own. Wrap it in parentheses, e.g. (${field} ${sampleArgs}).`,
            fieldLoc,
          );
        }
      }
    }
  }
}

export function validateVariantMethodAnnotations(
  annotationMap: Map<string, TypeAnnotation>,
  addDiag: (message: string, loc: { start: number; end: number }) => void,
): void {
  for (const [name, ann] of annotationMap) {
    if (!name.includes('#')) continue;
    const [typeName, methodName] = name.split('#');
    if (!typeName || !methodName) continue;

    const parentName = getParentTypeName(typeName);
    if (parentName) {
      addDiag(
        `'${typeName}' is a variant of '${parentName}'. Use '${parentName}#${methodName}' instead of '${typeName}#${methodName}'.`,
        annotationNameLoc(ann),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Missing variant method implementation detection
// ---------------------------------------------------------------------------

/**
 * Collect all method implementations from the AST.
 * Returns a Set of `"ClassName:methodName"` strings.
 */
function collectImplementedMethods(source: string): Set<string> {
  const implemented = new Set<string>();

  let ast: estree.Program;
  try {
    ast = parseStrict(source);
  } catch {
    return implemented;
  }

  for (const stmt of ast.body) {
    // Unwrap export wrappers
    const decl = (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration')
      && (stmt as estree.ExportNamedDeclaration | estree.ExportDefaultDeclaration).declaration
      ? (stmt as estree.ExportNamedDeclaration | estree.ExportDefaultDeclaration).declaration!
      : stmt;

    // Class declarations: class Left { isLeft() { ... } }
    if (decl.type === 'ClassDeclaration' && decl.id?.name) {
      const className = decl.id.name;
      for (const member of (decl.body?.body ?? [])) {
        if (member.type !== 'MethodDefinition') continue;
        if (member.key?.type !== 'Identifier') continue;
        if (member.kind === 'constructor') continue;
        implemented.add(`${className}:${member.key.name}`);
      }
    }

    // Prototype assignments: Left.prototype.isLeft = function() { ... }
    if (decl.type === 'ExpressionStatement'
        && decl.expression?.type === 'AssignmentExpression'
        && decl.expression.left?.type === 'MemberExpression') {
      const proto = extractPrototypeMethod(decl.expression.left as estree.MemberExpression);
      if (proto) {
        implemented.add(`${proto.typeName}:${proto.methodName}`);
      }

      // Object literal on prototype: Left.prototype = { isLeft: function() { ... } }
      const left = decl.expression.left;
      if (!left.computed
          && left.object?.type === 'Identifier'
          && left.property?.type === 'Identifier'
          && left.property.name === 'prototype'
          && decl.expression.right?.type === 'ObjectExpression') {
        const className = left.object.name;
        for (const prop of decl.expression.right.properties) {
          if (prop.type === 'Property' && prop.key?.type === 'Identifier') {
            implemented.add(`${className}:${(prop.key as estree.Identifier).name}`);
          }
        }
      }
    }
  }

  return implemented;
}

/**
 * Detect sum type variants that are missing method implementations.
 *
 * For each parent type method annotation (e.g. `Either#isLeft :: ...`),
 * checks whether every variant of that sum type has an implementation
 * (class method or prototype assignment).  Emits an informational diagnostic
 * on the variant name in the sum type definition when missing.
 */
export function validateVariantMethodImplementations(
  annotationMap: Map<string, TypeAnnotation>,
  source: string,
  addDiag: (message: string, loc: { start: number; end: number }, relatedInformation?: { message: string; start: number; end: number }[], severity?: number) => void,
): void {
  const dataTypeNames = getDataTypeNames();
  if (dataTypeNames.size === 0) return;

  // Collect parent method annotations: Map<parentTypeName, Set<methodName>>
  // Only include annotations where the method type is a function (TFun) or
  // Boolean (getter).  Property annotations like `$value :: (e | a)` are set
  // in constructors and don't need separate variant implementations.
  const parentMethods = new Map<string, Set<string>>();
  for (const [name, ann] of annotationMap) {
    if (!name.includes('#')) continue;
    const [typeName, methodName] = name.split('#');
    if (!typeName || !methodName) continue;
    if (!dataTypeNames.has(typeName)) continue;
    if (!ann.methodType) continue;
    if (ann.methodType.tag !== 'TFun' && !(ann.methodType.tag === 'TCon' && ann.methodType.name === 'Boolean')) continue;
    const methods = parentMethods.get(typeName) ?? new Set();
    methods.add(methodName);
    parentMethods.set(typeName, methods);
  }

  if (parentMethods.size === 0) return;

  const implemented = collectImplementedMethods(source);

  for (const [parentName, methods] of parentMethods) {
    const dt = getDataType(parentName);
    if (!dt) continue;

    for (const methodName of methods) {
      // Only flag missing implementations when at least one variant has
      // implemented the method.  When no variant has an implementation,
      // the signature is likely a pure declaration (or work hasn't started).
      const variantsWithImpl = dt.decl.variants.filter(v => implemented.has(`${v.name}:${methodName}`));
      if (variantsWithImpl.length === 0) continue;

      for (const variant of dt.decl.variants) {
        if (implemented.has(`${variant.name}:${methodName}`)) continue;

        // Find the variant name position within the sumtype comment
        const commentText = source.slice(dt.decl.commentStart, dt.decl.commentEnd);
        const bodyStart = commentText.indexOf('::');
        const offset = bodyStart >= 0 ? bodyStart : 0;
        const searchText = commentText.slice(offset);
        const variantMatch = new RegExp(`\\b${variant.name}\\b`).exec(searchText);
        const variantLoc = variantMatch
          ? { start: dt.decl.commentStart + offset + variantMatch.index, end: dt.decl.commentStart + offset + variantMatch.index + variant.name.length }
          : { start: dt.decl.commentStart, end: dt.decl.commentEnd };

        const ann = annotationMap.get(`${parentName}#${methodName}`);
        const related = ann
          ? [{ message: `${parentName}#${methodName} :: ${ann.raw}`, start: ann.commentStart, end: ann.commentEnd }]
          : undefined;

        // DiagnosticSeverity.Information = 3 (blue underline)
        addDiag(
          `'${variant.name}' does not implement '${parentName}#${methodName}'`,
          variantLoc,
          related,
          3,
        );
      }
    }
  }
}

/**
/**
 * Build a map of known type constructor arities from all available sources:
 * - sumtype declarations (via dataTypeRegistry)
 * - Constructor annotations (e.g. `Pair :: (a, b) -> Pair a b` → arity 2)
 * - Method registry (Array=1, Map=2, etc.)
 * - Built-in hardcoded arities (StrMap=1)
 */
export function buildTypeArities(
  annotationMap: Map<string, TypeAnnotation>,
): Map<string, number> {
  const arities = new Map<string, number>();

  // 1. From sumtype declarations
  for (const name of getDataTypeNames()) {
    const dt = getDataType(name);
    if (dt && dt.decl.typeVars.length > 0) {
      arities.set(name, dt.decl.typeVars.length);
    }
  }

  // 2. From constructor annotations: name :: ... -> Name a b → arity = args.length
  for (const [name, ann] of annotationMap) {
    if (!ann.scheme || isMethodAnnotationName(name)) continue;
    const returnType = getReturnType(ann.scheme.type);
    if (returnType.tag === 'TCon' && returnType.name === name && returnType.args.length > 0) {
      arities.set(name, returnType.args.length);
    }
  }

  // 3. From method registry (built-in types with registered arities)
  for (const typeName of getRegisteredTypeNames()) {
    if (!arities.has(typeName)) {
      const arity = getTypeArity(typeName);
      if (arity > 0) arities.set(typeName, arity);
    }
  }

  // 4. From hardcoded built-in arities
  for (const [name, arity] of BUILTIN_TYPE_ARITIES) {
    if (!arities.has(name)) arities.set(name, arity);
  }

  return arities;
}

/**
 * Apply arity-aware HK grouping to annotations that reference type constructors
 * with known arities and have constraint variables.
 *
 * Instead of re-parsing (which would create new TVar IDs), this does a
 * structural transform on the existing type tree: when a TCon has more args
 * than its known arity and the excess args start with a constraint variable,
 * group those trailing args into a $kv:name:id TCon.
 *
 * Example: `Pair(Boolean, TVar:f, TVar:m)` with arity 2 and constraint var `f`
 * → `Pair(Boolean, $kv:f:42(TVar:m))`
 */
export function applyArityHKGrouping(
  annotationMap: Map<string, TypeAnnotation>,
  annotationByOffset: Map<number, TypeAnnotation>,
  typeArities: Map<string, number>,
): void {
  if (typeArities.size === 0) return;

  const processAnnotation = (ann: TypeAnnotation) => {
    if (!ann.scheme) return;
    const constraints = ann.scheme.constraints;
    if (!constraints || constraints.length === 0) return;

    // Build a set of constraint variable names for this annotation
    const constraintVarNames = new Set(constraints.map(c => c.typeVarName));

    // Build a map from constraint variable name → TVar id
    // collectVarNames returns Map<id, name>
    const idToName = new Map<number, string>();
    collectVarNames(ann.scheme.type, idToName);
    if (ann.receiver) collectVarNames(ann.receiver, idToName);
    if (ann.methodType) collectVarNames(ann.methodType, idToName);
    const nameToId = new Map<string, number>();
    for (const [id, name] of idToName) {
      if (constraintVarNames.has(name)) nameToId.set(name, id);
    }
    if (nameToId.size === 0) return;

    const transform = (t: Type): Type => {
      if (t.tag === 'TCon') {
        // First recursively transform args
        const newArgs = t.args.map(transform);
        const arity = typeArities.get(t.name);
        if (arity !== undefined && newArgs.length > arity) {
          // Try to group excess args starting at position `arity - 1`
          // The arg at `arity - 1` must be a TVar that is a constraint variable
          const lastNormalIdx = arity - 1;
          const candidate = newArgs[lastNormalIdx];
          if (candidate.tag === 'TVar' && candidate.name && nameToId.has(candidate.name)) {
            const hvArgs = newArgs.slice(lastNormalIdx + 1);
            const kvCon = tCon(kvName(candidate.name, candidate.id), hvArgs);
            return tCon(t.name, [...newArgs.slice(0, lastNormalIdx), kvCon]);
          }
        }
        // If args changed, return new TCon
        if (newArgs.some((a, i) => a !== t.args[i])) {
          return tCon(t.name, newArgs);
        }
        return t;
      }
      if (t.tag === 'TFun') {
        const newParam = transform(t.param);
        const newResult = transform(t.result);
        if (newParam !== t.param || newResult !== t.result) {
          return tFun(newParam, newResult);
        }
        return t;
      }
      return t;
    };

    ann.scheme = {
      ...ann.scheme,
      type: transform(ann.scheme.type),
    };
    if (ann.receiver) ann.receiver = transform(ann.receiver);
    if (ann.methodType) ann.methodType = transform(ann.methodType);
  };

  for (const [, ann] of annotationMap) {
    processAnnotation(ann);
  }
  for (const [, ann] of annotationByOffset) {
    processAnnotation(ann);
  }
}

/**
 * Validate that all type constructors referenced in annotations are known.
 * A type constructor is "known" if it is:
 *   - A built-in type (Number, String, Boolean, Array, etc.)
 *   - Registered in the method registry (via local or ::types annotations)
 *   - Defined as a constructor in the current file's annotations (e.g. `// Box :: a -> Box a`)
 */
export function validateAnnotationTypes(
  annotations: TypeAnnotation[],
  source: string,
  annotationMap: Map<string, TypeAnnotation>,
  typeAliases: Map<string, Type>,
  addDiag: (message: string, loc: { start: number; end: number }, severity?: number) => void,
): void {
  const knownTypes = buildKnownTypeNames(annotationMap, typeAliases, source);
  const constructorArities = collectConstructorArities(annotationMap, typeAliases, knownTypes);
  const aliasNames = new Set(typeAliases.keys());

  validateConstructorReturnVars(annotations, typeAliases, addDiag);
  checkUnknownTypeConstructors(annotations, annotationMap, knownTypes, addDiag);

  // Check type constructor arity
  for (const ann of annotations) {
    if (!ann.scheme) continue;
    const mapAnn = ann.name ? annotationMap.get(ann.name) : undefined;
    const useAnn = (mapAnn?.scheme) ? mapAnn : ann;
    for (const t of annotationTypeParts(useAnn)) {
      for (const { name, actual, expected } of findArityMismatches(t, constructorArities, aliasNames)) {
        addDiag(
          `Type constructor '${name}' expects ${expected} type argument${expected === 1 ? '' : 's'} but got ${actual}`,
          annotationNameLoc(ann),
        );
      }
      for (const loc of findBareTypeReps(t)) {
        addDiag(
          `'TypeRep' requires a type argument, e.g. 'TypeRep m'`,
          annotationNameLoc(ann),
        );
      }
      for (const { display } of findFunctionParamListErrors(t)) {
        addDiag(
          `The first child of 'Function' must be a parameter-list array (e.g. 'Function [a] b' or 'Function [] b'), but got '${display}'`,
          annotationNameLoc(ann),
        );
      }
    }

    // A `::narrow <InstanceType>` target may UNDER-apply a parametric
    // constructor (`::narrow Array` denotes an instance, saturated with fresh
    // vars at narrowing time), but OVER-application (`::narrow Array a a`) is an
    // error — the user should write `::narrow Array a`.
    const narrowedType = useAnn.scheme?.typePredicate?.narrowedType;
    if (narrowedType) {
      for (const { name, actual, expected } of findArityMismatches(narrowedType, constructorArities, aliasNames)) {
        if (actual > expected) {
          addDiag(
            `Type constructor '${name}' expects ${expected} type argument${expected === 1 ? '' : 's'} but got ${actual}`,
            annotationNameLoc(ann),
          );
        }
      }
    }
  }

  // Validate type-constructor arity *inside* `::constraint` definitions.
  // A bare parametric constructor that appears in a constraint body — whether
  // in a method-record signature, a structural self-clause, or misused in an
  // `extends`/super-constraint position (e.g. `{ f :: Array }`) — must carry
  // its mandatory children (`Array a`), or use a `TypeRep Array` witness.
  // This reuses the same arity diagnostic as ordinary annotation positions.
  for (const directive of extractConstraintDirectives(source)) {
    const def = parseConstraintDirective(directive.text);
    if (!def) continue;
    const cvars = def.headerParams ?? [def.typeVar];
    const reportType = (t: Type) => {
      for (const { name, actual, expected } of findArityMismatches(t, constructorArities, aliasNames)) {
        addDiag(
          `Type constructor '${name}' expects ${expected} type argument${expected === 1 ? '' : 's'} but got ${actual}`,
          directive,
        );
      }
    };
    // (a) method-record signatures (`{ map :: f a ~> (a -> b) -> f b }`)
    for (const method of def.methods) {
      try {
        if (/~>/.test(method.signature)) {
          const sig = parseMethodTypeSignature(method.signature, cvars);
          reportType(sig.receiver);
          reportType(sig.methodType);
        } else {
          reportType(parseTypeSignature(method.signature, cvars).type);
        }
      } catch {
        /* malformed signatures are surfaced by other diagnostics */
      }
    }
    // (b) structural self-clause bodies (`f :: Array String`)
    for (const sc of def.selfClauses ?? []) {
      reportType(sc.body);
    }
    // (c) `extends` names that are actually parametric type constructors
    //     misused as a structural body (`{ f :: Array }`).  A genuine
    //     super-constraint carries no type-constructor arity, so this only
    //     fires for real type constructors that demand children.
    for (const ext of def.extends ?? []) {
      if (lookupConstraint(ext)) continue;
      const dt = getDataType(ext);
      const expected = dt
        ? dt.decl.typeVars.length
        : (getTypeArity(ext) || BUILTIN_TYPE_ARITIES.get(ext) || 0);
      if (expected > 0) {
        addDiag(
          `Type constructor '${ext}' expects ${expected} type argument${expected === 1 ? '' : 's'} but got 0`,
          directive,
        );
      }
    }
  }

  // Validate applied constraints
  for (const ann of annotations) {
    if (!ann.scheme?.constraints) continue;
    for (const constraint of ann.scheme.constraints) {
      if (!constraint.isApplied) continue;
      const def = lookupConstraint(constraint.className);
      if (!def) continue;
      const methods = getEffectiveMethods(constraint.className);
      const typeArgNames = new Set<string>();
      const varPattern = new RegExp(`\\b${def.typeVar}\\s+([a-z])\\b`, 'g');
      for (const method of methods) {
        let match: RegExpExecArray | null;
        while ((match = varPattern.exec(method.signature)) !== null) {
          typeArgNames.add(match[1]);
        }
        varPattern.lastIndex = 0;
      }
      if (typeArgNames.size > 1) {
        addDiag(
          `Constraint '${constraint.className}' has methods that vary the type argument (${[...typeArgNames].map(n => `${def.typeVar} ${n}`).join(', ')}). Use '${constraint.className} ${constraint.typeVarName}' instead of '${constraint.className} (${constraint.typeVarName} ...)'`,
          annotationNameLoc(ann),
        );
      }
    }
  }

  // Validate unconstrained kind-variable usages
  for (const ann of annotations) {
    if (!ann.scheme) continue;
    const ownConstraintVars = new Set(
      (ann.scheme.constraints ?? []).map(c => c.typeVarName),
    );
    for (const t of annotationTypeParts(ann)) {
      for (const varName of findUnconstrainedKvUsages(t, ownConstraintVars)) {
        addDiag(
          `Type variable '${varName}' is used as a type constructor (${varName} ...) but has no constraint. Add a constraint like 'Functor ${varName} =>' to enable higher-kinded usage`,
          annotationNameLoc(ann),
        );
      }
    }
  }

  // Validate bare-TVar value annotations on uppercase names (e.g. `Tag :: a`).
  // Such an annotation lets the value `Tag` be used as ANY type, which is
  // unsound for a name that is also used as a type constructor.  The
  // engineering-correct form is a constructor signature like `a -> Tag a`.
  validateBareTVarValueAnnotations(annotations, annotationMap, addDiag);

  // Validate record-spread / Merge over bare type-variable parameters.  An
  // annotation like `(a, b) -> { ...a, ...b }` (or its desugaring
  // `(a, b) -> Merge a b`) spreads/merges parameters `a`/`b` that are bare
  // type variables — they are not known to be records, so the merge is
  // meaningless.  The user must declare each parameter with a record form.
  for (const ann of annotations) {
    if (!ann.scheme) continue;
    for (const branch of unionBranches(ann.scheme.type)) {
      for (const name of findBareParamMergeNames(branch)) {
        addDiag(
          `Cannot merge bare type variable '${name}' — it is not known to be a record. Declare the parameter with a record form: '{${name}}', '{[k] :: ${name}}', or '{...${name}}'.`,
          annotationNameLoc(ann),
        );
      }
    }
  }
}

/**
 * Diagnostic 4a/4b: detect uppercase value annotations whose merged scheme
 * contains a bare-TVar branch (e.g. `Tag :: a`).  Emits a warning on the
 * annotation itself, and a second warning on every `Tag#method` annotation
 * that depends on `Tag` being a real type constructor.
 *
 * Both diagnostics are suppressed when the same name also has a constructor
 * branch (`Tag :: ... -> Tag ...`), because the bare branch is then inert
 * and has already been overridden by a sound declaration.
 */
function validateBareTVarValueAnnotations(
  annotations: TypeAnnotation[],
  annotationMap: Map<string, TypeAnnotation>,
  addDiag: (message: string, loc: { start: number; end: number }, severity?: number) => void,
): void {
  // Identify uppercase value names whose scheme contains a bare-TVar branch
  // and NO constructor branch returning the same TCon.
  const offenders = new Set<string>();
  for (const [name, ann] of annotationMap) {
    if (!ann.scheme) continue;
    if (isMethodAnnotationName(name)) continue;
    if (!/^[A-Z]/.test(name)) continue;
    if (isVariant(name)) continue;
    if (isDataType(name)) continue;

    const branches = unionBranches(ann.scheme.type);
    const hasBareTVar = branches.some(b => b.tag === 'TVar');
    if (!hasBareTVar) continue;

    const hasOwnConstructor = branches.some(b => {
      const ret = getReturnType(b);
      return ret.tag === 'TCon' && ret.name === name;
    });
    if (hasOwnConstructor) continue;

    offenders.add(name);
  }

  if (offenders.size === 0) return;

  // 4a — warn on the annotation site itself.  Emit one warning per
  // annotation occurrence in the source so the user sees it on the
  // exact `Name :: a` line they wrote.
  // DiagnosticSeverity.Warning = 2.
  for (const ann of annotations) {
    if (!ann.name || !offenders.has(ann.name)) continue;
    if (!ann.scheme) continue;
    if (ann.scheme.type.tag !== 'TVar') continue;
    addDiag(
      `'${ann.name}' is annotated as an unconstrained type variable, which lets it be used as any type. Did you mean a constructor signature like 'a -> ${ann.name} a'?`,
      annotationNameLoc(ann),
      2,
    );
  }

  // 4b — warn on each `Name#method` (or `Name.method`) annotation when
  // `Name` is an offender.  Such methods presuppose that `Name` is a real
  // type constructor with values of type `Name a`, which the bare value
  // annotation defeats.
  for (const ann of annotations) {
    if (!ann.name) continue;
    const sep = ann.name.includes('#') ? '#' : (ann.name.includes('.') ? '.' : null);
    if (!sep) continue;
    const typeName = ann.name.split(sep)[0];
    if (!offenders.has(typeName)) continue;
    addDiag(
      `Method '${ann.name}' is declared on type '${typeName}', but '${typeName} :: a' annotates '${typeName}' as a plain type variable rather than a type constructor. Change the value annotation to a constructor form (e.g. 'a -> ${typeName} a') so instances of '${typeName}' have a proper type.`,
      annotationNameLoc(ann),
      2,
    );
  }
}

/** Split a type into union branches, or return [t] for non-union types. */
function unionBranches(t: Type): Type[] {
  if (t.tag === 'TCon' && t.name === T_UNION) return t.args;
  return [t];
}

/**
 * Detect `Merge` markers in a function annotation's result that reference a
 * parameter declared as a *bare* type variable (rather than a record form).
 *
 * In `(a, b) -> { ...a, ...b }` (parsed as `Merge(TRow a, TRow b)`) or its
 * desugaring `(a, b) -> Merge a b`, the parameters `a` and `b` are bare
 * `TVar`s — nothing constrains them to be records, so spreading/merging them
 * is meaningless.  By contrast `({a}, {...b}) -> { ...a, ...b }` binds `a`/`b`
 * as record row variables, which is valid.
 *
 * Returns the distinct names of the offending bare-variable parameters.
 */
function findBareParamMergeNames(fnType: Type): string[] {
  if (fnType.tag !== 'TFun') return [];

  // Walk the curried/tupled parameter spine, classifying each parameter as a
  // bare type variable or a record row variable.
  const bareParamNames = new Set<string>();
  const recordRowNames = new Set<string>();
  let cur: Type = fnType;
  while (cur.tag === 'TFun') {
    const params = isTuple(cur.param) ? cur.param.args : [cur.param];
    for (const p of params) {
      if (p.tag === 'TVar') bareParamNames.add(p.name);
      else if (p.tag === 'TRecord' && p.rest && p.rest.tag === 'TRow') {
        recordRowNames.add(p.rest.name);
      }
    }
    cur = cur.result;
  }
  if (bareParamNames.size === 0) return [];

  // Collect every Merge marker reachable in the (final) result type and check
  // its operands against the bare-parameter set.
  const offenders = new Set<string>();
  const visit = (t: Type): void => {
    if (t.tag === 'TCon') {
      if (t.name === T_MERGE) {
        for (const arg of t.args) {
          const argName =
            arg.tag === 'TVar' ? arg.name : arg.tag === 'TRow' ? arg.name : undefined;
          if (argName && bareParamNames.has(argName) && !recordRowNames.has(argName)) {
            offenders.add(argName);
          }
        }
      }
      for (const arg of t.args) visit(arg);
    } else if (t.tag === 'TFun') {
      visit(t.param);
      visit(t.result);
    } else if (t.tag === 'TRecord') {
      for (const f of Object.values(t.fields)) visit(f);
    }
  };
  visit(cur);

  return [...offenders];
}

/** Collect all known type constructor names from built-ins, registries, aliases,
 *  imports, and constructor annotations (excluding method-annotation-only types). */
function buildKnownTypeNames(
  annotationMap: Map<string, TypeAnnotation>,
  typeAliases: Map<string, Type>,
  source: string,
): Set<string> {
  const knownTypes = new Set(BUILTIN_TYPE_NAMES);
  // DOM/Fetch nominal types (Element, Event, Response, …) — valid in
  // annotations when typed globals are on; Response always (fetch API).
  for (const name of activeDomAnnotationTypeNames()) knownTypes.add(name);

  for (const name of typeAliases.keys()) {
    knownTypes.add(name);
  }

  // Uppercase names with a callable-value annotation (e.g.
  // `Tag :: a -> Wrapped a` paired with `Tag :: a`) are deliberately
  // excluded from `typeAliases` so the constructor-as-callable bridge
  // can keep `tagged :: Tag a` as a TCon at the value site.  Register
  // the bare name here so other annotations referring to `Tag a` don't
  // emit a spurious "unknown type constructor" diagnostic.
  for (const [name, ann] of annotationMap) {
    if (!ann.scheme) continue;
    if (name.includes('#') || name.includes('.')) continue;
    if (!/^[A-Z]/.test(name)) continue;
    knownTypes.add(name);
  }

  // Type names introduced by LOCAL method annotations (e.g. Either2#map → Either2)
  // should NOT auto-mark the type as known.
  const localMethodTypeNames = new Set<string>();
  for (const name of annotationMap.keys()) {
    if (name.includes('#')) localMethodTypeNames.add(name.split('#')[0]);
    if (name.includes('.')) localMethodTypeNames.add(name.split('.')[0]);
  }

  for (const name of getRegisteredTypeNames()) {
    if (!localMethodTypeNames.has(name)) {
      knownTypes.add(name);
    }
  }

  for (const cName of getConstraintNames()) {
    knownTypes.add(cName);
  }

  for (const name of getDataTypeNames()) {
    knownTypes.add(name);
    const dt = getDataType(name);
    if (dt) {
      for (const v of dt.decl.variants) {
        knownTypes.add(v.name);
      }
    }
  }

  for (const name of extractImportedNames(source)) {
    knownTypes.add(name);
  }

  return knownTypes;
}

/** Collect arity information from constructor annotations and type aliases.
 *  Also adds constructor return-type names to `knownTypes`. */
function collectConstructorArities(
  annotationMap: Map<string, TypeAnnotation>,
  typeAliases: Map<string, Type>,
  knownTypes: Set<string>,
): Map<string, number> {
  const constructorArities = new Map<string, number>();

  for (const [name, ann] of annotationMap) {
    if (!ann.scheme) continue;
    if (isMethodAnnotationName(name)) continue;
    const returnType = getReturnType(ann.scheme.type);
    if (returnType.tag === 'TCon' && returnType.name === name) {
      knownTypes.add(name);
      if (returnType.args.length > 0) {
        constructorArities.set(name, returnType.args.length);
      }
    }
    if (returnType.tag === 'TCon' && returnType.name !== name && /^[A-Z]/.test(name)) {
      if (getParentTypeName(name) === returnType.name) {
        knownTypes.add(returnType.name);
      }
    }
  }

  // Add type alias arities
  for (const [name, type] of typeAliases) {
    if (constructorArities.has(name)) continue;
    const ann = annotationMap.get(name);
    if (ann?.scheme) {
      const vars = collectFreeVarNames(type);
      constructorArities.set(name, vars.length);
    }
  }

  return constructorArities;
}

/** Validate that type vars in constructor return types appear in the parameter types.
 *  Only walks annotations parsed from the CURRENT file — never annotations
 *  pulled in via `// ::types <pkg>` (those live in the merged annotationMap
 *  but originate from a different source file and have offsets that don't
 *  belong to this document). */
function validateConstructorReturnVars(
  annotations: TypeAnnotation[],
  typeAliases: Map<string, Type>,
  addDiag: (message: string, loc: { start: number; end: number }) => void,
): void {
  for (const ann of annotations) {
    const name = ann.name;
    if (!name) continue;
    if (!ann.scheme) continue;
    if (isMethodAnnotationName(name)) continue;
    if (!/^[A-Z]/.test(name)) continue;

    const returnType = getReturnType(ann.scheme.type);
    if (returnType.tag !== 'TCon' || returnType.name !== name) continue;
    if (returnType.args.length === 0) continue;

    const returnVarNames = new Map<number, string>();
    for (const arg of returnType.args) collectVarNames(arg, returnVarNames);
    if (returnVarNames.size === 0) continue;

    // Expand aliases in the parameter positions before collecting their
    // type vars.  A parameter written as an alias (e.g. `Rej` where
    // `Rej :: e -> ()`) contributes the alias body's free vars; those
    // whose name matches a return var are captured to the same outer var
    // (see `expandAliases` capture-by-name), so `Future :: (Rej -> Res
    // -> ()) -> Future e a` correctly derives `e`/`a` from the params.
    const outerVars = new Map<string, TVar>();
    eachType(ann.scheme.type, n => {
      if (n.tag === 'TVar' && !outerVars.has(n.name)) outerVars.set(n.name, n);
    });
    const expandedType = typeAliases.size > 0
      ? expandAliases(typeAliases, ann.scheme.type, undefined, undefined, undefined, outerVars)
      : ann.scheme.type;

    const paramVarNames = new Set<string>();
    let cur: Type = expandedType;
    while (cur.tag === 'TFun') {
      const paramNames = new Map<number, string>();
      collectVarNames(cur.param, paramNames);
      for (const n of paramNames.values()) paramVarNames.add(n);
      cur = cur.result;
    }

    for (const varName of returnVarNames.values()) {
      if (!paramVarNames.has(varName)) {
        addDiag(
          `Type variable '${varName}' in return type '${name}' is not derivable from the parameter types. Each type variable in the return type must appear in at least one parameter`,
          annotationNameLoc(ann),
        );
      }
    }
  }
}

/** Check all annotations for unknown type constructors and constraint-as-type misuse. */
function checkUnknownTypeConstructors(
  annotations: TypeAnnotation[],
  annotationMap: Map<string, TypeAnnotation>,
  knownTypes: Set<string>,
  addDiag: (message: string, loc: { start: number; end: number }) => void,
): void {
  const constraintNames = new Set(getConstraintNames());

  for (const ann of annotations) {
    if (!ann.scheme) continue;

    // Validate method annotation type name matches receiver type
    if (ann.name?.includes('#') && ann.receiver?.tag === 'TCon') {
      const typeName = ann.name.split('#')[0];
      const receiverName = ann.receiver.name;
      if (typeName && typeName !== receiverName) {
        const ctorAnn = annotationMap.get(typeName);
        const ctorReturnType = ctorAnn?.scheme ? getReturnType(ctorAnn.scheme.type) : null;
        const isSubtype = ctorReturnType?.tag === 'TCon' && ctorReturnType.name === receiverName;
        // A named transformer INSTANCE (`StateFuture :: TypeRep (StateT
        // (Future e) s)`) may override a method for that instance only:
        // `StateFuture#ap :: StateT (Future e) s a ~> …`.
        const ctorType = ctorAnn?.scheme?.type;
        const isInstance = ctorType?.tag === 'TCon' && ctorType.name === 'TypeRep'
          && ctorType.args[0]?.tag === 'TCon' && ctorType.args[0].name === receiverName;
        if (!isSubtype && !isInstance) {
          addDiag(`Type name mismatch in method annotation: '${typeName}' does not match receiver type '${receiverName}'. Did you mean '${receiverName}#${ann.name.split('#')[1]}'?`, annotationNameLoc(ann));
        }
      }
    }

    // Method/static annotations: validate type constructors in full scheme + receiver + method type
    if (isMethodAnnotationName(ann.name)) {
      const unknownMethodTypes: string[] = [];
      for (const t of annotationTypeParts(ann)) {
        unknownMethodTypes.push(...findUnknownTCons(t, knownTypes));
      }
      for (const unknown of new Set(unknownMethodTypes)) {
        addDiag(`Unknown type constructor '${unknown}' in method annotation. Define it with a sum type declaration or \`// ::types\``, annotationNameLoc(ann));
      }
      continue;
    }

    const unknownTypes: string[] = [];
    for (const t of annotationTypeParts(ann)) {
      unknownTypes.push(...findUnknownTCons(t, knownTypes));
    }

    for (const unknown of new Set(unknownTypes)) {
      addDiag(`Unknown type constructor '${unknown}'. Use \`// ::types\` to load its definition`, annotationNameLoc(ann));
    }

    // Check for constraint names used as type constructors
    if (constraintNames.size > 0) {
      const tconNames = new Set<string>();
      eachType(ann.scheme.type, n => {
        if (n.tag === 'TCon' && /^[A-Z]/.test(n.name)) tconNames.add(n.name);
      });
      for (const name of tconNames) {
        if (constraintNames.has(name)) {
          addDiag(
            `'${name}' is a type class constraint, not a type constructor. Use it in the constraint section (e.g. '${name} f => ... f a ...'), not as a type.`,
            annotationNameLoc(ann),
          );
        }
      }
    }
  }
}

/** Walk a type tree and find TCon nodes whose arg count mismatches the sumtype declaration. */
export function findArityMismatches(
  t: Type,
  constructorArities: Map<string, number>,
  aliasNames?: ReadonlySet<string>,
): { name: string; actual: number; expected: number }[] {
  const out: { name: string; actual: number; expected: number }[] = [];
  // A type constructor that is the direct argument of `TypeRep` is a *type
  // representative witness* (e.g. `TypeRep Function`, `TypeRep Either`), not an
  // instantiation, so its mandatory-arity requirement does not apply — the
  // witness may be a bare or partially-applied constructor.
  const witnessExempt = new WeakSet<object>();
  eachType(t, n => {
    if (n.tag === 'TCon' && n.name === T_TYPEREP) {
      for (const a of n.args) witnessExempt.add(a);
    }
  });
  // A constructor that is a direct argument of a USER-defined type
  // constructor may be under-applied by exactly one: it fills a
  // higher-kinded parameter (`StateT (Future e) s a`, where StateT's `m` is
  // used as `m (Pair a s)`).  Kinds of user parameters are not tracked, so
  // this is not checked further here; a wrong use still fails unification.
  const hkArgSlots = new WeakSet<object>();
  eachType(t, n => {
    if (n.tag !== 'TCon' || n.args.length === 0) return;
    if (isBuiltinType(n.name) || BUILTIN_TYPE_ARITIES.has(n.name) || n.name === T_TYPEREP) return;
    for (const a of n.args) if (a.tag === 'TCon') hkArgSlots.add(a);
  });
  eachType(t, n => {
    if (n.tag !== 'TCon') return;
    if (witnessExempt.has(n)) return;
    if (hkArgSlots.has(n)) {
      const full = getDataType(n.name)?.decl.typeVars.length ?? constructorArities.get(n.name) ?? getTypeArity(n.name);
      if (full !== undefined && full > 0 && n.args.length === full - 1) return;
    }
    const dt = getDataType(n.name);
    if (dt && n.args.length !== dt.decl.typeVars.length) {
      out.push({ name: n.name, actual: n.args.length, expected: dt.decl.typeVars.length });
    } else if (!dt) {
      // Check constructor annotation arities (e.g. Pair :: (a, b) -> Pair a b → arity 2)
      const ctorArity = constructorArities.get(n.name);
      if (ctorArity !== undefined && n.args.length !== ctorArity) {
        // Aliases support partial application: any unprovided trailing
        // parameters are freshened at expansion time (see `expandAliases`).
        // So `[Selector]` and `GenericSelector UserTag` both type-check
        // against a multi-param alias just like `Selector a b` does.
        // Only over-application is reported.  Real constructors (named in
        // `aliasNames`'s complement) still require exact arity.
        const isAlias = aliasNames
          ? aliasNames.has(n.name)
          : !getDataType(n.name);
        if (isAlias && n.args.length <= ctorArity) return;
        out.push({ name: n.name, actual: n.args.length, expected: ctorArity });
      } else if (ctorArity === undefined) {
        // Check method registry arities (Array=1, Map=2, Set=1, Promise=1)
        const regArity = getTypeArity(n.name);
        if (regArity > 0 && n.args.length !== regArity) {
          out.push({ name: n.name, actual: n.args.length, expected: regArity });
        } else if (regArity === 0) {
          // Fallback: hardcoded built-in arities
          const expected = BUILTIN_TYPE_ARITIES.get(n.name);
          if (expected !== undefined && n.args.length !== expected) {
            out.push({ name: n.name, actual: n.args.length, expected });
          } else if (expected === undefined && n.args.length > 0 && isBuiltinType(n.name)) {
            // Nullary built-in types (Object, String, Number, Boolean, …) take
            // no type arguments — `Object a b c` or `String a` is an error.
            out.push({ name: n.name, actual: n.args.length, expected: 0 });
          }
        }
      }
    }
  });
  return out;
}

/** Walk a type tree and find applied `Function` nodes whose first child is not
 *  an array-like parameter list (`[x]` / `[x, y]` / `[]`).  The first child of
 *  `Function` MUST be such an array (`Function [params] result`). */
function findFunctionParamListErrors(t: Type): { display: string }[] {
  const out: { display: string }[] = [];
  eachType(t, n => {
    if (n.tag === 'TCon' && n.name === T_FUNCTION && n.args.length === 2 &&
        functionParamList(n.args[0]) === null) {
      out.push({ display: typeToString(n.args[0]) });
    }
  });
  return out;
}

/** Walk a type tree and find bare `TypeRep` TCon nodes with no type arguments. */
function findBareTypeReps(t: Type): true[] {
  const out: true[] = [];
  eachType(t, n => {
    if (n.tag === 'TCon' && n.name === T_TYPEREP && n.args.length === 0) out.push(true);
  });
  return out;
}

/**
 * Walk a type tree and collect kind-variable names ($kv:name:id) that are
 * NOT in the given set of constraint variable names.  Returns a deduplicated
 * Set of unconstrained variable names used in HK position.
 */
function findUnconstrainedKvUsages(
  t: Type,
  constraintVarNames: Set<string>,
): Set<string> {
  const out = new Set<string>();
  // Rank-N: constraints scoped inside a `forall` (e.g.
  // `(forall f. Functor f => f a -> f a)`) also constrain their binder —
  // collect them up-front so kv usages inside the forall body are covered.
  const inScope = new Set(constraintVarNames);
  eachType(t, n => {
    if (n.tag === 'TForall' && n.constraints) {
      for (const c of n.constraints) inScope.add(c.typeVarName);
    }
  });
  eachType(t, n => {
    if (n.tag !== 'TCon') return;
    const kv = parseKvName(n.name);
    if (kv && !inScope.has(kv.varName)) out.add(kv.varName);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Rigid annotation checking
// ---------------------------------------------------------------------------

/**
 * Detect whether the annotation type and the inferred type have a clear
 * structural mismatch — different parameter count/shape or incompatible
 * return-type constructors — that the rigid check can reliably catch even
 * when the annotation's return type contains quantified variables and
 * wildcards make identity-tracking unreliable.
 *
 * Covered mismatches:
 *   - One side uses a tuple param, the other doesn't
 *   - Both use tuples but with different arity
 *   - Return types are distinct TCons (e.g. Undefined vs Array)
 */
export function hasStructuralMismatch(annotationType: Type, inferredType: Type): boolean {
  if (annotationType.tag !== 'TFun' || inferredType.tag !== 'TFun') return false;

  const annParam = annotationType.param;
  const infParam = inferredType.param;
  const annIsTuple = isTuple(annParam);
  const infIsTuple = isTuple(infParam);

  // Param structure: one is tuple, other is not
  if (annIsTuple !== infIsTuple) return true;
  // Both tuples but different arity
  if (annIsTuple && infIsTuple && annParam.args.length !== (infParam as TCon).args.length) return true;

  // Return type top-level constructor mismatch
  const annReturn = getReturnType(annotationType);
  const infReturn = getReturnType(inferredType);
  if (annReturn.tag === 'TCon' && infReturn.tag === 'TCon'
      && !isWildcard(annReturn) && !isWildcard(infReturn)
      && !isAnyType(infReturn)
      && annReturn.name !== infReturn.name) {
    return true;
  }

  // Record-vs-non-record return mismatch: the annotation's return is a record
  // shape (`{ x::T }`, `{ [k]::a }`, `{ ...a }`, or a `Merge` marker) but the
  // body returns a concrete NON-record value (`String`, `Number`, `[a]`, …).
  // The plain TCon-vs-TCon test above misses this because a record-shaped
  // annotation return is a `TRecord`, not a `TCon`.  This only GATES whether
  // the rigid check runs; the rigid check itself (with the merge-shape
  // acceptance in `unify`) makes the final decision, so a record-ish body is
  // still accepted there.
  const annReturnIsRecordShape =
    annReturn.tag === 'TRecord' ||
    (annReturn.tag === 'TCon' && annReturn.name === T_MERGE);
  const infReturnIsConcreteNonRecord =
    infReturn.tag === 'TCon' && infReturn.name !== T_MERGE
      && !isWildcard(infReturn) && !isAnyType(infReturn);
  if (annReturnIsRecordShape && infReturnIsConcreteNonRecord) {
    return true;
  }

  return false;
}

/**
 * Detect whether the annotation type and the inferred type have different
 * parameter shapes.  A curried annotation (`a -> b -> c -> d`) paired with
 * a multi-param (tuple) implementation (`(a, b, c) -> d`) — or vice versa —
 * is a structural mismatch that the rigid check should always catch,
 * regardless of whether the return type contains quantified variables.
 */
export function hasParamShapeMismatch(annotationType: Type, inferredType: Type): boolean {
  if (annotationType.tag !== 'TFun' || inferredType.tag !== 'TFun') return false;

  const annIsTuple = isTuple(annotationType.param);
  const annIsCurriedMulti = !annIsTuple && annotationType.result.tag === 'TFun';

  const infIsTuple = isTuple(inferredType.param);
  const infIsCurriedMulti = !infIsTuple && inferredType.result.tag === 'TFun';

  // Mismatch when one side is curried and the other uses a tuple param
  return (annIsCurriedMulti && infIsTuple) || (annIsTuple && infIsCurriedMulti);
}

/**
 * Get the declaration-name location for an annotation.  Prefers the JS
 * identifier range (`nameStart`/`nameEnd`) so that only the function or
 * variable name is underlined, not the entire `// :: signature` comment.
 * Falls back to the full comment range when no declaration name is available.
 */
export function annotationNameLoc(ann: TypeAnnotation): { start: number; end: number } {
  if (typeof ann.signatureNameStart === 'number' && typeof ann.signatureNameEnd === 'number') {
    return { start: ann.signatureNameStart, end: ann.signatureNameEnd };
  }
  return { start: ann.commentStart, end: ann.commentEnd };
}
