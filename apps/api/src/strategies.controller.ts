import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { createStrategyVersion, getStrategy, listStrategies, setStrategyApproval, setStrategyEnabled } from "@signal-engine/database/admin-repository";
import { AdminGuard } from "./admin.guard.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireId(id: string) {
  if (!UUID.test(id)) throw new BadRequestException("Invalid strategy id");
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException(`${name} must be an object`);
  return value as Record<string, unknown>;
}

@Controller("strategies")
export class StrategiesController {
  @Get()
  async list() {
    const data = await listStrategies();
    return { data, total: data.length };
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    requireId(id);
    const row = await getStrategy(id);
    if (!row) throw new NotFoundException("Strategy configuration not found");
    return row;
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Body() body: { key?: unknown; name?: unknown; description?: unknown; parameters?: unknown; riskConfig?: unknown }) {
    if (typeof body.key !== "string" || typeof body.name !== "string") throw new BadRequestException("key and name are required");
    if (body.description !== undefined && typeof body.description !== "string") throw new BadRequestException("description must be a string");
    const parameters = asObject(body.parameters, "parameters");
    const riskConfig = body.riskConfig === undefined ? {} : asObject(body.riskConfig, "riskConfig");
    try {
      return await createStrategyVersion({
        key: body.key,
        name: body.name,
        ...(body.description !== undefined ? { description: body.description } : {}),
        parameters,
        riskConfig
      });
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : "Unable to create strategy version");
    }
  }

  @Patch(":id/approval")
  @UseGuards(AdminGuard)
  async approve(@Param("id") id: string, @Body() body: { approved?: unknown; note?: unknown }) {
    requireId(id);
    if (typeof body.approved !== "boolean" || (body.approved && typeof body.note !== "string")) {
      throw new BadRequestException("approved and an approval note are required");
    }
    try {
      const row = await setStrategyApproval(id, body.approved, typeof body.note === "string" ? body.note : "");
      if (!row) throw new NotFoundException("Strategy configuration not found");
      return row;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ConflictException(error instanceof Error ? error.message : "Approval failed");
    }
  }

  @Patch(":id/enabled")
  @UseGuards(AdminGuard)
  async setEnabled(@Param("id") id: string, @Body() body: { enabled?: unknown }) {
    requireId(id);
    if (typeof body.enabled !== "boolean") throw new BadRequestException("enabled must be a boolean");
    try {
      const row = await setStrategyEnabled(id, body.enabled);
      if (!row) throw new NotFoundException("Strategy configuration not found");
      return row;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ConflictException(error instanceof Error ? error.message : "Strategy activation failed");
    }
  }
}
