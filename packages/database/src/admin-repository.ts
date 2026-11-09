import { desc,eq } from "drizzle-orm";
import { db } from "./index.js";
import { backtestRuns,strategyConfigs } from "./schema.js";
export async function listStrategies(){return db.select().from(strategyConfigs).orderBy(strategyConfigs.key,strategyConfigs.version);}
export async function setStrategyEnabled(id:string,enabled:boolean){const [row]=await db.update(strategyConfigs).set({enabled}).where(eq(strategyConfigs.id,id)).returning();return row??null;}
export async function listBacktests(){return db.select().from(backtestRuns).orderBy(desc(backtestRuns.createdAt)).limit(100);}
export async function createBacktest(input:{strategyKey:string;strategyVersion:number;timeframe:string;dataset:Record<string,unknown>;assumptions:Record<string,unknown>}){const [row]=await db.insert(backtestRuns).values({...input,status:"queued"}).returning();return row;}
