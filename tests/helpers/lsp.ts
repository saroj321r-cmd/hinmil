// Shared LSP-service test helpers: TextDocument / Diagnostic / params
// factories and a minimal InferenceResult builder.  Replaces the mock
// plumbing that used to be duplicated across hover/codeActions/completion
// test files.

import {
  CodeActionParams,
  Diagnostic,
  DiagnosticSeverity,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceResult } from '../../src/infer/types';
import { Substitution } from '../../src/hm/substitution';
import { tNumber } from '../../src/hm/types';

export const TEST_URI = 'file:///test.js';

/** Create a TextDocument for an inline source string. */
export function makeDoc(content: string, uri: string = TEST_URI): TextDocument {
  return TextDocument.create(uri, 'javascript', 1, content);
}

/** Create a single-line diagnostic (hinmil source, Information severity). */
export function makeDiag(
  line: number,
  startChar: number,
  endChar: number,
  message: string,
  severity: DiagnosticSeverity = DiagnosticSeverity.Information,
): Diagnostic {
  return {
    severity,
    range: {
      start: { line, character: startChar },
      end: { line, character: endChar },
    },
    message,
    source: 'hinmil',
  };
}

/** CodeActionParams wrapping the given diagnostics. */
export function makeParams(uri: string, diagnostics: Diagnostic[]): CodeActionParams {
  return {
    textDocument: { uri },
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
    context: { diagnostics },
  };
}

/** Minimal InferenceResult with all required fields; override as needed. */
export function makeInferenceResult(
  overrides: Partial<InferenceResult> = {},
): InferenceResult {
  return {
    type: tNumber,
    substitution: new Substitution(),
    diagnostics: [],
    nodeTypes: new Map(),
    annotations: new Map(),
    annotationsByOffset: new Map(),
    methodSignatures: new Map(),
    exports: new Map(),
    kvConstraints: new Map(),
    kvConstructorConstraints: new Map(),
    typeAliases: new Map(),
    nodeTypesByEnd: new Map(),
    functionNodeTypes: new Map(),
    curriedNodes: new Set(),
    topLevelBindings: new Map(),
    dataVariantNames: new Set(),
    unconstrainedPropAccesses: new Set(),
    ...overrides,
  };
}
