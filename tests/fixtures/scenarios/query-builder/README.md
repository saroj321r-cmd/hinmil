# Fixture: query builder

The `.hm` sidecar of a tagged-template SQL query builder (`sqlkit.hm`:
`Table`, `Prop`, `QueryTag`, `QueryOne`, `QueryExists`, relations, `Limit`,
…) and a client sidecar generated from a database schema
(`.sqlkit/client/index.hm`: per-table rows, selectors and relations). The
runtime (`build/index.js`) is a stand-in — hinmil only reads the sidecars.
`_node_modules` is renamed to `node_modules` when a test copies the fixture.
Used by `tests/scenarios/queryBuilderQueries.test.ts`,
`tests/scenarios/queryParameters.test.ts` and
`tests/scenarios/memberOwners.test.ts`.
