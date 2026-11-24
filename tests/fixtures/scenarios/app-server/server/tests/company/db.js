// ::types sqlkit
// The sample `company` database: the same SqlKit factory as the
// application database, connected to the sample database instead.
import { companyDbConfig } from "../../src/config/env";
import { mkDb } from "../../src/db/sqlkit";

export const { tables, sql, introspect, options, pool, end } = mkDb (companyDbConfig ());
