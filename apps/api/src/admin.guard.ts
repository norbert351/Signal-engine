import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.ADMIN_API_KEY;
    if (!expected || expected.length < 16) throw new UnauthorizedException("Admin API is not configured securely");
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const supplied = request.headers["x-admin-api-key"];
    if (!supplied) throw new UnauthorizedException("Invalid admin API key");
    const left = createHash("sha256").update(supplied).digest();
    const right = createHash("sha256").update(expected).digest();
    if (!timingSafeEqual(left, right)) throw new UnauthorizedException("Invalid admin API key");
    return true;
  }
}
