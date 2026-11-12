import fs from 'fs';
import path from 'path';
import {evaluateStrategy, DEFAULT_STRATEGY_CONFIG} from '../../packages/core/dist/index.js';

const fixturesDir = path.resolve('tests/parity/fixtures');
const files = fs.readdirSync(fixturesDir).filter(f=>f.endsWith('.json')).sort();
const out = { version: 1, strategies: {} };
for (const file of files) {
  const fx = JSON.parse(fs.readFileSync(path.join(fixturesDir,file),'utf8'));
  const results = [];
  const {strategyKey, entryBars, trendBars, params, timeframe, symbol} = fx;
  for (let i=0;i<entryBars.length;i++) {
    const entryCandles = entryBars.slice(0,i+1).map(b=>({openTime:b.t,closeTime:b.ct,open:b.o,high:b.h,low:b.l,close:b.c,volume:b.v??0,complete:b.complete!==false}));
    const last = entryCandles[entryCandles.length-1];
    const trendCandles = trendBars.map(b=>({openTime:b.t,closeTime:b.ct,open:b.o,high:b.h,low:b.l,close:b.c,volume:b.v??0,complete:b.complete!==false})).filter(c=>c.closeTime<=last.closeTime);
    let res;
    try { res = evaluateStrategy(strategyKey,{symbol:symbol||'TEST',timeframe:timeframe||'1h',entryCandles,trendCandles}, params||{}); } catch(e){ res = {error:String(e)}; }
    if (res && !res.error) {
      results.push({index:i,triggerCloseTime:res.triggerCloseTime,direction:res.direction,entry:res.candidate.entry,stop:res.candidate.stopLoss,targets:res.candidate.targets,rr:(res.direction==='LONG'?(res.candidate.targets[0]-res.candidate.entry)/(res.candidate.entry-res.candidate.stopLoss):(res.candidate.entry-res.candidate.targets[0])/(res.candidate.stopLoss-res.candidate.entry))});
    } else if (res && res.error) {
      results.push({index:i,error:res.error});
    }
  }
  out.strategies[strategyKey] = out.strategies[strategyKey] || [];
  out.strategies[strategyKey].push({fixture:fx.name||file, params: params||{}, results});
}
process.stdout.write(JSON.stringify(out));
