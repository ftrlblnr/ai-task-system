import { CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from './authenticated-request';

// Владелец 20.10.2026 — администратор работает и со своими календарём/
// почтой, и с календарём/почтой руководителя. Чьи данные — решает
// заголовок X-Act-As: leader (переключатель на странице); без него, и для
// любой роли, кроме ADMIN, — данные самого пользователя. Все личные
// интеграции (календарь, почта, их агенты) берут владельца данных отсюда,
// а не из request.user.id напрямую.
export const ACT_AS_HEADER = 'x-act-as';

export interface DataOwner {
  id: string;
  actingAsLeader: boolean;
}

interface DataOwnerRequest extends AuthenticatedRequest {
  dataOwner?: DataOwner;
}

// Ставится ПОСЛЕ JwtAuthGuard/RolesGuard (нужен request.user).
@Injectable()
export class DataOwnerGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DataOwnerRequest>();
    const { user } = request;
    if (request.headers[ACT_AS_HEADER] !== 'leader' || user.role !== Role.ADMIN) {
      request.dataOwner = { id: user.id, actingAsLeader: false };
      return true;
    }

    const leader = await this.prisma.employee.findFirst({
      where: { role: Role.OWNER, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!leader) throw new NotFoundException('Руководитель не найден');
    request.dataOwner = { id: leader.id, actingAsLeader: true };

    // Изменения в данных руководителя — всегда с указанием, кто их сделал.
    if (request.method !== 'GET') {
      await this.audit.log(user.id, 'ACT_AS_LEADER', 'Employee', leader.id, { method: request.method, path: request.originalUrl });
    }
    return true;
  }
}

export const CurrentDataOwner = createParamDecorator((_data: unknown, ctx: ExecutionContext): DataOwner => {
  const request = ctx.switchToHttp().getRequest<DataOwnerRequest>();
  return request.dataOwner ?? { id: request.user.id, actingAsLeader: false };
});

// Подключить/отключить интеграцию руководителя (свой Google-аккаунт, пароль
// почты) может только она сама — администратор в режиме руководителя
// только работает с уже подключёнными данными.
export function assertOwnIntegration(owner: DataOwner): void {
  if (owner.actingAsLeader) {
    throw new ForbiddenException('Подключать и отключать интеграции руководителя может только она сама');
  }
}
