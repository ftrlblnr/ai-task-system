import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmployeeStatus } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { mcpAllowedForRole, mcpResource } from './mcp-config';

// OAuth 2.1 для коннектора Claude (владелец 22.10.2026): authorization code
// + PKCE S256, публичные клиенты без секрета, динамическая регистрация.
// Вход и согласие — на веб-странице /connect (обычная сессия Адъютанта),
// сюда она приходит уже с JWT пользователя.

const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_REDIRECT_URIS = 5;
// CIMD (Client ID Metadata Document): client_id — https-адрес документа
// клиента. Claude по умолчанию использует его («опубликованная
// идентичность Claude»); доверяем только документам с доменов Anthropic.
const CIMD_HOSTS = new Set(['claude.ai', 'claude.com']);
const CIMD_REFRESH_MS = 24 * 60 * 60_000;
const CIMD_FETCH_TIMEOUT_MS = 5_000;

// Только Claude: веб/мобильный/десктоп (callback claude.ai и claude.com) и
// локальный callback Claude Code / MCP Inspector (loopback, любой порт).
const CLAUDE_CALLBACKS = new Set(['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']);

export function isAllowedRedirectUri(uri: string): boolean {
  if (CLAUDE_CALLBACKS.has(uri)) return true;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && !url.username && !url.password;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

// Ошибка протокола OAuth — контроллер отдаёт её как {error, error_description}.
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource?: string;
}

export interface McpUser extends AuthenticatedUser {
  fullName: string;
}

@Injectable()
export class OAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async registerClient(body: unknown): Promise<{ client_id: string; client_name: string; redirect_uris: string[]; token_endpoint_auth_method: 'none'; grant_types: string[]; response_types: string[]; client_id_issued_at: number }> {
    const input = (body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (uris.length === 0 || uris.length > MAX_REDIRECT_URIS) throw new OAuthError('invalid_redirect_uri', 'Нужен хотя бы один redirect_uri');
    const bad = uris.find((u) => !isAllowedRedirectUri(u));
    if (bad) throw new OAuthError('invalid_redirect_uri', `Адрес возврата не разрешён: ${bad}`);
    const name = typeof input.client_name === 'string' && input.client_name.trim() ? input.client_name.trim().slice(0, 100) : 'Claude';

    const client = await this.prisma.oAuthClient.create({
      data: { id: `mcp_${randomBytes(16).toString('hex')}`, name, redirectUris: uris },
    });
    return {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    };
  }

  // Клиент по client_id: зарегистрированный (DCR) — из БД; CIMD-адрес —
  // документ скачивается и кэшируется в той же таблице на сутки.
  async resolveClient(clientId: string): Promise<{ id: string; name: string; redirectUris: string[] } | null> {
    const existing = await this.prisma.oAuthClient.findUnique({ where: { id: clientId } });
    if (!clientId.startsWith('https://')) return existing;
    if (existing && Date.now() - existing.createdAt.getTime() < CIMD_REFRESH_MS) return existing;

    const doc = await fetchClientMetadata(clientId);
    if (!doc) return existing;
    const data = { name: doc.name, redirectUris: doc.redirectUris, createdAt: new Date() };
    return this.prisma.oAuthClient.upsert({ where: { id: clientId }, create: { id: clientId, ...data }, update: data });
  }

  // Проверка параметров до показа страницы согласия — страница показывает
  // имя клиента и не даёт подтвердить заведомо битый запрос.
  async describeRequest(params: AuthorizeParams): Promise<{ clientName: string }> {
    const client = await this.resolveClient(params.clientId);
    if (!client) throw new OAuthError('invalid_client', 'Приложение не зарегистрировано');
    if (!client.redirectUris.includes(params.redirectUri)) throw new OAuthError('invalid_request', 'Адрес возврата не совпадает с зарегистрированным');
    if (params.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(params.codeChallenge)) {
      throw new OAuthError('invalid_request', 'Нужен PKCE с методом S256');
    }
    if (params.resource && params.resource !== mcpResource(this.config)) throw new OAuthError('invalid_target', 'Неизвестный ресурс');
    return { clientName: client.name };
  }

  async approve(user: AuthenticatedUser, params: AuthorizeParams): Promise<string> {
    if (!mcpAllowedForRole(this.config, user.role)) throw new ForbiddenException('Подключение внешних ИИ для вашей роли недоступно');
    await this.describeRequest(params);
    const code = newToken('code');
    await this.prisma.oAuthAuthCode.create({
      data: {
        codeHash: sha256(code),
        clientId: params.clientId,
        employeeId: user.id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        resource: params.resource ?? null,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
    void this.audit.log(user.id, 'MCP_CONNECT_APPROVED', 'OAuthClient', params.clientId, {});
    return code;
  }

  async exchangeCode(body: Record<string, unknown>): Promise<TokenResponse> {
    const code = str(body.code);
    const verifier = str(body.code_verifier);
    const clientId = str(body.client_id);
    const redirectUri = str(body.redirect_uri);
    if (!code || !verifier || !clientId) throw new OAuthError('invalid_request', 'Не хватает code, code_verifier или client_id');

    const codeHash = sha256(code);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.oAuthAuthCode.findUnique({ where: { codeHash } });
      if (!row || row.clientId !== clientId || row.expiresAt < new Date()) throw new OAuthError('invalid_grant', 'Код недействителен');
      // Повторное использование кода — одноразовость важнее ответа:
      // помечаем атомарно, второй обмен получает invalid_grant.
      const claimed = await tx.oAuthAuthCode.updateMany({ where: { codeHash, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count === 0) throw new OAuthError('invalid_grant', 'Код уже использован');
      if (redirectUri && redirectUri !== row.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri не совпадает');
      if (s256(verifier) !== row.codeChallenge) throw new OAuthError('invalid_grant', 'Неверный code_verifier');

      const employee = await tx.employee.findUnique({ where: { id: row.employeeId }, select: { status: true } });
      if (!employee || employee.status !== EmployeeStatus.ACTIVE) throw new OAuthError('invalid_grant', 'Пользователь неактивен');

      const access = newToken('at');
      const refresh = newToken('rt');
      const now = Date.now();
      await tx.oAuthGrant.create({
        data: {
          clientId,
          employeeId: row.employeeId,
          accessTokenHash: sha256(access),
          accessExpiresAt: new Date(now + ACCESS_TTL_MS),
          refreshTokenHash: sha256(refresh),
          refreshExpiresAt: new Date(now + REFRESH_TTL_MS),
        },
      });
      return tokenResponse(access, refresh);
    });
  }

  async refresh(body: Record<string, unknown>): Promise<TokenResponse> {
    const refreshToken = str(body.refresh_token);
    const clientId = str(body.client_id);
    if (!refreshToken) throw new OAuthError('invalid_request', 'Не передан refresh_token');

    const grant = await this.prisma.oAuthGrant.findUnique({ where: { refreshTokenHash: sha256(refreshToken) } });
    if (!grant || grant.revokedAt || grant.refreshExpiresAt < new Date() || (clientId && grant.clientId !== clientId)) {
      throw new OAuthError('invalid_grant', 'Подключение недействительно — подключите заново');
    }
    const access = newToken('at');
    const refresh = newToken('rt');
    const now = Date.now();
    // Условие на старый хэш — два одновременных refresh не получат оба
    // рабочие токены.
    const updated = await this.prisma.oAuthGrant.updateMany({
      where: { id: grant.id, refreshTokenHash: grant.refreshTokenHash, revokedAt: null },
      data: {
        accessTokenHash: sha256(access),
        accessExpiresAt: new Date(now + ACCESS_TTL_MS),
        refreshTokenHash: sha256(refresh),
        refreshExpiresAt: new Date(now + REFRESH_TTL_MS),
      },
    });
    if (updated.count === 0) throw new OAuthError('invalid_grant', 'Подключение недействительно — подключите заново');
    return tokenResponse(access, refresh);
  }

  // Bearer-токен запроса к /mcp → пользователь. Роль и статус — из БД на
  // каждый запрос: уволенный или пониженный в правах теряет доступ сразу.
  async authenticate(accessToken: string): Promise<McpUser | null> {
    const grant = await this.prisma.oAuthGrant.findUnique({
      where: { accessTokenHash: sha256(accessToken) },
      select: { id: true, revokedAt: true, accessExpiresAt: true, lastUsedAt: true, employee: { select: { id: true, email: true, role: true, status: true, fullName: true } } },
    });
    if (!grant || grant.revokedAt || grant.accessExpiresAt < new Date()) return null;
    const e = grant.employee;
    if (e.status !== EmployeeStatus.ACTIVE || !mcpAllowedForRole(this.config, e.role)) return null;
    // lastUsedAt для списка подключений — не чаще раза в минуту.
    if (!grant.lastUsedAt || Date.now() - grant.lastUsedAt.getTime() > 60_000) {
      void this.prisma.oAuthGrant.update({ where: { id: grant.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return { id: e.id, email: e.email, role: e.role, fullName: e.fullName };
  }

  async listConnections(employeeId: string) {
    const grants = await this.prisma.oAuthGrant.findMany({
      where: { employeeId, revokedAt: null, refreshExpiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, lastUsedAt: true, client: { select: { name: true } } },
    });
    return grants.map((g) => ({ id: g.id, clientName: g.client.name, createdAt: g.createdAt.toISOString(), lastUsedAt: g.lastUsedAt?.toISOString() ?? null }));
  }

  async revoke(employeeId: string, grantId: string): Promise<void> {
    const res = await this.prisma.oAuthGrant.updateMany({ where: { id: grantId, employeeId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count > 0) void this.audit.log(employeeId, 'MCP_CONNECTION_REVOKED', 'OAuthGrant', grantId, {});
  }
}

async function fetchClientMetadata(url: string): Promise<{ name: string; redirectUris: string[] } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !CIMD_HOSTS.has(parsed.hostname)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS), redirect: 'error', headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const doc = (await res.json()) as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
    if (doc.client_id !== url || !Array.isArray(doc.redirect_uris)) return null;
    const redirectUris = doc.redirect_uris.filter((u): u is string => typeof u === 'string' && isAllowedRedirectUri(u)).slice(0, MAX_REDIRECT_URIS);
    if (redirectUris.length === 0) return null;
    const name = typeof doc.client_name === 'string' && doc.client_name.trim() ? doc.client_name.trim().slice(0, 100) : 'Claude';
    return { name, redirectUris };
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function tokenResponse(access: string, refresh: string): TokenResponse {
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh };
}
