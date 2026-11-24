// Tests for sample/demo7.js — the call-site projection demo.
//
// Covers:
//  • The five micro-examples (q1..q5) keep producing their documented
//    projected types.
//  • The realistic scenarios appended to the file (postDetail,
//    dashboard, firstPage, postIds) infer cleanly and produce the
//    projected records described in their doc-comments.
//  • The demo file itself emits NO diagnostics — projection + relation
//    + Prop machinery cooperate end-to-end.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { wrapHmSource } from '../../src/services/files';
import { prettyTypeToString } from '../../src/hm/types';

const sampleDir = path.resolve(__dirname, '..', '..', 'sample');
const globalsSrc = wrapHmSource(fs.readFileSync(path.join(sampleDir, 'globals.hm'), 'utf8'));

function inferDemo(): { src: string; result: ReturnType<InferenceEngine['infer']> } {
  const filePath = path.join(sampleDir, 'demo7.js');
  const fileUri = pathToFileURL(filePath).href;
  const src = fs.readFileSync(filePath, 'utf8');
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  const resolver = ctx.createImportResolver(fileUri);
  const eng = new InferenceEngine();
  eng.globalsSource = globalsSrc;
  const result = eng.infer(src, undefined, resolver);
  return { src, result };
}

function typeOfBinding(src: string, result: ReturnType<InferenceEngine['infer']>, name: string): string | null {
  const m = src.match(new RegExp('\\bconst ' + name + ' '));
  if (!m || m.index === undefined) return null;
  const off = m.index + 'const '.length;
  for (const [start, info] of result.nodeTypes) {
    if (start === off) return prettyTypeToString(info.type);
  }
  return null;
}

describe('sample/demo7.js (call-site projection demo)', () => {
  test('infers cleanly with no diagnostics', () => {
    const { result } = inferDemo();
    expect(result.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('q1 — string-literal column selection', () => {
    const { src, result } = inferDemo();
    expect(typeOfBinding(src, result, 'q1'))
      .toBe('Q { id :: Number, title :: String }');
  });

  test('q2 — Prop T calculated field', () => {
    const { src, result } = inferDemo();
    expect(typeOfBinding(src, result, 'q2'))
      .toBe('Q { id :: Number, wordCount :: Number }');
  });

  test('q3 — nested call resolved through method-shadows', () => {
    const { src, result } = inferDemo();
    expect(typeOfBinding(src, result, 'q3'))
      .toBe('Q { id :: Number, author :: { name :: String }, comments :: [{ text :: String }] }');
  });

  test('q4 — bare relation identifier selects all child columns', () => {
    const { src, result } = inferDemo();
    expect(typeOfBinding(src, result, 'q4'))
      .toBe('Q { id :: Number, author :: { id :: Number, name :: String, email :: String } }');
  });

  test('q5 — implicit "select all columns" when no column selectors are present', () => {
    const { src, result } = inferDemo();
    const t = typeOfBinding(src, result, 'q5');
    expect(t).toContain('author :: { name :: String }');
    expect(t).toContain('wordCount :: Number');
    // every PostRow column folded in:
    expect(t).toContain('id :: Number');
    expect(t).toContain('title :: String');
    expect(t).toContain('body :: String');
    expect(t).toContain('authorId :: Number');
  });

  // -------------------------------------------------------------------------
  // Realistic scenarios appended to the demo
  // -------------------------------------------------------------------------

  test('S1 postDetail — three levels of nested projection', () => {
    const { src, result } = inferDemo();
    expect(typeOfBinding(src, result, 'postDetail'))
      .toBe('Q { id :: Number, title :: String, body :: String, author :: { name :: String, email :: String }, comments :: [{ text :: String, author :: { name :: String } }] }');
  });

  test('S2 dashboard — Prop-only selector folds in every row column', () => {
    const { src, result } = inferDemo();
    const t = typeOfBinding(src, result, 'dashboard');
    expect(t).toContain('wordCount :: Number');
    expect(t).toContain('readingMinutes :: Number');
    expect(t).toContain('isPinned :: Boolean');
    expect(t).toContain('id :: Number');
    expect(t).toContain('title :: String');
    expect(t).toContain('body :: String');
    expect(t).toContain('authorId :: Number');
  });

  test('S3 firstPage — paginate preserves the inner projection', () => {
    const { src, result } = inferDemo();
    expect(typeOfBinding(src, result, 'firstPage'))
      .toBe('Q (Page { id :: Number, title :: String })');
  });

  test('S4 postIds — wrapper helper keeps the picked record at the call site', () => {
    const { src, result } = inferDemo();
    expect(typeOfBinding(src, result, 'postIds'))
      .toBe('Q { id :: Number }');
  });
});
