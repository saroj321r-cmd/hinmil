// ============================================================================
// References & Rename — scope-aware identifier reference collection
//
// Performs a post-hoc AST walk (separate from inference) to build a map of
// every identifier back to its declaring binding.  This powers:
//   • textDocument/references   — Find All References
//   • textDocument/rename       — Rename Symbol
//   • textDocument/prepareRename
// ============================================================================

import type * as estree from '../estree';
import { parseStrict } from '../parsing';
import { InferenceResult } from '../infer/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IdentifierLocation {
  /** 0-based start offset in source. */
  start: number;
  /** 0-based end offset in source. */
  end: number;
  /** Whether this occurrence is the declaration site. */
  isDefinition: boolean;
}

export interface ReferenceGroup {
  /** The declared name. */
  name: string;
  /** All occurrences (declaration + usages) sorted by start offset. */
  locations: IdentifierLocation[];
  /** Start offset of the annotation name, if an HM annotation exists. */
  annotationNameStart?: number;
  /** End offset of the annotation name in the annotation comment. */
  annotationNameEnd?: number;
}

// ---------------------------------------------------------------------------
// Scope tracking
// ---------------------------------------------------------------------------

interface Scope {
  /** Maps a variable name to the unique key for the binding. */
  bindings: Map<string, number>;
}

/**
 * Allocate a globally unique binding id. Each distinct binding in the source
 * gets its own id — even if two bindings share the same name (shadowing).
 */
let nextBindingId = 0;
function freshBindingId(): number {
  return nextBindingId++;
}

// ---------------------------------------------------------------------------
// Core: collectReferences
// ---------------------------------------------------------------------------

/**
 * Parse the source and walk the AST with scope tracking.  Returns a Map
 * keyed by **binding id** to all reference locations.
 *
 * The binding id is an ephemeral number that uniquely identifies a binding
 * (i.e. a specific `const x`, `let y`, or function parameter).  Two
 * different `x` variables in nested scopes get different ids.
 */
export function collectReferences(
  source: string,
  result?: InferenceResult,
): Map<number, ReferenceGroup> {
  nextBindingId = 0;

  let ast: estree.Program;
  try {
    ast = parseStrict(source);
  } catch { /* parse error — no references to collect */
    return new Map();
  }

  const groups = new Map<number, ReferenceGroup>();
  const scopes: Scope[] = [{ bindings: new Map() }]; // global scope

  // --- scope helpers -------------------------------------------------------

  function currentScope(): Scope {
    return scopes[scopes.length - 1];
  }

  function pushScope(): Scope {
    const s: Scope = { bindings: new Map() };
    scopes.push(s);
    return s;
  }

  function popScope(): void {
    scopes.pop();
  }

  /** Declare a new binding in the current scope and record the definition location. */
  function declare(name: string, start: number, end: number): number {
    const id = freshBindingId();
    currentScope().bindings.set(name, id);
    const group: ReferenceGroup = {
      name,
      locations: [{ start, end, isDefinition: true }],
    };

    // Attach annotation info if available
    if (result) {
      const ann = result.annotations.get(name);
      if (ann && ann.commentStart !== undefined && ann.commentEnd !== undefined) {
        // Find the name offset within the annotation comment text
        const commentText = source.slice(ann.commentStart, ann.commentEnd);
        const nameIdx = findAnnotationNameOffset(commentText, name);
        if (nameIdx >= 0) {
          group.annotationNameStart = ann.commentStart + nameIdx;
          group.annotationNameEnd = ann.commentStart + nameIdx + name.length;
        }
      }
    }

    groups.set(id, group);
    return id;
  }

  /** Look up a name in the scope chain (innermost first). */
  function resolve(name: string): number | undefined {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const id = scopes[i].bindings.get(name);
      if (id !== undefined) return id;
    }
    return undefined;
  }

  /** Record a usage (non-definition) reference for an already-resolved binding. */
  function recordUsage(id: number, start: number, end: number): void {
    const group = groups.get(id);
    if (group) {
      group.locations.push({ start, end, isDefinition: false });
    }
  }

  // --- pattern helpers (destructuring) ------------------------------------

  /** Declare all bindings introduced by a pattern node (Identifier, ObjectPattern, ArrayPattern, RestElement, AssignmentPattern). */
  function declarePattern(node: any): void {
    if (!node) return;
    switch (node.type) {
      case 'Identifier':
        declare(node.name, node.start, node.end);
        break;
      case 'ObjectPattern':
        for (const prop of node.properties) {
          if (prop.type === 'RestElement') {
            declarePattern(prop.argument);
          } else {
            declarePattern(prop.value);
          }
        }
        break;
      case 'ArrayPattern':
        for (const el of node.elements) {
          if (el) declarePattern(el);
        }
        break;
      case 'RestElement':
        declarePattern(node.argument);
        break;
      case 'AssignmentPattern':
        declarePattern(node.left);
        walkExpr(node.right);
        break;
    }
  }

  // --- expression walker ---------------------------------------------------

  function walkExpr(node: any): void {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': {
        const id = resolve(node.name);
        if (id !== undefined) {
          recordUsage(id, node.start, node.end);
        }
        break;
      }

      case 'MemberExpression':
        walkExpr(node.object);
        if (node.computed) walkExpr(node.property);
        break;

      case 'CallExpression':
      case 'NewExpression':
        walkExpr(node.callee);
        for (const arg of node.arguments) walkExpr(arg);
        break;

      case 'ArrayExpression':
        for (const el of node.elements) {
          if (el) {
            if (el.type === 'SpreadElement') walkExpr(el.argument);
            else walkExpr(el);
          }
        }
        break;

      case 'ObjectExpression':
        for (const prop of node.properties) {
          if (prop.type === 'SpreadElement') {
            walkExpr(prop.argument);
          } else {
            if (prop.computed) walkExpr(prop.key);
            walkExpr(prop.value);
          }
        }
        break;

      case 'ArrowFunctionExpression':
      case 'FunctionExpression': {
        pushScope();
        if (node.id) declare(node.id.name, node.id.start, node.id.end);
        for (const param of node.params) declarePattern(param);
        if (node.body.type === 'BlockStatement') {
          walkBlock(node.body);
        } else {
          walkExpr(node.body);
        }
        popScope();
        break;
      }

      case 'AssignmentExpression':
        // Left side: if it's an identifier, it's a usage (write), not a declaration
        if (node.left.type === 'Identifier') {
          const id = resolve(node.left.name);
          if (id !== undefined) recordUsage(id, node.left.start, node.left.end);
        } else {
          walkExpr(node.left);
        }
        walkExpr(node.right);
        break;

      case 'UpdateExpression':
        walkExpr(node.argument);
        break;

      case 'UnaryExpression':
        walkExpr(node.argument);
        break;

      case 'BinaryExpression':
      case 'LogicalExpression':
        walkExpr(node.left);
        walkExpr(node.right);
        break;

      case 'ConditionalExpression':
        walkExpr(node.test);
        walkExpr(node.consequent);
        walkExpr(node.alternate);
        break;

      case 'SequenceExpression':
        for (const expr of node.expressions) walkExpr(expr);
        break;

      case 'TemplateLiteral':
        for (const expr of node.expressions) walkExpr(expr);
        break;

      case 'TaggedTemplateExpression':
        walkExpr(node.tag);
        for (const expr of node.quasi.expressions) walkExpr(expr);
        break;

      case 'SpreadElement':
        walkExpr(node.argument);
        break;

      case 'YieldExpression':
        if (node.argument) walkExpr(node.argument);
        break;

      case 'AwaitExpression':
        if (node.argument) walkExpr(node.argument);
        break;

      case 'ClassExpression': {
        pushScope();
        if (node.id) declare(node.id.name, node.id.start, node.id.end);
        if (node.superClass) walkExpr(node.superClass);
        walkClassBody(node.body);
        popScope();
        break;
      }

      // Literals, ThisExpression, MetaProperty — no identifiers
      default:
        break;
    }
  }

  // --- statement walker ----------------------------------------------------

  function walkStmt(node: any): void {
    if (!node) return;
    switch (node.type) {
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          // Walk initializer first (it can't reference `decl.id` in const)
          if (decl.init) walkExpr(decl.init);
          declarePattern(decl.id);
        }
        break;

      case 'FunctionDeclaration': {
        // Function declarations are hoisted — declare in current scope
        if (node.id) declare(node.id.name, node.id.start, node.id.end);
        pushScope();
        for (const param of node.params) declarePattern(param);
        if (node.body) walkBlock(node.body);
        popScope();
        break;
      }

      case 'ClassDeclaration': {
        if (node.id) declare(node.id.name, node.id.start, node.id.end);
        pushScope();
        if (node.superClass) walkExpr(node.superClass);
        walkClassBody(node.body);
        popScope();
        break;
      }

      case 'ExpressionStatement':
        walkExpr(node.expression);
        break;

      case 'ReturnStatement':
        if (node.argument) walkExpr(node.argument);
        break;

      case 'ThrowStatement':
        if (node.argument) walkExpr(node.argument);
        break;

      case 'IfStatement':
        walkExpr(node.test);
        walkStmt(node.consequent);
        if (node.alternate) walkStmt(node.alternate);
        break;

      case 'WhileStatement':
      case 'DoWhileStatement':
        walkExpr(node.test);
        walkStmt(node.body);
        break;

      case 'ForStatement': {
        pushScope();
        if (node.init) {
          if (node.init.type === 'VariableDeclaration') walkStmt(node.init);
          else walkExpr(node.init);
        }
        if (node.test) walkExpr(node.test);
        if (node.update) walkExpr(node.update);
        walkStmt(node.body);
        popScope();
        break;
      }

      case 'ForInStatement':
      case 'ForOfStatement': {
        pushScope();
        if (node.left.type === 'VariableDeclaration') walkStmt(node.left);
        else walkExpr(node.left);
        walkExpr(node.right);
        walkStmt(node.body);
        popScope();
        break;
      }

      case 'SwitchStatement': {
        walkExpr(node.discriminant);
        for (const c of node.cases) {
          if (c.test) walkExpr(c.test);
          for (const s of c.consequent) walkStmt(s);
        }
        break;
      }

      case 'TryStatement': {
        walkBlock(node.block);
        if (node.handler) {
          pushScope();
          if (node.handler.param) declarePattern(node.handler.param);
          walkBlock(node.handler.body);
          popScope();
        }
        if (node.finalizer) walkBlock(node.finalizer);
        break;
      }

      case 'BlockStatement':
        walkBlock(node);
        break;

      case 'LabeledStatement':
        walkStmt(node.body);
        break;

      // Import/Export
      case 'ImportDeclaration':
        for (const spec of node.specifiers) {
          if (spec.local) declare(spec.local.name, spec.local.start, spec.local.end);
        }
        break;

      case 'ExportNamedDeclaration':
        if (node.declaration) walkStmt(node.declaration);
        // export { x, y } — these are usages of existing bindings
        if (node.specifiers) {
          for (const spec of node.specifiers) {
            if (spec.local) {
              const id = resolve(spec.local.name);
              if (id !== undefined) recordUsage(id, spec.local.start, spec.local.end);
            }
          }
        }
        break;

      case 'ExportDefaultDeclaration':
        if (node.declaration) {
          if (node.declaration.type === 'FunctionDeclaration' || node.declaration.type === 'ClassDeclaration') {
            walkStmt(node.declaration);
          } else {
            walkExpr(node.declaration);
          }
        }
        break;

      case 'ExportAllDeclaration':
        // no local identifiers
        break;

      // Skip empty, debugger, break, continue
      default:
        break;
    }
  }

  function walkBlock(block: any): void {
    if (!block || !block.body) return;
    // Hoist function declarations first
    for (const stmt of block.body) {
      if (stmt.type === 'FunctionDeclaration' && stmt.id) {
        declare(stmt.id.name, stmt.id.start, stmt.id.end);
      }
    }
    for (const stmt of block.body) {
      // Skip hoisted function declarations (already declared above)
      if (stmt.type === 'FunctionDeclaration') {
        pushScope();
        for (const param of stmt.params) declarePattern(param);
        if (stmt.body) walkBlock(stmt.body);
        popScope();
        continue;
      }
      walkStmt(stmt);
    }
  }

  function walkClassBody(body: any): void {
    if (!body || !body.body) return;
    for (const node of body.body) {
      if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
        if (node.computed && node.key) walkExpr(node.key);
        if (node.value) walkExpr(node.value);
      }
    }
  }

  // --- Run the walker on top-level body -------
  // Hoist function declarations at the top level
  for (const stmt of ast.body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) {
      declare(stmt.id.name, stmt.id.start, stmt.id.end);
    }
  }
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration') {
      // Already declared above; just walk the body
      pushScope();
      for (const param of node.params) declarePattern(param);
      if (node.body) walkBlock(node.body);
      popScope();
      continue;
    }
    walkStmt(node);
  }

  return groups;
}

// ---------------------------------------------------------------------------
// findReferencesAtOffset
// ---------------------------------------------------------------------------

/**
 * Given a source offset (cursor position), find the reference group that
 * the identifier at that offset belongs to.  Returns null if the offset
 * does not land on a known identifier.
 */
export function findReferencesAtOffset(
  source: string,
  offset: number,
  result?: InferenceResult,
): ReferenceGroup | null {
  const groups = collectReferences(source, result);

  for (const [, group] of groups) {
    for (const loc of group.locations) {
      if (offset >= loc.start && offset <= loc.end) {
        return group;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// collectScopeBindings — all identifiers visible at a given offset
// ---------------------------------------------------------------------------

/**
 * Return the names of all bindings that are in scope at the given source
 * offset, mapped to their declaration start offset.  This includes module-level
 * declarations, function parameters, local variables, and imports.
 */
export function collectScopeBindings(source: string, offset: number): Map<string, number> {
  let ast: estree.Program;
  try {
    ast = parseStrict(source);
  } catch { /* parse error — no scope bindings available */
    return new Map();
  }

  const names = new Map<string, number>();

  /** Collect names from a pattern node (Identifier, destructuring). */
  function collectPattern(node: any): void {
    if (!node) return;
    switch (node.type) {
      case 'Identifier':
        names.set(node.name, node.start);
        break;
      case 'ObjectPattern':
        for (const prop of node.properties) {
          if (prop.type === 'RestElement') collectPattern(prop.argument);
          else collectPattern(prop.value);
        }
        break;
      case 'ArrayPattern':
        for (const el of node.elements) {
          if (el) collectPattern(el);
        }
        break;
      case 'RestElement':
        collectPattern(node.argument);
        break;
      case 'AssignmentPattern':
        collectPattern(node.left);
        break;
    }
  }

  function contains(node: any): boolean {
    return node.start <= offset && offset <= node.end;
  }

  /** Walk a block, collecting declarations and recursing into containing scopes. */
  function walkBlock(body: any[]): void {
    // Hoist function declarations
    for (const stmt of body) {
      if (stmt.type === 'FunctionDeclaration' && stmt.id) {
        names.set(stmt.id.name, stmt.id.start);
      }
    }
    for (const stmt of body) {
      walkStmt(stmt);
    }
  }

  function walkStmt(node: any): void {
    if (!node) return;
    switch (node.type) {
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          if (decl.init && contains(decl.init)) {
            // Cursor is in the initializer — the variable itself isn't in scope yet
            walkExpr(decl.init);
          } else {
            collectPattern(decl.id);
          }
        }
        break;
      case 'FunctionDeclaration':
        // Already hoisted; only recurse into body if cursor is inside
        if (contains(node)) {
          for (const param of node.params) collectPattern(param);
          if (node.body) walkBlock(node.body.body ?? []);
        }
        break;
      case 'ClassDeclaration':
        if (node.id) names.set(node.id.name, node.id.start);
        if (contains(node) && node.body) walkClassBody(node.body);
        break;
      case 'ExpressionStatement':
        if (contains(node)) walkExpr(node.expression);
        break;
      case 'ReturnStatement':
        if (node.argument && contains(node)) walkExpr(node.argument);
        break;
      case 'IfStatement':
        if (contains(node)) {
          walkExpr(node.test);
          walkStmt(node.consequent);
          if (node.alternate) walkStmt(node.alternate);
        }
        break;
      case 'ForStatement':
        if (contains(node)) {
          if (node.init) {
            if (node.init.type === 'VariableDeclaration') walkStmt(node.init);
            else walkExpr(node.init);
          }
          walkStmt(node.body);
        }
        break;
      case 'ForInStatement':
      case 'ForOfStatement':
        if (contains(node)) {
          if (node.left.type === 'VariableDeclaration') walkStmt(node.left);
          walkStmt(node.body);
        }
        break;
      case 'WhileStatement':
      case 'DoWhileStatement':
        if (contains(node)) walkStmt(node.body);
        break;
      case 'TryStatement':
        if (contains(node)) {
          if (node.block && contains(node.block)) walkBlock(node.block.body ?? []);
          if (node.handler && contains(node.handler)) {
            if (node.handler.param) collectPattern(node.handler.param);
            walkBlock(node.handler.body.body ?? []);
          }
          if (node.finalizer && contains(node.finalizer)) walkBlock(node.finalizer.body ?? []);
        }
        break;
      case 'SwitchStatement':
        if (contains(node)) {
          for (const c of node.cases) {
            for (const s of c.consequent) walkStmt(s);
          }
        }
        break;
      case 'BlockStatement':
        if (contains(node)) walkBlock(node.body ?? []);
        break;
      case 'LabeledStatement':
        walkStmt(node.body);
        break;
      case 'ImportDeclaration':
        for (const spec of node.specifiers) {
          if (spec.local) names.set(spec.local.name, spec.local.start);
        }
        break;
      case 'ExportNamedDeclaration':
        if (node.declaration) walkStmt(node.declaration);
        break;
      case 'ExportDefaultDeclaration':
        if (node.declaration) {
          if (node.declaration.type === 'FunctionDeclaration' || node.declaration.type === 'ClassDeclaration') {
            walkStmt(node.declaration);
          } else if (contains(node)) {
            walkExpr(node.declaration);
          }
        }
        break;
      default:
        break;
    }
  }

  function walkExpr(node: any): void {
    if (!node) return;
    switch (node.type) {
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        if (contains(node)) {
          if (node.id) names.set(node.id.name, node.id.start);
          for (const param of node.params) collectPattern(param);
          if (node.body.type === 'BlockStatement') {
            walkBlock(node.body.body ?? []);
          } else {
            walkExpr(node.body);
          }
        }
        break;
      case 'ClassExpression':
        if (contains(node)) {
          if (node.id) names.set(node.id.name, node.id.start);
          if (node.body) walkClassBody(node.body);
        }
        break;
      default:
        // For other expressions, recurse into sub-expressions that contain the offset
        for (const key of Object.keys(node)) {
          if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
          const val = node[key];
          if (val && typeof val === 'object' && typeof val.type === 'string' && typeof val.start === 'number') {
            if (contains(val)) walkExpr(val);
          } else if (Array.isArray(val)) {
            for (const el of val) {
              if (el && typeof el === 'object' && typeof el.type === 'string' && typeof el.start === 'number') {
                if (contains(el)) walkExpr(el);
              }
            }
          }
        }
        break;
    }
  }

  function walkClassBody(body: any): void {
    if (!body || !body.body) return;
    for (const node of body.body) {
      if ((node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') && node.value && contains(node.value)) {
        walkExpr(node.value);
      }
    }
  }

  // Walk top-level statements
  walkBlock(ast.body);

  return names;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the offset of a declaration name inside an HM annotation comment.
 * E.g. for "// add :: Number -> Number" and name "add", returns the index
 * of "add" within the comment text.
 */
function findAnnotationNameOffset(commentText: string, name: string): number {
  // Pattern: optional leading `//` or `/*`, optional `*`, whitespace, then `name ::`
  const pattern = new RegExp(`(?:^|[\\s*/])${escapeRegExp(name)}\\s+::`);
  const m = pattern.exec(commentText);
  if (!m) return -1;
  // The match might start with a delimiter character; find exact name start
  const matchStart = m.index;
  const nameIdx = commentText.indexOf(name, matchStart);
  return nameIdx;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
