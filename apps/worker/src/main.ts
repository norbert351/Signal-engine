import { Worker } from "bullmq";
import { connection,scanQueue,notificationQueue } from "./queues.js";
import { ingestAll } from "./ingestion.js";
import { processScan } from "./scanner.js";
import { deliverPending } from "./telegram.js";
async function start(){
 const scanWorker=new Worker("market-scan",async job=>{if(job.name==="ingest")return ingestAll();return processScan();},{connection,concurrency:1});
 const notifyWorker=new Worker("notification-delivery",async()=>deliverPending(),{connection,concurrency:2});
 scanWorker.on("failed",(job,err)=>console.error("scan job failed",job?.id,err));notifyWorker.on("failed",(job,err)=>console.error("notification job failed",job?.id,err));
 await scanQueue.add("ingest",{}, {repeat:{every:60_000},removeOnComplete:100,removeOnFail:500});
 await scanQueue.add("evaluate",{}, {repeat:{every:60_000},removeOnComplete:100,removeOnFail:500});
 await notificationQueue.add("deliver",{}, {repeat:{every:10_000},removeOnComplete:100,removeOnFail:500});
 console.log("Signal Engine workers started. Strategy configs remain disabled by default.");
 const shutdown=async()=>{await scanWorker.close();await notifyWorker.close();await scanQueue.close();await notificationQueue.close();await connection.quit();process.exit(0);};process.on("SIGINT",()=>void shutdown());process.on("SIGTERM",()=>void shutdown());
}
void start().catch(error=>{console.error(error);process.exit(1);});
