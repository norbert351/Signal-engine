from dataclasses import replace
from decimal import Decimal
from typing import Literal
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, model_validator
from .backtest import Bar, Setup, breakdowns, simulate, summarize, chronological_split, walk_forward
from .models import CostModel, COST_MODEL_VERSION
from .strategies import generate_setups

app = FastAPI(title="Signal Engine Research API", version="0.1.0")

class BarInput(BaseModel):
    timestamp: int
    close_timestamp: int
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal = Decimal("0")
    @model_validator(mode="after")
    def validate_ohlc(self):
        if self.close_timestamp<=self.timestamp:
            raise ValueError("Candle close_timestamp must follow open timestamp")
        if min(self.open,self.high,self.low,self.close)<=0 or self.high < max(self.open, self.close, self.low) or self.low > min(self.open, self.close, self.high):
            raise ValueError("Invalid OHLC bounds")
        return self

class SetupInput(BaseModel):
    signal_time: int
    direction: Literal["long", "short"]
    stop: Decimal
    target: Decimal
    risk_fraction: Decimal = Decimal("0.01")
    target2: Decimal | None = None
    target1_allocation_pct: Decimal = Decimal("100")
    target2_allocation_pct: Decimal = Decimal("0")
    @model_validator(mode="after")
    def validate_setup(self):
        if self.risk_fraction<=0 or self.target1_allocation_pct<0 or self.target1_allocation_pct>100 or self.target2_allocation_pct<0 or self.target2_allocation_pct>100:
            raise ValueError("Invalid risk fraction or target allocation")
        if self.direction=="long" and self.target<=self.stop or self.direction=="short" and self.target>=self.stop:
            raise ValueError("Target and stop are on invalid sides")
        if self.target2 is None and self.target1_allocation_pct!=Decimal("100"):
            raise ValueError("A single target must allocate 100 percent")
        if self.target2 is not None:
            if self.direction=="long" and self.target2<=self.target or self.direction=="short" and self.target2>=self.target:
                raise ValueError("Second target must be beyond the first target")
            if self.target1_allocation_pct+self.target2_allocation_pct!=Decimal("100"):
                raise ValueError("Target allocations must sum to 100 percent")
        return self

class CostsInput(BaseModel):
    fee_bps_per_side: Decimal = Field(ge=0)
    spread_bps: Decimal = Field(ge=0)
    slippage_bps: Decimal = Field(ge=0)
    funding_bps_per_8h: Decimal = Field(default=Decimal("0"), ge=0)

class BacktestInput(BaseModel):
    strategy_key: str
    strategy_params: dict = Field(default_factory=dict)
    evaluation_start: int | None = None
    evaluation_end: int | None = None
    symbol: str = "unknown"
    timeframe: str = "unknown"
    trading_style: str | None = None
    expiry_bars: int | None = Field(default=None, ge=1)
    bars: list[BarInput]
    trend_bars: list[BarInput] = Field(default_factory=list)
    setups: list[SetupInput] | None = None
    costs: CostsInput

@app.get("/health")
def health():
    return {"status": "ok", "service": "signal-engine-research"}

def bar_interval(bars: list[Bar]) -> int:
    intervals = [later.timestamp - earlier.timestamp for earlier, later in zip(bars, bars[1:]) if later.timestamp > earlier.timestamp]
    if not intervals:
        raise ValueError("cannot infer bar interval")
    return sorted(intervals)[len(intervals) // 2]


@app.post("/backtests")
def run_backtest(payload: BacktestInput):
    try:
        bars = [Bar(**item.model_dump()) for item in payload.bars]
        trend_bars = [Bar(**item.model_dump()) for item in payload.trend_bars]
        params = {**payload.strategy_params}
        if payload.expiry_bars is not None:
            params["expiryBars"] = payload.expiry_bars
        if payload.setups is not None:
            setups = [Setup(**item.model_dump()) for item in payload.setups]
            if payload.expiry_bars is not None and bars:
                interval = bar_interval(bars)
                close_by_time = {
                    bar.timestamp: bar.close_timestamp if bar.close_timestamp is not None else bar.timestamp
                    for bar in bars
                }
                setups = [
                    replace(
                        setup,
                        expires_at=close_by_time.get(setup.signal_time, setup.signal_time) + payload.expiry_bars * interval,
                    )
                    for setup in setups
                ]
        else:
            setups = generate_setups(payload.strategy_key, bars, trend_bars, params)
        setups = [
            replace(setup, symbol=payload.symbol, timeframe=payload.timeframe, trading_style=payload.trading_style)
            for setup in setups
        ]
        evaluation_bars=[b for b in bars if (payload.evaluation_start is None or b.timestamp>=payload.evaluation_start) and (payload.evaluation_end is None or (b.close_timestamp is not None and b.close_timestamp<=payload.evaluation_end))]
        evaluation_times={b.timestamp for b in evaluation_bars}
        setups=[s for s in setups if s.signal_time in evaluation_times]
        costs = CostModel(**payload.costs.model_dump())
        zero_costs = CostModel(fee_bps_per_side=Decimal("0"), spread_bps=Decimal("0"), slippage_bps=Decimal("0"), funding_bps_per_8h=Decimal("0"))
        train, validation, out_of_sample = chronological_split(evaluation_bars)
        def segment_metrics(segment, model):
            timestamps = {bar.timestamp for bar in segment}
            selected = [setup for setup in setups if setup.signal_time in timestamps]
            trades = simulate(segment, selected, model)
            return summarize(trades), trades
        gross_overall, _ = segment_metrics(evaluation_bars, zero_costs)
        net_overall, net_trades = segment_metrics(evaluation_bars, costs)
        def run_segment(segment):
            _, g = segment_metrics(segment, zero_costs)
            s, n = segment_metrics(segment, costs)
            return {"gross": summarize(g), "net": s}
        gross_train, _ = segment_metrics(train, zero_costs); net_train, _ = segment_metrics(train, costs)
        gross_val, _ = segment_metrics(validation, zero_costs); net_val, _ = segment_metrics(validation, costs)
        gross_oos, _ = segment_metrics(out_of_sample, zero_costs); net_oos, _ = segment_metrics(out_of_sample, costs)
        assumptions = {
            **payload.costs.model_dump(mode="json"),
            "version": COST_MODEL_VERSION,
            "explicit": True,
            "market": "crypto_perpetual" if ("USDT" in payload.symbol or payload.symbol.endswith("USD")) and payload.symbol.replace("_","").isupper() and "_" not in payload.symbol else ("forex_or_metals" if "_" in payload.symbol or payload.symbol.endswith("USD") else "unknown"),
        }
        return {
            "metrics": {
                "overall": net_overall,
                "overallGross": gross_overall,
                "overallNet": net_overall,
                "train": net_train,
                "trainGross": gross_train,
                "validation": net_val,
                "validationGross": gross_val,
                "outOfSample": net_oos,
                "outOfSampleGross": gross_oos,
                "outOfSampleBars": len(out_of_sample),
                "evaluationBars": len(evaluation_bars),
                "breakdowns": breakdowns(net_trades),
                "breakdownsGross": breakdowns(simulate(evaluation_bars, setups, zero_costs)),
                "costModelVersion": COST_MODEL_VERSION,
            },
            "walkForward": walk_forward(evaluation_bars, setups, costs) if len(evaluation_bars) >= 40 else [],
            "walkForwardGross": walk_forward(evaluation_bars, setups, zero_costs) if len(evaluation_bars) >= 40 else [],
            "trades": [t.__dict__ for t in net_trades],
            "generatedSetupCount": len(setups),
            "assumptions": assumptions,
        }
    except (ValueError, ArithmeticError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
