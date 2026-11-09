import { ema, onlyClosedCandles, rewardRisk, type Candle, type Direction, type SignalCandidate } from "./index.js";
export type StrategyContext={symbol:string;timeframe:string;trendCandles:Candle[];entryCandles:Candle[]};
export type StrategyConfig={emaFast:number;emaSlow:number;atrPeriod:number;stopAtrMultiple:number;minRewardRisk:number;rangeLookback:number;retestToleranceAtr:number};
export type StrategyResult={strategyKey:string;direction:Direction;candidate:SignalCandidate;triggerCloseTime:number};
const defaults:StrategyConfig={emaFast:20,emaSlow:50,atrPeriod:14,stopAtrMultiple:1.5,minRewardRisk:2,rangeLookback:20,retestToleranceAtr:0.25};
function trueRanges(c:Candle[]):number[]{return c.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-c[i]!.close),Math.abs(x.low-c[i]!.close)));}
function latestAtr(c:Candle[],p:number):number|undefined{const r=trueRanges(c);if(r.length<p)return;return r.slice(-p).reduce((a,b)=>a+b,0)/p;}
function trendDirection(c:Candle[],cfg:StrategyConfig):Direction|undefined{const closes=c.map(x=>x.close);const f=ema(closes,cfg.emaFast),s=ema(closes,cfg.emaSlow);if(!f.length||!s.length)return;const fast=f.at(-1)!,slow=s.at(-1)!,last=closes.at(-1)!;if(fast>slow&&last>fast)return "LONG";if(fast<slow&&last<fast)return "SHORT";}
function buildCandidate(direction:Direction,entry:number,stop:number,atr:number,timeframe:string,rationale:string[],minimum:number):SignalCandidate|undefined{const risk=direction==="LONG"?entry-stop:stop-entry;if(risk<=0)return;const target=direction==="LONG"?entry+risk*minimum:entry-risk*minimum;return {direction,entry,stopLoss:stop,targets:[target, direction==="LONG"?entry+risk*3:entry-risk*3],timeframe,rationale};}
export function evaluateEmaPullback(context:StrategyContext,overrides:Partial<StrategyConfig>={}):StrategyResult|undefined{
 const cfg={...defaults,...overrides};const bars=onlyClosedCandles(context.entryCandles);if(bars.length<cfg.emaSlow+2)return;const trend=onlyClosedCandles(context.trendCandles).filter(c=>c.closeTime<=bars[bars.length-1]!.closeTime);if(trend.length<cfg.emaSlow+2)return;
 const direction=trendDirection(trend,cfg);if(!direction)return;const closes=bars.map(x=>x.close),fast=ema(closes,cfg.emaFast);if(fast.length<2)return;
 const last=bars.at(-1)!,prior=bars.at(-2)!,fastNow=fast.at(-1)!;const pulled=direction==="LONG"?prior.low<=fast.at(-2)!*1.002&&last.close>fastNow&&last.close>last.open:prior.high>=fast.at(-2)!*0.998&&last.close<fastNow&&last.close<last.open;
 if(!pulled)return;const atr=latestAtr(bars,cfg.atrPeriod);if(!atr||atr<=0)return;const structural=direction==="LONG"?Math.min(...bars.slice(-cfg.atrPeriod).map(x=>x.low)):Math.max(...bars.slice(-cfg.atrPeriod).map(x=>x.high));const stop=direction==="LONG"?Math.min(structural,last.close-atr*cfg.stopAtrMultiple):Math.max(structural,last.close+atr*cfg.stopAtrMultiple);
 const candidate=buildCandidate(direction,last.close,stop,atr,context.timeframe,["Higher timeframe EMA trend aligned", "Pullback reclaimed the fast EMA on a completed candle"],cfg.minRewardRisk);if(!candidate||rewardRisk(direction,candidate.entry,candidate.stopLoss,candidate.targets[0]!)<cfg.minRewardRisk)return;
 return {strategyKey:"ema-trend-pullback",direction,candidate,triggerCloseTime:last.closeTime};
}
export function evaluateBreakoutRetest(context:StrategyContext,overrides:Partial<StrategyConfig>={}):StrategyResult|undefined{
 const cfg={...defaults,...overrides};const bars=onlyClosedCandles(context.entryCandles);if(bars.length<cfg.rangeLookback+3)return;const trend=onlyClosedCandles(context.trendCandles).filter(c=>c.closeTime<=bars[bars.length-1]!.closeTime);if(trend.length<cfg.emaSlow+2)return;
 const direction=trendDirection(trend,cfg);if(!direction)return;const prior=bars.slice(-(cfg.rangeLookback+2),-2),breakout=bars.at(-2)!,last=bars.at(-1)!;const ceiling=Math.max(...prior.map(x=>x.high)),floor=Math.min(...prior.map(x=>x.low));const atr=latestAtr(bars,cfg.atrPeriod);if(!atr||atr<=0)return;
 const tolerance=atr*cfg.retestToleranceAtr;let valid=false,stop=0;
 if(direction==="LONG"&&breakout.close>ceiling&&last.low<=ceiling+tolerance&&last.close>ceiling&&last.close>last.open){valid=true;stop=Math.min(last.low,ceiling-tolerance);}
 if(direction==="SHORT"&&breakout.close<floor&&last.high>=floor-tolerance&&last.close<floor&&last.close<last.open){valid=true;stop=Math.max(last.high,floor+tolerance);}
 if(!valid)return;const candidate=buildCandidate(direction,last.close,stop,atr,context.timeframe,["Higher timeframe trend aligned","Range breakout followed by a completed-candle retest"],cfg.minRewardRisk);if(!candidate||rewardRisk(direction,candidate.entry,candidate.stopLoss,candidate.targets[0]!)<cfg.minRewardRisk)return;
 return {strategyKey:"range-breakout-retest",direction,candidate,triggerCloseTime:last.closeTime};
}
