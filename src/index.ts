// ============================================================================
// Public API — re-exports for convenience
//
// Plain language: the front door for programmatic users (tests, scripts):
// one import point that re-exports the engine, the type building blocks and
// the parsers from their various modules.
// ============================================================================

export {
  Type,
  TVar,
  TCon,
  TFun,
  TRecord,
  Scheme,
  Constraint,
  TypePredicate,
  tVar,
  tCon,
  tFun,
  tRecord,
  tNumber,
  tString,
  tBool,
  tNull,
  tUndefined,
  tVoid,
  tArray,
  tTuple,
  tMultiFun,
  tAny,
  tAnyType,
  mono,
  scheme,
  typeToString,
  prettyTypeToString,
  schemeToString,
  resetTypeVarCounter,
  saveTypeVarCounter,
  restoreTypeVarCounter,
  TypeVarAllocator,
  getActiveAllocator,
  setActiveAllocator,
  isKindVariable,
  kvName,
  parseKvName,
  generateCurriedOverloads,
  flattenCurriedType,
} from './hm/types';

export { Substitution } from './hm/substitution';

export {
  TypeEnv,
  instantiate,
  generalize,
  freeTypeVarsInType,
  freeTypeVarsInScheme,
} from './hm/env';

export { unify, UnificationError } from './hm/unify';

export { parseTypeSignature, parseType, parseMethodTypeSignature, MethodTypeSignature, TypeParseError } from './hm/typeParser';

export {
  extractAnnotations,
  buildAnnotationMap,
  buildAnnotationByOffset,
  extractTypeDirectives,
  extractTypeDirectivesWithLocations,
  extractPreferDirectives,
  extractConstraintDirectives,
  extractGlobalDirectives,
  hasIgnoreFileDirective,
  extractIgnoreLineDirectives,
  extractIgnoreFunctionDirectives,
  TypeAnnotation,
} from './commentParser';

export {
  InferenceEngine,
  InferenceDiagnostic,
  InferenceResult,
  ImportResolver,
  TypeDirectiveResolver,
  ImportTypeAliasResolver,
  UNTYPED_MODULE,
  UntypedModule,
  markOpenWorldExports,
  isOpenWorldExports,
  defaultEnv,
} from './infer';

export {
  MethodRegistry,
  lookupMethod,
  lookupStaticMethod,
  getMethodNames,
  isBuiltinType,
  registerMethod,
  clearCustomMethods,
  snapshotMethodRegistry,
  restoreMethodRegistry,
  mergeMethodRegistry,
  snapshotBuiltinOriginalEntries,
  restoreBuiltinOriginalEntries,
  findMethodCandidates,
  MethodFactory,
  MethodEntry,
} from './registries/methodRegistry';

export {
  ConstraintRegistry,
  registerConstraint,
  lookupConstraint,
  getConstraintNames,
  getEffectiveMethods,
  clearConstraints,
  snapshotConstraintRegistry,
  restoreConstraintRegistry,
  mergeConstraintRegistry,
  checkConstraint,
  parseConstraintDirective,
  ConstraintDef,
  MethodRequirement,
} from './registries/constraintRegistry';

export {
  registerDataType,
  isDataType,
  isVariant,
  getParentTypeName,
  getDataType,
  getDataTypeDisplayString,
  getVariantNames,
  clearDataTypes,
  snapshotDataTypeRegistry,
  restoreDataTypeRegistry,
  mergeDataTypeRegistry,
  DataTypeRegistrySnapshot,
} from './registries/dataTypeRegistry';

export {
  levelToSeverity,
  mapInferenceDiagnostics,
  detectMissingSignatures,
  filterIgnoredDiagnostics,
  filterAnnotationMismatchDiagnostics,
  filterDiagnosticsInsideBindings,
  collectBindingIntervals,
} from './services/diagnostics';

export {
  HinMilSettings,
  HinMilPartialSettings,
  HinMilProjectConfig,
  DiagnosticLevel,
  DIAGNOSTIC_LEVELS,
  TrustAnnotationsLevel,
  normalizeTrustAnnotations,
  mergeSettings,
  defaultSettings,
  PROJECT_CONFIG_FILES,
  DEFAULT_GLOBALS_FILES,
  DEFAULT_TYPES_DIR,
} from './config';

export {
  buildHover,
  getAliasHoverAtOffset,
  getIdentifierAt,
  getWordAt,
  resolveValidIdent,
  collectConstraintInfo,
  validIdentLooksLikeArrayMethod,
  tryArrayLiteralReinfer,
  HoverContext,
} from './services/hover';

export {
  resolveImportSpecifier,
  resolveTypeDirectiveSpecifier,
  extractImportSpecifiers,
  normalizeArrayLiteralASI,
  unmapOffset,
  patchArrayLiteralASI,
  positionAt,
  findTypeDefinitionLocation,
  findExportedIdentifierOffset,
} from './services/files';

export {
  getDestructuringCompletions,
  getImportSpecifierCompletions,
  getImportPathCompletions,
  getWorkspaceExports,
  buildAutoImportEdit,
  getIdentifierCompletions,
  getDotCompletions,
  CompletionContext,
} from './services/completion';

export {
  getCodeActions,
  CodeActionContext,
} from './services/codeActions';

export {
  getDocumentSymbols,
  DocumentSymbolContext,
} from './services/documentSymbols';

export {
  classifyDiagnosticCode,
  codeToCategory,
  ConfigurableDiagnosticCategory,
  HM_TYPE_MISMATCH,
  HM_INFINITE_TYPE,
  HM_ANNOTATION_MISMATCH,
  HM_RETURN_TYPE_MISMATCH,
  HM_MISSING_PROPERTY,
  HM_UNCONSTRAINED_PROP,
  HM_UNBOUND_VARIABLE,
  HM_INVALID_ANNOTATION,
  HM_NAME_MISMATCH,
  HM_METHOD_NAME_MISMATCH,
  HM_UNKNOWN_TYPE,
  HM_VARIANT_METHOD,
  HM_METHOD_TYPE_MISMATCH,
  HM_TYPE_ARITY_MISMATCH,
  HM_INVALID_NARROW,
  HM_MISSING_EXPORT,
  HM_UNRESOLVED_TYPES_PATH,
  HM_UNKNOWN_CONSTRAINT,
  HM_CONSTRAINT_VIOLATION,
  HM_INVALID_CONSTRAINT,
  HM_CURRY_ARITY,
  HM_CURRY_TYPE,
  HM_CURRIED_OVER_APPLICATION,
  HM_MISSING_SIGNATURE,
  HM_PARSE_ERROR,
} from './services/diagnosticCodes';

export { setDebugSink, debugLog, DebugSink } from './debugLog';
