import json, os, glob
from decimal import Decimal
from signal_engine_research.backtest import Bar
from signal_engine_research.strategies import generate_setups

def entry_price_from(setup, bars):
    for b in bars:
        if b.timestamp == setup.signal_time:
            return b.close
    return None

fixtures_dir = os.environ.get('PARITY_FIXTURES','tests/parity/fixtures')
out = {"version":1,"strategies":{}}
for path in sorted(glob.glob(os.path.join(fixtures_dir,'*.json'))):
    fx = json.load(open(path))
    key = fx['strategyKey']
    entry = [Bar(int(b['t']), Decimal(str(b['o'])), Decimal(str(b['h'])), Decimal(str(b['l'])), Decimal(str(b['c'])), int(b.get('ct', b['t']+1)), Decimal(str(b.get('v',0)))) for b in fx['entryBars']]
    trend = [Bar(int(b['t']), Decimal(str(b['o'])), Decimal(str(b['h'])), Decimal(str(b['l'])), Decimal(str(b['c'])), int(b.get('ct', b['t']+1)), Decimal(str(b.get('v',0)))) for b in fx['trendBars']]
    params = fx.get('params') or {}
    try:
        setups = generate_setups(key, entry, trend, params)
        by_time = {}
        for s in setups:
            epx = entry_price_from(s, entry)
            if epx is None:
                continue
            risk = epx - s.stop if s.direction=='long' else s.stop - epx
            rr = abs((s.target - epx) / risk) if risk != 0 else Decimal('0')
            idx = next((i for i,b in enumerate(entry) if b.timestamp==s.signal_time), None)
            tct = next((b.close_timestamp if b.close_timestamp is not None else b.timestamp for b in entry if b.timestamp==s.signal_time), s.signal_time)
            by_time[s.signal_time] = {
                "index": idx,
                "triggerCloseTime": tct,
                "direction": "LONG" if s.direction=='long' else 'SHORT',
                "entry": str(epx),
                "stop": str(s.stop),
                "targets": [str(s.target), str(s.target2) if s.target2 is not None else None],
                "rr": str(rr)
            }
        results = list(by_time.values())
    except Exception as e:
        results = [{"error": str(e)}]
    out['strategies'].setdefault(key, []).append({"fixture": fx.get('name') or os.path.basename(path), "params": params, "results": results})

print(json.dumps(out))
