import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ImportInferenceContext } from '../../src/services/importContext';
import { evictHmSidecar } from '../../src/services/files';

describe('selective .hm sidecar invalidation', () => {
  test('getDependents reports direct importers but not unrelated files', () => {
    const docs = new TextDocuments(TextDocument);
    const ctx = new ImportInferenceContext(docs, { warn: () => { /* noop */ } });
    const hmUri = 'file:///workspace/hm-types/sqlkit.hm';
    const importerUri = 'file:///workspace/src/repo.js';
    const otherUri = 'file:///workspace/src/unrelated.js';

    ctx.trackDependency(importerUri, hmUri);

    const dependents = ctx.getDependents(hmUri);
    expect(dependents).toBeDefined();
    expect(dependents!.has(importerUri)).toBe(true);
    expect(dependents!.has(otherUri)).toBe(false);
  });

  test('getDependents returns undefined for never-tracked uri (triggers conservative fallback)', () => {
    const docs = new TextDocuments(TextDocument);
    const ctx = new ImportInferenceContext(docs, { warn: () => { /* noop */ } });
    expect(ctx.getDependents('file:///never/touched.hm')).toBeUndefined();
  });

  test('getDependents reflects transitive re-export chain when both edges are tracked', () => {
    const docs = new TextDocuments(TextDocument);
    const ctx = new ImportInferenceContext(docs, { warn: () => { /* noop */ } });
    const leafHm = 'file:///workspace/hm-types/sqlkit.hm';
    const midJs = 'file:///workspace/src/types/index.js';
    const consumerJs = 'file:///workspace/src/repo.js';

    ctx.trackDependency(midJs, leafHm);
    ctx.trackDependency(consumerJs, midJs);

    // Direct dependents of the .hm
    expect(Array.from(ctx.getDependents(leafHm)!)).toEqual([midJs]);
    // Transitive dependents of the mid layer
    expect(Array.from(ctx.getDependents(midJs)!)).toEqual([consumerJs]);
  });

  test('evictHmSidecar accepts both file:// URIs and absolute paths without throwing', () => {
    expect(() => evictHmSidecar('file:///tmp/never-loaded.hm')).not.toThrow();
    expect(() => evictHmSidecar('/tmp/never-loaded.hm')).not.toThrow();
  });
});
