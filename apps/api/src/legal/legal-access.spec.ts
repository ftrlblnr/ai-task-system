import { Role } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { isLegalEnabled, legalAllowedForRole } from './legal-access';

const cfg = (env: Record<string, string>) => new ConfigService(env);

describe('legal-access', () => {
  it('без флага — выключено для всех', () => {
    expect(isLegalEnabled(cfg({}))).toBe(false);
    expect(legalAllowedForRole(cfg({ LEGAL_AGENT_ROLES: 'OWNER' }), Role.OWNER)).toBe(false);
  });

  it('флаг без списка ролей — всем', () => {
    expect(legalAllowedForRole(cfg({ LEGAL_AGENT_ENABLED: 'true' }), Role.EMPLOYEE)).toBe(true);
  });

  it('LEGAL_AGENT_ROLES ограничивает роли', () => {
    const c = cfg({ LEGAL_AGENT_ENABLED: 'true', LEGAL_AGENT_ROLES: ' owner, ADMIN ' });
    expect(legalAllowedForRole(c, Role.OWNER)).toBe(true);
    expect(legalAllowedForRole(c, Role.ADMIN)).toBe(true);
    expect(legalAllowedForRole(c, Role.EMPLOYEE)).toBe(false);
  });
});
