from datetime import datetime
from decimal import Decimal
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

COST_MODEL_VERSION = "costs-v1"
REQUIRED_COST_FIELDS = ("fee_bps_per_side", "spread_bps", "slippage_bps", "funding_bps_per_8h")

class Candle(BaseModel):
 model_config = ConfigDict(frozen=True)
 symbol: str
 timeframe: str
 open_time: datetime
 close_time: datetime
 open: Decimal
 high: Decimal
 low: Decimal
 close: Decimal
 volume: Decimal = Decimal("0")
 complete: bool = False
 @model_validator(mode="after")
 def validate_ohlc(self):
  if self.high < max(self.open, self.close, self.low): raise ValueError("high must bound OHLC")
  if self.low > min(self.open, self.close, self.high): raise ValueError("low must bound OHLC")
  return self

class CostModel(BaseModel):
 fee_bps_per_side: Decimal = Field(ge=0)
 spread_bps: Decimal = Field(ge=0)
 slippage_bps: Decimal = Field(ge=0)
 funding_bps_per_8h: Decimal = Field(default=Decimal("0"))

class BacktestRequest(BaseModel):
 strategy_key: str
 strategy_version: int = Field(ge=1)
 symbol: str
 timeframe: str
 start: datetime
 end: datetime
 costs: CostModel
 direction: Literal["long", "short", "both"] = "both"
