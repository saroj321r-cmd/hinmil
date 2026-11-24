#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { HinMilProjectConfig, findScopeRoot } from './config';
import { ProjectChecker } from './services/projectChecker';
import { loadProjectConfig } from './services/globalsLoader';
import { FileSelection, addExtensions, globMatches, isSelectedFile, mergeFileSelection } from './services/fileSelection';

interface CliOptions {
  projectRoot: string;
  configPath?: string;
  format: 'stylish' | 'json';
  inputs: string[];
  extensions: string[];
  help: boolean;
  version: boolean;
}

export interface CliIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Optional editor-compatible layer, primarily for embedded/test use. */
  settingsLayer?: unknown;
}

function usage(): string {
  return [
    'Usage: hinmil [paths...] [options]',
    '',
    'Options:',
    '  --project <directory>   Project root (default: current directory)',
    '  --config <file>         Explicit hinmil JSON or JS config',
    '  --format <stylish|json> Output format (default: stylish)',
    '  --ext <extension>       Add a file extension (repeatable)',
    '  --help                  Show this help',
    '  --version               Show the package version',
  ].join('\n');
}

function parseArguments(args: string[], cwd: string): CliOptions {
  const options: CliOptions = {
    projectRoot: cwd,
    format: 'stylish',
    inputs: [],
    extensions: [],
    help: false,
    version: false,
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--version' || argument === '-v') options.version = true;
    else if (argument === '--project') {
      const value = args[++index];
      if (!value) throw new Error('--project requires a directory');
      options.projectRoot = path.resolve(cwd, value);
    } else if (argument === '--config') {
      const value = args[++index];
      if (!value) throw new Error('--config requires a file');
      options.configPath = path.resolve(cwd, value);
    } else if (argument === '--ext') {
      const value = args[++index];
      if (!value) throw new Error('--ext requires an extension');
      options.extensions.push(value);
    } else if (argument === '--format') {
      const value = args[++index];
      if (value !== 'stylish' && value !== 'json') {
        throw new Error("--format must be 'stylish' or 'json'");
      }
      options.format = value;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      options.inputs.push(path.resolve(cwd, argument));
    }
  }
  options.projectRoot = path.resolve(options.projectRoot);
  return options;
}

function loadExplicitConfig(filePath: string): HinMilProjectConfig {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read config '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (filePath.endsWith('.json')) return JSON.parse(source) as HinMilProjectConfig;
    if (filePath.endsWith('.js')) {
      const match = /module\.exports\s*=\s*(\{[^]*\})\s*;?\s*$/.exec(source);
      if (!match) throw new Error('expected a JSON-compatible module.exports object');
      return JSON.parse(match[1]) as HinMilProjectConfig;
    }
    throw new Error('expected a .json or .js file');
  } catch (error) {
    throw new Error(`Invalid config '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

function discoverFiles(
  inputs: string[], projectRoot: string,
  selection: FileSelection = mergeFileSelection([]),
): string[] {
  const found = new Set<string>();
  // Real paths of every traversed directory: a symlink cycle (or two links
  // to the same directory) is visited at most once.
  const visitedDirectories = new Set<string>();
  let rootReal: string;
  try { rootReal = fs.realpathSync(projectRoot); } catch { rootReal = path.resolve(projectRoot); }
  const withinRoot = (real: string): boolean =>
    real === rootReal || real.startsWith(rootReal + path.sep);

  const visitDirectory = (target: string): void => {
    let real: string;
    try { real = fs.realpathSync(target); } catch { return; }
    if (visitedDirectories.has(real)) return;
    visitedDirectories.add(real);
    const entries = fs.readdirSync(target, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = path.join(target, entry.name);
      let stat: fs.Stats;
      // Broken symlinks and transient entries are skipped, not fatal.
      try { stat = fs.statSync(child); } catch { continue; }
      if (stat.isDirectory()) {
        const relative = path.relative(projectRoot, child).replace(/\\/g, '/');
        if (selection.exclude.some(glob => globMatches(`${relative}/x`, glob))) continue;
        // A symlinked directory must stay inside the project root; links that
        // escape (e.g. into a global store or $HOME) are never traversed.
        if (entry.isSymbolicLink()) {
          let childReal: string;
          try { childReal = fs.realpathSync(child); } catch { continue; }
          if (!withinRoot(childReal)) continue;
        }
        visitDirectory(child);
      } else if (stat.isFile()) {
        if (isSelectedFile(child, projectRoot, selection)) found.add(path.resolve(child));
      }
    }
  };

  for (const input of inputs.length > 0 ? inputs : [projectRoot]) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(input);
    } catch {
      throw new Error(`Input does not exist or is unreadable: ${input}`);
    }
    if (stat.isFile()) {
      if (isSelectedFile(input, projectRoot, selection)) found.add(path.resolve(input));
    } else if (stat.isDirectory()) {
      visitDirectory(input);
    } else {
      throw new Error(`Input is not a file or directory: ${input}`);
    }
  }
  return [...found].sort();
}

function severityName(severity?: DiagnosticSeverity): string {
  switch (severity) {
    case DiagnosticSeverity.Error: return 'error';
    case DiagnosticSeverity.Warning: return 'warning';
    case DiagnosticSeverity.Information: return 'information';
    case DiagnosticSeverity.Hint: return 'hint';
    default: return 'error';
  }
}

function compareDiagnostics(
  left: { file: string; diagnostic: Diagnostic },
  right: { file: string; diagnostic: Diagnostic },
): number {
  return left.file.localeCompare(right.file)
    || left.diagnostic.range.start.line - right.diagnostic.range.start.line
    || left.diagnostic.range.start.character - right.diagnostic.range.start.character
    || (left.diagnostic.severity ?? DiagnosticSeverity.Error) - (right.diagnostic.severity ?? DiagnosticSeverity.Error)
    || String(left.diagnostic.code ?? '').localeCompare(String(right.diagnostic.code ?? ''))
    || left.diagnostic.message.localeCompare(right.diagnostic.message);
}

function packageVersion(): string {
  // Both the repository build and the published package place this file at
  // <root>/dist/cli.js → ../package.json; the second candidate covers any
  // nested dist layout.
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(__dirname, candidate), 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string') return parsed.version;
    } catch { /* try the next layout */ }
  }
  return 'unknown';
}

export function runCli(args: string[], io: CliIo = {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}): number {
  let options: CliOptions;
  try {
    options = parseArguments(args, io.cwd);
    if (options.help) {
      io.stdout(`${usage()}\n`);
      return 0;
    }
    if (options.version) {
      io.stdout(`${packageVersion()}\n`);
      return 0;
    }
    if (!fs.statSync(options.projectRoot).isDirectory()) {
      throw new Error(`Project root is not a directory: ${options.projectRoot}`);
    }
    // Configuration must be known before walking: it determines extensions
    // and include/exclude patterns, including for explicit path arguments.
    const config = options.configPath
      ? loadExplicitConfig(options.configPath)
      : loadProjectConfig(options.projectRoot);
    const warnings: string[] = [];
    const editorFiles = typeof io.settingsLayer === 'object' && io.settingsLayer !== null
      ? (io.settingsLayer as { files?: unknown }).files
      : undefined;
    const selection = addExtensions(
      mergeFileSelection([editorFiles, config.files], message => warnings.push(message)),
      options.extensions,
      message => warnings.push(message),
    );
    const files = discoverFiles(options.inputs, options.projectRoot, selection);
    // One checker per project scope: a nested `hinmil.config.json` (an
    // application in a monorepo) brings its own globals, types directory and
    // overrides.  An explicit `--config` applies to every file.
    const checkers = new Map<string, ProjectChecker>();
    const checkerFor = (file: string): ProjectChecker => {
      const scope = options.configPath ? options.projectRoot : findScopeRoot(file, options.projectRoot);
      let checker = checkers.get(scope);
      if (!checker) {
        checker = new ProjectChecker(scope, {
          config: scope === options.projectRoot
            ? { ...config, files: selection }
            : loadProjectConfig(scope),
          settingsLayer: io.settingsLayer,
          warn: (message) => warnings.push(message),
        });
        checkers.set(scope, checker);
      }
      return checker;
    };
    const diagnostics: Array<{ file: string; diagnostic: Diagnostic }> = [];
    for (const file of files) {
      const result = checkerFor(file).checkFile(file);
      for (const diagnostic of result.diagnostics) diagnostics.push({ file, diagnostic });
    }
    diagnostics.sort(compareDiagnostics);

    if (options.format === 'json') {
      io.stdout(`${JSON.stringify({
        project: options.projectRoot,
        checkedFiles: files,
        warnings,
        diagnostics: diagnostics.map(({ file, diagnostic }) => ({
          file,
          severity: severityName(diagnostic.severity),
          code: diagnostic.code ?? null,
          message: diagnostic.message,
          range: diagnostic.range,
        })),
      }, null, 2)}\n`);
    } else {
      for (const warning of warnings) io.stderr(`${warning}\n`);
      for (const { file, diagnostic } of diagnostics) {
        const relative = path.relative(options.projectRoot, file) || path.basename(file);
        const position = diagnostic.range.start;
        const code = diagnostic.code === undefined ? '' : ` HM${diagnostic.code}`;
        io.stdout(`${relative}:${position.line + 1}:${position.character + 1} ${severityName(diagnostic.severity)}${code} ${diagnostic.message}\n`);
      }
      const errors = diagnostics.filter(({ diagnostic }) => diagnostic.severity === DiagnosticSeverity.Error).length;
      io.stdout(`${diagnostics.length} problem${diagnostics.length === 1 ? '' : 's'} (${errors} error${errors === 1 ? '' : 's'})\n`);
    }
    return diagnostics.some(({ diagnostic }) => diagnostic.severity === DiagnosticSeverity.Error) ? 1 : 0;
  } catch (error) {
    io.stderr(`hinmil: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}

export { discoverFiles, loadExplicitConfig };
