// ============================================================================
// AST walking façade — typed traversal over the neutral ESTree vocabulary
//
// WHAT THIS FILE DOES (in plain language): the `acorn-walk` library walks any
// ESTree-shaped tree (it only dispatches on `node.type`, so it works no
// matter which parser produced the tree).  Its bundled TypeScript typings,
// however, are written against acorn's OWN node types — which clash with the
// parser-neutral vocabulary in `estree.ts`.  This module re-exposes the walk
// functions retyped against that neutral vocabulary, so visitor callbacks get
// proper per-node-type parameter types without any `as` casts at call sites.
//
// The runtime behaviour is exactly acorn-walk's; only the types differ.
// ============================================================================

import * as acornWalk from 'acorn-walk';
import type { AnyNode } from './estree';

/** The concrete node type(s) whose `type` field equals `K`. */
type NodeOfType<K extends string> = Extract<AnyNode, { type: K }>;

// ---------------------------------------------------------------------------
// Base walker with JSX support.  acorn-walk's bundled base only knows the
// core ESTree vocabulary and THROWS on unknown node types; trees produced by
// the Babel backend may contain the standard JSX extension nodes, so the
// walkers below always pass this extended base.
// ---------------------------------------------------------------------------

type WalkerCallback = (node: unknown, state: unknown) => void;
type BaseVisitor = (node: never, state: unknown, callback: WalkerCallback) => void;

const ignore: BaseVisitor = () => {};

const jsxBase: Record<string, BaseVisitor> = {
  ...(acornWalk.base as unknown as Record<string, BaseVisitor>),
  JSXElement: ((node: { openingElement: unknown; children: unknown[]; closingElement: unknown | null }, st, c) => {
    c(node.openingElement, st);
    for (const child of node.children) c(child, st);
    if (node.closingElement) c(node.closingElement, st);
  }) as BaseVisitor,
  JSXFragment: ((node: { children: unknown[] }, st, c) => {
    for (const child of node.children) c(child, st);
  }) as BaseVisitor,
  JSXOpeningElement: ((node: { attributes: unknown[] }, st, c) => {
    for (const attr of node.attributes) c(attr, st);
  }) as BaseVisitor,
  JSXAttribute: ((node: { value: unknown | null }, st, c) => {
    if (node.value) c(node.value, st);
  }) as BaseVisitor,
  JSXSpreadAttribute: ((node: { argument: unknown }, st, c) => {
    c(node.argument, st);
  }) as BaseVisitor,
  JSXExpressionContainer: ((node: { expression: { type?: string } }, st, c) => {
    if (node.expression && node.expression.type !== 'JSXEmptyExpression') c(node.expression, st);
  }) as BaseVisitor,
  JSXSpreadChild: ((node: { expression: unknown }, st, c) => {
    c(node.expression, st);
  }) as BaseVisitor,
  JSXClosingElement: ignore,
  JSXOpeningFragment: ignore,
  JSXClosingFragment: ignore,
  JSXText: ignore,
  JSXIdentifier: ignore,
  JSXMemberExpression: ignore,
  JSXNamespacedName: ignore,
  JSXEmptyExpression: ignore,
};

/** Per-node-type callbacks for {@link simple}: `(node, state)`. */
export type SimpleVisitors<S = unknown> = {
  [K in AnyNode['type']]?: (node: NodeOfType<K>, state: S) => void;
};

/** Per-node-type callbacks for {@link ancestor}: `(node, state, ancestors)`. */
export type AncestorVisitors<S = unknown> = {
  [K in AnyNode['type']]?: (node: NodeOfType<K>, state: S, ancestors: AnyNode[]) => void;
};

/**
 * Walk the tree, calling the matching visitor for every node.
 * Does NOT pass ancestor information (cheaper than {@link ancestor}).
 */
export function simple<S = unknown>(node: AnyNode, visitors: SimpleVisitors<S>, state?: S): void {
  (acornWalk.simple as (n: unknown, v: unknown, b?: unknown, s?: unknown) => void)(
    node, visitors, jsxBase, state,
  );
}

/**
 * Like {@link simple}, but each visitor also receives the stack of ancestor
 * nodes (outermost first, the visited node last).
 */
export function ancestor<S = unknown>(node: AnyNode, visitors: AncestorVisitors<S>, state?: S): void {
  (acornWalk.ancestor as (n: unknown, v: unknown, b?: unknown, s?: unknown) => void)(
    node, visitors, jsxBase, state,
  );
}
