import { describe, expect, it, vi } from "vitest";
vi.mock("@signal-engine/database/repository", () => ({
  listSignalsPage: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
  getSignalDetail: vi.fn().mockResolvedValue(null),
  decodeCursor: vi.fn()
}));
import { SignalsController } from "./signals.controller.js";
describe("SignalsController", () => {
  it("returns a filter-aware paginated response", async () => {
    const result = await new SignalsController().list("crypto_perpetual", "BTCUSDT", "PENDING");
    expect(result.data).toEqual([]);
    expect(result.filters.symbol).toBe("BTCUSDT");
    expect(result.hasMore).toBe(false);
  });
  it("rejects invalid filters", async () => {
    await expect(new SignalsController().list(undefined, undefined, "published")).rejects.toThrow();
    await expect(new SignalsController().list(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "0")).rejects.toThrow();
  });
});
