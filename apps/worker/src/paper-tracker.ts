import { and,asc,eq,gt,inArray } from "drizzle-orm";
import { db } from "@signal-engine/database";
import { candles,paperTrades,signalEvents,signals } from "@signal-engine/database";
export async function processPaperTrades(){
 const candidates=await db.select().from(signals).where(inArray(signals.status,["published","active"])).limit(500);let opened=0,closed=0;
 for(const signal of candidates){const existingRows=await db.select().from(paperTrades).where(eq(paperTrades.signalId,signal.id)).limit(1);const existing=existingRows[0];
  const start=existing?.entryTime??signal.publishedAt;
  const bars=await db.select().from(candles).where(and(eq(candles.instrumentId,signal.instrumentId),eq(candles.timeframe,signal.timeframe),eq(candles.isComplete,true),gt(candles.openTime,start))).orderBy(asc(candles.openTime)).limit(300);
  if(!existing){const first=bars[0];if(!first)continue;const [created]=await db.insert(paperTrades).values({signalId:signal.id,status:"open",direction:signal.direction,entryPrice:first.open,entryTime:first.openTime}).onConflictDoNothing().returning();if(!created)continue;opened++;await db.update(signals).set({status:"active"}).where(eq(signals.id,signal.id));await db.insert(signalEvents).values({signalId:signal.id,eventType:"paper_entry",payload:{entryPrice:first.open,entryTime:first.openTime.toISOString()}});}
  const trade=existing??(await db.select().from(paperTrades).where(eq(paperTrades.signalId,signal.id)).limit(1))[0];if(!trade)continue;
  const target=Number((signal.targets as Array<{price:string}>)[0]?.price);const stop=Number(signal.stopLoss);const entry=Number(trade.entryPrice);let outcome:string|undefined,exitPrice:number|undefined,exitTime:Date|undefined;
  for(const bar of bars){if(bar.openTime<=trade.entryTime)continue;const long=signal.direction==="LONG";const stopHit=long?Number(bar.low)<=stop:Number(bar.high)>=stop;const targetHit=long?Number(bar.high)>=target:Number(bar.low)<=target;if(stopHit){outcome="stop";exitPrice=stop;exitTime=bar.closeTime;break;}if(targetHit){outcome="target";exitPrice=target;exitTime=bar.closeTime;break;}}
  if(outcome&&exitPrice!==undefined&&exitTime){const gross=signal.direction==="LONG"?(exitPrice-entry)/entry:(entry-exitPrice)/entry;const costBps=Number(process.env.PAPER_ROUND_TRIP_COST_BPS??"12");const net=gross-costBps/10000;await db.update(paperTrades).set({status:"closed",exitPrice:String(exitPrice),exitTime,outcome,netReturn:String(net)}).where(eq(paperTrades.id,trade.id));await db.update(signals).set({status:outcome==="target"?"target_hit":"stopped"}).where(eq(signals.id,signal.id));await db.insert(signalEvents).values({signalId:signal.id,eventType:"paper_exit",payload:{outcome,exitPrice,netReturn:net,exitTime:exitTime.toISOString(),assumedRoundTripCostBps:costBps}});closed++;}
 }
 return {opened,closed,checked:candidates.length};
}
