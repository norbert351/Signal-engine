import { Controller, Get } from "@nestjs/common";
@Controller("instruments")
export class InstrumentsController {
 @Get()
 list() { return { data: [], total: 0, state: "scaffold" }; }
}
