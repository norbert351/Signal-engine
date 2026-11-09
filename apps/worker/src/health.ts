import { reportHealth } from "@signal-engine/database/health-repository";
export async function reportWorkerHealth(status:"ok"|"degraded"|"error",details:Record<string,unknown>={}){try{await reportHealth("worker",status,details);}catch(error){console.error("Unable to persist worker health",error);}}
