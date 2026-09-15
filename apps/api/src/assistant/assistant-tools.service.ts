import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { EventStatus, Role } from '@prisma/client';
import { TasksService } from '../tasks/tasks.service';
import { EventsService } from '../calendar/events.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import type { TaskCardData, EventCardData } from './dto/message-part-data.dto';

// Столько карточек максимум в одном ответе — то же соображение, что
// MAX_CONTEXT_TASKS/MAX_CONTEXT_EVENTS в voice.service.ts: не заваливать
// ответ 40 карточками. totalCount ниже — реальное число до среза, чтобы
// модель могла честно сказать "всего 37, вот первые 10", а не соврать про
// количество.
const MAX_TOOL_ITEMS = 10;

export type GetTasksFilter = 'all' | 'overdue';

export type ToolExecutionResult =
  | { tool: 'get_tasks'; items: TaskCardData[]; totalCount: number }
  | { tool: 'get_events'; items: EventCardData[]; totalCount: number }
  | { tool: 'get_tasks' | 'get_events'; error: true; message: string };

// Инструменты, которые Assistant Core (assistant-reply.service.ts) может
// предложить модели — только чтение, ничего не мутирует (спека Stage 2
// §16/§33: этот этап не про изменение задач/событий голосом-текстом, это
// уже делает voice-модуль своим отдельным путём). RBAC — на уровне того,
// какие инструменты вообще ВИДИТ модель (buildTools), а не постфактум:
// get_events просто отсутствует в списке для не-OWNER, тот же принцип,
// что уже в VoiceService.parse для видимости календаря.
@Injectable()
export class AssistantToolsService {
  constructor(
    private readonly tasks: TasksService,
    private readonly events: EventsService,
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
      return { tool: 'get_tasks', error: true, message: `Неизвестный инструмент: ${name}` };
    } catch (err) {
      return {
        tool: name === 'get_events' ? 'get_events' : 'get_tasks',
        error: true,
        message: err instanceof Error ? err.message : 'Не удалось выполнить запрос',
      };
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
