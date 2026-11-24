import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { isFile, isDir, readJsonCached, clearFsProbeCache } from '../../src/services/fsProbe';
import { resolveImportSpecifier } from '../../src/services/files';

describe('fsProbe — memoised resolution probes', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-fsprobe-'));
    clearFsProbeCache();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    clearFsProbeCache();
  });

  test('distinguishes files, directories and missing paths without throwing', () => {
    const f = path.join(dir, 'a.js');
    fs.writeFileSync(f, '');
    expect(isFile(f)).toBe(true);
    expect(isDir(f)).toBe(false);
    expect(isDir(dir)).toBe(true);
    expect(isFile(dir)).toBe(false);
    expect(isFile(path.join(dir, 'missing.js'))).toBe(false);
    expect(isFile(path.join(f, 'below-a-file.js'))).toBe(false); // ENOTDIR
  });

  test('answers are cached until clearFsProbeCache (LSP clears on watched-file events)', () => {
    const f = path.join(dir, 'late.js');
    expect(isFile(f)).toBe(false);
    fs.writeFileSync(f, '');
    expect(isFile(f)).toBe(false); // stale by design within one snapshot
    clearFsProbeCache();
    expect(isFile(f)).toBe(true);
  });

  test('readJsonCached: undefined when missing, null when malformed', () => {
    const missing = path.join(dir, 'package.json');
    expect(readJsonCached(missing)).toBeUndefined();
    clearFsProbeCache();
    fs.writeFileSync(missing, '{ not json');
    expect(readJsonCached(missing)).toBeNull();
    clearFsProbeCache();
    fs.writeFileSync(missing, '{ "name": "x" }');
    expect(readJsonCached(missing)).toEqual({ name: 'x' });
  });

  test('module resolution sees a file created after a cache clear', () => {
    const from = pathToFileURL(path.join(dir, 'main.js')).href;
    expect(resolveImportSpecifier('./dep', from)).toBeNull();
    fs.writeFileSync(path.join(dir, 'dep.js'), 'module.exports = 1;');
    clearFsProbeCache();
    expect(resolveImportSpecifier('./dep', from)).toBe(pathToFileURL(path.join(dir, 'dep.js')).href);
  });
});
