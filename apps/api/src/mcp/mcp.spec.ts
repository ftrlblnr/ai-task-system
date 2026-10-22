import type Anthropic from '@anthropic-ai/sdk';
import { isAllowedRedirectUri } from './oauth.service';
import { toMcpResult, toMcpTools } from './mcp-tools';

describe('MCP: адреса возврата OAuth', () => {
  it('пускает только Claude и loopback', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isAllowedRedirectUri('https://claude.com/api/mcp/auth_callback')).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:53122/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:8080/cb')).toBe(true);
    expect(isAllowedRedirectUri('https://claude.ai/other')).toBe(false);
    expect(isAllowedRedirectUri('https://evil.example/api/mcp/auth_callback')).toBe(false);
    expect(isAllowedRedirectUri('http://localhost.evil.example/cb')).toBe(false);
    expect(isAllowedRedirectUri('http://user:pw@localhost/cb')).toBe(false);
    expect(isAllowedRedirectUri('не адрес')).toBe(false);
  });
});

describe('MCP: инструменты', () => {
  const tool = (name: string): Anthropic.Tool => ({ name, description: name, input_schema: { type: 'object', properties: {} } });

  it('отдаёт наружу только чтение, с подсказкой readOnly', () => {
    const out = toMcpTools([tool('get_tasks'), tool('create_task_from_meeting'), tool('export_tasks_xlsx'), tool('legal_review_contract'), tool('legal_ask'), tool('toString')]);
    expect(out.map((t) => t.name)).toEqual(['get_tasks', 'legal_ask']);
    expect(out.every((t) => t.annotations.readOnlyHint && !t.annotations.destructiveHint)).toBe(true);
  });

  it('ошибка инструмента → isError, без служебного поля tool в данных', () => {
    expect(toMcpResult({ tool: 'get_tasks', error: true, message: 'X: нет' })).toEqual({ content: [{ type: 'text', text: 'X: нет' }], isError: true });
    const ok = toMcpResult({ tool: 'get_tasks', items: [], totalCount: 0 });
    expect(JSON.parse((ok.content[0] as { text: string }).text)).toEqual({ items: [], totalCount: 0 });
  });
});
