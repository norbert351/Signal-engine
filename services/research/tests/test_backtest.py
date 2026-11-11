from decimal import Decimal
from signal_engine_research.backtest import Bar, Setup, simulate, summarize, chronological_split
from signal_engine_research.models import CostModel

def test_entry_occurs_on_next_bar_and_stop_wins_ambiguous_bar():
    bars=[Bar(1,Decimal("100"),Decimal("101"),Decimal("99"),Decimal("100")),Bar(2,Decimal("100"),Decimal("112"),Decimal("88"),Decimal("105"))]
    setups=[Setup(1,"long",Decimal("95"),Decimal("110"),Decimal("0.01"))]
    result=simulate(bars,setups,CostModel(fee_bps_per_side=Decimal("0"),spread_bps=Decimal("0"),slippage_bps=Decimal("0")))
    assert result[0].exit_reason=="stop"
    assert result[0].net_return==Decimal("-0.05")

def test_metrics_and_out_of_sample_split():
    bars=[Bar(i,Decimal("100"),Decimal("101"),Decimal("99"),Decimal("100")) for i in range(10)]
    train,validation,test=chronological_split(bars)
    assert len(train)+len(validation)+len(test)==10
    assert summarize([])["trades"]==0


def test_backtest_prevents_overlapping_positions():
    bars=[Bar(i,Decimal("100"),Decimal("102"),Decimal("99"),Decimal("101")) for i in range(6)]
    setups=[Setup(0,"long",Decimal("98"),Decimal("103"),Decimal("0.01")),Setup(1,"long",Decimal("98"),Decimal("101.5"),Decimal("0.01"))]
    trades=simulate(bars,setups,CostModel(fee_bps_per_side=Decimal("0"),spread_bps=Decimal("0"),slippage_bps=Decimal("0")))
    assert len(trades)==1


def test_partial_targets_weight_realized_return():
    bars=[Bar(1,Decimal("100"),Decimal("101"),Decimal("99"),Decimal("100")),Bar(2,Decimal("100"),Decimal("111"),Decimal("99"),Decimal("108")),Bar(3,Decimal("108"),Decimal("116"),Decimal("107"),Decimal("115"))]
    setups=[Setup(1,"long",Decimal("90"),Decimal("110"),Decimal("0.01"),Decimal("120"),Decimal("50"),Decimal("50"))]
    result=simulate(bars,setups,CostModel(fee_bps_per_side=Decimal("0"),spread_bps=Decimal("0"),slippage_bps=Decimal("0")))
    assert result[0].gross_return==Decimal("0.125")


def test_positive_funding_cost_is_directional():
    bars=[Bar(1,Decimal("100"),Decimal("101"),Decimal("99"),Decimal("100")),Bar(2,Decimal("100"),Decimal("101"),Decimal("99"),Decimal("100")),Bar(3,Decimal("100"),Decimal("101"),Decimal("99"),Decimal("100"))]
    costs=CostModel(fee_bps_per_side=Decimal("0"),spread_bps=Decimal("0"),slippage_bps=Decimal("0"),funding_bps_per_8h=Decimal("8"))
    long=simulate(bars,[Setup(1,"long",Decimal("90"),Decimal("120"),Decimal("0.01"))],costs)[0]
    short=simulate(bars,[Setup(1,"short",Decimal("110"),Decimal("80"),Decimal("0.01"))],costs)[0]
    assert short.net_return > long.net_return


def test_summarize_reports_risk_metrics():
    from signal_engine_research.backtest import Trade
    trades = [
        Trade("long", 0, 3600000, Decimal("100"), Decimal("102"), Decimal("0.02"), Decimal("0.01"), "target"),
        Trade("long", 7200000, 10800000, Decimal("100"), Decimal("99"), Decimal("-0.01"), Decimal("-0.02"), "stop"),
    ]
    metrics = summarize(trades)
    assert metrics["trades"] == 2
    assert "sharpe_ratio" in metrics
    assert "sortino_ratio" in metrics
    assert "profit_factor" in metrics
    assert metrics["average_holding_hours"] == "1"


def test_walk_forward_produces_chronological_folds():
    from signal_engine_research.backtest import walk_forward
    bars = [Bar(i, Decimal("100"), Decimal("101"), Decimal("99"), Decimal("100")) for i in range(40)]
    folds = walk_forward(bars, [], CostModel(), 4)
    assert len(folds) == 4
    assert folds[0]["start"] < folds[-1]["end"]
    assert all(fold["bars"] >= 10 for fold in folds)


def test_volume_ratio_prefers_real_volume():
    from signal_engine_research.strategies import volume_ratio_at
    bars = [Bar(i, Decimal("100"), Decimal("101"), Decimal("99"), Decimal("100"), volume=Decimal("10")) for i in range(6)]
    bars.append(Bar(6, Decimal("100"), Decimal("101"), Decimal("99"), Decimal("100"), volume=Decimal("30")))
    assert volume_ratio_at(bars, 6, 5) == Decimal("3")


def test_setup_expiry_exits_at_last_close_before_expiry():
    bars = [
        Bar(1, Decimal("100"), Decimal("101"), Decimal("99"), Decimal("100"), close_timestamp=2),
        Bar(2, Decimal("100"), Decimal("101"), Decimal("99"), Decimal("100"), close_timestamp=3),
        Bar(3, Decimal("100"), Decimal("101"), Decimal("99"), Decimal("100"), close_timestamp=4),
    ]
    setups = [Setup(1, "long", Decimal("90"), Decimal("120"), Decimal("0.01"), expires_at=3)]
    trades = simulate(bars, setups, CostModel(fee_bps_per_side=Decimal("0"), spread_bps=Decimal("0"), slippage_bps=Decimal("0")))
    assert trades[0].exit_reason == "expired"
    assert trades[0].exit_time == 3
    assert trades[0].exit == Decimal("100")


def test_breakdowns_group_by_instrument_timeframe_and_style():
    from signal_engine_research.backtest import breakdowns
    bars = [
        Bar(1, Decimal("100"), Decimal("101"), Decimal("99"), Decimal("100"), close_timestamp=2),
        Bar(2, Decimal("100"), Decimal("111"), Decimal("99"), Decimal("110"), close_timestamp=3),
    ]
    setups = [Setup(1, "long", Decimal("95"), Decimal("110"), Decimal("0.01"), symbol="BTCUSDT", timeframe="1h", trading_style="intraday")]
    trades = simulate(bars, setups, CostModel(fee_bps_per_side=Decimal("0"), spread_bps=Decimal("0"), slippage_bps=Decimal("0")))
    grouped = breakdowns(trades)
    assert grouped["byInstrument"]["BTCUSDT"]["trades"] == 1
    assert Decimal(str(grouped["byTimeframe"]["1h"]["net_return"])) == Decimal("0.1")
    assert grouped["byTradingStyle"]["intraday"]["target_trades"] == 1


def test_summarize_reports_loss_streak_and_reward_risk():
    from signal_engine_research.backtest import Trade
    trades = [
        Trade("long", 0, 1, Decimal("100"), Decimal("99"), Decimal("-0.01"), Decimal("-0.01"), "stop", Decimal("2")),
        Trade("long", 2, 3, Decimal("100"), Decimal("98"), Decimal("-0.02"), Decimal("-0.02"), "stop", Decimal("3")),
        Trade("long", 4, 5, Decimal("100"), Decimal("103"), Decimal("0.03"), Decimal("0.03"), "target", Decimal("4")),
    ]
    metrics = summarize(trades)
    assert metrics["consecutive_losses"] == 2
    assert metrics["average_reward_risk"] == "3"
    assert metrics["stop_trades"] == 2
    assert metrics["target_trades"] == 1
