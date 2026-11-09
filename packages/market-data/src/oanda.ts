import { fetchWithRetry } from "./http.js";
import type { CandleInterval, MarketDataProvider, NormalizedCandle } from "./index.js";
const oandaGranularity: Record<CandleInterval,string> = {"1m":"M1","5m":"M5","15m":"M15","1h":"H1","4h":"H4","1d":"D"};
type OandaCandle = { time:string; complete:boolean; volume:number; mid?:{o:string;h:string;l:string;c:string} };
export class OandaV20Provider implements MarketDataProvider {
 readonly name="oanda_v20";
 constructor(private readonly token=process.env.OANDA_API_TOKEN, private readonly baseUrl=process.env.OANDA_BASE_URL ?? "https://api-fxpractice.oanda.com") {}
 async fetchCandles(symbol:string, interval:CandleInterval, limit=500):Promise<NormalizedCandle[]> {
  if(!this.token) throw new Error("OANDA_API_TOKEN is required for forex data");
  if(!/^[A-Z]{3}_[A-Z]{3}$/.test(symbol)) throw new Error("Invalid OANDA instrument");
  if(!Number.isInteger(limit)||limit<1||limit>5000) throw new Error("limit must be 1..5000");
  const url=new URL(`/v3/instruments/${symbol}/candles`,this.baseUrl); url.searchParams.set("granularity",oandaGranularity[interval]); url.searchParams.set("count",String(limit)); url.searchParams.set("price","M");
  const res=await fetchWithRetry(url,{Authorization:`Bearer ${this.token}`,Accept:"application/json"},12000);
  if(!res.ok) throw new Error(`OANDA candle request failed: HTTP ${res.status}`);
  const body=await res.json() as {candles?:OandaCandle[]}; if(!Array.isArray(body.candles)) throw new Error("Malformed OANDA candle response");
  return body.candles.filter(c=>c.mid).map(c=>{const open=new Date(c.time);const close=new Date(open.getTime()+intervalMillis(interval)-1);return {provider:this.name,market:"forex",symbol,interval,openTime:open,closeTime:close,open:c.mid!.o,high:c.mid!.h,low:c.mid!.l,close:c.mid!.c,volume:String(c.volume),complete:c.complete};});
 }
 async fetchCandlesRange(symbol:string,interval:CandleInterval,startTime:number,endTime:number):Promise<NormalizedCandle[]>{
  if(!this.token)throw new Error("OANDA_API_TOKEN is required for forex data");if(!/^[A-Z]{3}_[A-Z]{3}$/.test(symbol))throw new Error("Invalid OANDA instrument");if(!Number.isFinite(startTime)||!Number.isFinite(endTime)||startTime>=endTime)throw new Error("Invalid historical range");const output:NormalizedCandle[]=[];let cursor=startTime;let pages=0;
  while(cursor<endTime&&pages<100){const url=new URL(`/v3/instruments/${symbol}/candles`,this.baseUrl);url.searchParams.set("granularity",oandaGranularity[interval]);url.searchParams.set("from",new Date(cursor).toISOString());url.searchParams.set("to",new Date(endTime).toISOString());url.searchParams.set("count","5000");url.searchParams.set("price","M");const res=await fetchWithRetry(url,{Authorization:`Bearer ${this.token}`,Accept:"application/json"},20000);if(!res.ok)throw new Error(`OANDA historical request failed: HTTP ${res.status}`);const body=await res.json() as {candles?:OandaCandle[]};if(!Array.isArray(body.candles)||body.candles.length===0)break;for(const c of body.candles){if(!c.mid)continue;const open=new Date(c.time);const close=new Date(open.getTime()+intervalMillis(interval)-1);output.push({provider:this.name,market:"forex",symbol,interval,openTime:open,closeTime:close,open:c.mid.o,high:c.mid.h,low:c.mid.l,close:c.mid.c,volume:String(c.volume),complete:c.complete});}const last=body.candles[body.candles.length-1]!;const next=new Date(last.time).getTime()+intervalMillis(interval);if(!Number.isFinite(next)||next<=cursor)throw new Error("OANDA pagination did not advance");cursor=next;pages++;}
  if(pages>=100&&cursor<endTime)throw new Error("OANDA historical range exceeded the 100-page safety limit");return output;
 }
}
function intervalMillis(i:CandleInterval):number {return {"1m":60000,"5m":300000,"15m":900000,"1h":3600000,"4h":14400000,"1d":86400000}[i];}
