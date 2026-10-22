import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';

// Подключение внешних ИИ (Claude) по MCP, владелец 22.10.2026. MCP_ENABLED
// выключен — роуты /mcp, /oauth и .well-known отвечают 404. MCP_ROLES —
// роли через запятую, пусто = все роли (как LEGAL_AGENT_ROLES).
// MCP_PUBLIC_URL — внешний адрес API (https://api-…), из него строятся
// issuer и адрес ресурса в метаданных OAuth.
export function isMcpEnabled(config: ConfigService): boolean {
  return config.get<string>('MCP_ENABLED') === 'true' && !!config.get<string>('MCP_PUBLIC_URL');
}

export function mcpAllowedForRole(config: ConfigService, role: Role): boolean {
  if (!isMcpEnabled(config)) return false;
  const roles = (config.get<string>('MCP_ROLES') ?? '')
    .split(',')
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean);
  return roles.length === 0 || roles.includes(role);
}

export function mcpIssuer(config: ConfigService): string {
  return (config.get<string>('MCP_PUBLIC_URL') ?? '').replace(/\/+$/, '');
}

export function mcpResource(config: ConfigService): string {
  return `${mcpIssuer(config)}/mcp`;
}
