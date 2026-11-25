// ============================================================================
// Diagnostics — LSP diagnostic creation and filtering helpers
//
// Plain language: this file turns the engine's internal findings into the
// squiggly underlines users see — mapping each finding to an editor warning
// with a location, severity and code — and then filters the list according
// to the user's settings (e.g. "trust my annotations", "hide missing-
// signature hints") so only wanted warnings reach the screen.
// ============================================================================

import {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticRelatedInformation,
  Location,
  Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceDiagnostic, InferenceResult } from '../infer';
import { DiagnosticLevel } from '../config';
import * as walk from '../walking';
import type * as estree from '../estree';
import { parseStrict } from '../parsing';
import { TypeAnnotation, extractPrototypeMethod, extractAnnotations } from '../commentParser';
import { getParentTypeName, isDataType } from '../registries/dataTypeRegistry';
import { classifyDiagnosticCode, HM_MISSING_SIGNATURE, HM_DUPLICATE_IMPORT, HM_CIRCULAR_IMPORT } from './diagnosticCodes';
import { prototypeToHashName } from './hover';
import { resolveImportSpecifier } from './files';

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

/**
 * Convert a {@link DiagnosticLevel} to the corresponding LSP
 * `DiagnosticSeverity` enum value, or `null` for `'off'` (the diagnostic
 * should be dropped entirely).
 */
export function levelToSeverity(level: DiagnosticLevel): DiagnosticSeverity | null {
  switch (level) {
    case 'off': return null;
    case 'hint': return DiagnosticSeverity.Hint;
    case 'information': return DiagnosticSeverity.Information;
    case 'warning': return DiagnosticSeverity.Warning;
    case 'error': return DiagnosticSeverity.Error;
  }
}

// ---------------------------------------------------------------------------
// Inference → LSP diagnostic mapping
// ---------------------------------------------------------------------------

/**
 * Convert inference-level diagnostics (offset-based) to LSP `Diagnostic`
 * objects.  Parse errors are filtered out (they are too noisy while the
 * user is still typing).
 *
 * @param inferDiags  Raw diagnostics produced by the inference engine.
 * @param textDocument  The LSP text document (used for offset → position conversion).
 * @param insertions  Insertion offsets from `normalizeArrayLiteralASI` — used
 *                    to map patched offsets back to the original source.
 * @param severityFor  Maps a diagnostic code to its configured LSP severity;
 *                     `null` drops the diagnostic (its category is `'off'`).
 *                     An engine-attached severity takes precedence over the
 *                     returned severity, but `null` still drops.
 */
export function mapInferenceDiagnostics(
  inferDiags: InferenceDiagnostic[],
  textDocument: TextDocument,
  insertions: number[],
  severityFor: (code: number) => DiagnosticSeverity | null,
  unmapOffset: (patchedOffset: number, insertions: number[]) => number,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const d of inferDiags) {
    if (d.message.startsWith('Parse error')) continue;
    const code = classifyDiagnosticCode(d.message);
    const severity = severityFor(code);
    if (severity === null) continue;
    const origStart = unmapOffset(d.start, insertions);
    const origEnd = unmapOffset(d.end, insertions);
    const startPos = textDocument.positionAt(origStart);
    const endPos = textDocument.positionAt(origEnd);
    const diag: Diagnostic = {
      severity: (d.severity as DiagnosticSeverity | undefined) ?? severity,
      range: { start: startPos, end: endPos },
      message: d.message,
      source: 'hinmil',
      code,
    };
    if (d.relatedInformation && d.relatedInformation.length > 0) {
      diag.relatedInformation = d.relatedInformation.map((ri) => {
        const riStart = unmapOffset(ri.start, insertions);
        const riEnd = unmapOffset(ri.end, insertions);
        return DiagnosticRelatedInformation.create(
          Location.create(
            textDocument.uri,
            Range.create(textDocument.positionAt(riStart), textDocument.positionAt(riEnd)),
          ),
          ri.message,
        );
      });
    }
    out.push(diag);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Missing-signature detection
// ---------------------------------------------------------------------------

/** Push a "missing HM type signature" diagnostic for a given node range. */
function pushMissingSigDiag(
  diagnostics: Diagnostic[],
  textDocument: TextDocument,
  severity: DiagnosticSeverity,
  start: number,
  end: number,
  label: string,
  name: string,
): void {
  diagnostics.push({
    severity,
    range: { start: textDocument.positionAt(start), end: textDocument.positionAt(end) },
    message: `${label} '${name}' has no HM annotation`,
    source: 'hinmil',
    code: HM_MISSING_SIGNATURE,
  });
}

/**
 * Check whether an annotation exists for a given declaration name.
 * Handles the `X$prototype$Y` ↔ `X#Y` aliasing convention.
 */
function hasAnnotation(annotations: Map<string, TypeAnnotation>, name: string): boolean {
  if (annotations.has(name)) return true;
  const alias = prototypeToHashName(name);
  return alias !== null && annotations.has(alias);
}

/**
 * Check whether *any* annotation (including parse-error ones that never made
 * it into the annotation map) exists for a given declaration name.  Used to
 * suppress "missing HM annotation" when the user has provided an annotation
 * with a syntax error — the parse-error diagnostic already covers that case.
 */
function hasAnnotationIncludingErrored(
  annotations: Map<string, TypeAnnotation>,
  erroredNames: Set<string>,
  name: string,
): boolean {
  if (hasAnnotation(annotations, name)) return true;
  if (erroredNames.has(name)) return true;
  const alias = prototypeToHashName(name);
  return alias !== null && erroredNames.has(alias);
}

/**
 * Check whether an annotation exists that is directly attached to a method
 * at a given offset (handles TypeName#method annotations, e.g. Maybe#map).
 */
function hasAnnotationAtOffset(annotations: Map<string, TypeAnnotation>, offset: number): boolean {
  for (const ann of annotations.values()) {
    if (ann.nodeStart === offset) return true;
  }
  return false;
}

/**
 * Check whether a parent-type method annotation exists for a given method name.
 * E.g. `Maybe#map :: Maybe a ~> ...` is a parent-type annotation that covers
 * all subtypes (Just, Nothing) even if they don't have their own annotation.
 * A parent-type annotation is one where the key's type name matches the
 * receiver's TCon name (e.g. Maybe#map has receiver Maybe).
 */
function hasParentMethodAnnotation(annotations: Map<string, TypeAnnotation>, className: string, methodName: string): boolean {
  const parentName = getParentTypeName(className);
  if (!parentName) return false;
  return annotations.has(`${parentName}#${methodName}`);
}

/**
 * True when `node` is a call to an already-annotated top-level binding, e.g.
 * `leftIdentity(C)` where `leftIdentity` has an HM annotation.  Such a value is
 * fully derivable by inference without any extra help.
 */
function isCallToAnnotatedFn(node: estree.Node | null | undefined, hasAnn: (name: string) => boolean): boolean {
  const call = node as estree.CallExpression | undefined;
  if (!call || call.type !== 'CallExpression') return false;
  const callee = call.callee as estree.Identifier | undefined;
  return callee?.type === 'Identifier' && hasAnn(callee.name);
}

/**
 * True when `node` is a plain reference to an already-annotated top-level
 * binding, e.g. the shorthand property in `({ associativity })` where
 * `associativity` has an HM annotation.
 */
function isRefToAnnotatedBinding(node: estree.Node | null | undefined, hasAnn: (name: string) => boolean): boolean {
  const ident = node as estree.Identifier | undefined;
  return ident?.type === 'Identifier' && hasAnn(ident.name);
}

/**
 * True when `obj` is a non-empty object literal whose every field value is
 * either a call to an already-annotated binding (see {@link isCallToAnnotatedFn})
 * or a direct reference to one (see {@link isRefToAnnotatedBinding}).
 */
function objectAllFieldsAnnotated(obj: estree.ObjectExpression, hasAnn: (name: string) => boolean): boolean {
  if (obj.type !== 'ObjectExpression' || obj.properties.length === 0) return false;
  for (const prop of obj.properties) {
    const p = prop as estree.Property;
    if (p.type !== 'Property' || p.computed) return false;
    if (!isCallToAnnotatedFn(p.value, hasAnn) && !isRefToAnnotatedBinding(p.value, hasAnn)) return false;
  }
  return true;
}

/**
 * True when `fn` is a function/arrow (possibly curried) whose ultimate return
 * value is an object literal whose fields are all calls to, or direct
 * references to, annotated bindings.  In that case inference can fully derive
 * the wrapper's type from the referenced definitions, so the "missing HM
 * annotation" warning is redundant.
 *
 * Handles `C => ({ ... })`, `C => a => ({ ... })`, `() => ({ law1, law2 })`,
 * and block bodies with a top-level `return { ... }`.
 */
function returnsAnnotatedObjectLiteral(
  fn: estree.AnyNode | null | undefined,
  hasAnn: (name: string) => boolean,
): boolean {
  const f = fn as (estree.ArrowFunctionExpression | estree.FunctionExpression | estree.FunctionDeclaration) | undefined;
  if (!f || (f.type !== 'ArrowFunctionExpression' && f.type !== 'FunctionExpression' && f.type !== 'FunctionDeclaration')) {
    return false;
  }
  let body: estree.Node | undefined = f.body;
  // Unwrap curried arrow/function chains: `C => a => ({ ... })`.
  while (body && (body.type === 'ArrowFunctionExpression' || body.type === 'FunctionExpression')) {
    body = (body as estree.ArrowFunctionExpression).body;
  }
  if (!body) return false;
  if (body.type === 'ObjectExpression') {
    return objectAllFieldsAnnotated(body as estree.ObjectExpression, hasAnn);
  }
  if (body.type === 'BlockStatement') {
    for (const st of (body as estree.BlockStatement).body) {
      if (st.type === 'ReturnStatement' && (st as estree.ReturnStatement).argument?.type === 'ObjectExpression') {
        return objectAllFieldsAnnotated((st as estree.ReturnStatement).argument as estree.ObjectExpression, hasAnn);
      }
    }
  }
  return false;
}

/** `curry ((a, b) => …)`, `curryN (3) (function (a, b, c) { … })`: a call
 *  whose only argument is a function literal. */
function wrapsOneFunctionLiteral(call: estree.CallExpression): boolean {
  if (call.arguments.length !== 1) return false;
  const arg = call.arguments[0] as estree.Node;
  return arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression';
}

/** `require ("x")`, `require ("x").y` or `require ("x") (…)`-style imports. */
function isRequireLike(node: estree.Node): boolean {
  let n: estree.Node | undefined = node;
  while (n && (n.type === 'CallExpression' || n.type === 'MemberExpression')) {
    if (n.type === 'CallExpression') {
      const callee = (n as estree.CallExpression).callee as estree.Node;
      if (callee.type === 'Identifier' && (callee as estree.Identifier).name === 'require') return true;
      n = callee;
    } else {
      n = (n as estree.MemberExpression).object as estree.Node;
    }
  }
  return false;
}

/**
 * Detect top-level function declarations and arrow/function-expression
 * bindings that lack an HM type annotation and produce an informational
 * diagnostic for each one.
 *
 * @param source  Original (un-patched) source code of the file.
 * @param textDocument  LSP text document for offset → position mapping.
 * @param annotations  Map of declaration names that *do* have an HM annotation.
 * @param fnSeverity  Severity for function/method diagnostics (null to skip).
 * @param varSeverity  Severity for non-function variable diagnostics (null to skip).
 */
export function detectMissingSignatures(
  source: string,
  textDocument: TextDocument,
  annotations: Map<string, TypeAnnotation>,
  fnSeverity: DiagnosticSeverity | null,
  varSeverity?: DiagnosticSeverity | null,
  isFunctionValuedAt?: (bindingStart: number) => boolean,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // Build a set of names whose annotation failed to parse.  These are *not*
  // in `annotations` (buildAnnotationMap drops failed entries), but the user
  // *did* provide an annotation — so we must not also report "missing HM
  // annotation" on top of the parse-error diagnostic.
  const erroredNames = new Set<string>();
  const erroredOffsets = new Set<number>();
  for (const ann of extractAnnotations(source)) {
    if (!ann.error) continue;
    if (ann.name) erroredNames.add(ann.name);
    if (ann.nodeStart !== undefined) erroredOffsets.add(ann.nodeStart);
  }

  const hasAnn = (name: string): boolean => hasAnnotationIncludingErrored(annotations, erroredNames, name);
  const hasAnnAtOffset = (offset: number): boolean =>
    hasAnnotationAtOffset(annotations, offset) || erroredOffsets.has(offset);

  try {
    const ast = parseStrict(source);
    for (const stmt of ast.body) {
      // Unwrap export wrappers
      const decl = (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration')
        && stmt.declaration ? stmt.declaration : stmt;

      // Case 1: function declarations — function foo() { ... }
      if (decl.type === 'FunctionDeclaration' && decl.id?.name && fnSeverity != null) {
        const name = decl.id.name;
        // A function whose name matches a registered sumtype carrier is
        // already "annotated" via the `// TypeName :: V1 | V2` directive.
        // A wrapper that returns an object literal built entirely from calls to
        // annotated bindings is fully derivable — no annotation needed.
        if (!hasAnn(name) && !isDataType(name) && !returnsAnnotatedObjectLiteral(decl, hasAnn)) {
          pushMissingSigDiag(diagnostics, textDocument, fnSeverity, decl.id.start, decl.id.end, 'Function', name);
        }
      }

      // Case 2: class declarations — check each method for missing signature
      if (decl.type === 'ClassDeclaration' && decl.id?.name && fnSeverity != null) {
        const className = decl.id.name;
        for (const member of (decl.body?.body ?? [])) {
          if (member.type !== 'MethodDefinition') continue;
          if (member.key?.type !== 'Identifier') continue;
          const methodName = member.key.name;
          if (methodName === 'constructor') continue;
          const isStatic = !!member.static;
          const qualifiedName = isStatic ? `${className}.${methodName}` : `${className}#${methodName}`;
          // Accept both ClassName#method and TypeName#method (e.g. Just#map or Maybe#map)
          if (!hasAnn(qualifiedName) && !hasAnnAtOffset(member.value?.start)
              && !hasParentMethodAnnotation(annotations, className, methodName)) {
            pushMissingSigDiag(diagnostics, textDocument, fnSeverity, member.key.start, member.key.end, 'Method', qualifiedName);
          }
        }
      }

      // Case 3: const/let/var bindings
      if (decl.type === 'VariableDeclaration') {
        for (const declarator of decl.declarations) {
          if ((declarator.id as estree.Identifier)?.name == null || !declarator.init) continue;
          const name = (declarator.id as estree.Identifier).name;
          // Sumtype carrier bindings (e.g. `const Param = function () {}`
          // beneath `// Param :: Path | Query`) are covered by the directive.
          if (!hasAnn(name) && !isDataType(name)) {
            // A point-free binding (partial application or composition of
            // existing functions: `pipe (map (prop ("total")), sum)`,
            // `subtract (__, 2.5)`) is fully derived from those functions and
            // is not asked for a signature.  A call that wraps one function
            // literal (`curry ((a, b) => …)`) defines a new function and is.
            if (declarator.init.type === 'CallExpression' && !isRequireLike(declarator.init)
                && !!isFunctionValuedAt?.(declarator.id.start)
                && !wrapsOneFunctionLiteral(declarator.init as estree.CallExpression)) continue;
            const isFn = declarator.init.type === 'ArrowFunctionExpression' ||
              declarator.init.type === 'FunctionExpression' ||
              // A function built by a call (`const f = curry (…)`,
              // `compose (g) (h)`) is a function too, judged by its INFERRED
              // type.  Imports (`require (…)`) are not definitions and are
              // never asked for a signature.
              (declarator.init.type === 'CallExpression' && !isRequireLike(declarator.init)
                && !!isFunctionValuedAt?.(declarator.id.start));
            // A function wrapper that returns an object literal built entirely
            // from calls to annotated bindings is fully derivable by inference.
            if (isFn && returnsAnnotatedObjectLiteral(declarator.init, hasAnn)) continue;
            const sev = isFn ? fnSeverity : varSeverity;
            if (sev == null) continue;
            const label = isFn ? 'Function' : 'Variable';
            pushMissingSigDiag(diagnostics, textDocument, sev, declarator.id.start, declarator.id.end, label, name);
          }
        }
      }
      // Case 4: prototype method assignments — X.prototype.method = function() { ... }
      if (fnSeverity != null
          && decl.type === 'ExpressionStatement'
          && decl.expression?.type === 'AssignmentExpression'
          && decl.expression.left?.type === 'MemberExpression'
          && !decl.expression.left.computed
          && (decl.expression.right?.type === 'FunctionExpression'
              || decl.expression.right?.type === 'ArrowFunctionExpression')) {
        const proto = extractPrototypeMethod(decl.expression.left as estree.MemberExpression);
        if (proto) {
          const qualifiedName = `${proto.typeName}#${proto.methodName}`;
          if (!hasAnn(qualifiedName)
              && !hasAnnAtOffset(decl.expression.right.start)
              && !hasParentMethodAnnotation(annotations, proto.typeName, proto.methodName)) {
            const propNode = decl.expression.left.property;
            pushMissingSigDiag(diagnostics, textDocument, fnSeverity, propNode.start, propNode.end, 'Method', qualifiedName);
          }
        }
      }

      // Case 5: static method assignment — X.method = function() { ... }
      // (non-prototype: obj.prop = fn where obj is a simple Identifier)
      if (fnSeverity != null
          && decl.type === 'ExpressionStatement'
          && decl.expression?.type === 'AssignmentExpression'
          && decl.expression.left?.type === 'MemberExpression'
          && !decl.expression.left.computed
          && decl.expression.left.object?.type === 'Identifier'
          && decl.expression.left.property?.type === 'Identifier'
          && (decl.expression.right?.type === 'FunctionExpression'
              || decl.expression.right?.type === 'ArrowFunctionExpression')) {
        // Skip prototype assignments (handled by Case 4 above)
        const proto = extractPrototypeMethod(decl.expression.left as estree.MemberExpression);
        if (!proto) {
          const objName = (decl.expression.left.object as estree.Identifier).name;
          const propName = (decl.expression.left.property as estree.Identifier).name;
          // Skip module.exports and exports.X
          if (objName !== 'module' && objName !== 'exports') {
            const qualifiedName = `${objName}.${propName}`;
            if (!hasAnn(qualifiedName)
                && !hasAnnAtOffset(decl.expression.right.start)) {
              const propNode = decl.expression.left.property;
              pushMissingSigDiag(diagnostics, textDocument, fnSeverity, propNode.start, propNode.end, 'Method', qualifiedName);
            }
          }
        }
      }
    }

    // Case 6: nested bindings inside function bodies
    detectNestedMissingSignatures(ast, annotations, erroredNames, erroredOffsets, textDocument, fnSeverity, varSeverity ?? null, diagnostics);

  } catch {
    // AST parse failed — skip missing-signature check
  }

  return diagnostics;
}


// ---------------------------------------------------------------------------
// Nested missing-signature detection
// ---------------------------------------------------------------------------

/**
 * Walk all function bodies looking for `const x = fn => ...` or
 * `const x = function(...) { ... }` bindings that lack an HM annotation.
 */
function detectNestedMissingSignatures(
  ast: estree.Program,
  annotations: Map<string, TypeAnnotation>,
  erroredNames: Set<string>,
  erroredOffsets: Set<number>,
  textDocument: TextDocument,
  fnSeverity: DiagnosticSeverity | null,
  varSeverity: DiagnosticSeverity | null,
  diagnostics: Diagnostic[],
): void {
  // Collect all top-level declaration names so we can skip them (already handled).
  const topLevelStarts = new Set<number>();
  for (const stmt of ast.body) {
    topLevelStarts.add(stmt.start);
    const decl = (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration')
      && stmt.declaration ? stmt.declaration : stmt;
    if (decl !== stmt) topLevelStarts.add(decl.start);
  }

  // Helper: check if a nested function name is covered by any annotation
  function isNestedFunctionAnnotated(name: string, nodeStart: number): boolean {
    // Check: does any annotation point to this node's offset?
    if (hasAnnotationAtOffset(annotations, nodeStart)) return true;
    if (erroredOffsets.has(nodeStart)) return true;
    // Also accept if the name is directly annotated
    if (annotations.has(name)) return true;
    if (erroredNames.has(name)) return true;
    // Also accept method-style annotations (e.g. Either2#map for a nested `const map = ...`)
    return [...annotations.keys()].some(key => key.endsWith('#' + name));
  }

  walk.simple(ast, {
    VariableDeclaration(node: estree.VariableDeclaration) {
      // Only care about nested declarations (inside function bodies)
      if (topLevelStarts.has(node.start)) return;

      for (const declarator of node.declarations) {
        const id = declarator.id as estree.Identifier;
        if (!id?.name || !declarator.init) continue;

        const name = id.name as string;
        if (isNestedFunctionAnnotated(name, declarator.init.start)) continue;
        if (isDataType(name)) continue;

        const isFn = declarator.init.type === 'ArrowFunctionExpression' ||
          declarator.init.type === 'FunctionExpression';
        const sev = isFn ? fnSeverity : varSeverity;
        if (sev == null) continue;
        const label = isFn ? 'Function' : 'Variable';
        pushMissingSigDiag(diagnostics, textDocument, sev, id.start, id.end, label, name);
      }
    },
    FunctionDeclaration(node: estree.FunctionDeclaration | estree.AnonymousFunctionDeclaration) {
      // Only care about nested declarations (inside function bodies)
      if (topLevelStarts.has(node.start)) return;
      if (!node.id?.name) return;
      if (fnSeverity == null) return;

      const name = node.id.name;
      if (isNestedFunctionAnnotated(name, node.start)) return;
      if (isDataType(name)) return;

      pushMissingSigDiag(diagnostics, textDocument, fnSeverity, node.id.start, node.id.end, 'Function', name);
    },
  });
}

// ---------------------------------------------------------------------------
// Ignored-line filtering
// ---------------------------------------------------------------------------

/**
 * Remove diagnostics whose start line appears in the set of ignored lines
 * (from `::ignore` / `::ignore-function` directives).
 */
export function filterIgnoredDiagnostics(
  diagnostics: Diagnostic[],
  ignoredLines: Set<number>,
): Diagnostic[] {
  return diagnostics.filter((d) => !ignoredLines.has(d.range.start.line));
}

// ---------------------------------------------------------------------------
// Annotation mismatch filtering (trustAnnotations)
// ---------------------------------------------------------------------------

/** Patterns that indicate a diagnostic was caused by an annotation vs inferred type mismatch. */
const ANNOTATION_MISMATCH_PATTERNS = [
  'Type mismatch: implementation does not match annotation',
  'Type mismatch: function returns',
];

/** Regex matching the unified annotation-mismatch message format. */
const UNIFIED_MISMATCH_RE = /^Type mismatch: ('[^']+'|value) has (return )?type /;

/**
 * Filter out diagnostics that are caused by a mismatch between the
 * user-written annotation and the inferred type.  Used when the
 * `trustAnnotations` setting is enabled.
 */
export function filterAnnotationMismatchDiagnostics(
  diagnostics: InferenceDiagnostic[],
): InferenceDiagnostic[] {
  return diagnostics.filter((d) =>
    !ANNOTATION_MISMATCH_PATTERNS.some((p) => d.message.startsWith(p)) &&
    !UNIFIED_MISMATCH_RE.test(d.message),
  );
}

// ---------------------------------------------------------------------------
// Binding-body filtering (trustAnnotations: 'annotated-bodies' / 'all-bodies')
// ---------------------------------------------------------------------------

/**
 * Drop any diagnostic whose `[start, end]` source range lies entirely
 * inside one of the supplied intervals.
 *
 * Pure / knowledge-free: callers decide which intervals to pass.  The
 * comparison is inclusive at both ends so a diagnostic that exactly
 * coincides with a binding's extent is treated as inside that binding.
 */
export function filterDiagnosticsInsideBindings(
  diagnostics: InferenceDiagnostic[],
  intervals: ReadonlyArray<readonly [number, number]>,
): InferenceDiagnostic[] {
  if (intervals.length === 0) return diagnostics;
  return diagnostics.filter((d) => {
    for (const [s, e] of intervals) {
      if (d.start >= s && d.end <= e) return false;
    }
    return true;
  });
}

/**
 * Collect `[start, end]` source ranges of bindings from an
 * {@link InferenceResult} for use with
 * {@link filterDiagnosticsInsideBindings}.
 *
 * Reads `result.bindingExtents` (populated by the inference engine):
 *  - `'annotated'`: only extents flagged `annotated: true`.
 *  - `'all'`:       every extent regardless of annotation.
 *
 * Returns an empty array when the engine did not publish extents
 * (older results / non-default code paths) — conservative: never
 * suppress diagnostics in code we cannot bound.
 */
export function collectBindingIntervals(
  result: InferenceResult,
  mode: 'annotated' | 'all',
): Array<[number, number]> {
  const extents = result.bindingExtents;
  if (!extents) return [];
  const out: Array<[number, number]> = [];
  for (const ext of extents) {
    if (mode === 'annotated' && !ext.annotated) continue;
    out.push([ext.start, ext.end]);
  }
  return out;
}


// ---------------------------------------------------------------------------
// Import diagnostics — duplicate & circular import scans
// ---------------------------------------------------------------------------

/**
 * Scan the source for `import` statements that bind a name which was
 * already imported earlier in the file, and produce one warning per
 * duplicate binding.
 */
export function detectDuplicateImports(source: string, textDocument: TextDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seenImports = new Map<string, number>();
  const dupRe = /^import\s+(?:(\w+)|\{([^}]+)\}|\*\s+as\s+(\w+))\s+from\s+['"][^'"]+['"];?\s*$/gm;
  let dm;
  while ((dm = dupRe.exec(source)) !== null) {
    const names: string[] = [];
    if (dm[1]) names.push(dm[1]);
    if (dm[3]) names.push(dm[3]);
    if (dm[2]) {
      for (const part of dm[2].split(',')) {
        const t = part.trim();
        const as = t.match(/\w+\s+as\s+(\w+)/);
        names.push(as ? as[1] : t);
      }
    }
    for (const name of names) {
      if (seenImports.has(name)) {
        const start = textDocument.positionAt(dm.index);
        const end = textDocument.positionAt(dm.index + dm[0].length);
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: { start, end },
          message: `Duplicate import: '${name}' is already imported`,
          source: 'hinmil',
          code: HM_DUPLICATE_IMPORT,
        });
      } else {
        seenImports.set(name, dm.index);
      }
    }
  }
  return diagnostics;
}

/**
 * Produce a warning for every `import ... from '<spec>'` whose resolved
 * target participates in a circular dependency chain with this file.
 * `circularDeps` is the set of URIs on a cycle through `textDocument.uri`
 * (as reported by the import context).
 */
export function detectCircularImports(
  source: string,
  textDocument: TextDocument,
  circularDeps: Set<string>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (circularDeps.size === 0) return diagnostics;
  const importRe = /^import\s+(?:\w+|\{[^}]+\}|\*\s+as\s+\w+)\s+from\s+['"]([^'"]+)['"];?\s*$/gm;
  let im;
  while ((im = importRe.exec(source)) !== null) {
    const specifier = im[1];
    const targetUri = resolveImportSpecifier(specifier, textDocument.uri);
    if (targetUri && circularDeps.has(targetUri)) {
      const start = textDocument.positionAt(im.index);
      const end = textDocument.positionAt(im.index + im[0].length);
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: { start, end },
        message: `Circular import: '${specifier}' is part of a circular dependency chain`,
        source: 'hinmil',
        code: HM_CIRCULAR_IMPORT,
      });
    }
  }
  return diagnostics;
}
