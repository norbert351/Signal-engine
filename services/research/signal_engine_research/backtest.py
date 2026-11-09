from dataclasses import dataclass
from decimal import Decimal
from typing import Literal
from .models import CostModel

@dataclass(frozen=True)
class Bar:
    timestamp: int
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal

@dataclass(frozen=True)
class Setup:
    signal_time: int
    direction: Literal["long", "short"]
    stop: Decimal
    target: Decimal
    risk_fraction: Decimal

@dataclass(frozen=True)
class Trade:
    direction: str
    entry_time: int
    exit_time: int
    entry: Decimal
    exit: Decimal
    gross_return: Decimal
    net_return: Decimal
    exit_reason: str

def simulate(bars: list[Bar], setups: list[Setup], costs: CostModel) -> list[Trade]:
    """Enter at the next bar open. If stop and target hit in one bar, assume stop first."""
    ordered = sorted(bars, key=lambda b: b.timestamp)
    if len({b.timestamp for b in ordered}) != len(ordered):
        raise ValueError("bar timestamps must be unique")
    setup_by_time = {s.signal_time: s for s in setups}
    trades: list[Trade] = []
    for i, bar in enumerate(ordered[:-1]):
        setup = setup_by_time.get(bar.timestamp)
        if setup is None:
            continue
        entry_bar = ordered[i + 1]
        entry = entry_bar.open
        is_long = setup.direction == "long"
        risk = entry - setup.stop if is_long else setup.stop - entry
        if risk <= 0:
            continue
        exit_price: Decimal | None = None
        exit_time = entry_bar.timestamp
        reason = ""
        for future in ordered[i + 1:]:
            stop_hit = future.low <= setup.stop if is_long else future.high >= setup.stop
            target_hit = future.high >= setup.target if is_long else future.low <= setup.target
            if stop_hit:
                exit_price, exit_time, reason = setup.stop, future.timestamp, "stop"
                break
            if target_hit:
                exit_price, exit_time, reason = setup.target, future.timestamp, "target"
                break
        if exit_price is None:
            future = ordered[-1]
            exit_price, exit_time, reason = future.close, future.timestamp, "data_end"
        gross = (exit_price - entry) / entry if is_long else (entry - exit_price) / entry
        net = gross - (costs.fee_bps_per_side * 2 + costs.spread_bps + costs.slippage_bps * 2) / Decimal("10000")
        trades.append(Trade(setup.direction, entry_bar.timestamp, exit_time, entry, exit_price, gross, net, reason))
    return trades

def summarize(trades: list[Trade]) -> dict[str, str | int]:
    if not trades:
        return {"trades": 0, "win_rate": "0", "profit_factor": "0", "expectancy": "0", "max_drawdown": "0", "net_return": "0"}
    wins = [t.net_return for t in trades if t.net_return > 0]
    losses = [t.net_return for t in trades if t.net_return < 0]
    gross_win = sum(wins, Decimal("0"))
    gross_loss = abs(sum(losses, Decimal("0")))
    equity = peak = Decimal("1")
    max_dd = Decimal("0")
    for trade in trades:
        equity *= Decimal("1") + trade.net_return
        peak = max(peak, equity)
        if peak > 0:
            max_dd = max(max_dd, (peak - equity) / peak)
    return {"trades": len(trades), "win_rate": str(Decimal(len(wins)) / Decimal(len(trades))), "profit_factor": str(gross_win / gross_loss) if gross_loss else ("Infinity" if gross_win else "0"), "expectancy": str(sum((t.net_return for t in trades), Decimal("0")) / Decimal(len(trades))), "max_drawdown": str(max_dd), "net_return": str(equity - Decimal("1"))}

def chronological_split(bars: list[Bar], train: Decimal = Decimal("0.6"), validation: Decimal = Decimal("0.2")) -> tuple[list[Bar], list[Bar], list[Bar]]:
    if train <= 0 or validation <= 0 or train + validation >= 1:
        raise ValueError("split fractions must be positive and leave an out-of-sample segment")
    ordered = sorted(bars, key=lambda b: b.timestamp)
    a = int(len(ordered) * train)
    b = a + int(len(ordered) * validation)
    return ordered[:a], ordered[a:b], ordered[b:]
