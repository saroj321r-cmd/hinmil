// Tests for the bundled `jest.hm` globals file: free-function globals
// (`describe`, `test`, lifecycle hooks) and the typed `expect(...)`
// matcher surface.  Loaded via `engine.globalsSource`, these must be
// visible in every inferred file WITHOUT an import, and misuse must be
// reported like any other call.

import * as fs from 'fs';
import * as path from 'path';
import { InferenceEngine } from '../../src/infer';
import { wrapHmSource } from '../../src/services/files';

const JEST_HM = wrapHmSource(
  fs.readFileSync(path.join(__dirname, '..', '..', 'sample', 'jest.hm'), 'utf-8'),
);

function infer(source: string) {
  const eng = new InferenceEngine();
  eng.globalsSource = JEST_HM;
  return eng.infer(source);
}

describe('jest.hm globals', () => {
  it('types describe/test/expect in a spec file with no import and no diagnostics', () => {
    const src = [
      "describe('math', () => {",
      "  test('adds', () => {",
      '    expect(1 + 1).toBe(2);',
      '  });',
      "  it('compares strings', () => {",
      "    expect('a').toEqual('a');",
      '  });',
      '});',
    ].join('\n');
    const result = infer(src);
    expect(result.diagnostics).toEqual([]);
  });

  it('types lifecycle hooks and negated matchers', () => {
    const src = [
      "describe('suite', () => {",
      '  beforeEach(() => {});',
      '  afterAll(() => {});',
      "  test('not', () => {",
      '    expect(3).not.toBe(4);',
      '    expect([1, 2, 3]).toHaveLength(3);',
      '  });',
      '});',
    ].join('\n');
    const result = infer(src);
    expect(result.diagnostics).toEqual([]);
  });

  it('reports a diagnostic when describe is given a non-String title', () => {
    const src = [
      'describe(123, () => {});',
    ].join('\n');
    const result = infer(src);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('reports a diagnostic when a matcher receives a non-Number where Number is required', () => {
    const src = [
      "test('mismatch', () => {",
      "  expect([1, 2]).toHaveLength('two');",
      '});',
    ].join('\n');
    const result = infer(src);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('does NOT define jest globals when jest.hm is not loaded', () => {
    const eng = new InferenceEngine();
    const result = eng.infer("describe('x', () => {});");
    const unbound = result.diagnostics.filter((d) => /Unbound variable: 'describe'/.test(d.message));
    expect(unbound.length).toBeGreaterThan(0);
  });

  it('types the async `resolves` / `rejects` matcher surfaces (awaitable)', () => {
    // Realistic fl-law spec idiom: fork a task to a promise and assert
    // through the async matcher chain.
    const src = [
      "test('resolves and rejects', async () => {",
      '  await expect (Promise.resolve (3)).resolves.toBe (3);',
      "  await expect (Promise.reject ('nope')).rejects.toBe ('nope');",
      '  await expect (Promise.resolve ([1, 2, 3])).resolves.toEqual ([1, 2, 3]);',
      '  await expect (Promise.resolve ([1, 2])).resolves.toHaveLength (2);',
      '  await expect (Promise.resolve (1)).resolves.not.toBe (2);',
      '});',
    ].join('\n');
    const result = infer(src);
    expect(result.diagnostics).toEqual([]);
  });

  it('reports a diagnostic for an unknown matcher behind `resolves`', () => {
    const src = [
      "test('typo', async () => {",
      '  await expect (Promise.resolve (3)).resolves.toBee (3);',
      '});',
    ].join('\n');
    const result = infer(src);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
