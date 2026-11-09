from decimal import Decimal
from .models import Candle, CostModel

def net_return(gross_return: Decimal, costs: CostModel, holding_hours: Decimal = Decimal("0")) -> Decimal:
 """Net fractional PnL after a transparent round-trip cost estimate."""
 round_trip_bps = costs.fee_bps_per_side * 2 + costs.spread_bps + costs.slippage_bps * 2
 funding_bps = costs.funding_bps_per_8h * (holding_hours / Decimal("8"))
 return gross_return - (round_trip_bps + funding_bps) / Decimal("10000")

def completed_candles(candles: list[Candle]) -> list[Candle]:
 """Only completed candles may enter signal logic, ordered chronologically."""
 ordered = sorted((c for c in candles if c.complete), key=lambda c: c.close_time)
 if len({c.close_time for c in ordered}) != len(ordered): raise ValueError("duplicate candle close_time")
 return ordered
