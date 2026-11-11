from bisect import bisect_right
from dataclasses import replace
from decimal import Decimal

from .backtest import Bar, Setup

SUPPORTED_STRATEGIES = (
    "ema-trend-pullback",
    "range-breakout-retest",
    "support-resistance-rejection",
    "market-structure-continuation",
    "trend-reversal-momentum",
    "volatility-expansion-breakout",
)


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
    ranges = []
    for i in range(index - period + 1, index + 1):
        previous = bars[i - 1].close
        ranges.append(
            max(
                bars[i].high - bars[i].low,
                abs(bars[i].high - previous),
                abs(bars[i].low - previous),
            )
        )
    return sum(ranges, Decimal("0")) / Decimal(period)


def rsi_series(values: list[Decimal], period: int) -> list[Decimal | None]:
    if period < 1:
        raise ValueError("RSI period must be positive")
    out: list[Decimal | None] = [None] * len(values)
    if len(values) <= period:
        return out
    gains = Decimal("0")
    losses = Decimal("0")
    for i in range(1, period + 1):
        change = values[i] - values[i - 1]
        gains += max(change, Decimal("0"))
        losses += max(-change, Decimal("0"))
    average_gain = gains / Decimal(period)
    average_loss = losses / Decimal(period)
    out[period] = _rsi_value(average_gain, average_loss)
    for i in range(period + 1, len(values)):
        change = values[i] - values[i - 1]
        average_gain = (average_gain * (period - 1) + max(change, Decimal("0"))) / Decimal(period)
        average_loss = (average_loss * (period - 1) + max(-change, Decimal("0"))) / Decimal(period)
        out[i] = _rsi_value(average_gain, average_loss)
    return out


def _rsi_value(average_gain: Decimal, average_loss: Decimal) -> Decimal:
    if average_loss == 0:
        return Decimal("100") if average_gain > 0 else Decimal("50")
    rs = average_gain / average_loss
    return Decimal("100") - Decimal("100") / (Decimal("1") + rs)


def bollinger_at(
    values: list[Decimal], index: int, period: int, multiplier: Decimal
) -> tuple[Decimal, Decimal, Decimal] | None:
    if period < 2 or index < period - 1:
        return None
    window = values[index - period + 1 : index + 1]
    middle = sum(window, Decimal("0")) / Decimal(period)
    variance = sum(((value - middle) ** 2 for value in window), Decimal("0")) / Decimal(period)
    deviation = variance.sqrt()
    return middle - deviation * multiplier, middle, deviation * multiplier + middle


def volume_ratio_at(bars: list[Bar], index: int, lookback: int) -> Decimal | None:
    if lookback < 1 or index < lookback:
        return None
    if any(bar.volume > 0 for bar in bars[index - lookback : index + 1]):
        previous = [bars[i].volume for i in range(index - lookback, index)]
        average = sum(previous, Decimal("0")) / Decimal(lookback)
        if average <= 0:
            return None
        return bars[index].volume / average
    previous = [max(bars[i].high - bars[i].low, Decimal("0.0000000001")) for i in range(index - lookback, index)]
    average = sum(previous, Decimal("0")) / Decimal(lookback)
    if average <= 0:
        return None
    current = max(bars[index].high - bars[index].low, Decimal("0.0000000001"))
    return current / average


def trend_at(bars: list[Bar], timestamp: int, fast_period: int, slow_period: int) -> str | None:
    available = [
        bar
        for bar in bars
        if (bar.close_timestamp if bar.close_timestamp is not None else bar.timestamp) <= timestamp
    ]
    if len(available) < slow_period:
        return None
    fast = ema_series([b.close for b in available], fast_period)[-1]
    slow = ema_series([b.close for b in available], slow_period)[-1]
    if fast is None or slow is None:
        return None
    last = available[-1].close
    if fast > slow and last > fast:
        return "long"
    if fast < slow and last < fast:
        return "short"
    return None


def trend_lookup(
    bars: list[Bar], fast_period: int, slow_period: int
) -> tuple[list[int], list[str | None]]:
    fast = ema_series([b.close for b in bars], fast_period)
    slow = ema_series([b.close for b in bars], slow_period)
    directions: list[str | None] = []
    for i, bar in enumerate(bars):
        if fast[i] is None or slow[i] is None:
            directions.append(None)
        elif fast[i] > slow[i] and bar.close > fast[i]:
            directions.append("long")
        elif fast[i] < slow[i] and bar.close < fast[i]:
            directions.append("short")
        else:
            directions.append(None)
    return [
        b.close_timestamp if b.close_timestamp is not None else b.timestamp for b in bars
    ], directions


def lookup_trend(times: list[int], directions: list[str | None], timestamp: int) -> str | None:
    index = bisect_right(times, timestamp) - 1
    return directions[index] if index >= 0 else None


def confirmed_swings(
    bars: list[Bar], upto: int, left: int = 2, right: int = 2
) -> tuple[list[tuple[int, Decimal]], list[tuple[int, Decimal]]]:
    highs: list[tuple[int, Decimal]] = []
    lows: list[tuple[int, Decimal]] = []
    for index in range(left, upto - right + 1):
        window = bars[index - left : index + right + 1]
        if bars[index].high >= max(bar.high for bar in window):
            highs.append((index, bars[index].high))
        if bars[index].low <= min(bar.low for bar in window):
            lows.append((index, bars[index].low))
    return highs, lows


def structure_at(
    bars: list[Bar], upto: int, left: int = 2, right: int = 2
) -> tuple[str, list[tuple[int, str, Decimal]]]:
    highs, lows = confirmed_swings(bars, upto, left, right)
    if len(highs) < 2 or len(lows) < 2:
        return "range", []
    higher_highs = highs[-1][1] > highs[-2][1]
    higher_lows = lows[-1][1] > lows[-2][1]
    lower_highs = highs[-1][1] < highs[-2][1]
    lower_lows = lows[-1][1] < lows[-2][1]
    trend = "up" if higher_highs and higher_lows else "down" if lower_highs and lower_lows else "range"
    events: list[tuple[int, str, Decimal]] = []
    last_high = highs[0]
    last_low = lows[0]
    high_cursor = 1
    low_cursor = 1
    prior = "range"
    for index in range(1, upto + 1):
        while high_cursor < len(highs) and highs[high_cursor][0] + right <= index:
            last_high = highs[high_cursor]
            high_cursor += 1
        while low_cursor < len(lows) and lows[low_cursor][0] + right <= index:
            last_low = lows[low_cursor]
            low_cursor += 1
        if bars[index].close > last_high[1]:
            event = "CHOCH_UP" if prior == "down" else "BOS_UP"
            events.append((index, event, last_high[1]))
            prior = "up"
        elif bars[index].close < last_low[1]:
            event = "CHOCH_DOWN" if prior == "up" else "BOS_DOWN"
            events.append((index, event, last_low[1]))
            prior = "down"
    return trend, events


def _append_long(
    setups: list[Setup], bar: Bar, stop: Decimal, min_rr: Decimal, target2_multiple: Decimal
) -> None:
    risk = bar.close - stop
    if risk <= 0:
        return
    setups.append(
        Setup(
            bar.timestamp,
            "long",
            stop,
            bar.close + risk * min_rr,
            Decimal("0.01"),
            bar.close + risk * target2_multiple,
            Decimal("50"),
            Decimal("50"),
        )
    )


def _append_short(
    setups: list[Setup], bar: Bar, stop: Decimal, min_rr: Decimal, target2_multiple: Decimal
) -> None:
    risk = stop - bar.close
    if risk <= 0:
        return
    setups.append(
        Setup(
            bar.timestamp,
            "short",
            stop,
            bar.close - risk * min_rr,
            Decimal("0.01"),
            bar.close - risk * target2_multiple,
            Decimal("50"),
            Decimal("50"),
        )
    )


def generate_setups(
    strategy_key: str, bars: list[Bar], trend_bars: list[Bar], params: dict
) -> list[Setup]:
    if strategy_key not in SUPPORTED_STRATEGIES:
        raise ValueError(f"Unsupported strategy key: {strategy_key}")
    bars = sorted(bars, key=lambda b: b.timestamp)
    trend_bars = sorted(trend_bars, key=lambda b: b.timestamp)
    if len({b.timestamp for b in bars}) != len(bars) or len({b.timestamp for b in trend_bars}) != len(
        trend_bars
    ):
        raise ValueError("candle timestamps must be unique")
    fast = int(params.get("emaFast", 20))
    slow = int(params.get("emaSlow", 50))
    atr_period = int(params.get("atrPeriod", 14))
    min_rr = Decimal(str(params.get("minRewardRisk", 2)))
    stop_mult = Decimal(str(params.get("stopAtrMultiple", 1.5)))
    target2_multiple = Decimal(str(params.get("target2Multiple", 3)))
    if fast < 1 or slow <= fast or atr_period < 1 or min_rr <= 0 or stop_mult <= 0:
        raise ValueError("invalid strategy parameters")
    closes = [b.close for b in bars]
    fast_ema = ema_series(closes, fast)
    trend_times, trend_directions = trend_lookup(trend_bars, fast, slow)
    setups: list[Setup] = []

    for i in range(max(slow, atr_period + 1, 2), len(bars) - 1):
        bar = bars[i]
        previous = bars[i - 1]
        direction = lookup_trend(
            trend_times,
            trend_directions,
            bar.close_timestamp if bar.close_timestamp is not None else bar.timestamp,
        )
        atr = atr_at(bars, i, atr_period)
        if atr is None or atr <= 0:
            continue

        if strategy_key == "ema-trend-pullback":
            if not direction or fast_ema[i] is None or fast_ema[i - 1] is None:
                continue
            if (
                direction == "long"
                and previous.low <= fast_ema[i - 1] * Decimal("1.002")
                and bar.close > fast_ema[i]
                and bar.close > bar.open
            ):
                structural = min(b.low for b in bars[max(0, i - atr_period + 1) : i + 1])
                _append_long(setups, bar, min(structural, bar.close - atr * stop_mult), min_rr, target2_multiple)
            if (
                direction == "short"
                and previous.high >= fast_ema[i - 1] * Decimal("0.998")
                and bar.close < fast_ema[i]
                and bar.close < bar.open
            ):
                structural = max(b.high for b in bars[max(0, i - atr_period + 1) : i + 1])
                _append_short(setups, bar, max(structural, bar.close + atr * stop_mult), min_rr, target2_multiple)

        elif strategy_key == "range-breakout-retest":
            lookback = int(params.get("rangeLookback", 20))
            tolerance_mult = Decimal(str(params.get("retestToleranceAtr", 0.25)))
            if lookback < 2 or tolerance_mult < 0:
                raise ValueError("invalid breakout parameters")
            if i < lookback + 1 or not direction:
                continue
            range_bars = bars[i - lookback - 1 : i - 1]
            breakout = previous
            ceiling = max(b.high for b in range_bars)
            floor = min(b.low for b in range_bars)
            tolerance = atr * tolerance_mult
            if (
                direction == "long"
                and breakout.close > ceiling
                and bar.low <= ceiling + tolerance
                and bar.close > ceiling
                and bar.close > bar.open
            ):
                _append_long(setups, bar, min(bar.low, ceiling - tolerance), min_rr, target2_multiple)
            if (
                direction == "short"
                and breakout.close < floor
                and bar.high >= floor - tolerance
                and bar.close < floor
                and bar.close < bar.open
            ):
                _append_short(setups, bar, max(bar.high, floor + tolerance), min_rr, target2_multiple)

        elif strategy_key == "support-resistance-rejection":
            if not direction:
                continue
            sr_lookback = int(params.get("srLookback", 120))
            tolerance = atr * Decimal(str(params.get("srToleranceAtr", 0.5)))
            highs, lows = confirmed_swings(bars, i, 2, 2)
            if direction == "long":
                supports = [price for index, price in lows if i - index <= sr_lookback and bar.low <= price + tolerance and bar.close > price]
                if supports and bar.close > bar.open:
                    level = max(supports)
                    _append_long(setups, bar, min(bar.low, level - atr * Decimal("0.25")), min_rr, target2_multiple)
            else:
                resistances = [price for index, price in highs if i - index <= sr_lookback and bar.high >= price - tolerance and bar.close < price]
                if resistances and bar.close < bar.open:
                    level = min(resistances)
                    _append_short(setups, bar, max(bar.high, level + atr * Decimal("0.25")), min_rr, target2_multiple)

        elif strategy_key == "market-structure-continuation":
            if not direction:
                continue
            structure_trend, events = structure_at(bars, i, 2, 2)
            expected_trend = "up" if direction == "long" else "down"
            if structure_trend != expected_trend:
                continue
            expected_event = "BOS_UP" if direction == "long" else "BOS_DOWN"
            recent = [event for event in events if event[0] >= i - 6 and event[1] == expected_event]
            if not recent:
                continue
            structural = (
                min(b.low for b in bars[max(0, i - atr_period + 1) : i + 1])
                if direction == "long"
                else max(b.high for b in bars[max(0, i - atr_period + 1) : i + 1])
            )
            stop = min(structural, bar.close - atr * stop_mult) if direction == "long" else max(structural, bar.close + atr * stop_mult)
            if direction == "long":
                _append_long(setups, bar, stop, min_rr, target2_multiple)
            else:
                _append_short(setups, bar, stop, min_rr, target2_multiple)

        elif strategy_key == "trend-reversal-momentum":
            structure_trend, events = structure_at(bars, i, 2, 2)
            recent = [event for event in events if event[0] >= i - 6 and event[1] in ("CHOCH_UP", "CHOCH_DOWN")]
            if not recent:
                continue
            event = recent[-1]
            reversal_direction = "long" if event[1] == "CHOCH_UP" else "short"
            rsi = rsi_series(closes, int(params.get("rsiPeriod", 14)))
            rsi_now = rsi[i]
            rsi_prior = rsi[i - 1]
            if rsi_now is None or rsi_prior is None:
                continue
            momentum = (
                (rsi_prior <= 50 and rsi_now > 50)
                if reversal_direction == "long"
                else (rsi_prior >= 50 and rsi_now < 50)
            )
            if not momentum:
                continue
            htf_rsi = rsi_series([b.close for b in trend_bars], int(params.get("rsiPeriod", 14)))
            htf_value = next((value for value in reversed(htf_rsi) if value is not None), None)
            if reversal_direction == "long":
                exhaustion = direction != "long" and (htf_value is None or htf_value <= 48)
            else:
                exhaustion = direction != "short" and (htf_value is None or htf_value >= 52)
            if not exhaustion:
                continue
            structural = (
                min(b.low for b in bars[max(0, i - atr_period + 1) : i + 1])
                if reversal_direction == "long"
                else max(b.high for b in bars[max(0, i - atr_period + 1) : i + 1])
            )
            stop = min(structural, bar.close - atr * stop_mult) if reversal_direction == "long" else max(structural, bar.close + atr * stop_mult)
            if reversal_direction == "long":
                _append_long(setups, bar, stop, min_rr, target2_multiple)
            else:
                _append_short(setups, bar, stop, min_rr, target2_multiple)

        elif strategy_key == "volatility-expansion-breakout":
            if not direction or i < int(params.get("bollingerPeriod", 20)) + 5:
                continue
            atr_history = [atr_at(bars, j, atr_period) for j in range(i - 20, i)]
            clean = [value for value in atr_history if value is not None]
            if len(clean) < 10:
                continue
            average_atr = sum(clean, Decimal("0")) / Decimal(len(clean))
            if average_atr <= 0 or atr / average_atr < Decimal(str(params.get("volatilityExpansion", 1.5))):
                continue
            bands = bollinger_at(closes, i, int(params.get("bollingerPeriod", 20)), Decimal(str(params.get("bollingerMultiplier", 2))))
            prior_bands = bollinger_at(closes, i - 1, int(params.get("bollingerPeriod", 20)), Decimal(str(params.get("bollingerMultiplier", 2))))
            if bands is None or prior_bands is None:
                continue
            lower, _, upper = bands
            prior_lower, _, prior_upper = prior_bands
            prior_width = prior_upper - prior_lower
            if prior_width <= 0 or (upper - lower) / prior_width < Decimal("1.05"):
                continue
            relative = volume_ratio_at(bars, i, int(params.get("volumeLookback", 20)))
            if relative is None or relative < Decimal(str(params.get("minRelativeVolume", 1.2))):
                continue
            lookback = int(params.get("rangeLookback", 20))
            if i < lookback + 1:
                continue
            range_bars = bars[i - lookback - 1 : i - 1]
            range_high = max(b.high for b in range_bars)
            range_low = min(b.low for b in range_bars)
            if direction == "long" and bar.close > upper and bar.close > range_high:
                _append_long(setups, bar, min(bar.low, bar.close - atr * stop_mult), min_rr, target2_multiple)
            if direction == "short" and bar.close < lower and bar.close < range_low:
                _append_short(setups, bar, max(bar.high, bar.close + atr * stop_mult), min_rr, target2_multiple)

    expiry_bars = params.get("expiryBars")
    if expiry_bars is not None:
        bars_count = int(expiry_bars)
        if bars_count < 1:
            raise ValueError("expiryBars must be positive")
        intervals = [
            later.timestamp - earlier.timestamp
            for earlier, later in zip(bars, bars[1:])
            if later.timestamp > earlier.timestamp
        ]
        if not intervals:
            raise ValueError("cannot infer bar interval for expiry")
        interval = sorted(intervals)[len(intervals) // 2]
        close_by_time = {
            bar.timestamp: bar.close_timestamp if bar.close_timestamp is not None else bar.timestamp
            for bar in bars
        }
        setups = [
            replace(
                setup,
                expires_at=close_by_time.get(setup.signal_time, setup.signal_time) + bars_count * interval,
            )
            for setup in setups
        ]

    return setups
