from decimal import Decimal
from typing import Literal
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, model_validator
from .backtest import Bar, Setup, simulate, summarize, chronological_split
from .models import CostModel
from .strategies import generate_setups

app = FastAPI(title="Signal Engine Research API", version="0.1.0")

class BarInput(BaseModel):
    timestamp: int
    close_timestamp: int
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
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
    fee_bps_per_side: Decimal = Field(default=Decimal("5"), ge=0)
    spread_bps: Decimal = Field(default=Decimal("2"), ge=0)
    slippage_bps: Decimal = Field(default=Decimal("2"), ge=0)
    funding_bps_per_8h: Decimal = Decimal("0")

class BacktestInput(BaseModel):
    strategy_key: str
    strategy_params: dict = Field(default_factory=dict)
    evaluation_start: int | None = None
    evaluation_end: int | None = None
    bars: list[BarInput]
    trend_bars: list[BarInput] = Field(default_factory=list)
    setups: list[SetupInput] | None = None
    costs: CostsInput = Field(default_factory=CostsInput)

@app.get("/health")
def health():
    return {"status": "ok", "service": "signal-engine-research"}

@app.post("/backtests")
def run_backtest(payload: BacktestInput):
    try:
        bars = [Bar(**item.model_dump()) for item in payload.bars]
        setups = [Setup(**item.model_dump()) for item in payload.setups] if payload.setups is not None else generate_setups(payload.strategy_key,bars,[Bar(**item.model_dump()) for item in payload.trend_bars],payload.strategy_params)
        if payload.evaluation_start is not None: setups=[s for s in setups if s.signal_time>=payload.evaluation_start]
        if payload.evaluation_end is not None: setups=[s for s in setups if s.signal_time<=payload.evaluation_end]
        evaluation_bars=[b for b in bars if (payload.evaluation_start is None or b.timestamp>=payload.evaluation_start) and (payload.evaluation_end is None or b.timestamp<=payload.evaluation_end)]
        costs = CostModel(**payload.costs.model_dump())
        train, validation, out_of_sample = chronological_split(evaluation_bars)
        def run_segment(segment):
            timestamps = {bar.timestamp for bar in segment}
            selected = [setup for setup in setups if setup.signal_time in timestamps]
            return summarize(simulate(segment, selected, costs))
        trades = simulate(evaluation_bars, setups, costs)
        return {
            "metrics": {
                "overall": summarize(trades),
                "train": run_segment(train),
                "validation": run_segment(validation),
                "outOfSample": run_segment(out_of_sample),
                "outOfSampleBars": len(out_of_sample),
                "evaluationBars": len(evaluation_bars),
            },
            "trades": [t.__dict__ for t in trades],
            "generatedSetupCount": len(setups),
            "assumptions": payload.costs.model_dump(mode="json"),
        }
    except (ValueError, ArithmeticError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
