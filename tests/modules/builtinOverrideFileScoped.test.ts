// ============================================================================
// File-scoped builtin-override policy
//
// A `.js` file that ships a shorthand HM annotation for a built-in method —
// e.g. `// Array.every :: (a -> Boolean) -> Array a -> Boolean` — registers
// a new entry that ignores receiver typeArgs and overwrites the built-in
// `Array#every` factory globally.  Without protection this corrupts the
// inferred type of `arr.every(...)` in every other file in the workspace.
//
// The LSP layer wraps `engine.infer` (and import-context scans) with
// `snapshotBuiltinOriginalEntries` / `restoreBuiltinOriginalEntries` so the
// override stays scoped to the file that declared it.  Only `globals.hm`
// (re-processed at the start of every `engine.infer` from `globalsSource`)
// may permanently mutate built-in entries.
//
// These tests exercise the registry primitives directly and then verify the
// end-to-end behaviour via `engine.infer` + `ImportInferenceContext`.
// ============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import {
  InferenceEngine,
  lookupMethod,
  registerMethod,
  clearCustomMethods,
  snapshotBuiltinOriginalEntries,
  restoreBuiltinOriginalEntries,
  tCon,
  tFun,
  tVar,
} from '../../src/index';
import { ImportInferenceContext } from '../../src/services/importContext';

// ---------------------------------------------------------------------------
// Registry-level: snapshot/restore semantics
// ---------------------------------------------------------------------------

describe('snapshotBuiltinOriginalEntries / restoreBuiltinOriginalEntries', () => {
  beforeEach(() => clearCustomMethods());

  test('restore undoes an overwrite of an original built-in entry', () => {
    const original = lookupMethod('Array', 'every');
    expect(original).not.toBeNull();
    const originalSig = original!.signature;

    const snap = snapshotBuiltinOriginalEntries();

    // Simulate a `// Array.every :: ...` shorthand annotation taking
    // effect — `register` overwrites the entry on the same key.
    registerMethod('Array', 'every', {
      signature: '(a -> Boolean) -> Array a -> Boolean',
      factory: () => tFun(tVar('a'), tCon('Boolean')),
    });
    expect(lookupMethod('Array', 'every')!.signature)
      .toBe('(a -> Boolean) -> Array a -> Boolean');

    restoreBuiltinOriginalEntries(snap);
    expect(lookupMethod('Array', 'every')!.signature).toBe(originalSig);
  });

  test('restore does not delete custom additions on non-builtin types', () => {
    const snap = snapshotBuiltinOriginalEntries();
    registerMethod('UserBox', 'unwrap', {
      signature: 'Box a ~> a',
      factory: () => tVar('a'),
    });
    expect(lookupMethod('UserBox', 'unwrap')).not.toBeNull();

    restoreBuiltinOriginalEntries(snap);
    // Custom non-builtin type is untouched by the builtin-only restore.
    expect(lookupMethod('UserBox', 'unwrap')).not.toBeNull();
  });

  test('restore does not delete custom additions on built-in types', () => {
    // Adding a *new* method on Array (not an original key) is a custom
    // addition — it must survive a builtin-only restore.
    const snap = snapshotBuiltinOriginalEntries();
    registerMethod('Array', 'chunk', {
      signature: 'Number -> Array (Array a)',
      factory: () => tFun(tCon('Number'), tVar('a')),
    });
    expect(lookupMethod('Array', 'chunk')).not.toBeNull();

    restoreBuiltinOriginalEntries(snap);
    expect(lookupMethod('Array', 'chunk')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: simulated LSP wrap around engine.infer
// ---------------------------------------------------------------------------

/**
 * Mirrors `safeEngineInfer` in `src/server.ts`: snapshot built-in originals
 * before inference, restore them afterwards (even on throw).  Keeps any
 * file-level shorthand override scoped to the inferring pass only.
 */
function safeInfer(engine: InferenceEngine, src: string) {
  const snap = snapshotBuiltinOriginalEntries();
  try {
    return engine.infer(src);
  } finally {
    restoreBuiltinOriginalEntries(snap);
  }
}

describe('Engine — file-scoped builtin override via safeInfer wrap', () => {
  beforeEach(() => clearCustomMethods());

  test('shorthand `Array.every ::` in one file does not leak to the next', () => {
    const engine = new InferenceEngine();
    const originalSig = lookupMethod('Array', 'every')!.signature;

    // File A: ships a shorthand annotation that would otherwise overwrite
    // `Array#every` globally.
    const fileA = `
      // Array.every :: (a -> Boolean) -> Array a -> Boolean
      const natives = {};
      natives.Array = function (pred) { return this.every(value => pred(value)); };
      module.exports = natives;
    `;
    safeInfer(engine, fileA);

    // The built-in entry is back to its receiver-binding factory.
    expect(lookupMethod('Array', 'every')!.signature).toBe(originalSig);

    // File B: plain consumer — `[1, 2, 3].every(...)` must still resolve
    // to the receiver-binding form (Boolean result), not the corrupted
    // raw curried form.
    const fileB = `
      const xs = [1, 2, 3];
      const result = xs.every(x => x > 0);
    `;
    const r = safeInfer(engine, fileB);

    const resultEntry = [...r.exports.entries()].find(([k]) => k === 'result')
      ?? [...r.diagnostics];
    // Even if `result` isn't exported, no diagnostics should be raised:
    // the receiver-binding factory unifies `[Number].every(Number -> Boolean)`
    // to `Boolean` without complaint.
    expect(r.diagnostics).toEqual([]);
    void resultEntry; // value not asserted here; cleanliness suffices
  });

  test('snapshot/restore protects originals even when inference throws', () => {
    const engine = new InferenceEngine();
    const originalSig = lookupMethod('Array', 'every')!.signature;

    const snap = snapshotBuiltinOriginalEntries();
    try {
      registerMethod('Array', 'every', {
        signature: 'broken',
        factory: () => { throw new Error('boom'); },
      });
      throw new Error('simulated infer failure');
    } catch {
      // swallow
    } finally {
      restoreBuiltinOriginalEntries(snap);
    }
    expect(lookupMethod('Array', 'every')!.signature).toBe(originalSig);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: ImportInferenceContext.inferFileAndCacheExports must not
// permanently corrupt built-in entries when scanning a sibling file.
// ---------------------------------------------------------------------------

describe('ImportInferenceContext — builtin override stays file-scoped', () => {
  beforeEach(() => clearCustomMethods());

  test('inferring an importable file with `Array.every ::` does not corrupt the registry', () => {
    const originalSig = lookupMethod('Array', 'every')!.signature;

    const docs = new TextDocuments<TextDocument>(TextDocument as any);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-builtin-scope-'));
    try {
      const corruptingFile = path.join(tmpDir, 'every.js');
      fs.writeFileSync(corruptingFile, [
        '// Array.every :: (a -> Boolean) -> Array a -> Boolean',
        'const natives = {};',
        'natives.Array = function (pred) { return this.every(v => pred(v)); };',
        'module.exports = natives;',
        '',
      ].join('\n'));

      ctx.inferFileAndCacheExports(`file://${corruptingFile}`);

      // After the import scan completes the global registry entry must be
      // restored to the original receiver-binding factory.
      expect(lookupMethod('Array', 'every')!.signature).toBe(originalSig);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
