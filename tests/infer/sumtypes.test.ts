// Sumtype suite — consolidated regressions for sum-type declarations,
// narrowing, and display:
//
//   * Declaration syntax: the legacy `::data Foo = A | B` directive is dead —
//     only the shorthand `// Foo :: A | B` registers a sumtype; inline
//     `is Variant` predicates are rejected (use `::narrow`).
//   * Complex variant fields: parenthesized applications, record variants,
//     and `::types`-resolved field types (the fpkit `Response` type).
//   * Narrow display: hover stays annotation-faithful (`Either a b`, not
//     `Either a a`) after narrowing through a `::narrow` accessor.
//   * Record field auto-registration (Q2) and bare-arity fields (Q1) in the
//     `|` shorthand, plus multiline `//` declaration parsing edge cases.
//   * `sample/Param.js` behaviours: missing-signature suppression on sumtype
//     carriers, wildcard-return suppression for factories, chained
//     annotations `// A :: B :: T`, hoisting, and member-assignment extension.

import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { scrubSkolems } from '../../src/hm/typeUtils';
import { InferenceEngine } from '../../src/infer';
import { prettyTypeToString } from '../../src/hm/types';
import type { Type } from '../../src/hm/types';
import {
  extractDataDirectives,
  buildAnnotationMap,
  extractAnnotations,
} from '../../src/commentParser';
import { parseTypeSignature } from '../../src/hm/typeParser';
import { isDataType } from '../../src/registries/dataTypeRegistry';
import { detectMissingSignatures } from '../../src/services/diagnostics';
import { freshEngine, inferSource, diags } from '../helpers/infer';

function hoverType(
  r: ReturnType<InferenceEngine['infer']>,
  source: string,
  offset: number,
): string | null {
  let bestStart = -1;
  let bestType: Type | null = null;
  for (const [s, { type, end }] of r.nodeTypes) {
    if (s <= offset && offset < end && s > bestStart) {
      bestStart = s;
      bestType = r.substitution.apply(type);
    }
  }
  if (!bestType) return null;
  // Mirror server.ts hover: rigid skolems render with their annotation letters.
  return prettyTypeToString(r.skolemDisplayNames ? scrubSkolems(bestType, r.skolemDisplayNames) : bestType);
}

// ---------------------------------------------------------------------------
// From sumtypeAndNarrow.test.ts — two design decisions pinned down:
//   1. `::data Foo = A | B` is dead syntax — only `// Foo :: A | B` registers
//      a sumtype.
//   2. Narrowing happens *only* through `::narrow` — no inline
//      `Boolean is Variant` after `~>` and no `(a is Type)` predicate.
// ---------------------------------------------------------------------------

describe('Sumtype declarations: ::data is rejected', () => {
  test('extractDataDirectives ignores `// ::data Foo = A | B`', () => {
    const decls = extractDataDirectives('// ::data Maybe a = Just a | Nothing\n');
    expect(decls).toHaveLength(0);
  });

  test('engine.infer does NOT register variants for `// ::data Foo = A | B`', () => {
    const r = inferSource(`
      // ::data Maybe a = Just a | Nothing
      const x = 5;
    `);
    // Variant set must be empty — the ::data directive is no longer parsed.
    expect(r.dataVariantNames.has('Just')).toBe(false);
    expect(r.dataVariantNames.has('Nothing')).toBe(false);
  });

  test('shorthand `// Maybe :: Just a | Nothing` IS recognised', () => {
    const decls = extractDataDirectives('// Maybe :: Just a | Nothing\n');
    expect(decls).toHaveLength(1);
    expect(decls[0].name).toBe('Maybe');
    expect(decls[0].typeVars).toEqual(['a']);
    expect(decls[0].variants.map(v => v.name)).toEqual(['Just', 'Nothing']);
  });

  test('shorthand auto-infers type vars in declaration order', () => {
    const decls = extractDataDirectives('// Either :: Left e | Right a\n');
    expect(decls).toHaveLength(1);
    expect(decls[0].typeVars).toEqual(['e', 'a']);
  });

  test('engine registers variants from shorthand syntax', () => {
    const r = inferSource(`
      // Either :: Left e | Right a
      // Left  :: e -> Either e a
      // Right :: a -> Either e a
      const Left  = (e) => ({ tag: "Left", e });
      const Right = (v) => ({ tag: "Right", v });
    `);
    expect(r.dataVariantNames.has('Left')).toBe(true);
    expect(r.dataVariantNames.has('Right')).toBe(true);
  });
});

describe('Inline predicate syntax is rejected (use ::narrow)', () => {
  test('parenthesised `(a is Type)` throws a helpful TypeParseError', () => {
    expect(() => parseTypeSignature('(a is String) -> Boolean')).toThrow(
      /Use ::narrow instead/i,
    );
  });

  test('`Boolean is Left` after `~>` is NOT silently accepted as a predicate', () => {
    // The signature must either parse as a plain Boolean return (with `is`
    // and `Left` ignored or causing a parse error) — but it MUST NOT
    // produce a typePredicate field on the resulting scheme.
    let scheme: ReturnType<typeof parseTypeSignature> | null = null;
    try {
      scheme = parseTypeSignature('Either e a ~> Boolean is Left');
    } catch {
      // Throwing is also acceptable behaviour — the key point is no
      // predicate sneaks through.
      scheme = null;
    }
    if (scheme) {
      expect(scheme.typePredicate).toBeUndefined();
    }
  });

  test('typePredicate is only set for annotations marked with ::narrow', () => {
    const r = inferSource(`
      // Maybe :: Just a | Nothing
      // ::narrow Just
      // isJust :: a -> Boolean
      const isJust = (m) => m.tag === "Just";

      // sameSig :: a -> Boolean
      const sameSig = (m) => m.tag === "Just";
    `);
    const isJustAnn = r.annotations.get('isJust');
    const sameSigAnn = r.annotations.get('sameSig');
    expect(isJustAnn?.scheme?.typePredicate).toBeDefined();
    expect(isJustAnn?.scheme?.typePredicate?.paramName).toBe('a');
    expect(sameSigAnn?.scheme?.typePredicate).toBeUndefined();
  });

  test('::narrow on a method annotation sets narrowVariant, plain method does not', () => {
    const r = inferSource(`
      // Maybe :: Just a | Nothing
      // ::narrow Just
      // Maybe#isJust :: Maybe a ~> Boolean
      // Maybe#plain  :: Maybe a ~> Boolean
      class Just { constructor(v) { this.v = v; } }
      class Nothing {}
    `);
    const narrowed = r.annotations.get('Maybe#isJust');
    const plain    = r.annotations.get('Maybe#plain');
    expect(narrowed?.narrowVariant).toBe('Just');
    expect(plain?.narrowVariant).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// From sumtypeComplexFields.test.ts — shorthand declarations with complex
// variant fields: parenthesized type applications (`(Object String a)`) and
// record variants (`{ status :: Number, url :: String }`), modelling the fpkit
// `Response` type in both Haskell-style shapes.  Constructors stay explicit.
// ---------------------------------------------------------------------------

// Positional form:  Redirect Number String | Render String (Object String a) | ...
const POSITIONAL = `// Body :: String
/* Response ::
     Redirect Number String
   | Render String (Object String a)
   | Send Number (Object String a) Body */
function Response() {}
// Redirect :: (Number, String) -> Response a
function Redirect(status, url) { this.status = status; this.url = url; }
// Render :: (String, Object String a) -> Response a
function Render(view, options) { this.view = view; this.options = options; }
// Send :: (Number, Object String a, Body) -> Response a
function Send(status, headers, body) {
  this.status = status; this.headers = headers; this.body = body;
}
// ::narrow Redirect
// Response#isRedirect :: Response a ~> Boolean
Redirect.prototype.isRedirect = true;
Render.prototype.isRedirect = false;
Send.prototype.isRedirect = false;
`;

// Record form:  Redirect { status :: Number, url :: String } | ...
const RECORD = `// Body :: String
/* Response ::
     Redirect { status :: Number, url :: String }
   | Render { view :: String, options :: Object String a }
   | Send { status :: Number, headers :: Object String a, body :: Body } */
function Response() {}
// Redirect :: (Number, String) -> Response a
function Redirect(status, url) { this.status = status; this.url = url; }
// Render :: (String, Object String a) -> Response a
function Render(view, options) { this.view = view; this.options = options; }
// Send :: (Number, Object String a, Body) -> Response a
function Send(status, headers, body) {
  this.status = status; this.headers = headers; this.body = body;
}
// ::narrow Redirect
// Response#isRedirect :: Response a ~> Boolean
Redirect.prototype.isRedirect = true;
Render.prototype.isRedirect = false;
Send.prototype.isRedirect = false;
`;

describe('Response sum type — positional form with paren fields', () => {
  test('registers the sum type and all three variants', () => {
    const r = inferSource(POSITIONAL);
    expect(isDataType('Response')).toBe(true);
    expect(r.dataVariantNames.has('Redirect')).toBe(true);
    expect(r.dataVariantNames.has('Render')).toBe(true);
    expect(r.dataVariantNames.has('Send')).toBe(true);
  });

  test('produces no diagnostics', () => {
    const r = inferSource(POSITIONAL);
    expect(r.diagnostics).toEqual([]);
  });

  test('Response identifier hovers as the variant union', () => {
    const r = inferSource(POSITIONAL);
    const offset = POSITIONAL.indexOf('function Response') + 'function '.length;
    const hover = hoverType(r, POSITIONAL, offset);
    expect(hover).toContain('Redirect');
    expect(hover).toContain('Render');
    expect(hover).toContain('Send');
    // Option B: the parametric type var `a` surfaces on the variants that use it.
    expect(hover).toContain('a');
  });
});

describe('Response sum type — record form', () => {
  test('registers the sum type and all three variants', () => {
    const r = inferSource(RECORD);
    expect(isDataType('Response')).toBe(true);
    expect(r.dataVariantNames.has('Redirect')).toBe(true);
    expect(r.dataVariantNames.has('Render')).toBe(true);
    expect(r.dataVariantNames.has('Send')).toBe(true);
  });

  test('produces no diagnostics', () => {
    const r = inferSource(RECORD);
    expect(r.diagnostics).toEqual([]);
  });

  test('record labels are not treated as type variables', () => {
    const r = inferSource(RECORD);
    const offset = RECORD.indexOf('function Response') + 'function '.length;
    const hover = hoverType(r, RECORD, offset);
    // `status`, `url`, `view`, `options`, `headers`, `body` are field labels,
    // never type vars — they must not appear in the hovered union type.
    for (const label of ['status', 'url', 'view', 'options', 'headers', 'body']) {
      expect(hover).not.toContain(label);
    }
  });
});

describe('variant field types resolved via `::types` are not "unknown"', () => {
  // Regression: variant-field validation used to run BEFORE `::types`
  // directives were resolved, so a field type imported via `// ::types ./Body`
  // was wrongly reported as unknown.  Validation now runs late (after imports).
  const CONSUMER = `// ::types ./Body
/* Response ::
     Redirect Number String
   | Send Number String Body */
function Response() {}
// Redirect :: (Number, String) -> Response
function Redirect(status, url) { this.status = status; this.url = url; }
// Send :: (Number, String, Body) -> Response
function Send(status, headers, body) {
  this.status = status; this.headers = headers; this.body = body;
}
`;

  const resolver = (specifier: string): string | null =>
    specifier === './Body' ? '// Body :: BodyText String | BodyEmpty\n' : null;

  test('no "Unknown type \'Body\'" diagnostic when Body comes from ::types', () => {
    const r = freshEngine().infer(CONSUMER, undefined, undefined, resolver);
    const bodyDiag = r.diagnostics.find(d => /Unknown type 'Body'/.test(d.message));
    expect(bodyDiag).toBeUndefined();
  });

  test('unresolved variant field type still reports "Unknown type"', () => {
    // No resolver → Body cannot be found → the diagnostic should still fire.
    const r = freshEngine().infer(CONSUMER, undefined, undefined, () => null);
    const bodyDiag = r.diagnostics.find(d => /Unknown type 'Body'/.test(d.message));
    expect(bodyDiag).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// From sumtypeNarrowDisplay.test.ts — after narrowing a sumtype parameter
// through a `::narrow` accessor (`e.isLeft`), hover must stay faithful to the
// annotation: `Either a b` used to render as `Either a a` because the phantom
// slot was wildcarded *and renamed*; `variantThisScheme` must preserve the
// phantom's own display name.
// ---------------------------------------------------------------------------

describe('sumtype narrowing keeps annotation-faithful display', () => {
  const SRC = `// Either :: Left e | Right a
// Either#value :: Either e a ~> (e | a)
// Left :: e -> Either e a
function Left(value) { this.value = value; this.tag = "Left"; }
// Right :: a -> Either e a
function Right(value) { this.value = value; this.tag = "Right"; }
// ::narrow Left
// Either#isLeft :: Either e a ~> Boolean
Left.prototype.isLeft = true;
Right.prototype.isLeft = false;

// probe :: Either a b -> Number
const probe = e => {
  if (e.isLeft) {
    var x = e.value;
    return 1;
  }
  return 2;
};
`;

  test('narrowed `e` hovers as `Either a b`, not `Either a a`', () => {
    const r = inferSource(SRC);
    expect(r.diagnostics).toEqual([]);

    // `e` inside `var x = e.value;` (the Left-narrowed true branch).
    const eOffset = SRC.indexOf('= e.value') + '= '.length;
    expect(hoverType(r, SRC, eOffset)).toBe('Either a b');
  });

  test('value accessor method signature shows `Either a b ~> a`', () => {
    const r = inferSource(SRC);
    const valueOffset = SRC.indexOf('= e.value') + '= e.'.length;
    expect(r.methodSignatures.get(valueOffset)).toBe(
      'Either#value :: Either a b ~> a',
    );
  });
});

// ---------------------------------------------------------------------------
// From sumtypeRecordFieldAccessAndArity.test.ts — two aligned behaviours:
//   Q2: a record-style variant's declared fields may be read off `this` in a
//       `Shape ~>` method even without constructor assignment or a
//       `Shape#field` annotation.
//   Q1: a bare arity-bearing type used as a field in the `|` shorthand is
//       flagged (parenthesize instead, e.g. `(Box a)`).
// Plus: multiline `//` record annotations / vertical sumtype declarations
// must not be mis-parsed as variant separators.
// ---------------------------------------------------------------------------

describe('record-style sumtype field access (Q2)', () => {
  const source = [
    '/* Shape :: Circle { radius :: Number } | Square { side :: Number } */',
    '// Circle :: Number -> Shape',
    'function Circle(r) {}',
    '// Square :: Number -> Shape',
    'function Square(s) {}',
    'function Shape() {}',
    'Circle.prototype = Object.create (Shape.prototype);',
    'Square.prototype = Object.create (Shape.prototype);',
    '// Shape#area :: Shape ~> () -> Number',
    'Circle.prototype.area = function () { return this.radius; };',
    'Square.prototype.area = function () { return this.side; };',
  ].join('\n');

  it('accepts reading a declared record field off `this` without an annotation', () => {
    const msgs = diags(source);
    expect(msgs.filter(m => /does not exist on type/.test(m))).toEqual([]);
  });

  it('still rejects reading an UNDECLARED field off `this`', () => {
    const bad = source.replace('return this.side;', 'return this.bogus;');
    const msgs = diags(bad);
    expect(msgs.some(m => /Property 'bogus' does not exist on type Shape/.test(m))).toBe(true);
  });
});

describe('bare arity-bearing field in the `|` shorthand (Q1)', () => {
  it('flags a bare local sumtype that carries type parameters', () => {
    const src = [
      '/* Box :: Wrap a | Empty */',
      '/* Bad :: Only Box | None */',
    ].join('\n');
    const msgs = diags(src);
    expect(msgs.some(m => /Type 'Box' requires 1 type argument/.test(m))).toBe(true);
  });

  it('accepts the same field once parenthesized with its argument', () => {
    const src = [
      '/* Box :: Wrap a | Empty */',
      '/* Bad :: Only (Box a) | None */',
    ].join('\n');
    const msgs = diags(src);
    expect(msgs.some(m => /Type 'Box' requires/.test(m))).toBe(false);
  });
});

describe('multiline `//` record annotation is not mis-parsed as a sumtype decl', () => {
  // A `Component#matchWith` annotation written as consecutive `//` lines
  // contains inner lines like `Route :: String -> String | RegExp -> ...`.
  // The `|` there is a union type, NOT a variant separator — the data
  // directive scanner must recognise these as continuation lines of the
  // matchWith annotation and leave them alone.
  const source = [
    '/* Component :: | Engine { ext :: String } | Route { path :: String } */',
    '// Engine :: String -> Component',
    'function Engine(ext) {}',
    '// Route :: String -> Component',
    'function Route(path) {}',
    'function Component() {}',
    '// Component#matchWith :: Component ~> {',
    '//  Engine :: String -> a,',
    '//  Route :: String -> String | RegExp -> RouteFn -> a',
    '// } -> a',
    'Engine.prototype.matchWith = function (pattern) { return pattern.Engine (this.ext); };',
    'Route.prototype.matchWith = function (pattern) { return pattern.Route (this.path); };',
  ].join('\n');

  it('emits no bogus "Variant \'String\' is missing a constructor annotation"', () => {
    const msgs = diags(source);
    expect(msgs.some(m => /Variant 'String'/.test(m))).toBe(false);
    expect(msgs.some(m => /Variant 'RegExp'/.test(m))).toBe(false);
  });
});

describe('multiline `//` sumtype declaration with empty first line + leading `|`', () => {
  // The declaration is laid out vertically: the `::` line is empty and each
  // variant sits on its own `//` line, continuation lines beginning with `|`.
  // Internal `String | RegExp` unions live inside record braces and must not
  // be split as variant separators.
  const source = [
    '// Component ::',
    '//  Engine { ext :: String, handler :: EngineFn }',
    '//  | Locals { obj :: Object String Any }',
    '//  | Plugin { path :: String, handler :: PluginFn }',
    '//  | Route { method :: String, path :: String | RegExp, handler :: RouteFn }',
    '//  | Setting { name :: String, value :: Any }',
    '// EngineFn :: String -> ()',
    '// PluginFn :: String -> ()',
    '// RouteFn :: String -> ()',
    '// Engine :: (String, EngineFn) -> Component',
    'function Engine(ext, handler) {}',
    'function Component() {}',
  ].join('\n');

  it('does not report "Unexpected token EOF" for the empty-body first line', () => {
    const msgs = diags(source);
    expect(msgs.some(m => /Invalid type annotation for 'Component'/.test(m))).toBe(false);
    expect(msgs.some(m => /Unexpected token EOF/.test(m))).toBe(false);
  });

  it('registers the sumtype so its record fields are accepted on `this`', () => {
    const withMethod = source + [
      '',
      '// Component#tag :: Component ~> () -> String',
      'Engine.prototype.tag = function () { return this.ext; };',
    ].join('\n');
    const msgs = diags(withMethod);
    expect(msgs.some(m => /does not exist on type/.test(m))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// From paramSumtype.test.ts — the `sample/Param.js` improvements:
//   Phase 1: missing-signature suppression on sumtype carriers.
//   Phase 2: wildcard-return suppression for sumtype factories.
//   Phase 3: chained annotation `// A :: B :: T`.
//   Phase 4: end-to-end check on the on-disk fixture.
//   Phase 5: annotated-binding hoisting + member-assignment field extension.
// ---------------------------------------------------------------------------

describe('Phase 1: sumtype carrier missing-signature suppression', () => {
  test('function declaration with sumtype name → no missing-sig diagnostic', () => {
    const src = `
// Param :: Path | Query
function Param() {}
`;
    // Inference must register the data type before diagnostics run.
    inferSource(src);
    const annMap = buildAnnotationMap(src);
    const doc = TextDocument.create('file:///t.js', 'javascript', 1, src);
    const result = detectMissingSignatures(
      src, doc, annMap,
      DiagnosticSeverity.Information,
      DiagnosticSeverity.Information,
    );
    const missing = result.filter(d => d.message.includes('has no HM annotation'));
    expect(missing).toEqual([]);
  });

  test('const = function() {} with sumtype name → no missing-sig diagnostic', () => {
    const src = `
// Param :: Path | Query
const Param = function () {};
`;
    inferSource(src);
    const annMap = buildAnnotationMap(src);
    const doc = TextDocument.create('file:///t.js', 'javascript', 1, src);
    const result = detectMissingSignatures(
      src, doc, annMap,
      DiagnosticSeverity.Information,
      DiagnosticSeverity.Information,
    );
    const missing = result.filter(d => d.message.includes('has no HM annotation'));
    expect(missing).toEqual([]);
  });

  test('non-sumtype function still emits missing-sig diagnostic', () => {
    const src = `function plain() {}`;
    const annMap = buildAnnotationMap(src);
    const doc = TextDocument.create('file:///t.js', 'javascript', 1, src);
    const result = detectMissingSignatures(
      src, doc, annMap,
      DiagnosticSeverity.Information,
      DiagnosticSeverity.Information,
    );
    expect(result.some(d => d.message === "Function 'plain' has no HM annotation")).toBe(true);
  });
});

describe('Phase 2: wildcard-return suppression for sumtype factories', () => {
  test('factory returning Object.create(proto) with sumtype-parent return → no "generic value" diagnostic', () => {
    const src = `
// Param :: Path | Query
const Param = function () {};

const Path$prototype = { constructor: Param };

// Path :: (String, [a], b) -> Param
const Path = (key, rules = [], defaultValue) => {
  const x = Object.create(Path$prototype);
  x.key = key;
  x.rules = rules;
  x.defaultValue = defaultValue;
  return x;
};
`;
    const r = inferSource(src);
    const generic = r.diagnostics.filter(d => d.message.includes('returns a generic value'));
    expect(generic).toEqual([]);
  });

  test('non-sumtype factory still emits generic-value diagnostic when returning a wildcard', () => {
    // Annotation says String, but body returns the wildcard `b` value directly.
    const src = `
// f :: a -> String
const f = (x) => x;
`;
    const r = inferSource(src);
    // The rigid check reports it (the body returns the parameter, `a`).
    const mismatch = r.diagnostics.filter(d =>
      d.message.includes('returns a generic value') || d.message.includes("'f' has type 'a -> a'"));
    expect(mismatch.length).toBeGreaterThan(0);
  });
});

describe('Phase 3: chained annotation', () => {
  test('// Path :: Param.Path :: T registers both names with same scheme', () => {
    const src = `
// Path :: Param.Path :: (String, [a], b) -> Param
const Path = (key, rules = [], defaultValue) => ({ key, rules, defaultValue });
`;
    const map = buildAnnotationMap(src);
    expect(map.has('Path')).toBe(true);
    expect(map.has('Param.Path')).toBe(true);
    const a = map.get('Path')!;
    const b = map.get('Param.Path')!;
    expect(a.scheme).toBeTruthy();
    expect(b.scheme).toBeTruthy();
    expect(prettyTypeToString(a.scheme!.type))
      .toBe(prettyTypeToString(b.scheme!.type));
  });

  test('chained annotation with bare second-name (Identifier only)', () => {
    const src = `
// foo :: bar :: Number -> Number
const foo = (x) => x + 1;
`;
    const map = buildAnnotationMap(src);
    expect(map.has('foo')).toBe(true);
    expect(map.has('bar')).toBe(true);
  });

  test('second name with # is accepted (chained method annotation)', () => {
    // `Param#x` as a secondary registers a method-side annotation on
    // `Param` while the primary `Path` carries the binding/value side.
    const src = `
// Path :: Param#x :: (String) -> Param
const Path = (key) => ({ key });
`;
    const anns = extractAnnotations(src);
    const secondary = anns.find(a => a.name === 'Param#x');
    expect(secondary).toBeDefined();
    expect(secondary!.error).toBeUndefined();
    expect(secondary!.chainedSecondary).toBe(true);
  });

  test('hover offset attached to the secondary name', () => {
    const src = `
// Path :: Param.Path :: (String) -> Param
const Path = (key) => ({ key });
`;
    const anns = extractAnnotations(src);
    const sec = anns.find(a => a.name === 'Param.Path');
    expect(sec).toBeDefined();
    expect(sec!.signatureNameStart).toBeGreaterThan(0);
    expect(sec!.signatureNameEnd).toBeGreaterThan(sec!.signatureNameStart!);
    expect(src.slice(sec!.signatureNameStart!, sec!.signatureNameEnd!))
      .toBe('Param.Path');
  });

  test('n-fold chain // A :: B :: C :: T registers all three names', () => {
    const src = `
// Path :: Param.Path :: ParamCopy.Foemp :: (String, [a], b) -> Param
const Path = (key, rules = [], defaultValue) => ({ key, rules, defaultValue });
`;
    const map = buildAnnotationMap(src);
    expect(map.has('Path')).toBe(true);
    expect(map.has('Param.Path')).toBe(true);
    expect(map.has('ParamCopy.Foemp')).toBe(true);
    const a = map.get('Path')!;
    const c = map.get('ParamCopy.Foemp')!;
    expect(a.scheme).toBeTruthy();
    expect(c.scheme).toBeTruthy();
    expect(prettyTypeToString(a.scheme!.type))
      .toBe(prettyTypeToString(c.scheme!.type));
  });

  test('n-fold chain: every secondary carries a distinct name offset', () => {
    const src = `
// Path :: Param.Path :: ParamCopy.Foemp :: (String) -> Param
const Path = (key) => ({ key });
`;
    const anns = extractAnnotations(src);
    for (const nm of ['Param.Path', 'ParamCopy.Foemp']) {
      const sec = anns.find(a => a.name === nm);
      expect(sec).toBeDefined();
      expect(sec!.chainedSecondary).toBe(true);
      expect(src.slice(sec!.signatureNameStart!, sec!.signatureNameEnd!)).toBe(nm);
    }
    const offsets = anns
      .filter(a => a.chainedSecondary)
      .map(a => a.signatureNameStart!);
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  test('n-fold chain: malformed mid-name stops peeling without crashing', () => {
    // `Bad.Name.Too` has two dots — not a valid chained name shape — so it is
    // NOT peeled; it stays part of the (now-invalid) type signature and the
    // primary annotation reports a parse error instead of crashing.
    const src = `
// Path :: Param.Path :: Bad.Name.Too :: (String) -> Param
const Path = (key) => ({ key });
`;
    const anns = extractAnnotations(src);
    expect(anns.find(a => a.name === 'Param.Path')).toBeDefined();
    expect(anns.find(a => a.name === 'Bad.Name.Too')).toBeUndefined();
    const primary = anns.find(a => a.name === 'Path');
    expect(primary).toBeDefined();
    expect(primary!.error).toBeDefined();
  });
});

describe('Phase 4: sample/Param.js end-to-end', () => {
  test('sumtype carrier and variant factories produce no false-positive diagnostics', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'sample', 'Param.js'), 'utf8');
    const r = inferSource(src);
    const annMap = buildAnnotationMap(src);
    const doc = TextDocument.create('file:///Param.js', 'javascript', 1, src);
    const missing = detectMissingSignatures(
      src, doc, annMap,
      DiagnosticSeverity.Information,
      // varSeverity = null mirrors the default LSP behaviour where
      // non-function bindings (`const x = 5`) are not flagged.
      null,
    );

    // The sumtype carrier `Param` and both variant factories `Path` / `Query`
    // (covered by chained annotations) must not be flagged as missing.
    const carrierFlagged = missing.find(d =>
      d.message === "Function 'Param' has no HM annotation"
      || d.message === "Variable 'Param' has no HM annotation"
      || d.message === "Function 'Path' has no HM annotation"
      || d.message === "Function 'Query' has no HM annotation");
    expect(carrierFlagged).toBeUndefined();

    // Phase 2: variant constructors must not yield "returns a generic value".
    const generic = r.diagnostics.filter(d => d.message.includes('returns a generic value'));
    expect(generic).toEqual([]);

    // Sumtype-factory member assignment (`Param.Path = ...`) must not yield
    // a "value has type ... but annotation expects ..." mismatch — the
    // chained annotation makes it a sumtype factory.
    const factoryMismatch = r.diagnostics.filter(d =>
      d.message.includes('but annotation expects') && /Param\b/.test(d.message));
    expect(factoryMismatch).toEqual([]);

    // Phase 5: `Param.Query("somePath2", ...)` must resolve through the
    // record-field path (the annotated `Param.Query = ...` extends the
    // env-bound record).  No "Property 'Query' does not exist" diagnostic.
    const missingProp = r.diagnostics.filter(d =>
      d.message.startsWith("Property '") && d.message.includes('does not exist'));
    expect(missingProp).toEqual([]);

    // Phase 5: `Param.of = function() { return Path(...) }` references `Path`
    // which is declared textually later as `const Path = ...`.  The annotated
    // const is hoisted, so no "Unbound variable: 'Path'" diagnostic.
    const unbound = r.diagnostics.filter(d =>
      d.message.startsWith("Unbound variable: 'Path'"));
    expect(unbound).toEqual([]);
  });
});

describe('Phase 5: hoisting and member-assignment field extension', () => {
  test('annotated const referenced before its declaration is not flagged unbound', () => {
    const src = `
const O = {};

// O.run :: () -> Number
O.run = function() {
  return helper();
};

// helper :: () -> Number
const helper = () => 1;
`;
    const r = inferSource(src);
    const unbound = r.diagnostics.filter(d => d.message.includes("Unbound variable: 'helper'"));
    expect(unbound).toEqual([]);
  });

  // Policy changed 2026-11-13: unannotated
  // top-level consts are hoisted too — referencing one from an earlier
  // closure is valid JS (the closure runs later).
  test('unannotated const referenced before its declaration is hoisted', () => {
    const src = `
const O = {};
O.run = function() { return helper(); };
const helper = () => 1;
`;
    const r = inferSource(src);
    const unbound = r.diagnostics.filter(d => d.message.includes("Unbound variable: 'helper'"));
    expect(unbound).toEqual([]);
  });

  test('a name declared nowhere is still unbound', () => {
    const r = inferSource(`
const O = {};
O.run = function() { return helpr(); };
const helper = () => 1;
`);
    expect(r.diagnostics.some(d => d.message.includes("Unbound variable: 'helpr'"))).toBe(true);
  });

  test('annotated member assignment extends LHS record so later access works', () => {
    const src = `
const Box = {};
// Box.of :: a -> Box
Box.of = (x) => x;
const r = Box.of(1);
`;
    const r = inferSource(src);
    const missingProp = r.diagnostics.filter(d =>
      d.message.startsWith("Property 'of'") && d.message.includes('does not exist'));
    expect(missingProp).toEqual([]);
  });

  test('Param.Path(...) result is typed as Param (annotation type, not body record)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'sample', 'Param.js'), 'utf8');
    const engine = freshEngine();
    engine.infer(src);
    // `const path2 = Param.Path("somePath2", [1, "3"], undefined)` — the
    // binding identifier should resolve to the annotation's return type
    // `Param a b c` (with the call-site type arguments substituted in),
    // not the structural record produced by `Object.create(...)`.
    const off = src.indexOf('path2', src.indexOf('const path2'));
    const entry = (engine as any).nodeTypes.get(off);
    expect(entry).toBeDefined();
    const t = (engine as any).subst.apply(entry.type);
    expect(prettyTypeToString(t)).toMatch(/^Param(\s|$)/);
    expect(t.tag === 'TCon' && t.name === 'Param').toBe(true);

    // Same for `const path = Path("somePath", [1, "3"], undefined)` (direct
    // call, not via the Param.X member — should also be Param).
    const off2 = src.indexOf('path', src.indexOf('const path '));
    const entry2 = (engine as any).nodeTypes.get(off2);
    expect(entry2).toBeDefined();
    const t2 = (engine as any).subst.apply(entry2.type);
    expect(prettyTypeToString(t2)).toMatch(/^Param(\s|$)/);
    expect(t2.tag === 'TCon' && t2.name === 'Param').toBe(true);
  });
});
