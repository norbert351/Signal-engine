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
    setups=[Setup(0,"long",Decimal("98"),Decimal("101.5"),Decimal("0.01")),Setup(1,"long",Decimal("98"),Decimal("101.5"),Decimal("0.01"))]
    trades=simulate(bars,setups,CostModel(fee_bps_per_side=Decimal("0"),spread_bps=Decimal("0"),slippage_bps=Decimal("0")))
    assert len(trades)==1
