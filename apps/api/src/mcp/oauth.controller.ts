import { Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { isMcpEnabled, mcpAllowedForRole, mcpIssuer, mcpResource } from './mcp-config';
import { OAuthError, OAuthService, type AuthorizeParams } from './oauth.service';

// Метаданные OAuth (RFC 9728 / RFC 8414), регистрация клиента, обмен кода
// на токен — то, что Claude вызывает сам. Согласие пользователя — веб-
// страница /connect, она ходит в /oauth/authorize/* с обычным JWT.

function paramsFrom(source: Record<string, unknown>): AuthorizeParams & { state: string } {
  const s = (k: string) => (typeof source[k] === 'string' ? (source[k]) : '');
  return {
    clientId: s('client_id'),
    redirectUri: s('redirect_uri'),
    codeChallenge: s('code_challenge'),
    codeChallengeMethod: s('code_challenge_method'),
    resource: s('resource') || undefined,
    state: s('state'),
  };
}

@Controller()
export class OAuthController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly config: ConfigService,
  ) {}

  private assertEnabled(): void {
    if (!isMcpEnabled(this.config)) throw new NotFoundException();
  }

  @Get(['.well-known/oauth-protected-resource', '.well-known/oauth-protected-resource/mcp'])
  protectedResource() {
    this.assertEnabled();
    return {
      resource: mcpResource(this.config),
      authorization_servers: [mcpIssuer(this.config)],
      bearer_methods_supported: ['header'],
      resource_name: 'Адъютант',
    };
  }

  @Get(['.well-known/oauth-authorization-server', '.well-known/oauth-authorization-server/mcp'])
  authorizationServer() {
    this.assertEnabled();
    const issuer = mcpIssuer(this.config);
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  @Post('oauth/register')
  async register(@Body() body: unknown, @Res() res: Response) {
    this.assertEnabled();
    try {
      res.status(HttpStatus.CREATED).json(await this.oauth.registerClient(body));
    } catch (err) {
      sendOAuthError(res, err);
    }
  }

  // Claude открывает этот адрес в браузере пользователя — отдаём на
  // страницу входа/согласия веб-приложения с теми же параметрами.
  @Get('oauth/authorize')
  authorize(@Req() req: Request, @Res() res: Response) {
    this.assertEnabled();
    const query = new URLSearchParams(req.query as Record<string, string>).toString();
    const web = (this.config.get<string>('WEB_APP_URL') ?? '').replace(/\/+$/, '');
    res.redirect(HttpStatus.FOUND, `${web}/connect?${query}`);
  }

  @Get('oauth/authorize/describe')
  @UseGuards(JwtAuthGuard)
  async describe(@Query() query: Record<string, unknown>, @CurrentUser() user: AuthenticatedUser) {
    this.assertEnabled();
    try {
      const { clientName } = await this.oauth.describeRequest(paramsFrom(query));
      return { clientName, allowed: mcpAllowedForRole(this.config, user.role) };
    } catch (err) {
      if (err instanceof OAuthError) return { error: err.message };
      throw err;
    }
  }

  @Post('oauth/authorize/approve')
  @UseGuards(JwtAuthGuard)
  async approve(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthenticatedUser) {
    this.assertEnabled();
    const params = paramsFrom(body);
    try {
      const code = await this.oauth.approve(user, params);
      const url = new URL(params.redirectUri);
      url.searchParams.set('code', code);
      if (params.state) url.searchParams.set('state', params.state);
      url.searchParams.set('iss', mcpIssuer(this.config));
      return { redirectTo: url.toString() };
    } catch (err) {
      if (err instanceof OAuthError) return { error: err.message };
      throw err;
    }
  }

  @Post('oauth/token')
  async token(@Body() body: Record<string, unknown>, @Res() res: Response) {
    this.assertEnabled();
    res.set('Cache-Control', 'no-store');
    try {
      const grantType = body?.grant_type;
      if (grantType === 'authorization_code') return void res.json(await this.oauth.exchangeCode(body));
      if (grantType === 'refresh_token') return void res.json(await this.oauth.refresh(body));
      throw new OAuthError('unsupported_grant_type', 'Поддерживаются authorization_code и refresh_token');
    } catch (err) {
      sendOAuthError(res, err);
    }
  }

  // «Мой профиль» → подключённые приложения.
  @Get('oauth/connections')
  @UseGuards(JwtAuthGuard)
  async connections(@CurrentUser() user: AuthenticatedUser) {
    if (!isMcpEnabled(this.config)) return { enabled: false, allowed: false, items: [] };
    return { enabled: true, allowed: mcpAllowedForRole(this.config, user.role), items: await this.oauth.listConnections(user.id) };
  }

  @Delete('oauth/connections/:id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.oauth.revoke(user.id, id);
  }
}

function sendOAuthError(res: Response, err: unknown): void {
  if (err instanceof OAuthError) {
    res.status(err.status).json({ error: err.code, error_description: err.message });
    return;
  }
  res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'server_error' });
}
