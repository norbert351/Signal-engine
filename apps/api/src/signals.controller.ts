import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { listSignals } from "@signal-engine/database/repository";
@Controller("signals")
export class SignalsController {
 @Get()
 async list(@Query("market") market?: string,@Query("symbol") symbol?: string,@Query("status") status?: string,@Query("limit") limit?: string){
  const parsedLimit=limit===undefined?50:Number(limit);if(!Number.isInteger(parsedLimit)||parsedLimit<1||parsedLimit>200)throw new BadRequestException("limit must be an integer from 1 to 200");const data=await listSignals({market,symbol,status,limit:parsedLimit});
  return {data,total:data.length,filters:{market:market??null,symbol:symbol??null,status:status??null}};
 }
}
