import { getDueNotifications,updateNotification } from "@signal-engine/database/scanner-repository";
import { db } from "@signal-engine/database";
import { eq } from "drizzle-orm";
import { signals } from "@signal-engine/database";
const token=process.env.TELEGRAM_BOT_TOKEN;
const escapeHtml=(value:string)=>value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
export async function deliverPending(){if(!token)return {delivered:0,skipped:"TELEGRAM_BOT_TOKEN_missing"};const pending=await getDueNotifications();let delivered=0;
 for(const item of pending){const [signal]=await db.select().from(signals).where(eq(signals.id,item.signalId)).limit(1);if(!signal){await updateNotification(item.id,{status:"failed",attempts:item.attempts+1,lastError:"Signal record missing"});continue;}
  const targets=signal.targets as Array<{price:string;rewardRisk:string}>;const textMessage=[`<b>${escapeHtml(signal.market.toUpperCase())} ${escapeHtml(signal.symbol)} ${escapeHtml(signal.direction)}</b>`,`Timeframe: ${signal.timeframe}`,`Entry: ${signal.entryMin}${signal.entryMin===signal.entryMax?"":` - ${signal.entryMax}`}`,`Stop loss: ${signal.stopLoss}`, ...targets.map((t,i)=>`TP${i+1}: ${t.price}${t.allocationPct!==undefined?` (${t.allocationPct}% allocation)`:""}`),`Reward/risk: ${signal.rewardRisk}`,`Reason: ${(signal.rationale as string[]).map(escapeHtml).join("; ")}`,`Expires: ${signal.expiresAt.toISOString()}`,`Signal only. No trade has been placed.`].join("\n");
  try{const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:item.destination,text:textMessage,parse_mode:"HTML",disable_web_page_preview:true}),signal:AbortSignal.timeout(10000)});const payload=await response.json() as {ok:boolean;result?:{message_id:number};description?:string};if(!response.ok||!payload.ok)throw new Error(payload.description??`Telegram HTTP ${response.status}`);await updateNotification(item.id,{status:"delivered",attempts:item.attempts+1,deliveredAt:new Date(),providerMessageId:String(payload.result?.message_id??"")});delivered++;}
  catch(error){const attempts=item.attempts+1;const exhausted=attempts>=8;const delay=Math.min(60*60_000,2**attempts*5000);await updateNotification(item.id,{status:exhausted?"failed":"pending",attempts,nextAttemptAt:new Date(Date.now()+delay),lastError:error instanceof Error?error.message:"Telegram delivery error"});}
 }
 return {delivered,checked:pending.length};
}
