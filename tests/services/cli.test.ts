import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../src/cli';

describe('hinmil CLI', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hinmil-cli-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relativePath: string, source: string): string => {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
    return filePath;
  };

  const invoke = (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = runCli(args, {
      cwd: root,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    });
    return { code, stdout, stderr };
  };

  test('returns zero for a clean configured project', () => {
    write('hinmil.config.json', JSON.stringify({
      settings: { diagnostics: { missingSignatures: 'off' } },
    }));
    write('main.js', '// identity :: a -> a\nconst identity = value => value;\n');

    const result = invoke(['--format', 'json']);
    const output = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(output.checkedFiles).toHaveLength(1);
    expect(output.diagnostics).toEqual([]);
  });

  test('returns one and emits locations for error diagnostics', () => {
    write('main.js', '// value :: Number\nconst value = "wrong";\n');

    const result = invoke(['.']);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/main\.js:\d+:\d+ error HM\d+/);
  });

  test('package.json configuration takes precedence over standalone config', () => {
    write('package.json', JSON.stringify({
      'hinmil': { settings: { diagnostics: { missingSignatures: 'off' } } },
    }));
    write('hinmil.config.json', JSON.stringify({
      settings: { diagnostics: { missingSignatures: 'error' } },
    }));
    write('main.js', 'const identity = value => value;\n');

    const result = invoke(['--format', 'json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).diagnostics).toEqual([]);
  });

  test('reports malformed explicit configuration as a CLI failure', () => {
    write('broken.json', '{ nope');
    write('main.js', 'const value = 1;\n');

    const result = invoke(['--config', 'broken.json']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Invalid config');
  });

  test('loads selection before discovery and filters explicit paths', () => {
    write('hinmil.config.json', JSON.stringify({
      files: { include: ['src/**'], exclude: ['**/*.skip.js'] },
      settings: { diagnostics: { missingSignatures: 'off' } },
    }));
    write('src/main.js', '// value :: Number\nconst value = 1;\n');
    write('src/no.skip.js', '// value :: Number\nconst value = "bad";\n');
    write('outside.js', '// value :: Number\nconst value = "bad";\n');

    const result = invoke(['src', 'outside.js', '--format', 'json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).checkedFiles.map((file: string) => path.relative(root, file)))
      .toEqual(['src/main.js']);
  });

  test('discovers .mjs and .cjs by default', () => {
    write('hinmil.config.json', JSON.stringify({ settings: { diagnostics: { missingSignatures: 'off' } } }));
    write('module.mjs', '// esm :: Number\nexport const esm = 1;\n');
    write('module.cjs', '// commonjs :: Number\nconst commonjs = 1;\n');
    const output = JSON.parse(invoke(['--format', 'json']).stdout);
    expect(output.checkedFiles.map((file: string) => path.basename(file)).sort())
      .toEqual(['module.cjs', 'module.mjs']);
  });

  test('--ext is repeatable and additive', () => {
    write('hinmil.config.json', JSON.stringify({ settings: { diagnostics: { missingSignatures: 'off' } } }));
    write('main.js', '// value :: Number\nconst value = 1;\n');
    write('other.foo', '// other :: Number\nconst other = 1;\n');
    write('another.bar', '// another :: Number\nconst another = 1;\n');
    const output = JSON.parse(invoke(['--ext', 'foo', '--ext', '.bar', '--format', 'json']).stdout);
    expect(output.checkedFiles.map((file: string) => path.extname(file)).sort())
      .toEqual(['.bar', '.foo', '.js']);
  });

  test('custom extensions keep JavaScript import inference working', () => {
    write('hinmil.config.json', JSON.stringify({
      files: { extensions: ['.custom'] },
      settings: { diagnostics: { missingSignatures: 'off' } },
    }));
    write('value.custom', 'export const value = 1;\n');
    write('main.custom', "import { value } from './value';\n// result :: Number\nconst result = value;\n");
    const result = invoke(['--format', 'json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).diagnostics).toEqual([]);
  });

  test('an excluded dependency remains inferable', () => {
    write('hinmil.config.json', JSON.stringify({
      files: { exclude: ['lib/**'] },
      settings: { diagnostics: { missingSignatures: 'off' } },
    }));
    write('lib/value.js', 'export const value = 1;\n');
    write('main.js', "import { value } from './lib/value.js';\n// result :: Number\nconst result = value;\n");
    const result = invoke(['--format', 'json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).checkedFiles).toEqual([path.join(root, 'main.js')]);
  });

  test('checks imports with configured globals', () => {
    write('hinmil.config.json', JSON.stringify({
      globals: ['globals.hm'],
      settings: { diagnostics: { missingSignatures: 'off' } },
    }));
    write('globals.hm', 'answer :: Number\n');
    write('lib.js', 'export const double = value => value * 2;\n');
    write('main.js', "import { double } from './lib.js';\n// value :: Number\nconst value = double(answer);\n");

    const result = invoke(['main.js', '--format', 'json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).diagnostics).toEqual([]);
  });

  test('discovery survives symlink cycles and ignores links escaping the root', () => {
    write('hinmil.config.json', JSON.stringify({ settings: { diagnostics: { missingSignatures: 'off' } } }));
    write('src/main.js', '// value :: Number\nconst value = 1;\n');
    // Cycle: src/loop -> src (would recurse forever without realpath tracking).
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'src', 'loop'));
    // Escape: a link pointing outside the project root must not be traversed.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hinmil-outside-'));
    fs.writeFileSync(path.join(outside, 'external.js'), '// value :: Number\nconst value = "bad";\n');
    fs.symlinkSync(outside, path.join(root, 'external'));
    // Broken link: must be skipped, not fatal.
    fs.symlinkSync(path.join(root, 'missing.js'), path.join(root, 'dangling.js'));
    try {
      const result = invoke(['--format', 'json']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).checkedFiles).toEqual([path.join(root, 'src', 'main.js')]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('an explicitly empty include selects zero files', () => {
    write('hinmil.config.json', JSON.stringify({
      files: { include: [] },
      settings: { diagnostics: { missingSignatures: 'off' } },
    }));
    write('main.js', '// value :: Number\nconst value = 1;\n');
    const result = invoke(['--format', 'json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).checkedFiles).toEqual([]);
  });
});
