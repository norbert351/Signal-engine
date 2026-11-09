import { asc,eq } from "drizzle-orm";
import { db } from "./index.js";
import { backtestRuns } from "./schema.js";
export async function claimQueuedBacktests(limit=5){return db.transaction(async tx=>{const rows=await tx.select().from(backtestRuns).where(eq(backtestRuns.status,"queued")).orderBy(asc(backtestRuns.createdAt)).limit(limit).for("update",{skipLocked:true});for(const row of rows)await tx.update(backtestRuns).set({status:"running",startedAt:new Date()}).where(eq(backtestRuns.id,row.id));return rows;});}
export async function finishBacktest(id:string,metrics:Record<string,unknown>,status:"completed"|"failed"="completed"){await db.update(backtestRuns).set({status,metrics,completedAt:new Date()}).where(eq(backtestRuns.id,id));}
