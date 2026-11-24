// ============================================================================
// DOM attribute catalogue for intrinsic JSX tags
//
// Plain language: `<div className={3}>` is almost certainly a bug, and
// `<div cla|` should complete to `className`.  This module is the single
// source of truth for the attributes we KNOW about on host elements
// (`div`, `input`, …): their names, their types, and which tags they apply
// to.  Attribute names we do NOT know (data-*, aria-*, exotic SVG) are
// deliberately left unchecked — that space is too large to validate and
// false positives are worse than silence.
//
// Types are exposed as FACTORIES: entries like event handlers (`a -> b`)
// and `style` (an open record) contain type variables that must be fresh
// per use site, otherwise two unrelated `<div style={…}>` occurrences
// would be forced to the same shape.
// ============================================================================

import { Type, tVar, tString, tNumber, tBool, tUnion, tRecord, tOpenRecord, tFun } from '../hm/types';

type TypeFactory = () => Type;

/** `String | Number` — dimensions, keys, numeric-ish HTML attributes. */
const stringOrNumber: TypeFactory = () => tUnion([tString, tNumber]);
/** Event handler: any function.  `() => …` infers as `Void -> a`, so a
 *  single fresh `a -> b` arrow accepts both nullary and unary handlers. */
const handler: TypeFactory = () => tFun(tVar(), tVar());
/** `style` — React expects an object, never a CSS string. */
const styleObject: TypeFactory = () => tOpenRecord({}, tVar());
/** `ref` — a ref object (`useRef`/`createRef`) or a callback ref. */
const refType: TypeFactory = () => tUnion([tOpenRecord({ current: tVar() }, tVar()), tFun(tVar(), tVar())]);

// ---------------------------------------------------------------------------
// React-special attributes — valid on EVERY element, including components.
// They are consumed by React itself and never reach the props record.
// ---------------------------------------------------------------------------

export const REACT_SPECIAL_ATTRS: Record<string, TypeFactory> = {
  key: stringOrNumber,
  ref: refType,
};

// ---------------------------------------------------------------------------
// Global attributes — valid on every host element.
// ---------------------------------------------------------------------------

const GLOBAL_ATTRS: Record<string, TypeFactory> = {
  className: () => tString,
  id: () => tString,
  style: styleObject,
  title: () => tString,
  role: () => tString,
  lang: () => tString,
  dir: () => tString,
  tabIndex: () => tNumber,
  hidden: () => tBool,
  draggable: () => tBool,
  contentEditable: () => tBool,
  spellCheck: () => tBool,
  dangerouslySetInnerHTML: () => tRecord({ __html: tString }),
};

/** Event handlers — all typed as a plain function. */
const EVENT_HANDLER_NAMES = [
  'onClick', 'onDoubleClick', 'onContextMenu',
  'onChange', 'onInput', 'onSubmit', 'onReset', 'onInvalid',
  'onKeyDown', 'onKeyUp', 'onKeyPress',
  'onFocus', 'onBlur',
  'onMouseDown', 'onMouseUp', 'onMouseEnter', 'onMouseLeave', 'onMouseMove', 'onMouseOver', 'onMouseOut',
  'onScroll', 'onWheel',
  'onTouchStart', 'onTouchMove', 'onTouchEnd', 'onTouchCancel',
  'onPointerDown', 'onPointerUp', 'onPointerMove', 'onPointerEnter', 'onPointerLeave',
  'onDrag', 'onDragStart', 'onDragEnd', 'onDragEnter', 'onDragLeave', 'onDragOver', 'onDrop',
  'onCopy', 'onCut', 'onPaste',
  'onLoad', 'onError',
  'onAnimationStart', 'onAnimationEnd', 'onTransitionEnd',
] as const;

// ---------------------------------------------------------------------------
// Per-tag attributes.
// ---------------------------------------------------------------------------

const FORM_CONTROL_ATTRS: Record<string, TypeFactory> = {
  name: () => tString,
  value: stringOrNumber,
  defaultValue: stringOrNumber,
  disabled: () => tBool,
  required: () => tBool,
  autoFocus: () => tBool,
};

const MEDIA_ATTRS: Record<string, TypeFactory> = {
  src: () => tString,
  controls: () => tBool,
  autoPlay: () => tBool,
  loop: () => tBool,
  muted: () => tBool,
  preload: () => tString,
};

const TAG_ATTRS: Record<string, Record<string, TypeFactory>> = {
  a: {
    href: () => tString,
    target: () => tString,
    rel: () => tString,
    download: () => tString,
  },
  img: {
    src: () => tString,
    alt: () => tString,
    width: stringOrNumber,
    height: stringOrNumber,
    loading: () => tString,
    srcSet: () => tString,
    sizes: () => tString,
  },
  input: {
    ...FORM_CONTROL_ATTRS,
    type: () => tString,
    checked: () => tBool,
    defaultChecked: () => tBool,
    placeholder: () => tString,
    readOnly: () => tBool,
    min: stringOrNumber,
    max: stringOrNumber,
    step: stringOrNumber,
    minLength: () => tNumber,
    maxLength: () => tNumber,
    pattern: () => tString,
    autoComplete: () => tString,
    accept: () => tString,
    multiple: () => tBool,
  },
  button: {
    type: () => tString,
    disabled: () => tBool,
    name: () => tString,
    value: stringOrNumber,
    autoFocus: () => tBool,
  },
  form: {
    action: () => tString,
    method: () => tString,
    encType: () => tString,
    noValidate: () => tBool,
    autoComplete: () => tString,
  },
  label: {
    htmlFor: () => tString,
  },
  select: {
    ...FORM_CONTROL_ATTRS,
    multiple: () => tBool,
    size: () => tNumber,
  },
  option: {
    value: stringOrNumber,
    selected: () => tBool,
    disabled: () => tBool,
    label: () => tString,
  },
  textarea: {
    ...FORM_CONTROL_ATTRS,
    placeholder: () => tString,
    readOnly: () => tBool,
    rows: () => tNumber,
    cols: () => tNumber,
    minLength: () => tNumber,
    maxLength: () => tNumber,
    wrap: () => tString,
  },
  video: {
    ...MEDIA_ATTRS,
    width: stringOrNumber,
    height: stringOrNumber,
    poster: () => tString,
    playsInline: () => tBool,
  },
  audio: MEDIA_ATTRS,
  iframe: {
    src: () => tString,
    width: stringOrNumber,
    height: stringOrNumber,
    allow: () => tString,
    allowFullScreen: () => tBool,
    loading: () => tString,
    sandbox: () => tString,
  },
  td: { colSpan: () => tNumber, rowSpan: () => tNumber, headers: () => tString },
  th: { colSpan: () => tNumber, rowSpan: () => tNumber, scope: () => tString, headers: () => tString },
  ol: { start: () => tNumber, reversed: () => tBool, type: () => tString },
  li: { value: () => tNumber },
  canvas: { width: stringOrNumber, height: stringOrNumber },
  progress: { value: stringOrNumber, max: stringOrNumber },
  meter: { value: stringOrNumber, min: stringOrNumber, max: stringOrNumber, low: stringOrNumber, high: stringOrNumber, optimum: stringOrNumber },
  details: { open: () => tBool },
  dialog: { open: () => tBool },
  time: { dateTime: () => tString },
  script: { src: () => tString, type: () => tString, async: () => tBool, defer: () => tBool },
  link: { href: () => tString, rel: () => tString, type: () => tString },
  // SVG basics — enough for icons and simple graphics; the exotic rest is
  // deliberately unchecked.
  svg: {
    viewBox: () => tString,
    xmlns: () => tString,
    width: stringOrNumber,
    height: stringOrNumber,
    fill: () => tString,
    stroke: () => tString,
  },
  path: { d: () => tString, fill: () => tString, stroke: () => tString, strokeWidth: stringOrNumber },
  circle: { cx: stringOrNumber, cy: stringOrNumber, r: stringOrNumber, fill: () => tString, stroke: () => tString },
  rect: { x: stringOrNumber, y: stringOrNumber, width: stringOrNumber, height: stringOrNumber, fill: () => tString, rx: stringOrNumber },
  line: { x1: stringOrNumber, y1: stringOrNumber, x2: stringOrNumber, y2: stringOrNumber, stroke: () => tString, strokeWidth: stringOrNumber },
  use: { href: () => tString },
};

// ---------------------------------------------------------------------------
// Lookup API
// ---------------------------------------------------------------------------

/**
 * The declared type for `attr` on intrinsic tag `tag`, or null when the
 * attribute is unknown (→ leave unchecked).  Returns a FRESH type per call.
 */
export function getIntrinsicAttrType(tag: string, attr: string): Type | null {
  const factory = REACT_SPECIAL_ATTRS[attr]
    ?? TAG_ATTRS[tag]?.[attr]
    ?? GLOBAL_ATTRS[attr]
    ?? (EVENT_HANDLER_NAMES.includes(attr as typeof EVENT_HANDLER_NAMES[number]) ? handler : undefined);
  return factory ? factory() : null;
}

export interface IntrinsicAttrEntry {
  name: string;
  /** Fresh declared type (display + insert-snippet decisions). */
  type: Type;
  /** Per-tag attributes sort above global ones in completion. */
  tagSpecific: boolean;
}

/** All known attributes for `tag`: per-tag first, then global + handlers + specials. */
export function getIntrinsicAttrEntries(tag: string): IntrinsicAttrEntry[] {
  const seen = new Set<string>();
  const out: IntrinsicAttrEntry[] = [];
  const push = (name: string, factory: TypeFactory, tagSpecific: boolean) => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ name, type: factory(), tagSpecific });
  };
  for (const [name, f] of Object.entries(TAG_ATTRS[tag] ?? {})) push(name, f, true);
  for (const [name, f] of Object.entries(GLOBAL_ATTRS)) push(name, f, false);
  for (const [name, f] of Object.entries(REACT_SPECIAL_ATTRS)) push(name, f, false);
  for (const name of EVENT_HANDLER_NAMES) push(name, handler, false);
  return out;
}

// ---------------------------------------------------------------------------
// CSS properties — completion inside `style={{ … }}`.
//
// Names are the camelCase forms React expects.  These drive COMPLETION
// only: the `style` attribute stays an open record, so unknown keys
// (CSS custom properties like `'--main-color'`, vendor prefixes) and any
// value shape remain diagnostic-free by design.
// ---------------------------------------------------------------------------

const CSS_PROPERTY_NAMES = [
  // Layout / box model
  'display', 'position', 'top', 'right', 'bottom', 'left', 'zIndex',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'boxSizing', 'overflow', 'overflowX', 'overflowY', 'inset',
  'aspectRatio', 'objectFit', 'objectPosition', 'visibility', 'float', 'clear',
  // Flexbox
  'flex', 'flexDirection', 'flexWrap', 'flexFlow', 'flexGrow', 'flexShrink', 'flexBasis',
  'justifyContent', 'justifyItems', 'justifySelf',
  'alignItems', 'alignContent', 'alignSelf',
  'gap', 'rowGap', 'columnGap', 'order',
  // Grid
  'grid', 'gridTemplateColumns', 'gridTemplateRows', 'gridTemplateAreas',
  'gridColumn', 'gridRow', 'gridArea', 'gridAutoFlow', 'gridAutoColumns', 'gridAutoRows',
  'placeItems', 'placeContent', 'placeSelf',
  // Typography
  'color', 'font', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'fontVariant',
  'lineHeight', 'letterSpacing', 'wordSpacing', 'textAlign', 'textDecoration',
  'textTransform', 'textOverflow', 'textShadow', 'textIndent', 'whiteSpace',
  'wordBreak', 'overflowWrap', 'verticalAlign', 'direction',
  // Background & borders
  'background', 'backgroundColor', 'backgroundImage', 'backgroundPosition',
  'backgroundRepeat', 'backgroundSize', 'backgroundAttachment', 'backgroundClip',
  'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft',
  'borderColor', 'borderStyle', 'borderWidth', 'borderRadius',
  'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'borderCollapse', 'borderSpacing', 'outline', 'outlineColor', 'outlineStyle',
  'outlineWidth', 'outlineOffset', 'boxShadow',
  // Effects & interaction
  'opacity', 'filter', 'backdropFilter', 'mixBlendMode', 'cursor', 'pointerEvents',
  'userSelect', 'resize', 'appearance', 'content', 'clipPath', 'maskImage',
  'scrollBehavior', 'scrollMargin', 'scrollPadding', 'scrollSnapType', 'scrollSnapAlign',
  'touchAction', 'willChange', 'caretColor', 'accentColor', 'colorScheme',
  // Transform / transition / animation
  'transform', 'transformOrigin', 'transformStyle', 'perspective', 'perspectiveOrigin',
  'translate', 'rotate', 'scale',
  'transition', 'transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'transitionDelay',
  'animation', 'animationName', 'animationDuration', 'animationTimingFunction',
  'animationDelay', 'animationIterationCount', 'animationDirection',
  'animationFillMode', 'animationPlayState',
  // Lists / tables / misc
  'listStyle', 'listStyleType', 'listStylePosition', 'listStyleImage',
  'tableLayout', 'emptyCells', 'captionSide',
  'columns', 'columnCount', 'columnWidth', 'columnRule',
  'fill', 'stroke', 'strokeWidth',
] as const;

export interface CssPropertyEntry {
  name: string;
  /** Fresh display type (`String | Number`) — completion detail only. */
  type: Type;
}

/** All known CSS properties (camelCase) for style-object completion. */
export function getCssPropertyEntries(): CssPropertyEntry[] {
  return CSS_PROPERTY_NAMES.map((name) => ({ name, type: stringOrNumber() }));
}
