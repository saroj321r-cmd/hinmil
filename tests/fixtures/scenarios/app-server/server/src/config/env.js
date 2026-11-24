// Configuration from the environment: loads the root .env file once and
// offers pure accessors.  DbConfig is a project-wide alias (globals.hm).
// Compiled to CommonJS, so `__dirname` rather than `import.meta`.
import { resolve } from "path";
import dotenv from "dotenv";

const rootEnvPath = resolve (__dirname, "../../../.env");

dotenv.config ({ path: rootEnvPath, quiet: true });

// envOr :: (String, String) -> String
const envOr = (key, fallback) =>
  process.env[key] == null ? fallback : process.env[key];

// dbConfig :: () -> DbConfig
export const dbConfig = () => ({
  host: envOr ("DB_HOST", "localhost"),
  port: Number (envOr ("DB_PORT", "5436")),
  user: envOr ("DB_USER", "app"),
  password: envOr ("DB_PASSWORD", "app"),
  database: envOr ("DB_NAME", "app")
});

// companyDbConfig :: () -> DbConfig
// The sample database of the query-builder tests (a local container on 3308).
export const companyDbConfig = () => ({
  host: envOr ("SAMPLE_DB_HOST", "localhost"),
  port: Number (envOr ("SAMPLE_DB_PORT", "3308")),
  user: envOr ("SAMPLE_DB_USER", "test"),
  password: envOr ("SAMPLE_DB_PASSWORD", "test"),
  database: envOr ("SAMPLE_DB_NAME", "company")
});

// redisConfig :: () -> { host :: String, port :: Number }
export const redisConfig = () => ({
  host: envOr ("REDIS_HOST", "localhost"),
  port: Number (envOr ("REDIS_PORT", "6380"))
});
