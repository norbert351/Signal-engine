from dataclasses import dataclass
from decimal import Decimal
from typing import Literal
from .models import CostModel
from .engine import net_return as calculate_net_return

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
    target2: Decimal | None = None
    target1_allocation_pct: Decimal = Decimal("50")
    target2_allocation_pct: Decimal = Decimal("50")

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
    """Enter next bar open, model partial targets, and resolve ambiguous bars stop-first."""
    ordered = sorted(bars, key=lambda b: b.timestamp)
    if len({b.timestamp for b in ordered}) != len(ordered):
        raise ValueError("bar timestamps must be unique")
    setup_by_time = {s.signal_time: s for s in setups}
    trades: list[Trade] = []
    next_available_index = 0
    for i, bar in enumerate(ordered[:-1]):
        setup = setup_by_time.get(bar.timestamp)
        if setup is None or i + 1 < next_available_index:
            continue
        entry_bar = ordered[i + 1]
        entry = entry_bar.open
        is_long = setup.direction == "long"
        risk = entry - setup.stop if is_long else setup.stop - entry
        if risk <= 0 or (is_long and entry >= setup.target) or (not is_long and entry <= setup.target):
            continue
        targets = [(setup.target, setup.target1_allocation_pct)]
        if setup.target2 is not None:
            targets.append((setup.target2, setup.target2_allocation_pct))
        remaining = Decimal("100")
        realized_gross = Decimal("0")
        realized_net = Decimal("0")
        target_index = 0
        exit_price = entry
        exit_time = entry_bar.timestamp
        reason = "data_end"
        closed = False
        for future_index, future in enumerate(ordered[i + 1:], start=i + 1):
            stop_hit = future.low <= setup.stop if is_long else future.high >= setup.stop
            if stop_hit:
                exit_price = min(setup.stop, future.open) if is_long else max(setup.stop, future.open)
                exit_time = future.timestamp
                gross = (exit_price - entry) / entry if is_long else (entry - exit_price) / entry
                holding_hours = Decimal(exit_time - entry_bar.timestamp) / Decimal("3600000")
                realized_gross += remaining / Decimal("100") * gross
                realized_net += remaining / Decimal("100") * calculate_net_return(gross, costs, holding_hours)
                remaining = Decimal("0")
                reason = "stop"
                next_available_index = future_index + 1
                closed = True
                break
            while target_index < len(targets):
                target, allocation = targets[target_index]
                target_hit = future.high >= target if is_long else future.low <= target
                if not target_hit:
                    break
                portion = min(remaining, allocation)
                gross = (target - entry) / entry if is_long else (entry - target) / entry
                holding_hours = Decimal(future.timestamp - entry_bar.timestamp) / Decimal("3600000")
                realized_gross += portion / Decimal("100") * gross
                realized_net += portion / Decimal("100") * calculate_net_return(gross, costs, holding_hours)
                remaining -= portion
                exit_price, exit_time = target, future.timestamp
                target_index += 1
            if remaining <= Decimal("0.0001"):
                remaining = Decimal("0")
                reason = "target"
                next_available_index = future_index + 1
                closed = True
                break
        if not closed:
            future = ordered[-1]
            exit_price, exit_time = future.close, future.timestamp
            if remaining > 0:
                gross = (exit_price - entry) / entry if is_long else (entry - exit_price) / entry
                holding_hours = Decimal(exit_time - entry_bar.timestamp) / Decimal("3600000")
                realized_gross += remaining / Decimal("100") * gross
                realized_net += remaining / Decimal("100") * calculate_net_return(gross, costs, holding_hours)
            reason = "data_end"
            next_available_index = len(ordered)
        trades.append(Trade(setup.direction, entry_bar.timestamp, exit_time, entry, exit_price, realized_gross, realized_net, reason))
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
