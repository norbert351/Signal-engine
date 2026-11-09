import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "./index.js";
import { candles, instruments, notificationOutbox, signals, strategyConfigs } from "./schema.js";
export async function listInstruments(){return db.select().from(instruments).orderBy(instruments.market,instruments.symbol);}
export async function listSignals(filters:{market?:string;symbol?:string;status?:string;limit?:number}){
 const conditions=[];if(filters.market)conditions.push(eq(signals.market,filters.market));if(filters.symbol)conditions.push(eq(signals.symbol,filters.symbol));if(filters.status)conditions.push(eq(signals.status,filters.status));
 return db.select().from(signals).where(conditions.length?and(...conditions):undefined).orderBy(desc(signals.publishedAt)).limit(Math.min(Math.max(filters.limit??50,1),200));
}
export async function upsertInstrument(input:{provider:string;market:string;symbol:string;baseAsset?:string;quoteAsset?:string;enabled?:boolean}){
 const [row]=await db.insert(instruments).values(input).onConflictDoUpdate({target:[instruments.provider,instruments.symbol],set:{market:input.market,baseAsset:input.baseAsset,quoteAsset:input.quoteAsset,enabled:input.enabled??false,updatedAt:new Date()}}).returning();return row;
}
export async function storeCandles(instrumentId:string,source:string,rows:Array<{timeframe:string;openTime:Date;closeTime:Date;open:string;high:string;low:string;close:string;volume:string|null;complete:boolean}>){
 if(!rows.length)return 0;const inserted=await db.insert(candles).values(rows.map(c=>({...c,instrumentId,source}))).onConflictDoNothing().returning({id:candles.id});return inserted.length;
}
export async function getEnabledStrategies(){return db.select().from(strategyConfigs).where(eq(strategyConfigs.enabled,true));}
export async function enqueueTelegram(signalId:string,destination:string){return db.insert(notificationOutbox).values({signalId,destination,channel:"telegram"}).onConflictDoNothing().returning();}
