// `::hidden` / `::private` visibility directives.
//
// Consolidated from four suites:
//   1. hiddenDirective — `::hidden` on member annotations: annotation flag,
//      dot-completion filtering, explicit access still allowed, implicit
//      `constructor` hiding, `@@`-prefixed members, standalone `::hidden` on
//      class methods, record display omitting `constructor`.
//   2. hiddenDirectiveArgument — B3: a `::hidden` member annotation also hides
//      the field on the host record; B4: `::hidden <Qualified.Name>` targets a
//      single registration in a chained / multi-binding annotation.
//   3. hiddenObjectLiteralProperty — `::hidden` / `::private` directly above an
//      object-literal property: hidden from completion but still structural.
//   4. privateDirective — `::private` implies hidden, blocks external access
//      with a diagnostic, but allows (and completes) access via `this`.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, typeToString } from '../../src/hm/types';
import { getDotCompletions, CompletionContext } from '../../src/services/completion';
import {
  isMethodHidden,
  isMethodPrivate,
  clearCustomMethods,
} from '../../src/registries/methodRegistry';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { clearConstraints } from '../../src/registries/constraintRegistry';
import { extractAnnotations } from '../../src/commentParser';

let engine: InferenceEngine;

beforeEach(() => {
  clearDataTypes();
  clearCustomMethods();
  clearConstraints();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

// Shared by sections 1 and 4 (the two originals defined identical copies).
function makeCtx(): CompletionContext {
  return {
    engine,
    createImportResolver: () => () => null,
    createTypeDirectiveResolver: () => () => null,
    inferFileAndCacheExports: () => null,
    inferredTypeStyle: 'pretty',
  };
}

// ---------------------------------------------------------------------------
// 1. hiddenDirective — `::hidden` on member annotations.
// ---------------------------------------------------------------------------

describe('::hidden directive', () => {
  test('parses ::hidden flag onto annotation', () => {
    const r = engine.infer(`
// ::hidden
// Box#secret :: Box a ~> a
const _ = 0;
class Box { constructor(v) { this.v = v; } }
// Box :: a -> Box a
    `);
    const ann = r.annotations.get('Box#secret');
    expect(ann?.hidden).toBe(true);
  });

  test('silently ignores ::hidden on a top-level (non-member) annotation', () => {
    const r = engine.infer(`
// ::hidden
// foo :: Number
const foo = 42;
    `);
    expect(r.diagnostics.some(d =>
      d.message.includes('::hidden')
    )).toBe(false);
  });

  test('hidden member is not offered in dot-completion', () => {
    const source = `
class Box { constructor(v) { this.v = v; } }
// Box :: a -> Box a
// Box#visible :: Box a ~> a
// ::hidden
// Box#secret :: Box a ~> a
const b = new Box(1);
b.`;
    const offset = source.length;
    const dotIdx = offset - 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('visible');
    expect(labels).not.toContain('secret');
  });

  test('hidden member still works when typed explicitly (inference)', () => {
    const r = engine.infer(`
class Box { constructor(v) { this.v = v; } }
// Box :: a -> Box a
// ::hidden
// Box#secret :: Box a ~> a
const b = new Box(42);
const s = b.secret;
    `);
    expect(r.diagnostics.filter(d =>
      d.message.includes("'secret'") && d.message.includes('does not exist')
    )).toHaveLength(0);
  });

  test("`constructor` is implicitly hidden from completion", () => {
    const source = `
class Box { constructor(v) { this.v = v; } }
// Box :: a -> Box a
// Box#map :: Box a ~> (a -> b) -> Box b
// Box#size :: Box a ~> Number
const b = new Box(1);
b.`;
    const offset = source.length;
    const dotIdx = offset - 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).not.toContain('constructor');
    expect(labels.length).toBeGreaterThan(0);
  });

  test('parses @@-prefixed member annotation (Phase A)', () => {
    const r = engine.infer(`
// Param :: Path | Query
class Path { constructor(k) { this.k = k; } }
class Query { constructor(k) { this.k = k; } }
// Path :: a -> Param
// Query :: a -> Param
// ::hidden
// Param#@@type :: String
const p = new Path(1);
    `);
    const ann = r.annotations.get('Param#@@type');
    expect(ann).toBeDefined();
    expect(ann?.hidden).toBe(true);
  });

  test('standalone ::hidden hides class method without annotation (Phase C)', () => {
    const source = `
class Box {
  constructor(v) { this.v = v; }
  // ::hidden
  secret() { return 42; }
  visible() { return 1; }
}
// Box :: a -> Box a
const b = new Box(1);
`;
    engine.infer(source);
    expect(isMethodHidden('Box', 'secret')).toBe(true);
    expect(isMethodHidden('Box', 'visible')).toBe(false);
  });

  test('record display omits `constructor` field (Phase B)', () => {
    // Object.create(prototype) inherits a `constructor` field; the printed
    // record type should not surface it.
    const r = engine.infer(`
const proto = { constructor: 1, foo: 'a', bar: 2 };
const x = Object.create(proto);
x.foo;
x.bar;
    `);
    // Find the binding for `proto` and check its printed type omits constructor.
    const protoScheme = r.topLevelBindings.get('proto');
    expect(protoScheme).toBeDefined();
    const { prettyTypeToString } = require('../../src/hm/types');
    const display = prettyTypeToString(protoScheme!.type);
    expect(display).not.toMatch(/\bconstructor\b/);
  });
});

// ---------------------------------------------------------------------------
// 2. hiddenDirectiveArgument
// ---------------------------------------------------------------------------
// Fase B3 / B4: `::hidden` record-field hiding and targeted `::hidden <Name>`.
//
// B3: a `::hidden` member annotation must also hide the corresponding field on
//     the host record, so hover/completion over the host (e.g. `natives`) does
//     not surface it.
// B4: `::hidden <Qualified.Name>` selects a single registration target in a
//     chained / multi-binding annotation, hiding only that one.

{
  const render = (r: ReturnType<InferenceEngine['infer']>, name: string): string => {
    const sch = r.topLevelBindings.get(name);
    expect(sch).toBeDefined();
    return typeToString(r.substitution.apply(sch!.type));
  };

  describe('B3: ::hidden hides the host record field', () => {
    test('hidden natives member does not appear in the host record render', () => {
      const r = engine.infer(`
const natives = {};

// ::hidden
// natives.Object :: Object ~> Object
natives.Object = function () {};
`);
      expect(render(r, 'natives')).not.toMatch(/\bObject\b/);
    });
  });

  describe('B4: ::hidden <Qualified.Name> targets a single binding', () => {
    const source = `
const Param = {};
const ParamCopy = {};

// ::hidden ParamCopy.Path
// Path :: Param.Path :: ParamCopy.Path :: (a) -> Param
const Path = Param.Path = ParamCopy.Path = (key) => ({ key });
`;

    test('only the named chained target is hidden', () => {
      const anns = extractAnnotations(source);
      const byName = (n: string) => anns.find((a) => a.name === n);
      expect(byName('ParamCopy.Path')?.hidden).toBe(true);
      expect(byName('Param.Path')?.hidden).toBeFalsy();
      expect(byName('Path')?.hidden).toBeFalsy();
    });

    test('the named target field is hidden on its host record only', () => {
      const r = engine.infer(source);
      expect(render(r, 'ParamCopy')).not.toMatch(/\bPath\b/);
      expect(render(r, 'Param')).toMatch(/\bPath\b/);
    });
  });

  describe('B4: stacked ::hidden <Name> directives act independently', () => {
    const source = `
const Param = {};
const ParamCopy = {};
const ParamCopy2 = {};

// ::hidden ParamCopy.Path
// ::hidden ParamCopy2.Path
// Path :: Param.Path :: ParamCopy.Path :: ParamCopy2.Path :: (a) -> Param
const Path = Param.Path = ParamCopy.Path = ParamCopy2.Path = (key) => ({ key });
`;

    test('both stacked targets are hidden, others stay visible', () => {
      const anns = extractAnnotations(source);
      const byName = (n: string) => anns.find((a) => a.name === n);
      expect(byName('ParamCopy.Path')?.hidden).toBe(true);
      expect(byName('ParamCopy2.Path')?.hidden).toBe(true);
      expect(byName('Param.Path')?.hidden).toBeFalsy();
      expect(byName('Path')?.hidden).toBeFalsy();
    });

    test('both named fields are hidden on their host records', () => {
      const r = engine.infer(source);
      expect(render(r, 'ParamCopy')).not.toMatch(/\bPath\b/);
      expect(render(r, 'ParamCopy2')).not.toMatch(/\bPath\b/);
      expect(render(r, 'Param')).toMatch(/\bPath\b/);
    });
  });
}

// ---------------------------------------------------------------------------
// 3. hiddenObjectLiteralProperty
// ---------------------------------------------------------------------------
/**
 * Tests for `// ::hidden` (and `// ::private`) directives placed directly
 * above a property in an *object literal*.
 *
 * Behaviour under test:
 *   1. The field is still part of the structural type, so a call site that
 *      requires it (e.g. `getType :: { @@type :: String } -> String`) accepts
 *      the object — no missing-field diagnostic.
 *   2. `getDotCompletions` on the value omits the hidden field.
 *   3. The visible fields still complete; non-hidden fields are not
 *      duplicated.
 *   4. `// ::private` directly above a property behaves identically to
 *      `// ::hidden` for visibility purposes.
 */

{
  // This section's originals built a ctx with a FRESH engine per call (unlike
  // the shared makeCtx above, which reuses the beforeEach engine).
  function makeCtx(): CompletionContext {
    return {
      engine: new InferenceEngine(),
      createImportResolver: () => () => null,
      createTypeDirectiveResolver: () => () => null,
      inferFileAndCacheExports: () => null,
      inferredTypeStyle: 'pretty',
    };
  }

  function dotLabelsAt(source: string, dotMarker: string, ctx: CompletionContext): string[] {
    const dotIdx = source.indexOf(dotMarker) + dotMarker.length - 1;
    const offset = dotIdx + 1;
    return getDotCompletions(source, offset, dotIdx, 'file:///t.js', ctx).map(i => i.label);
  }

  describe('hidden property in object literal', () => {
    test('// ::hidden hides @@type from dot completion (no duplicate "a")', () => {
      const source =
        '// getType :: { @@type :: String } | Undefined -> String\n' +
        'const getType = value => value && value["@@type"] || {}.toString.call(value).slice(8, -1);\n' +
        '\n' +
        'const obj = {\n' +
        '  //::hidden\n' +
        '  "@@type": "Foo",\n' +
        '  a: "string"\n' +
        '};\n' +
        '\n' +
        'obj.\n' +
        '\n' +
        'const tObj = getType(obj);\n';
      const labels = dotLabelsAt(source, 'obj.', makeCtx());
      expect(labels).toContain('a');
      expect(labels).not.toContain('@@type');
      // No duplicate visible field.
      expect(labels.filter(l => l === 'a').length).toBe(1);
    });

    test('hidden @@type is still accepted by structural call site (no missing-field diagnostic)', () => {
      const source =
        '// getType :: { @@type :: String } | Undefined -> String\n' +
        'const getType = value => value && value["@@type"] || {}.toString.call(value).slice(8, -1);\n' +
        '\n' +
        'const obj = {\n' +
        '  //::hidden\n' +
        '  "@@type": "Foo",\n' +
        '  a: "string"\n' +
        '};\n' +
        '\n' +
        'const tObj = getType(obj);\n';
      const engine = new InferenceEngine();
      const result = engine.infer(source);
      // The call must not produce a missing-`@@type` diagnostic.
      const missingFieldDiag = result.diagnostics.find(d =>
        /@@type/.test(d.message) && /missing|required|expected/i.test(d.message),
      );
      expect(missingFieldDiag).toBeUndefined();
    });

    test('// ::private directly above a property hides it from dot completion', () => {
      const source =
        'const obj = {\n' +
        '  //::private\n' +
        '  secret: 42,\n' +
        '  visible: "yes"\n' +
        '};\n' +
        '\n' +
        'obj.\n';
      const labels = dotLabelsAt(source, 'obj.', makeCtx());
      expect(labels).toContain('visible');
      expect(labels).not.toContain('secret');
    });

    test('hidden field is preserved through substitution (still in TRecord.fields)', () => {
      const source =
        'const obj = {\n' +
        '  //::hidden\n' +
        '  "@@type": "Foo",\n' +
        '  a: "string"\n' +
        '};\n';
      const engine = new InferenceEngine();
      const result = engine.infer(source);
      // Find the `obj` binding type.
      const objScheme = result.topLevelBindings.get('obj');
      expect(objScheme).toBeDefined();
      const t = result.substitution.apply(objScheme!.type);
      expect(t.tag).toBe('TRecord');
      if (t.tag === 'TRecord') {
        // Both fields must remain in `fields` (structural).
        expect(Object.keys(t.fields).sort()).toEqual(['@@type', 'a']);
        // Hidden marker carries the @@type name.
        expect(t.hiddenFields?.has('@@type')).toBe(true);
        expect(t.hiddenFields?.has('a')).toBeFalsy();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 4. privateDirective — `::private` implies hidden and blocks external access.
// ---------------------------------------------------------------------------

describe('::private directive', () => {
  test('parses ::private flag onto annotation (and implies hidden)', () => {
    const r = engine.infer(`
// ::private
// Box#secret :: Box a ~> a
class Box { constructor(v) { this.v = v; } }
// Box :: a -> Box a
    `);
    const ann = r.annotations.get('Box#secret');
    expect(ann?.private).toBe(true);
    expect(ann?.hidden).toBe(true);
    expect(isMethodPrivate('Box', 'secret')).toBe(true);
    expect(isMethodHidden('Box', 'secret')).toBe(true);
  });

  test('::private stacks with ::hidden line above annotation', () => {
    const r = engine.infer(`
// ::private
// ::hidden
// Box#x :: Box a ~> a
class Box { constructor(v) { this.v = v; } }
// Box :: a -> Box a
    `);
    const ann = r.annotations.get('Box#x');
    expect(ann?.private).toBe(true);
    expect(ann?.hidden).toBe(true);
  });

  test('private member is filtered from dot-completion', () => {
    const source = `
class Box { constructor(v) { this.v = v; } }
// Box :: a -> Box a
// Box#visible :: Box a ~> a
// ::private
// Box#secret :: Box a ~> a
const b = new Box(1);
b.`;
    const offset = source.length;
    const dotIdx = offset - 1;
    const items = getDotCompletions(source, offset, dotIdx, 'file:///pp.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('visible');
    expect(labels).not.toContain('secret');
  });

  test('private member access from outside emits diagnostic', () => {
    const r = engine.infer(`
class Box { constructor(v) { this.v = v; } }
// Box :: a -> Box a
// ::private
// Box#secret :: Box a ~> a
const b = new Box(1);
const x = b.secret;
    `);
    expect(r.diagnostics.some(d =>
      d.message.includes("'secret'") && d.message.includes('private')
    )).toBe(true);
  });

  test('private member access via this does NOT emit diagnostic', () => {
    const r = engine.infer(`
class Box {
  constructor(v) { this.v = v; }
  // ::private
  // Box#secret :: Box a ~> Number
  secret() { return 42; }
  // Box#use :: Box a ~> Number
  use() { return this.secret(); }
}
// Box :: a -> Box a
    `);
    expect(r.diagnostics.filter(d =>
      d.message.includes("'secret'") && d.message.includes('private')
    )).toHaveLength(0);
  });

  test('standalone ::private on class method registers as private', () => {
    engine.infer(`
class Box {
  constructor(v) { this.v = v; }
  // ::private
  secret() { return 42; }
  visible() { return 1; }
}
// Box :: a -> Box a
    `);
    expect(isMethodPrivate('Box', 'secret')).toBe(true);
    expect(isMethodHidden('Box', 'secret')).toBe(true);
    expect(isMethodPrivate('Box', 'visible')).toBe(false);
  });

  test('private prototype method is registered as private', () => {
    engine.infer(`
function Box(v) { this.v = v; }
// Box :: a -> Box a
// ::private
// Box#secret :: Box a ~> a
Box.prototype.secret = function () { return this.v; };
    `);
    expect(isMethodPrivate('Box', 'secret')).toBe(true);
  });

  test('private member IS offered in dot-completion on `this`', () => {
    const prelude = `
class Box {
  constructor(v) { this.v = v; }
  // ::private
  // Box#secret :: Box a ~> Number
  secret() { return 42; }
  // Box#use :: Box a ~> Number
  use() { return this.x; }
}
// Box :: a -> Box a
`;
    const source = prelude + 'const b = new Box(1); b.';
    const offset = source.length;
    const dotIdx = offset - 1;
    const itemsExt = getDotCompletions(source, offset, dotIdx, 'file:///pp.js', makeCtx());
    expect(itemsExt.map(i => i.label)).not.toContain('secret');

    // Now `this.` inside a method body: replace `this.x` with `this.<here>`
    const innerSrc = prelude.replace('this.x', 'this.');
    const innerOff = innerSrc.indexOf('this.') + 'this.'.length;
    const innerDot = innerOff - 1;
    const itemsThis = getDotCompletions(innerSrc, innerOff, innerDot, 'file:///pp.js', makeCtx());
    expect(itemsThis.map(i => i.label)).toContain('secret');
  });

  test('::private on top-level (non-member) annotation is silently ignored', () => {
    const r = engine.infer(`
// ::private
// foo :: Number
const foo = 42;
    `);
    expect(r.diagnostics.some(d =>
      d.message.toLowerCase().includes('private')
    )).toBe(false);
  });
});
