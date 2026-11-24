// ============================================================================
// The command-line checker: options, output formats and exit statuses.
// Exit status contract (README "Command-Line Checker"): 0 without error
// diagnostics, 1 with errors, 2 for argument, configuration and input failures.
// ============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../src/cli';

const pkg = require('../../package.json') as { version: string };

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hinmil-cli-options-')));
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

const invoke = (args: string[], cwd = root) => {
  let stdout = '';
  let stderr = '';
  const code = runCli(args, {
    cwd,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { code, stdout, stderr };
};

const INVOICE_WITH_ERROR = [
  '// lineTotal :: { quantity :: Number, unitPrice :: Number } -> Number',
  'const lineTotal = (line) => line.quantity * line.unitPrice;',
  '',
  '// firstLine :: Number',
  'const firstLine = lineTotal ({ quantity: "2", unitPrice: 1250 });',
  '',
].join('\n');

const QUIET = JSON.stringify({ settings: { diagnostics: { missingSignatures: 'off' } } });

describe('information options', () => {
  test.each([['--help'], ['-h']])('%s prints the usage and checks nothing', (flag) => {
    write('invoice.js', INVOICE_WITH_ERROR);
    const result = invoke([flag]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Usage: hinmil \[paths\.\.\.\] \[options\]/);
    expect(result.stdout).toContain('--format <stylish|json>');
    expect(result.stdout).not.toMatch(/HM\d{4}/);
  });

  test.each([['--version'], ['-v']])('%s prints the package version', (flag) => {
    const result = invoke([flag]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${pkg.version}\n`);
  });
});

describe('JSON output', () => {
  test('lists each diagnostic with absolute file, severity name, numeric code and zero-based range', () => {
    write('hinmil.config.json', QUIET);
    const file = write('invoice.js', INVOICE_WITH_ERROR);
    const result = invoke(['--format', 'json']);
    const output = JSON.parse(result.stdout);

    expect(result.code).toBe(1);
    expect(output.project).toBe(root);
    expect(output.checkedFiles).toEqual([file]);
    expect(output.warnings).toEqual([]);
    expect(output.diagnostics.length).toBeGreaterThan(0);
    const [first] = output.diagnostics;
    expect(first).toEqual({
      file,
      severity: 'error',
      code: 1001,
      message: expect.stringMatching(/String.*Number|Number.*String/),
      range: { start: { line: 4, character: expect.any(Number) }, end: { line: 4, character: expect.any(Number) } },
    });
  });

  test('names non-error severities and still exits with zero', () => {
    write('hinmil.config.json', JSON.stringify({ settings: { diagnostics: { missingSignatures: 'hint' } } }));
    write('money.js', 'const centsToEuros = (cents) => cents / 100;\nmodule.exports = { centsToEuros };\n');
    const result = invoke(['--format', 'json']);
    const output = JSON.parse(result.stdout);
    expect(result.code).toBe(0);
    expect(output.diagnostics.map((d: { severity: string; code: number }) => [d.severity, d.code]))
      .toEqual([['hint', 6001]]);
  });

  test('carries configuration warnings in the result instead of stderr', () => {
    write('hinmil.config.json', JSON.stringify({ settings: { diagnostics: { typeErrors: 'loud', missingSignatures: 'off' } } }));
    write('invoice.js', '// vatRate :: Number\nconst vatRate = 0.21;\n');
    const result = invoke(['--format', 'json']);
    const output = JSON.parse(result.stdout);
    expect(result.code).toBe(0);
    expect(output.warnings.join('\n')).toMatch(/typeErrors/);
    expect(result.stderr).toBe('');
  });
});

describe('stylish output', () => {
  test('prints one-based positions and a summary line', () => {
    write('hinmil.config.json', QUIET);
    write('invoice.js', INVOICE_WITH_ERROR);
    const result = invoke([]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^invoice\.js:5:\d+ error HM1001 /m);
    expect(result.stdout).toMatch(/^\d+ problems? \(\d+ errors?\)$/m);
  });

  test('a clean project reports zero problems', () => {
    write('hinmil.config.json', QUIET);
    write('invoice.js', '// vatRate :: Number\nconst vatRate = 0.21;\n');
    const result = invoke([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('0 problems (0 errors)\n');
  });

  test('prints configuration warnings on stderr', () => {
    write('hinmil.config.json', JSON.stringify({ settings: { diagnostics: { typeErrors: 'loud', missingSignatures: 'off' } } }));
    write('invoice.js', '// vatRate :: Number\nconst vatRate = 0.21;\n');
    const result = invoke([]);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/typeErrors/);
  });
});

describe('project and configuration options', () => {
  test('--project checks another directory, relative to the working directory', () => {
    write('shop/hinmil.config.json', QUIET);
    write('shop/invoice.js', INVOICE_WITH_ERROR);
    const result = invoke(['--project', 'shop', '--format', 'json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).project).toBe(path.join(root, 'shop'));
  });

  test('--config with a JSON-compatible JavaScript file applies its settings', () => {
    write('ci/hinmil.strict.js', `module.exports = ${JSON.stringify({ settings: { diagnostics: { typeErrors: 'warning', missingSignatures: 'off' } } })};\n`);
    write('invoice.js', INVOICE_WITH_ERROR);
    const result = invoke(['--config', 'ci/hinmil.strict.js', '--format', 'json']);
    const output = JSON.parse(result.stdout);
    expect(result.code).toBe(0);
    expect(output.diagnostics.every((d: { severity: string }) => d.severity === 'warning')).toBe(true);
  });

  test('--config applies to every file, also below a folder with its own configuration', () => {
    write('ci/hinmil.json', QUIET);
    write('server/hinmil.config.json', JSON.stringify({ settings: { diagnostics: { missingSignatures: 'error' } } }));
    write('server/money.js', 'const centsToEuros = (cents) => cents / 100;\nmodule.exports = { centsToEuros };\n');
    const result = invoke(['--config', 'ci/hinmil.json', '--format', 'json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).diagnostics).toEqual([]);
  });

  test('without --config a nested configuration governs its own folder', () => {
    write('hinmil.config.json', QUIET);
    write('server/hinmil.config.json', JSON.stringify({ settings: { diagnostics: { missingSignatures: 'error' } } }));
    write('server/money.js', 'const centsToEuros = (cents) => cents / 100;\nmodule.exports = { centsToEuros };\n');
    write('client/format.js', 'const euros = (cents) => cents / 100;\nmodule.exports = { euros };\n');
    const result = invoke(['--format', 'json']);
    const output = JSON.parse(result.stdout);
    expect(result.code).toBe(1);
    expect(output.diagnostics.map((d: { file: string; code: number }) => [path.relative(root, d.file), d.code]))
      .toEqual([['server/money.js', 6001]]);
  });
});

describe('exit status 2: the check could not run', () => {
  const fails = (args: string[], message: RegExp) => {
    const result = invoke(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^hinmil: /);
    expect(result.stderr).toMatch(message);
  };

  test('an unknown option', () => fails(['--strict'], /Unknown option: --strict/));
  test('an unsupported output format', () => fails(['--format', 'xml'], /--format must be 'stylish' or 'json'/));
  test('--project without a directory', () => fails(['--project'], /--project requires a directory/));
  test('--config without a file', () => fails(['--config'], /--config requires a file/));
  test('--ext without an extension', () => fails(['--ext'], /--ext requires an extension/));

  test('a project root that is a file', () => {
    write('invoice.js', INVOICE_WITH_ERROR);
    fails(['--project', 'invoice.js'], /Project root is not a directory/);
  });

  test('a project root that does not exist', () => fails(['--project', 'missing'], /ENOENT|no such file/));

  test('an input path that does not exist', () => {
    write('invoice.js', INVOICE_WITH_ERROR);
    fails(['src/invoice.js'], /Input does not exist or is unreadable/);
  });

  test('an explicit configuration file that does not exist', () => {
    fails(['--config', 'hinmil.ci.json'], /Cannot read config/);
  });

  test('a JavaScript configuration that is not a plain object export', () => {
    write('hinmil.config.js', 'const base = require ("./base");\nmodule.exports = Object.assign ({}, base);\n');
    fails(['--config', 'hinmil.config.js'], /Invalid config .*JSON-compatible module\.exports object/);
  });

  test('a configuration file of an unsupported type', () => {
    write('hinmil.yaml', 'settings:\n  diagnostics: {}\n');
    fails(['--config', 'hinmil.yaml'], /Invalid config .*expected a \.json or \.js file/);
  });
});
