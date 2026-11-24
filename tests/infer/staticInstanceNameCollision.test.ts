// ============================================================================
// Static / instance name collision on built-in types
//
// A user file may declare a STATIC helper whose name happens to collide with
// an existing INSTANCE method on a built-in type — e.g. `lst/every.js`:
//
//   // Array.every :: (a -> Boolean) -> Array a -> Boolean
//   natives.Array = function (pred) { return this.every(v => pred(v)); };
//
// Built-in `Array#every` is the well-known JS array `every` instance method.
// The two pieces of metadata are conceptually different members and the LSP
// must surface both: `Array.every` in static-completion, `[].every` in
// instance-completion.
//
// Before the parallel-namespace fix in MethodRegistry, the static
// registration would silently overwrite the built-in instance entry on the
// same map key, then ImportInferenceContext's `restoreBuiltinOriginalEntries`
// would wipe the static again — net effect: neither `[].every` instance
// (filtered out by the `isStatic: true` flag) nor `Array.every` static
// (gone after restore) was visible in a downstream consumer file.
// ============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import {
  InferenceEngine,
  lookupMethod,
  lookupStaticMethod,
  registerMethod,
  clearCustomMethods,
  tCon,
  tFun,
  tVar,
} from '../../src/index';
import { ImportInferenceContext } from '../../src/services/importContext';
import { getDotCompletions } from '../../src/services/completion';

// ---------------------------------------------------------------------------
// Registry-level
// ---------------------------------------------------------------------------

describe('MethodRegistry — static/instance name collision on built-in keys', () => {
  beforeEach(() => clearCustomMethods());

  test('registering a static with the same name as a built-in instance does not overwrite the instance', () => {
    const originalInstance = lookupMethod('Array', 'every');
    expect(originalInstance).not.toBeNull();
    expect(originalInstance!.isStatic).toBeFalsy();

    registerMethod('Array', 'every', {
      signature: '(a -> Boolean) -> Array a -> Boolean',
      factory: () => tFun(tVar('a'), tCon('Boolean')),
      isStatic: true,
    });

    // Instance is still the original — colliding static was routed aside.
    expect(lookupMethod('Array', 'every')).toBe(originalInstance);
    // Static is reachable through the dedicated lookup.
    const staticEntry = lookupStaticMethod('Array', 'every');
    expect(staticEntry).not.toBeNull();
    expect(staticEntry!.isStatic).toBe(true);
  });

  test('clearCustomMethods wipes the parallel-namespace static', () => {
    registerMethod('Array', 'every', {
      signature: 'x',
      factory: () => tCon('Boolean'),
      isStatic: true,
    });
    expect(lookupStaticMethod('Array', 'every')).not.toBeNull();
    clearCustomMethods();
    expect(lookupStaticMethod('Array', 'every')).toBeNull();
  });

  test('built-in static (no collision) still flows through the primary namespace', () => {
    // `Array.from` is a built-in static — it sits in the primary `methods`
    // map because it never collided with an instance entry of the same
    // name.  lookupStaticMethod returns it; lookupMethod returns it too.
    const fromEntry = lookupMethod('Array', 'from');
    expect(fromEntry?.isStatic).toBe(true);
    expect(lookupStaticMethod('Array', 'from')?.isStatic).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: cross-file static-on-built-in via require resolver
// ---------------------------------------------------------------------------

describe('cross-file: static collision on built-in survives import scan', () => {
  beforeEach(() => clearCustomMethods());

  test('Array.every static declared in an imported file is visible in `Array.` completion in the consumer', () => {
    const docs = new TextDocuments<TextDocument>(TextDocument as any);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-coll-'));
    try {
      fs.writeFileSync(path.join(tmp, 'every.js'), [
        '// Array.every :: (a -> Boolean) -> Array a -> Boolean',
        'module.exports = pred => arr => arr.every(pred);',
        '',
      ].join('\n'));
      const consumer = path.join(tmp, 'chain.js');
      const consumerSrc = "const every = require('./every');\nArray.\n";
      fs.writeFileSync(consumer, consumerSrc);

      const dotIdx = consumerSrc.lastIndexOf('Array.') + 'Array.'.length - 1;
      const items = getDotCompletions(consumerSrc, dotIdx + 1, dotIdx, 'file://' + consumer, {
        engine: new InferenceEngine(),
        createImportResolver: (u: string) => ctx.createImportResolver(u),
        createTypeDirectiveResolver: (u: string) => ctx.createTypeDirectiveResolver(u),
        inferFileAndCacheExports: (u: string) => ctx.inferFileAndCacheExports(u),
        inferredTypeStyle: 'pretty',
      });

      const labels = items.map((i) => i.label);
      expect(labels).toContain('every');
      // Built-in statics must still be there too.
      expect(labels).toContain('isArray');
      expect(labels).toContain('from');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('built-in instance `[].every` in the consumer is unaffected by the colliding static import', () => {
    const docs = new TextDocuments<TextDocument>(TextDocument as any);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-coll2-'));
    try {
      fs.writeFileSync(path.join(tmp, 'every.js'), [
        '// Array.every :: (a -> Boolean) -> Array a -> Boolean',
        'module.exports = pred => arr => arr.every(pred);',
        '',
      ].join('\n'));
      const consumer = path.join(tmp, 'chain.js');
      const consumerSrc = "const every = require('./every');\nconst arr = [1, 2, 3];\narr.\n";
      fs.writeFileSync(consumer, consumerSrc);

      const dotIdx = consumerSrc.lastIndexOf('arr.') + 'arr.'.length - 1;
      const items = getDotCompletions(consumerSrc, dotIdx + 1, dotIdx, 'file://' + consumer, {
        engine: new InferenceEngine(),
        createImportResolver: (u: string) => ctx.createImportResolver(u),
        createTypeDirectiveResolver: (u: string) => ctx.createTypeDirectiveResolver(u),
        inferFileAndCacheExports: (u: string) => ctx.inferFileAndCacheExports(u),
        inferredTypeStyle: 'pretty',
      });

      const labels = items.map((i) => i.label);
      // Original built-in instance methods must still be in instance completion.
      expect(labels).toContain('every');
      expect(labels).toContain('map');
      expect(labels).toContain('filter');
      // Statics must NOT appear in instance completion.
      expect(labels).not.toContain('isArray');
      expect(labels).not.toContain('from');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-file instance override on a built-in original key
//
// Distinct from the static-collision case: here the imported file declares
// `// Array#every :: ...` (instance, `~>`-receiver syntax) which is meant
// to REPLACE the built-in `Array#every` factory in any file that imports
// it.  Before this fix, `inferFileAndCacheExports` always rolled the
// built-in entry back to its factory state on exit, so the override was
// silently discarded.
// ---------------------------------------------------------------------------

describe('cross-file: instance override on built-in survives explicit import', () => {
  beforeEach(() => clearCustomMethods());

  test('imported `// Array#every :: ...` redefinition takes effect in the consumer', () => {
    const docs = new TextDocuments<TextDocument>(TextDocument as any);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-inst-ov-'));
    try {
      // Override returns String (instead of the built-in Boolean) so we
      // can detect the override took effect from the lookup signature.
      fs.writeFileSync(path.join(tmp, 'every.js'), [
        '// Array#every :: Array a ~> (a -> Boolean) -> String',
        'module.exports = pred => arr => arr.every(pred);',
        '',
      ].join('\n'));
      const consumer = path.join(tmp, 'chain.js');
      const consumerSrc = "const every = require('./every');\nconst x = [1, 2, 3];\n";
      fs.writeFileSync(consumer, consumerSrc);

      const engine = new InferenceEngine();
      engine.infer(consumerSrc, undefined,
        ctx.createImportResolver('file://' + consumer),
        ctx.createTypeDirectiveResolver('file://' + consumer));

      const overridden = lookupMethod('Array', 'every');
      expect(overridden).not.toBeNull();
      expect(overridden!.signature).toBe('Array a ~> (a -> Boolean) -> String');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a fresh engine without the explicit import sees the original built-in', () => {
    // Sanity: the override does NOT bleed into a brand-new engine pass
    // that did not require the file.  (clearCustomMethods + engine.infer
    // restore originals on the first pass.)
    clearCustomMethods();
    const engine = new InferenceEngine();
    engine.infer('const x = 1;');
    // The built-in predicate accepts any (truthy/falsy) callback result.
    expect(lookupMethod('Array', 'every')!.signature)
      .toBe('((a, Number, [a]) -> t) -> Boolean');
  });
});
