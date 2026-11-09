import { Body,Controller,Get,Post,UseGuards,BadRequestException } from "@nestjs/common";
import { createBacktest,listBacktests } from "@signal-engine/database/admin-repository";
import { AdminGuard } from "./admin.guard.js";
@Controller("backtests")
export class BacktestsController {
 @Get() async list(){const data=await listBacktests();return {data,total:data.length};}
 @Post() @UseGuards(AdminGuard) async create(@Body() body:{strategyKey?:unknown;strategyVersion?:unknown;timeframe?:unknown;dataset?:unknown;assumptions?:unknown}){
  if(typeof body.strategyKey!=="string"||!Number.isInteger(body.strategyVersion)||typeof body.timeframe!=="string"||!body.dataset||typeof body.dataset!=="object"||!body.assumptions||typeof body.assumptions!=="object")throw new BadRequestException("Invalid backtest request");
  return createBacktest({strategyKey:body.strategyKey,strategyVersion:body.strategyVersion as number,timeframe:body.timeframe,dataset:body.dataset as Record<string,unknown>,assumptions:body.assumptions as Record<string,unknown>});
 }
}
