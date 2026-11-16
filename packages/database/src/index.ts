import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const statementTimeoutMs = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? "60000");
export const sql = postgres(url, {
  max: Number(process.env.PG_POOL_MAX ?? "4"),
  idle_timeout: 20,
  connect_timeout: 10,
  max_lifetime: 60 * 30,
  ...(Number.isFinite(statementTimeoutMs) && statementTimeoutMs > 0
    ? { connection: { statement_timeout: Math.floor(statementTimeoutMs) } }
    : {})
});
export const db = drizzle(sql, { schema });
export * from "./schema.js";
