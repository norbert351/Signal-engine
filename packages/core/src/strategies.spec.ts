import {describe,it,expect} from "vitest";
import {evaluateEmaPullback,evaluateBreakoutRetest} from "./strategies.js";
import type {Candle} from "./index.js";
function series(n:number,step:number,offset=0):Candle[]{return Array.from({length:n},(_,i)=>{const close=100+offset+i*step;return {openTime:i*300000,closeTime:(i+1)*300000,open:close-step*.2,high:close+step*.3,low:close-step*.4,close,complete:true};});}
describe("strategy evaluators",()=>{it("does not evaluate an incomplete candle",()=>{const bars=series(80,.2);bars[bars.length-1]!.complete=false;expect(evaluateEmaPullback({symbol:"BTCUSDT",timeframe:"5m",trendCandles:series(80,.2),entryCandles:bars})).toBeUndefined();});it("returns no breakout when there is no confirmed retest",()=>{expect(evaluateBreakoutRetest({symbol:"BTCUSDT",timeframe:"5m",trendCandles:series(80,.2),entryCandles:series(80,.2)})).toBeUndefined();});});
