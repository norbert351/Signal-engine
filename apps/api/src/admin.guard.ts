import { CanActivate,ExecutionContext,Injectable,UnauthorizedException } from "@nestjs/common";
@Injectable()
export class AdminGuard implements CanActivate {
 canActivate(context:ExecutionContext):boolean {const expected=process.env.ADMIN_API_KEY;if(!expected)throw new UnauthorizedException("Admin API is not configured");const request=context.switchToHttp().getRequest<{headers:Record<string,string|undefined>}>();const supplied=request.headers["x-admin-api-key"];if(!supplied||supplied!==expected)throw new UnauthorizedException("Invalid admin API key");return true;}
}
