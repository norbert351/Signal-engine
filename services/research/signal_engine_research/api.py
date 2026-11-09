from decimal import Decimal
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from .backtest import Bar, Setup, simulate, summarize
from .models import CostModel

app = FastAPI(title="Signal Engine Research API", version="0.1.0")

class BarInput(BaseModel):
    timestamp: int
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal

class SetupInput(BaseModel):
    signal_time: int
    direction: str
    stop: Decimal
    target: Decimal
    risk_fraction: Decimal = Decimal("0.01")

class CostsInput(BaseModel):
    fee_bps_per_side: Decimal = Field(default=Decimal("5"), ge=0)
    spread_bps: Decimal = Field(default=Decimal("2"), ge=0)
    slippage_bps: Decimal = Field(default=Decimal("2"), ge=0)
    funding_bps_per_8h: Decimal = Decimal("0")

class BacktestInput(BaseModel):
    bars: list[BarInput]
    setups: list[SetupInput]
    costs: CostsInput = CostsInput()

@app.get("/health")
def health():
    return {"status": "ok", "service": "signal-engine-research"}

@app.post("/backtests")
def run_backtest(payload: BacktestInput):
    try:
        bars = [Bar(**item.model_dump()) for item in payload.bars]
        setups = [Setup(**item.model_dump()) for item in payload.setups]
        costs = CostModel(**payload.costs.model_dump())
        trades = simulate(bars, setups, costs)
        return {"metrics": summarize(trades), "trades": [t.__dict__ for t in trades], "assumptions": payload.costs.model_dump(mode="json")}
    except (ValueError, ArithmeticError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
