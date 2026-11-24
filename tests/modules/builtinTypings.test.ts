// ============================================================================
// Bundled builtin typings (`hm-types-builtin/`) — zero-config React.
//
// The extension ships `.hm` typings for react and react-dom.  They form the
// weakest layer of import resolution: project overrides and conventional
// `hm-types/<pkg>.hm` stubs merge ON TOP of them per export name.  Because
// the bundled catalogue may lag behind the installed package version, maps
// backed by a builtin layer are open-world: unknown names bind to `Any`
// instead of producing an "is not exported" diagnostic.
//
// Browser globals (document, window, navigator, localStorage,
// sessionStorage) are covered here too — typed via the compact DOM
// catalogue (registries/domGlobals.ts); uncatalogued members fall back to
// `Any`.  Full coverage lives in tests/infer/domGlobals.test.ts.
// ============================================================================

import { TempProject } from '../helpers/project';

describe('builtin typings', () => {
  const project = new TempProject('builtin-typings');

  beforeAll(() => project.setup());
  afterAll(() => project.cleanup());

  describe('zero-config resolution', () => {
    test('react hooks resolve without any project config', () => {
      const r = project.inferSource('app.js', `
        import { useState, useEffect, useMemo } from 'react';
        export const useCounter = () => {
          const [n, setN] = useState(0);
          const double = useMemo(() => n * 2, [n]);
          useEffect(() => { setN(double); }, [double]);
          return n;
        };
      `);
      expect(r.diagnostics.map(d => d.message)).toEqual([]);
    });

    test('builtin signatures are real types (misuse still errors)', () => {
      const r = project.inferSource('bad.js', `
        import { useState } from 'react';
        const [n] = useState(0);
        export const s = n.toUpperCase();
      `);
      expect(r.diagnostics.length).toBeGreaterThan(0);
      expect(r.diagnostics[0].message).toMatch(/toUpperCase/);
    });

    test('react-dom/client createRoot flows through render', () => {
      const r = project.inferSource('main.js', `
        import { createElement } from 'react';
        import { createRoot } from 'react-dom/client';
        const root = createRoot(document.getElementById('root'));
        root.render(createElement('div', null, 'hi'));
        export { root };
      `);
      expect(r.diagnostics.map(d => d.message)).toEqual([]);
    });

    test('render returns Void — using it as a value errors', () => {
      const r = project.inferSource('main.js', `
        import { createRoot } from 'react-dom/client';
        const root = createRoot(document.body);
        export const n = root.render(1) + 1;
      `);
      expect(r.diagnostics.length).toBeGreaterThan(0);
    });
  });

  describe('open-world exports', () => {
    test('unknown named import from a builtin-backed package binds Any', () => {
      const r = project.inferSource('unknown.js', `
        import { someFutureHook } from 'react';
        export const y = someFutureHook(1) + 2;
      `);
      expect(r.diagnostics.map(d => d.message)).toEqual([]);
    });

    test('default import from a builtin-backed package binds Any', () => {
      const r = project.inferSource('default.js', `
        import React from 'react';
        export const z = React.anything(1);
      `);
      expect(r.diagnostics.map(d => d.message)).toEqual([]);
    });

    test('plain overrides without builtin stay closed-world', () => {
      const closed = new TempProject('builtin-closed-world');
      closed.setup();
      closed.write('hm-types/somelib.hm', 'f :: String -> String\n');
      const r = closed.inferSource('t.js', `
        import { g } from 'somelib';
        export const a = g;
      `);
      closed.cleanup();
      expect(r.diagnostics.length).toBeGreaterThan(0);
      expect(r.diagnostics[0].message).toMatch(/'g' is not exported from 'somelib'/);
    });
  });

  describe('merge with project layers', () => {
    const merged = new TempProject('builtin-merge');

    beforeAll(() => {
      merged.setup();
      merged.write('hm-types/react.hm', 'useState :: String -> String\nuseMagic :: Number -> Number\n');
    });
    afterAll(() => merged.cleanup());

    test('project entries win, builtin fills the rest', () => {
      const r = merged.inferSource('merge.js', `
        import { useState, useMagic, useEffect } from 'react';
        export const s = useState('hi').toUpperCase();
        export const m = useMagic(1) + 1;
        useEffect(() => {}, []);
      `);
      expect(r.diagnostics.map(d => d.message)).toEqual([]);
    });

    test('the project signature is authoritative on collision', () => {
      // Project says useState returns String; builtin says [value, setter].
      const r = merged.inferSource('collide.js', `
        import { useState } from 'react';
        export const a = useState('x').toFixed(2);
      `);
      expect(r.diagnostics.length).toBeGreaterThan(0);
      expect(r.diagnostics[0].message).toMatch(/toFixed/);
    });
  });

  describe('browser globals', () => {
    test('document/window/localStorage are typed and usable out of the box', () => {
      const r = project.inferSource('browser.js', `
        const el = document.getElementById('app');
        el.textContent = 'hi';
        window.addEventListener('resize', () => window.innerWidth);
        localStorage.setItem('theme', 'dark');
        sessionStorage.clear();
        export const online = navigator.onLine;
      `);
      expect(r.diagnostics.map(d => d.message)).toEqual([]);
    });

    test('local bindings shadow globals with strict checking', () => {
      const r = project.inferSource('shadow.js', `
        const document = { title: 'mine' };
        export const x = document.body;
      `);
      expect(r.diagnostics.length).toBeGreaterThan(0);
      expect(r.diagnostics[0].message).toMatch(/body/);
    });
  });
});
