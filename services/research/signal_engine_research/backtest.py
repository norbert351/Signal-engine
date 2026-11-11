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
    close_timestamp: int | None = None
    volume: Decimal = Decimal("0")

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
    expires_at: int | None = None
    symbol: str | None = None
    timeframe: str | None = None
    trading_style: str | None = None

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
    reward_risk: Decimal = Decimal("0")
    symbol: str | None = None
    timeframe: str | None = None
    trading_style: str | None = None

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
        position_costs = CostModel(**{**costs.model_dump(), "funding_bps_per_8h": costs.funding_bps_per_8h if is_long else -costs.funding_bps_per_8h})
        risk = entry - setup.stop if is_long else setup.stop - entry
        if risk <= 0 or (is_long and entry >= setup.target) or (not is_long and entry <= setup.target):
            continue
        reward = abs(setup.target - entry)
        reward_risk = reward / risk
        targets = [(setup.target, setup.target1_allocation_pct if setup.target2 is not None else Decimal("100"))]
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
        last_close = entry_bar.close
        last_close_time = entry_bar.close_timestamp if entry_bar.close_timestamp is not None else entry_bar.timestamp
        for future_index, future in enumerate(ordered[i + 1:], start=i + 1):
            future_close_time = future.close_timestamp if future.close_timestamp is not None else future.timestamp
            if setup.expires_at is not None and future_close_time > setup.expires_at:
                exit_price = last_close
                exit_time = last_close_time
                gross = (exit_price - entry) / entry if is_long else (entry - exit_price) / entry
                holding_hours = Decimal(exit_time - entry_bar.timestamp) / Decimal("3600000")
                realized_gross += remaining / Decimal("100") * gross
                realized_net += remaining / Decimal("100") * calculate_net_return(gross, position_costs, holding_hours)
                remaining = Decimal("0")
                reason = "expired"
                next_available_index = future_index
                closed = True
                break
            last_close = future.close
            last_close_time = future_close_time
            stop_hit = future.low <= setup.stop if is_long else future.high >= setup.stop
            if stop_hit:
                exit_price = min(setup.stop, future.open) if is_long else max(setup.stop, future.open)
                exit_time = future.close_timestamp if future.close_timestamp is not None else future.timestamp
                gross = (exit_price - entry) / entry if is_long else (entry - exit_price) / entry
                holding_hours = Decimal(exit_time - entry_bar.timestamp) / Decimal("3600000")
                realized_gross += remaining / Decimal("100") * gross
                realized_net += remaining / Decimal("100") * calculate_net_return(gross, position_costs, holding_hours)
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
                holding_hours = Decimal((future.close_timestamp if future.close_timestamp is not None else future.timestamp) - entry_bar.timestamp) / Decimal("3600000")
                realized_gross += portion / Decimal("100") * gross
                realized_net += portion / Decimal("100") * calculate_net_return(gross, position_costs, holding_hours)
                remaining -= portion
                exit_price, exit_time = target, (future.close_timestamp if future.close_timestamp is not None else future.timestamp)
                target_index += 1
            if remaining <= Decimal("0.0001"):
                remaining = Decimal("0")
                reason = "target"
                next_available_index = future_index + 1
                closed = True
                break
        if not closed:
            future = ordered[-1]
            exit_price, exit_time = future.close, (future.close_timestamp if future.close_timestamp is not None else future.timestamp)
            if remaining > 0:
                gross = (exit_price - entry) / entry if is_long else (entry - exit_price) / entry
                holding_hours = Decimal(exit_time - entry_bar.timestamp) / Decimal("3600000")
                realized_gross += remaining / Decimal("100") * gross
                realized_net += remaining / Decimal("100") * calculate_net_return(gross, position_costs, holding_hours)
            reason = "data_end"
            next_available_index = len(ordered)
        trades.append(
            Trade(
                setup.direction,
                entry_bar.timestamp,
                exit_time,
                entry,
                exit_price,
                realized_gross,
                realized_net,
                reason,
                reward_risk,
                setup.symbol,
                setup.timeframe,
                setup.trading_style,
            )
        )
    return trades

def summarize(trades: list[Trade]) -> dict[str, str | int]:
    if not trades:
        return {
            "trades": 0,
            "win_rate": "0",
            "profit_factor": "0",
            "expectancy": "0",
            "average_win": "0",
            "average_loss": "0",
            "payoff_ratio": "0",
            "sharpe_ratio": "0",
            "sortino_ratio": "0",
            "average_holding_hours": "0",
            "max_drawdown": "0",
            "net_return": "0",
            "consecutive_losses": 0,
            "average_reward_risk": "0",
            "gross_win": "0",
            "gross_loss": "0",
            "stop_trades": 0,
            "target_trades": 0,
            "expired_trades": 0,
        }
    wins = [t.net_return for t in trades if t.net_return > 0]
    losses = [t.net_return for t in trades if t.net_return < 0]
    gross_win = sum(wins, Decimal("0"))
    gross_loss = abs(sum(losses, Decimal("0")))
    returns = [t.net_return for t in trades]
    count = Decimal(len(returns))
    mean = sum(returns, Decimal("0")) / count
    variance = sum(((value - mean) ** 2 for value in returns), Decimal("0")) / count
    standard_deviation = variance.sqrt()
    downside = [min(value, Decimal("0")) for value in returns]
    downside_variance = sum((value**2 for value in downside), Decimal("0")) / count
    downside_deviation = downside_variance.sqrt()
    root_count = count.sqrt()
    equity = peak = Decimal("1")
    max_dd = Decimal("0")
    for trade in trades:
        equity *= Decimal("1") + trade.net_return
        peak = max(peak, equity)
        if peak > 0:
            max_dd = max(max_dd, (peak - equity) / peak)
    average_win = gross_win / Decimal(len(wins)) if wins else Decimal("0")
    average_loss = gross_loss / Decimal(len(losses)) if losses else Decimal("0")
    holding_hours = [Decimal(t.exit_time - t.entry_time) / Decimal("3600000") for t in trades]
    streak = 0
    worst_streak = 0
    for trade in sorted(trades, key=lambda item: item.exit_time):
        if trade.net_return < 0:
            streak += 1
            worst_streak = max(worst_streak, streak)
        else:
            streak = 0
    reward_risks = [t.reward_risk for t in trades if t.reward_risk > 0]
    average_reward_risk = sum(reward_risks, Decimal("0")) / Decimal(len(reward_risks)) if reward_risks else Decimal("0")
    return {
        "trades": len(trades),
        "win_rate": str(Decimal(len(wins)) / count),
        "profit_factor": str(gross_win / gross_loss) if gross_loss else ("Infinity" if gross_win else "0"),
        "expectancy": str(mean),
        "average_win": str(average_win),
        "average_loss": str(average_loss),
        "payoff_ratio": str(average_win / average_loss) if average_loss else ("Infinity" if average_win else "0"),
        "sharpe_ratio": str(mean / standard_deviation * root_count) if standard_deviation else "0",
        "sortino_ratio": str(mean / downside_deviation * root_count) if downside_deviation else "0",
        "average_holding_hours": str(sum(holding_hours, Decimal("0")) / count),
        "max_drawdown": str(max_dd),
        "net_return": str(equity - Decimal("1")),
        "consecutive_losses": worst_streak,
        "average_reward_risk": str(average_reward_risk),
        "gross_win": str(gross_win),
        "gross_loss": str(gross_loss),
        "stop_trades": sum(1 for trade in trades if trade.exit_reason == "stop"),
        "target_trades": sum(1 for trade in trades if trade.exit_reason == "target"),
        "expired_trades": sum(1 for trade in trades if trade.exit_reason == "expired"),
    }


def breakdowns(trades: list[Trade]) -> dict[str, dict[str, dict[str, str | int]]]:
    groups: dict[str, dict[str, list[Trade]]] = {"byInstrument": {}, "byTimeframe": {}, "byTradingStyle": {}}
    for trade in trades:
        for name, key in (
            ("byInstrument", trade.symbol or "unknown"),
            ("byTimeframe", trade.timeframe or "unknown"),
            ("byTradingStyle", trade.trading_style or "unknown"),
        ):
            groups[name].setdefault(key, []).append(trade)
    return {
        name: {key: summarize(items) for key, items in sorted(buckets.items())}
        for name, buckets in groups.items()
    }

def chronological_split(bars: list[Bar], train: Decimal = Decimal("0.6"), validation: Decimal = Decimal("0.2")) -> tuple[list[Bar], list[Bar], list[Bar]]:
    if train <= 0 or validation <= 0 or train + validation >= 1:
        raise ValueError("split fractions must be positive and leave an out-of-sample segment")
    ordered = sorted(bars, key=lambda b: b.timestamp)
    a = int(len(ordered) * train)
    b = a + int(len(ordered) * validation)
    return ordered[:a], ordered[a:b], ordered[b:]


def walk_forward(
    bars: list[Bar], setups: list[Setup], costs: CostModel, folds: int = 4
) -> list[dict[str, object]]:
    if folds < 2:
        raise ValueError("walk-forward requires at least two folds")
    ordered = sorted(bars, key=lambda bar: bar.timestamp)
    if len(ordered) < folds * 10:
        raise ValueError("insufficient bars for walk-forward folds")
    size = len(ordered) // folds
    results: list[dict[str, object]] = []
    for fold in range(folds):
        start = fold * size
        end = len(ordered) if fold == folds - 1 else (fold + 1) * size
        segment = ordered[start:end]
        timestamps = {bar.timestamp for bar in segment}
        selected = [setup for setup in setups if setup.signal_time in timestamps]
        results.append(
            {
                "fold": fold + 1,
                "start": segment[0].timestamp,
                "end": segment[-1].timestamp,
                "bars": len(segment),
                **summarize(simulate(segment, selected, costs)),
            }
        )
    return results
