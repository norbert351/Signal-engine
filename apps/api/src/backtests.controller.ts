import { Body,Controller,Get,Post,UseGuards,BadRequestException } from "@nestjs/common";
import { createBacktest,listBacktests } from "@signal-engine/database/admin-repository";
import { AdminGuard } from "./admin.guard.js";
const REQUIRED_COST_FIELDS=["fee_bps_per_side","spread_bps","slippage_bps","funding_bps_per_8h"] as const;
function assertExplicitCosts(value: unknown): Record<string, unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value)) throw new BadRequestException("Explicit cost assumptions are required");
  const costs=value as Record<string,unknown>;
  for(const key of REQUIRED_COST_FIELDS){
    const v=costs[key];
    if(v===null||v===undefined||v===""||!Number.isFinite(Number(v))) throw new BadRequestException(`Missing or invalid cost assumption: ${key}`);
    if(Number(v)<0) throw new BadRequestException(`Cost assumption must be non-negative: ${key}`);
  }
  return costs;
}
@Controller("backtests")
export class BacktestsController {
 @Get() async list(){const data=await listBacktests();return {data,total:data.length};}
 @Post() @UseGuards(AdminGuard) async create(@Body() body:{strategyKey?:unknown;strategyVersion?:unknown;timeframe?:unknown;instrumentId?:unknown;start?:unknown;end?:unknown;trendTimeframe?:unknown;dataset?:unknown;assumptions?:unknown}){
  if(typeof body.strategyKey!=="string"||!Number.isInteger(body.strategyVersion)||Number(body.strategyVersion)<1||typeof body.timeframe!=="string")throw new BadRequestException("Invalid backtest request");
  const assumptions=assertExplicitCosts(body.assumptions);
  const stored=typeof body.instrumentId==="string"&&typeof body.start==="string"&&typeof body.end==="string"&&typeof body.trendTimeframe==="string";let dataset:Record<string,unknown>;let instrumentId:string|undefined;
  if(stored){const start=new Date(body.start as string),end=new Date(body.end as string);if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||start>=end)throw new BadRequestException("Backtest start/end range is invalid");dataset={start:start.toISOString(),end:end.toISOString(),trendTimeframe:body.trendTimeframe};instrumentId=body.instrumentId as string;}
  else if(body.dataset&&typeof body.dataset==="object"&&Array.isArray((body.dataset as Record<string,unknown>).bars)&&Array.isArray((body.dataset as Record<string,unknown>).trendBars)){dataset=body.dataset as Record<string,unknown>;}
  else throw new BadRequestException("Provide instrumentId/start/end/trendTimeframe or a dataset with bars and trendBars");
  const input={strategyKey:body.strategyKey,strategyVersion:body.strategyVersion as number,timeframe:body.timeframe,dataset,assumptions,...(instrumentId?{instrumentId}:{})};return createBacktest(input);
 }
}
