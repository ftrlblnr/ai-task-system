import { createHash } from 'crypto';
import type { MemoryKind, RecommendationAction, RecommendationArea, RecommendationEffort, RoutineChannel, RoutineMode, SkillModel } from '@prisma/client';

// ARMS, фаза 5 — рекомендации: чистые билдеры промпта, схема ответа и
// разбор. Opus 5.5 отвечает JSON по схеме (output_config.format): forced
// tool_choice на нём даёт 400.

export const RECO_MODEL = 'claude-opus-5-5';
export const RECO_MAX_TOKENS = 16000;
export const RECO_MAX_ITEMS = 10;
export const RECO_WINDOW_MS = 7 * 86400_000;
// Бюджет входа (символы) — недельный «лимит токенов» анализа.
export const RECO_PROMPT_BUDGET = 60000;
const CHAT_BUDGET = 25000;
const CHAT_EXCERPT = 300;

const ACTIONS: RecommendationAction[] = ['CREATE_ROUTINE', 'REVISE_SKILL', 'ADD_MEMORY', 'ARCHIVE_MEMORY', 'DOWNGRADE_SKILL_MODEL', 'SET_ROUTINE_CAP', 'DISABLE_SKILL', 'DEV_TASK'];
const MEMORY_KINDS: MemoryKind[] = ['PREFERENCE', 'FACT', 'PERSON', 'RULE', 'CONTEXT'];
const MODEL_RANK: Record<SkillModel, number> = { HAIKU: 0, SONNET: 1, OPUS: 2 };

export const ACTION_AREA: Record<RecommendationAction, RecommendationArea> = {
  CREATE_ROUTINE: 'ROUTINES',
  SET_ROUTINE_CAP: 'ROUTINES',
  REVISE_SKILL: 'SKILLS',
  DOWNGRADE_SKILL_MODEL: 'SKILLS',
  DISABLE_SKILL: 'SKILLS',
  ADD_MEMORY: 'MEMORY',
  ARCHIVE_MEMORY: 'MEMORY',
  DEV_TASK: 'APPS',
};

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

export const RECO_SCHEMA = {
  type: 'object',
  properties: {
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTIONS },
          title: { type: 'string', description: 'Коротко, что сделать — до 80 символов' },
          benefit: { type: 'string', description: 'Польза для руководителя, 1–2 предложения, с опорой на факты недели' },
          plan: { type: 'string', description: 'Что именно изменится при применении, 1–2 предложения' },
          effort: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
          priority: { type: 'integer', description: '1 — высокий, 2 — средний, 3 — низкий' },
          tokenSaving: nullable({ type: 'integer', description: 'Экономия токенов в неделю, если рекомендация про расход' }),
          targetId: { type: 'string', description: 'id навыка/регламента/пункта памяти из данных; пустая строка, если цели нет' },
          text: { type: 'string', description: 'ADD_MEMORY — текст пункта; REVISE_SKILL — новая инструкция целиком; DEV_TASK — постановка для разработчика (markdown); иначе пустая строка' },
          memoryKind: nullable({ type: 'string', enum: MEMORY_KINDS }),
          model: nullable({ type: 'string', enum: ['HAIKU', 'SONNET', 'OPUS'] }),
          weeklyTokenCap: nullable({ type: 'integer' }),
          routine: nullable({
            type: 'object',
            properties: {
              title: { type: 'string' },
              prompt: { type: 'string', description: 'Инструкция агенту; пустая строка, если регламент запускает навык targetId' },
              days: { type: 'array', items: { type: 'integer' }, description: 'Дни недели 1=пн … 7=вс' },
              time: { type: 'string', description: 'ЧЧ:ММ по Алматы' },
              mode: { type: 'string', enum: ['ACTIVE', 'PASSIVE'] },
              channel: { type: 'string', enum: ['FEED', 'TELEGRAM', 'BOTH'] },
            },
            required: ['title', 'prompt', 'days', 'time', 'mode', 'channel'],
            additionalProperties: false,
          }),
        },
        required: ['action', 'title', 'benefit', 'plan', 'effort', 'priority', 'tokenSaving', 'targetId', 'text', 'memoryKind', 'model', 'weeklyTokenCap', 'routine'],
        additionalProperties: false,
      },
    },
  },
  required: ['recommendations'],
  additionalProperties: false,
} as const;

export const RECO_SYSTEM = `Ты — аналитик корпоративного ассистента «Адъютант» (руководитель
строительной компании, Казахстан). Раз в неделю ты смотришь, как
руководитель работал с ассистентом последние 7 дней, и предлагаешь
3–10 улучшений, которые экономят его время или деньги на ИИ.

Что искать:
- Повторяющиеся вопросы и ручная рутина в чате → регламент по расписанию
  (CREATE_ROUTINE) или пункт памяти (ADD_MEMORY), если ассистент
  переспрашивает одно и то же.
- Навыки с 👎 и замечаниями → новая инструкция (REVISE_SKILL, text —
  инструкция целиком). Простые навыки на дорогой модели → DOWNGRADE_SKILL_MODEL.
  Навыки, которыми не пользуются, → DISABLE_SKILL.
- Дорогие регламенты без пользы (молчат или падают) → SET_ROUTINE_CAP.
- Устаревшие или противоречащие пункты памяти → ARCHIVE_MEMORY.
- То, что требует доработки программы (новый экран, интеграция, отчёт),
  → DEV_TASK: text — понятная постановка для разработчика.

Правила:
- Опирайся только на данные ниже, в benefit называй конкретику (сколько
  раз спрашивал, сколько стоило). Нет оснований — не предлагай.
- targetId — только id из данных. Не повторяй отклонённые и уже открытые
  рекомендации, даже другими словами.
- Регламент: PASSIVE (присылает только при находках) для проверок,
  ACTIVE для сводок; channel TELEGRAM по умолчанию; время — рабочее.
- Если за неделю почти не было активности — меньше рекомендаций, не
  выдумывай. Пиши по-русски, коротко, без канцелярита.`;

export interface RecoChatMessage {
  at: Date;
  text: string;
}

export interface RecoAiFeature {
  feature: string;
  calls: number;
  errors: number;
  costUsd: number;
  tokens: number;
}

export interface RecoSkill {
  id: string;
  slug: string;
  title: string;
  model: SkillModel;
  enabled: boolean;
  shared: boolean;
  // /тон: стиль писем подмешивается сам, без запусков — не «неиспользуемый».
  service: boolean;
  runs7d: number;
  runs30d: number;
  up: number;
  down: number;
  comments: string[];
}

export interface RecoRoutine {
  id: string;
  title: string;
  state: string;
  schedule: string | null;
  mode: string;
  weeklyTokenCap: number | null;
  runs: Record<string, number>;
  tokens7d: number;
  costUsd7d: number;
}

export interface RecoMemory {
  id: string;
  kind: string;
  text: string;
  useCount: number;
  lastUsedAt: Date | null;
}

export interface RecoInput {
  now: Date;
  chat: RecoChatMessage[];
  ai: RecoAiFeature[];
  skills: RecoSkill[];
  routines: RecoRoutine[];
  memory: RecoMemory[];
  rejectedRevisions: string[];
  dismissed: string[];
  open: string[];
  applied: string[];
}

const usd = (v: number) => `$${v.toFixed(2)}`;
const day = (d: Date) => new Date(d.getTime() + 5 * 3600_000).toISOString().slice(0, 10);

export function buildRecoUserContent(input: RecoInput): string {
  const chatLines: string[] = [];
  let used = 0;
  for (const m of input.chat) {
    const line = `- ${day(m.at)}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, CHAT_EXCERPT)}`;
    if (used + line.length > CHAT_BUDGET) break;
    chatLines.push(line);
    used += line.length;
  }
  const sections = [
    `Сегодня ${day(input.now)}. Данные за 7 дней.`,
    `## Сообщения руководителя ассистенту (${input.chat.length})\n${chatLines.join('\n') || '(нет)'}`,
    `## Расход ИИ по функциям (вся система)\n${
      input.ai.map((a) => `- ${a.feature}: вызовов ${a.calls}, ошибок ${a.errors}, ${usd(a.costUsd)}, токенов ${a.tokens}`).join('\n') || '(нет)'
    }`,
    `## Навыки\n${
      input.skills
        .map(
          (s) =>
            `- id=${s.id} /${s.slug} «${s.title}» модель ${s.model}${s.enabled ? '' : ' (в архиве)'}${s.shared ? ' (общий)' : ''}${s.service ? ' (служебный: стиль писем, применяется автоматически без запусков — не отключать)' : ''}: запусков 7д ${s.runs7d}, 30д ${s.runs30d}, 👍${s.up} 👎${s.down}${
              s.comments.length ? `; замечания: ${s.comments.map((c) => `«${c}»`).join('; ')}` : ''
            }`,
        )
        .join('\n') || '(нет)'
    }`,
    `## Регламенты\n${
      input.routines
        .map(
          (r) =>
            `- id=${r.id} «${r.title}» ${r.state}, ${r.schedule ? `cron ${r.schedule}` : 'по кнопке'}, ${r.mode}, лимит ${r.weeklyTokenCap ?? 'нет'}; прогоны 7д: ${
              Object.entries(r.runs)
                .map(([k, v]) => `${k} ${v}`)
                .join(', ') || 'нет'
            }; токенов ${r.tokens7d}, ${usd(r.costUsd7d)}`,
        )
        .join('\n') || '(нет)'
    }`,
    `## Память (активные пункты)\n${
      input.memory.map((m) => `- id=${m.id} [${m.kind}] ${m.text} (использован ${m.useCount} раз${m.lastUsedAt ? `, последний ${day(m.lastUsedAt)}` : ''})`).join('\n') || '(нет)'
    }`,
    `## Отклонённые предложения по навыкам\n${input.rejectedRevisions.map((t) => `- ${t}`).join('\n') || '(нет)'}`,
    `## Отклонённые рекомендации — не предлагать снова\n${input.dismissed.map((t) => `- ${t}`).join('\n') || '(нет)'}`,
    `## Уже открытые рекомендации — не повторять\n${input.open.map((t) => `- ${t}`).join('\n') || '(нет)'}`,
    `## Применённые за 30 дней — уже сделано, не повторять\n${input.applied.map((t) => `- ${t}`).join('\n') || '(нет)'}`,
  ];
  return sections.join('\n\n').slice(0, RECO_PROMPT_BUDGET);
}

export interface RecoRoutineDraft {
  title: string;
  prompt: string;
  days: number[];
  time: string;
  mode: RoutineMode;
  channel: RoutineChannel;
}

export interface RecoPayload {
  targetId: string | null;
  text: string | null;
  memoryKind: MemoryKind | null;
  model: SkillModel | null;
  weeklyTokenCap: number | null;
  routine: RecoRoutineDraft | null;
}

export interface ParsedReco {
  area: RecommendationArea;
  action: RecommendationAction;
  title: string;
  benefit: string;
  plan: string;
  effort: RecommendationEffort;
  priority: number;
  tokenSaving: number | null;
  payload: RecoPayload;
  fingerprint: string;
}

// То, что модель может назвать целью: всё остальное — выдумка, отбрасываем.
export interface RecoTargets {
  skills: Map<string, { model: SkillModel; enabled: boolean; service?: boolean }>;
  routines: Set<string>;
  memory: Set<string>;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// То же действие над той же целью (навык, регламент, пункт памяти).
export function recoTargetKey(action: RecommendationAction, targetId: string | null): string | null {
  return targetId ? `target:${action}:${targetId}` : null;
}

export function recoFingerprint(action: RecommendationAction, targetId: string | null, title: string): string {
  return createHash('sha1').update(`${action}:${targetId ?? ''}:${normalizeTitle(title)}`).digest('hex');
}

function parseRoutine(v: unknown): RecoRoutineDraft | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const days = Array.isArray(r.days) ? [...new Set(r.days.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b) : [];
  const time = typeof r.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) ? r.time : '09:00';
  return {
    title: str(r.title, 80),
    prompt: str(r.prompt, 4000),
    days,
    time,
    mode: r.mode === 'ACTIVE' ? 'ACTIVE' : 'PASSIVE',
    channel: r.channel === 'FEED' || r.channel === 'BOTH' ? r.channel : 'TELEGRAM',
  };
}

// Одна рекомендация → проверенная или null (нет цели, нечего применять).
function parseOne(raw: unknown, targets: RecoTargets): ParsedReco | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = r.action as RecommendationAction;
  if (!ACTIONS.includes(action)) return null;
  const title = str(r.title, 120);
  const benefit = str(r.benefit, 600);
  const plan = str(r.plan, 600);
  if (title.length < 3 || !benefit || !plan) return null;
  const targetId = str(r.targetId, 64) || null;
  const text = str(r.text, 12000) || null;
  const payload: RecoPayload = { targetId: null, text: null, memoryKind: null, model: null, weeklyTokenCap: null, routine: null };
  const skill = targetId ? targets.skills.get(targetId) : undefined;

  switch (action) {
    case 'CREATE_ROUTINE': {
      const routine = parseRoutine(r.routine);
      if (!routine || routine.title.length < 2) return null;
      if (skill) payload.targetId = targetId;
      else if (routine.prompt.length < 10) return null;
      payload.routine = routine;
      break;
    }
    case 'REVISE_SKILL':
      if (!skill || !text || text.length < 20) return null;
      Object.assign(payload, { targetId, text });
      break;
    case 'DOWNGRADE_SKILL_MODEL': {
      const model = r.model as SkillModel;
      if (!skill || !(model in MODEL_RANK) || MODEL_RANK[model] >= MODEL_RANK[skill.model]) return null;
      Object.assign(payload, { targetId, model });
      break;
    }
    case 'DISABLE_SKILL':
      if (!skill?.enabled || skill.service) return null;
      payload.targetId = targetId;
      break;
    case 'ADD_MEMORY': {
      const kind = r.memoryKind as MemoryKind;
      if (!MEMORY_KINDS.includes(kind) || !text || text.length < 5) return null;
      Object.assign(payload, { memoryKind: kind, text: text.slice(0, 300) });
      break;
    }
    case 'ARCHIVE_MEMORY':
      if (!targetId || !targets.memory.has(targetId)) return null;
      payload.targetId = targetId;
      break;
    case 'SET_ROUTINE_CAP': {
      const cap = r.weeklyTokenCap;
      if (!targetId || !targets.routines.has(targetId) || typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1000) return null;
      Object.assign(payload, { targetId, weeklyTokenCap: cap });
      break;
    }
    case 'DEV_TASK':
      if (!text) return null;
      payload.text = text;
      break;
  }

  const priority = typeof r.priority === 'number' ? Math.min(3, Math.max(1, Math.round(r.priority))) : 2;
  const saving = typeof r.tokenSaving === 'number' && r.tokenSaving > 0 ? Math.round(r.tokenSaving) : null;
  const effort: RecommendationEffort = r.effort === 'LOW' || r.effort === 'HIGH' ? r.effort : 'MEDIUM';
  return {
    area: ACTION_AREA[action],
    action,
    title,
    benefit,
    plan,
    effort,
    priority,
    tokenSaving: saving,
    payload,
    fingerprint: recoFingerprint(action, payload.targetId, title),
  };
}

// known — отпечатки и ключи целей уже бывших рекомендаций (отклонённых,
// открытых, недавно применённых): повтор той же рекомендации не создаём,
// даже если модель назвала её другими словами.
export function parseRecommendations(text: string, targets: RecoTargets, known: Set<string>): ParsedReco[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Ответ модели — не JSON');
  }
  const list = (data as { recommendations?: unknown })?.recommendations;
  if (!Array.isArray(list)) throw new Error('В ответе нет списка рекомендаций');
  const seen = new Set(known);
  const out: ParsedReco[] = [];
  for (const raw of list) {
    const reco = parseOne(raw, targets);
    const targetKey = reco && recoTargetKey(reco.action, reco.payload.targetId);
    if (!reco || seen.has(reco.fingerprint) || (targetKey && seen.has(targetKey))) continue;
    seen.add(reco.fingerprint);
    if (targetKey) seen.add(targetKey);
    out.push(reco);
    if (out.length >= RECO_MAX_ITEMS) break;
  }
  return out.sort((a, b) => a.priority - b.priority);
}

// Плановый ключ недели — дата пятницы (по Алматы), в которую собирали.
export function weekKeyFor(now: Date): string {
  return day(now);
}
