// Friendlier signature help for callback arguments.
//
// Optional-callback method slots are `((String, String) -> Number) | Undefined`.
// While the user builds the callback:
//  - Level 2: when the cursor is INSIDE the callback's own parentheses, the
//    popup shows the EXPECTED CALLBACK signature `(String, String) -> Number`
//    with the active callback parameter highlighted (the `| Undefined` is
//    dropped, and it no longer collapses to a bare `a`).
//  - Level 1: at the enclosing call's argument level, a function slot whose
//    in-progress argument does not yet parse as a function shows the narrowed
//    function SHAPE instead of a meaningless variable.
//  - An empty slot still shows the full `| Undefined` union (callback optional).

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import { provideSignatureHelp } from '../../src/services/signatureHelp';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

function sig(src: string, offset: number): { labels: string[]; activeParam: number | undefined } {
  const help = provideSignatureHelp({
    source: src, offset, engine,
    resolver: () => null,
    typeResolver: () => null,
    reinferWithArrayASI: () => null,
  });
  return {
    labels: help ? help.signatures.map(s => s.label) : [],
    activeParam: help?.activeParameter,
  };
}

const SORT_UNION_LABEL = '.sort(((String, String) -> Number) | Undefined) -> [String]';
const SORT_CALLBACK = '(String, String) -> Number';

describe('Level 2 — callback signature help inside the callback parens', () => {
  test('empty callback parens `sort(())` shows the comparator, param 0', () => {
    const src = `const obj = {}; const r = Object.keys(obj).sort(())`;
    const cursor = src.indexOf('sort((') + 'sort(('.length; // between (( and ))
    const { labels, activeParam } = sig(src, cursor);
    expect(labels).toEqual([SORT_CALLBACK]);
    expect(activeParam).toBe(0);
  });

  test('`sort((a))` highlights the first comparator parameter', () => {
    const src = `const obj = {}; const r = Object.keys(obj).sort((a))`;
    const cursor = src.indexOf('((a)') + 3; // just after `a`
    const { labels, activeParam } = sig(src, cursor);
    expect(labels).toEqual([SORT_CALLBACK]);
    expect(activeParam).toBe(0);
  });

  test('`sort((a, b))` highlights the second comparator parameter', () => {
    const src = `const obj = {}; const r = Object.keys(obj).sort((a, b))`;
    const cursor = src.indexOf('(a, b)') + '(a, b'.length; // just after `b`
    const { labels, activeParam } = sig(src, cursor);
    expect(labels).toEqual([SORT_CALLBACK]);
    expect(activeParam).toBe(1);
  });

  test('not sort-specific — `map((a, b))` shows the map callback shape', () => {
    const src = `const obj = {}; const r = Object.keys(obj).map((a, b))`;
    const cursor = src.indexOf('(a, b)') + '(a, b'.length; // just after `b`
    const { labels, activeParam } = sig(src, cursor);
    expect(labels.length).toBe(1);
    expect(labels[0]).toMatch(/^\(String, Number, \[String\]\) -> /);
    expect(activeParam).toBe(1);
  });
});

describe('Level 1 — narrowed function shape at the call argument level', () => {
  test('`sort((a, b))` with the cursor OUTSIDE the inner parens drops `| Undefined`', () => {
    const src = `const obj = {}; const r = Object.keys(obj).sort((a, b))`;
    // cursor between the inner ')' and the outer ')': at the call arg level.
    const cursor = src.indexOf('(a, b)') + '(a, b)'.length;
    const { labels } = sig(src, cursor);
    expect(labels).toEqual(['.sort((String, String) -> Number) -> [String]']);
  });
});

describe('empty and complete slots are unchanged', () => {
  test('empty slot keeps the optional `| Undefined` union', () => {
    const src = `const obj = {}; const r = Object.keys(obj).sort()`;
    const cursor = src.indexOf('sort(') + 'sort('.length;
    expect(sig(src, cursor).labels).toEqual([SORT_UNION_LABEL]);
  });

  test('a real call paren directly before the cursor is unaffected', () => {
    const src = `const obj = {}; const r = Object.keys(obj).sort(`;
    const cursor = src.length;
    expect(sig(src, cursor).labels).toEqual([SORT_UNION_LABEL]);
  });
});
