// ============================================================================
// Project checker — transport-independent HinMil project diagnostics.
//
// Shared by command-line consumers and the language server. Editor lifecycle
// concerns (debouncing, publication and live-document invalidation) remain in
// server.ts; project configuration, inference and diagnostic semantics live
// here so batch checks cannot drift from editor checks.
// ============================================================================

import { T_UNION } from '../hm/types';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  Diagnostic,
  DiagnosticSeverity,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { HinMilProjectConfig, HinMilSettings, DEFAULT_TYPES_DIR, defaultSettings, mergeSettings } from '../config';
import {
  extractIgnoreFunctionDirectives,
  extractIgnoreLineDirectives,
  extractImportModuleSpecifiers,
  hasIgnoreFileDirective,
} from '../commentParser';
import { InferenceEngine, InferenceResult } from '../infer';
import {
  applyDomSettings,
  MethodRegistrySnapshot,
  restoreBuiltinOriginalEntries,
  snapshotBuiltinOriginalEntries,
  snapshotMethodRegistry,
} from '../registries/methodRegistry';
import { classifyDiagnosticCode, codeToCategory, HM_INFINITE_TYPE } from './diagnosticCodes';
import {
  collectBindingIntervals,
  detectCircularImports,
  detectDuplicateImports,
  detectMissingSignatures,
  filterAnnotationMismatchDiagnostics,
  filterDiagnosticsInsideBindings,
  filterIgnoredDiagnostics,
  levelToSeverity,
  mapInferenceDiagnostics,
} from './diagnostics';
import { configureModuleExtensions, resolveImportSpecifier, normalizeArrayLiteralASI, unmapOffset } from './files';
import { loadGlobalsFile, loadProjectConfig } from './globalsLoader';
import { getHmDiagnostics, HmServiceContext } from './hmFileServices';
import { ImportInferenceContext } from './importContext';
import { FileSelection, isSelectedFile, mergeFileSelection } from './fileSelection';

export interface CheckResult {
  uri: string;
  diagnostics: Diagnostic[];
  inference?: InferenceResult;
}

export interface ProjectCheckerOptions {
  config?: HinMilProjectConfig;
  settingsLayer?: unknown;
  warn?: (message: string) => void;
}

export interface BuildDiagnosticsOptions {
  source: string;
  document: TextDocument;
  result: InferenceResult;
  insertions: number[];
  settings: HinMilSettings;
  circularImports?: Set<string>;
}

/** Apply the exact post-inference diagnostic policy shared by LSP and CLI. */
export function buildDiagnostics(options: BuildDiagnosticsOptions): Diagnostic[] {
  const { source, document, result, insertions, settings } = options;
  if (!settings.diagnostics.enabled || hasIgnoreFileDirective(source)) return [];

  const ignoredLines = extractIgnoreLineDirectives(source);
  for (const line of extractIgnoreFunctionDirectives(source)) ignoredLines.add(line);

  let inferDiags = result.diagnostics;
  const trustLevel = settings.diagnostics.trustAnnotations;
  if (trustLevel !== 'off') inferDiags = filterAnnotationMismatchDiagnostics(inferDiags);
  if (trustLevel === 'annotated-bodies' || trustLevel === 'all-bodies') {
    inferDiags = filterDiagnosticsInsideBindings(
      inferDiags,
      collectBindingIntervals(result, trustLevel === 'all-bodies' ? 'all' : 'annotated'),
    );
  }

  const annotatedIntervals = collectBindingIntervals(result, 'annotated');
  if (annotatedIntervals.length > 0) {
    inferDiags = inferDiags.filter((diagnostic) =>
      classifyDiagnosticCode(diagnostic.message) !== HM_INFINITE_TYPE
      || !annotatedIntervals.some(([start, end]) => diagnostic.start >= start && diagnostic.end <= end),
    );
  }

  const severityFor = (code: number): DiagnosticSeverity | null => {
    const category = codeToCategory(code);
    return levelToSeverity(category ? settings.diagnostics[category] : 'error');
  };
  const diagnostics = mapInferenceDiagnostics(
    inferDiags, document, insertions, severityFor, unmapOffset,
  );

  const functionSeverity = levelToSeverity(settings.diagnostics.missingSignatures);
  const variableSeverity = levelToSeverity(settings.diagnostics.missingVariableSignatures);
  if (functionSeverity !== null || variableSeverity !== null) {
    diagnostics.push(...detectMissingSignatures(
      source, document, result.annotations, functionSeverity, variableSeverity,
      (bindingStart) => isFunctionType(result.substitution.apply(
        result.nodeTypes.get(bindingStart)?.type ?? { tag: 'TCon', name: 'Undefined', args: [] })),
    ));
  }
  diagnostics.push(...detectDuplicateImports(source, document));
  diagnostics.push(...detectCircularImports(
    source, document, options.circularImports ?? new Set<string>(),
  ));
  return filterIgnoredDiagnostics(diagnostics, ignoredLines);
}

/** Stateful single-project checker; check files sequentially with one instance.
 *
 *  Construction configures process-global import-resolution extensions and
 *  method registries (see `configureModuleExtensions`). Do not interleave
 *  checkers with different extension sets or DOM settings in one process —
 *  create one checker per project and finish with it before starting another. */
export class ProjectChecker {
  readonly settings: HinMilSettings;
  readonly config: HinMilProjectConfig;
  readonly fileSelection: FileSelection;
  readonly warnings: string[] = [];

  private readonly documents = new TextDocuments<TextDocument>(TextDocument as never);
  private readonly engine = new InferenceEngine();
  private readonly importContext: ImportInferenceContext;
  private readonly warn: (message: string) => void;
  private globalsSource: string | null = null;
  private globalsFilePaths: string[] = [];

  constructor(readonly root: string, options: ProjectCheckerOptions = {}) {
    this.root = path.resolve(root);
    this.warn = (message) => {
      this.warnings.push(message);
      options.warn?.(message);
    };
    this.config = options.config ?? loadProjectConfig(this.root);
    this.settings = mergeSettings(
      [options.settingsLayer ?? {}, this.config.settings ?? {}],
      this.warn,
    );
    const editorFiles = typeof options.settingsLayer === 'object' && options.settingsLayer !== null
      ? (options.settingsLayer as { files?: unknown }).files
      : undefined;
    this.fileSelection = mergeFileSelection([editorFiles, this.config.files], this.warn);
    configureModuleExtensions(this.fileSelection.extensions);
    applyDomSettings(this.settings.dom);
    this.importContext = new ImportInferenceContext(this.documents, { warn: this.warn });
    this.initializeProject();
  }

  private initializeProject(): void {
    const globals = loadGlobalsFile(this.root, this.config, {
      getOpenDocText: () => null,
      warn: this.warn,
    });
    this.globalsSource = globals.source;
    this.globalsFilePaths = globals.filePaths;
    this.importContext.setProjectConfig(this.root, {
      overrides: this.config.overrides ?? {},
      typesDir: this.config.typesDir ?? DEFAULT_TYPES_DIR,
      globalsSource: this.globalsSource,
      globalsFilePath: this.globalsFilePaths[0] ?? null,
    });
    this.importContext.preloadPackageGlobalsFromWorkspace(this.root);
    const additions = [
      this.importContext.getProjectGlobalsAddendum(),
      this.importContext.getAllPackageGlobalsAddendum(),
    ].filter((value): value is string => Boolean(value));
    if (additions.length > 0) {
      this.globalsSource = [this.globalsSource, ...additions]
        .filter((value): value is string => Boolean(value))
        .join('\n');
    }
    this.engine.globalsSource = this.globalsSource;
  }

  checkFile(filePath: string): CheckResult {
    const absolutePath = path.resolve(filePath);
    const uri = pathToFileURL(absolutePath).href;
    // Selection controls standalone diagnostics only. ImportContext reads and
    // infers dependencies independently, including excluded files.
    if (!isSelectedFile(absolutePath, this.root, this.fileSelection)) {
      return { uri, diagnostics: [] };
    }
    const source = fs.readFileSync(absolutePath, 'utf8');
    const languageId = absolutePath.endsWith('.hm')
      ? 'hm'
      : absolutePath.endsWith('.jsx') ? 'javascriptreact' : 'javascript';
    const document = TextDocument.create(uri, languageId, 1, source);

    if (absolutePath.endsWith('.hm')) {
      if (!this.settings.diagnostics.enabled) return { uri, diagnostics: [] };
      const context: HmServiceContext = {
        findTypeDefinitions: (name) => this.importContext.findTypeDefinitions(
          name, uri, source, this.globalsSource, this.globalsFilePaths[0] ?? null,
        ),
        globals: this.globalsSource && this.globalsFilePaths[0]
          ? { source: this.globalsSource, uri: pathToFileURL(this.globalsFilePaths[0]).href }
          : null,
      };
      return { uri, diagnostics: getHmDiagnostics(uri, source, context) };
    }

    const resolver = this.importContext.createImportResolver(uri);
    const typeResolver = this.importContext.createTypeDirectiveResolver(uri);
    const aliasResolver = this.importContext.createImportTypeAliasResolver(uri);
    for (const specifier of extractImportModuleSpecifiers(source)) {
      const targetUri = resolveImportSpecifier(specifier, uri);
      if (targetUri && targetUri !== uri) this.importContext.inferFileAndCacheExports(targetUri);
    }

    const { patched, insertions } = normalizeArrayLiteralASI(source);
    let result: InferenceResult;
    let methodSnapshot: MethodRegistrySnapshot | undefined;
    const builtinSnapshot = snapshotBuiltinOriginalEntries();
    try {
      result = this.engine.infer(patched, undefined, resolver, typeResolver, aliasResolver);
      methodSnapshot = snapshotMethodRegistry();
    } finally {
      restoreBuiltinOriginalEntries(builtinSnapshot);
    }
    this.importContext.cacheExportsWithSnapshot(uri, result.exports, methodSnapshot);
    return {
      uri,
      inference: result,
      diagnostics: buildDiagnostics({
        source,
        document,
        result,
        insertions,
        settings: this.settings,
        circularImports: this.importContext.getCircularImports(uri),
      }),
    };
  }
}

/** Convenience defaults for API consumers constructing checker options. */
export const projectCheckerDefaultSettings = defaultSettings;

/** A function value: an arrow, an applied `Function [x] a`, or an overload set
 *  of functions (L2: only functions are asked for a signature). */
function isFunctionType(t: import('../hm/types').Type): boolean {
  if (t.tag === 'TFun') return true;
  if (t.tag === 'TForall') return isFunctionType(t.body);
  if (t.tag !== 'TCon') return false;
  if (t.name === 'Function' && t.args.length === 2) return true;
  if (t.name === T_UNION && t.args.length > 0) return t.args.every(isFunctionType);
  return false;
}
