// Coverage-gap tests for src/services/files.ts.
// Targets previously uncovered regions: package.json `exports` resolution
// (conditions, patterns, sugar forms), subpath fallback, single-name CJS
// require extraction, .hm wrapping/comment handling, sidecar cache eviction,
// unreadable-file logging, malformed package.json handling, hinmil.globals
// missing entries, companion package naming, inline package scans
// (overload merge, ::types .hm failures, ::extend-only files, cache
// eviction per package, index fallback entry) and the regex fallback of
// extractAllModuleSpecifiers.

import {
  resolveImportSpecifier,
  extractImportSpecifiers,
  clearHmSidecarCache,
  loadHmFile,
  wrapHmSource,
  parseHmSource,
  findHmSidecarPaths,
  findPackageJson,
  findPackageGlobalsPaths,
  hmCompanionPackageName,
  getBarePackageName,
  collectInlinePackageAnnotations,
  clearInlinePackageCache,
  clearInlinePackageCacheForPackage,
  extractAllModuleSpecifiers,
} from '../../src/services/files';
import { TempProject } from '../helpers/project';
import { pathToFileURL } from 'url';
import * as fs from 'fs';
import * as path from 'path';

const project = new TempProject('files-gaps');
beforeAll(() => project.setup());
afterAll(() => project.cleanup());

/** Collect warnings from the Logger parameter. */
function makeLogger(): { warnings: string[]; warn(msg: string): void } {
  const warnings: string[] = [];
  return { warnings, warn(msg: string) { warnings.push(msg); } };
}

// ---------------------------------------------------------------------------
// splitBareSpecifier via getBarePackageName (line 55)
// ---------------------------------------------------------------------------

describe('getBarePackageName — unscoped subpath', () => {
  it('splits an unscoped specifier with a subpath', () => {
    expect(getBarePackageName('lodash/fp')).toBe('lodash');
  });

  it('splits a deep unscoped subpath', () => {
    expect(getBarePackageName('rxjs/operators/map')).toBe('rxjs');
  });
});

// ---------------------------------------------------------------------------
// package.json `exports` field resolution (lines 65-82, 96-134, 174-177, 196-197)
// ---------------------------------------------------------------------------

describe('resolveImportSpecifier — package.json exports field', () => {
  let fromUri: string;

  beforeAll(() => {
    project.write('resolve/main.js', '// consumer\n');
    fromUri = pathToFileURL(project.pathOf('resolve/main.js')).href;
    const nm = 'resolve/node_modules';

    // Sugar string exports
    project.write(`${nm}/pkg-str/package.json`, JSON.stringify({ name: 'pkg-str', exports: './lib/entry.js' }));
    project.write(`${nm}/pkg-str/lib/entry.js`, 'module.exports = 1;\n');

    // Sugar condition map (no '.' keys)
    project.write(`${nm}/pkg-cond/package.json`, JSON.stringify({
      name: 'pkg-cond',
      exports: { import: './esm/i.mjs', require: './cjs/i.cjs' },
    }));
    project.write(`${nm}/pkg-cond/esm/i.mjs`, 'export default 1;\n');

    // Subpath keys with exact matches
    project.write(`${nm}/pkg-sub/package.json`, JSON.stringify({
      name: 'pkg-sub',
      exports: { '.': './main.js', './sub': './lib/sub.js' },
    }));
    project.write(`${nm}/pkg-sub/main.js`, 'module.exports = 1;\n');
    project.write(`${nm}/pkg-sub/lib/sub.js`, 'module.exports = 2;\n');

    // Pattern mapping
    project.write(`${nm}/pkg-pattern/package.json`, JSON.stringify({
      name: 'pkg-pattern',
      exports: { './*': './src/*.js' },
    }));
    project.write(`${nm}/pkg-pattern/src/util.js`, 'module.exports = 3;\n');

    // Array condition value: first entry unmatched object, second a string
    project.write(`${nm}/pkg-arr/package.json`, JSON.stringify({
      name: 'pkg-arr',
      exports: { '.': [{ browser: './b.js' }, './real.js'] },
    }));
    project.write(`${nm}/pkg-arr/real.js`, 'module.exports = 4;\n');

    // Array condition value where every entry fails → index fallback
    project.write(`${nm}/pkg-arrfail/package.json`, JSON.stringify({
      name: 'pkg-arrfail',
      exports: { '.': [{ browser: './b.js' }] },
    }));
    project.write(`${nm}/pkg-arrfail/index.js`, 'module.exports = 5;\n');

    // Non-string / non-object condition value → index fallback
    project.write(`${nm}/pkg-num/package.json`, JSON.stringify({
      name: 'pkg-num',
      exports: { '.': 42 },
    }));
    project.write(`${nm}/pkg-num/index.js`, 'module.exports = 6;\n');

    // Top-level array exports (rejected) → index fallback
    project.write(`${nm}/pkg-toparr/package.json`, JSON.stringify({
      name: 'pkg-toparr',
      exports: ['./a.js'],
    }));
    project.write(`${nm}/pkg-toparr/index.js`, 'module.exports = 7;\n');

    // No exports field at all → raw subpath fallback
    project.write(`${nm}/pkg-nosub/package.json`, JSON.stringify({ name: 'pkg-nosub' }));
    project.write(`${nm}/pkg-nosub/lib/util.js`, 'module.exports = 8;\n');
  });

  it('resolves sugar string exports for the package root', () => {
    const r = resolveImportSpecifier('pkg-str', fromUri);
    expect(r).not.toBeNull();
    expect(r).toContain('pkg-str/lib/entry.js');
  });

  it('returns null for a subpath when exports is a sugar string', () => {
    expect(resolveImportSpecifier('pkg-str/other', fromUri)).toBeNull();
  });

  it('resolves sugar condition-map exports via the import condition', () => {
    const r = resolveImportSpecifier('pkg-cond', fromUri);
    expect(r).not.toBeNull();
    expect(r).toContain('pkg-cond/esm/i.mjs');
  });

  it('returns null for a subpath when exports is a sugar condition map', () => {
    expect(resolveImportSpecifier('pkg-cond/x', fromUri)).toBeNull();
  });

  it('resolves an exact subpath key', () => {
    const r = resolveImportSpecifier('pkg-sub/sub', fromUri);
    expect(r).not.toBeNull();
    expect(r).toContain('pkg-sub/lib/sub.js');
  });

  it('resolves the "." subpath key for the package root', () => {
    const r = resolveImportSpecifier('pkg-sub', fromUri);
    expect(r).not.toBeNull();
    expect(r).toContain('pkg-sub/main.js');
  });

  it('resolves a pattern subpath key ("./*")', () => {
    const r = resolveImportSpecifier('pkg-pattern/util', fromUri);
    expect(r).not.toBeNull();
    expect(r).toContain('pkg-pattern/src/util.js');
  });

  it('resolves an array condition value by picking the first usable entry', () => {
    const r = resolveImportSpecifier('pkg-arr', fromUri);
    expect(r).not.toBeNull();
    expect(r).toContain('pkg-arr/real.js');
  });

  it('falls back to index.js when every array condition entry fails', () => {
    const r = resolveImportSpecifier('pkg-arrfail', fromUri);
    expect(r).not.toBeNull();
    expect(r).toContain('pkg-arrfail/index.js');
  });

  it('falls back to index.js when the condition value is a number', () => {
    const r = resolveImportSpecifier('pkg-num', fromUri);
    expect(r).not.toBeNull();
    expect(r).toContain('pkg-num/index.js');
  });

  it('falls back to index.js when top-level exports is an array', () => {
    const r = resolveImportSpecifier('pkg-toparr', fromUri);
    expect(r).not.toBeNull();
    expect(r).toContain('pkg-toparr/index.js');
  });

  it('resolves a subpath relative to the package root when exports is absent', () => {
    const r = resolveImportSpecifier('pkg-nosub/lib/util', fromUri);
    expect(r).not.toBeNull();
    expect(r).toContain('pkg-nosub/lib/util.js');
  });

  it('returns null for a subpath matching neither exact nor pattern keys', () => {
    expect(resolveImportSpecifier('pkg-sub/unknown', fromUri)).toBeNull();
  });

  it('returns null for a subpath that exists in no fallback', () => {
    expect(resolveImportSpecifier('pkg-nosub/does/not/exist', fromUri)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractImportSpecifiers — single-name CJS require (line 288)
// ---------------------------------------------------------------------------

describe('extractImportSpecifiers — single-name require', () => {
  it('extracts const Name = require(...)', () => {
    const result = extractImportSpecifiers("const Foo = require('./foo')");
    expect(result.get('Foo')).toBe('./foo');
  });
});

// ---------------------------------------------------------------------------
// wrapHmSource — comment handling (lines 722-731)
// ---------------------------------------------------------------------------

describe('wrapHmSource — comments', () => {
  it('blanks // comment lines while preserving length', () => {
    const wrapped = wrapHmSource('// just a comment\nmap :: a -> b');
    const lines = wrapped.split('\n');
    expect(lines[0]).toBe(' '.repeat('// just a comment'.length));
    expect(lines[1]).toBe('// map :: a -> b');
  });

  it('blanks multi-line block comments', () => {
    const src = [
      '/* block start',
      'inside the block',
      'end of block */',
      'id :: a -> a',
    ].join('\n');
    const lines = wrapHmSource(src).split('\n');
    expect(lines[0].trim()).toBe('');
    expect(lines[1].trim()).toBe('');
    expect(lines[2].trim()).toBe('');
    expect(lines[3]).toBe('// id :: a -> a');
    // length preserved for offsets
    expect(lines[1].length).toBe('inside the block'.length);
  });

  it('blanks single-line /* ... */ comments without entering block mode', () => {
    const src = '/* one liner */\nconst :: Number';
    const lines = wrapHmSource(src).split('\n');
    expect(lines[0].trim()).toBe('');
    expect(lines[1]).toBe('// const :: Number');
  });

  it('blanks JSDoc-style * continuation lines and keeps empty lines', () => {
    const src = ' * continuation\n\nfoo :: Number -> Number';
    const lines = wrapHmSource(src).split('\n');
    expect(lines[0].trim()).toBe('');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('// foo :: Number -> Number');
  });
});

// ---------------------------------------------------------------------------
// parseHmSource — repeated method annotation (line 762)
// ---------------------------------------------------------------------------

describe('parseHmSource — repeated method annotations', () => {
  it('last declaration wins for repeated Type#method names', () => {
    const src = [
      'Box#map :: (a -> b) -> Box b',
      'Box#map :: Number -> Box Number',
    ].join('\n');
    const exports = parseHmSource(src);
    expect(exports.has('Box#map')).toBe(true);
    // Not merged into an overload union — replaced by the second scheme.
    const scheme = exports.get('Box#map')!;
    expect(scheme.type.tag).toBe('TFun');
  });
});

// ---------------------------------------------------------------------------
// loadHmFile — read failure + cache, clearHmSidecarCache (lines 685, 807-809)
// ---------------------------------------------------------------------------

describe('loadHmFile — cache and failures', () => {
  it('warns and caches null when the file cannot be read', () => {
    clearHmSidecarCache();
    const logger = makeLogger();
    const missing = project.pathOf('does-not-exist/types.hm');
    expect(loadHmFile(missing, logger)).toBeNull();
    expect(logger.warnings.some(w => w.includes('Failed to read'))).toBe(true);
    // Second call served from cache — no extra warning.
    expect(loadHmFile(missing, logger)).toBeNull();
    expect(logger.warnings.length).toBe(1);
    clearHmSidecarCache();
  });

  it('a rewrite on disk is picked up without an explicit cache clear', () => {
    const p = project.write('cachetest/types.hm', 'alpha :: Number -> Number\n');
    clearHmSidecarCache();
    expect(loadHmFile(p)!.has('alpha')).toBe(true);
    // The cache stamps entries by mtime+size, so a rewrite is detected
    // on the next load — no clearHmSidecarCache needed.
    const future = new Date(Date.now() + 5000);
    fs.writeFileSync(p, 'beta :: String -> String\n');
    fs.utimesSync(p, future, future);
    const fresh = loadHmFile(p)!;
    expect(fresh.has('beta')).toBe(true);
    expect(fresh.has('alpha')).toBe(false);
    clearHmSidecarCache();
  });
});

// ---------------------------------------------------------------------------
// findHmSidecarPaths / findPackageJson — malformed package.json (946, 976)
// ---------------------------------------------------------------------------

describe('malformed package.json handling', () => {
  it('findHmSidecarPaths returns [] for malformed package.json', () => {
    project.write('malformed/package.json', '{ this is not json');
    const entry = project.write('malformed/entry.js', 'module.exports = 1;\n');
    expect(findHmSidecarPaths(entry)).toEqual([]);
  });

  it('findPackageJson returns null for malformed package.json', () => {
    project.write('malformed2/package.json', 'not json at all {{');
    const entry = project.write('malformed2/entry.js', 'module.exports = 1;\n');
    expect(findPackageJson(entry)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findPackageGlobalsPaths — missing globals entry (line 1008)
// ---------------------------------------------------------------------------

describe('findPackageGlobalsPaths — missing entries', () => {
  it('warns and skips globals entries that do not exist', () => {
    project.write('globalspkg/package.json', JSON.stringify({
      name: 'globalspkg',
      'hinmil': { globals: ['./missing-globals.hm'] },
    }));
    const entry = project.write('globalspkg/index.js', 'module.exports = 1;\n');
    const logger = makeLogger();
    expect(findPackageGlobalsPaths(entry, logger)).toEqual([]);
    expect(logger.warnings.some(w => w.includes('does not exist'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hmCompanionPackageName — scoped packages (line 1059)
// ---------------------------------------------------------------------------

describe('hmCompanionPackageName', () => {
  it('maps scoped packages to @hm/scope__pkg', () => {
    expect(hmCompanionPackageName('@scope/pkg')).toBe('@hm/scope__pkg');
  });

  it('maps unscoped packages to @hm/pkg', () => {
    expect(hmCompanionPackageName('lodash')).toBe('@hm/lodash');
  });
});

// ---------------------------------------------------------------------------
// extractAllModuleSpecifiers — regex fallback (lines 1169, 1171)
// ---------------------------------------------------------------------------

describe('extractAllModuleSpecifiers — regex fallback', () => {
  it('falls back to regex extraction when the source does not parse', () => {
    const src = [
      "import { a } from './alpha'",
      'const %% = broken syntax here',
      "require('./beta')",
    ].join('\n');
    const specs = extractAllModuleSpecifiers(src);
    expect(specs).toContain('./alpha');
    expect(specs).toContain('./beta');
  });
});

// ---------------------------------------------------------------------------
// collectInlinePackageAnnotations — inline scans
// (lines 1124-1126, 1203, 1262-1263, 1284-1285, 1295, 1316)
// ---------------------------------------------------------------------------

describe('collectInlinePackageAnnotations', () => {
  // chmod-000 files are still readable when running as root — skip there.
  const itNonRoot = typeof process.getuid === 'function' && process.getuid() === 0 ? it.skip : it;

  beforeEach(() => clearInlinePackageCache());
  afterEach(() => clearInlinePackageCache());

  it('merges repeated top-level annotations across files into an overload', () => {
    project.write('inline-overload/package.json', JSON.stringify({ name: 'inline-overload', main: './index.js' }));
    const entry = project.write('inline-overload/index.js', [
      "export { dup } from './extra';",
      '// dup :: Number -> Number',
      'export const dupLocal = x => x;',
    ].join('\n'));
    project.write('inline-overload/extra.js', [
      '// dup :: String -> String',
      'export const dup = x => x;',
    ].join('\n'));
    const scan = collectInlinePackageAnnotations(entry);
    expect(scan).not.toBeNull();
    const dup = scan!.exports.get('dup');
    expect(dup).toBeDefined();
    // Two same-name annotations merged into an overloaded (union) scheme.
    expect(dup!.type.tag).toBe('TCon');
  });

  itNonRoot('warns and continues when a ::types .hm target cannot be read', () => {
    project.write('inline-hmfail/package.json', JSON.stringify({ name: 'inline-hmfail', main: './index.js' }));
    const entry = project.write('inline-hmfail/index.js', [
      '// ::types ./unreadable.hm',
      '// good :: Number -> Number',
      'export const good = x => x;',
    ].join('\n'));
    const hmPath = project.write('inline-hmfail/unreadable.hm', 'hidden :: Number -> Number\n');
    fs.chmodSync(hmPath, 0o000);

    try {
      const logger = makeLogger();
      const scan = collectInlinePackageAnnotations(entry, logger);
      expect(scan).not.toBeNull();
      expect(scan!.exports.has('good')).toBe(true);
      expect(scan!.exports.has('hidden')).toBe(false);
      expect(logger.warnings.some(w => w.includes('inline scan failed to read') && w.includes('unreadable.hm'))).toBe(true);
    } finally {
      fs.chmodSync(hmPath, 0o644);
    }
  });

  itNonRoot('warns and continues when an imported JS file cannot be read', () => {
    project.write('inline-jsfail/package.json', JSON.stringify({ name: 'inline-jsfail', main: './index.js' }));
    const entry = project.write('inline-jsfail/index.js', [
      "import './unreadable-mod';",
      '// ok :: Number -> Number',
      'export const ok = x => x;',
    ].join('\n'));
    const modPath = project.write('inline-jsfail/unreadable-mod.js', '// secret :: Number -> Number\n');
    fs.chmodSync(modPath, 0o000);

    try {
      const logger = makeLogger();
      const scan = collectInlinePackageAnnotations(entry, logger);
      expect(scan).not.toBeNull();
      expect(scan!.exports.has('ok')).toBe(true);
      expect(scan!.exports.has('secret')).toBe(false);
      expect(logger.warnings.some(w => w.includes('inline scan failed to read') && w.includes('unreadable-mod'))).toBe(true);
    } finally {
      fs.chmodSync(modPath, 0o644);
    }
  });

  it('treats a file with only ::extend directives as annotated', () => {
    project.write('inline-extend/package.json', JSON.stringify({ name: 'inline-extend', main: './index.js' }));
    const entry = project.write('inline-extend/index.js', [
      '// ::extend Selector Table Row | Picked Row a',
      'export const nothing = 1;',
    ].join('\n'));
    const scan = collectInlinePackageAnnotations(entry);
    expect(scan).not.toBeNull();
    expect(scan!.exports.size).toBe(0);
    expect(scan!.methodSource).toContain('::extend Selector');
  });

  it('falls back to index.js when a .hm entry has no main/module', () => {
    project.write('inline-hmentry/package.json', JSON.stringify({ name: 'inline-hmentry' }));
    project.write('inline-hmentry/index.js', [
      '// hi :: Number -> Number',
      'export const hi = x => x;',
    ].join('\n'));
    const hmPath = project.write('inline-hmentry/types.hm', 'sidecarOnly :: Number -> Number\n');
    const scan = collectInlinePackageAnnotations(hmPath);
    expect(scan).not.toBeNull();
    expect(scan!.exports.has('hi')).toBe(true);
    expect(scan!.visitedFiles.some(f => f.endsWith('index.js'))).toBe(true);
  });

  it('clearInlinePackageCacheForPackage evicts only the targeted package', () => {
    project.write('inline-evict-a/package.json', JSON.stringify({ name: 'inline-evict-a', main: './index.js' }));
    const entryA = project.write('inline-evict-a/index.js', '// aOne :: Number -> Number\nexport const aOne = x => x;\n');
    project.write('inline-evict-b/package.json', JSON.stringify({ name: 'inline-evict-b', main: './index.js' }));
    const entryB = project.write('inline-evict-b/index.js', '// bOne :: Number -> Number\nexport const bOne = x => x;\n');

    // Prime both caches.
    expect(collectInlinePackageAnnotations(entryA)!.exports.has('aOne')).toBe(true);
    expect(collectInlinePackageAnnotations(entryB)!.exports.has('bOne')).toBe(true);

    // Change both files on disk.
    fs.writeFileSync(entryA, '// aTwo :: String -> String\nexport const aTwo = x => x;\n');
    fs.writeFileSync(entryB, '// bTwo :: String -> String\nexport const bTwo = x => x;\n');

    // Evict only package A.
    clearInlinePackageCacheForPackage(project.pathOf('inline-evict-a'));

    // A re-scans (sees the new annotation), B is still served from cache.
    expect(collectInlinePackageAnnotations(entryA)!.exports.has('aTwo')).toBe(true);
    const scanB = collectInlinePackageAnnotations(entryB)!;
    expect(scanB.exports.has('bOne')).toBe(true);
    expect(scanB.exports.has('bTwo')).toBe(false);
  });
});
