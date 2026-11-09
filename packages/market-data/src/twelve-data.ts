import { fetchWithRetry } from "./http.js";
import type { CandleInterval, MarketDataProvider, NormalizedCandle } from "./index.js";
const resolutions:Record<CandleInterval,string>={"1m":"1min","5m":"5min","15m":"15min","1h":"1h","4h":"4h","1d":"1day"};
type TwelveValue={datetime:string;open:string;high:string;low:string;close:string;volume?:string};
export class TwelveDataProvider implements MarketDataProvider {
 readonly name="twelve_data";
 constructor(private readonly apiKey=process.env.TWELVE_DATA_API_KEY,private readonly baseUrl="https://api.twelvedata.com"){}
 async fetchCandles(symbol:string,interval:CandleInterval,limit=500):Promise<NormalizedCandle[]> {
  if(!this.apiKey) throw new Error("TWELVE_DATA_API_KEY is required");
  const url=new URL("/time_series",this.baseUrl);url.searchParams.set("symbol",symbol.replace("_","/"));url.searchParams.set("interval",resolutions[interval]);url.searchParams.set("outputsize",String(Math.min(Math.max(limit,1),5000)));url.searchParams.set("apikey",this.apiKey);url.searchParams.set("timezone","UTC");
  const res=await fetchWithRetry(url,{},12000);if(!res.ok)throw new Error(`Twelve Data request failed: HTTP ${res.status}`);
  const body=await res.json() as {values?:TwelveValue[];status?:string;message?:string};if(!body.values)throw new Error(body.message??"Malformed Twelve Data response");
  const ms={"1m":60000,"5m":300000,"15m":900000,"1h":3600000,"4h":14400000,"1d":86400000}[interval];
  return body.values.map(v=>{const open=new Date(v.datetime+"Z");const close=new Date(open.getTime()+ms-1);return {provider:this.name,market:"forex",symbol,interval,openTime:open,closeTime:close,open:v.open,high:v.high,low:v.low,close:v.close,volume:v.volume??null,complete:close.getTime()<Date.now()};}).reverse();
 }
 async fetchCandlesRange(symbol:string,interval:CandleInterval,startTime:number,endTime:number):Promise<NormalizedCandle[]>{
  if(!this.apiKey)throw new Error("TWELVE_DATA_API_KEY is required");if(startTime>=endTime)throw new Error("Invalid historical range");const url=new URL("/time_series",this.baseUrl);url.searchParams.set("symbol",symbol.replace("_","/"));url.searchParams.set("interval",resolutions[interval]);url.searchParams.set("start_date",new Date(startTime).toISOString());url.searchParams.set("end_date",new Date(endTime).toISOString());url.searchParams.set("outputsize","5000");url.searchParams.set("timezone","UTC");url.searchParams.set("order","ASC");url.searchParams.set("apikey",this.apiKey);const res=await fetchWithRetry(url,{},20000);if(!res.ok)throw new Error(`Twelve Data historical request failed: HTTP ${res.status}`);const body=await res.json() as {values?:TwelveValue[];message?:string};if(!body.values)throw new Error(body.message??"Malformed Twelve Data historical response");const ms={"1m":60000,"5m":300000,"15m":900000,"1h":3600000,"4h":14400000,"1d":86400000}[interval];return body.values.map(v=>{const open=new Date(v.datetime+"Z");const close=new Date(open.getTime()+ms-1);return {provider:this.name,market:"forex",symbol,interval,openTime:open,closeTime:close,open:v.open,high:v.high,low:v.low,close:v.close,volume:v.volume??null,complete:close.getTime()<Date.now()};}).filter(v=>v.openTime.getTime()>=startTime&&v.openTime.getTime()<endTime);
 }
}
