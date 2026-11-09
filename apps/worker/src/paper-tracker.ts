import { and,asc,eq,gt,inArray,lte } from "drizzle-orm";
import { db } from "@signal-engine/database";
import { candles,paperTrades,signalEvents,signals } from "@signal-engine/database";
const returnAfterCosts=(direction:string,entry:number,exit:number,costBps:number)=>((direction==="LONG"?(exit-entry)/entry:(entry-exit)/entry)-costBps/10000);
export async function processPaperTrades(){
 const candidates=await db.select().from(signals).where(inArray(signals.status,["published","active"])).limit(500);let opened=0,closed=0,partialExits=0;
 for(const signal of candidates){const existingRows=await db.select().from(paperTrades).where(eq(paperTrades.signalId,signal.id)).limit(1);const existing=existingRows[0];
  if(!existing&&signal.expiresAt<=new Date()){await db.update(signals).set({status:"expired"}).where(eq(signals.id,signal.id));await db.insert(signalEvents).values({signalId:signal.id,eventType:"expired",payload:{reason:"expired_before_paper_entry"}});continue;}
  const start=existing?.entryTime??signal.publishedAt;
  const bars=await db.select().from(candles).where(and(eq(candles.instrumentId,signal.instrumentId),eq(candles.timeframe,signal.timeframe),eq(candles.isComplete,true),gt(candles.openTime,start),lte(candles.closeTime,signal.expiresAt))).orderBy(asc(candles.openTime)).limit(300);
  if(!existing){const first=bars[0];if(!first)continue;const [created]=await db.insert(paperTrades).values({signalId:signal.id,status:"open",direction:signal.direction,entryPrice:first.open,entryTime:first.openTime,targetIndex:0,remainingPct:"100",realizedReturn:"0"}).onConflictDoNothing().returning();if(!created)continue;opened++;await db.update(signals).set({status:"active"}).where(eq(signals.id,signal.id));await db.insert(signalEvents).values({signalId:signal.id,eventType:"paper_entry",payload:{entryPrice:first.open,entryTime:first.openTime.toISOString(),entryRule:"first candle open after publication"}});}
  const trade=existing??(await db.select().from(paperTrades).where(eq(paperTrades.signalId,signal.id)).limit(1))[0];if(!trade)continue;
  const targets=signal.targets as Array<{price:string;allocationPct?:number}>;const entry=Number(trade.entryPrice),stop=Number(signal.stopLoss),costBps=Number(process.env.PAPER_ROUND_TRIP_COST_BPS??"12");let targetIndex=trade.targetIndex,remaining=Number(trade.remainingPct),realized=Number(trade.realizedReturn);let outcome:string|undefined,exitPrice:number|undefined,exitTime:Date|undefined;
  for(const bar of bars){const long=signal.direction==="LONG";const stopHit=long?Number(bar.low)<=stop:Number(bar.high)>=stop;
   if(stopHit){exitPrice=long?Math.min(stop,Number(bar.open)):Math.max(stop,Number(bar.open));exitTime=bar.closeTime;realized+=remaining/100*returnAfterCosts(signal.direction,entry,exitPrice,costBps);remaining=0;outcome="stop";break;}
   while(targetIndex<targets.length){const target=Number(targets[targetIndex]!.price);const hit=long?Number(bar.high)>=target:Number(bar.low)<=target;if(!hit)break;const allocation=Math.min(remaining,targets[targetIndex]!.allocationPct??100/targets.length);realized+=allocation/100*returnAfterCosts(signal.direction,entry,target,costBps);remaining-=allocation;targetIndex++;partialExits++;await db.insert(signalEvents).values({signalId:signal.id,eventType:"paper_target",payload:{targetIndex,price:target,allocationPct:allocation,remainingPct:remaining,realizedReturn:realized}});exitPrice=target;exitTime=bar.closeTime;if(remaining<=0.0001){remaining=0;outcome="target";break;}}
   if(outcome)break;
  }
  if(!outcome&&signal.expiresAt<=new Date()&&bars.length){const last=bars[bars.length-1]!;exitPrice=Number(last.close);exitTime=last.closeTime;realized+=remaining/100*returnAfterCosts(signal.direction,entry,exitPrice,costBps);remaining=0;outcome="expired";}
  if(outcome&&exitPrice!==undefined&&exitTime){await db.update(paperTrades).set({status:"closed",targetIndex,remainingPct:String(remaining),realizedReturn:String(realized),exitPrice:String(exitPrice),exitTime,outcome,netReturn:String(realized)}).where(eq(paperTrades.id,trade.id));await db.update(signals).set({status:outcome==="target"?"target_hit":outcome==="expired"?"expired":"stopped"}).where(eq(signals.id,signal.id));await db.insert(signalEvents).values({signalId:signal.id,eventType:"paper_exit",payload:{outcome,exitPrice,netReturn:realized,exitTime:exitTime.toISOString(),assumedRoundTripCostBps:costBps}});closed++;}
  else if(targetIndex!==trade.targetIndex||remaining!==Number(trade.remainingPct)){await db.update(paperTrades).set({targetIndex,remainingPct:String(remaining),realizedReturn:String(realized)}).where(eq(paperTrades.id,trade.id));}
 }
 return {opened,closed,partialExits,checked:candidates.length};
}
