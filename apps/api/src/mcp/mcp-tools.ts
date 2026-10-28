import type Anthropic from '@anthropic-ai/sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolExecutionResult } from '../assistant/assistant-tools.service';

// Какие инструменты ассистента отдаются внешнему ИИ. Только чтение:
// create_task_from_meeting и legal_review_contract привязаны к беседе
// ассистента (идемпотентность, ответ приходит в чат), export_tasks_xlsx
// кладёт файл, который Claude не скачает. Список явный — новый инструмент
// ассистента наружу сам не попадёт.
export const MCP_TOOL_TITLES: Record<string, string> = {
  get_tasks: 'Задачи',
  find_tasks: 'Поиск задач',
  get_task: 'Задача',
  get_events: 'Календарь руководителя',
  find_events: 'Поиск событий календаря',
  find_free_slots: 'Свободное время в календаре',
  get_recent_meetings: 'Последние встречи',
  search_meetings: 'Поиск встреч',
  get_meeting: 'Встреча',
  search_meeting_transcript: 'Поиск по расшифровкам встреч',
  find_employee_by_competency: 'Сотрудники по компетенции',
  search_emails: 'Поиск писем',
  get_email: 'Письмо',
  legal_ask: 'Юрист: вопрос по НПА РК',
  legal_review_status: 'Юрист: статус разборов договоров',
};

export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  annotations: { title: string; readOnlyHint: true; destructiveHint: false; openWorldHint: false };
}

export function toMcpTools(tools: Anthropic.Tool[]): McpToolDescriptor[] {
  return tools
    .filter((t) => Object.hasOwn(MCP_TOOL_TITLES, t.name))
    .map((t) => {
      const title = MCP_TOOL_TITLES[t.name];
      return {
        name: t.name,
        title,
        description: t.description ?? title,
        inputSchema: t.input_schema,
        annotations: { title, readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      };
    });
}

// Результат инструмента ассистента → ответ MCP. Ответ юриста — готовый
// markdown с проверенными цитатами (тот же, что видит пользователь в чате),
// остальное — JSON без служебного поля tool.
export function toMcpResult(result: ToolExecutionResult): CallToolResult {
  if ('error' in result) return { content: [{ type: 'text', text: result.message }], isError: true };
  if (result.tool === 'legal_ask') {
    return {
      content: [
        {
          type: 'text',
          text: `${result.markdown}\n\n---\nЦитаты норм сверены с базой НПА Адъютанта. Передавай их пользователю дословно, не пересказывай нормы своими словами.`,
        },
      ],
    };
  }
  const payload: Record<string, unknown> = { ...result };
  delete payload.tool;
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }] };
}

export const MCP_SERVER_INSTRUCTIONS =
  'Адъютант — система задач и контроля поручений компании (Казахстан, время Asia/Almaty). ' +
  'Инструменты только читают данные от имени подключившегося сотрудника и с его правами: задачи видны всем, ' +
  'календарь, встречи и почта — только руководству. Даты в ответах — ISO 8601 в UTC. ' +
  'Юридические вопросы по законодательству РК задавай через legal_ask (ответ 1–2 минуты) и не подменяй его ответ своими знаниями.';
