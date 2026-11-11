import { reportHealth } from "@signal-engine/database/health-repository";
export async function reportWorkerHealth(component: string, status: "ok" | "degraded" | "error", details: Record<string, unknown> = {}) {
  try {
    await reportHealth(component, status, details);
  } catch (error) {
    console.error("Unable to persist worker health", error);
  }
}
