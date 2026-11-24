// ============================================================================
// Workspace-export cache regressions (perf fix, see getWorkspaceExports).
//
// Background: typing `const test = p` under a function in a large repo
// (570-file fpkit) froze the server for ~10s per completion request:
// every request with a ≥2-char partial synchronously inferred up to 500
// workspace files, and the import LRU (200 entries) thrashed, so the scan
// never became warm.  Diagnostics and follow-up completions queued behind
// it ("diagnostics haperen").
//
// The fix caches per-file exports keyed by on-disk mtime, bounds the
// request-path scan with a time budget, and warms the cache incrementally
// in the background (warmWorkspaceExports, driven by the server after
// validation).
// ============================================================================

import {
  getWorkspaceExports,
  warmWorkspaceExports,
  clearWorkspaceExportCache,
  invalidateWorkspaceExportEntry,
  getIdentifierCompletions,
  CompletionContext,
} from '../../src/services/completion';
import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, mono, tCon, Scheme } from '../../src/hm/types';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

function makeCtx(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    engine: new InferenceEngine(),
    createImportResolver: () => () => null,
    createTypeDirectiveResolver: () => () => null,
    inferFileAndCacheExports: () => null,
    inferredTypeStyle: 'pretty',
    ...overrides,
  };
}

/** Create a temp workspace with `source.js` plus the given sibling files. */
function makeWorkspace(files: Record<string, string>): { dir: string; uri: string } {
  const dir = fs.mkdtempSync(path.join(__dirname, '.tmp-wsx-'));
  fs.writeFileSync(path.join(dir, 'source.js'), 'const x = 1;');
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return { dir, uri: pathToFileURL(path.join(dir, 'source.js')).href };
}

describe('getWorkspaceExports — per-file mtime cache', () => {
  beforeEach(() => {
    resetTypeVarCounter();
    clearWorkspaceExportCache();
  });

  test('second scan serves cached exports without re-inferring', () => {
    const { dir, uri } = makeWorkspace({ 'utils.js': 'export const add = (a, b) => a + b;' });
    try {
      const inferred: string[] = [];
      const infer = (fileUri: string) => {
        inferred.push(fileUri);
        return new Map<string, Scheme>([['add', mono(tCon('Number'))]]);
      };

      const first = getWorkspaceExports(uri, infer);
      expect(first.has('add')).toBe(true);
      const callsAfterFirst = inferred.length;
      expect(callsAfterFirst).toBeGreaterThan(0);

      const second = getWorkspaceExports(uri, infer);
      expect(second.has('add')).toBe(true);
      expect(inferred.length).toBe(callsAfterFirst); // no new inference
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('inference failures are cached too (no re-infer per keystroke)', () => {
    const { dir, uri } = makeWorkspace({ 'broken.js': 'syntax error(((' });
    try {
      let calls = 0;
      const infer = () => { calls++; return null; };

      getWorkspaceExports(uri, infer);
      const after = calls;
      getWorkspaceExports(uri, infer);
      expect(calls).toBe(after);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('invalidateWorkspaceExportEntry forces a single-file re-infer', () => {
    const { dir, uri } = makeWorkspace({ 'utils.js': 'export const add = 1;' });
    const utilsUri = pathToFileURL(path.join(dir, 'utils.js')).href;
    try {
      const inferred: string[] = [];
      const infer = (fileUri: string) => {
        inferred.push(fileUri);
        return new Map<string, Scheme>([['add', mono(tCon('Number'))]]);
      };

      getWorkspaceExports(uri, infer);
      const after = inferred.length;

      invalidateWorkspaceExportEntry(utilsUri);
      getWorkspaceExports(uri, infer);
      expect(inferred.length).toBe(after + 1);
      expect(inferred[inferred.length - 1]).toBe(utilsUri);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exhausted budget skips uncached files instead of blocking', () => {
    const { dir, uri } = makeWorkspace({
      'a.js': 'export const aaa = 1;',
      'b.js': 'export const bbb = 2;',
    });
    try {
      let calls = 0;
      const slowInfer = (fileUri: string) => {
        calls++;
        const until = Date.now() + 15; // simulate slow inference
        while (Date.now() < until) { /* spin */ }
        const name = path.basename(fileUri).startsWith('a') ? 'aaa' : 'bbb';
        return new Map<string, Scheme>([[name, mono(tCon('Number'))]]);
      };

      // Budget of 1ms: after the first slow file the budget is exhausted,
      // so at most a handful of files are inferred — not all of them.
      const first = getWorkspaceExports(uri, slowInfer, 1);
      expect(calls).toBeLessThan(2 + 1); // source.js excluded; ≤1 of a/b inferred
      expect(first.size).toBeLessThanOrEqual(1);

      // Follow-up rounds pick up the remaining files incrementally.
      getWorkspaceExports(uri, slowInfer, 1_000);
      const final = getWorkspaceExports(uri, slowInfer, 1_000);
      expect(final.has('aaa')).toBe(true);
      expect(final.has('bbb')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('warmWorkspaceExports — incremental background warming', () => {
  beforeEach(() => {
    resetTypeVarCounter();
    clearWorkspaceExportCache();
  });

  test('warms a bounded number of files per tick until complete', () => {
    const { dir, uri } = makeWorkspace({
      'a.js': 'export const aaa = 1;',
      'b.js': 'export const bbb = 2;',
      'c.js': 'export const ccc = 3;',
    });
    try {
      const inferred: string[] = [];
      const infer = (fileUri: string) => {
        inferred.push(fileUri);
        return new Map<string, Scheme>([[path.basename(fileUri, '.js'), mono(tCon('Number'))]]);
      };

      // 3 candidate files, 2 per tick → first tick incomplete
      expect(warmWorkspaceExports(uri, infer, 2)).toBe(false);
      expect(inferred.length).toBe(2);
      // second tick finishes the remainder
      expect(warmWorkspaceExports(uri, infer, 2)).toBe(true);
      expect(inferred.length).toBe(3);
      // fully warm → stat-only noop
      expect(warmWorkspaceExports(uri, infer, 2)).toBe(true);
      expect(inferred.length).toBe(3);

      // The request path now assembles everything from cache without
      // inferring, even with a zero budget.
      const result = getWorkspaceExports(uri, infer, 0);
      expect(inferred.length).toBe(3);
      expect(result.has('a')).toBe(true);
      expect(result.has('b')).toBe(true);
      expect(result.has('c')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('identifier completion regression — propOrElse under its own definition', () => {
  beforeEach(() => {
    resetTypeVarCounter();
    clearWorkspaceExportCache();
  });

  test('typing `const test = p` below a CJS binding suggests it', () => {
    // fpkit-style CJS file: require with a space before the paren, an
    // annotation comment above the binding, module.exports at the bottom.
    const source = `"use strict";

const maybeToEither = require ("../Either/maybeToEither");
const prop = require ("../object/prop");

// propOrElse :: e -> k -> { [k] :: a } -> Either e a
const propOrElse = err => propName => obj =>
  maybeToEither (err) (prop (propName) (obj));

const test = p
module.exports = propOrElse;`;
    const offset = source.indexOf('const test = p') + 'const test = p'.length;

    const items = getIdentifierCompletions(source, offset, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('propOrElse');
    expect(labels).toContain('prop');
  });
});
