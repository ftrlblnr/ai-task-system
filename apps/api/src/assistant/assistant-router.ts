import type Anthropic from '@anthropic-ai/sdk';

// ARMS, фаза 3 — маршрутизация моделей. Обычный чат остаётся на Haiku;
// дешёвый шаг-роутер (Haiku, принудительный инструмент — на Haiku 5.5 это
// можно) решает, не нужен ли сложному вопросу Opus. Включается только
// флагом ASSISTANT_ROUTER=on: сначала смотрим на «Расход ИИ», потом решаем.

export const ROUTER_MODEL = 'claude-haiku-5-5';
export const DEEP_MODEL = 'claude-opus-5-5';
const ROUTER_INPUT_MAX = 2000;

export type RouteTier = 'fast' | 'deep';

export const ROUTER_SYSTEM = `Ты выбираешь модель для ответа ассистента руководителя.
fast — почти всё: вопросы о задачах, встречах, письмах, поставить задачу,
найти, ответить на письмо, короткие справки, обычный разговор.
deep — только когда нужен анализ: сравнить несколько встреч или
документов, найти противоречия, подготовить развёрнутый документ или
план, разобрать сложную ситуацию с несколькими сторонами.
Сомневаешься — fast.`;

export function buildRouterTool(): Anthropic.Tool {
  return {
    name: 'route',
    description: 'Выбрать модель для ответа.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: ['fast', 'deep'] },
        reason: { type: 'string', description: 'Почему — до 10 слов' },
      },
      required: ['tier', 'reason'],
      additionalProperties: false,
    },
  };
}

export function buildRouterInput(text: string): string {
  return `Сообщение пользователя:\n${text.trim().slice(0, ROUTER_INPUT_MAX)}`;
}

export function parseRoute(input: unknown): { tier: RouteTier; reason: string } {
  const d = (input ?? {}) as { tier?: unknown; reason?: unknown };
  return {
    tier: d.tier === 'deep' ? 'deep' : 'fast',
    reason: typeof d.reason === 'string' ? d.reason.slice(0, 200) : '',
  };
}
