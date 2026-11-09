import { describe, expect, it, vi } from "vitest";
vi.mock("@signal-engine/database/repository",()=>({listSignals:vi.fn().mockResolvedValue([])}));
import { SignalsController } from "./signals.controller.js";
describe("SignalsController", () => {
 it("returns a filter-aware response", async () => {
  const result = await new SignalsController().list("crypto", "BTCUSDT", "published");
  expect(result.total).toBe(0);
  expect(result.filters.symbol).toBe("BTCUSDT");
 });
});
