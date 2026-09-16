import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { EventStatus, Role } from '@prisma/client';
import { TasksService } from '../tasks/tasks.service';
import { EventsService } from '../calendar/events.service';
import { FilesService } from '../files/files.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import type { TaskCardData, EventCardData, FilePartData } from './dto/message-part-data.dto';
import { buildTasksWorkbookBuffer } from './task-export';

// Тот же MIME, что уже в ALLOWED_UPLOAD_MIME_TYPES (upload-file.dto.ts) для
// пользовательских .xlsx-вложений — единственный формат, который эта фаза
// генерирует.
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Столько карточек максимум в одном ответе — то же соображение, что
// MAX_CONTEXT_TASKS/MAX_CONTEXT_EVENTS в voice.service.ts: не заваливать
// ответ 40 карточками. totalCount ниже — реальное число до среза, чтобы
// модель могла честно сказать "всего 37, вот первые 10", а не соврать про
// количество.
const MAX_TOOL_ITEMS = 10;

export type GetTasksFilter = 'all' | 'overdue';

type KnownToolName = 'get_tasks' | 'get_events' | 'export_tasks_xlsx';

function resolveToolName(name: string): KnownToolName {
  if (name === 'get_events') return 'get_events';
  if (name === 'export_tasks_xlsx') return 'export_tasks_xlsx';
  return 'get_tasks';
}

// Безопасные коды для tool_result (аудит 16.09.2026, Phase F.1, P2.1) —
// расширено третьим инструментом в Phase G тем же приёмом.
const TOOL_ERROR_MESSAGES: Record<KnownToolName, string> = {
  get_tasks: 'TASK_LOOKUP_FAILED: не удалось получить список задач',
  get_events: 'CALENDAR_LOOKUP_FAILED: не удалось получить события календаря',
  export_tasks_xlsx: 'EXPORT_FAILED: не удалось сформировать файл',
};

export type ToolExecutionResult =
  | { tool: 'get_tasks'; items: TaskCardData[]; totalCount: number }
  | { tool: 'get_events'; items: EventCardData[]; totalCount: number }
  | { tool: 'export_tasks_xlsx'; file: FilePartData; totalCount: number }
  | { tool: 'get_tasks' | 'get_events' | 'export_tasks_xlsx'; error: true; message: string };

// Инструменты, которые Assistant Core (assistant-reply.service.ts) может
// предложить модели — только чтение, ничего не мутирует (спека Stage 2
// §16/§33: этот этап не про изменение задач/событий голосом-текстом, это
// уже делает voice-модуль своим отдельным путём). RBAC — на уровне того,
// какие инструменты вообще ВИДИТ модель (buildTools), а не постфактум:
// get_events просто отсутствует в списке для не-OWNER, тот же принцип,
// что уже в VoiceService.parse для видимости календаря.
@Injectable()
export class AssistantToolsService {
  private readonly logger = new Logger(AssistantToolsService.name);

  constructor(
    private readonly tasks: TasksService,
    private readonly events: EventsService,
    private readonly files: FilesService,
  ) {}

  buildTools(user: AuthenticatedUser): Anthropic.Tool[] {
    const tools: Anthropic.Tool[] = [
      {
        name: 'get_tasks',
        description:
          'Получить список задач, видимых текущему пользователю (свои для сотрудника, все для руководителя), с исполнителем, сроком и статусом.',
        input_schema: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              enum: ['all', 'overdue'],
              description: '"all" — все видимые задачи, "overdue" — только просроченные',
            },
          },
          required: ['filter'],
        },
      },
      {
        name: 'export_tasks_xlsx',
        description:
          'Сформировать файл Excel (.xlsx) со списком задач, видимых пользователю, и приложить его к ответу как файл для скачивания. Используй, когда пользователь просит выгрузить/экспортировать задачи файлом/таблицей/экселем, а не просто посмотреть их в чате.',
        input_schema: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              enum: ['all', 'overdue'],
              description: '"all" — все видимые задачи, "overdue" — только просроченные',
            },
          },
          required: ['filter'],
        },
      },
    ];

    // Календарь — личный календарь руководителя, весь CalendarController
    // закрыт на Role.OWNER (раздел 5 ТЗ) — сотруднику этот инструмент не
    // предлагается вообще, а не отклоняется после вызова.
    if (user.role === Role.OWNER) {
      tools.push({
        name: 'get_events',
        description: 'Получить список предстоящих подтверждённых встреч в личном календаре руководителя.',
        input_schema: { type: 'object', properties: {} },
      });
    }

    return tools;
  }

  async execute(name: string, input: unknown, user: AuthenticatedUser): Promise<ToolExecutionResult> {
    try {
      if (name === 'get_tasks') {
        const filter = (input as { filter?: unknown } | null)?.filter;
        return await this.getTasks(user, filter === 'overdue' ? 'overdue' : 'all');
      }
      if (name === 'get_events') return await this.getEvents(user);
      if (name === 'export_tasks_xlsx') {
        const filter = (input as { filter?: unknown } | null)?.filter;
        return await this.exportTasksXlsx(user, filter === 'overdue' ? 'overdue' : 'all');
      }
      return { tool: 'get_tasks', error: true, message: `Неизвестный инструмент: ${name}` };
    } catch (err) {
      const tool = resolveToolName(name);
      // Полная ошибка (может содержать детали БД/инфраструктуры) — только в
      // серверный лог. Модели (и через неё — пользователю) уходит только
      // безопасный код + короткая фраза, без err.message (аудит 16.09.2026,
      // находка про утечку сырых ошибок в tool_result).
      const err2 = err instanceof Error ? err : new Error(String(err));
      this.logger.error(`tool=${name} failed: ${err2.message}`, err2.stack);
      return { tool, error: true, message: TOOL_ERROR_MESSAGES[tool] };
    }
  }

  private async getTasks(user: AuthenticatedUser, filter: GetTasksFilter = 'all'): Promise<ToolExecutionResult> {
    const tasks = await this.tasks.findAll(user);
    const filtered = filter === 'overdue' ? tasks.filter((t) => t.isOverdue) : tasks;
    const items: TaskCardData[] = filtered.slice(0, MAX_TOOL_ITEMS).map((t) => ({
      taskId: t.id,
      title: t.title,
      status: t.status,
      // findAll() вызывается напрямую (в обход HTTP-сериализации), поэтому
      // dueDate — сырой Prisma Date, не строка (тот же приём, что уже был
      // пойман в voice.service.ts при прямом вызове TasksService.findOne).
      dueDate: t.dueDate ? t.dueDate.toISOString() : null,
      assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.fullName } : null,
    }));
    return { tool: 'get_tasks', items, totalCount: filtered.length };
  }

  // Stage 2, Phase G — в отличие от getTasks выше, здесь НЕТ среза на
  // MAX_TOOL_ITEMS: карточки в чате намеренно ограничены (не заваливать
  // ответ), но весь смысл экспорта в файл — увидеть больше, чем 10 задач,
  // иначе экспорт был бы бесполезен ровно в том случае, ради которого его
  // и попросили.
  private async exportTasksXlsx(user: AuthenticatedUser, filter: GetTasksFilter = 'all'): Promise<ToolExecutionResult> {
    const tasks = await this.tasks.findAll(user);
    const filtered = filter === 'overdue' ? tasks.filter((t) => t.isOverdue) : tasks;
    const buffer = await buildTasksWorkbookBuffer(filtered);
    const label = filter === 'overdue' ? 'просроченные' : 'все';
    const name = `Задачи (${label}) ${new Date().toISOString().slice(0, 10)}.xlsx`;
    const artifact = await this.files.createGenerated(user, buffer, name, XLSX_MIME_TYPE);
    return {
      tool: 'export_tasks_xlsx',
      totalCount: filtered.length,
      file: { fileId: artifact.id, name: artifact.name, mimeType: artifact.mimeType, size: artifact.size },
    };
  }

  private async getEvents(user: AuthenticatedUser): Promise<ToolExecutionResult> {
    const now = new Date();
    const events = await this.events.findAll(user.id);
    const upcoming = events.filter((e) => e.status !== EventStatus.CANCELLED && e.startAt >= now);
    const items: EventCardData[] = upcoming.slice(0, MAX_TOOL_ITEMS).map((e) => ({
      eventId: e.id,
      title: e.title,
      startAt: e.startAt.toISOString(),
      endAt: e.endAt.toISOString(),
      location: e.location,
      participants: e.participants.map((p) => ({ id: p.id, name: p.fullName })),
    }));
    return { tool: 'get_events', items, totalCount: upcoming.length };
  }
}
