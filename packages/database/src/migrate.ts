import postgres from "postgres";
import { readFile } from "node:fs/promises";
const url=process.env.DATABASE_URL;if(!url)throw new Error("DATABASE_URL is required");
const client=postgres(url,{max:1});
try{const sql=await readFile(new URL("../drizzle/0001_initial.sql",import.meta.url),"utf8");await client.unsafe(sql);console.log("Database migration 0001 applied");}finally{await client.end();}
