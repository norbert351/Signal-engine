import { Body,Controller,Get,Param,Patch,UseGuards,BadRequestException,NotFoundException,ConflictException } from "@nestjs/common";
import { listStrategies,setStrategyEnabled,setStrategyApproval } from "@signal-engine/database/admin-repository";
import { AdminGuard } from "./admin.guard.js";
@Controller("strategies")
export class StrategiesController {
 @Get() async list(){const data=await listStrategies();return {data,total:data.length};}
 @Patch(":id/approval") @UseGuards(AdminGuard) async approve(@Param("id") id:string,@Body() body:{approved?:unknown;note?:unknown}){if(typeof body.approved!=="boolean"||(body.approved&&typeof body.note!=="string"))throw new BadRequestException("approved and an approval note are required");try{const row=await setStrategyApproval(id,body.approved,typeof body.note==="string"?body.note:"");if(!row)throw new NotFoundException("Strategy configuration not found");return row;}catch(error){if(error instanceof NotFoundException)throw error;throw new ConflictException(error instanceof Error?error.message:"Approval failed");}}
 @Patch(":id/enabled") @UseGuards(AdminGuard) async setEnabled(@Param("id") id:string,@Body() body:{enabled?:unknown}){if(typeof body.enabled!=="boolean")throw new BadRequestException("enabled must be a boolean");try{const row=await setStrategyEnabled(id,body.enabled);if(!row)throw new NotFoundException("Strategy configuration not found");return row;}catch(error){if(error instanceof NotFoundException)throw error;throw new ConflictException(error instanceof Error?error.message:"Strategy activation failed");}}
}
