# Changelog

All notable changes to HinMil are listed here. The project follows
[semantic versioning](https://semver.org/).

## 0.1.0 — first release

HinMil type-checks plain JavaScript with Hindley-Milner inference. Types are
written as signatures in ordinary comments (`// add :: (Number, Number) -> Number`);
the files stay plain JavaScript, without a build step.

### VS Code extension

- Diagnostics while you type, with codes (`HM1001`…) and configurable severities.
- Hover with inferred types, completion (including auto-imports), signature
  help, go to definition, find references, rename, document symbols and quick
  fixes.
- Syntax highlighting for annotations in comments and for `.hm` type files.
- Works alongside VS Code's built-in TypeScript extension, or without it.
- Project configuration in `hinmil.config.json`, `hinmil.config.js` or a
  `"hinmil"` key in `package.json`, per folder in a monorepo and per folder in
  a multi-root workspace.

### Command-line checker

- `npx hinmil .` checks a project in CI, with `stylish` or `json` output and
  exit codes for errors (`1`) and failures (`2`).
- Uses the same configuration, inference and diagnostics as the extension.

### Type system

- Records with row polymorphism, tuples, sum types, type classes with
  constraints, higher-kinded types, currying, overloading and narrowing.
- Type information for npm packages through `.hm` sidecar files or inline
  `::` annotations, and built-in types for JavaScript, the DOM, React and
  the Node.js core modules.

See the [README](README.md) for the full documentation.
