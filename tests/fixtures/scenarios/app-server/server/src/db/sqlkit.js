// ::types sqlkit
// Builds a database handle (Pool + SqlKit) from a DbConfig.  Pure apart from
// construction: the pool connects lazily, on the first query.
import pg from "pg";
import SqlKit from "sqlkit";

// mkQuerier :: Pool -> (String, [a]) -> Promise e [b]
const mkQuerier = pool => (query, values) =>
  pool.query (query, values).then (({ rows }) => rows);

// mkDb :: DbConfig -> { tables :: Tables, sql :: a, introspect :: () -> Promise e (), options :: b, pool :: Pool, end :: () -> Promise e2 () }
export const mkDb = config => {
  const pool = new pg.Pool (config);
  const { tables, sql, introspect, options } = SqlKit ({
    querier: mkQuerier (pool),
    schemas: ["public"]
  });

  return { tables, sql, introspect, options, pool, end: () => pool.end () };
};
