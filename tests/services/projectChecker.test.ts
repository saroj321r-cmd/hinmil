import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { ProjectChecker } from '../../src/services/projectChecker';
import { HM_MISSING_SIGNATURE } from '../../src/services/diagnosticCodes';

describe('ProjectChecker', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hinmil-checker-'));
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

  test('uses project diagnostic settings from package.json', () => {
    write('package.json', JSON.stringify({
      'hinmil': {
        settings: { diagnostics: { missingSignatures: 'error' } },
      },
    }));
    const sourcePath = write('main.js', 'const identity = value => value;\n');

    const result = new ProjectChecker(root).checkFile(sourcePath);
    const missing = result.diagnostics.find((diagnostic) => diagnostic.code === HM_MISSING_SIGNATURE);

    expect(missing?.severity).toBe(DiagnosticSeverity.Error);
  });

  test('uses hinmil.config.json and can disable a diagnostic category', () => {
    write('hinmil.config.json', JSON.stringify({
      settings: { diagnostics: { missingSignatures: 'off' } },
    }));
    const sourcePath = write('main.js', 'const identity = value => value;\n');

    const result = new ProjectChecker(root).checkFile(sourcePath);

    expect(result.diagnostics.some((diagnostic) => diagnostic.code === HM_MISSING_SIGNATURE)).toBe(false);
  });

  test('loads configured globals and resolves project imports', () => {
    write('hinmil.config.json', JSON.stringify({
      globals: ['types/globals.hm'],
      settings: { diagnostics: { missingSignatures: 'off' } },
    }));
    write('types/globals.hm', 'answer :: Number\n');
    write('lib.js', 'export const double = value => value * 2;\n');
    const sourcePath = write(
      'main.js',
      "import { double } from './lib.js';\n// result :: Number\nconst result = double(answer);\n",
    );

    const result = new ProjectChecker(root).checkFile(sourcePath);

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error)).toEqual([]);
  });
});
