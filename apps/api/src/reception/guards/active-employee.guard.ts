import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedRequest } from '../../auth/authenticated-request';

// Раздел 4/13 ТЗ «Приёмная» — JwtStrategy.validate() доверяет роли/статусу,
// закодированным в JWT при логине, и нигде в проекте не перепроверяет живое
// состояние сотрудника на каждый запрос. Для остальных модулей это сходило с
// рук (риск: уволенный/заблокированный сотрудник с ещё не истёкшим токеном
// JWT_EXPIRES_IN=8h продолжает действовать до истечения токена), но здесь ТЗ
// требует явной проверки. Решение — не трогать JwtStrategy глобально (риск
// регресса во всех остальных модулях), а добавить этот guard только на
// /reception/*: идёт СРАЗУ после JwtAuthGuard и ДО RolesGuard, перечитывает
// сотрудника из БД и перезаписывает request.user.role живым значением — так
// RolesGuard, который запускается следующим, уже видит актуальную роль, а не
// то, что было в токене на момент логина.
@Injectable()
export class ActiveEmployeeGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const employee = await this.prisma.employee.findUnique({
      where: { id: request.user.id },
      select: { status: true, role: true, isProfileAdmin: true },
    });
    if (!employee || employee.status !== 'ACTIVE') {
      throw new UnauthorizedException('Сотрудник неактивен');
    }
    // Живые роль/isProfileAdmin — не то, что было в JWT на момент логина.
    request.user.role = employee.role;
    request.user.isProfileAdmin = employee.isProfileAdmin;
    return true;
  }
}
