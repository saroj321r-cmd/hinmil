/**
 * Smoke-test that exercises the public barrel export (`src/index.ts`).
 *
 * Every test file imports directly from the source modules, so the
 * re-export getters in index.ts never fire.  This single test triggers
 * them all and verifies the public API surface stays coherent.
 */
import {
  // --- hm/types ---
  tVar, tCon, tFun, tRecord, tNumber, tString, tBool, tNull, tUndefined,
  tVoid, tArray, tTuple, tMultiFun, mono, scheme, typeToString,
  prettyTypeToString, schemeToString, resetTypeVarCounter,
  saveTypeVarCounter, restoreTypeVarCounter, TypeVarAllocator,
  getActiveAllocator, setActiveAllocator, isKindVariable, kvName,
  parseKvName, generateCurriedOverloads, flattenCurriedType,

  // --- hm/substitution ---
  Substitution,

  // --- hm/env ---
  TypeEnv, instantiate, generalize, freeTypeVarsInType, freeTypeVarsInScheme,

  // --- hm/unify ---
  unify, UnificationError,

  // --- hm/typeParser ---
  parseTypeSignature, parseType, parseMethodTypeSignature,

  // --- commentParser ---
  extractAnnotations, buildAnnotationMap, buildAnnotationByOffset,
  extractTypeDirectives, extractTypeDirectivesWithLocations,
  extractConstraintDirectives, extractGlobalDirectives,
  hasIgnoreFileDirective, extractIgnoreLineDirectives,
  extractIgnoreFunctionDirectives,

  // --- infer ---
  InferenceEngine, defaultEnv,

  // --- registries/methodRegistry ---
  lookupMethod, getMethodNames, isBuiltinType, registerMethod,
  clearCustomMethods, snapshotMethodRegistry, restoreMethodRegistry,
  mergeMethodRegistry, findMethodCandidates,

  // --- registries/constraintRegistry ---
  registerConstraint, lookupConstraint, getConstraintNames,
  getEffectiveMethods, clearConstraints, snapshotConstraintRegistry,
  restoreConstraintRegistry, mergeConstraintRegistry, checkConstraint,
  parseConstraintDirective,

  // --- registries/dataTypeRegistry ---
  registerDataType, isDataType, isVariant, getParentTypeName, getDataType,
  getDataTypeDisplayString, getVariantNames, clearDataTypes,
  snapshotDataTypeRegistry, restoreDataTypeRegistry, mergeDataTypeRegistry,

  // --- services/diagnostics ---
  levelToSeverity, mapInferenceDiagnostics, detectMissingSignatures,
  filterIgnoredDiagnostics,

  // --- config ---
  defaultSettings, mergeSettings, normalizeTrustAnnotations,
  PROJECT_CONFIG_FILES, DEFAULT_GLOBALS_FILES, DEFAULT_TYPES_DIR,

  // --- services/hover ---
  buildHover, getAliasHoverAtOffset, getIdentifierAt, getWordAt,
  resolveValidIdent, collectConstraintInfo, validIdentLooksLikeArrayMethod,
  tryArrayLiteralReinfer,

  // --- services/files ---
  resolveImportSpecifier, resolveTypeDirectiveSpecifier,
  extractImportSpecifiers, normalizeArrayLiteralASI, unmapOffset,
  patchArrayLiteralASI, positionAt, findTypeDefinitionLocation,
  findExportedIdentifierOffset,

  // --- services/completion ---
  getDestructuringCompletions, getImportSpecifierCompletions,
  getImportPathCompletions, getWorkspaceExports, buildAutoImportEdit,
  getIdentifierCompletions, getDotCompletions,

  // --- services/codeActions ---
  getCodeActions,

  // --- services/documentSymbols ---
  getDocumentSymbols,

  // --- services/diagnosticCodes ---
  classifyDiagnosticCode,
  HM_TYPE_MISMATCH, HM_INFINITE_TYPE, HM_ANNOTATION_MISMATCH,
  HM_RETURN_TYPE_MISMATCH, HM_MISSING_PROPERTY, HM_UNCONSTRAINED_PROP,
  HM_UNBOUND_VARIABLE, HM_INVALID_ANNOTATION, HM_NAME_MISMATCH,
  HM_METHOD_NAME_MISMATCH, HM_UNKNOWN_TYPE, HM_VARIANT_METHOD,
  HM_METHOD_TYPE_MISMATCH, HM_MISSING_EXPORT, HM_UNRESOLVED_TYPES_PATH,
  HM_UNKNOWN_CONSTRAINT, HM_CONSTRAINT_VIOLATION, HM_INVALID_CONSTRAINT,
  HM_CURRY_ARITY, HM_CURRY_TYPE, HM_CURRIED_OVER_APPLICATION,
  HM_MISSING_SIGNATURE, HM_PARSE_ERROR,
} from '../../src/index';

describe('Public API barrel export', () => {
  beforeEach(() => resetTypeVarCounter());

  test('type constructors are functions', () => {
    expect(typeof tVar).toBe('function');
    expect(typeof tCon).toBe('function');
    expect(typeof tFun).toBe('function');
    expect(typeof tRecord).toBe('function');
  });

  test('built-in type constants are TCon nodes', () => {
    expect(typeToString(tNumber)).toBe('Number');
    expect(typeToString(tString)).toBe('String');
    expect(typeToString(tBool)).toBe('Boolean');
    expect(typeToString(tNull)).toBe('Null');
    expect(typeToString(tUndefined)).toBe('Undefined');
    expect(typeToString(tVoid)).toBe('()');
  });

  test('tArray / tTuple / tMultiFun produce correct signatures', () => {
    expect(typeToString(tArray(tNumber))).toBe('[Number]');
    expect(typeToString(tTuple([tNumber, tString]))).toBe('(Number, String)');
    expect(typeToString(tMultiFun([tNumber, tString], tBool))).toBe('(Number, String) -> Boolean');
  });

  test('mono / scheme / schemeToString round-trip', () => {
    const m = mono(tNumber);
    expect(m.type).toBe(tNumber);
    const a = tVar('a');
    const s = scheme([a.id], tFun(a, a));
    expect(schemeToString(s)).toContain('->');
  });

  test('prettyTypeToString formats correctly', () => {
    const t = tFun(tNumber, tString);
    expect(prettyTypeToString(t)).toContain('->');
  });

  test('type-var counter save/restore', () => {
    resetTypeVarCounter();
    const saved = saveTypeVarCounter();
    tVar('_fresh_');
    restoreTypeVarCounter(saved);
    // No assertion needed — just verifying the API doesn't crash
  });

  test('TypeVarAllocator / getActiveAllocator / setActiveAllocator', () => {
    const alloc = new TypeVarAllocator();
    const prev = getActiveAllocator();
    setActiveAllocator(alloc);
    setActiveAllocator(prev);
  });

  test('isKindVariable / kvName / parseKvName', () => {
    expect(typeof isKindVariable).toBe('function');
    expect(typeof kvName).toBe('function');
    expect(typeof parseKvName).toBe('function');
  });

  test('generateCurriedOverloads / flattenCurriedType', () => {
    expect(typeof generateCurriedOverloads).toBe('function');
    const curried = tFun(tNumber, tFun(tString, tBool));
    const flat = flattenCurriedType(curried);
    expect(flat.params.length + 1).toBeGreaterThanOrEqual(2);
  });

  test('Substitution is a constructor', () => {
    const sub = new Substitution();
    expect(sub).toBeDefined();
  });

  test('TypeEnv / instantiate / generalize / freeTypeVars', () => {
    const env = new TypeEnv();
    expect(typeof instantiate).toBe('function');
    expect(typeof generalize).toBe('function');
    expect(typeof freeTypeVarsInType).toBe('function');
    expect(typeof freeTypeVarsInScheme).toBe('function');
  });

  test('unify / UnificationError', () => {
    expect(typeof unify).toBe('function');
    expect(typeof UnificationError).toBe('function');
  });

  test('type parser functions', () => {
    const parsed = parseTypeSignature('Number -> String');
    expect(parsed).toBeDefined();
    const t = parseType('Number');
    expect(t).toBeDefined();
    expect(typeof parseMethodTypeSignature).toBe('function');
  });

  test('comment parser functions', () => {
    expect(typeof extractAnnotations).toBe('function');
    expect(typeof buildAnnotationMap).toBe('function');
    expect(typeof buildAnnotationByOffset).toBe('function');
    expect(typeof extractTypeDirectives).toBe('function');
    expect(typeof extractTypeDirectivesWithLocations).toBe('function');
    expect(typeof extractConstraintDirectives).toBe('function');
    expect(typeof extractGlobalDirectives).toBe('function');
    expect(typeof hasIgnoreFileDirective).toBe('function');
    expect(typeof extractIgnoreLineDirectives).toBe('function');
    expect(typeof extractIgnoreFunctionDirectives).toBe('function');
  });

  test('InferenceEngine works through barrel export', () => {
    const engine = new InferenceEngine();
    const r = engine.infer('const x = 1 + 2;');
    expect(typeToString(r.type)).toBe('Number');
  });

  test('defaultEnv is a TypeEnv', () => {
    expect(defaultEnv).toBeDefined();
  });

  test('method registry functions', () => {
    expect(typeof lookupMethod).toBe('function');
    expect(typeof getMethodNames).toBe('function');
    expect(typeof isBuiltinType).toBe('function');
    expect(typeof registerMethod).toBe('function');
    expect(typeof clearCustomMethods).toBe('function');
    expect(typeof snapshotMethodRegistry).toBe('function');
    expect(typeof restoreMethodRegistry).toBe('function');
    expect(typeof mergeMethodRegistry).toBe('function');
    expect(typeof findMethodCandidates).toBe('function');
  });

  test('constraint registry functions', () => {
    expect(typeof registerConstraint).toBe('function');
    expect(typeof lookupConstraint).toBe('function');
    expect(typeof getConstraintNames).toBe('function');
    expect(typeof getEffectiveMethods).toBe('function');
    expect(typeof clearConstraints).toBe('function');
    expect(typeof snapshotConstraintRegistry).toBe('function');
    expect(typeof restoreConstraintRegistry).toBe('function');
    expect(typeof mergeConstraintRegistry).toBe('function');
    expect(typeof checkConstraint).toBe('function');
    expect(typeof parseConstraintDirective).toBe('function');
  });

  test('data-type registry functions', () => {
    expect(typeof registerDataType).toBe('function');
    expect(typeof isDataType).toBe('function');
    expect(typeof isVariant).toBe('function');
    expect(typeof getParentTypeName).toBe('function');
    expect(typeof getDataType).toBe('function');
    expect(typeof getDataTypeDisplayString).toBe('function');
    expect(typeof getVariantNames).toBe('function');
    expect(typeof clearDataTypes).toBe('function');
    expect(typeof snapshotDataTypeRegistry).toBe('function');
    expect(typeof restoreDataTypeRegistry).toBe('function');
    expect(typeof mergeDataTypeRegistry).toBe('function');
  });

  test('diagnostic service functions', () => {
    expect(typeof levelToSeverity).toBe('function');
    expect(typeof mapInferenceDiagnostics).toBe('function');
    expect(typeof detectMissingSignatures).toBe('function');
    expect(typeof filterIgnoredDiagnostics).toBe('function');
  });

  test('config exports', () => {
    expect(defaultSettings).toBeDefined();
    expect(typeof mergeSettings).toBe('function');
    expect(typeof normalizeTrustAnnotations).toBe('function');
    expect(Array.isArray(PROJECT_CONFIG_FILES)).toBe(true);
    expect(Array.isArray(DEFAULT_GLOBALS_FILES)).toBe(true);
    expect(typeof DEFAULT_TYPES_DIR).toBe('string');
  });

  test('hover service functions', () => {
    expect(typeof buildHover).toBe('function');
    expect(typeof getAliasHoverAtOffset).toBe('function');
    expect(typeof getIdentifierAt).toBe('function');
    expect(typeof getWordAt).toBe('function');
    expect(typeof resolveValidIdent).toBe('function');
    expect(typeof collectConstraintInfo).toBe('function');
    expect(typeof validIdentLooksLikeArrayMethod).toBe('function');
    expect(typeof tryArrayLiteralReinfer).toBe('function');
  });

  test('file service functions', () => {
    expect(typeof resolveImportSpecifier).toBe('function');
    expect(typeof resolveTypeDirectiveSpecifier).toBe('function');
    expect(typeof extractImportSpecifiers).toBe('function');
    expect(typeof normalizeArrayLiteralASI).toBe('function');
    expect(typeof unmapOffset).toBe('function');
    expect(typeof patchArrayLiteralASI).toBe('function');
    expect(typeof positionAt).toBe('function');
    expect(typeof findTypeDefinitionLocation).toBe('function');
    expect(typeof findExportedIdentifierOffset).toBe('function');
  });

  test('completion service functions', () => {
    expect(typeof getDestructuringCompletions).toBe('function');
    expect(typeof getImportSpecifierCompletions).toBe('function');
    expect(typeof getImportPathCompletions).toBe('function');
    expect(typeof getWorkspaceExports).toBe('function');
    expect(typeof buildAutoImportEdit).toBe('function');
    expect(typeof getIdentifierCompletions).toBe('function');
    expect(typeof getDotCompletions).toBe('function');
  });

  test('code-action and document-symbol functions', () => {
    expect(typeof getCodeActions).toBe('function');
    expect(typeof getDocumentSymbols).toBe('function');
  });

  test('diagnostic codes are numbers', () => {
    expect(typeof classifyDiagnosticCode).toBe('function');
    for (const code of [
      HM_TYPE_MISMATCH, HM_INFINITE_TYPE, HM_ANNOTATION_MISMATCH,
      HM_RETURN_TYPE_MISMATCH, HM_MISSING_PROPERTY, HM_UNCONSTRAINED_PROP,
      HM_UNBOUND_VARIABLE, HM_INVALID_ANNOTATION, HM_NAME_MISMATCH,
      HM_METHOD_NAME_MISMATCH, HM_UNKNOWN_TYPE, HM_VARIANT_METHOD,
      HM_METHOD_TYPE_MISMATCH, HM_MISSING_EXPORT, HM_UNRESOLVED_TYPES_PATH,
      HM_UNKNOWN_CONSTRAINT, HM_CONSTRAINT_VIOLATION, HM_INVALID_CONSTRAINT,
      HM_CURRY_ARITY, HM_CURRY_TYPE, HM_CURRIED_OVER_APPLICATION,
      HM_MISSING_SIGNATURE, HM_PARSE_ERROR,
    ]) {
      expect(typeof code).toBe('number');
    }
  });
});
