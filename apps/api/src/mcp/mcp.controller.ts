import { All, Controller, HttpStatus, Logger, NotFoundException, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AssistantToolsService } from '../assistant/assistant-tools.service';
import { AuditService } from '../audit/audit.service';
import { isMcpEnabled, mcpIssuer } from './mcp-config';
import { MCP_SERVER_INSTRUCTIONS, MCP_TOOL_TITLES, toMcpResult, toMcpTools } from './mcp-tools';
import { OAuthService, type McpUser } from './oauth.service';

// MCP-сервер для Claude (владелец 22.10.2026): Streamable HTTP без сессий —
// новый Server на каждый запрос, пользователь — из Bearer-токена OAuth.
// Инструменты — те же, что у ассистента (AssistantToolsService), с теми же
// правами по роли.
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly oauth: OAuthService,
    private readonly tools: AssistantToolsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  @All()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!isMcpEnabled(this.config)) throw new NotFoundException();

    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const user = token ? await this.oauth.authenticate(token) : null;
    if (!user) {
      res
        .status(HttpStatus.UNAUTHORIZED)
        .set('WWW-Authenticate', `Bearer resource_metadata="${mcpIssuer(this.config)}/.well-known/oauth-protected-resource"`)
        .json({ error: 'invalid_token', error_description: 'Нужно подключение через вход в Адъютант' });
      return;
    }

    // Без сессий: GET (поток уведомлений) и DELETE (закрытие сессии) не нужны.
    if (req.method !== 'POST') {
      res.status(HttpStatus.METHOD_NOT_ALLOWED).set('Allow', 'POST').json({ error: 'method_not_allowed' });
      return;
    }

    const server = this.buildServer(user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.logger.error(`mcp request failed: ${e.message}`, e.stack);
      if (!res.headersSent) res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }

  private buildServer(user: McpUser): Server {
    const server = new Server({ name: 'adyutant', title: 'Адъютант', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: MCP_SERVER_INSTRUCTIONS });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toMcpTools(await this.tools.buildTools(user)) }));

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      // Видимость — как в чате ассистента: инструмента нет в списке для
      // этой роли (или он не отдаётся наружу) — вызвать его нельзя.
      const available = Object.hasOwn(MCP_TOOL_TITLES, name) && (await this.tools.buildTools(user)).some((t) => t.name === name);
      if (!available) return { content: [{ type: 'text', text: `Инструмент недоступен: ${name}` }], isError: true };
      void this.audit.log(user.id, 'MCP_TOOL_CALL', 'McpTool', name, {});
      return toMcpResult(await this.tools.execute(name, args ?? {}, user));
    });

    return server;
  }
}
