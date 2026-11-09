from decimal import Decimal
from bisect import bisect_right
from .backtest import Bar, Setup

def ema_series(values: list[Decimal], period: int) -> list[Decimal | None]:
    if period < 1:
        raise ValueError("EMA period must be positive")
    out: list[Decimal | None] = [None] * len(values)
    if len(values) < period:
        return out
    current = sum(values[:period], Decimal("0")) / Decimal(period)
    out[period - 1] = current
    alpha = Decimal("2") / Decimal(period + 1)
    for i in range(period, len(values)):
        current = values[i] * alpha + current * (Decimal("1") - alpha)
        out[i] = current
    return out

def atr_at(bars: list[Bar], index: int, period: int) -> Decimal | None:
    if period < 1 or index < period:
        return None
    ranges=[]
    for i in range(index-period+1,index+1):
        previous=bars[i-1].close
        ranges.append(max(bars[i].high-bars[i].low,abs(bars[i].high-previous),abs(bars[i].low-previous)))
    return sum(ranges,Decimal("0"))/Decimal(period)

def trend_at(bars: list[Bar], timestamp: int, fast_period: int, slow_period: int) -> str | None:
    available=[bar for bar in bars if bar.timestamp<=timestamp]
    if len(available)<slow_period:
        return None
    fast=ema_series([b.close for b in available],fast_period)[-1]
    slow=ema_series([b.close for b in available],slow_period)[-1]
    if fast is None or slow is None:
        return None
    last=available[-1].close
    if fast>slow and last>fast:
        return "long"
    if fast<slow and last<fast:
        return "short"
    return None

def trend_lookup(bars: list[Bar], fast_period: int, slow_period: int) -> tuple[list[int], list[str | None]]:
    fast=ema_series([b.close for b in bars],fast_period)
    slow=ema_series([b.close for b in bars],slow_period)
    directions=[]
    for i,bar in enumerate(bars):
        if fast[i] is None or slow[i] is None: directions.append(None)
        elif fast[i]>slow[i] and bar.close>fast[i]: directions.append("long")
        elif fast[i]<slow[i] and bar.close<fast[i]: directions.append("short")
        else: directions.append(None)
    return [b.timestamp for b in bars],directions

def lookup_trend(times: list[int],directions: list[str | None],timestamp: int) -> str | None:
    index=bisect_right(times,timestamp)-1
    return directions[index] if index>=0 else None

def generate_setups(strategy_key: str, bars: list[Bar], trend_bars: list[Bar], params: dict) -> list[Setup]:
    bars=sorted(bars,key=lambda b:b.timestamp)
    trend_bars=sorted(trend_bars,key=lambda b:b.timestamp)
    if len({b.timestamp for b in bars})!=len(bars) or len({b.timestamp for b in trend_bars})!=len(trend_bars):
        raise ValueError("candle timestamps must be unique")
    fast=int(params.get("emaFast",20));slow=int(params.get("emaSlow",50));atr_period=int(params.get("atrPeriod",14));min_rr=Decimal(str(params.get("minRewardRisk",2)));stop_mult=Decimal(str(params.get("stopAtrMultiple",1.5)))
    if fast<1 or slow<=fast or atr_period<1 or min_rr<=0 or stop_mult<=0:
        raise ValueError("invalid strategy parameters")
    closes=[b.close for b in bars];fast_ema=ema_series(closes,fast);trend_times,trend_directions=trend_lookup(trend_bars,fast,slow);setups=[]
    if strategy_key=="ema-trend-pullback":
        start=max(slow,atr_period+1,2)
        for i in range(start,len(bars)-1):
            direction=lookup_trend(trend_times,trend_directions,bars[i].timestamp)
            if not direction or fast_ema[i] is None or fast_ema[i-1] is None:continue
            previous,current=bars[i-1],bars[i]
            atr=atr_at(bars,i,atr_period)
            if atr is None or atr<=0:continue
            if direction=="long" and previous.low<=fast_ema[i-1]*Decimal("1.002") and current.close>fast_ema[i] and current.close>current.open:
                structural=min(b.low for b in bars[max(0,i-atr_period+1):i+1]);stop=min(structural,current.close-atr*stop_mult);risk=current.close-stop
                if risk>0:setups.append(Setup(current.timestamp,"long",stop,current.close+risk*min_rr,Decimal("0.01")))
            if direction=="short" and previous.high>=fast_ema[i-1]*Decimal("0.998") and current.close<fast_ema[i] and current.close<current.open:
                structural=max(b.high for b in bars[max(0,i-atr_period+1):i+1]);stop=max(structural,current.close+atr*stop_mult);risk=stop-current.close
                if risk>0:setups.append(Setup(current.timestamp,"short",stop,current.close-risk*min_rr,Decimal("0.01")))
    elif strategy_key=="range-breakout-retest":
        lookback=int(params.get("rangeLookback",20));tolerance_mult=Decimal(str(params.get("retestToleranceAtr",0.25)))
        if lookback<2 or tolerance_mult<0:raise ValueError("invalid breakout parameters")
        for i in range(max(lookback+1,slow,atr_period+1),len(bars)-1):
            direction=trend_at(trend_bars,bars[i].timestamp,fast,slow)
            if not direction:continue
            atr=atr_at(bars,i,atr_period)
            if atr is None or atr<=0:continue
            range_bars=bars[i-lookback-1:i-1];breakout,current=bars[i-1],bars[i]
            ceiling=max(b.high for b in range_bars);floor=min(b.low for b in range_bars);tolerance=atr*tolerance_mult
            if direction=="long" and breakout.close>ceiling and current.low<=ceiling+tolerance and current.close>ceiling and current.close>current.open:
                stop=min(current.low,ceiling-tolerance);risk=current.close-stop
                if risk>0:setups.append(Setup(current.timestamp,"long",stop,current.close+risk*min_rr,Decimal("0.01")))
            if direction=="short" and breakout.close<floor and current.high>=floor-tolerance and current.close<floor and current.close<current.open:
                stop=max(current.high,floor+tolerance);risk=stop-current.close
                if risk>0:setups.append(Setup(current.timestamp,"short",stop,current.close-risk*min_rr,Decimal("0.01")))
    else:
        raise ValueError(f"Unsupported strategy key: {strategy_key}")
    return setups
