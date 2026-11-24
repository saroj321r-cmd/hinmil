// ============================================================================
// Asset imports — bundler-managed non-JS files (Vite/webpack style).
//
// `import heroImg from './hero.png'` and side-effect imports like
// `import './App.css'` are resolved by the bundler, not by inference.
// The resolver treats them as untyped modules: imported names bind to the
// opaque `Any` type, and no "Cannot resolve module" / "Unbound variable"
// diagnostics are emitted.  Genuinely missing files still error.
// ============================================================================

import { TempProject } from '../helpers/project';

describe('asset imports', () => {
  const project = new TempProject('asset-imports');

  beforeAll(() => {
    project.setup();
    project.write('assets/hero.png', 'not-a-real-png');
    project.write('assets/react.svg', '<svg></svg>');
    project.write('App.css', 'body {}');
  });
  afterAll(() => project.cleanup());

  test('default imports of existing assets bind to Any (no diagnostics)', () => {
    const r = project.inferSource('App.jsx', `
      import heroImg from './assets/hero.png'
      import reactLogo from './assets/react.svg'
      import './App.css'
      const el = <img src={heroImg} alt="" />;
      const el2 = <img src={reactLogo} alt="" />;
      export default el;
    `);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('bundler query suffixes are handled (?url)', () => {
    const r = project.inferSource('App.js', `
      import heroUrl from './assets/hero.png?url'
      const s = heroUrl;
    `);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('a missing asset still reports Cannot resolve module', () => {
    const r = project.inferSource('App.js', `
      import gone from './assets/missing.png'
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/Cannot resolve module '\.\/assets\/missing\.png'/);
  });

  test('a missing JS module still reports Cannot resolve module', () => {
    const r = project.inferSource('App.js', `
      import x from './does-not-exist.js'
    `);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics[0].message).toMatch(/Cannot resolve module/);
  });
});
