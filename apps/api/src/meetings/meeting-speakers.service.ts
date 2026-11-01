import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import type { ConfidenceLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiUsageService, trackedCreate } from '../ai-usage/ai-usage.service';
import { EmployeeResolverService, normalizeAliasText } from '../employees/employee-resolver.service';

// Поручения из встреч, шаг 1 — кто есть кто (AGENT_AND_MEETINGS.md, B.3).
// Без имён говорящих извлечение не сопоставит «Speaker 2 подготовит смету»
// с сотрудником. Модель только предлагает имя по репликам и кандидатам;
// сотрудника по имени находит EmployeeResolverService, как у голосового
// assigneeRawText. Применяется само только при полной уверенности (см.
// shouldAutoApply), иначе остаётся подсказкой на странице встречи.
// Haiku: задача — сопоставление по контексту, не рассуждение.
const MODEL = 'claude-haiku-5-5';

const REPLICAS_PER_SPEAKER = 12;
const REPLICA_MAX_CHARS = 300;
// Участники календарных событий владельца вокруг времени записи — первые
// кандидаты: совещание обычно стоит в календаре.
const EVENT_WINDOW_MS = 30 * 60 * 1000;

export interface SpeakerSuggestion {
  label: string;
  // Сотрудник, если имя однозначно сопоставлено; внешний участник — null.
  employeeId: string | null;
  name: string | null;
  confidence: ConfidenceLevel;
  applied: boolean;
}

export interface SpeakerSegment {
  speakerLabel: string;
  startMs: number;
  text: string;
}

interface Candidate {
  id: string;
  fullName: string;
  aliases: string[];
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Метки в порядке первого появления в расшифровке.
export function speakerLabels(segments: SpeakerSegment[]): string[] {
  return [...new Set(segments.map((s) => s.speakerLabel))];
}

export function buildSpeakerExcerpts(segments: SpeakerSegment[]): string {
  return speakerLabels(segments)
    .map((label) => {
      const lines = segments
        .filter((s) => s.speakerLabel === label)
        .slice(0, REPLICAS_PER_SPEAKER)
        .map((s) => `${mmss(s.startMs)} ${s.text.length > REPLICA_MAX_CHARS ? `${s.text.slice(0, REPLICA_MAX_CHARS)}…` : s.text}`);
      return `## ${label}\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

// Само применяем, только если модель уверена во ВСЕХ метках и имена
// различны: одна ошибка в имени даёт поручение не тому человеку, а
// подсказку руководитель подтверждает одним нажатием.
export function shouldAutoApply(labels: string[], suggestions: SpeakerSuggestion[]): boolean {
  if (labels.length === 0) return false;
  const byLabel = new Map(suggestions.map((s) => [s.label, s]));
  const names = new Set<string>();
  for (const label of labels) {
    const s = byLabel.get(label);
    if (!s || !s.name || s.confidence !== 'HIGH') return false;
    names.add(normalizeAliasText(s.name));
  }
  return names.size === labels.length;
}

// Имена, введённые человеком (или применённые раньше), не перезаписываются.
export function hasSpeakerNames(speakerNames: unknown): boolean {
  if (!speakerNames || typeof speakerNames !== 'object') return false;
  return Object.values(speakerNames as Record<string, unknown>).some((v) => typeof v === 'string' && v.trim().length > 0);
}

function buildTool(labels: string[]): Anthropic.Tool {
  return {
    name: 'map_speakers',
    description: 'Сопоставить метки говорящих записи встречи с именами участников.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        speakers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', enum: labels },
              // Имя как его стоит показать: из списка кандидатов или
              // прозвучавшее в записи имя внешнего участника.
              name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
            },
            required: ['label', 'name', 'confidence'],
            additionalProperties: false,
          },
        },
      },
      required: ['speakers'],
      additionalProperties: false,
    },
  };
}

function candidateLine(c: Candidate): string {
  return c.aliases.length > 0 ? `- ${c.fullName} (зовут также: ${c.aliases.join(', ')})` : `- ${c.fullName}`;
}

function buildSystemPrompt(meetingTitle: string, owner: Candidate | null, invited: Candidate[], others: Candidate[]): string {
  const ownerLine = owner ? `Запись сделал(а) ${owner.fullName} — скорее всего, это один из говорящих.` : '';
  return `Ты определяешь, кто из участников встречи говорит под каждой меткой расшифровки («Speaker 1» и т.п.). Вызови инструмент map_speakers ровно один раз и перечисли каждую метку.

Встреча: «${meetingTitle}». ${ownerLine}

Участники по календарю (вероятнее всего):
${invited.length > 0 ? invited.map(candidateLine).join('\n') : '(в календаре участников нет)'}

Остальные сотрудники:
${others.length > 0 ? others.map(candidateLine).join('\n') : '(нет)'}

Как определять: по обращениям («Жандос, подготовь…» — отвечает следующий говорящий), представлениям, упоминаниям себя, роли в разговоре. Внешний участник (клиент, подрядчик), названный по имени, — его имя как прозвучало.

confidence: HIGH — имя прямо следует из реплик (к человеку обратились по имени и он ответил, он представился); MEDIUM — вероятно по контексту; LOW — догадка. Не уверен совсем — name = null. Две разные метки не могут быть одним человеком.`;
}

@Injectable()
export class MeetingSpeakersService {
  private client: Anthropic | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly resolver: EmployeeResolverService,
    @Optional() private readonly aiUsage?: AiUsageService,
  ) {}

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.client;
  }

  private async candidates(ownerId: string, meetingDate: Date) {
    const employees = await this.prisma.employee.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, fullName: true, aliases: { select: { alias: true } } },
    });
    const all: Candidate[] = employees.map((e) => ({ id: e.id, fullName: e.fullName, aliases: e.aliases.map((a) => a.alias) }));
    // Те же события, что EventsService.findBetween (созданные владельцем,
    // подтверждённые), но с участниками — напрямую через Prisma, без
    // зависимости модуля встреч от модуля календаря.
    const events = await this.prisma.event.findMany({
      where: {
        createdById: ownerId,
        status: 'CONFIRMED',
        startAt: { lt: new Date(meetingDate.getTime() + EVENT_WINDOW_MS) },
        endAt: { gt: new Date(meetingDate.getTime() - EVENT_WINDOW_MS) },
      },
      select: { participants: { select: { employeeId: true } } },
    });
    const invitedIds = new Set(events.flatMap((e) => e.participants.map((p) => p.employeeId)));
    invitedIds.delete(ownerId);
    return {
      all,
      owner: all.find((c) => c.id === ownerId) ?? null,
      invited: all.filter((c) => invitedIds.has(c.id)),
      others: all.filter((c) => c.id !== ownerId && !invitedIds.has(c.id)),
    };
  }

  async suggest(meeting: { title: string; meetingDate: Date; createdById: string }, segments: SpeakerSegment[]): Promise<SpeakerSuggestion[]> {
    const labels = speakerLabels(segments);
    if (labels.length === 0) return [];
    const { all, owner, invited, others } = await this.candidates(meeting.createdById, meeting.meetingDate);

    const response = await trackedCreate(this.aiUsage, 'meetings.auto-speakers', this.getClient(), {
      model: MODEL,
      max_tokens: 2000,
      system: buildSystemPrompt(meeting.title, owner, invited, others),
      tools: [buildTool(labels)],
      tool_choice: { type: 'tool', name: 'map_speakers' },
      messages: [{ role: 'user', content: buildSpeakerExcerpts(segments) }],
    });
    const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const raw = (block?.input as { speakers?: { label: string; name: string | null; confidence: ConfidenceLevel }[] } | undefined)?.speakers;
    if (!Array.isArray(raw)) return [];

    const suggestions: SpeakerSuggestion[] = [];
    const seen = new Set<string>();
    for (const s of raw) {
      // Метка вне расшифровки или повтор — модель ошиблась, пропускаем.
      if (!labels.includes(s.label) || seen.has(s.label)) continue;
      seen.add(s.label);
      const name = s.name?.trim() || null;
      const resolution = name ? await this.resolver.resolve(name, all) : null;
      const employeeId = resolution?.status === 'RESOLVED' ? resolution.employeeId : null;
      suggestions.push({
        label: s.label,
        employeeId,
        // Сотрудник — полным именем из справочника, а не как назвала модель.
        name: employeeId ? (all.find((c) => c.id === employeeId)?.fullName ?? name) : name,
        confidence: s.confidence,
        applied: false,
      });
    }
    return suggestions;
  }
}
