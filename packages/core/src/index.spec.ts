import { describe, expect, it } from "vitest";
import { ema, rewardRisk, validateCandidate } from "./index.js";
describe("technical analysis core", () => {
 it("builds an EMA series", () => expect(ema([1,2,3],2)).toHaveLength(2));
 it("calculates directional R multiple", () => expect(rewardRisk("LONG",100,95,110)).toBe(2));
 it("rejects a weak target", () => expect(() => validateCandidate({direction:"LONG",entry:100,stopLoss:95,targets:[108],timeframe:"5m",rationale:["rule"]},2)).toThrow());
});
