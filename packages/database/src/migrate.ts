import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const client = postgres(url, { max: 1 });
try {
  await client`CREATE TABLE IF NOT EXISTS schema_migrations (name varchar(160) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const directory = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    const [applied] = await client`SELECT name FROM schema_migrations WHERE name = ${name}`;
    if (applied) {
      console.log("Skipping " + name);
      continue;
    }
    const migration = await readFile(new URL(name, directory), "utf8");
    await client.begin(async (transaction) => {
      await transaction.unsafe(migration);
      await transaction`INSERT INTO schema_migrations(name) VALUES (${name})`;
    });
    console.log("Applied " + name);
  }
} finally {
  await client.end();
}
