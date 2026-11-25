# Contributing to HinMil

Thanks for taking a look. Bug reports, missing types and small fixes are
all welcome. Issues labelled
[good first issue](https://github.com/tureluren/hinmil/labels/good%20first%20issue)
are a good place to start.

**In short:** the tests pass, and your change comes with a test. Everything
else on this page is helpful background; if something is unclear, open the
pull request anyway and ask.

## Setting up

You need Node.js 18 or later and VS Code.

```sh
git clone https://github.com/tureluren/hinmil.git
cd hinmil
npm ci
npm run build      # TypeScript → dist/
npx jest           # the whole suite, about 5,000 tests, under a minute
```

To try your change in the editor, open the folder in VS Code and press
**F5** ("Launch Extension"). A second VS Code window opens on
[sample/](sample/) with your build of the extension.

The command-line checker runs straight from the build:

```sh
node dist/cli.js path/to/file.js
```

## Adding a built-in type

The most common small contribution is a missing method or module.

- **A method on a built-in type** (`Array#toSorted`, `String#at`): add it
  to [src/registries/methodRegistry.ts](src/registries/methodRegistry.ts),
  next to a similar method, and add a case to
  [tests/infer/builtins.test.ts](tests/infer/builtins.test.ts).
- **A Node module** (`readline`, `events`): add
  `hm-types-builtin/<module>.hm` (see [os.hm](hm-types-builtin/os.hm) for
  the format) and a case to
  [tests/scenarios/nodeBuiltins.test.ts](tests/scenarios/nodeBuiltins.test.ts).
  Cover the functions people actually use. A name that is not declared
  stays `Any`, which is better than a wrong signature.

Types for third-party npm packages do not belong in HinMil: they belong in
the package itself (inline annotations or a `.hm` file, see
[Publishing types for an npm package](README.md#publishing-types-for-an-npm-package)).

## Where things are

| Path | What it holds |
|---|---|
| `src/infer/` | The inference engine: expressions, calls, narrowing, imports |
| `src/hm/` | Types, unification, substitution, the signature parser |
| `src/services/` | Editor features (hover, completion, diagnostics) and module resolution |
| `src/registries/` | Built-in methods (`Array#map`, `String#split`, …) and type classes |
| `hm-types-builtin/` | Signatures for Node modules and React |
| `syntaxes/` | Highlighting grammars |
| `tests/` | Jest tests; `tests/scenarios/` holds the end-to-end ones |

Before you change the inference, read
[ARCHITECTURE.md](ARCHITECTURE.md) and [TYPE-SYSTEM.md](TYPE-SYSTEM.md).
[GLOSSARY.md](GLOSSARY.md) explains the terms they use.

## Writing a test

Every change comes with a test. It reads best with realistic code (an
order, an invoice, a list of customers) rather than `foo` and `bar`. If
you can, test both sides:

- **positive:** correct code is accepted, and gets the type you expect;
- **negative:** a real mistake is still reported.

A test for a single file can use the engine directly:

```ts
import { InferenceEngine } from '../../src/infer';

test('a price given as text is rejected', () => {
  const r = new InferenceEngine().infer(`
// discounted :: (Number, Number) -> Number
const discounted = (price, pct) => price * (1 - pct / 100);
const wrong = discounted ("250", 10);
`);
  expect(r.diagnostics.map(d => d.message))
    .toEqual(["Type mismatch: Cannot unify 'String' with 'Number'"]);
});
```

For imports, packages and `.hm` files, use the temporary project helper in
[tests/helpers/project.ts](tests/helpers/project.ts):

```ts
import { TempProject } from '../helpers/project';

const project = new TempProject('invoice-totals');
beforeAll(() => {
  project.setup();
  project.write('money.js', `
// round2 :: Number -> Number
export const round2 = (n) => Math.round (n * 100) / 100;
`);
});
afterAll(() => project.cleanup());

test('an imported function keeps its signature', () => {
  const r = project.inferSource('invoice.js', `
import { round2 } from "./money";
const total = round2 ("12.5");
`);
  expect(r.diagnostics.length).toBeGreaterThan(0);
});
```

Tip: undo your fix for a moment and run the test again. If it still
passes, it does not test your change yet.

## Opening a pull request

Needed:

- `npm run build` and `npx jest` pass (CI checks this on every pull request);
- a test for your change.

Welcome, but the maintainer can take care of it:

- a line in the [README](README.md) or under "Unreleased" in
  [CHANGELOG.md](CHANGELOG.md) when users can see the change;
- for changes deep in the engine (unification, calls, member access):
  `npm run bench:quick` before and after.

## Reporting a bug

Use the [bug report form](https://github.com/tureluren/hinmil/issues/new?template=bug_report.yml).
The most useful report is a few lines of JavaScript, the diagnostic you
expected, and the one you got.

## License

By contributing you agree that your contribution is licensed under the
[MIT license](LICENSE).
