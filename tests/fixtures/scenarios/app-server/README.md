# Fixture: app server

A small, self-contained server project as hinmil sees it: ESM source under
`server/src`, a curried functional library (`fpkit`, inline `::`-annotated
CommonJS, no `.hm` sidecar) and a SQL query builder (`sqlkit`, `.hm` sidecar
plus an introspection-generated client) under `server/node_modules`.
Used by `tests/scenarios/appServer.test.ts` for end-to-end, cross-package
inference, run as `hinmil src tests --project ..` from `server/`.

| Path | Contents |
|---|---|
| `hinmil.config.json`, `server/globals.hm`, `server/hm-types/*.hm` | project config, shared aliases, a project override of `sqlkit` |
| `server/src/**`, `server/tests/**` | config, a Promise→task adapter, the query-builder setup, smoke scripts |
| `server/_node_modules/fpkit/**` | a small `RTask` (a reader-task with a promise adapter) and the helpers it uses |
| `server/_node_modules/sqlkit/sqlkit.hm`, `server/_node_modules/.sqlkit/client/index.hm` | the library sidecar and a generated client for an events test schema |
| `server/_node_modules/sqlkit/build/index.js` | runtime stand-in with the real export names |
| `server/_node_modules/{pg,dotenv}` | stand-ins for untyped CommonJS packages |

This fixture is a fixed test project: extend it (or add a new fixture) when a
new realistic pattern needs end-to-end coverage. `_node_modules` is renamed
to `node_modules` when the test copies the tree to a temp dir (a real
`node_modules` would be git-ignored).
