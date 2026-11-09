import { Controller, Get } from "@nestjs/common";
import { listInstruments } from "@signal-engine/database/dist/repository.js";
@Controller("instruments")
export class InstrumentsController {
 @Get()
 async list(){const data=await listInstruments();return {data,total:data.length};}
}
