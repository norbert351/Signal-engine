import { Body,Controller,Get,Param,Patch,UseGuards,BadRequestException,NotFoundException } from "@nestjs/common";
import { listStrategies,setStrategyEnabled } from "@signal-engine/database/admin-repository";
import { AdminGuard } from "./admin.guard.js";
@Controller("strategies")
export class StrategiesController {
 @Get() async list(){const data=await listStrategies();return {data,total:data.length};}
 @Patch(":id/enabled") @UseGuards(AdminGuard) async setEnabled(@Param("id") id:string,@Body() body:{enabled?:unknown}){if(typeof body.enabled!=="boolean")throw new BadRequestException("enabled must be a boolean");const row=await setStrategyEnabled(id,body.enabled);if(!row)throw new NotFoundException("Strategy configuration not found");return row;}
}
