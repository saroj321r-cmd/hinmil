// ============================================================================
// Redux samples — classic redux, @reduxjs/toolkit and react-redux, typed
// through user-supplied `.hm` files (sample/hm-types/*).  Mirrors the
// sample project wiring: conventional stubs for `redux` / `react-redux`,
// an explicit override for the scoped `@reduxjs/toolkit`, and React from
// the bundled builtin typings merged with sample/react.hm.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { TempProject } from '../helpers/project';

const sampleDir = path.join(__dirname, '../../sample');

describe('redux samples', () => {
  const project = new TempProject('redux-samples', {
    overrides: {
      react: './react.hm',
      '@reduxjs/toolkit': './hm-types/reduxjs-toolkit.hm',
    },
  });

  beforeAll(() => {
    project.setup();
    project.write('react.hm', fs.readFileSync(path.join(sampleDir, 'react.hm'), 'utf8'));
    for (const f of fs.readdirSync(path.join(sampleDir, 'hm-types'))) {
      project.write(`hm-types/${f}`, fs.readFileSync(path.join(sampleDir, 'hm-types', f), 'utf8'));
    }
    for (const f of fs.readdirSync(path.join(sampleDir, 'redux'))) {
      project.write(f, fs.readFileSync(path.join(sampleDir, 'redux', f), 'utf8'));
    }
  });
  afterAll(() => project.cleanup());

  test.each(['store.js', 'toolkitStore.js', 'CounterApp.jsx'])(
    'sample %s is diagnostic-free',
    (file) => {
      const r = project.inferFile(file);
      expect(r.diagnostics.map(d => d.message)).toEqual([]);
    },
  );

  test('browser.js sample is diagnostic-free', () => {
    const src = fs.readFileSync(path.join(sampleDir, 'browser.js'), 'utf8');
    const r = project.inferSource('browser.js', src);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('the store state type flows out of the reducer', () => {
    const r = project.inferSource('typed.js', `
      import { store } from './store';
      export const bad = store.getState().toUpperCase();
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/toUpperCase/);
  });

  test('dispatch checks the reducer action shape', () => {
    const r = project.inferSource('dispatch.js', `
      import { store } from './store';
      store.dispatch({ type: 42 });
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});
