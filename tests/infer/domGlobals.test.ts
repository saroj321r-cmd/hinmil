// ============================================================================
// Typed DOM globals & Fetch API (registries/domGlobals.ts)
//
// `document`/`window`/`navigator`/`localStorage`/`sessionStorage` carry
// nominal types (Document, Window, …) with a compact method catalogue:
// members complete, hover and get return-type checking, while anything not
// catalogued silently resolves to `Any` (open-world fallback).  `fetch` is
// always typed `(u, o?) -> Promise e Response`, independent of the setting.
//
// Settings threading is exercised via `applyDomSettings` (the LSP server
// calls it on every settings (re)load):
//   • dom.globalTypes=false → globals revert to `Any`, DOM annotation type
//     names become unknown again.
//   • dom.strictNulls=true  → lookups that can miss return `T | Null`.
// ============================================================================

import { InferenceEngine } from '../../src/infer';
import { applyDomSettings } from '../../src/registries/methodRegistry';
import { getDotCompletions, CompletionContext } from '../../src/services/completion';

function msgs(src: string): string[] {
  return new InferenceEngine().infer(src).diagnostics.map(d => d.message);
}

function makeCtx(): CompletionContext {
  return {
    engine: new InferenceEngine(),
    createImportResolver: () => () => null,
    createTypeDirectiveResolver: () => () => null,
    inferFileAndCacheExports: () => null,
    inferredTypeStyle: 'pretty',
  };
}

// Every test must leave the shared registry/env in the default state.
afterEach(() => applyDomSettings({ globalTypes: true, strictNulls: false }));

describe('typed DOM globals', () => {
  test('member access and chaining are typed and clean', () => {
    expect(msgs(`
      const el = document.getElementById('root');
      el.focus();
      const t = el.textContent.toUpperCase();
      const kids = el.children.map(c => c.tagName);
      const w = el.getBoundingClientRect().width + 1;
      export const title = document.title.trim();
    `)).toEqual([]);
  });

  test('catalogue types are real — misuse errors', () => {
    expect(msgs(`const x = document.title.toFixed(1);`).join(' ')).toMatch(/toFixed/);
    expect(msgs(`const x = navigator.onLine.toUpperCase();`).join(' ')).toMatch(/toUpperCase/);
    expect(msgs(`const x = localStorage.getItem('k').toFixed(1);`).join(' ')).toMatch(/toFixed/);
  });

  test('property assignment is checked', () => {
    expect(msgs(`
      const el = document.getElementById('root');
      el.textContent = 'hi';
    `)).toEqual([]);
    expect(msgs(`
      const el = document.getElementById('root');
      el.textContent = 42;
    `).join(' ')).toMatch(/String.*Number|Number.*String/);
  });

  test('uncatalogued members silently resolve to Any (open-world fallback)', () => {
    expect(msgs(`
      const a = document.exotic.deeper(1, 2).x;
      const el = document.createElement('div');
      el.style.color = 'red';
      el.classList.add('active');
      const data = el.dataset.userId;
      export const clip = navigator.clipboard.writeText('hi');
    `)).toEqual([]);
  });

  test('window members: numbers, nested Document, Storage', () => {
    expect(msgs(`
      const w = window.innerWidth + window.scrollY;
      window.document.body.focus();
      window.localStorage.setItem('k', 'v');
      window.alert({ anything: true });
      const id = window.setTimeout(() => 1, 100);
      window.clearTimeout(id);
      export { w };
    `)).toEqual([]);
  });

  test('event listeners: Event members are typed', () => {
    expect(msgs(`
      document.addEventListener('click', (e) => e.clientX + e.clientY);
      window.addEventListener('keydown', (e) => e.key.toUpperCase());
      document.addEventListener('input', (e) => e.target.value.trim());
      window.addEventListener('resize', () => window.innerHeight);
    `)).toEqual([]);
    expect(msgs(`
      document.addEventListener('click', (e) => e.clientX.toUpperCase());
    `).join(' ')).toMatch(/toUpperCase/);
  });

  test('DOM type names are valid in annotations', () => {
    expect(msgs(`
      // focusIt :: Element -> Void
      const focusIt = (el) => el.focus();
      // onKey :: Event -> String
      const onKey = (e) => e.key;
      export { focusIt, onKey };
    `)).toEqual([]);
  });

  test('in-file method annotations extend a DOM type', () => {
    expect(msgs(`
      // Element#swipe :: Element ~> Number -> Boolean
      const el = document.createElement('div');
      export const b = el.swipe(3) && true;
    `)).toEqual([]);
  });
});

describe('fetch API (always on)', () => {
  test('fetch returns Promise e Response; Response members typed', () => {
    expect(msgs(`
      const p = fetch('/api/users').then(r => r.json());
      const q = fetch('/api', { method: 'POST', body: 'x' }).then(r => r.text());
      export { p, q };
    `)).toEqual([]);
    expect(msgs(`
      const bad = fetch('/x').then(r => r.status.toUpperCase());
    `).join(' ')).toMatch(/toUpperCase/);
  });

  test('await fetch in an async function', () => {
    expect(msgs(`
      const load = async () => {
        const r = await fetch('/api');
        if (!r.ok) return '';
        const body = await r.text();
        return body.trim();
      };
      export { load };
    `)).toEqual([]);
  });

  test('Response is a valid annotation type name', () => {
    expect(msgs(`
      // toStatus :: Response -> Number
      const toStatus = (r) => r.status;
      export { toStatus };
    `)).toEqual([]);
  });
});

describe('dom.strictNulls = true', () => {
  beforeEach(() => applyDomSettings({ strictNulls: true }));

  test('lookups that can miss return T | Null', () => {
    // Unguarded member access on `Element | Null` must error on the Null arm.
    const out = msgs(`
      const el = document.getElementById('root');
      el.focus();
    `).join(' ');
    expect(out).toMatch(/Null/);
    // Same for Storage#getItem: `String | Null`.
    expect(msgs(`
      const v = localStorage.getItem('k').toUpperCase();
    `).join(' ')).toMatch(/Null/);
  });

  test('always-present lookups stay clean', () => {
    expect(msgs(`
      const els = document.querySelectorAll('a').map(a => a.id);
      const fresh = document.createElement('div');
      fresh.focus();
      export { els };
    `)).toEqual([]);
  });
});

describe('dom.globalTypes = false (kill switch)', () => {
  beforeEach(() => applyDomSettings({ globalTypes: false }));

  test('globals revert to Any — everything is permitted', () => {
    expect(msgs(`
      const el = document.getElementById(42);
      el.textContent = 42;
      el.whatever.deep(1);
      window.anything();
      localStorage.bogus(true);
    `)).toEqual([]);
  });

  test('DOM type annotations remain usable (types stay registered)', () => {
    // The kill switch only reverts the GLOBALS to `Any`; the nominal types
    // themselves stay in the method registry, so existing `:: Element`
    // annotations keep working (and keep their catalogue methods).
    expect(msgs(`
      // focusIt :: Element -> Void
      const focusIt = (el) => el.focus();
      export { focusIt };
    `)).toEqual([]);
  });

  test('fetch stays typed', () => {
    expect(msgs(`
      const bad = fetch('/x').then(r => r.status.toUpperCase());
    `).join(' ')).toMatch(/toUpperCase/);
  });
});

describe('completion on typed globals', () => {
  test('document. lists the Document catalogue', () => {
    const source = 'document.';
    const dotIdx = source.indexOf('.');
    const items = getDotCompletions(source, dotIdx + 1, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('getElementById');
    expect(labels).toContain('querySelector');
    expect(labels).toContain('addEventListener');
  });

  test('localStorage. lists the Storage catalogue', () => {
    const source = 'localStorage.';
    const dotIdx = source.indexOf('.');
    const items = getDotCompletions(source, dotIdx + 1, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('getItem');
    expect(labels).toContain('setItem');
  });

  test('element method chain completes Element members', () => {
    const source = `const el = document.createElement('div');\nel.`;
    const dotIdx = source.lastIndexOf('.');
    const items = getDotCompletions(source, dotIdx + 1, dotIdx, 'file:///test.js', makeCtx());
    const labels = items.map(i => i.label);
    expect(labels).toContain('textContent');
    expect(labels).toContain('setAttribute');
  });
});
