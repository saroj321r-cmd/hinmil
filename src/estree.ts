// ============================================================================
// ESTree AST types — the parser-independent type vocabulary
//
// WHAT THIS FILE DOES (in plain language): every JavaScript parser worth
// using outputs its results in the same standardised shape, called "ESTree"
// (think of it as the common file format for parsed JavaScript).  This module
// re-exports that type vocabulary — `Program`, `CallExpression`,
// `Identifier`, and so on — from the parser-neutral `@types/estree` package,
// with one project-specific addition (see below).
//
// Every other file should import these AST types FROM HERE, never from a
// parser library directly.  That way, swapping the parser for another
// ESTree-compliant library (espree, meriyah, @babel/parser with the estree
// plugin, …) means touching only `parsing.ts` — the rest of the codebase
// only ever sees the standard shapes.
//
// THE ONE ADDITION: the ESTree spec only gives nodes an OPTIONAL
// `range`/`loc`; this engine instead requires absolute `start`/`end`
// character offsets on every node (all per-node type maps are keyed on
// them).  The module augmentation below adds those two fields to
// `BaseNodeWithoutComments`, the interface every node and comment in
// @types/estree inherits from — so the whole vocabulary gains mandatory
// offsets in one stroke.
//
// Contract every replacement parser must honour (see also the contract test
// in tests/parserContract.test.ts):
//   - nodes carry absolute `start` / `end` character offsets;
//   - `sourceType: 'module'` parsing of import/export syntax;
//   - a way to collect comments during the parse (annotations live there);
//   - an error-tolerant mode for half-typed sources.
// ============================================================================

export type * from 'estree';

// Add the mandatory character offsets to every node and comment type.
declare module 'estree' {
  interface BaseNodeWithoutComments {
    /** Absolute start offset of the node in the source text. */
    start: number;
    /** Absolute end offset of the node in the source text. */
    end: number;
  }
}

import type {
  MaybeNamedFunctionDeclaration,
  MaybeNamedClassDeclaration,
  Node,
  BaseNode,
  Expression,
  Literal,
} from 'estree';

/**
 * A `function` declaration whose `id` may be null — only possible as part of
 * `export default function () { … }`.  (Alias for the name acorn uses.)
 */
export type AnonymousFunctionDeclaration = MaybeNamedFunctionDeclaration;

/**
 * A `class` declaration whose `id` may be null — only possible as part of
 * `export default class { … }`.  (Alias for the name acorn uses.)
 */
export type AnonymousClassDeclaration = MaybeNamedClassDeclaration;

// ---------------------------------------------------------------------------
// JSX node types — the standard ESTree JSX extension
// (https://github.com/facebook/jsx).  @types/estree does not include these;
// they are produced by the Babel backend (the façade in `parsing.ts` routes
// JSX sources there).  At runtime JSX nodes appear in `Expression` positions;
// statically they are added to `AnyNode` so `switch (node.type)` narrows.
// ---------------------------------------------------------------------------

export interface JSXIdentifier extends BaseNode {
  type: 'JSXIdentifier';
  name: string;
}

export interface JSXNamespacedName extends BaseNode {
  type: 'JSXNamespacedName';
  namespace: JSXIdentifier;
  name: JSXIdentifier;
}

export interface JSXMemberExpression extends BaseNode {
  type: 'JSXMemberExpression';
  object: JSXMemberExpression | JSXIdentifier;
  property: JSXIdentifier;
}

export interface JSXEmptyExpression extends BaseNode {
  type: 'JSXEmptyExpression';
}

export interface JSXExpressionContainer extends BaseNode {
  type: 'JSXExpressionContainer';
  expression: Expression | JSXEmptyExpression;
}

export interface JSXSpreadChild extends BaseNode {
  type: 'JSXSpreadChild';
  expression: Expression;
}

export interface JSXText extends BaseNode {
  type: 'JSXText';
  value: string;
  raw?: string;
}

export interface JSXAttribute extends BaseNode {
  type: 'JSXAttribute';
  name: JSXIdentifier | JSXNamespacedName;
  value: Literal | JSXExpressionContainer | JSXElement | JSXFragment | null;
}

export interface JSXSpreadAttribute extends BaseNode {
  type: 'JSXSpreadAttribute';
  argument: Expression;
}

export interface JSXOpeningElement extends BaseNode {
  type: 'JSXOpeningElement';
  name: JSXIdentifier | JSXMemberExpression | JSXNamespacedName;
  attributes: Array<JSXAttribute | JSXSpreadAttribute>;
  selfClosing: boolean;
}

export interface JSXClosingElement extends BaseNode {
  type: 'JSXClosingElement';
  name: JSXIdentifier | JSXMemberExpression | JSXNamespacedName;
}

export interface JSXOpeningFragment extends BaseNode {
  type: 'JSXOpeningFragment';
}

export interface JSXClosingFragment extends BaseNode {
  type: 'JSXClosingFragment';
}

/** Any node that may appear in a JSX element's `children` array. */
export type JSXChild = JSXElement | JSXFragment | JSXExpressionContainer | JSXSpreadChild | JSXText;

export interface JSXElement extends BaseNode {
  type: 'JSXElement';
  openingElement: JSXOpeningElement;
  children: JSXChild[];
  closingElement: JSXClosingElement | null;
}

export interface JSXFragment extends BaseNode {
  type: 'JSXFragment';
  openingFragment: JSXOpeningFragment;
  children: JSXChild[];
  closingFragment: JSXClosingFragment;
}

/** Union of every JSX node type. */
export type JSXNode =
  | JSXIdentifier
  | JSXNamespacedName
  | JSXMemberExpression
  | JSXEmptyExpression
  | JSXExpressionContainer
  | JSXSpreadChild
  | JSXText
  | JSXAttribute
  | JSXSpreadAttribute
  | JSXOpeningElement
  | JSXClosingElement
  | JSXOpeningFragment
  | JSXClosingFragment
  | JSXElement
  | JSXFragment;

/**
 * Union of ALL concrete node types.  Using this (instead of a base
 * interface) gives TypeScript discriminated-union narrowing on `node.type`
 * inside switch statements.  Includes the anonymous (`id: null`) declaration
 * variants, which the spec's `Node` union leaves out, plus the JSX
 * extension.  (Alias for the name acorn uses.)
 */
export type AnyNode = Node | MaybeNamedFunctionDeclaration | MaybeNamedClassDeclaration | JSXNode;
