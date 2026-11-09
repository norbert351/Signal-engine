import { Controller, Get, Query } from "@nestjs/common";
import { listSignals } from "@signal-engine/database/repository";
@Controller("signals")
export class SignalsController {
 @Get()
 async list(@Query("market") market?: string,@Query("symbol") symbol?: string,@Query("status") status?: string,@Query("limit") limit?: string){
  const data=await listSignals({market,symbol,status,limit:limit?Number(limit):50});
  return {data,total:data.length,filters:{market:market??null,symbol:symbol??null,status:status??null}};
 }
}
