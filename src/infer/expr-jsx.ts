// ============================================================================
// JSX expression inference
//
// Plain language: a JSX element like `<Greeting name={user} />` is syntactic
// sugar for a component call — React compiles it to
// `createElement(Greeting, { name: user })`.  This module types JSX the same
// way: a capitalized (component) element is DESUGARED into a synthetic
// `CallExpression`  `Greeting({ name: user, children: … })`  and routed
// through the regular call-inference machinery, so props are unified against
// the component's parameter type and every existing diagnostic (wrong prop
// type, missing prop, overloads, constraints…) fires exactly as it would for
// a plain function call.  All synthetic nodes carry the offsets of the REAL
// JSX tokens they stand for, so diagnostics and hover point at the source.
//
// Lowercase (intrinsic/host) elements — `<div>`, `<button>` — have no
// component function to check against; their attribute values and children
// are still inferred (so `<div>{books.mapp(...)}</div>` reports the typo)
// but the attribute NAMES are not validated against a DOM catalogue.
//
// Every JSX expression evaluates to the nominal `ReactElement` type — the
// same name a `react.hm` signature file uses (e.g.
// `App :: { title :: String } -> ReactElement`), so annotations and
// inference meet nominally.
// ============================================================================

import type * as estree from '../estree';
import { Type, tCon, tString, AstNode, isTuple } from '../hm/types';
import { instantiate } from '../hm/env';
import { TypeEnv } from '../hm/env';
import { inferExpression } from './expressions';
import { getIntrinsicAttrType, REACT_SPECIAL_ATTRS } from './jsx-dom';
import type { InferenceEngine } from './index';

/** The nominal type every JSX expression evaluates to. */
export const REACT_ELEMENT = 'ReactElement';

const tReactElement = (): Type => tCon(REACT_ELEMENT, []);

/** Offsets shared by all synthetic-node builders. */
interface Span { start: number; end: number }

function synthIdentifier(name: string, at: Span): estree.Identifier {
  return { type: 'Identifier', name, start: at.start, end: at.end } as estree.Identifier;
}

function synthLiteral(value: string | boolean, at: Span): estree.Literal {
  return {
    type: 'Literal', value, raw: JSON.stringify(value), start: at.start, end: at.end,
  } as estree.Literal;
}

/**
 * Convert a JSX tag name to a callable expression node.
 * `<Greeting/>` → `Greeting`; `<UI.Button/>` → `UI.Button` (member chain).
 */
function tagNameToExpression(name: estree.JSXIdentifier | estree.JSXMemberExpression): estree.Expression {
  if (name.type === 'JSXIdentifier') return synthIdentifier(name.name, name);
  const object = tagNameToExpression(name.object);
  return {
    type: 'MemberExpression',
    object,
    property: synthIdentifier(name.property.name, name.property),
    computed: false,
    optional: false,
    start: name.start,
    end: name.end,
  } as estree.MemberExpression;
}

/** True for lowercase tags (`div`, `button`) — host elements, not components. */
function isIntrinsicTag(name: estree.JSXOpeningElement['name']): boolean {
  if (name.type === 'JSXNamespacedName') return true; // <svg:path …>
  if (name.type === 'JSXMemberExpression') return false; // <UI.Button …>
  return !/^[A-Z]/.test(name.name);
}

/**
 * Convert one attribute value to the expression node that carries its type:
 *   name="str"   → the Literal itself
 *   name={expr}  → the inner expression (REAL node → diagnostics on source)
 *   name         → a synthetic `true` literal (JSX bare-attribute semantics)
 *   name=<El/>   → the JSX element itself (handled by the expression switch)
 */
function attrValueToExpression(attr: estree.JSXAttribute): AstNode {
  const v = attr.value;
  if (!v) return synthLiteral(true, attr.name);
  if (v.type === 'JSXExpressionContainer') {
    if (v.expression.type === 'JSXEmptyExpression') return synthLiteral(true, v);
    return v.expression;
  }
  return v; // Literal, JSXElement or JSXFragment
}

/**
 * Convert the children of an element/fragment to the expression nodes that
 * carry their types.  Whitespace-only text (indentation between tags) is
 * dropped, matching what JSX compiles away; meaningful text becomes a String
 * literal.  `{expr}` containers contribute their inner expression;
 * `{/* comment *​/}` (empty expression) contributes nothing.
 */
function childrenToExpressions(children: estree.JSXChild[]): AstNode[] {
  const out: AstNode[] = [];
  for (const child of children) {
    switch (child.type) {
      case 'JSXText': {
        if (child.value.trim() !== '') out.push(synthLiteral(child.value, child));
        break;
      }
      case 'JSXExpressionContainer': {
        if (child.expression.type !== 'JSXEmptyExpression') out.push(child.expression);
        break;
      }
      case 'JSXSpreadChild': {
        out.push(child.expression);
        break;
      }
      default: // JSXElement | JSXFragment
        out.push(child);
    }
  }
  return out;
}

/** Plain (non-namespaced) attribute name, or null for `xlink:href` style names. */
function plainAttrName(attr: estree.JSXAttribute): string | null {
  return attr.name.type === 'JSXIdentifier' ? attr.name.name : null;
}

/**
 * Infer one attribute value and, when the attribute name is known in the
 * DOM catalogue (or is a React-special like `key`/`ref`), unify it against
 * the declared type — `<div className={3}>` then reports on the attribute.
 * The declared type is also recorded on the name span so hover shows it.
 */
function checkAttrAgainst(
  engine: InferenceEngine,
  attr: estree.JSXAttribute,
  declared: Type | null,
  env: TypeEnv,
): void {
  const valueExpr = attrValueToExpression(attr);
  const valueType = inferExpression(engine, valueExpr, env);
  if (!declared) return;
  engine.unifyWithDiagnostic(valueType, declared, valueExpr);
  engine.recordNodeType(attr.name, declared);
}

/** An attribute name with a hyphen (`aria-label`, `data-testid`).  As in
 *  TypeScript, such an attribute is not checked against a component's
 *  props: it is not a valid identifier, so a props type cannot declare it,
 *  and components pass it on to their DOM element.  Its value is still
 *  typed. */
function isHyphenatedAttr(attr: estree.JSXAttribute): boolean {
  return attr.name.type === 'JSXIdentifier' && attr.name.name.includes('-');
}

/** Build the synthetic `{ prop: value, … }` ObjectExpression for a component call. */
function buildPropsObject(
  opening: estree.JSXOpeningElement,
  childExprs: AstNode[],
): estree.ObjectExpression {
  const properties: Array<estree.Property | estree.SpreadElement> = [];

  for (const attr of opening.attributes) {
    if (attr.type === 'JSXSpreadAttribute') {
      // `<C {...rest} />` — same typing as `{ ...rest }` in an object literal.
      properties.push({
        type: 'SpreadElement',
        argument: attr.argument,
        start: attr.start,
        end: attr.end,
      } as estree.SpreadElement);
      continue;
    }
    // `key` and `ref` are consumed by React itself and never reach the
    // component's props — keep them out of the record so a strictly
    // annotated component does not see phantom extra fields.  They are
    // type-checked separately in inferJSXElement.
    const plain = plainAttrName(attr);
    if (plain && plain in REACT_SPECIAL_ATTRS) continue;
    if (isHyphenatedAttr(attr)) continue;
    const key = attr.name.type === 'JSXNamespacedName'
      ? synthLiteral(`${attr.name.namespace.name}:${attr.name.name.name}`, attr.name)
      : synthIdentifier(attr.name.name, attr.name);
    properties.push({
      type: 'Property',
      key,
      value: attrValueToExpression(attr),
      kind: 'init',
      method: false,
      shorthand: false,
      computed: false,
      start: attr.start,
      end: attr.end,
    } as estree.Property);
  }

  if (childExprs.length > 0) {
    // React passes a single child as-is and multiple children as an array.
    const value: AstNode = childExprs.length === 1
      ? childExprs[0]
      : ({
          type: 'ArrayExpression',
          elements: childExprs,
          start: childExprs[0].start,
          end: childExprs[childExprs.length - 1].end,
        } as estree.ArrayExpression);
    properties.push({
      type: 'Property',
      key: synthIdentifier('children', opening),
      value,
      kind: 'init',
      method: false,
      shorthand: false,
      computed: false,
      start: value.start,
      end: value.end,
    } as estree.Property);
  }

  return {
    type: 'ObjectExpression',
    properties,
    start: opening.start,
    end: opening.end,
  } as estree.ObjectExpression;
}

/**
 * Whether a component takes no props at all (`const App = () => …`, annotated
 * `App :: () -> ReactElement`).  React still passes a props object, which
 * the component ignores; desugaring to `App({})` would be an arity error.
 */
function componentTakesNoProps(engine: InferenceEngine, callee: estree.Expression, env: TypeEnv): boolean {
  if (callee.type !== 'Identifier') return false;
  const scheme = env.lookup(callee.name as string);
  if (!scheme) return false;
  const t = engine.subst.apply(instantiate(scheme));
  if (t.tag !== 'TFun') return false;
  const p = engine.subst.apply(t.param);
  return (p.tag === 'TCon' && p.name === 'Void' && p.args.length === 0) || (isTuple(p) && p.args.length === 0);
}

/**
 * Infer a JSX element.
 *
 * Component elements are typed as the call `Component(propsRecord)` (see the
 * module header); host elements just infer their attribute values and
 * children.  Both evaluate to `ReactElement`.
 */
export function inferJSXElement(engine: InferenceEngine, node: estree.JSXElement, env: TypeEnv): Type {
  const opening = node.openingElement;
  const childExprs = childrenToExpressions(node.children);

  if (isIntrinsicTag(opening.name)) {
    // Host element: infer attribute values / spreads / children.  Attribute
    // names known in the DOM catalogue (className, style, onClick, …) have
    // their values checked against the declared type; unknown names
    // (data-*, aria-*, exotic SVG) stay unchecked by design.
    const tag = opening.name.type === 'JSXIdentifier' ? opening.name.name : '';
    for (const attr of opening.attributes) {
      if (attr.type === 'JSXSpreadAttribute') {
        inferExpression(engine, attr.argument, env);
        continue;
      }
      const plain = plainAttrName(attr);
      checkAttrAgainst(engine, attr, plain ? getIntrinsicAttrType(tag, plain) : null, env);
    }
    for (const child of childExprs) inferExpression(engine, child, env);
    return tReactElement();
  }

  // Component element — desugar to `Component({ …props, children })` and let
  // the call machinery do the props/param unification and diagnostics.
  // Class components are instantiated with `new` at runtime, so a callee
  // with class provenance desugars to a NewExpression instead (otherwise
  // the "must be called with 'new'" strictness check would fire).
  // React-special attributes (`key`, `ref`) are stripped from the props
  // record by buildPropsObject; check them against their own types here.
  for (const attr of opening.attributes) {
    if (attr.type === 'JSXSpreadAttribute') continue;
    const plain = plainAttrName(attr);
    if (plain && plain in REACT_SPECIAL_ATTRS) {
      checkAttrAgainst(engine, attr, getIntrinsicAttrType('', plain), env);
    } else if (isHyphenatedAttr(attr)) {
      checkAttrAgainst(engine, attr, null, env);
    }
  }
  const callee = tagNameToExpression(opening.name as estree.JSXIdentifier | estree.JSXMemberExpression);
  const prov = callee.type === 'Identifier'
    ? engine.constructorProvenance.get((callee as estree.Identifier).name as string)
    : undefined;
  const isClassComponent = prov === 'class' || prov === 'function-this';
  const props = buildPropsObject(opening, childExprs);
  // A component without parameters ignores its props: call it without
  // arguments, but still type the attribute values and children.
  const noProps = !isClassComponent && componentTakesNoProps(engine, callee, env);
  if (noProps && props.properties.length > 0) inferExpression(engine, props, env);
  const call = {
    type: isClassComponent ? 'NewExpression' : 'CallExpression',
    callee,
    arguments: noProps ? [] : [props],
    optional: false,
    start: node.start,
    end: node.end,
  } as estree.CallExpression;
  engine.inferCallExpression(call, env);
  return tReactElement();
}

/** Infer a JSX fragment `<>…</>`: children carry their own types. */
export function inferJSXFragment(engine: InferenceEngine, node: estree.JSXFragment, env: TypeEnv): Type {
  for (const child of childrenToExpressions(node.children)) {
    inferExpression(engine, child, env);
  }
  return tReactElement();
}

/** Infer a stray JSX child node reached directly (defensive). */
export function inferJSXText(): Type {
  return tString;
}
