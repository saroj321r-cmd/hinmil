// ============================================================================
// Code Actions — quick-fix suggestions for diagnostics
//
// Plain language: when a warning squiggle appears, the editor's lightbulb
// menu can offer one-click fixes.  This file builds those offers — e.g.
// "insert the inferred `::` annotation above this function" or "add a
// `::narrow` directive" — as ready-made text edits the editor applies.
// ============================================================================

import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  Diagnostic,
  TextEdit,
  Position,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceResult } from '../infer';
import {
  Scheme,
  prettyTypeToString,
  typeToString,
  tFun,
  tVoid,
} from '../hm/types';

// ---------------------------------------------------------------------------
// Diagnostic message patterns
// ---------------------------------------------------------------------------

// The message `diagnostics.ts` emits ("… has no HM annotation"); the older
// wording ("… has no HM type signature.") is still accepted for clients that
// send back a stored diagnostic.
const MISSING_SIGNATURE_PATTERN = /^(?:Function|Method|Variable) '(.+)' has no HM (?:annotation|type signature\.)$/;
const UNKNOWN_TYPE_PATTERN = /^Unknown type constructor '(\w+)'\./;
const UNRESOLVED_TYPES_PATH_PATTERN = /^Cannot resolve ::types path '(.+)'\.$/;

/** Matches: Method name 'mapp' does not match annotation 'Either2#map' */
const METHOD_NAME_MISMATCH_PATTERN = /^Method name '(.+)' does not match annotation '(?:.+#)?(.+)'$/;
/** Matches: Declaration name 'memoizee' does not match annotation name 'memoize' */
const DECL_NAME_MISMATCH_PATTERN = /^Declaration name '(.+)' does not match annotation name '(.+)'$/;
/** Matches: Missing constraint 'Monoid (f a)' required here; add it to the enclosing function's signature. */
const MISSING_CONSTRAINT_PATTERN = /^Missing constraint '(.+)' required here; add it to the enclosing function's signature\.$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeActionContext {
  /** Most recent inference result for the file. */
  result: InferenceResult;
  /** The text document. */
  textDocument: TextDocument;
  /** User preference: 'pretty' or 'raw'. */
  inferredTypeStyle: 'pretty' | 'raw';
  /**
   * Map of imported name → module specifier from the current file.
   * Used to suggest `// ::types` directives based on existing imports.
   */
  importSpecifierMap?: Map<string, string>;
}

const INDENT_RE = /^(\s*)/;

/** Get the leading whitespace of the line at `line` in `textDocument`. */
function getLineIndent(textDocument: TextDocument, line: number): string {
  const lineText = textDocument.getText({
    start: { line, character: 0 },
    end: { line: line + 1, character: 0 },
  });
  const m = INDENT_RE.exec(lineText);
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate code actions for the requested range and diagnostics.
 * Called by the LSP `textDocument/codeAction` handler.
 */
export function getCodeActions(
  params: CodeActionParams,
  ctx: CodeActionContext,
): CodeAction[] {
  const actions: CodeAction[] = [];
  const { textDocument, result, inferredTypeStyle } = ctx;
  const uri = params.textDocument.uri;

  // Track which lines already have an ignore action to avoid duplicates
  const seenIgnoreLines = new Set<number>();
  let addedIgnoreFile = false;

  for (const diag of params.context.diagnostics) {
    // Only handle our own diagnostics
    if (diag.source !== 'hinmil') continue;

    // --- Quick-fix: add missing HM annotation ---
    const match = MISSING_SIGNATURE_PATTERN.exec(diag.message);
    if (match) {
      const name = match[1];
      const action = buildAddAnnotationAction(name, diag, uri, ctx);
      if (action) actions.push(action);
    }

    // --- Quick-fix: add ::types directive for unknown type constructor ---
    const unknownMatch = UNKNOWN_TYPE_PATTERN.exec(diag.message);
    if (unknownMatch) {
      const typeName = unknownMatch[1];
      const typesAction = buildAddTypesDirectiveAction(typeName, diag, uri, ctx);
      if (typesAction) actions.push(typesAction);
    }

    // --- Quick-fix: rename to match annotation ---
    const methodMismatch = METHOD_NAME_MISMATCH_PATTERN.exec(diag.message);
    if (methodMismatch) {
      const action = buildRenameToMatchAnnotationAction(methodMismatch[1], methodMismatch[2], diag, uri);
      actions.push(action);
    }
    const declMismatch = DECL_NAME_MISMATCH_PATTERN.exec(diag.message);
    if (declMismatch) {
      const action = buildRenameToMatchAnnotationAction(declMismatch[1], declMismatch[2], diag, uri);
      actions.push(action);
    }

    // --- Quick-fix: add missing constraint to the enclosing signature ---
    const missingConstraint = MISSING_CONSTRAINT_PATTERN.exec(diag.message);
    if (missingConstraint) {
      const action = buildAddConstraintAction(missingConstraint[1], diag, uri, textDocument);
      if (action) actions.push(action);
    }

    // --- Quick-fix: ignore this line (deduplicate by line) ---
    const diagLine = diag.range.start.line;
    if (!seenIgnoreLines.has(diagLine)) {
      seenIgnoreLines.add(diagLine);
      actions.push(buildIgnoreLineAction(diag, uri, textDocument));
    }

    // --- Quick-fix: ignore this file (at most once) ---
    if (!addedIgnoreFile) {
      addedIgnoreFile = true;
      actions.push(buildIgnoreFileAction(diag, uri, textDocument));
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// "Add HM type annotation" action
// ---------------------------------------------------------------------------

/**
 * Format a Scheme as a human-readable annotation string, e.g.
 * `Functor f => (a -> b) -> f a -> f b`
 */
function formatScheme(scheme: Scheme, style: 'pretty' | 'raw'): string {
  const formatType = style === 'pretty' ? prettyTypeToString : typeToString;
  const typeStr = formatType(scheme.type);

  if (scheme.constraints && scheme.constraints.length > 0) {
    const renderC = (c: typeof scheme.constraints[0]): string => {
      if (c.unionAlternatives && c.unionAlternatives.length > 0) {
        const alts = c.unionAlternatives.map(a => {
          const s = formatType(a);
          return a.tag === 'TFun' ? `(${s})` : s;
        }).join(' | ');
        return `(${alts}) ${c.typeVarName}`;
      }
      return `${c.className} ${c.typeVarName}`;
    };
    const constraintStr = scheme.constraints.length === 1
      ? `${renderC(scheme.constraints[0])} => `
      : `(${scheme.constraints.map(renderC).join(', ')}) => `;
    return constraintStr + typeStr;
  }

  return typeStr;
}

/**
 * Look up the inferred type for a given name from the inference result.
 *
 * Checks `topLevelBindings` first (for top-level declarations), then
 * `exports` (for re-exported names).  For method annotations like
 * `ClassName#method`, we do not currently resolve the type — we fall
 * back to a placeholder.
 *
 * If the name is not found by name, falls back to looking up the AST node
 * type by offset (for nested declarations that don't appear in topLevelBindings).
 */
function lookupInferredScheme(
  name: string,
  result: InferenceResult,
  offset?: number,
): Scheme | null {
  // Method annotation name like "Box#map"
  if (name.includes('#')) {
    const [, methodName] = name.split('#');
    // Try to find by unqualified method name in topLevelBindings
    const s = result.topLevelBindings.get(methodName);
    if (s) return s;

    // Fallback: scan nodeTypes near the offset to find the RHS function type.
    // For prototype assignments (X.prototype.method = function() {...}) without
    // an annotation, the inferred type is recorded at the RHS expression start
    // — not at the property offset.  Scan forward within a small window.
    if (offset != null) {
      const entry = result.nodeTypes.get(offset);
      if (entry) {
        const resolved = result.substitution.apply(entry.type);
        // 0-param functions collapse to just the return type (tMultiFun([], r) === r).
        // For method annotations, wrap non-function types as () -> type.
        const wrapped = resolved.tag !== 'TFun' ? tFun(tVoid, resolved) : resolved;
        return { type: wrapped, vars: [] };
      }
      // Scan forward from offset to find the nearest recorded type
      for (let o = offset + 1; o <= offset + 100; o++) {
        const nearby = result.nodeTypes.get(o);
        if (nearby) {
          const resolved = result.substitution.apply(nearby.type);
          const wrapped = resolved.tag !== 'TFun' ? tFun(tVoid, resolved) : resolved;
          return { type: wrapped, vars: [] };
        }
      }
    }
    return null;
  }

  // Static method name like "Building.create"
  if (name.includes('.')) {
    if (offset != null) {
      const entry = result.nodeTypes.get(offset);
      if (entry) {
        const resolved = result.substitution.apply(entry.type);
        return { type: resolved, vars: [] };
      }
    }
    return null;
  }

  // Regular top-level binding
  const scheme = result.topLevelBindings.get(name);
  if (scheme) return scheme;

  // Exported name
  const exported = result.exports.get(name);
  if (exported) return exported;

  // Fallback: look up by AST node offset (for nested declarations)
  if (offset != null) {
    const entry = result.nodeTypes.get(offset);
    if (entry) {
      return { type: result.substitution.apply(entry.type), vars: [] };
    }
  }

  return null;
}

/**
 * Build a CodeAction that inserts `// name :: InferredType` above the
 * function declaration.
 */
function buildAddAnnotationAction(
  name: string,
  diag: Diagnostic,
  uri: string,
  ctx: CodeActionContext,
): CodeAction | null {
  const { result, textDocument, inferredTypeStyle } = ctx;

  // Compute the source offset of the diagnostic start for nodeTypes fallback
  const diagOffset = textDocument.offsetAt(diag.range.start);

  // Verify the source text at the diagnostic range matches the name
  const diagEndOffset = textDocument.offsetAt(diag.range.end);
  const sourceAtDiag = textDocument.getText({ start: diag.range.start, end: diag.range.end });
  // For qualified method names (e.g. "Animal#speak" or "Building.create"),
  // the diagnostic range covers only the method name ("speak" / "create"),
  // so also check the method part.
  const methodPart = name.includes('#') ? name.split('#')[1]
    : name.includes('.') ? name.split('.')[1]
    : undefined;
  const nameOffset = (sourceAtDiag === name || (methodPart && sourceAtDiag === methodPart))
    ? diagOffset : undefined;

  const scheme = lookupInferredScheme(name, result, nameOffset);
  const typeStr = scheme
    ? formatScheme(scheme, inferredTypeStyle)
    : null;

  if (!typeStr) return null;

  // Compute the annotation comment: `// name :: Type`
  const annotationComment = `// ${name} :: ${typeStr}`;

  // Insert on the line above the diagnostic range start
  const diagLine = diag.range.start.line;
  const indent = getLineIndent(textDocument, diagLine);

  const insertPos: Position = { line: diagLine, character: 0 };
  const insertText = `${indent}${annotationComment}\n`;

  return {
    title: `Add HM annotation: ${name} :: ${typeStr}`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    isPreferred: true,
    edit: {
      changes: {
        [uri]: [TextEdit.insert(insertPos, insertText)],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// "Add ::types directive" action
// ---------------------------------------------------------------------------

/**
 * Find the best ::types specifier for an unknown type name.
 *
 * Strategy:
 * 1. If the type name matches a module specifier (e.g. `Either2` and there's
 *    `import { Left } from './Either2'`), suggest that specifier.
 * 2. If the type name has a matching import specifier key, suggest that specifier.
 * 3. Otherwise suggest `./<TypeName>` as a reasonable default.
 */
function findTypesSpecifier(typeName: string, importSpecifierMap?: Map<string, string>): string {
  if (importSpecifierMap) {
    // Check if any import specifier's module path contains the type name
    // e.g. import { Left } from './Either2' → suggest './Either2' for type Either2
    for (const [, specifier] of importSpecifierMap) {
      const basename = specifier.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
      if (basename === typeName) {
        return specifier;
      }
    }
    // Check if the type name itself is imported
    if (importSpecifierMap.has(typeName)) {
      return importSpecifierMap.get(typeName)!;
    }
  }
  // Default: suggest ./<TypeName>
  return `./${typeName}`;
}

/**
 * Find the first line that is not a comment or empty, to insert `// ::types`
 * before all code but after existing directives and imports.
 */
function findTypesDirectiveInsertLine(source: string): number {
  const lines = source.split('\n');
  let lastDirectiveLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Track ::types, ::constraint directives and import/require lines
    if (trimmed.startsWith('// ::types') || trimmed.startsWith('// ::constraint') ||
        trimmed.startsWith('import ') ||
        /^(?:const|let|var)\s.*require\s*\(/.test(trimmed)) {
      lastDirectiveLine = i;
    }
  }
  // Insert after last directive/import, or at the top
  return lastDirectiveLine >= 0 ? lastDirectiveLine + 1 : 0;
}

/**
 * Build a CodeAction that inserts `// ::types <specifier>` at the top of the file
 * to resolve an unknown type constructor.
 */
function buildAddTypesDirectiveAction(
  typeName: string,
  diag: Diagnostic,
  uri: string,
  ctx: CodeActionContext,
): CodeAction | null {
  const source = ctx.textDocument.getText();
  const specifier = findTypesSpecifier(typeName, ctx.importSpecifierMap);

  // Don't offer if this ::types directive already exists
  if (source.includes(`::types ${specifier}`)) return null;

  const insertLine = findTypesDirectiveInsertLine(source);
  const insertPos: Position = { line: insertLine, character: 0 };
  const insertText = `// ::types ${specifier}\n`;

  return {
    title: `Add ::types directive: // ::types ${specifier}`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    isPreferred: true,
    edit: {
      changes: {
        [uri]: [TextEdit.insert(insertPos, insertText)],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// "Rename to match annotation" action
// ---------------------------------------------------------------------------

/**
 * Build a CodeAction that renames an identifier to match the expected name
 * from an HM annotation.
 *
 * Handles both:
 * - Method name mismatches: `mapp` → `map` (from `Either2#map`)
 * - Declaration name mismatches: `memoizee` → `memoize`
 */
function buildRenameToMatchAnnotationAction(
  actualName: string,
  expectedName: string,
  diag: Diagnostic,
  uri: string,
): CodeAction {
  return {
    title: `Rename '${actualName}' to '${expectedName}'`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    isPreferred: true,
    edit: {
      changes: {
        [uri]: [TextEdit.replace(diag.range, expectedName)],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// "Add missing constraint" action
// ---------------------------------------------------------------------------

/**
 * Build a CodeAction that adds a constraint required by a callee (e.g.
 * `Monoid (f a)`) to the enclosing function's `::` signature.
 *
 * The diagnostic carries the enclosing annotation's comment range as
 * related information (attached by `validateMissingConstraints`); the edit
 * rewrites the signature's constraint section in place:
 *
 *   no constraints:        `f a -> f a`          → `Monoid (f a) => f a -> f a`
 *   single constraint:     `Applicative f => …`  → `(Applicative f, Monoid (f a)) => …`
 *   parenthesised list:    `(A f, B f) => …`     → `(A f, B f, Monoid (f a)) => …`
 */
function buildAddConstraintAction(
  constraint: string,
  diag: Diagnostic,
  uri: string,
  textDocument: TextDocument,
): CodeAction | null {
  const related = diag.relatedInformation?.find(
    (ri) => ri.location.uri === uri && /enclosing function's signature/i.test(ri.message),
  );
  if (!related) return null;

  const annStart = textDocument.offsetAt(related.location.range.start);
  const annEnd = textDocument.offsetAt(related.location.range.end);
  const annText = textDocument.getText().slice(annStart, annEnd);

  // Locate the signature after the annotation's `::` separator.
  const sepMatch = /::\s*/.exec(annText);
  if (!sepMatch) return null;
  const sigStart = sepMatch.index + sepMatch[0].length;

  const arrowIdx = annText.indexOf('=>', sigStart);
  let edit: TextEdit;
  if (arrowIdx === -1) {
    // No constraint section yet — prepend `X => `.
    edit = TextEdit.insert(textDocument.positionAt(annStart + sigStart), `${constraint} => `);
  } else {
    const section = annText.slice(sigStart, arrowIdx);
    const trimmed = section.trim();
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      // Parenthesised list — insert before the closing paren.
      const closeIdx = sigStart + section.lastIndexOf(')');
      edit = TextEdit.insert(textDocument.positionAt(annStart + closeIdx), `, ${constraint}`);
    } else {
      // Single constraint — wrap both into a parenthesised list.
      const sectionStart = sigStart + (section.length - section.trimStart().length);
      const sectionEnd = sectionStart + trimmed.length;
      edit = TextEdit.replace(
        {
          start: textDocument.positionAt(annStart + sectionStart),
          end: textDocument.positionAt(annStart + sectionEnd),
        },
        `(${trimmed}, ${constraint})`,
      );
    }
  }

  return {
    title: `Add constraint '${constraint}' to the enclosing signature`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    isPreferred: true,
    edit: {
      changes: {
        [uri]: [edit],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// "Ignore this line" action
// ---------------------------------------------------------------------------

/**
 * Build a CodeAction that inserts `// ::ignore` on the line above the
 * diagnostic, suppressing that specific line.
 */
function buildIgnoreLineAction(
  diag: Diagnostic,
  uri: string,
  textDocument: TextDocument,
): CodeAction {
  const diagLine = diag.range.start.line;
  const indent = getLineIndent(textDocument, diagLine);

  const insertPos: Position = { line: diagLine, character: 0 };
  const insertText = `${indent}// ::ignore\n`;

  return {
    title: 'Ignore this line (::ignore)',
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    edit: {
      changes: {
        [uri]: [TextEdit.insert(insertPos, insertText)],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// "Ignore this file" action
// ---------------------------------------------------------------------------

/**
 * Build a CodeAction that inserts `// ::ignore-file` at the top of the file,
 * suppressing all diagnostics for the entire file.
 */
function buildIgnoreFileAction(
  diag: Diagnostic,
  uri: string,
  textDocument: TextDocument,
): CodeAction {
  const source = textDocument.getText();

  // Don't offer this if ::ignore-file is already present
  if (source.includes('::ignore-file')) {
    return {
      title: 'Ignore this file (::ignore-file)',
      kind: CodeActionKind.QuickFix,
      diagnostics: [diag],
      disabled: { reason: '::ignore-file is already present in this file.' },
      edit: { changes: {} },
    };
  }

  const insertPos: Position = { line: 0, character: 0 };
  const insertText = '// ::ignore-file\n';

  return {
    title: 'Ignore this file (::ignore-file)',
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    edit: {
      changes: {
        [uri]: [TextEdit.insert(insertPos, insertText)],
      },
    },
  };
}
