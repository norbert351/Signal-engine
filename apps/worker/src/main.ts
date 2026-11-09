import { Worker } from "bullmq";
import { connection,scanQueue,notificationQueue } from "./queues.js";
import { ingestAll } from "./ingestion.js";
import { processScan } from "./scanner.js";
import { deliverPending } from "./telegram.js";
import { processPaperTrades } from "./paper-tracker.js";
import { processBacktests } from "./backtests.js";
import { reportWorkerHealth } from "./health.js";
import { backfillHistory } from "./backfill.js";
async function start(){
 const scanWorker=new Worker("market-scan",async job=>{if(job.name==="backfill")return backfillHistory();if(job.name==="ingest")return ingestAll();if(job.name==="paper")return processPaperTrades();if(job.name==="backtests")return processBacktests();return processScan();},{connection,concurrency:1});
 const notifyWorker=new Worker("notification-delivery",async()=>deliverPending(),{connection,concurrency:2});
 scanWorker.on("failed",(job,err)=>{console.error("scan job failed",job?.id,err);void reportWorkerHealth("degraded",{queue:"market-scan",job:job?.name,error:err.message});});notifyWorker.on("failed",(job,err)=>{console.error("notification job failed",job?.id,err);void reportWorkerHealth("degraded",{queue:"notification-delivery",job:job?.name,error:err.message});});
 scanWorker.on("completed",job=>{const result=job.returnvalue as {error?:string;failed?:number}|{error?:string}[]|undefined;const failures=Array.isArray(result)?result.filter(item=>item.error).length:typeof result==="object"&&result!==null&&"failed" in result?Number(result.failed):0;void reportWorkerHealth(failures>0?"degraded":"ok",{queue:"market-scan",lastJob:job.name,failures});});notifyWorker.on("completed",job=>void reportWorkerHealth("ok",{queue:"notification-delivery",lastJob:job.name}));
 await reportWorkerHealth("ok",{startedAt:new Date().toISOString()});
 if(process.env.RUN_INITIAL_BACKFILL==="true"){const start=process.env.BACKFILL_START??"missing";const end=process.env.BACKFILL_END??"missing";const jobId=`historical-backfill-${start}-${end}`.replace(/[^a-zA-Z0-9_-]/g,"_");await scanQueue.add("backfill",{}, {jobId,removeOnComplete:100,removeOnFail:500});}
 await scanQueue.add("ingest",{}, {repeat:{every:300_000},removeOnComplete:100,removeOnFail:500});
 await scanQueue.add("evaluate",{}, {repeat:{every:60_000},removeOnComplete:100,removeOnFail:500});
 await scanQueue.add("paper",{}, {repeat:{every:60_000},removeOnComplete:100,removeOnFail:500});
 await scanQueue.add("backtests",{}, {repeat:{every:30_000},removeOnComplete:100,removeOnFail:500});
 await notificationQueue.add("deliver",{}, {repeat:{every:10_000},removeOnComplete:100,removeOnFail:500});
 console.log("Signal Engine workers started. Strategy configs remain disabled by default.");
 const shutdown=async()=>{await scanWorker.close();await notifyWorker.close();await scanQueue.close();await notificationQueue.close();await connection.quit();process.exit(0);};process.on("SIGINT",()=>void shutdown());process.on("SIGTERM",()=>void shutdown());
}
void start().catch(error=>{console.error(error);process.exit(1);});
