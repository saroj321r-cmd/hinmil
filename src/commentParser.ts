// ============================================================================
// Comment Parser — parses HM type signatures from JS comments
//
// Plain language: users write their type notes inside ordinary JavaScript
// comments (the checker never changes how their code runs).  This file is
// the "mail sorter": it scans a file's comments, picks out everything that
// looks like a type annotation or a `::directive` command, parses it, and
// attaches each note to the piece of code directly below it.
//
// Recognizes these patterns:
//   // :: Number -> String
//   /* :: a -> a */
//   /** :: Number -> Number -> Number */
//
// The `::` prefix is required to distinguish HM annotations from regular
// comments. Comments are associated with the declaration that immediately
// follows them.
// ============================================================================

import type * as estree from './estree';
import * as walk from './walking';
import { parseStrict, parseLoose } from './parsing';
import { Type, Scheme, AstNode, getReturnType, T_BOOLEAN, setActiveAllocator, TypeVarAllocator } from './hm/types';
import { parseTypeSignature, parseMethodTypeSignature, parseType, TypeParseError } from './hm/typeParser';

/** Sentinel comment inserted between sidecar/override parts in the merged
 *  source returned by `ImportInferenceContext.createTypeDirectiveResolver`.
 *  `processTypeDirectives` splits on it to apply override semantics for
 *  instance-callables (later parts win on `Name() :: ...` collisions).
 *  Comments survive the JS-parse pass that processes the merged source
 *  for annotations, so the sentinel itself is harmless to all other
 *  consumers. */
export const TYPE_DIRECTIVE_PART_BOUNDARY = '//__HM_TYPE_DIRECTIVE_BOUNDARY__';

// ---------------------------------------------------------------------------
// Prototype method pattern extraction
// ---------------------------------------------------------------------------

/**
 * Extract X.prototype.method pattern from a MemberExpression node.
 * Returns { typeName, methodName } or null.
 */
export function extractPrototypeMethod(memberExpr: estree.MemberExpression): { typeName: string, methodName: string } | null {
  const obj = memberExpr.object;
  const prop = memberExpr.property;
  if (obj?.type === 'MemberExpression' && !obj.computed
      && obj.object?.type === 'Identifier'
      && obj.property?.type === 'Identifier' && obj.property.name === 'prototype'
      && prop?.type === 'Identifier') {
    return { typeName: obj.object.name, methodName: prop.name };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Provenance of a `TypeAnnotation` entry in `engine.annotationMap`.
 *
 * `annotationMap` is a junction point: file-local annotations live next
 * to entries merged in from project globals (`engine.globalsSource`),
 * `// ::types <pkg>` directive targets, and imported packages.  Many
 * features (export schemes, dotted-name constraint injection, prototype
 * receiver inference, bare-binding annotation lookup …) must only honour
 * file-local entries — otherwise a sidecar's `default :: ...` or a
 * library's `field :: ...` silently hijacks unrelated user bindings.
 *
 * Consumers that need a strict file-local check should use the
 * `isLocalAnnotation` helper (see `infer/annotations.ts`) rather than
 * comparing this field directly; that helper is the single source of
 * truth for "treat absent as 'local' for backwards-compat" and any
 * future origin refinement.
 */
export type AnnotationOrigin =
  /** Parsed from the file currently being inferred. Trusted as authoritative. */
  | 'local'
  /** Merged from `engine.globalsSource` (user globals file +
   *  project `::types` addendum + package globals concatenation). */
  | 'globals'
  /** Merged via a `// ::types <specifier>` directive resolution. */
  | 'directive'
  /** Sourced from an imported module's exports / sidecar.  Reserved;
   *  no production path writes this today. */
  | 'imported';

export interface TypeAnnotation {
  /** The raw signature text after `::` */
  raw: string;
  /** Parsed scheme (null if parsing failed) */
  scheme: Scheme | null;
  /** Parse error message, if any */
  error?: string;
  /** Comment start offset in source */
  commentStart: number;
  /** Comment end offset in source */
  commentEnd: number;
  /** Name of the declaration this annotation is attached to (if found) */
  name?: string;
  /** Start offset of the declaration node */
  nodeStart?: number;
  /** Start offset of the declaration name identifier */
  nameStart?: number;
  /** End offset of the declaration name identifier */
  nameEnd?: number;
  /** Receiver type for method annotations (when ~> is used) */
  receiver?: Type;
  /** Method type for method annotations (right side of ~>) */
  methodType?: Type;
  /** When set, the annotation's method name didn't match the attached
   *  declaration's method name.  Contains the ACTUAL declaration method name. */
  methodNameMismatch?: string;
  /** When set, the annotation's regular name didn't match the attached
   *  declaration's name.  Contains the ACTUAL declaration name. */
  nameMismatch?: string;
  /** Start offset of the mismatched name identifier */
  mismatchNameStart?: number;
  /** End offset of the mismatched name identifier */
  mismatchNameEnd?: number;
  /** When ::narrow is used on a method annotation, the variant name to narrow to */
  narrowVariant?: string;
  /** Source span of the `::narrow` directive comment line (when present), used
   *  to anchor inference-time diagnostics about the directive (e.g. an
   *  unknown parameter name). */
  narrowLoc?: { start: number; end: number };
  /** When `::hidden` is used on the line above this annotation, this property/
   *  method should NOT be offered in completion lists.  It remains fully
   *  usable when the user types it explicitly (hover, signature help and
   *  inference work as normal).  Constructor properties are hidden
   *  implicitly without this flag. */
  hidden?: boolean;
  /** When `::private` is used on the line above this annotation, the
   *  member is private to the owning type: accessible via `this.x` inside
   *  the class / prototype methods, but NOT from outside.  Outside access
   *  (`obj.x`) emits a diagnostic.  Implies `hidden`. */
  private?: boolean;
  /** When set, a nameless annotation (`// :: ...`) was used above a named declaration */
  namelessOnNamed?: string;
  /**
   * Set on the SECONDARY entry produced by chained-annotation syntax
   * (`// A :: B :: T`).  Such entries describe a binding annotation under
   * the second name (typically a dotted `Obj.Field` for a member
   * assignment, or a bare `Ident` alias) and must NOT be treated as a
   * static/instance method on the type before the `.` — the chained
   * form is the binding's own annotation, not a member declaration on
   * an unrelated constructor.
   */
  chainedSecondary?: true;
  /** Start offset of the annotation name within the comment (e.g. "TypedArray" in `// TypedArray :: ...`) */
  signatureNameStart?: number;
  /** End offset of the annotation name within the comment */
  signatureNameEnd?: number;
  /**
   * Where this annotation came from.  Absent means "local" for
   * backwards compatibility with code paths that synthesise
   * `TypeAnnotation` objects directly (always treat via the
   * `isLocalAnnotation` helper rather than reading this field raw).
   * See {@link AnnotationOrigin}.
   */
  origin?: AnnotationOrigin;
}

/**
 * Single source of truth for "is this annotation file-local?".
 *
 * Inference-feeding consumers (export-scheme construction, dotted-name
 * constraint injection, prototype receiver inference, bare-binding
 * annotation lookup, …) must call this rather than naked
 * `annotationMap.get(...)` so that sidecar / globals / `::types`
 * entries with colliding names cannot silently hijack user bindings.
 *
 * Treats `undefined` origin as `'local'` so that any code path that
 * still constructs `TypeAnnotation` objects without setting `origin`
 * remains correct by default.
 */
export function isLocalAnnotation(ann: TypeAnnotation | undefined | null): boolean {
  if (!ann) return false;
  return ann.origin === undefined || ann.origin === 'local';
}

// ---------------------------------------------------------------------------
// Shared parse helper
// ---------------------------------------------------------------------------

/** Parse source with the parser, collecting comments. Falls back to the loose mode on
 *  parse failure so annotations and other comment-driven features still work
 *  on partially-broken sources. */
// Tiny LRU memoization keyed by source string identity.  Re-parsing huge
// sources (e.g. an 8000-line `.query-builder/client/index.hm` globals addendum) on
// every hover / completion / diagnostic call dominates request latency,
// so we keep the last few parses ready to be reused as long as the caller
// hands us the SAME string instance.  The cache is intentionally kept
// small — entries hold full ASTs and comment arrays.
const PARSE_CACHE_MAX = 8;
const parseCache: Array<{
  source: string;
  result: { ast: estree.Program; comments: estree.Comment[] } | null;
}> = [];

function parseWithComments(source: string): { ast: estree.Program; comments: estree.Comment[] } | null {
  for (let i = 0; i < parseCache.length; i++) {
    if (parseCache[i].source === source) {
      // Promote to most-recent
      const hit = parseCache[i];
      if (i !== 0) {
        parseCache.splice(i, 1);
        parseCache.unshift(hit);
      }
      return hit.result;
    }
  }
  const comments: estree.Comment[] = [];
  let result: { ast: estree.Program; comments: estree.Comment[] } | null;
  try {
    const ast = parseStrict(source, comments);
    result = { ast, comments };
  } catch {
    // Try fault-tolerant parser
    try {
      const looseComments: estree.Comment[] = [];
      const ast = parseLoose(source, looseComments);
      result = { ast, comments: looseComments };
    } catch {
      result = null;
    }
  }
  parseCache.unshift({ source, result });
  if (parseCache.length > PARSE_CACHE_MAX) parseCache.length = PARSE_CACHE_MAX;
  return result;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Regex to match optional `name ::`, `Name#method ::`, `Name.method ::`,
 *  `Name##private ::`, `Name() ::` (instance-callable annotation),
 *  or just `::` in a comment body. */
const HM_PATTERN = /^[\s*]*(?:([\w$]+(?:\(\)|(?:##|[#.])(?:@@)?[\w$]+)?)\s+)?::\s*(.+)$/m;

/** Regex to match `// ::narrow <Type>` directive in comments. */
/**
 * For a block comment's HM_PATTERN match: does the annotation line start a
 * paragraph?  True when every line before it is blank, or the line directly
 * above it is blank (JSDoc `*` gutters count as blank).  `[\s*]*` in
 * HM_PATTERN may swallow leading blank lines, so locate the real annotation
 * line via the `::` separator.
 */
function blockAnnotationStartsParagraph(text: string, match: RegExpExecArray): boolean {
  const sepIdx = match.index + match[0].indexOf('::');
  const lineStart = text.lastIndexOf('\n', sepIdx) + 1;
  if (lineStart === 0) return true;
  const before = text.slice(0, lineStart - 1); // drop the separating '\n'
  const prevLine = before.slice(before.lastIndexOf('\n') + 1);
  return /^[\s*]*$/.test(prevLine);
}

const NARROW_DIRECTIVE_PATTERN =/^[\s*]*::narrow\s+(.+)$/m;

/** Regex to match `// ::hidden` or `// ::hidden <Qualified.Name>` directives.
 *  The optional capture group selects a single registration target (by its
 *  qualified `Base.field` / `Base#method` name) in a chained / multi-binding
 *  annotation; without it the directive hides every member-shaped target. */
const HIDDEN_DIRECTIVE_PATTERN = /^[\s*]*::hidden(?:\s+([\w$]+(?:[#.][\w$]+)?))?\s*$/m;

/** Regex to match `// ::private` or `// ::private <Qualified.Name>` directives.
 *  See {@link HIDDEN_DIRECTIVE_PATTERN} for the optional target argument. */
const PRIVATE_DIRECTIVE_PATTERN = /^[\s*]*::private(?:\s+([\w$]+(?:[#.][\w$]+)?))?\s*$/m;

function findImmediatePreviousLineDirective(
  comments: estree.Comment[],
  index: number,
  source: string,
  pattern: RegExp,
): { match: RegExpExecArray; start: number; end: number } | null {
  if (index <= 0) return null;
  const prev = comments[index - 1];
  const curr = comments[index];
  /* istanbul ignore next */
  if (!prev || !curr) return null;
  if (prev.type !== 'Line' || curr.type !== 'Line') return null;
  const gap = source.slice(prev.end, curr.start);
  if (!/^\s*$/.test(gap)) return null;
  const match = pattern.exec(prev.value);
  if (!match) return null;
  return { match, start: prev.start, end: prev.end };
}

/**
 * Collect every stacked, line-adjacent `::hidden` / `::private` directive
 * sitting immediately above the comment at `index`.  Unlike
 * {@link findImmediatePreviousLineDirective} (which only inspects the single
 * previous line) this walks the whole contiguous run of directive lines so
 * that several `::hidden <Name>` directives stacked above one chained
 * annotation each take effect independently.
 *
 * Returns, for the requested `pattern`, the set of qualified target arguments
 * and whether any directive omitted its argument (meaning "hide every member
 * target").  The walk continues across BOTH `::hidden` and `::private` lines,
 * so callers get the full stack regardless of how the two kinds interleave.
 */
interface StackedDirectiveInfo {
  /** Qualified target names that were given an explicit argument. */
  args: Set<string>;
  /** True when at least one directive of this kind omitted its argument. */
  hasNoArg: boolean;
  /** True when at least one directive of this kind was present. */
  present: boolean;
}

function collectStackedDirectives(
  comments: estree.Comment[],
  index: number,
  source: string,
  pattern: RegExp,
): StackedDirectiveInfo {
  const args = new Set<string>();
  let hasNoArg = false;
  let present = false;
  let curr = comments[index];
  if (!curr || curr.type !== 'Line') return { args, hasNoArg, present };
  for (let j = index - 1; j >= 0; j--) {
    const prev = comments[j];
    if (!prev || prev.type !== 'Line') break;
    const gap = source.slice(prev.end, curr.start);
    if (!/^\s*$/.test(gap)) break;
    // Only `::hidden` / `::private` lines continue the directive stack.
    const isDirectiveLine =
      HIDDEN_DIRECTIVE_PATTERN.test(prev.value) || PRIVATE_DIRECTIVE_PATTERN.test(prev.value);
    if (!isDirectiveLine) break;
    const m = pattern.exec(prev.value);
    if (m) {
      present = true;
      const arg = m[1]?.trim();
      if (arg) args.add(arg);
      else hasNoArg = true;
    }
    curr = prev;
  }
  return { args, hasNoArg, present };
}

/** A `// ::narrow T` line comment directly next to the signature comment
 *  `curr` (only whitespace, no blank line, in between). */
function narrowDirectiveNextTo(
  directive: estree.Comment | undefined,
  curr: estree.Comment,
  source: string,
): { narrowedTypeRaw: string; start: number; end: number } | null {
  if (!directive || directive.type !== 'Line' || curr.type !== 'Line') return null;
  const gap = directive.end <= curr.start
    ? source.slice(directive.end, curr.start)
    : source.slice(curr.end, directive.start);
  if (!/^[ \t]*\r?\n[ \t]*$/.test(gap)) return null;
  const match = NARROW_DIRECTIVE_PATTERN.exec(directive.value);
  return match ? { narrowedTypeRaw: match[1].trim(), start: directive.start, end: directive.end } : null;
}

/**
 * The `::narrow` directive of the signature comment at `index`: the line
 * directly above it, or else the line directly below it (both orders occur:
 * `// ::narrow Array` + `// isArray :: …`, or the signature first).
 */
function findImmediateNarrowDirective(
  comments: estree.Comment[],
  index: number,
  source: string,
): { narrowedTypeRaw: string; start: number; end: number } | null {
  const curr = comments[index];
  /* istanbul ignore next — always defined for a valid index */
  if (!curr) return null;
  const above = narrowDirectiveNextTo(index > 0 ? comments[index - 1] : undefined, curr, source);
  if (above) return above;
  // Below: only when no signature follows the directive directly — then the
  // directive belongs to THAT signature (the usual "directive above" order).
  const below = narrowDirectiveNextTo(comments[index + 1], curr, source);
  const after = comments[index + 2];
  const belongsToNext = below !== null && after !== undefined && after.type === 'Line'
    && /^[ \t]*\r?\n[ \t]*$/.test(source.slice(below.end, after.start))
    && HM_PATTERN.test(after.value) && !NARROW_DIRECTIVE_PATTERN.test(after.value);
  return belongsToNext ? null : below;
}

/**
 * Find the first label-variable name referenced anywhere in a type
 * (e.g. 'k' in `{ [k] :: a }`).  Used to link a narrowed record's polymorphic
 * label to the signature parameter that supplies its concrete value.  Returns
 * null when the type has no polymorphic-label field.
 */
function firstLabelVarName(t: Type): string | null {
  switch (t.tag) {
    case 'TRecord': {
      for (const lf of t.labelFields ?? []) {
        if (lf.label.tag === 'TLabel' && lf.label.kind === 'var') return lf.label.name;
        const inner = firstLabelVarName(lf.type);
        if (inner) return inner;
      }
      for (const key of Object.keys(t.fields)) {
        const inner = firstLabelVarName(t.fields[key]);
        if (inner) return inner;
      }
      return t.rest ? firstLabelVarName(t.rest) : null;
    }
    case 'TCon': {
      for (const a of t.args) {
        const inner = firstLabelVarName(a);
        if (inner) return inner;
      }
      return null;
    }
    case 'TFun':
      return firstLabelVarName(t.param) ?? firstLabelVarName(t.result);
    default:
      return null;
  }
}

/**
 * Extract all HM type annotations from a JavaScript source string.
 *
 * The function:
 * 1. Parses the source with Acorn to get comments + AST
 * 2. For each comment containing `:: <signature>`, parses the type signature
 * 3. Associates the annotation with the next declaration
 */
export function extractAnnotations(source: string): TypeAnnotation[] {
  for (let i = 0; i < extractCache.length; i++) {
    if (extractCache[i].source === source) {
      const hit = extractCache[i];
      if (i !== 0) { extractCache.splice(i, 1); extractCache.unshift(hit); }
      return hit.annotations;
    }
  }
  // Parse annotation type variables in a RESERVED high ID range, separate
  // from the per-run inference allocator.  Parsed schemes are cached by
  // source string and reused across inference runs; every consumer
  // instantiates (or refreshes) them before use, so the reserved template
  // IDs are remapped to fresh per-run vars.  Reserving the range here keeps
  // the per-run allocator's trajectory IDENTICAL on cache-hit vs cache-miss
  // runs (parsing no longer advances it), which is essential for
  // deterministic inference — otherwise the same source could intermittently
  // alias unrelated type variables.
  const prevAllocator = setActiveAllocator(new TypeVarAllocator(ANNOTATION_PARSE_VAR_BASE));
  let annotations: TypeAnnotation[];
  try {
    annotations = extractAnnotationsImpl(source);
  } finally {
    setActiveAllocator(prevAllocator);
  }
  extractCache.unshift({ source, annotations });
  if (extractCache.length > PARSE_CACHE_MAX) extractCache.length = PARSE_CACHE_MAX;
  return annotations;
}

/**
 * High base offset for type-variable IDs allocated while parsing cached
 * annotation schemes.  Distinct from the builtin-environment range and far
 * above any per-run allocation, so cached template IDs never collide with
 * fresh inference vars.
 */
const ANNOTATION_PARSE_VAR_BASE = 2_000_000_000;

const extractCache: Array<{ source: string; annotations: TypeAnnotation[] }> = [];

/**
 * A standalone `// ::hidden` directive — one that is not immediately
 * followed by an HM annotation comment.  These are attached to the next
 * AST member declaration (class method or prototype-object property)
 * that we can identify the owning type for.
 *
 * Returned as `{ typeName, methodName }` pairs so the inference engine
 * can mark them via `markMethodHidden`.
 */
export interface StandaloneHiddenMarker {
  typeName: string;
  methodName: string;
  /** Comment start offset (for diagnostics if needed) */
  commentStart: number;
  /** Comment end offset */
  commentEnd: number;
  /** Start offset of the AST node (Property / MethodDefinition) being hidden */
  memberStart: number;
}

/** Extract `(typeName, methodName)` pairs for every standalone `::hidden`
 *  directive found in `source` whose owning type can be resolved. */
export function extractStandaloneHiddenMarkers(source: string): StandaloneHiddenMarker[] {
  return extractStandaloneDirectiveMarkers(source, HIDDEN_DIRECTIVE_PATTERN);
}

/** Extract `(typeName, methodName)` pairs for every standalone `::private`
 *  directive found in `source` whose owning type can be resolved. */
export function extractStandalonePrivateMarkers(source: string): StandaloneHiddenMarker[] {
  return extractStandaloneDirectiveMarkers(source, PRIVATE_DIRECTIVE_PATTERN);
}

function extractStandaloneDirectiveMarkers(source: string, pattern: RegExp): StandaloneHiddenMarker[] {
  const parsed = parseWithComments(source);
  if (!parsed) return [];
  const { ast, comments } = parsed;
  const markers: StandaloneHiddenMarker[] = [];

  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    if (c.type !== 'Line') continue;
    if (!pattern.test(c.value)) continue;

    // Skip when the next comment is line-adjacent and is a real HM annotation.
    // That case is already handled in extractAnnotations by attaching `hidden`
    // to the annotation entry.
    const next = comments[i + 1];
    if (next && next.type === 'Line') {
      const gap = source.slice(c.end, next.start);
      if (/^\s*$/.test(gap) && HM_PATTERN.test(next.value)) continue;
    }

    // Walk the AST to find the next class method or prototype-object property
    // appearing after this directive.
    const target = findNextHidableMember(ast, c.end);
    if (target) {
      markers.push({
        typeName: target.typeName,
        methodName: target.methodName,
        commentStart: c.start,
        commentEnd: c.end,
        memberStart: target.start,
      });
    }
  }
  return markers;
}

/** Look for the next class MethodDefinition or prototype-object Property that
 *  starts after `afterOffset` and whose owner type is determinable. */
function findNextHidableMember(
  ast: estree.Program,
  afterOffset: number,
): { typeName: string; methodName: string; start: number } | null {
  let best: { typeName: string; methodName: string; start: number } | null = null;

  const consider = (start: number, typeName: string, methodName: string) => {
    if (start <= afterOffset) return;
    if (!best || start < best.start) best = { typeName, methodName, start };
  };

  const propertyKeyName = (key: estree.Node | null | undefined): string | null => {
    if (!key) return null;
    if (key.type === 'Identifier') return (key as estree.Identifier).name;
    if (key.type === 'Literal' && typeof (key as estree.Literal).value === 'string') {
      return (key as estree.Literal).value as string;
    }
    return null;
  };

  const ownerOfPrototypeObject = (parent: estree.Node | null): string | null => {
    if (!parent) return null;
    // const X$prototype = { ... }   →  X
    if (parent.type === 'VariableDeclarator') {
      const vd = parent as estree.VariableDeclarator;
      if (vd.id?.type === 'Identifier' && /\$prototype$/.test(vd.id.name)) {
        return vd.id.name.replace(/\$prototype$/, '');
      }
    }
    // X.prototype = { ... }
    if (parent.type === 'AssignmentExpression') {
      const ae = parent as estree.AssignmentExpression;
      const left = ae.left;
      if (left.type === 'MemberExpression'
          && !left.computed
          && left.object.type === 'Identifier'
          && left.property.type === 'Identifier'
          && left.property.name === 'prototype') {
        return left.object.name;
      }
    }
    return null;
  };

  walk.ancestor(ast, {
    MethodDefinition(node, _state, ancestors) {
      const methodName = propertyKeyName(node.key as estree.Node);
      if (!methodName) return;
      // Climb to the enclosing ClassDeclaration / ClassExpression
      for (let k = ancestors.length - 2; k >= 0; k--) {
        const a = ancestors[k] as estree.Node;
        if (a.type === 'ClassDeclaration' || a.type === 'ClassExpression') {
          const className = (a as estree.ClassDeclaration).id?.name;
          if (className) consider(node.start, className, methodName);
          return;
        }
      }
    },
    Property(node, _state, ancestors) {
      const methodName = propertyKeyName(node.key as estree.Node);
      if (!methodName) return;
      // Climb: Property -> ObjectExpression -> (VariableDeclarator | AssignmentExpression)
      // ancestors: [Program, ..., parentOfObj, ObjectExpression, Property]
      const objIdx = ancestors.length - 2;
      const parent = ancestors[objIdx - 1] as estree.Node | undefined;
      const owner = ownerOfPrototypeObject(parent ?? null);
      // Resolved class/prototype owner: register the method-level marker.
      // Otherwise still consider the property so its offset can be marked
      // hidden — plain object-literal fields use offset-based filtering.
      if (owner) consider(node.start, owner, methodName);
      else consider(node.start, '', methodName);
    },
  } as walk.AncestorVisitors<unknown>);

  return best;
}

function extractAnnotationsImpl(source: string): TypeAnnotation[] {
  const parsed = parseWithComments(source);
  if (!parsed) return [];
  const { ast, comments } = parsed;

  const annotations: TypeAnnotation[] = [];
  const skipIndices = new Set<number>(); // comments consumed as continuation lines

  for (let i = 0; i < comments.length; i++) {
    if (skipIndices.has(i)) continue;

    const comment = comments[i];
    const text = comment.value;
    const match = HM_PATTERN.exec(text);
    if (!match) continue;
    // Block comments: the annotation must START A PARAGRAPH — the first
    // non-empty line of the block, or a line directly after a blank (or bare
    // JSDoc `*`) line, as in
    //   /**
    //    * For more info: …
    //    *
    //    * Array#traverse :: Applicative f => …
    //    */
    // HM_PATTERN is multiline, so without this guard any `Name :: …` line in
    // the middle of a prose paragraph (notes, quoted examples) would be parsed
    // as a real annotation.
    if (comment.type === 'Block' && !blockAnnotationStartsParagraph(text, match)) continue;

    const annotationName = match[1]; // optional name before ::
    let raw = match[2].trim();       // type signature after ::

    // Compute the source offset of the annotation name within the comment.
    // comment.value starts at comment.start + 2 (after `//` or `/*`).
    let signatureNameStart: number | undefined;
    let signatureNameEnd: number | undefined;
    if (annotationName) {
      const nameIdx = text.indexOf(annotationName, match.index);
      if (nameIdx >= 0) {
        signatureNameStart = comment.start + 2 + nameIdx;
        signatureNameEnd = signatureNameStart + annotationName.length;
      }
    }

    // Skip ::directive keywords — these are handled by their own extractors.
    // Directives use `::keyword` (no space before keyword after `::` in the
    // comment body), while type annotations always have a space after `::`.
    if (!annotationName && /^(?:types|constraint|global|narrow|hidden|private|extend|rep|prefer|builtin|curried|ignore(?:-file|-function)?)\b/.test(raw)) continue;

    // Skip shorthand data type declarations (e.g. `// Either2 :: Left e | Right a`).
    // These are handled by extractDataDirectives instead.  Also covers the
    // multi-line forms (block comments / `|`-continued line comments) so their
    // continuation lines are not mis-parsed as standalone annotations.
    if (annotationName && /^[A-Z]/.test(annotationName)) {
      const ds = readDataShorthand(comments, i, source);
      if (ds) {
        for (const c of ds.consumed) skipIndices.add(c);
        continue;
      }
    }

    const commentStart = comment.start;
    let commentEnd = comment.end;
    const narrowDirective = findImmediateNarrowDirective(comments, i, source);
    // Collect EVERY stacked `::hidden` / `::private` directive above this
    // annotation.  Several `::hidden <Name>` lines may stack above one chained
    // annotation, each independently selecting a different target.
    const hiddenInfo = collectStackedDirectives(comments, i, source, HIDDEN_DIRECTIVE_PATTERN);
    const privateInfo = collectStackedDirectives(comments, i, source, PRIVATE_DIRECTIVE_PATTERN);

    // --- Multi-line support: block comments (/* ... */) ---
    // HM_PATTERN with /m flag only captures to end of the first matching line.
    // If there is remaining content in the block comment, append it.
    if (comment.type === 'Block') {
      const matchEnd = match.index + match[0].length;
      const remaining = text.slice(matchEnd);
      if (remaining.trim()) {
        // Continuation runs to the end of the PARAGRAPH: a blank (or bare
        // JSDoc `*`) line ends the annotation, so prose that follows in the
        // same block comment is not glued onto the signature.
        const continuationLines: string[] = [];
        const remLines = remaining.split('\n');
        // remLines[0] is the (empty) tail of the annotation's own line.
        for (let li = 1; li < remLines.length; li++) {
          const line = remLines[li].replace(/^\s*\*?\s?/, '').trim();
          if (line.length === 0) break;
          continuationLines.push(line);
        }
        if (continuationLines.length > 0) {
          raw = raw + ' ' + continuationLines.join(' ');
        }
      }
    }

    // --- Multi-line support: consecutive line comments (// ...) ---
    // If the current comment is a line comment and the type signature so far
    // has unbalanced brackets/braces/parens, look ahead for continuation
    // lines that are NOT new annotations or directives.
    if (comment.type === 'Line') {
      const joined = joinLineContinuations(comments, i, source, raw, commentEnd);
      raw = joined.raw;
      commentEnd = joined.commentEnd;
      for (const j of joined.consumed) skipIndices.add(j);
    }

    let schemeResult: Scheme | null = null;
    let error: string | undefined;
    let receiver: Type | undefined;
    let methodType: Type | undefined;
    let isNarrowableBooleanMember = false;

    // --- Chained annotation: `// A :: B :: TypeSig` ---
    // The first `::` is consumed by HM_PATTERN above (annotationName = A,
    // raw = "B :: TypeSig").  Detect a leading `Identifier(.Identifier)? ::`
    // in `raw` and split off the second name so we can register a secondary
    // annotation entry under that name with the same parsed scheme.
    // Chained names collected from `// A :: B :: C :: … :: TypeSig`.  The
    // first `::` is consumed by HM_PATTERN (annotationName = A); here we peel
    // any number of further leading `Name ::` prefixes off `raw`, each of
    // which becomes a secondary annotation entry sharing the parsed scheme.
    const chainedNames: { name: string; start?: number; end?: number }[] = [];
    let chainedError: string | undefined;
    if (annotationName) {
      // Start searching for chained names after the first `::` so we never
      // re-match the leading annotation name itself.
      const firstSepIdx = text.indexOf('::', match.index);
      let searchFrom = firstSepIdx >= 0 ? firstSepIdx + 2 : 0;
      for (;;) {
        const chainMatch = /^([A-Za-z_$][\w$]*(?:[#.][A-Za-z_$][\w$]*)?)\s*::\s*([\s\S]+)$/.exec(raw);
        if (!chainMatch) break;
        const secondName = chainMatch[1];
        const isValidShape = /^[A-Za-z_$][\w$]*(?:[.#][A-Za-z_$][\w$]*)?$/.test(secondName);
        if (!isValidShape && chainedError === undefined) {
          chainedError = `Invalid chained annotation name '${secondName}': only Identifier, Identifier.Identifier or Identifier#Identifier are allowed`;
        }
        // Locate this name in the original comment text, advancing past each
        // consumed `::` so repeated names get distinct positions.
        let nameStart: number | undefined;
        let nameEnd: number | undefined;
        const nameIdx = text.indexOf(secondName, searchFrom);
        if (nameIdx >= 0) {
          nameStart = comment.start + 2 + nameIdx;
          nameEnd = nameStart + secondName.length;
          const sepIdx = text.indexOf('::', nameIdx + secondName.length);
          searchFrom = sepIdx >= 0 ? sepIdx + 2 : nameIdx + secondName.length;
        }
        chainedNames.push({ name: secondName, start: nameStart, end: nameEnd });
        // Strip the prefix so the remainder is parsed as the actual signature
        // (or the next chained name on the following iteration).
        raw = chainMatch[2].trim();
      }
    }

    try {
      if (raw.includes('~>')) {
        // Method type signature: ReceiverType ~> MethodType
        const parsed = parseMethodTypeSignature(raw);
        schemeResult = parsed.scheme;
        receiver = parsed.receiver;
        methodType = parsed.methodType;
        if (narrowDirective) {
          // Allow ::narrow on method annotations when the method type is Boolean
          // (getter) or returns Boolean (method like `() -> Boolean`).
          const methodReturnType = methodType ? getReturnType(methodType) : undefined;
          if (methodReturnType && methodReturnType.tag === 'TCon' && methodReturnType.name === T_BOOLEAN) {
            // Store the variant name for use by the narrowing system
            // (stored on the annotation object after construction below)
          } else {
            error = '::narrow can only be used with regular function annotations or Boolean-returning methods';
          }
        }
      } else {
        schemeResult = parseTypeSignature(raw);
        if (schemeResult && narrowDirective) {
          const returnType = getReturnType(schemeResult.type);
          if (!(returnType.tag === 'TCon' && returnType.name === T_BOOLEAN)) {
            error = '::narrow can only be used on Boolean-returning functions';
            schemeResult = null;
          } else if (schemeResult.type.tag !== 'TFun') {
            // A bare Boolean MEMBER annotation (e.g. `// Body#isStream ::
            // Boolean`) is a getter-style narrowing predicate: when the
            // property is truthy the receiver narrows to the named variant.
            // This is valid only on members (`Type#prop`); a free-standing
            // `// foo :: Boolean` has no receiver to narrow.
            if (annotationName && annotationName.includes('#')) {
              isNarrowableBooleanMember = true;
            } else {
              error = '::narrow requires a function annotation (e.g. a -> Boolean)';
              schemeResult = null;
            }
          } else {
            // Collect the curried parameters.
            const params: Type[] = [];
            let cur: Type = schemeResult.type;
            while (cur.tag === 'TFun') {
              params.push(cur.param);
              cur = cur.result;
            }

            // `::narrow <InstanceType>`: the directive body is read wholly as
            // a type.  The narrowed parameter is always the LAST parameter
            // (the value being tested).
            const narrowedType = parseType(narrowDirective.narrowedTypeRaw);

            // Link a polymorphic label in the narrowed record (e.g. `k` in
            // `{ [k] :: a }`) to the signature parameter that supplies its
            // concrete value, so the call-site narrowing can substitute it.
            // The parser turns a bare `k` parameter into a LABEL variable when
            // `[k]` appears elsewhere in the signature, so match either sort.
            const keyVarName = firstLabelVarName(narrowedType);
            let keyParamIndex: number | undefined;
            if (keyVarName) {
              const idx = params.findIndex(
                p =>
                  (p.tag === 'TVar' && p.name === keyVarName) ||
                  (p.tag === 'TLabel' && p.kind === 'var' && p.name === keyVarName),
              );
              if (idx >= 0) keyParamIndex = idx;
            }

            // Narrow the LAST parameter (the value being tested).  Single-param
            // predicates (`a -> Boolean`) narrow their sole parameter;
            // multi-parameter predicates such as `k -> { [k] :: a } -> Boolean`
            // narrow the trailing record.
            const paramIndex = params.length - 1;
            const narrowedParam = params[paramIndex];
            const paramName =
              narrowedParam.tag === 'TVar'
                ? narrowedParam.name
                : narrowedParam.tag === 'TLabel' && narrowedParam.kind === 'var'
                  ? narrowedParam.name
                  : '';
            schemeResult = {
              ...schemeResult,
              typePredicate: {
                paramName,
                paramIndex,
                narrowedType,
                ...(keyVarName ? { keyVarName } : {}),
                ...(keyParamIndex !== undefined ? { keyParamIndex } : {}),
              },
            };
          }
        }
      }
    } catch (e) {
      /* istanbul ignore else — parseTypeSignature/parseMethodTypeSignature only throw TypeParseError */
      if (e instanceof TypeParseError) {
        error = e.message;
      } else {
        error = `Failed to parse type signature: ${raw}`;
      }
    }

    const isNarrowableMethodType = narrowDirective && !error && methodType
      && getReturnType(methodType).tag === 'TCon'
      && (getReturnType(methodType) as Extract<Type, { tag: 'TCon' }>).name === T_BOOLEAN;

    // ::hidden marks the following annotation as completion-suppressed.
    // It is most useful on instance/static member annotations
    // (`Type#prop`, `Type.method`); on other annotations the flag has no
    // effect and is silently ignored (no error).  Standalone
    // `::hidden` directives (no annotation below) are handled separately
    // by `extractStandaloneHiddenMarkers`.
    // Optional `::hidden <Qualified.Name>` / `::private <Qualified.Name>`
    // target argument.  When present, only the registration target whose
    // qualified name equals the argument is hidden/privatised.  Stacked
    // directives are merged: an argument-less directive hides every member,
    // while each argument-bearing directive selects its own target.
    const isMemberName = !!annotationName
      && (annotationName.includes('#') || annotationName.includes('.'));
    let hiddenFlag = false;
    if (hiddenInfo.present && isMemberName
        && (hiddenInfo.hasNoArg || hiddenInfo.args.has(annotationName))) {
      hiddenFlag = true;
    }
    let privateFlag = false;
    if (privateInfo.present && isMemberName
        && (privateInfo.hasNoArg || privateInfo.args.has(annotationName))) {
      privateFlag = true;
      // ::private implies ::hidden — privates are also filtered from
      // completions.
      hiddenFlag = true;
    }

    const annotation: TypeAnnotation = {
      raw,
      scheme: schemeResult,
      error,
      commentStart,
      commentEnd,
      receiver,
      methodType,
      signatureNameStart,
      signatureNameEnd,
      ...((isNarrowableMethodType || isNarrowableBooleanMember) && narrowDirective
        ? { narrowVariant: narrowDirective.narrowedTypeRaw }
        : {}),
      ...(narrowDirective
        ? { narrowLoc: { start: narrowDirective.start, end: narrowDirective.end } }
        : {}),
      ...(hiddenFlag ? { hidden: true } : {}),
      ...(privateFlag ? { private: true } : {}),
    };

    // Trailing annotation (`const filter = ...; // filter :: String`): when
    // the comment sits AFTER a statement on the same line and that statement
    // declares exactly the annotated name, it documents THAT binding — attach
    // backward instead of leaking forward to the next declaration (which
    // would produce a spurious name-mismatch diagnostic there).
    let attached = annotationName
      ? findSameLineDeclaration(ast, commentStart, source, annotationName)
      : null;

    // Try to find the declaration that follows this comment
    if (!attached) attached = findNextDeclaration(ast, commentEnd, source, annotationName);

    // If another HM annotation comment sits between this annotation and the
    // found declaration, the declaration belongs to that closer annotation —
    // detach it from this one.
    if (attached) {
      for (let k = i + 1; k < comments.length; k++) {
        if (skipIndices.has(k)) continue;
        const c = comments[k];
        if (c.start >= attached.nodeStart) break;
        if (c.start < commentEnd) continue;
        if (HM_PATTERN.test(c.value)) {
          attached = null;
          break;
        }
      }
    }

    // A type alias (`// Thing :: { … }`) followed by a BLANK line and an
    // unrelated declaration (`// How long …` / `const TTL = 1000;`) stands
    // alone: it is not that declaration's annotation, and must stay a type
    // name that importers can see.
    if (attached && annotationName && /^[A-Z]/.test(annotationName)
        && !annotationName.includes('#') && !annotationName.includes('.')
        && attached.name !== undefined && attached.name !== annotationName
        && /\n[ \t]*\r?\n/.test(source.slice(commentEnd, attached.nodeStart))) {
      attached = null;
    }

    if (attached) {
      // When the annotation has an explicit name with '#' and the attached
      // declaration also has '#', validate that the method name part matches.
      // e.g. `// Left#mapp :: ...` above `Left.prototype.map` is invalid
      //       because 'mapp' !== 'map', but `// Either#map :: ...` is valid.
      if (annotationName && attached.name
          && annotationName.includes('#') && attached.name.includes('#')) {
        const annMethod = annotationName.split('#')[1];
        const attachedMethod = attached.name.split('#')[1];
        annotation.name = annotationName;
        annotation.nodeStart = attached.nodeStart;
        annotation.nameStart = attached.nameStart;
        annotation.nameEnd = attached.nameEnd;
        if (annMethod !== attachedMethod) {
          // Don't set error here — the diagnostic will be produced by the
          // inference engine on the function declaration so the user sees
          // the problem at the implementation site, not at the annotation.
          annotation.methodNameMismatch = attachedMethod;
          annotation.mismatchNameStart = attached.nameStart;
          annotation.mismatchNameEnd = attached.nameEnd;
        }
      } else if (annotationName && attached.name
          && annotationName.includes('#') && !attached.name.includes('#')) {
        // Method annotation above a plain variable/function.
        // Several valid patterns:
        //  (a) Top-level: `// Box#value :: Box a ~> a` above `const Box = ...`
        //      The base type name matches the variable → normal attachment.
        //  (b) Prototype: `// Box#map :: ...` above `function Box$prototype$map`
        //      The JS prototype pattern matches the annotation.
        //  (c) Nested: `// Either2#map :: ...` above `const map = fn => ...`
        //      The method name part should match the variable name.
        //  (d) Top-level: `// Either#map :: ...` above `class Left { ... }`
        //      Unrelated — the attached name is a class/type not a method impl.
        const annBase = annotationName.split('#')[0];
        const annMethod = annotationName.split('#')[1];
        annotation.name = annotationName;
        annotation.nodeStart = attached.nodeStart;
        annotation.nameStart = attached.nameStart;
        annotation.nameEnd = attached.nameEnd;
        if (annBase === attached.name) {
          // Case (a): annotation for type "Box" above its constructor "Box"
          // — valid, no mismatch.
        } else if (attached.name === `${annBase}$prototype$${annMethod}`) {
          // Case (b): JS prototype pattern — valid, no mismatch.
        } else if (chainedNames.some(cn => cn.name === attached!.name)) {
          // Case (e): chained annotation `// Array#chain :: builtIn.Array :: T`
          // attached to `builtIn.Array = …`.  The attached binding is one of
          // the chained-secondary targets, not a method-name mismatch.
        } else if (attached.name.includes('.')) {
          // Case (f): single-name method annotation attached to a member
          // assignment on a plain-object host
          // (`// Array#chain :: T` above `builtIn.Array = …`).  The host
          // record extension is incidental — the annotation registers a
          // method on `Array`, not on `builtIn.Array`.  No mismatch.
        } else if (/^[a-z_$]/.test(attached.name) && annMethod !== attached.name) {
          // Case (c): nested lowercase variable name should match method name
          // part. Uppercase names (case d) are classes/type constructors and
          // don't represent method implementations.
          annotation.methodNameMismatch = attached.name;
          annotation.mismatchNameStart = attached.nameStart;
          annotation.mismatchNameEnd = attached.nameEnd;
        }
      } else if (annotationName && attached.name
          && !annotationName.includes('#') && !annotationName.includes('.')
          && !attached.name.includes('#') && !attached.name.includes('.')
          && annotationName !== attached.name
          && /^[a-z_$]/.test(annotationName)) {
        // Regular function/variable name mismatch:
        // e.g. `// memoize :: ...` above `const memoizee = ...`
        // Only applies when the annotation name is lowercase-initial —
        // uppercase names (e.g. Person, Either) are type aliases or
        // constructors that intentionally differ from the next declaration.
        annotation.name = annotationName;
        annotation.nodeStart = attached.nodeStart;
        annotation.nameStart = attached.nameStart;
        annotation.nameEnd = attached.nameEnd;
        annotation.nameMismatch = attached.name;
      } else {
        annotation.name = annotationName || attached.name;
        annotation.nodeStart = attached.nodeStart;
        annotation.nameStart = attached.nameStart;
        annotation.nameEnd = attached.nameEnd;
        if (!annotationName && attached.name) {
          annotation.namelessOnNamed = attached.name;
        }
      }
    } else if (annotationName) {
      annotation.name = annotationName;
    }

    annotations.push(annotation);

    // Emit one secondary annotation per chained name in `// A :: B :: C :: T`.
    for (const cn of chainedNames) {
      // A `::hidden` / `::private` directive above a chained annotation hides
      // (or privatises) every member-shaped registration target in the chain,
      // regardless of which position holds the binding name.  This covers
      // orderings like `// builtIn.Array :: Array#reduce :: T` where the real
      // registration target (`Array#reduce`) is a chained secondary rather
      // than the primary name.
      const cnIsMember = cn.name.includes('#') || cn.name.includes('.');
      const secondaryPrivate = privateInfo.present && cnIsMember
        && (privateInfo.hasNoArg || privateInfo.args.has(cn.name));
      const secondaryHidden = ((hiddenInfo.present && (hiddenInfo.hasNoArg || hiddenInfo.args.has(cn.name)))
        || secondaryPrivate) && cnIsMember;
      const secondary: TypeAnnotation = {
        raw,
        scheme: chainedError ? null : schemeResult,
        error: chainedError ?? error,
        commentStart,
        commentEnd,
        receiver,
        methodType,
        signatureNameStart: cn.start,
        signatureNameEnd: cn.end,
        name: cn.name,
        chainedSecondary: true,
        // Inherit attachment from the primary so hover/sig-help can find
        // the same declaration via any of the chained names.
        nodeStart: annotation.nodeStart,
        nameStart: annotation.nameStart,
        nameEnd: annotation.nameEnd,
        ...(secondaryHidden ? { hidden: true } : {}),
        ...(secondaryPrivate ? { private: true } : {}),
      };
      annotations.push(secondary);
    }
  }

  return annotations;
}

/**
 * Build a map from declaration name -> parsed Scheme for all valid annotations.
 *
 * When the same name appears more than once with non-method annotations
 * (e.g. two `Table :: ...` lines in a `.hm` file) the schemes are merged
 * into a single overloaded scheme using `mergeOverloadSchemes`. Call sites
 * use the existing union-unification path to pick the matching branch.
 */
export function buildAnnotationMap(source: string): Map<string, TypeAnnotation> {
  const annotations = extractAnnotations(source);
  const map = new Map<string, TypeAnnotation>();
  const declOf = declarationStarts(annotations);
  const firstDecl = new Map<string, number | undefined>();
  // Lazy import to avoid a cycle: env.ts -> types.ts is fine, but
  // commentParser.ts is loaded from many places that don't otherwise
  // pull in env.ts.
  const { mergeOverloadSchemes } = require('./hm/env') as typeof import('./hm/env');

  for (const ann of annotations) {
    if (!ann.name || !ann.scheme || ann.namelessOnNamed) continue;
    // `Name()` (instance-callable) annotations are stored separately via
    // `extractInstanceCallables`; skip them here so they never enter the
    // value-level `annotationMap` (where they'd be misread as a constructor
    // scheme by hover/sig-help/arity/alias passes).
    if (ann.name.endsWith('()')) continue;
    const existing = map.get(ann.name);
    // Overloads are annotation lines above the SAME declaration.  A second
    // declaration with the same name (a nested helper such as `safeReject`
    // in two closures) is a different binding: it keeps its own annotation,
    // reachable through `buildAnnotationsByDeclaration`; the map keeps the
    // first.
    const at = declOf.get(ann);
    if (!firstDecl.has(ann.name)) firstDecl.set(ann.name, at);
    const first = firstDecl.get(ann.name);
    if (existing && first !== undefined && at !== undefined && first !== at) continue;
    if (existing && existing.scheme
        && !ann.name.includes('#')) {
      // Plain names AND dotted statics (`Task.ask`) merge into an overload
      // union; method-form (`#`) annotations go through the method registry
      // instead.  Without the dotted case, the LAST `Task.ask :: ...` line
      // would silently replace earlier overloads (an FP library's `ask :: () -> ...`
      // / `ask :: (r -> a) -> ...` pair).
      const merged = mergeOverloadSchemes(existing.scheme, ann.scheme);
      // Keep the FIRST annotation's metadata (location, raw text) as the
      // anchor; record the merged scheme. Hover/signature surfaces can
      // present all branches by re-walking the original annotation list.
      map.set(ann.name, { ...existing, scheme: merged, origin: 'local' });
    } else {
      map.set(ann.name, { ...ann, origin: 'local' });
    }
  }

  return map;
}

/**
 * Build a map from type name -> array of Schemes for all `Name() :: T`
 * (instance-callable) annotations in the source.  Multiple `Name()`
 * declarations produce multiple overload entries, in declaration order.
 *
 * Used by the inference engine and hover/signature help to look up the
 * callable signatures of an uppercase TCon-typed value (e.g. an
 * `QueryTag {row}` instance is callable as `({}) -> RTask r e [b]`).
 */
export function extractInstanceCallables(source: string): Map<string, Scheme[]> {
  const annotations = extractAnnotations(source);
  const map = new Map<string, Scheme[]>();
  for (const ann of annotations) {
    if (!ann.name || !ann.scheme) continue;
    if (!ann.name.endsWith('()')) continue;
    const baseName = ann.name.slice(0, -2);
    if (!baseName) continue;
    const list = map.get(baseName);
    if (list) list.push(ann.scheme);
    else map.set(baseName, [ann.scheme]);
  }
  return map;
}

/**
 * The declaration each annotation belongs to.  Only the LAST line of an
 * overload block carries `nodeStart`; the earlier lines belong to the next
 * same-named annotation that does.
 */
const declarationStartsMemo = new WeakMap<TypeAnnotation[], Map<TypeAnnotation, number | undefined>>();

export function declarationStarts(annotations: TypeAnnotation[]): Map<TypeAnnotation, number | undefined> {
  const memo = declarationStartsMemo.get(annotations);
  if (memo) return memo;
  const out = new Map<TypeAnnotation, number | undefined>();
  declarationStartsMemo.set(annotations, out);
  const nextByName = new Map<string, number>();
  for (let i = annotations.length - 1; i >= 0; i--) {
    const ann = annotations[i];
    if (!ann.name) continue;
    if (ann.nodeStart !== undefined) nextByName.set(ann.name, ann.nodeStart);
    out.set(ann, ann.nodeStart ?? nextByName.get(ann.name));
  }
  return out;
}

/**
 * Map from declaration node start → that declaration's own annotation, with
 * its overload lines merged (as `buildAnnotationMap` does per name).  Lets
 * same-named bindings in different scopes find their own signature.
 */
const byDeclarationCache: { source: string; map: Map<number, TypeAnnotation> }[] = [];

export function buildAnnotationsByDeclaration(source: string): Map<number, TypeAnnotation> {
  for (const hit of byDeclarationCache) if (hit.source === source) return hit.map;
  const map = buildAnnotationsByDeclarationUncached(source);
  byDeclarationCache.unshift({ source, map });
  if (byDeclarationCache.length > 8) byDeclarationCache.pop();
  return map;
}

function buildAnnotationsByDeclarationUncached(source: string): Map<number, TypeAnnotation> {
  const { mergeOverloadSchemes } = require('./hm/env') as typeof import('./hm/env');
  const map = new Map<number, TypeAnnotation>();
  const annotations = extractAnnotations(source);
  const declOf = declarationStarts(annotations);
  for (const ann of annotations) {
    const at = declOf.get(ann);
    if (!ann.name || !ann.scheme || ann.namelessOnNamed || at === undefined) continue;
    if (ann.name.endsWith('()') || ann.name.includes('#')) continue;
    const existing = map.get(at);
    if (existing?.scheme && existing.name === ann.name) {
      map.set(at, { ...existing, scheme: mergeOverloadSchemes(existing.scheme, ann.scheme), origin: 'local' });
    } else if (!existing) {
      map.set(at, { ...ann, nodeStart: at, origin: 'local' });
    }
  }
  return map;
}

/**
 * Build a map from node start offset -> TypeAnnotation.
 */
export function buildAnnotationByOffset(source: string): Map<number, TypeAnnotation> {
  const annotations = extractAnnotations(source);
  const map = new Map<number, TypeAnnotation>();

  for (const ann of annotations) {
    if (ann.nodeStart !== undefined && !ann.namelessOnNamed) {
      map.set(ann.nodeStart, ann);
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// ::types directive extraction
// ---------------------------------------------------------------------------

/** Regex to match `// ::types <specifier>` directives in comments. */
const TYPES_DIRECTIVE_PATTERN = /^[\s*]*::types\s+(.+)$/m;

/** Regex to match `// ::constraint Name v { ... }` directives in comments. */
const CONSTRAINT_DIRECTIVE_PATTERN = /^[\s*]*::constraint\s+/m;

/**
 * Extract all `// ::types <specifier>` directives from a JavaScript source string.
 *
 * These directives tell the type system to load type annotations from another
 * file or package, without requiring a runtime import. Supports:
 *   - Relative paths: `// ::types ./demo`
 *   - Package names:  `// ::types fantasy-box`
 *   - Scoped packages: `// ::types @scope/package`
 */
export function extractTypeDirectives(source: string): string[] {
  return extractTypeDirectivesWithLocations(source).map(d => d.specifier);
}

/**
 * Extract all `// ::types <specifier>` directives with their source locations.
 * Returns an array of `{ specifier, start, end }` objects.
 */
export function extractTypeDirectivesWithLocations(source: string): { specifier: string; start: number; end: number }[] {
  const parsed = parseWithComments(source);
  if (!parsed) {
    // If parsing fails, try regex-based extraction from raw source as fallback
    const directives: { specifier: string; start: number; end: number }[] = [];
    const lineRegex = /\/\/\s*::types\s+(.+)/g;
    let match;
    while ((match = lineRegex.exec(source)) !== null) {
      directives.push({ specifier: match[1].trim(), start: match.index, end: match.index + match[0].length });
    }
    return directives;
  }
  const { comments } = parsed;

  const directives: { specifier: string; start: number; end: number }[] = [];

  for (const comment of comments) {
    const match = TYPES_DIRECTIVE_PATTERN.exec(comment.value);
    if (match) {
      directives.push({ specifier: match[1].trim(), start: comment.start, end: comment.end });
    }
  }

  return directives;
}

/** Regex matching `// ::prefer <Name>(, <Name>)* from <specifier>` directives. */
const PREFER_DIRECTIVE_PATTERN = /^[\s*]*::prefer\s+([A-Z][A-Za-z0-9_]*(?:\s*,\s*[A-Z][A-Za-z0-9_]*)*)\s+from\s+(\S+)\s*$/m;

/**
 * Extract `// ::prefer <Name>(, <Name>)* from <specifier>` directives.  Used
 * to disambiguate when the same uppercase type/constructor name (e.g.
 * `Prop`) is defined by multiple loaded sidecars/globals.  Multiple names
 * may share one directive, e.g. `// ::prefer Prop, Table from query-builder`.
 * Returns a Map from each declared name to its preferred origin specifier
 * (bare package name or relative path, exactly as written).  When the
 * same name appears in multiple directives, the last wins.
 */
export function extractPreferDirectives(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const parsed = parseWithComments(source);
  const consume = (names: string, specifier: string): void => {
    for (const raw of names.split(',')) {
      const name = raw.trim();
      if (name) result.set(name, specifier);
    }
  };
  if (parsed) {
    for (const comment of parsed.comments) {
      const m = PREFER_DIRECTIVE_PATTERN.exec(comment.value);
      if (m) consume(m[1], m[2]);
    }
  } else {
    // Fallback: regex on raw source when parsing fails
    const re = /\/\/\s*::prefer\s+([A-Z][A-Za-z0-9_]*(?:\s*,\s*[A-Z][A-Za-z0-9_]*)*)\s+from\s+(\S+)/g;
    let m;
    while ((m = re.exec(source)) !== null) consume(m[1], m[2]);
  }
  return result;
}

/** Regex to match `// ::extend <AliasName> <typeExpr>` directives in comments. */
const EXTEND_DIRECTIVE_PATTERN = /^[\s*]*::extend\s+([A-Z]\w*)\s+(.+?)\s*$/m;

/**
 * Extract all `// ::extend <AliasName> <typeExpr>` directives from source.
 *
 * Each directive appends `typeExpr` to the named union-alias post-build
 * (see `applyAliasExtensions` in src/infer/annotations.ts).  Generic
 * mechanism — independent of any particular library.  When `typeExpr` is
 * itself a `|`-union, its branches are flattened into the target.
 *
 * Returns an array of `{ name, raw, start, end }` where `raw` is the
 * unparsed RHS to be fed into `parseTypeSignature` later.
 */
export function extractAliasExtensions(source: string): { name: string; raw: string; start: number; end: number }[] {
  const parsed = parseWithComments(source);
  const results: { name: string; raw: string; start: number; end: number }[] = [];
  if (!parsed) {
    // Fallback: regex on raw source when parsing fails.
    const lineRegex = /\/\/\s*::extend\s+([A-Z]\w*)\s+(.+)/g;
    let m;
    while ((m = lineRegex.exec(source)) !== null) {
      results.push({ name: m[1], raw: m[2].trim(), start: m.index, end: m.index + m[0].length });
    }
    return results;
  }
  for (const comment of parsed.comments) {
    const m = EXTEND_DIRECTIVE_PATTERN.exec(comment.value);
    if (m) {
      results.push({ name: m[1], raw: m[2].trim(), start: comment.start, end: comment.end });
    }
  }
  return results;
}

/**
 * Extract all `// ::constraint ...` directive comment bodies from source.
 * Returns the raw comment text for each ::constraint comment.
 */
export function extractConstraintDirectives(source: string): { text: string; start: number; end: number }[] {
  const parsed = parseWithComments(source);
  if (!parsed) {
    // Fallback: regex on raw source
    const results: { text: string; start: number; end: number }[] = [];
    const lineRegex = /\/\/\s*(::constraint\s+.+)/g;
    let match;
    while ((match = lineRegex.exec(source)) !== null) {
      results.push({ text: match[1], start: match.index, end: match.index + match[0].length });
    }
    return results;
  }
  const { comments } = parsed;

  const results: { text: string; start: number; end: number }[] = [];

  // Continuation rule for `//` directives: a `// ::constraint` line whose
  // body has unbalanced `{`/`}` is concatenated with adjacent `//` line
  // comments until the braces are balanced. This allows multi-line
  // definitions like:
  //   // ::constraint Indexed r e s {
  //   //   r :: [e] | Map s e,
  //   //   s :: Number | String
  //   // }
  // Block comments (/* ... */) already contain their newlines in `value`;
  // we apply the same brace-balance heuristic line-by-line.
  const braceDelta = (s: string): number => {
    let d = 0;
    for (const ch of s) {
      if (ch === '{') d++;
      else if (ch === '}') d--;
    }
    return d;
  };
  const flattenBlock = (value: string): string => {
    const lines = value
      .split(/\r?\n/)
      .map(l => l.replace(/^\s*\*\s?/, '').replace(/^\s+/, ' '))
      .map(l => l.trim());
    let out = lines[0] ?? '';
    let depth = braceDelta(out);
    for (let i = 1; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln) continue;
      if (depth <= 0) break;
      out += ' ' + ln;
      depth += braceDelta(ln);
    }
    return out;
  };

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];
    if (!CONSTRAINT_DIRECTIVE_PATTERN.test(comment.value)) continue;

    let text = comment.type === 'Block'
      ? flattenBlock(comment.value).trim()
      : comment.value.trim();
    let end = comment.end;

    // Line-comment continuation: keep scanning adjacent `//` line comments
    // until the running `{`/`}` balance is zero.
    if (comment.type === 'Line') {
      let depth = braceDelta(text);
      let j = i + 1;
      while (j < comments.length && depth > 0) {
        const next = comments[j];
        if (next.type !== 'Line') break;
        text += ' ' + next.value.trim();
        depth += braceDelta(next.value);
        end = next.end;
        j++;
      }
      i = j - 1;
    }

    results.push({ text, start: comment.start, end });
  }

  return results;
}

// ---------------------------------------------------------------------------
// ::rep directive extraction
// ---------------------------------------------------------------------------

/** Regex to match `// ::rep <Constraint> <Type#method>` (instance) or
 *  `// ::rep <Constraint> <Type.method>` (static) directives.
 *  Examples: `// ::rep Foldable Array#reduce`, `// ::rep Foldable Array.off`.
 *  The separator distinguishes an instance method (`#`, carries a `~>`
 *  receiver) from a static method (`.`, no receiver). */
const REP_DIRECTIVE_PATTERN = /^[\s*]*::rep\s+([A-Z][\w$]*)\s+([A-Z][\w$]*)(#|\.)([\w$]+)\s*$/m;

export interface RepDirective {
  constraint: string;
  typeName: string;
  methodName: string;
  /** True when the directive used `Type.method` (static); false for `Type#method` (instance). */
  isStatic: boolean;
  start: number;
  end: number;
}

/**
 * Extract all `// ::rep <Constraint> <Type#method>` directives.
 *
 * A `::rep` directive declares that the named container method (annotated
 * locally in the same file) represents the constraint's like-named method
 * when discharging that constraint — scoped to the function that carries it
 * (see Fase 5).  Returns one entry per well-formed directive; malformed
 * directives are silently skipped (the caller emits no parser error).
 */
/**
 * Every `::curried` directive in the comments of a JavaScript source.  The
 * directive belongs in `.hm` files only; in JavaScript the curried behaviour
 * of a function follows from its code (see `setupPass`).
 */
export function extractCurriedDirectiveLocations(source: string): { start: number; end: number }[] {
  if (!source.includes('::curried')) return [];
  const parsed = parseWithComments(source);
  if (!parsed) return [];
  const out: { start: number; end: number }[] = [];
  for (const comment of parsed.comments) {
    const lines = comment.type === 'Block' ? comment.value.split(/\r?\n/) : [comment.value];
    if (lines.some(l => /^[\s*]*::curried\b/.test(l))) out.push({ start: comment.start, end: comment.end });
  }
  return out;
}

export function extractRepDirectives(source: string): RepDirective[] {
  const parsed = parseWithComments(source);
  const results: RepDirective[] = [];
  const collect = (text: string, start: number, end: number): void => {
    const m = REP_DIRECTIVE_PATTERN.exec(text);
    if (!m) return;
    results.push({
      constraint: m[1],
      typeName: m[2],
      isStatic: m[3] === '.',
      methodName: m[4],
      start,
      end,
    });
  };
  if (!parsed) {
    const lineRegex = /\/\/\s*(::rep\s+.+)/g;
    let match;
    while ((match = lineRegex.exec(source)) !== null) {
      collect(match[1], match.index, match.index + match[0].length);
    }
    return results;
  }
  for (const comment of parsed.comments) {
    if (comment.type === 'Block') {
      for (const line of comment.value.split(/\r?\n/)) {
        collect(line.replace(/^\s*\*\s?/, '').trim(), comment.start, comment.end);
      }
    } else {
      collect(comment.value.trim(), comment.start, comment.end);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// ::global directive extraction
// ---------------------------------------------------------------------------
const GLOBAL_DIRECTIVE_PATTERN = /^[\s*]*::global\s+/m;

/**
 * Extract all `// ::global ...` directive comment bodies from source.
 * Returns the raw comment text (without the leading `//`) for each ::global comment.
 *
 * Supports:
 *   - Instance methods: `// ::global Array#ap :: [a] ~> [a -> b] -> [b]`
 *   - Static methods:   `// ::global Array.empty :: () -> [a]`
 */
export function extractGlobalDirectives(source: string): { text: string; start: number; end: number }[] {
  const parsed = parseWithComments(source);
  if (!parsed) {
    const results: { text: string; start: number; end: number }[] = [];
    const lineRegex = /\/\/\s*(::global\s+.+)/g;
    let match;
    while ((match = lineRegex.exec(source)) !== null) {
      results.push({ text: match[1], start: match.index, end: match.index + match[0].length });
    }
    return results;
  }
  const { comments } = parsed;

  const results: { text: string; start: number; end: number }[] = [];

  for (const comment of comments) {
    if (GLOBAL_DIRECTIVE_PATTERN.test(comment.value)) {
      results.push({
        text: comment.value.trim(),
        start: comment.start,
        end: comment.end,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Sum type declaration extraction
// ---------------------------------------------------------------------------

/**
 * A parsed sum type declaration.
 *
 * Example: `// Maybe :: Just a | Nothing`
 * →  { name: 'Maybe', typeVars: ['a'], variants: [{ name: 'Just', fields: ['a'] }, { name: 'Nothing', fields: [] }] }
 */
export interface DataTypeDecl {
  /** The sum type name (e.g. 'Maybe', 'Either') */
  name: string;
  /** Type variable names (e.g. ['a'] for Maybe, ['e', 'a'] for Either) */
  typeVars: string[];
  /** Variant definitions */
  variants: DataVariant[];
  /** Comment start offset in source */
  commentStart: number;
  /** Comment end offset in source */
  commentEnd: number;
  /** Start offset of the type name within the comment */
  signatureNameStart?: number;
  /** End offset of the type name within the comment */
  signatureNameEnd?: number;
}

export interface DataVariant {
  /** Variant name (e.g. 'Just', 'Nothing', 'Left', 'Right') */
  name: string;
  /** Field types carried by this variant — type variable names (e.g. 'a') or concrete type names (e.g. 'Int') */
  fields: string[];
}

/**
 * Split `body` on top-level occurrences of a single-character separator,
 * ignoring separators nested inside parentheses `()` or braces `{}`.  Used to
 * split variant alternations (`|`) and record fields (`,`) without breaking on
 * delimiters that live inside a variant's field types (e.g. `(Map String a)`
 * or `{ status :: Int, url :: String }`).
 */
function splitTopLevel(body: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(' || ch === '{') depth++;
    else if (ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Return the index of the delimiter matching the opener at `open`, or -1. */
function matchDelim(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Delimiter-depth delta of `s`: openers minus closers.  `includeBrackets`
 * additionally counts `[`/`]`.  Used to maintain a RUNNING depth while
 * joining multi-line comment annotations so each appended line costs
 * O(line) instead of re-scanning the whole accumulated body (which made
 * joining a huge generated record annotation — e.g. an 11k-line
 * `Tables :: { … }` sidecar — quadratic: seconds of pure char-scanning
 * per cold parse).  A running `depth <= 0` test replaces the old
 * `isSignatureComplete(acc)` / `!hasOpenDelimiters(acc)` full-body scans.
 */
function delimDepthDelta(s: string, includeBrackets: boolean): number {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '{' || (includeBrackets && c === '[')) d++;
    else if (c === ')' || c === '}' || (includeBrackets && c === ']')) d--;
  }
  return d;
}

/**
 * Split a variant body (everything after the variant name) into its top-level
 * field chunks.  A field is a bare word, a balanced `(...)` group, or a
 * balanced `{...}` record group.  Whitespace inside groups is collapsed to a
 * single space.  Returns null on unbalanced or stray delimiters.
 */
function splitVariantFields(rest: string): string[] | null {
  const fields: string[] = [];
  let i = 0;
  const n = rest.length;
  while (i < n) {
    while (i < n && /\s/.test(rest[i])) i++;
    if (i >= n) break;
    const ch = rest[i];
    if (ch === '(' || ch === '{') {
      const end = matchDelim(rest, i);
      if (end < 0) return null;
      fields.push(rest.slice(i, end + 1).replace(/\s+/g, ' ').trim());
      i = end + 1;
    } else if (ch === ')' || ch === '}') {
      return null;
    } else {
      let j = i;
      while (j < n && !/[\s(){}]/.test(rest[j])) j++;
      fields.push(rest.slice(i, j));
      i = j;
    }
  }
  return fields;
}

/**
 * Parse a single variant string into its name + fields.  Handles positional
 * fields (`Redirect Number String`), parenthesized type applications
 * (`Render String (Object String a)`), and record fields
 * (`Redirect { status :: Number, url :: String }`).  Returns null when the
 * first token isn't an uppercase name or delimiters are unbalanced.
 */
function parseVariant(vs: string): DataVariant | null {
  const trimmed = vs.trim();
  const m = /^([A-Z]\w*)/.exec(trimmed);
  if (!m) return null;
  const fields = splitVariantFields(trimmed.slice(m[0].length));
  if (fields === null) return null;
  return { name: m[1], fields };
}

/**
 * Collect type-variable names (lowercase identifiers) referenced inside a
 * field type text, in first-appearance order.  Record labels — the identifier
 * immediately before each `::` inside `{...}` — are field names, not type
 * variables, and are skipped.  Nested records / parens are handled recursively.
 */
function collectVarsFromTypeText(text: string, seen: Set<string>, out: string[]): void {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '{') {
      const end = matchDelim(text, i);
      if (end < 0) { i++; continue; }
      collectVarsFromRecord(text.slice(i + 1, end), seen, out);
      i = end + 1;
    } else if (ch === '(') {
      const end = matchDelim(text, i);
      if (end < 0) { i++; continue; }
      collectVarsFromTypeText(text.slice(i + 1, end), seen, out);
      i = end + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[\w.]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (/^[a-z]/.test(word) && !word.includes('.') && !seen.has(word)) {
        seen.add(word);
        out.push(word);
      }
      i = j;
    } else {
      i++;
    }
  }
}

/** Collect type vars from a record body (`label :: T, label :: T`), skipping labels. */
function collectVarsFromRecord(inner: string, seen: Set<string>, out: string[]): void {
  for (const part of splitTopLevel(inner, ',')) {
    const dbl = part.indexOf('::');
    // The text before the first `::` is the field label (not a type var).
    const typePart = dbl < 0 ? part : part.slice(dbl + 2);
    collectVarsFromTypeText(typePart, seen, out);
  }
}

/**
 * Return the parent type variables a single field references, in order.
 * Exposed so the sumtype identifier-union builder can map complex fields
 * (records / parenthesized applications) back to their type parameters.
 */
export function fieldTypeVars(field: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  collectVarsFromTypeText(field, seen, out);
  return out;
}

/**
 * Extract the labelled fields from a record-style variant field
 * (`{ ext :: String, handler :: EngineFn }` -> [{name:'ext', type:'String'},
 * {name:'handler', type:'EngineFn'}]).  Returns [] when `field` is not a
 * `{...}` record group (e.g. a positional word or parenthesized application).
 */
export function recordFields(field: string): { name: string; type: string }[] {
  const t = field.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return [];
  const inner = t.slice(1, -1);
  const out: { name: string; type: string }[] = [];
  for (const part of splitTopLevel(inner, ',')) {
    const dbl = part.indexOf('::');
    if (dbl < 0) continue;
    const name = part.slice(0, dbl).trim();
    const type = part.slice(dbl + 2).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push({ name, type });
  }
  return out;
}

/**
 * Detect whether an annotation with an uppercase name and a raw body
 * represents the shorthand data type syntax:
 *   `// TypeName :: Variant1 a | Variant2 b`
 * Variant fields may be positional words, parenthesized type applications, or
 * record groups; at least two `|`-separated variants are required so that a
 * plain type annotation like `Maybe a` is not mistaken for a declaration.
 */
/**
 * Built-in type names that can never be the variant of a user sum type:
 * `Cell :: String | Number | Null` is an alias for a union of existing
 * types, not a declaration of three new constructors.
 */
const NON_VARIANT_TYPE_NAMES = new Set([
  'Number', 'String', 'Boolean', 'Null', 'Undefined', 'Void', 'Any', 'Object',
  'Array', 'Date', 'Error', 'Promise', 'RegExp', 'Map', 'Set', 'BigInt', 'Symbol',
  'ReactElement', 'Element',
]);

export function isDataShorthand(annotationName: string, raw: string): boolean {
  if (!/^[A-Z]/.test(annotationName)) return false;
  if (annotationName.includes('#') || annotationName.includes('.')) return false;
  const variantStrs = splitTopLevel(raw, '|').map(s => s.trim()).filter(s => s.length > 0);
  if (variantStrs.length < 2) return false;
  const variants = variantStrs.map(vs => parseVariant(vs));
  if (variants.some(v => v === null)) return false;
  return !variants.some(v => NON_VARIANT_TYPE_NAMES.has(v!.name));
}

/**
 * Parse the shorthand data type syntax:
 *   `// TypeName :: Variant1 a | Variant2 b`
 *
 * Type variables are inferred from the variant fields in order of first
 * appearance.  Fields can be type variables (lowercase) or concrete types
 * (uppercase), e.g. `// Result :: Ok Int | Err String`.
 * Returns null if the body doesn't match.
 */
export function parseDataShorthand(
  typeName: string,
  body: string,
  commentStart: number,
  commentEnd: number,
): DataTypeDecl | null {
  const variantStrs = splitTopLevel(body, '|').map(s => s.trim()).filter(s => s.length > 0);
  if (variantStrs.length < 2) return null;

  const variants: DataVariant[] = [];
  const seenVars = new Set<string>();
  const typeVars: string[] = [];

  for (const vs of variantStrs) {
    const variant = parseVariant(vs);
    if (variant === null) return null;
    for (const f of variant.fields) {
      collectVarsFromTypeText(f, seenVars, typeVars);
    }
    variants.push(variant);
  }

  return { name: typeName, typeVars, variants, commentStart, commentEnd };
}

/** A sum-type alternation body is "incomplete" when it ends with a trailing `|`. */
function isAlternationIncomplete(body: string): boolean {
  return /\|\s*$/.test(body.trim());
}

/**
 * Starting from the line comment at `index` whose accumulated signature body
 * is `raw` (ending at `commentEnd`), scan forward and consume contiguous
 * continuation line comments that belong to the same multi-line `//`
 * annotation (e.g. a record body `{ … }` split across several `//` lines, or
 * a constraint signature broken after `=>`).
 *
 * Returns the joined `raw`, the new `commentEnd`, and the indices consumed.
 * Shared by `extractAnnotationsImpl` (to build the annotation) and by
 * `extractDataDirectives` (to avoid mis-parsing a continuation line such as
 * `Route :: String -> String | RegExp -> RouteFn -> a` as its own sumtype
 * declaration).
 */
function joinLineContinuations(
  comments: estree.Comment[],
  index: number,
  source: string,
  raw: string,
  commentEnd: number,
): { raw: string; commentEnd: number; consumed: number[] } {
  const consumed: number[] = [];
  // Incremental joining state: `parts` accumulates chunks (joined once at the
  // end), `depth` tracks the running delimiter balance of the accumulated
  // body, and `tail` is the last appended chunk.  The trailing-continuation
  // and completeness tests below are equivalent to running them on the full
  // accumulated body (which ends with `tail` and whose delimiter balance is
  // `depth`) but keep each iteration O(line) instead of O(accumulated).
  const parts: string[] = [raw];
  let depth = delimDepthDelta(raw, true);
  let tail = raw;
  for (let j = index + 1; j < comments.length; j++) {
    const next = comments[j];
    if (next.type !== 'Line') break;

    // Only allow whitespace between this comment and the next.
    const gap = source.slice(commentEnd, next.start);
    if (!/^\s*$/.test(gap)) break;

    const continuationText = next.value.trim();
    if (continuationText.length === 0) break;

    const startsWithContinuation = /^(?:=>|->|~>|[|,)}\]])/.test(continuationText);
    const endsWithContinuation = /(?:=>|->|~>|[|,])\s*$/.test(tail);
    if (depth <= 0 && !startsWithContinuation && !endsWithContinuation) break;

    // A nameless annotation (`// :: ...`) or a directive starts something new.
    const nextText = next.value;
    const nextMatch = HM_PATTERN.exec(nextText);
    if (nextMatch && !nextMatch[1]) break;
    if (TYPES_DIRECTIVE_PATTERN.test(nextText)) break;
    if (CONSTRAINT_DIRECTIVE_PATTERN.test(nextText)) break;
    if (EXTEND_DIRECTIVE_PATTERN.test(nextText)) break;

    parts.push(continuationText);
    depth += delimDepthDelta(continuationText, true);
    tail = continuationText;
    commentEnd = next.end;
    consumed.push(j);
  }
  return { raw: parts.join(' '), commentEnd, consumed };
}

/**
 * Compute the set of comment indices that are *continuation* lines of a
 * multi-line `//` annotation (or of a multi-line `//` data shorthand).  These
 * indices must NOT be treated as the start of an independent annotation or
 * sumtype declaration.  Mirrors the forward-scan performed by
 * `extractAnnotationsImpl` so both extractors agree on grouping.
 */
function computeContinuationSkips(
  comments: estree.Comment[],
  source: string,
): Set<number> {
  const skip = new Set<number>();
  for (let i = 0; i < comments.length; i++) {
    if (skip.has(i)) continue;
    const comment = comments[i];
    const match = HM_PATTERN.exec(comment.value);
    if (!match) continue;
    const annotationName = match[1];

    // A multi-line `//` data shorthand consumes its own continuation lines.
    if (annotationName && /^[A-Z]/.test(annotationName)) {
      const ds = readDataShorthand(comments, i, source);
      if (ds) {
        for (const c of ds.consumed) skip.add(c);
        continue;
      }
    }

    if (comment.type !== 'Line') continue; // block continuations are intra-comment
    const raw = match[2].trim();
    const { consumed } = joinLineContinuations(comments, i, source, raw, comment.end);
    for (const c of consumed) skip.add(c);
  }
  return skip;
}

/**
 * If `comments[index]` begins a (possibly multi-line) sum-type shorthand
 * declaration, return the joined declaration plus the indices of any
 * continuation line comments that were consumed.
 *
 * Supports:
 *   - single-line:   `// T :: A x | B y`
 *   - block comment: variants split across several physical lines
 *   - line comments: consecutive `//` lines joined while the alternation is
 *     incomplete (a trailing `|`, or the next line begins with `|`).
 */
function readDataShorthand(
  comments: estree.Comment[],
  index: number,
  source: string,
): { name: string; body: string; commentStart: number; commentEnd: number; nameIdx: number; consumed: number[] } | null {
  const comment = comments[index];
  const hmMatch = HM_PATTERN.exec(comment.value);
  let name: string;
  let firstBody: string;
  let matchIndex: number;
  if (hmMatch && hmMatch[1]) {
    name = hmMatch[1];
    firstBody = (hmMatch[2] ?? '').trim();
    matchIndex = hmMatch.index;
  } else if (comment.type === 'Line') {
    // The first line may declare only the name with an empty body
    // (`// Component ::`), with every variant on the following `//` lines.
    // HM_PATTERN requires at least one char after `::`, so match it here.
    const empty = /^[\s*]*([A-Za-z_$][\w$]*)\s*::\s*$/.exec(comment.value);
    if (!empty) return null;
    name = empty[1];
    firstBody = '';
    matchIndex = empty.index;
  } else {
    return null;
  }
  if (!/^[A-Z]/.test(name) || name.includes('#') || name.includes('.')) return null;

  const consumed: number[] = [];
  let commentEnd = comment.end;
  let body: string;

  if (comment.type === 'Block') {
    const dblIdx = comment.value.indexOf('::', matchIndex);
    if (dblIdx < 0) return null;
    const lines = comment.value.slice(dblIdx + 2).split('\n')
      .map(l => l.replace(/^\s*\*?\s?/, '').trim());
    const parts: string[] = [];
    // Running joining state (see delimDepthDelta): depth = delimiter balance
    // of the accumulated body, lastPart = last non-empty appended line.
    let depth = 0;
    let lastPart = '';
    for (const line of lines) {
      if (parts.length === 0) {
        if (line.length > 0) {
          parts.push(line);
          depth += delimDepthDelta(line, false);
          lastPart = line;
        }
        continue;
      }
      // Keep joining while the alternation is unfinished: either a trailing `|`
      // or an unbalanced `(`/`{` (a record / paren field spanning lines).
      const incomplete = isAlternationIncomplete(lastPart) || depth > 0;
      if (line.length === 0) {
        if (incomplete) continue;
        break;
      }
      if (incomplete || /^\|/.test(line)) {
        parts.push(line);
        depth += delimDepthDelta(line, false);
        lastPart = line;
      } else break;
    }
    body = parts.join(' ').replace(/\s+/g, ' ').trim();
  } else {
    // Incremental joining state, mirroring the block path above: appending a
    // line costs O(line) — testing the FULL accumulated body per line made
    // joining huge generated multi-line annotations quadratic.
    const parts: string[] = firstBody.length > 0 ? [firstBody.replace(/\s+/g, ' ')] : [];
    let depth = delimDepthDelta(firstBody, false);
    let lastPart = firstBody;
    for (let j = index + 1; j < comments.length; j++) {
      const next = comments[j];
      if (next.type !== 'Line') break;
      const gap = source.slice(commentEnd, next.start);
      if (!/^\s*$/.test(gap)) break;
      const nextText = next.value.trim();
      if (nextText.length === 0) break;

      // Keep joining while the declaration is unfinished — nothing captured yet
      // (empty first-line body), a trailing `|`, or an unbalanced `(`/`{` (a
      // record / paren field spanning lines) — OR the next line begins a new
      // alternation branch (`| Variant …`).  This covers the vertically laid
      // out form:
      //   // Component ::
      //   //   Engine { ext :: String }
      //   //   | Locals { obj :: Object String Any }
      const incomplete = parts.length === 0
        || isAlternationIncomplete(lastPart)
        || depth > 0;
      const nextIsAlternation = /^\|/.test(nextText);
      if (!incomplete && !nextIsAlternation) break;

      parts.push(nextText.replace(/\s+/g, ' '));
      depth += delimDepthDelta(nextText, false);
      lastPart = nextText;
      commentEnd = next.end;
      consumed.push(j);
    }
    body = parts.join(' ').trim();
  }

  if (!body || !isDataShorthand(name, body)) return null;
  const nameIdx = comment.value.indexOf(name, matchIndex);
  return { name, body, commentStart: comment.start, commentEnd, nameIdx, consumed };
}

/**
 * Extract all sum type declarations from a JavaScript source string.
 *
 * Recognises the `// TypeName :: Variant1 a | Variant2 b` syntax, including
 * multi-line forms (block comments whose variants span several lines, or
 * consecutive `//` line comments joined by a trailing/leading `|`).
 */
export function extractDataDirectives(source: string): DataTypeDecl[] {
  const parsed = parseWithComments(source);
  if (!parsed) return [];
  const { comments } = parsed;

  const results: DataTypeDecl[] = [];
  // Comment indices that are continuation lines of a multi-line `//`
  // annotation (e.g. the fields inside `Component#matchWith :: Component ~> {
  // … }`).  These must not be re-parsed here as standalone sumtype decls.
  const skip = computeContinuationSkips(comments, source);

  for (let ci = 0; ci < comments.length; ci++) {
    if (skip.has(ci)) continue;
    const ds = readDataShorthand(comments, ci, source);
    if (!ds) continue;
    const decl = parseDataShorthand(ds.name, ds.body, ds.commentStart, ds.commentEnd);
    if (decl) {
      if (ds.nameIdx >= 0) {
        decl.signatureNameStart = ds.commentStart + 2 + ds.nameIdx;
        decl.signatureNameEnd = decl.signatureNameStart + ds.name.length;
      }
      results.push(decl);
    }
    // Consumed continuation comments are the contiguous indices that follow.
    ci += ds.consumed.length;
  }

  return results;
}

// ---------------------------------------------------------------------------
// ::ignore-file / ::ignore directive extraction
// ---------------------------------------------------------------------------

/** Regex to match `// ::ignore-file` directive. */
const IGNORE_FILE_PATTERN = /^[\s*]*::ignore-file\s*$/m;

/** Regex to match `// ::ignore` directive. */
const IGNORE_LINE_PATTERN = /^[\s*]*::ignore\s*$/m;

/**
 * Check whether the source contains an `// ::ignore-file` directive.
 * When present, all diagnostics for the file should be suppressed.
 */
export function hasIgnoreFileDirective(source: string): boolean {
  const parsed = parseWithComments(source);
  if (!parsed) {
    // Fallback: regex on raw source
    return /\/\/\s*::ignore-file\s*$/m.test(source) ||
           /\/\*[\s*]*::ignore-file\s*\*\//m.test(source);
  }

  for (const comment of parsed.comments) {
    if (IGNORE_FILE_PATTERN.test(comment.value)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract 0-based line numbers that should be ignored due to `// ::ignore`
 * directives. The directive suppresses diagnostics on the **next** line.
 */
export function extractIgnoreLineDirectives(source: string): Set<number> {
  const ignoredLines = new Set<number>();
  const parsed = parseWithComments(source);
  if (!parsed) {
    // Fallback: regex on raw source
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/\/\/\s*::ignore\s*$/.test(lines[i]) ||
          /\/\*[\s*]*::ignore\s*\*\//.test(lines[i])) {
        ignoredLines.add(i + 1); // next line (0-based)
      }
    }
    return ignoredLines;
  }

  for (const comment of parsed.comments) {
    if (IGNORE_LINE_PATTERN.test(comment.value)) {
      // The directive is on the comment's line; ignore the NEXT line.
      const loc = comment.loc;
      if (loc) {
        // loc.end.line is 1-based; the next line in 0-based is loc.end.line
        ignoredLines.add(loc.end.line); // 0-based next line
      }
    }
  }

  return ignoredLines;
}

/** Regex to match `// ::ignore-function` directive. */
const IGNORE_FUNCTION_PATTERN = /^[\s*]*::ignore-function\s*$/m;

/**
 * Extract 0-based line numbers that should be ignored due to `// ::ignore-function`
 * directives. The directive suppresses diagnostics on the entire function body
 * following the comment.
 */
export function extractIgnoreFunctionDirectives(source: string): Set<number> {
  const ignoredLines = new Set<number>();
  const parsed = parseWithComments(source);
  if (!parsed) {
    // Can't parse AST — fall back to ignoring just the next line
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/\/\/\s*::ignore-function\s*$/.test(lines[i]) ||
          /\/\*[\s*]*::ignore-function\s*\*\//m.test(lines[i])) {
        ignoredLines.add(i + 1);
      }
    }
    return ignoredLines;
  }
  const { ast, comments } = parsed;

  // Collect directive comment positions (1-based line numbers)
  const directiveLines = new Set<number>();
  for (const comment of comments) {
    if (IGNORE_FUNCTION_PATTERN.test(comment.value)) {
      const loc = comment.loc;
      if (loc) {
        directiveLines.add(loc.end.line); // 1-based line of the comment
      }
    }
  }

  if (directiveLines.size === 0) return ignoredLines;

  // Walk the AST to find function declarations/expressions on the line(s)
  // after each directive comment
  const addIgnoredRange = (loc: estree.SourceLocation) => {
    for (const dirLine of directiveLines) {
      if (loc.start.line > dirLine && loc.start.line <= dirLine + 3) {
        for (let line = loc.start.line - 1; line < loc.end.line; line++) {
          ignoredLines.add(line); // 0-based
        }
      }
    }
  };

  walk.simple(ast, {
    FunctionDeclaration(node) { if (node.loc) addIgnoredRange(node.loc); },
    FunctionExpression(node) { if (node.loc) addIgnoredRange(node.loc); },
    ArrowFunctionExpression(node) { if (node.loc) addIgnoredRange(node.loc); },
    VariableDeclaration(node) { if (node.loc) addIgnoredRange(node.loc); },
  });
  return ignoredLines;
}

// ---------------------------------------------------------------------------
// AST traversal helpers
// ---------------------------------------------------------------------------

interface AttachedDecl {
  name?: string;
  nodeStart: number;
  /** Start offset of the name identifier (for precise mismatch diagnostics) */
  nameStart?: number;
  /** End offset of the name identifier */
  nameEnd?: number;
}

/**
 * Find a variable declaration that ends on the SAME LINE right before a
 * trailing annotation comment and that binds exactly `annotationName`
 * (identifier or destructuring pattern).  Used so that
 * `const [filter, setFilter] = useState('x'); // filter :: String`
 * attaches backward to its own statement instead of leaking forward.
 * Returns null when the comment is not trailing (only whitespace before it
 * on its line) or no same-line declaration binds the name.
 */
function findSameLineDeclaration(
  ast: estree.Program,
  commentStart: number,
  source: string,
  annotationName: string,
): AttachedDecl | null {
  const lineStart = source.lastIndexOf('\n', commentStart - 1) + 1;
  if (/^\s*$/.test(source.slice(lineStart, commentStart))) return null;
  let found: AttachedDecl | null = null;
  walk.simple(ast, {
    VariableDeclaration(node: estree.VariableDeclaration) {
      if (found) return;
      if (node.end > commentStart) return;
      if (source.slice(node.end, commentStart).includes('\n')) return;
      for (const decl of node.declarations) {
        if (decl.id?.type === 'Identifier' && decl.id.name === annotationName) {
          found = { name: annotationName, nodeStart: node.start, nameStart: decl.id.start, nameEnd: decl.id.end };
          return;
        }
        const b = collectPatternBindings(decl.id as estree.Pattern)
          .find(p => p.name === annotationName);
        if (b) {
          found = { name: annotationName, nodeStart: node.start, nameStart: b.start, nameEnd: b.end };
          return;
        }
      }
    },
  });
  return found;
}

/**
 * Find the nearest declaration node that starts after `afterOffset`.
 * Searches the top-level body of the program and inside class bodies.
 */
function findNextDeclaration(
  ast: estree.Program,
  afterOffset: number,
  source: string,
  annotationName?: string,
): AttachedDecl | null {
  for (const node of ast.body) {
    // Comment might be inside this node — check class bodies
    if (node.start < afterOffset) {
      if ((node.type === 'ClassDeclaration' || (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration') || (node.type === 'ExportDefaultDeclaration' && node.declaration?.type === 'ClassDeclaration'))
          && node.end > afterOffset) {
        const classNode = (node.type === 'ClassDeclaration' ? node : node.declaration) as estree.ClassDeclaration;
        const className = classNode?.id?.name;
        if (className && classNode?.body?.body) {
          // If the comment is inside a member's body (e.g. a property
          // annotation inside the constructor), search for inline
          // declarations (this.prop = ...) inside that member first.
          for (const member of classNode.body.body) {
            if (member.start <= afterOffset && member.end > afterOffset) {
              const inline = findNextFunctionExpressionNode(
                member as unknown as AstNode, afterOffset, source,
              );
              if (inline) {
                return inline;
              }
              break;
            }
          }

          for (const member of classNode.body.body) {
            if (member.start < afterOffset) continue;
            const gap = member.start - afterOffset;
            if (gap > 200) break;
            if (member.type === 'MethodDefinition' && member.key?.type === 'Identifier') {
              const methodName = member.key.name;
              if (methodName !== 'constructor') {
                return {
                  name: `${className}#${methodName}`,
                  nodeStart: member.value?.start ?? /* istanbul ignore next */ member.start,
                  nameStart: member.key.start,
                  nameEnd: member.key.end,
                };
              }
            }
          }
        }
      }

      // Inline annotation inside an expression/call argument list.
      // Example:
      //   ex(
      //     // :: Number -> String
      //     x => x + "!"
      //   )
      const inline = findNextFunctionExpressionNode(node, afterOffset, source);
      if (inline) {
        return inline;
      }
      continue;
    }

    // Skip nodes that are too far away (allow some whitespace but not other statements)
    const gap = node.start - afterOffset;
    if (gap > 200) break; // heuristic: annotation should be close to declaration

    const result = extractDeclName(node, annotationName);
    if (result) {
      return { name: result.name, nodeStart: result.nodeStart ?? node.start, nameStart: result.nameStart, nameEnd: result.nameEnd };
    }
  }

  return null;
}

/**
 * Find the nearest function expression/arrow function that starts after
 * `afterOffset` inside a given subtree.
 */
function findNextFunctionExpressionNode(
  root: AstNode,
  afterOffset: number,
  source: string,
): AttachedDecl | null {
  let bestStart: number | null = null;
  let bestName: string | undefined;
  // When the best match is a variable declaration (`const map = fn => ...`),
  // store the declaration start separately for the gap check — the nodeStart
  // should still point to the function expression init.
  let bestDeclStart: number | null = null;
  let bestNameStart: number | undefined;
  let bestNameEnd: number | undefined;

  const checkNode = (node: estree.Node) => {
    if (node.start >= afterOffset && (bestStart === null || node.start < bestStart)) {
      bestStart = node.start;
      bestName = undefined;
      bestDeclStart = null;
    }
  };

  // Also look for variable declarations inside function bodies.  This allows
  // annotations like
  //   // Either2#map :: Either2 e a ~> (a -> b) -> Either2 e b
  //   const map = fn => ...
  // to be properly attached with the binding name.  The init may be ANY
  // expression — not just a function — so nested value bindings like
  //   // test :: Applicative m => m z
  //   const test = reduce (reducer) (seed) (xs);
  // attach here too (mirroring top-level `extractDeclName` semantics)
  // instead of leaking through to the next top-level statement.
  const checkVarDecl = (node: estree.VariableDeclaration) => {
    if (node.start < afterOffset) return;
    for (const decl of node.declarations) {
      if (decl.init && decl.id?.type === 'Identifier') {
        if (bestStart === null || decl.init.start <= bestStart) {
          bestStart = decl.init.start;
          bestName = decl.id.name;
          bestDeclStart = node.start;
          bestNameStart = decl.id.start;
          bestNameEnd = decl.id.end;
        }
      }
    }
  };

  // Also look for nested function declarations:
  //   // Either2#map :: Either2 e a ~> (a -> b) -> Either2 e b
  //   function map(fn) { ... }
  const checkFuncDecl = (node: estree.FunctionDeclaration | estree.AnonymousFunctionDeclaration) => {
    if (node.start < afterOffset) return;
    if (!node.id?.name) return;
    if (bestStart === null || node.start <= bestStart) {
      bestStart = node.start;
      bestName = node.id.name;
      bestDeclStart = null;
      bestNameStart = node.id.start;
      bestNameEnd = node.id.end;
    }
  };

  // Also look for `this.<prop> = <expr>` assignments inside constructor bodies.
  // This allows annotations like:
  //   // RTask#fork :: RTask r e a ~> (e -> (), a -> (), r) -> ()
  //   this.fork = fork;
  // to be properly attached with the property name.
  const checkThisAssignment = (node: estree.ExpressionStatement) => {
    if (node.start < afterOffset) return;
    const expr = node.expression;
    if (expr?.type !== 'AssignmentExpression') return;
    const left = expr.left;
    if (left?.type !== 'MemberExpression' || left.computed) return;
    if (left.object?.type !== 'ThisExpression') return;
    if (left.property?.type !== 'Identifier') return;
    const propName = left.property.name;
    if (bestStart === null || node.start <= bestStart) {
      bestStart = node.start;
      bestName = propName;
      bestDeclStart = null;
      bestNameStart = left.property.start;
      bestNameEnd = left.property.end;
    }
  };

  // Look for object literal property/method shorthand:
  //   // Box#map :: Box a ~> (a -> b) -> Box b
  //   map(fn) { return Box(fn(this.value)); },
  // or shorthand property:
  //   // Box#value :: Box a ~> a
  //   value,
  const checkProperty = (node: estree.Property | estree.AssignmentProperty) => {
    if (node.type !== 'Property') return;
    if (node.start < afterOffset) return;
    if (node.key?.type !== 'Identifier') return;
    const propName = (node.key as estree.Identifier).name;
    const valueStart = node.method ? node.value.start : node.start;
    if (bestStart === null || valueStart <= bestStart) {
      bestStart = valueStart;
      bestName = propName;
      bestDeclStart = node.start;
      bestNameStart = node.key.start;
      bestNameEnd = node.key.end;
    }
  };

  walk.simple(root, {
    ArrowFunctionExpression: checkNode,
    FunctionExpression: checkNode,
    VariableDeclaration: checkVarDecl,
    FunctionDeclaration: checkFuncDecl,
    ExpressionStatement: checkThisAssignment,
    Property: checkProperty,
  });

  if (bestStart === null) return null;

  // For variable declarations, check gap to the `const`/`let`/`var` keyword,
  // not to the function expression init (which would include `const name = `).
  const gapTarget = bestDeclStart ?? bestStart;
  const gap = source.slice(afterOffset, gapTarget);
  if (!/^\s*$/.test(gap)) {
    return null;
  }

  // Keep the same proximity heuristic used for declarations.
  if ((gapTarget - afterOffset) > 200) {
    return null;
  }

  return { nodeStart: bestStart, name: bestName, nameStart: bestNameStart, nameEnd: bestNameEnd };
}

/**
 * Walk an `ObjectPattern` / `ArrayPattern` (and the rest patterns nested
 * inside them) and return every locally-bound identifier with its source
 * range.  Used by `extractDeclName` so an annotation above
 * `const { x } = ...` attaches to `x` instead of being pushed forward to
 * the next declaration in the file.
 */
function collectPatternBindings(
  pat: estree.Pattern,
): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = [];
  const walk = (p: estree.Pattern | null | undefined): void => {
    if (!p) return;
    switch (p.type) {
      case 'Identifier':
        out.push({ name: p.name, start: p.start, end: p.end });
        return;
      case 'ObjectPattern':
        for (const prop of p.properties) {
          if (prop.type === 'Property') {
            walk(prop.value as estree.Pattern);
          } else if (prop.type === 'RestElement') {
            walk(prop.argument as estree.Pattern);
          }
        }
        return;
      case 'ArrayPattern':
        for (const el of p.elements) walk(el as estree.Pattern | null);
        return;
      case 'AssignmentPattern':
        walk(p.left as estree.Pattern);
        return;
      case 'RestElement':
        walk(p.argument as estree.Pattern);
        return;
      default:
        return;
    }
  };
  walk(pat);
  return out;
}

/**
 * Extract the declared name from a statement node.
 * Returns the name and optionally a custom nodeStart offset.
 */
function extractDeclName(node: AstNode, annotationName?: string): { name: string; nodeStart?: number; nameStart?: number; nameEnd?: number } | null {
  switch (node.type) {
    case 'FunctionDeclaration':
      /* istanbul ignore next — anonymous FunctionDeclaration is a syntax error */
      return node.id?.name ? { name: node.id.name, nameStart: node.id.start, nameEnd: node.id.end } : null;

    case 'VariableDeclaration': {
      // Take the first declarator's name
      if (node.declarations.length === 0) return null;
      const id0 = node.declarations[0].id as estree.Pattern | estree.Identifier;
      if ((id0 as estree.Identifier)?.type === 'Identifier' && (id0 as estree.Identifier).name) {
        const id = id0 as estree.Identifier;
        return { name: id.name, nameStart: id.start, nameEnd: id.end };
      }
      // Destructuring patterns: `const { x } = ...` / `const [x] = ...`.
      // Walk the bindings and prefer the one matching the annotation name
      // so a destructuring assignment doesn't push the annotation through
      // to a later, unrelated declaration.
      const bindings = collectPatternBindings(id0 as estree.Pattern);
      if (bindings.length === 0) return null;
      const matched = annotationName
        ? bindings.find(b => b.name === annotationName)
        : undefined;
      const chosen = matched ?? bindings[0];
      return { name: chosen.name, nameStart: chosen.start, nameEnd: chosen.end };
    }

    case 'ExportNamedDeclaration':
      if (node.declaration) {
        const inner = extractDeclName(node.declaration, annotationName);
        // Use the inner declaration's start so the nodeStart aligns with
        // the range check in inferNamedBinding (which uses the
        // VariableDeclaration's start, not the outer export's start).
        if (inner && inner.nodeStart === undefined) {
          inner.nodeStart = node.declaration.start;
        }
        return inner;
      }
      return null;

    case 'ExportDefaultDeclaration':
      if (node.declaration) {
        const inner = extractDeclName(node.declaration, annotationName);
        if (inner && inner.nodeStart === undefined) {
          inner.nodeStart = node.declaration.start;
        }
        return inner;
      }
      return null;

    case 'ClassDeclaration':
      /* istanbul ignore next — anonymous ClassDeclaration is a syntax error */
      return node.id?.name ? { name: node.id.name, nameStart: node.id.start, nameEnd: node.id.end } : null;

    case 'ExpressionStatement': {
      // Handle: Box.fromPair = pair => ...
      const expr = node.expression;
      if (expr?.type === 'AssignmentExpression' && expr.left?.type === 'MemberExpression') {
        const obj = expr.left.object;
        const prop = expr.left.property;
        if (obj?.type === 'Identifier' && prop?.type === 'Identifier') {
          return { name: `${obj.name}.${prop.name}`, nameStart: prop.start, nameEnd: prop.end };
        }
        // Handle: Right.prototype.map = function() {...} → Right#map
        // nodeStart points to the RHS expression so hover on Right/prototype
        // does not pick up the method annotation.
        const proto = extractPrototypeMethod(expr.left);
        if (proto) {
          const methodKey = expr.left.property;
          return {
            name: `${proto.typeName}#${proto.methodName}`,
            nodeStart: expr.right?.start,
            nameStart: methodKey?.type === 'Identifier' ? methodKey.start : undefined,
            nameEnd: methodKey?.type === 'Identifier' ? methodKey.end : undefined,
          };
        }
      }
      return null;
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Import name extraction
// ---------------------------------------------------------------------------

/**
 * Extract uppercase-initial names from ES module import / require declarations
 * in JS source.  Used to recognise locally-imported type constructors so the
 * type validator doesn't flag them as unknown.
 */
export function extractImportedNames(source: string): string[] {
  const names: string[] = [];
  const importRegex =
    /import\s+(\w+)\s+from\s+['"]|import\s+\{([^}]+)\}\s+from\s+['"]|const\s+\{([^}]+)\}\s*=\s*require\s*\(/g;
  let match;
  while ((match = importRegex.exec(source)) !== null) {
    if (match[1] && /^[A-Z]/.test(match[1])) {
      names.push(match[1]);
    }
    const namedImports = match[2] || match[3];
    if (namedImports) {
      for (const part of namedImports.split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name && /^[A-Z]/.test(name)) {
          names.push(name);
        }
      }
    }
  }
  return names;
}

/**
 * Extract unique module specifier paths from import/require declarations.
 * Returns paths like `'./Either2'`, `'./demo'`, etc.
 */
export function extractImportModuleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const importRegex =
    /import\s+(?:\w+|\{[^}]+\}|\*\s+as\s+\w+)\s+from\s+['"]([^'"]+)['"]|(?:const|let|var)\s+(?:\w+|\{[^}]+\})\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = importRegex.exec(source)) !== null) {
    const specifier = match[1] || match[2];
    if (specifier) specifiers.add(specifier);
  }
  return [...specifiers];
}
