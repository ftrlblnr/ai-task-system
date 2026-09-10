import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from './roles.decorator';
import type { AuthenticatedUser } from './jwt.strategy';

// RBAC на уровне API (раздел 15 ТЗ): даже прямой запрос к backend в обход
// UI не должен дать доступ к чужим данным.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const user: AuthenticatedUser = context.switchToHttp().getRequest().user;
    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException('Недостаточно прав для этого действия');
    }
    return true;
  }
}
