import type Anthropic from '@anthropic-ai/sdk';
import type { TaskCardData } from '@ai-task-system/shared-types';

// Поручения из встреч в чате (AGENT_AND_MEETINGS.md, B.5) — это и путь с
// телефона: в Mini App нет экрана встречи, руководитель говорит «разбери
// вчерашнюю планёрку» и «утверди все, кроме третьего». Те же сервисы, что у
// кнопок на странице встречи (MeetingAnalysisService/MeetingProposalsService).
// Только руководству; регламентам и MCP пишущие не выдаются (isWriteTool).

export const ANALYZE_MEETING_TOOL: Anthropic.Tool = {
  name: 'analyze_meeting',
  description:
    'Запустить разбор записи встречи — найти в ней поручения с исполнителями и сроками («разбери планёрку», «найди поручения во вчерашней встрече»). Встречу сначала найди через get_recent_meetings/search_meetings. Разбор идёт пару минут в фоне и стоит вызова большой модели — запускай только по прямой просьбе. Задачи сам разбор НЕ ставит: результат — список предложений (get_meeting_proposals), их утверждает руководитель.',
  input_schema: {
    type: 'object',
    properties: { meetingId: { type: 'string' } },
    required: ['meetingId'],
  },
};

export const GET_MEETING_PROPOSALS_TOOL: Anthropic.Tool = {
  name: 'get_meeting_proposals',
  description:
    'Показать поручения, найденные разбором встречи, и состояние разбора. У каждого поручения номер n — по нему пользователь говорит «кроме третьего»; используй эти номера в approve_meeting_proposals.',
  input_schema: {
    type: 'object',
    properties: { meetingId: { type: 'string' } },
    required: ['meetingId'],
  },
};

export const APPROVE_MEETING_PROPOSALS_TOOL: Anthropic.Tool = {
  name: 'approve_meeting_proposals',
  description:
    'Утвердить или отклонить поручения разбора встречи — только по прямой команде руководителя («утверди все», «утверди все, кроме третьего», «второе отклони»). Утверждённые становятся обычными задачами, исполнитель получает уведомление. approve — номера n из get_meeting_proposals («все» — перечисли все ждущие решения); reject — номера, которые отклонить; edits — правки перед утверждением («срок Жандосу — среда»): исполнитель КАК прозвучал, срок — местное время без смещения («ГГГГ-ММ-ДД» или «ГГГГ-ММ-ДДTчч:мм»). Сначала вызови get_meeting_proposals, если номера в этом разговоре ещё не видел.',
  input_schema: {
    type: 'object',
    properties: {
      meetingId: { type: 'string' },
      approve: { type: 'array', items: { type: 'integer', minimum: 1 } },
      reject: { type: 'array', items: { type: 'integer', minimum: 1 } },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer', minimum: 1 },
            title: { type: 'string' },
            assigneeRawText: { type: 'string' },
            dueDate: { type: 'string' },
          },
          required: ['n'],
        },
      },
    },
    required: ['meetingId'],
  },
};

export const MEETING_TOOLS: Anthropic.Tool[] = [ANALYZE_MEETING_TOOL, GET_MEETING_PROPOSALS_TOOL, APPROVE_MEETING_PROPOSALS_TOOL];

export interface ProposalEditInput {
  n: number;
  title?: string;
  assigneeRawText?: string;
  dueDate?: string;
}

export interface ApproveMeetingProposalsInput {
  meetingId: string;
  approve: number[];
  reject: number[];
  edits: ProposalEditInput[];
}

function numbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseMeetingId(input: unknown): string {
  return text((input as { meetingId?: unknown } | null)?.meetingId) ?? '';
}

export function parseApproveMeetingProposalsInput(input: unknown): ApproveMeetingProposalsInput {
  const raw = (input ?? {}) as { approve?: unknown; reject?: unknown; edits?: unknown };
  const edits: ProposalEditInput[] = [];
  if (Array.isArray(raw.edits)) {
    for (const e of raw.edits as Record<string, unknown>[]) {
      const n = Number(e?.n);
      if (!Number.isInteger(n) || n < 1) continue;
      edits.push({ n, title: text(e.title), assigneeRawText: text(e.assigneeRawText), dueDate: text(e.dueDate) });
    }
  }
  const approve = numbers(raw.approve);
  // Одно и то же поручение и «утвердить», и «отклонить» — утверждение
  // важнее: отказ руководитель скажет явно ещё раз, потерянная задача хуже.
  const reject = numbers(raw.reject).filter((n) => !approve.includes(n));
  return { meetingId: parseMeetingId(input), approve, reject, edits };
}

// Для модели: коротко и с номером. Цитату и таймкод — чтобы она могла
// ответить «это про смету, 12:40».
export interface MeetingProposalData {
  n: number;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';
  title: string;
  assignee: string | null;
  assigneeAsHeard: string | null;
  dueDate: string | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  source: string;
  timestamp: string | null;
  similarTo: string | null;
}

export interface ApproveMeetingProposalsData {
  approved: TaskCardData[];
  rejected: number;
  failed: { n: number; title: string; message: string }[];
}
