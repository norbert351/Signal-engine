from __future__ import annotations

import math
from bisect import bisect_right
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Iterable

from .backtest import Bar, Setup

SUPPORTED_STRATEGIES = (
    "ema-trend-pullback",
    "range-breakout-retest",
    "support-resistance-rejection",
    "market-structure-continuation",
    "trend-reversal-momentum",
    "volatility-expansion-breakout",
)


@dataclass(frozen=True)
class StrategyEvaluation:
    strategy_key: str
    strategy_name: str
    strategy_version: int
    direction: str
    signal_time: int
    trigger_close_time: int
    entry: float
    stop: float
    targets: tuple[float, float]
    timeframe: str
    rationale: tuple[str, ...]
    invalidation: tuple[str, ...]
    evidence: dict[str, Any]
    score_factors: dict[str, float | None]
    score: float


def _num(value: Any) -> float:
    return float(value)


def _close_time(bar: Bar) -> int:
    return int(bar.close_timestamp if bar.close_timestamp is not None else bar.timestamp)


def _clamp(value: float) -> float:
    return min(1.0, max(0.0, value))


def _ema_compact(values: list[float], period: int) -> list[float]:
    if period < 1:
        raise ValueError("period must be positive")
    if len(values) < period:
        return []
    alpha = 2.0 / (period + 1.0)
    current = sum(values[:period]) / period
    out = [current]
    for value in values[period:]:
        current = value * alpha + current * (1.0 - alpha)
        out.append(current)
    return out


def _ema_aligned(values: list[float], period: int) -> list[float | None]:
    compact = _ema_compact(values, period)
    out: list[float | None] = [None] * len(values)
    if not compact:
        return out
    start = period - 1
    for index, value in enumerate(compact):
        out[start + index] = value
    return out


def _rsi(values: list[float], period: int = 14) -> float | None:
    if period < 1 or len(values) <= period:
        return None
    gain = 0.0
    loss = 0.0
    for index in range(1, period + 1):
        change = values[index] - values[index - 1]
        if change >= 0:
            gain += change
        else:
            loss -= change
    average_gain = gain / period
    average_loss = loss / period

    def value() -> float:
        if average_loss == 0:
            return 50.0 if average_gain == 0 else 100.0
        return 100.0 - 100.0 / (1.0 + average_gain / average_loss)

    current = value()
    for index in range(period + 1, len(values)):
        change = values[index] - values[index - 1]
        current_gain = change if change > 0 else 0.0
        current_loss = -change if change < 0 else 0.0
        average_gain = (average_gain * (period - 1) + current_gain) / period
        average_loss = (average_loss * (period - 1) + current_loss) / period
        current = value()
    return current


def _macd(values: list[float], fast: int = 12, slow: int = 26, signal_period: int = 9) -> dict[str, float | None] | None:
    if fast >= slow or len(values) <= slow:
        return None
    fast_values = _ema_aligned(values, fast)
    slow_values = _ema_aligned(values, slow)
    macd_line: list[float | None] = [
        None if a is None or b is None else a - b for a, b in zip(fast_values, slow_values)
    ]
    first_index = next((index for index, value in enumerate(macd_line) if value is not None), -1)
    if first_index < 0:
        return None
    compact = [value for value in macd_line[first_index:] if value is not None]
    signal_compact = _ema_compact(compact, signal_period)
    signal: list[float | None] = [None] * len(values)
    signal_start = first_index + signal_period - 1
    for index, value in enumerate(signal_compact):
        signal[signal_start + index] = value
    histogram: list[float | None] = [
        None if a is None or b is None else a - b for a, b in zip(macd_line, signal)
    ]
    if histogram[-1] is None:
        return None
    return {
        "histogram": histogram[-1],
        "previousHistogram": histogram[-2] if len(histogram) > 1 else None,
    }


def _true_range(bar: Bar, previous: Bar | None) -> float:
    high = _num(bar.high)
    low = _num(bar.low)
    if previous is None:
        return high - low
    previous_close = _num(previous.close)
    return max(high - low, abs(high - previous_close), abs(low - previous_close))


def _atr_series(candles: list[Bar], period: int = 14) -> list[float | None]:
    if period < 1 or len(candles) < period:
        return [None] * len(candles)
    ranges = [_true_range(bar, candles[index - 1] if index else None) for index, bar in enumerate(candles)]
    current = sum(ranges[:period]) / period
    out: list[float | None] = [None] * len(candles)
    out[period - 1] = current
    for index in range(period, len(ranges)):
        current = (current * (period - 1) + ranges[index]) / period
        out[index] = current
    return out


def _bollinger(values: list[float], period: int = 20, multiplier: float = 2.0) -> dict[str, list[float | None]]:
    if period < 1 or multiplier <= 0:
        raise ValueError("invalid Bollinger parameters")
    middle: list[float | None] = [None] * len(values)
    upper: list[float | None] = [None] * len(values)
    lower: list[float | None] = [None] * len(values)
    for index in range(period - 1, len(values)):
        window = values[index - period + 1 : index + 1]
        mean = sum(window) / period
        variance = sum((value - mean) ** 2 for value in window) / period
        deviation = math.sqrt(variance)
        middle[index] = mean
        upper[index] = mean + multiplier * deviation
        lower[index] = mean - multiplier * deviation
    return {"middle": middle, "upper": upper, "lower": lower}


def _relative_volume(candles: list[Bar], period: int = 20) -> float | None:
    if period < 1 or len(candles) < period + 1:
        return None
    volumes = [_num(bar.volume) for bar in candles]
    average = sum(volumes[-period - 1 : -1]) / period
    return volumes[-1] / average if average > 0 else None


def _find_swings(candles: list[Bar], left: int = 2, right: int = 2) -> list[dict[str, Any]]:
    if left < 1 or right < 1:
        raise ValueError("period must be positive")
    swings: list[dict[str, Any]] = []
    for index in range(left, len(candles) - right):
        candle = candles[index]
        is_high = True
        is_low = True
        for offset in range(index - left, index + right + 1):
            if offset == index:
                continue
            if _num(candles[offset].high) >= _num(candle.high):
                is_high = False
            if _num(candles[offset].low) <= _num(candle.low):
                is_low = False
        if is_high:
            swings.append({"index": index, "type": "high", "price": _num(candle.high), "time": _close_time(candle)})
        if is_low:
            swings.append({"index": index, "type": "low", "price": _num(candle.low), "time": _close_time(candle)})
    swings.sort(key=lambda swing: swing["index"])
    return swings


def _support_resistance(candles: list[Bar], lookback: int = 120, tolerance_pct: float = 0.005) -> dict[str, list[dict[str, Any]]]:
    if tolerance_pct <= 0:
        raise ValueError("tolerancePct must be positive")
    start = max(0, len(candles) - lookback)
    swings = [
        {**swing, "index": swing["index"] + start}
        for swing in _find_swings(candles[start:])
    ]
    current = _num(candles[-1].close) if candles else 0.0
    clusters: list[dict[str, Any]] = []
    for swing in swings:
        tolerance = swing["price"] * tolerance_pct
        existing = next((cluster for cluster in clusters if abs(cluster["price"] - swing["price"]) <= tolerance), None)
        if existing:
            existing["price"] = (existing["price"] * existing["touches"] + swing["price"]) / (existing["touches"] + 1)
            existing["touches"] += 1
        else:
            clusters.append(
                {
                    "price": swing["price"],
                    "touches": 1,
                    "type": "resistance" if swing["type"] == "high" else "support",
                }
            )
    supports = sorted(
        (cluster for cluster in clusters if cluster["price"] < current and cluster["type"] == "support"),
        key=lambda cluster: cluster["price"],
        reverse=True,
    )
    resistances = sorted(
        (cluster for cluster in clusters if cluster["price"] > current and cluster["type"] == "resistance"),
        key=lambda cluster: cluster["price"],
    )
    return {"supports": supports, "resistances": resistances}


def _analyze_market_structure(candles: list[Bar], left: int = 2, right: int = 2) -> dict[str, Any]:
    swings = _find_swings(candles, left, right)
    highs = [swing for swing in swings if swing["type"] == "high"]
    lows = [swing for swing in swings if swing["type"] == "low"]
    events: list[dict[str, Any]] = []
    for index in range(1, len(highs)):
        previous, current = highs[index - 1], highs[index]
        events.append(
            {
                "type": "HH" if current["price"] > previous["price"] else "LH",
                "index": current["index"],
                "price": current["price"],
                "time": current["time"],
            }
        )
    for index in range(1, len(lows)):
        previous, current = lows[index - 1], lows[index]
        events.append(
            {
                "type": "HL" if current["price"] > previous["price"] else "LL",
                "index": current["index"],
                "price": current["price"],
                "time": current["time"],
            }
        )
    events.sort(key=lambda event: event["index"])
    trend = "range"
    if len(highs) >= 2 and len(lows) >= 2:
        higher_high = highs[-1]["price"] > highs[-2]["price"]
        higher_low = lows[-1]["price"] > lows[-2]["price"]
        lower_high = highs[-1]["price"] < highs[-2]["price"]
        lower_low = lows[-1]["price"] < lows[-2]["price"]
        if higher_high and higher_low:
            trend = "up"
        elif lower_high and lower_low:
            trend = "down"
    current_trend = trend
    last_confirmed_high: dict[str, Any] | None = None
    last_confirmed_low: dict[str, Any] | None = None
    for index, candle in enumerate(candles):
        confirmed_high = next((swing for swing in reversed(highs) if swing["index"] + right < index), None)
        confirmed_low = next((swing for swing in reversed(lows) if swing["index"] + right < index), None)
        if confirmed_high:
            last_confirmed_high = confirmed_high
        if confirmed_low:
            last_confirmed_low = confirmed_low
        close = _num(candle.close)
        if last_confirmed_high and close > last_confirmed_high["price"]:
            events.append(
                {
                    "type": "CHOCH_UP" if current_trend == "down" else "BOS_UP",
                    "index": index,
                    "price": close,
                    "time": _close_time(candle),
                }
            )
            current_trend = "up"
            last_confirmed_high = None
        elif last_confirmed_low and close < last_confirmed_low["price"]:
            events.append(
                {
                    "type": "CHOCH_DOWN" if current_trend == "up" else "BOS_DOWN",
                    "index": index,
                    "price": close,
                    "time": _close_time(candle),
                }
            )
            current_trend = "down"
            last_confirmed_low = None
    events.sort(key=lambda event: event["index"])
    result: dict[str, Any] = {"trend": trend, "events": events}
    if highs:
        result["lastSwingHigh"] = highs[-1]
    if lows:
        result["lastSwingLow"] = lows[-1]
    return result


def _trend_from_ema(candles: list[Bar], fast_period: int = 20, slow_period: int = 50) -> str:
    closes = [_num(bar.close) for bar in candles]
    fast = _ema_aligned(closes, fast_period)[-1] if closes else None
    slow = _ema_aligned(closes, slow_period)[-1] if closes else None
    if not closes or fast is None or slow is None:
        return "range"
    last = closes[-1]
    if fast > slow and last > fast:
        return "up"
    if fast < slow and last < fast:
        return "down"
    return "range"


def _default_config() -> dict[str, Any]:
    return {
        "emaFast": 20,
        "emaSlow": 50,
        "atrPeriod": 14,
        "stopAtrMultiple": 1.5,
        "minRewardRisk": 2.0,
        "target2Multiple": 3.0,
        "rangeLookback": 20,
        "retestToleranceAtr": 0.25,
        "rsiPeriod": 14,
        "macdFast": 12,
        "macdSlow": 26,
        "macdSignal": 9,
        "volumeLookback": 20,
        "minRelativeVolume": 1.2,
        "swingLeft": 2,
        "swingRight": 2,
        "srLookback": 120,
        "srTolerancePct": 0.005,
        "srToleranceAtr": 0.5,
        "structureLookback": 40,
        "volatilityExpansion": 1.5,
        "bollingerPeriod": 20,
        "bollingerMultiplier": 2.0,
    }


def _resolve_config(params: dict[str, Any]) -> dict[str, Any]:
    config = {**_default_config(), **params}
    for key in (
        "emaFast", "emaSlow", "atrPeriod", "rangeLookback", "rsiPeriod", "macdFast", "macdSlow",
        "macdSignal", "volumeLookback", "swingLeft", "swingRight", "srLookback",
        "structureLookback", "bollingerPeriod",
    ):
        value = config.get(key)
        if not isinstance(value, (int, float)) or not float(value).is_integer():
            raise ValueError(f"{key} must be an integer")
        config[key] = int(value)
    if config["emaFast"] < 1 or config["emaSlow"] <= config["emaFast"]:
        raise ValueError("Invalid EMA periods")
    if config["atrPeriod"] < 1:
        raise ValueError("Invalid ATR period")
    if config["macdFast"] >= config["macdSlow"]:
        raise ValueError("MACD fast period must be smaller than slow period")
    if config["rangeLookback"] < 2:
        raise ValueError("rangeLookback must be at least 2")
    if config["swingLeft"] < 1 or config["swingRight"] < 1:
        raise ValueError("swingLeft and swingRight must be at least 1")
    if config["srTolerancePct"] <= 0 or config["srToleranceAtr"] < 0:
        raise ValueError("Invalid support/resistance tolerances")
    if not math.isfinite(config["minRewardRisk"]) or config["minRewardRisk"] <= 0:
        raise ValueError("Invalid minimum reward/risk")
    if not math.isfinite(config["stopAtrMultiple"]) or config["stopAtrMultiple"] <= 0:
        raise ValueError("Invalid stop ATR multiple")
    if not math.isfinite(config["target2Multiple"]) or config["target2Multiple"] <= config["minRewardRisk"]:
        raise ValueError("Invalid second target multiple")
    return config


def _prepare(entry_bars: list[Bar], trend_bars: list[Bar], cfg: dict[str, Any]) -> dict[str, Any] | None:
    entry = sorted((bar for bar in entry_bars if bar.complete), key=_close_time)
    if len({_close_time(bar) for bar in entry}) != len(entry):
        raise ValueError("Duplicate candle close time")
    if len(entry) < cfg["emaSlow"] + 2:
        return None
    last = entry[-1]
    trend = sorted(
        (bar for bar in trend_bars if bar.complete and _close_time(bar) <= _close_time(last)),
        key=_close_time,
    )
    if len({_close_time(bar) for bar in trend}) != len(trend):
        raise ValueError("Duplicate candle close time")
    if len(trend) < cfg["emaSlow"] + 2:
        return None
    atr_value = _atr_series(entry, cfg["atrPeriod"])[-1]
    if atr_value is None or not math.isfinite(atr_value) or atr_value <= 0:
        return None
    return {
        "entry": entry,
        "trend": trend,
        "last": last,
        "atr": atr_value,
        "htfTrend": _trend_from_ema(trend, cfg["emaFast"], cfg["emaSlow"]),
    }


def _direction(htf_trend: str) -> str:
    return "LONG" if htf_trend == "up" else "SHORT"


def _structure_alignment(entry: list[Bar], cfg: dict[str, Any], direction: str) -> float:
    window = max(60, cfg["structureLookback"] + 10)
    structure = _analyze_market_structure(entry[-window:], cfg["swingLeft"], cfg["swingRight"])
    expected = "up" if direction == "LONG" else "down"
    if structure["trend"] == expected:
        return 1.0
    return 0.5 if structure["trend"] == "range" else 0.2


def _factor_scores(
    direction: str,
    prepared: dict[str, Any],
    cfg: dict[str, Any],
    min_reward_risk: float,
    entry_quality: float,
    structure_alignment: float,
) -> dict[str, float | None]:
    entry = prepared["entry"]
    closes = [_num(bar.close) for bar in entry]
    rsi_value = _rsi(closes, cfg["rsiPeriod"])
    macd_result = _macd(closes, cfg["macdFast"], cfg["macdSlow"], cfg["macdSignal"])
    histogram = macd_result["histogram"] if macd_result else None
    previous_histogram = macd_result["previousHistogram"] if macd_result else None
    relative = _relative_volume(entry, cfg["volumeLookback"])
    atr_percent = (prepared["atr"] / _num(prepared["last"].close)) * 100
    levels = _support_resistance(entry, cfg["srLookback"], cfg["srTolerancePct"])
    relevant = (
        levels["supports"][0] if direction == "LONG" and levels["supports"]
        else levels["resistances"][0] if direction == "SHORT" and levels["resistances"]
        else None
    )
    distance = abs(_num(prepared["last"].close) - relevant["price"]) / prepared["atr"] if relevant else 3.0
    momentum_aligned = ((rsi_value if rsi_value is not None else 50.0) >= 50.0) if direction == "LONG" else ((rsi_value if rsi_value is not None else 50.0) <= 50.0)
    histogram_aligned = histogram is not None and ((histogram > 0) if direction == "LONG" else (histogram < 0))
    histogram_improving = (
        histogram is not None
        and previous_histogram is not None
        and ((histogram > previous_histogram) if direction == "LONG" else (histogram < previous_histogram))
    )
    trend_alignment = 1.0 if prepared["htfTrend"] == ("up" if direction == "LONG" else "down") else 0.5 if prepared["htfTrend"] == "range" else 0.0
    volatility = 0.0 if atr_percent <= 0 else 0.2 if atr_percent > 8 else 0.4 + min(atr_percent, 4.0) * 0.15
    return {
        "trendAlignment": trend_alignment,
        "marketStructure": _clamp(structure_alignment),
        "momentum": _clamp((0.6 if momentum_aligned else 0.0) + (0.25 if histogram_aligned else 0.0) + (0.15 if histogram_improving else 0.0)),
        "volumeConfirmation": _clamp((relative if relative is not None else 1.0) / 2.0),
        "supportResistance": _clamp(1.0 - distance / 3.0),
        "volatilitySuitability": _clamp(volatility),
        "riskReward": _clamp(min_reward_risk / 4.0),
        "entryQuality": _clamp(entry_quality),
    }


def _score(factors: dict[str, float | None]) -> float:
    weights = {
        "trendAlignment": 0.2,
        "marketStructure": 0.15,
        "momentum": 0.12,
        "volumeConfirmation": 0.1,
        "supportResistance": 0.1,
        "volatilitySuitability": 0.08,
        "riskReward": 0.15,
        "entryQuality": 0.1,
    }
    total = 0.0
    weight_total = 0.0
    for key, weight in weights.items():
        raw = factors.get(key)
        value = _clamp(raw if raw is not None else 0.0)
        factors[key] = value
        total += value * weight
        weight_total += weight
    score = (total / weight_total) * 100.0 if weight_total > 0 else 0.0
    return math.floor(score * 100.0 + 0.5) / 100.0


def _build(
    key: str,
    name: str,
    direction: str,
    prepared: dict[str, Any],
    stop: float,
    cfg: dict[str, Any],
    timeframe: str,
    rationale: list[str],
    invalidation: list[str],
    evidence: dict[str, Any],
    entry_quality: float,
    structure_alignment: float,
) -> StrategyEvaluation | None:
    last = prepared["last"]
    entry = _num(last.close)
    risk = entry - stop if direction == "LONG" else stop - entry
    if not math.isfinite(risk) or risk <= 0:
        return None
    targets = (
        entry + risk * cfg["minRewardRisk"] if direction == "LONG" else entry - risk * cfg["minRewardRisk"],
        entry + risk * cfg["target2Multiple"] if direction == "LONG" else entry - risk * cfg["target2Multiple"],
    )
    if any(not math.isfinite(value) or value <= 0 for value in targets):
        return None
    reward_risk = (targets[0] - entry) / risk if direction == "LONG" else (entry - targets[0]) / risk
    if reward_risk < cfg["minRewardRisk"]:
        return None
    factors = _factor_scores(direction, prepared, cfg, reward_risk, entry_quality, structure_alignment)
    score = _score(factors)
    return StrategyEvaluation(
        strategy_key=key,
        strategy_name=name,
        strategy_version=1,
        direction=direction,
        signal_time=int(last.timestamp),
        trigger_close_time=_close_time(last),
        entry=entry,
        stop=stop,
        targets=targets,
        timeframe=timeframe,
        rationale=tuple(rationale),
        invalidation=tuple(invalidation),
        evidence=evidence,
        score_factors=factors,
        score=score,
    )


def _ema_trend_pullback(prepared: dict[str, Any], cfg: dict[str, Any], timeframe: str) -> StrategyEvaluation | None:
    entry = prepared["entry"]
    last = prepared["last"]
    atr_value = prepared["atr"]
    if prepared["htfTrend"] == "range":
        return None
    direction = _direction(prepared["htfTrend"])
    closes = [_num(bar.close) for bar in entry]
    fast = _ema_compact(closes, cfg["emaFast"])
    if len(fast) < 2:
        return None
    prior = entry[-2]
    fast_now = fast[-1]
    fast_prior = fast[-2]
    if direction == "LONG":
        pulled = _num(prior.low) <= fast_prior * 1.002 and _num(last.close) > fast_now and _num(last.close) > _num(last.open)
    else:
        pulled = _num(prior.high) >= fast_prior * 0.998 and _num(last.close) < fast_now and _num(last.close) < _num(last.open)
    if not pulled:
        return None
    structural = (
        min(_num(bar.low) for bar in entry[-cfg["atrPeriod"] :])
        if direction == "LONG"
        else max(_num(bar.high) for bar in entry[-cfg["atrPeriod"] :])
    )
    stop = (
        min(structural, _num(last.close) - atr_value * cfg["stopAtrMultiple"])
        if direction == "LONG"
        else max(structural, _num(last.close) + atr_value * cfg["stopAtrMultiple"])
    )
    rationale = [
        "Higher timeframe EMA trend aligned",
        "Pullback reclaimed the fast EMA on a completed candle",
    ]
    invalidation = [
        f"Invalidated on a completed close {'below' if direction == 'LONG' else 'above'} {stop:.8f}",
        "Invalidated if higher timeframe EMA trend flips",
    ]
    evidence = {"emaFast": fast_now, "atr": atr_value, "htfTrend": prepared["htfTrend"]}
    return _build(
        "ema-trend-pullback", "EMA Trend Pullback", direction, prepared, stop, cfg, timeframe,
        rationale, invalidation, evidence, 0.8, _structure_alignment(entry, cfg, direction),
    )


def _range_breakout_retest(prepared: dict[str, Any], cfg: dict[str, Any], timeframe: str) -> StrategyEvaluation | None:
    entry = prepared["entry"]
    last = prepared["last"]
    atr_value = prepared["atr"]
    if len(entry) < cfg["rangeLookback"] + 3 or prepared["htfTrend"] == "range":
        return None
    direction = _direction(prepared["htfTrend"])
    prior = entry[-(cfg["rangeLookback"] + 2) : -2]
    breakout = entry[-2]
    ceiling = max(_num(bar.high) for bar in prior)
    floor = min(_num(bar.low) for bar in prior)
    tolerance = atr_value * cfg["retestToleranceAtr"]
    stop: float | None = None
    if direction == "LONG" and _num(breakout.close) > ceiling and _num(last.low) <= ceiling + tolerance and _num(last.close) > ceiling and _num(last.close) > _num(last.open):
        stop = min(_num(last.low), ceiling - tolerance)
    if direction == "SHORT" and _num(breakout.close) < floor and _num(last.high) >= floor - tolerance and _num(last.close) < floor and _num(last.close) < _num(last.open):
        stop = max(_num(last.high), floor + tolerance)
    if stop is None:
        return None
    rationale = ["Higher timeframe trend aligned", "Range breakout followed by a completed-candle retest"]
    invalidation = [
        f"Invalidated on a completed close back {'below' if direction == 'LONG' else 'above'} the broken range",
        f"Invalidated on a close {'below' if direction == 'LONG' else 'above'} {stop:.8f}",
    ]
    evidence = {"rangeHigh": ceiling, "rangeLow": floor, "atr": atr_value, "htfTrend": prepared["htfTrend"]}
    return _build(
        "range-breakout-retest", "Range Breakout Retest", direction, prepared, stop, cfg, timeframe,
        rationale, invalidation, evidence, 0.75, _structure_alignment(entry, cfg, direction),
    )


def _support_resistance_rejection(prepared: dict[str, Any], cfg: dict[str, Any], timeframe: str) -> StrategyEvaluation | None:
    entry = prepared["entry"]
    last = prepared["last"]
    atr_value = prepared["atr"]
    if prepared["htfTrend"] == "range":
        return None
    direction = _direction(prepared["htfTrend"])
    levels = _support_resistance(entry, cfg["srLookback"], cfg["srTolerancePct"])
    tolerance = atr_value * cfg["srToleranceAtr"]
    stop: float | None = None
    level_price: float | None = None
    if direction == "LONG":
        support = next((level for level in levels["supports"] if _num(last.low) <= level["price"] + tolerance and _num(last.close) > level["price"]), None)
        if support and _num(last.close) > _num(last.open) and _num(last.low) < _num(last.close):
            stop = min(_num(last.low), support["price"] - atr_value * 0.25)
            level_price = support["price"]
    else:
        resistance = next((level for level in levels["resistances"] if _num(last.high) >= level["price"] - tolerance and _num(last.close) < level["price"]), None)
        if resistance and _num(last.close) < _num(last.open) and _num(last.high) > _num(last.close):
            stop = max(_num(last.high), resistance["price"] + atr_value * 0.25)
            level_price = resistance["price"]
    if stop is None or level_price is None:
        return None
    rationale = ["Higher timeframe trend aligned", "Price rejected a confirmed support/resistance level on a completed candle"]
    invalidation = [
        f"Invalidated on a completed close {'below' if direction == 'LONG' else 'above'} the rejected level",
        f"Invalidated on a close {'below' if direction == 'LONG' else 'above'} {stop:.8f}",
    ]
    evidence = {"level": level_price, "atr": atr_value, "htfTrend": prepared["htfTrend"]}
    return _build(
        "support-resistance-rejection", "Support Resistance Rejection", direction, prepared, stop, cfg, timeframe,
        rationale, invalidation, evidence, 0.7, _structure_alignment(entry, cfg, direction),
    )


def _recent_event(events: list[dict[str, Any]], event_type: str, window_length: int, maximum_age: int) -> dict[str, Any] | None:
    recent = [event for event in events if window_length - 1 - event["index"] <= maximum_age]
    return next((event for event in reversed(recent) if event["type"] == event_type), None)


def _market_structure_continuation(prepared: dict[str, Any], cfg: dict[str, Any], timeframe: str) -> StrategyEvaluation | None:
    entry = prepared["entry"]
    last = prepared["last"]
    atr_value = prepared["atr"]
    if prepared["htfTrend"] == "range":
        return None
    direction = _direction(prepared["htfTrend"])
    structure_window = entry[-max(80, cfg["structureLookback"] + 20) :]
    structure = _analyze_market_structure(structure_window, cfg["swingLeft"], cfg["swingRight"])
    if structure["trend"] != prepared["htfTrend"]:
        return None
    break_event = _recent_event(structure["events"], "BOS_UP" if direction == "LONG" else "BOS_DOWN", len(structure_window), 6)
    if break_event is None:
        return None
    if direction == "LONG":
        structural = structure.get("lastSwingLow", {}).get("price") if structure.get("lastSwingLow") else min(_num(bar.low) for bar in entry[-cfg["atrPeriod"] :])
        stop = min(structural, _num(last.close) - atr_value * cfg["stopAtrMultiple"])
    else:
        structural = structure.get("lastSwingHigh", {}).get("price") if structure.get("lastSwingHigh") else max(_num(bar.high) for bar in entry[-cfg["atrPeriod"] :])
        stop = max(structural, _num(last.close) + atr_value * cfg["stopAtrMultiple"])
    rationale = ["Higher timeframe trend and entry market structure aligned", "Break of structure followed by continuation"]
    invalidation = [
        f"Invalidated on a completed close {'below' if direction == 'LONG' else 'above'} the last structural swing",
        f"Invalidated on a close {'below' if direction == 'LONG' else 'above'} {stop:.8f}",
    ]
    evidence = {"structureTrend": structure["trend"], "breakPrice": break_event["price"], "atr": atr_value, "htfTrend": prepared["htfTrend"]}
    return _build(
        "market-structure-continuation", "Market Structure Continuation", direction, prepared, stop, cfg, timeframe,
        rationale, invalidation, evidence, 0.85, 1.0,
    )


def _trend_reversal_momentum(prepared: dict[str, Any], cfg: dict[str, Any], timeframe: str) -> StrategyEvaluation | None:
    entry = prepared["entry"]
    last = prepared["last"]
    atr_value = prepared["atr"]
    structure_window = entry[-max(80, cfg["structureLookback"] + 20) :]
    structure = _analyze_market_structure(structure_window, cfg["swingLeft"], cfg["swingRight"])
    recent = [event for event in structure["events"] if len(structure_window) - 1 - event["index"] <= 6]
    reversal = next((event for event in reversed(recent) if event["type"] in ("CHOCH_UP", "CHOCH_DOWN")), None)
    if reversal is None:
        return None
    direction = "LONG" if reversal["type"] == "CHOCH_UP" else "SHORT"
    closes = [_num(bar.close) for bar in entry]
    rsi_now = _rsi(closes, cfg["rsiPeriod"])
    rsi_prior = _rsi(closes[:-1], cfg["rsiPeriod"])
    if rsi_now is None or rsi_prior is None:
        return None
    macd_result = _macd(closes, cfg["macdFast"], cfg["macdSlow"], cfg["macdSignal"])
    histogram = macd_result["histogram"] if macd_result else None
    if direction == "LONG":
        momentum_confirmed = (rsi_prior <= 50 < rsi_now) or (histogram is not None and histogram > 0)
    else:
        momentum_confirmed = (rsi_prior >= 50 > rsi_now) or (histogram is not None and histogram < 0)
    if not momentum_confirmed:
        return None
    htf_rsi = _rsi([_num(bar.close) for bar in prepared["trend"]], cfg["rsiPeriod"])
    if direction == "LONG":
        exhaustion = prepared["htfTrend"] != "up" and (htf_rsi is None or htf_rsi <= 48)
    else:
        exhaustion = prepared["htfTrend"] != "down" and (htf_rsi is None or htf_rsi >= 52)
    if not exhaustion:
        return None
    if direction == "LONG":
        structural = structure.get("lastSwingLow", {}).get("price") if structure.get("lastSwingLow") else min(_num(bar.low) for bar in entry[-cfg["atrPeriod"] :])
        stop = min(structural, _num(last.close) - atr_value * cfg["stopAtrMultiple"])
    else:
        structural = structure.get("lastSwingHigh", {}).get("price") if structure.get("lastSwingHigh") else max(_num(bar.high) for bar in entry[-cfg["atrPeriod"] :])
        stop = max(structural, _num(last.close) + atr_value * cfg["stopAtrMultiple"])
    rationale = ["Change of character confirmed on a completed candle", "Momentum confirmation with higher timeframe exhaustion"]
    invalidation = [
        "Invalidated if the change of character fails on a completed close",
        f"Invalidated on a close {'below' if direction == 'LONG' else 'above'} {stop:.8f}",
    ]
    evidence = {
        "reversal": reversal["type"],
        "rsi": rsi_now,
        "htfTrend": prepared["htfTrend"],
        "htfRsi": htf_rsi if htf_rsi is not None else 0,
        "atr": atr_value,
    }
    return _build(
        "trend-reversal-momentum", "Trend Reversal Momentum", direction, prepared, stop, cfg, timeframe,
        rationale, invalidation, evidence, 0.6, 0.7,
    )


def _volatility_expansion_breakout(prepared: dict[str, Any], cfg: dict[str, Any], timeframe: str) -> StrategyEvaluation | None:
    entry = prepared["entry"]
    last = prepared["last"]
    atr_value = prepared["atr"]
    if prepared["htfTrend"] == "range" or len(entry) < cfg["bollingerPeriod"] + 5:
        return None
    direction = _direction(prepared["htfTrend"])
    atr_history = [value for value in _atr_series(entry, cfg["atrPeriod"])[-21:-1] if value is not None]
    if len(atr_history) < 10:
        return None
    average_atr = sum(atr_history) / len(atr_history)
    if average_atr <= 0 or atr_value / average_atr < cfg["volatilityExpansion"]:
        return None
    closes = [_num(bar.close) for bar in entry]
    bands = _bollinger(closes, cfg["bollingerPeriod"], cfg["bollingerMultiplier"])
    upper, lower = bands["upper"][-1], bands["lower"][-1]
    prior_upper, prior_lower = bands["upper"][-2], bands["lower"][-2]
    if upper is None or lower is None:
        return None
    width = upper - lower
    prior_width = prior_upper - prior_lower if prior_upper is not None and prior_lower is not None else 0.0
    if prior_width <= 0 or width / prior_width < 1.05:
        return None
    relative = _relative_volume(entry, cfg["volumeLookback"])
    if relative is None or relative < cfg["minRelativeVolume"]:
        return None
    range_bars = entry[-(cfg["rangeLookback"] + 1) : -1]
    if len(range_bars) < cfg["rangeLookback"]:
        return None
    range_high = max(_num(bar.high) for bar in range_bars)
    range_low = min(_num(bar.low) for bar in range_bars)
    expanded = _num(last.close) > upper and _num(last.close) > range_high if direction == "LONG" else _num(last.close) < lower and _num(last.close) < range_low
    if not expanded:
        return None
    stop = (
        min(_num(last.low), _num(last.close) - atr_value * cfg["stopAtrMultiple"])
        if direction == "LONG"
        else max(_num(last.high), _num(last.close) + atr_value * cfg["stopAtrMultiple"])
    )
    rationale = ["Higher timeframe trend aligned", "Volatility expansion confirmed by ATR, Bollinger width and relative volume"]
    invalidation = [
        "Invalidated on a completed close back inside the prior range",
        f"Invalidated on a close {'below' if direction == 'LONG' else 'above'} {stop:.8f}",
    ]
    evidence = {
        "atrExpansion": atr_value / average_atr,
        "relativeVolume": relative,
        "rangeHigh": range_high,
        "rangeLow": range_low,
        "htfTrend": prepared["htfTrend"],
    }
    return _build(
        "volatility-expansion-breakout", "Volatility Expansion Breakout", direction, prepared, stop, cfg, timeframe,
        rationale, invalidation, evidence, 0.9, _structure_alignment(entry, cfg, direction),
    )


_STRATEGIES = {
    "ema-trend-pullback": ("EMA Trend Pullback", _ema_trend_pullback),
    "range-breakout-retest": ("Range Breakout Retest", _range_breakout_retest),
    "support-resistance-rejection": ("Support Resistance Rejection", _support_resistance_rejection),
    "market-structure-continuation": ("Market Structure Continuation", _market_structure_continuation),
    "trend-reversal-momentum": ("Trend Reversal Momentum", _trend_reversal_momentum),
    "volatility-expansion-breakout": ("Volatility Expansion Breakout", _volatility_expansion_breakout),
}


def evaluate_at(
    strategy_key: str,
    bars: list[Bar],
    trend_bars: list[Bar],
    params: dict[str, Any] | None = None,
    timeframe: str = "unknown",
) -> StrategyEvaluation | None:
    if strategy_key not in _STRATEGIES:
        variants = ", ".join(SUPPORTED_STRATEGIES)
        raise ValueError(f"Unsupported strategy '{strategy_key}'. Expected one of: {variants}")
    cfg = _resolve_config(params or {})
    prepared = _prepare(bars, trend_bars, cfg)
    if prepared is None:
        return None
    _, evaluator = _STRATEGIES[strategy_key]
    return evaluator(prepared, cfg, timeframe)


def generate_setups(
    strategy_key: str,
    bars: list[Bar],
    trend_bars: list[Bar] | None = None,
    params: dict[str, Any] | None = None,
    *,
    timeframe: str = "unknown",
) -> list[Setup]:
    if strategy_key not in _STRATEGIES:
        variants = ", ".join(SUPPORTED_STRATEGIES)
        raise ValueError(f"Unsupported strategy '{strategy_key}'. Expected one of: {variants}")
    if not bars:
        return []
    cfg = _resolve_config(params or {})
    ordered = sorted((bar for bar in bars if bar.complete), key=_close_time)
    trend = sorted((bar for bar in (trend_bars or []) if bar.complete), key=_close_time)
    if len({_close_time(bar) for bar in ordered}) != len(ordered):
        raise ValueError("Duplicate candle close time")
    if len({_close_time(bar) for bar in trend}) != len(trend):
        raise ValueError("Duplicate candle close time")
    minimum = max(cfg["emaSlow"] + 2, cfg["atrPeriod"] + 2)
    warmup = max(1000, cfg["emaSlow"] * 20, cfg["srLookback"] * 4, cfg["structureLookback"] * 8)
    trend_close_times = [_close_time(bar) for bar in trend]
    expiry_bars = params.get("expiryBars") if params else None
    intervals = sorted(
        later.timestamp - earlier.timestamp
        for earlier, later in zip(ordered, ordered[1:])
        if later.timestamp > earlier.timestamp
    )
    bar_interval = intervals[len(intervals) // 2] if intervals else 0
    setups: list[Setup] = []
    for index in range(minimum, len(ordered) - 1):
        window_start = max(0, index + 1 - warmup)
        window = ordered[window_start : index + 1]
        trend_end = bisect_right(trend_close_times, _close_time(window[-1]))
        trend_window = trend[max(0, trend_end - warmup) : trend_end]
        evaluation = evaluate_at(strategy_key, window, trend_window, params, timeframe)
        if evaluation is None:
            continue
        first, second = evaluation.targets
        setups.append(
            Setup(
                signal_time=evaluation.signal_time,
                direction="long" if evaluation.direction == "LONG" else "short",
                stop=Decimal(str(evaluation.stop)),
                target=Decimal(str(first)),
                risk_fraction=Decimal("0.01"),
                target2=Decimal(str(second)),
                target1_allocation_pct=Decimal("50"),
                target2_allocation_pct=Decimal("50"),
                expires_at=(
                    evaluation.trigger_close_time + int(expiry_bars) * bar_interval
                    if expiry_bars is not None and bar_interval
                    else None
                ),
            )
        )
    return setups


def ema_series(values: Iterable[Decimal], period: int) -> list[Decimal | None]:
    if period < 1:
        raise ValueError("EMA period must be positive")
    decimals = [Decimal(value) for value in values]
    out: list[Decimal | None] = [None] * len(decimals)
    if len(decimals) < period:
        return out
    current = sum(decimals[:period], Decimal("0")) / Decimal(period)
    out[period - 1] = current
    alpha = Decimal("2") / Decimal(period + 1)
    for index in range(period, len(decimals)):
        current = decimals[index] * alpha + current * (Decimal("1") - alpha)
        out[index] = current
    return out


def trend_at(bars: list[Bar], timestamp: int, fast: int = 20, slow: int = 50) -> str | None:
    eligible = sorted((bar for bar in bars if bar.complete and _close_time(bar) <= timestamp), key=_close_time)
    if len(eligible) < slow:
        return None
    trend = _trend_from_ema(eligible, fast, slow)
    return None if trend == "range" else ("long" if trend == "up" else "short")


def volume_ratio_at(bars: list[Bar], index: int, period: int) -> Decimal | None:
    if period < 1 or index < period or index >= len(bars):
        return None
    volumes = [Decimal(bar.volume) for bar in bars[index - period : index]]
    average = sum(volumes, Decimal("0")) / Decimal(period)
    return Decimal(bars[index].volume) / average if average > 0 else None
