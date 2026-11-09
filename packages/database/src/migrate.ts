import postgres from "postgres";
import { readFile } from "node:fs/promises";
const url=process.env.DATABASE_URL;if(!url)throw new Error("DATABASE_URL is required");
const client=postgres(url,{max:1});
try{for(const name of ["0001_initial.sql","0002_seed_defaults.sql","0003_paper_trades.sql"]){const migration=await readFile(new URL("../drizzle/"+name,import.meta.url),"utf8");await client.unsafe(migration);console.log("Applied "+name);}}finally{await client.end();}
