import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import type { ConfidenceLevel } from '@prisma/client';

export interface EmployeeOption {
  id: string;
  fullName: string;
}

export interface MeetingTaskDraft {
  title: string;
  description: string | null;
  assigneeId: string | null;
  dueDate: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
  confidence: ConfidenceLevel;
  sourceContext: string;
}

// Nullable через anyOf, не через type-массив — тот же приём и то же
// обоснование, что в apps/api/src/voice/draft-extraction.service.ts.
const NULLABLE_STRING = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;

function buildExtractionTool(employeeIds: string[]): Anthropic.Tool {
  return {
    name: 'extract_tasks',
    description:
      'Извлечь из саммари встречи список явных, однозначных поручений/договорённостей — не общих тем обсуждения.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: NULLABLE_STRING,
              // Замкнутый список реальных id сотрудников — модель не может
              // придумать несуществующий id (тот же приём, что в voice).
              assigneeId: { enum: [...employeeIds, null] },
              dueDate: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
              priority: {
                anyOf: [{ type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }, { type: 'null' }],
              },
              confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
              // Короткая цитата/пересказ фрагмента саммари, откуда взята
              // задача — исполнитель должен понимать контекст, даже не имея
              // доступа к самой встрече.
              sourceContext: { type: 'string' },
            },
            required: ['title', 'description', 'assigneeId', 'dueDate', 'priority', 'confidence', 'sourceContext'],
            additionalProperties: false,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  };
}

function buildSystemPrompt(meetingTitle: string, meetingDate: string, employees: EmployeeOption[]): string {
  const employeeTable =
    employees.length > 0 ? employees.map((e) => `- ${e.id}: ${e.fullName}`).join('\n') : '(список пуст)';

  return `Ты помогаешь руководителю превратить саммари встречи в список задач. Вызови инструмент extract_tasks ровно один раз.

Встреча: «${meetingTitle}», дата: ${meetingDate}.

ЧТО СЧИТАТЬ ЗАДАЧЕЙ: явное, однозначное поручение или договорённость сделать
что-то конкретное ("Иван подготовит отчёт к пятнице", "нужно связаться с
поставщиком"). НЕ задача: общая тема обсуждения, констатация факта, мнение,
вопрос без принятого решения. Если сомневаешься — не включай; лучше пропустить
задачу, чем придумать несуществующую.

Относительные даты ("к пятнице", "на следующей неделе") разрешай относительно
ДАТЫ ВСТРЕЧИ (${meetingDate}), не текущего момента — встреча могла быть давно.
Если срок не упоминается явно — dueDate = null, не придумывай.

Сотрудники (id: имя) — закрытый список для assigneeId; исполнитель назван по
имени или через "Speaker N" (если имена спикеров ещё не сопоставлены с
реальными людьми) — используй его, если удаётся сопоставить с списком ниже;
если не назван или не удаётся сопоставить — assigneeId = null:
${employeeTable}

confidence — твоя уверенность именно в деталях (кто исполнитель, какой срок),
не в самом факте, что это задача: HIGH — исполнитель и/или срок явно названы;
MEDIUM — задача явная, но исполнитель/срок предположительны; LOW — задача
угадывается по смыслу, но формулировка расплывчата.

sourceContext — короткая цитата или пересказ (1-2 предложения) фрагмента
саммари, откуда взята эта задача, чтобы исполнитель понимал контекст, даже
не имея доступа к самой встрече.

Если явных поручений в саммари нет вообще — верни tasks: [] (пустой массив),
это нормальный результат, не нужно ничего придумывать, чтобы список не был пустым.`;
}

// Один forced tool-use вызов, без каскада Haiku→Opus (в отличие от
// голосового агента) — это разовое действие по клику руководителя на весь
// текст саммари, не диктовка в реальном времени: качество важнее
// полусекунды задержки, каскад здесь не нужен.
const MODEL = 'claude-opus-5';

@Injectable()
export class MeetingTaskExtractionService {
  private client: Anthropic | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.client;
  }

  async extract(
    summary: string,
    meetingTitle: string,
    meetingDate: string,
    employees: EmployeeOption[],
  ): Promise<MeetingTaskDraft[]> {
    const tool = buildExtractionTool(employees.map((e) => e.id));
    const system = buildSystemPrompt(meetingTitle, meetingDate, employees);

    const response = await this.getClient().messages.create({
      model: MODEL,
      max_tokens: 4096,
      output_config: { effort: 'low' },
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'extract_tasks' },
      messages: [{ role: 'user', content: summary }],
    });

    const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!block) {
      throw new InternalServerErrorException('Claude не вернул структурированный список задач');
    }

    return (block.input as { tasks: MeetingTaskDraft[] }).tasks;
  }
}
