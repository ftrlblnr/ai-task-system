import type { ConfigService } from '@nestjs/config';
import type { Role } from '@prisma/client';

// Доступ к агенту-юристу (handoff, раздел 3.5): флаг LEGAL_AGENT_ENABLED
// (выключен — инструменты не попадают в чат, роуты /legal отвечают 404) и
// задел LEGAL_AGENT_ROLES — список ролей через запятую; пусто = все роли.
export function isLegalEnabled(config: ConfigService): boolean {
  return config.get<string>('LEGAL_AGENT_ENABLED') === 'true';
}

export function legalAllowedForRole(config: ConfigService, role: Role): boolean {
  if (!isLegalEnabled(config)) return false;
  const roles = (config.get<string>('LEGAL_AGENT_ROLES') ?? '')
    .split(',')
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean);
  return roles.length === 0 || roles.includes(role);
}
