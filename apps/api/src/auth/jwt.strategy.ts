import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
}

interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  // Отключённая учётка (владелец 09.11.2026) теряет доступ сразу, а не
  // когда истечёт токен (JWT_EXPIRES_IN, по умолчанию 8 ч). Проверяется
  // только статус: роль по-прежнему из токена, как было (живую роль
  // перечитывает ActiveEmployeeGuard там, где это нужно).
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const employee = await this.prisma.employee.findUnique({ where: { id: payload.sub }, select: { status: true } });
    if (!employee || employee.status !== 'ACTIVE') {
      throw new UnauthorizedException('Учётная запись отключена');
    }
    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
    };
  }
}
