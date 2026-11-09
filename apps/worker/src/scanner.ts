import { evaluateEmaPullback,evaluateBreakoutRetest } from "@signal-engine/core/strategies";
import { validateRisk } from "@signal-engine/core/risk";
import { findEnabledStrategies,findInstrument,readRecentCandles,publishSignal } from "@signal-engine/database/scanner-repository";
import type { Candle } from "@signal-engine/core";
const toCore=(rows:Array<{openTime:Date;closeTime:Date;open:string;high:string;low:string;close:string;isComplete:boolean}>):Candle[]=>rows.map(r=>({openTime:r.openTime.getTime(),closeTime:r.closeTime.getTime(),open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),complete:r.isComplete}));
export async function processScan(){
 const strategies=await findEnabledStrategies();if(!strategies.length)return {evaluated:0,published:0,reason:"no_enabled_strategies"};
 let evaluated=0,published=0;const crypto=(process.env.CRYPTO_SYMBOLS??"BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,LTCUSDT").split(",");const forex=(process.env.FOREX_SYMBOLS??"EUR_USD,GBP_USD,USD_JPY,AUD_USD,USD_CAD,USD_CHF,NZD_USD,EUR_GBP,EUR_JPY,GBP_JPY").split(",");
 for(const symbol of [...crypto,...forex]){const provider=symbol.includes("_")?"oanda_v20":"binance_usdm";const instrument=await findInstrument(provider,symbol)??(provider==="oanda_v20"?await findInstrument("twelve_data",symbol):undefined);if(!instrument)continue;
  for(const timeframe of ["5m","4h"]){const trendTf=timeframe==="5m"?"15m":"1d";const [entryRows,trendRows]=await Promise.all([readRecentCandles(instrument.id,timeframe,350),readRecentCandles(instrument.id,trendTf,350)]);const entry=toCore(entryRows),trend=toCore(trendRows);if(!entry.length||!trend.length)continue;const maxAge=timeframe==="5m"?15*60_000:12*60*60_000;if(Date.now()-entry[entry.length-1]!.closeTime>maxAge||Date.now()-trend[trend.length-1]!.closeTime>(timeframe==="5m"?45*60_000:36*60*60_000))continue;
   for(const strategy of strategies){const params=(strategy.parameters??{}) as Record<string,number>;const result=strategy.key==="ema-trend-pullback"?evaluateEmaPullback({symbol,timeframe,entryCandles:entry,trendCandles:trend},params):strategy.key==="range-breakout-retest"?evaluateBreakoutRetest({symbol,timeframe,entryCandles:entry,trendCandles:trend},params):undefined;if(!result)continue;evaluated++;
    const risk=(strategy.riskConfig??{}) as {minimumRewardRisk?:number;maximumStopDistancePct?:number;maxTargets?:number};const policy=validateRisk(result.direction,result.candidate.entry,result.candidate.stopLoss,result.candidate.targets,{minimumRewardRisk:risk.minimumRewardRisk??2,maximumStopDistancePct:risk.maximumStopDistancePct??5,maxTargets:risk.maxTargets??3});if(!policy.valid)continue;
    const rr=policy.rewardRisk[0]??0;const trigger=new Date(result.triggerCloseTime);const expiry=new Date(trigger.getTime()+(timeframe==="5m"?30*60_000:48*60*60_000));const signal=await publishSignal({dedupeKey:`${symbol}:${timeframe}:${strategy.key}:v${strategy.version}:${result.triggerCloseTime}`,instrumentId:instrument.id,strategyConfigId:strategy.id,market:instrument.market,symbol,direction:result.direction,entry:result.candidate.entry,stop:result.candidate.stopLoss,targets:result.candidate.targets,rr,timeframe,rationale:result.candidate.rationale,publishedAt:new Date(),expiresAt:expiry});if(signal)published++;
   }
  }
 }
 return {evaluated,published};
}
