import type { VoiceActionResult, VoiceParseResponse } from '@ai-task-system/shared-types';

// Stage 2, Phase Q (24.09.2026) — озвучка итога делегации GPT-Live. Делегация
// выполняется тем же голосовым пайплайном, что и push-to-talk (VoiceService:
// задачи/события/чат), а Live-модель должна ПРОГОВОРИТЬ результат. Текст строится
// из уже выполненных results[] в порядке произнесения; ошибки — безопасной
// фразой без err.message; успех говорится только для ok=true.

// Лимит append у GPT-Live — 500 токенов; кириллица токенизируется хуже
// латиницы, берём консервативно.
export const MAX_COMMENTARY_CHARS = 900;
const TRUNCATION_SUFFIX = ' Подробности в чате.';
const EMPTY_ANSWER = 'Готово, подробности в чате.';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Значения приходят как местное время без смещения ("2026-09-25T15:00:00") или
// только датой ("2026-09-25") — разбираем строку, а не Date (без сдвигов TZ).
function speakDateTime(value: string | null | undefined, allDay = false): string | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!match) return null;
  const day = Number(match[3]);
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return null;
  const date = `${day} ${month}`;
  return match[4] && !allDay ? `${date} в ${match[4]}:${match[5]}` : date;
}

function speakResult(r: VoiceActionResult): string {
  if (r.type === 'chat') return r.reply;

  if (r.type === 'task_action') {
    const d = r.draft;
    const title = d.action === 'create' ? d.title : d.title || d.targetTitle;
    if (!r.ok) {
      const verb = d.action === 'create' ? 'создать' : d.action === 'update' ? 'изменить' : 'удалить';
      return `Не удалось ${verb} задачу «${title}», подробности в чате.`;
    }
    if (d.action === 'delete') return `Удалил задачу «${d.targetTitle}».`;
    if (d.action === 'update') return `Обновил задачу «${title}».`;
    const due = speakDateTime(d.dueDate);
    // Имя приходит в именительном падеже — не склоняем ("для Азамат"), говорим нейтрально.
    return `Создал задачу «${title}»${d.assigneeName ? `, исполнитель ${d.assigneeName}` : ''}${due ? `, срок ${due}` : ''}.`;
  }

  const d = r.draft;
  const title = d.action === 'create' ? d.title : d.title || d.targetTitle;
  if (!r.ok) {
    const verb = d.action === 'create' ? 'добавить' : d.action === 'update' ? 'изменить' : 'удалить';
    return `Не удалось ${verb} встречу «${title}», подробности в чате.`;
  }
  const warning = r.warning ? ' С участниками возникла проблема, подробности в чате.' : '';
  if (d.action === 'delete') return `Удалил встречу «${d.targetTitle}».`;
  if (d.action === 'update') return `Изменил встречу «${title}».${warning}`;
  const when = speakDateTime(d.startAt, d.allDay === true);
  return `Добавил в календарь «${title}»${when ? ` на ${when}` : ''}.${warning}`;
}

export function toSpokenLiveReply(response: Pick<VoiceParseResponse, 'results' | 'clarificationReason'>): string {
  const parts = response.results.map(speakResult);
  // Уточнение — общий вопрос по всей реплике; chat-ответ уже сам содержит вопрос.
  const hasChat = response.results.some((r) => r.type === 'chat');
  if (!hasChat && response.clarificationReason) parts.push(response.clarificationReason);

  const text = parts
    .join(' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return EMPTY_ANSWER;
  if (text.length <= MAX_COMMENTARY_CHARS) return text;
  const budget = MAX_COMMENTARY_CHARS - TRUNCATION_SUFFIX.length;
  const cut = text.slice(0, budget);
  const lastSentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (lastSentenceEnd > budget / 2 ? cut.slice(0, lastSentenceEnd + 1) : cut.trimEnd()) + TRUNCATION_SUFFIX;
}
