import { Controller, Get } from "@nestjs/common";
import { listInstruments } from "@signal-engine/database/repository";
@Controller("instruments")
export class InstrumentsController {
 @Get()
 async list(){const data=await listInstruments();return {data,total:data.length};}
}
