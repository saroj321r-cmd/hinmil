// ============================================================================
// Document Symbols — outline / breadcrumbs for navigation
//
// Plain language: powers the editor's Outline panel and the breadcrumb bar:
// a table of contents of the file (functions, classes, constants), each with
// its inferred type as detail text.
// ============================================================================

import {
  DocumentSymbol,
  SymbolKind,
  Range,
  Position,
} from 'vscode-languageserver/node';
import type * as estree from '../estree';
import { parseStrict } from '../parsing';
import { InferenceResult } from '../infer/types';
import { Scheme, prettyTypeToString, typeToString, Type } from '../hm/types';
import { extractDataDirectives } from '../commentParser';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentSymbolContext {
  /** Most recent inference result for the file. */
  result: InferenceResult;
  /** User preference: 'pretty' or 'raw'. */
  inferredTypeStyle: 'pretty' | 'raw';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a 0-based offset to an LSP Position. */
function positionAt(source: string, offset: number): Position {
  let line = 0;
  let character = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  return { line, character };
}

/** Build an LSP Range from two offsets within source. */
function rangeOf(source: string, start: number, end: number): Range {
  return Range.create(positionAt(source, start), positionAt(source, end));
}

/** Format a Scheme for the symbol detail string. */
function formatScheme(scheme: Scheme, style: 'pretty' | 'raw'): string {
  const fmt = style === 'pretty' ? prettyTypeToString : typeToString;
  const typeStr = fmt(scheme.type);
  if (scheme.constraints && scheme.constraints.length > 0) {
    const renderC = (c: typeof scheme.constraints[0]): string => {
      if (c.unionAlternatives && c.unionAlternatives.length > 0) {
        const alts = c.unionAlternatives.map(a => {
          const s = fmt(a);
          return a.tag === 'TFun' ? `(${s})` : s;
        }).join(' | ');
        return `(${alts}) ${c.typeVarName}`;
      }
      return `${c.className} ${c.typeVarName}`;
    };
    const cstr = scheme.constraints.length === 1
      ? `${renderC(scheme.constraints[0])} => `
      : `(${scheme.constraints.map(renderC).join(', ')}) => `;
    return cstr + typeStr;
  }
  return typeStr;
}

/**
 * Determine whether a Type looks like a function type.
 * Recognises both `TFun` (arrow) and `TCon("Function", ...)`.
 */
function isFunctionType(t: Type): boolean {
  if (t.tag === 'TFun') return true;
  if (t.tag === 'TCon' && t.name === 'Function') return true;
  return false;
}

/**
 * Determine whether a name is a constructor-like identifier
 * (starts with upper-case letter).
 */
function isConstructorName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/**
 * Choose an appropriate SymbolKind based on the name and inferred type.
 */
function classifySymbol(name: string, scheme: Scheme | undefined): SymbolKind {
  if (scheme && isFunctionType(scheme.type)) {
    // Uppercase + function → constructor / class-like
    if (isConstructorName(name)) return SymbolKind.Constructor;
    return SymbolKind.Function;
  }
  // Non-function values
  if (isConstructorName(name)) return SymbolKind.Constructor;
  return SymbolKind.Variable;
}

// ---------------------------------------------------------------------------
// AST walking
// ---------------------------------------------------------------------------

interface RawSymbol {
  name: string;
  /** Full range of the declaration (including annotation comment above). */
  fullStart: number;
  fullEnd: number;
  /** Selection range (just the identifier). */
  selStart: number;
  selEnd: number;
  /** If this is an exported declaration. */
  exported: boolean;
}

/**
 * Extract a declared name + its offsets from a VariableDeclarator node.
 * Handles normal identifiers; skips destructuring patterns (those appear
 * as separate individual bindings in nodeTypes).
 */
function extractDeclarator(
  declarator: estree.VariableDeclarator,
  declStart: number,
  declEnd: number,
): RawSymbol | null {
  if (declarator.id?.type === 'Identifier') {
    return {
      name: declarator.id.name,
      fullStart: declStart,
      fullEnd: declEnd,
      selStart: declarator.id.start,
      selEnd: declarator.id.end,
      exported: false,
    };
  }
  return null;
}

/**
 * Walk the top-level AST body and extract raw symbols.
 */
function extractRawSymbols(ast: estree.Program): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (const node of ast.body) {
    switch (node.type) {
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          const sym = extractDeclarator(decl, node.start, node.end);
          if (sym) symbols.push(sym);
        }
        break;

      case 'FunctionDeclaration':
        if (node.id) {
          symbols.push({
            name: node.id.name,
            fullStart: node.start,
            fullEnd: node.end,
            selStart: node.id.start,
            selEnd: node.id.end,
            exported: false,
          });
        }
        break;

      case 'ClassDeclaration':
        if (node.id) {
          symbols.push({
            name: node.id.name,
            fullStart: node.start,
            fullEnd: node.end,
            selStart: node.id.start,
            selEnd: node.id.end,
            exported: false,
          });
        }
        break;

      case 'ExportNamedDeclaration':
        if (node.declaration) {
          const inner = node.declaration;
          if (inner.type === 'VariableDeclaration') {
            for (const decl of inner.declarations) {
              const sym = extractDeclarator(decl, node.start, node.end);
              if (sym) {
                sym.exported = true;
                symbols.push(sym);
              }
            }
          } else if (inner.type === 'FunctionDeclaration' && inner.id) {
            symbols.push({
              name: inner.id.name,
              fullStart: node.start,
              fullEnd: node.end,
              selStart: inner.id.start,
              selEnd: inner.id.end,
              exported: true,
            });
          } else if (inner.type === 'ClassDeclaration' && inner.id) {
            symbols.push({
              name: inner.id.name,
              fullStart: node.start,
              fullEnd: node.end,
              selStart: inner.id.start,
              selEnd: inner.id.end,
              exported: true,
            });
          }
        }
        break;

      case 'ExportDefaultDeclaration':
        if (node.declaration) {
          const decl = node.declaration;
          const id = 'id' in decl ? decl.id : undefined;
          const name = id?.name ?? 'default';
          symbols.push({
            name,
            fullStart: node.start,
            fullEnd: node.end,
            selStart: id ? id.start : node.start,
            selEnd: id ? id.end : node.start + 'export default'.length,
            exported: true,
          });
        }
        break;
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate DocumentSymbol[] for the given source and inference result.
 *
 * The symbols are hierarchical:
 * - Top-level declarations (const, function, class, export) form the root.
 * - Method annotations (Name#method) are nested under the corresponding
 *   constructor/object symbol.
 * - sumtype declarations become Enum symbols with variant EnumMembers.
 * - Type aliases become Interface symbols.
 */
export function getDocumentSymbols(
  source: string,
  ctx: DocumentSymbolContext,
): DocumentSymbol[] {
  const { result, inferredTypeStyle } = ctx;

  // --- Parse AST ---
  let ast: estree.Program;
  try {
    ast = parseStrict(source);
  } catch {
    return [];
  }

  const rawSymbols = extractRawSymbols(ast);
  const symbols: DocumentSymbol[] = [];
  /** Map parent name → children (for method nesting). */
  const childrenByParent = new Map<string, DocumentSymbol[]>();

  // --- Collect method annotations (Name#method) and private members (Name##name) ---
  for (const [annName, ann] of result.annotations) {
    if (!annName.includes('#')) continue;
    // Detect the private form `Class##name` first; otherwise it would split
    // into `['Class', '', 'name']` and produce a DocumentSymbol with an
    // empty `name`, which the LSP client rejects with "name must not be falsy".
    const privIdx = annName.indexOf('##');
    let parentName: string;
    let methodName: string;
    let kind: SymbolKind;
    if (privIdx >= 0) {
      parentName = annName.slice(0, privIdx);
      methodName = '#' + annName.slice(privIdx + 2);
      kind = SymbolKind.Field;
    } else {
      const parts = annName.split('#', 2);
      parentName = parts[0];
      methodName = parts[1];
      kind = SymbolKind.Method;
    }
    if (!parentName || !methodName) continue;
    // Prefer the user's verbatim annotation text over a re-printed scheme.
    const detail = ann.raw ?? (ann.scheme ? formatScheme(ann.scheme, inferredTypeStyle) : undefined);

    const range = rangeOf(source, ann.commentStart, ann.commentEnd);
    const methodSym: DocumentSymbol = {
      name: methodName,
      detail,
      kind,
      range,
      selectionRange: range,
    };

    if (!childrenByParent.has(parentName)) {
      childrenByParent.set(parentName, []);
    }
    childrenByParent.get(parentName)!.push(methodSym);
  }

  // --- Collect static method annotations (Name.method) ---
  for (const [annName, ann] of result.annotations) {
    if (!annName.includes('.') || annName.includes('#')) continue;
    const dotIdx = annName.indexOf('.');
    const parentName = annName.slice(0, dotIdx);
    const methodName = annName.slice(dotIdx + 1);
    // Skip if it's not attached to a raw symbol
    if (!rawSymbols.some(s => s.name === parentName)) continue;
    // Prefer the user's verbatim annotation text over a re-printed scheme.
    const detail = ann.raw ?? (ann.scheme ? formatScheme(ann.scheme, inferredTypeStyle) : undefined);

    const range = rangeOf(source, ann.commentStart, ann.commentEnd);
    const methodSym: DocumentSymbol = {
      name: methodName,
      detail,
      kind: SymbolKind.Method,
      range,
      selectionRange: range,
    };

    if (!childrenByParent.has(parentName)) {
      childrenByParent.set(parentName, []);
    }
    childrenByParent.get(parentName)!.push(methodSym);
  }

  // --- Build top-level declaration symbols ---
  for (const raw of rawSymbols) {
    const scheme = result.topLevelBindings.get(raw.name)
      ?? result.exports.get(raw.name);
    const ann = result.annotations.get(raw.name);

    // Extend full range to include preceding annotation comment
    let fullStart = raw.fullStart;
    if (ann && ann.commentStart < fullStart) {
      fullStart = ann.commentStart;
    }

    const kind = raw.name === 'default'
      ? SymbolKind.Variable
      : classifySymbol(raw.name, scheme);

    // Prefer the user's verbatim annotation text when present, so the
    // outline matches exactly what was written.  Fall back to the
    // inferred/parsed scheme otherwise.
    const detail = ann?.raw
      ? ann.raw
      : scheme
        ? formatScheme(scheme, inferredTypeStyle)
        : ann?.scheme
          ? formatScheme(ann.scheme, inferredTypeStyle)
          : undefined;

    const sym: DocumentSymbol = {
      name: raw.name,
      detail,
      kind,
      range: rangeOf(source, fullStart, raw.fullEnd),
      selectionRange: rangeOf(source, raw.selStart, raw.selEnd),
      children: childrenByParent.get(raw.name),
    };

    symbols.push(sym);
  }

  // --- sumtype declarations → Enum + EnumMember children ---
  const dataDecls = extractDataDirectives(source);
  for (const decl of dataDecls) {
    // Don't duplicate if the name was already emitted as a regular symbol
    if (symbols.some(s => s.name === decl.name)) continue;

    const range = rangeOf(source, decl.commentStart, decl.commentEnd);
    const variantChildren: DocumentSymbol[] = decl.variants.map(v => {
      // Find the variant's constructor annotation for detail
      const variantAnn = result.annotations.get(v.name);
      const variantDetail = variantAnn?.raw
        ? variantAnn.raw
        : variantAnn?.scheme
          ? formatScheme(variantAnn.scheme, inferredTypeStyle)
          : v.fields.length > 0
            ? v.fields.join(' ')
            : undefined;

      return {
        name: v.name,
        detail: variantDetail,
        kind: SymbolKind.EnumMember,
        range,  // variants share the sumtype comment range
        selectionRange: range,
      } as DocumentSymbol;
    });

    // Add method annotations as children too
    const methods = childrenByParent.get(decl.name) ?? [];

    const sym: DocumentSymbol = {
      name: decl.name,
      detail: `${decl.typeVars.join(' ')}`,
      kind: SymbolKind.Enum,
      range,
      selectionRange: range,
      children: [...variantChildren, ...methods],
    };

    symbols.push(sym);
  }

  // --- Type aliases → Interface symbols ---
  for (const [name, alias] of result.typeAliases) {
    // Don't duplicate if already covered by a declaration or sumtype
    if (symbols.some(s => s.name === name)) continue;

    const range = rangeOf(source, alias.commentStart, alias.commentEnd);
    const detail = inferredTypeStyle === 'pretty'
      ? prettyTypeToString(alias.type)
      : typeToString(alias.type);

    symbols.push({
      name,
      detail,
      kind: SymbolKind.Interface,
      range,
      selectionRange: range,
    });
  }

  return symbols;
}
