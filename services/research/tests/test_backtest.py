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
