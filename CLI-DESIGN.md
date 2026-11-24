# HinMil command-line checker

## Scope

One invocation checks one project root. Below it, every folder with its own
HinMil configuration is a separate *project scope* (globals, `typesDir`,
overrides, settings), exactly as in the language server: a file uses the
nearest configuration above it (`findScopeRoot`), and the CLI keeps one
`ProjectChecker` per scope. The CLI shares the same inference, import,
globals, sidecar, settings and diagnostic pipeline as the language server; editor lifecycle features such as debounce, live document
text and background completion warming are not part of the CLI.

## Invocation

```text
hinmil [paths...] [--project <directory>] [--config <file>] [--format stylish|json] [--ext <extension>]
```

- The project root defaults to the current working directory.
- `--project` selects another project root.
- Paths default to the project root and may name selected files or directories.
  Relative paths are resolved from the current working directory. Explicit
  paths obey the same extension/include/exclude rules as discovered files.
- `--ext` is repeatable and additively extends the effective extension list.
- Files are checked sequentially because HinMil registries are process-global.
- `--format stylish` is the human-readable default. `--format json` emits one
  stable JSON object containing checked files and diagnostics.
- `--help` and `--version` do not run the checker.

## File discovery

Configuration is loaded before directory traversal. Defaults select `.js`,
`.jsx`, `.mjs`, `.cjs`, and `.hm`, include `**/*`, and exclude `.git`,
`node_modules`, `dist`, `build`, and `coverage`. Effective precedence is
defaults → optional editor-compatible `settingsLayer.files` → project `files`;
`--ext` additions apply last. Excludes suppress standalone diagnostics only:
imported dependencies remain inferable. Duplicate paths are removed and
results are sorted for deterministic output.

## Configuration

Without `--config`, each file uses the configuration of its nearest folder
that has one, up to the project root. Within one folder, discovery preserves
the existing language-server precedence:

1. the `hinmil` object in `package.json`;
2. `hinmil.config.js`;
3. `hinmil.config.json`;
4. empty project configuration.

The existing JavaScript configuration support is deliberately limited to a
JSON-compatible `module.exports = { ... }` object; arbitrary JavaScript is not
executed. `--config` selects exactly the named JSON or supported JavaScript
configuration file for every checked file (nested configurations are then
ignored) and is an error when it is missing or malformed. The file selection
(`files`) always comes from the project root's configuration or `--config`.

Effective diagnostic settings are built from `defaultSettings`, followed by
the project configuration's `settings`. Future setting-specific command-line
flags, if introduced, apply last. The first release has no setting-specific
CLI overrides.

The checker honours all existing project fields, including `globals`,
`overrides`, `typesDir`, and `settings`. It composes explicit/conventional
globals, `::types` globals addenda, dependency package globals, sidecars and
bundled typings in the same order as the language server. Invalid optional
configuration values use the existing validation/fallback behavior and emit
warnings. An explicitly selected unreadable or malformed config is a CLI error.

## Diagnostics and exit status

Human output uses one-based positions:

```text
path/to/file.js:3:8 error HM1001 message
```

Diagnostics are ordered by file, start position, severity, code, and message.
JSON output retains the diagnostic code, severity, message and zero-based LSP
range. Warnings about project assets/configuration go to stderr in stylish
mode and are included in the JSON result.

Exit codes:

- `0`: checking completed and no error-severity diagnostics were found;
- `1`: one or more error-severity diagnostics were found;
- `2`: invalid arguments, an explicit configuration failure, an unreadable
  input, or an unexpected checker failure.

Warnings, information and hints are reported but do not fail the first release.
A source-level `::ignore-file`, line/function ignores, trust settings and all
configured diagnostic severities retain their language-server semantics.

## Published package

The npm package exposes `hinmil` through `bin` and runs a build during
`prepack`. Its allowlist contains compiled runtime files, bundled HM typings,
schemas, user documentation and the license. It excludes TypeScript sources, tests,
fixtures, samples, scripts, coverage and repository-only design documents.

While the VS Code extension and CLI share this package, extension runtime
output and syntax assets remain publishable where VS Code packaging requires
them. The CLI must not import the extension client. Tarball tests install the
created package in an isolated temporary project to prove that no repository
files are used accidentally.

## Verification

Acceptance requires the existing Jest suite (including its coverage
threshold), the checker/configuration/CLI integration tests
(`tests/services/cli.test.ts`, `tests/services/cliOptions.test.ts`,
`tests/scenarios/scopedProjectConfig.test.ts`), TypeScript build,
`npm pack --dry-run`, and the isolated tarball test (`npm run test:tarball`)
to pass. Configuration fixtures cover
`package.json`, JSON config, JavaScript config, precedence, globals, overrides,
`typesDir`, settings and explicit malformed configuration.
