import { db } from "./index.js";
import { systemHealth } from "./schema.js";
export async function reportHealth(component:string,status:string,details:Record<string,unknown>={}){const [row]=await db.insert(systemHealth).values({component,status,details,checkedAt:new Date()}).onConflictDoUpdate({target:systemHealth.component,set:{status,details,checkedAt:new Date()}}).returning();return row;}
