export function returnAfterCosts(direction: string, entry: number, exit: number, costBps: number, entryTime: Date, exitTime: Date, fundingBps: number, market: string): number {
  const hours = Math.max(0, (exitTime.getTime() - entryTime.getTime()) / 3_600_000);
  const fundingCost = market === "crypto_perpetual" ? fundingBps * (hours / 8) * (direction === "LONG" ? 1 : -1) : 0;
  const gross = direction === "LONG" ? (exit - entry) / entry : (entry - exit) / entry;
  return gross - costBps / 10_000 - fundingCost / 10_000;
}
