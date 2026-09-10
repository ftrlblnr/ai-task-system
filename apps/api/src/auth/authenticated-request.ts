import type { Request } from 'express';
import type { AuthenticatedUser } from './jwt.strategy';

// Аудит 10.09.2026, п. 5.2: ctx.switchToHttp().getRequest() без generic-
// параметра возвращает any — @typescript-eslint/no-unsafe-* (впервые
// реально включённый в CI этим же аудитом) справедливо ругался на .user
// на any в CurrentUser/RolesGuard. passport.use(JwtStrategy) кладёт сюда
// именно то, что вернул JwtStrategy.validate() — AuthenticatedUser.
export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}
