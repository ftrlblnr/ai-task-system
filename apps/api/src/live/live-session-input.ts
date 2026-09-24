// Stage 2, Phase Q hardening (24.09.2026) — session.input GPT-Live: недавняя
// переписка Assistant-разговора, чтобы «Живой голос» продолжал текстовый диалог,
// а не начинал с нуля. Доки: поле принимается ТОЛЬКО при создании сессии,
// ≤128 сообщений и ≤8192 токенов, роли developer|user|assistant, один
// текстовый part на сообщение (input_text для user, output_text для
// assistant), tool/function-элементы не допускаются. Поведение при
// превышении лимита в доках не описано — держим большой запас.

export const LIVE_INPUT_MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 800;
const MAX_TOTAL_CHARS = 6000; // ≈ 2.5k токенов для кириллицы ≪ 8192

export interface LiveInputMessage {
  type: 'message';
  role: 'user' | 'assistant';
  content: [{ type: 'input_text' | 'output_text'; text: string }];
}

// history — от старых к новым; уже только текст (tool/card/file-части
// отфильтрованы в AssistantChatService.getRecentMessages).
export function buildSessionInput(history: { role: 'user' | 'assistant'; text: string }[]): LiveInputMessage[] {
  const trimmed = history
    .map((m) => ({ role: m.role, text: m.text.replace(/\s+/g, ' ').trim() }))
    .filter((m) => m.text)
    .slice(-LIVE_INPUT_MAX_MESSAGES)
    .map((m) => ({ role: m.role, text: m.text.length > MAX_MESSAGE_CHARS ? m.text.slice(0, MAX_MESSAGE_CHARS) + '…' : m.text }));

  // Общий бюджет: выкидываем самые старые сообщения целиком (свежее важнее).
  let total = trimmed.reduce((sum, m) => sum + m.text.length, 0);
  while (trimmed.length > 1 && total > MAX_TOTAL_CHARS) {
    total -= (trimmed.shift() as { text: string }).text.length;
  }

  return trimmed.map((m) => ({
    type: 'message',
    role: m.role,
    content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.text }],
  }));
}
