// Stage 2, Phase Q hardening (24.09.2026) — небольшой ring buffer транскрипта
// GPT-Live. Доки: session.input_transcript.delta / output_transcript.delta —
// фрагменты, а НЕ полные ходы (события done нет), у делегации есть только
// offset_ms без текста. Поэтому запрос и контекст собираются из фрагментов
// самим приложением. Класс чистый (без I/O и таймеров) — время приходит извне.

export type LiveSpeaker = 'user' | 'assistant';

interface Fragment {
  speaker: LiveSpeaker;
  text: string;
  startMs?: number;
  endMs?: number;
  consumed: boolean;
}

// Хранится только небольшой хвост, не вся сессия.
const WINDOW_MS = 3 * 60 * 1000;
const MAX_FRAGMENTS = 200;
const MAX_TOTAL_CHARS = 6000;

// Контекст для Assistant Core — несколько последних ходов, не весь транскрипт.
export const MAX_CONTEXT_TURNS = 8;
export const MAX_CONTEXT_CHARS = 1500;

export class LiveTranscriptBuffer {
  private fragments: Fragment[] = [];
  private maxUserEndMs = -1;

  addFragment(speaker: LiveSpeaker, text: string, startMs?: number, endMs?: number): void {
    if (!text) return;
    this.fragments.push({ speaker, text, startMs, endMs, consumed: false });
    if (speaker === 'user' && typeof endMs === 'number') this.maxUserEndMs = Math.max(this.maxUserEndMs, endMs);
    this.trim();
  }

  // Самая дальняя точка user-речи на таймлайне сессии (−1, если тайминга не
  // было) — сервис использует её для раннего выхода из ожидания хвоста.
  get userCoverageMs(): number {
    return this.maxUserEndMs;
  }

  hasUnconsumedUserText(): boolean {
    return this.fragments.some((f) => f.speaker === 'user' && !f.consumed);
  }

  // Атомарно: текущая команда + контекст БЕЗ неё. Команда = ещё не потреблённые
  // user-фрагменты, начавшиеся не позже offset_ms делегации (фрагменты без
  // тайминга относятся к текущей команде; более поздние остаются для
  // следующей). Контекст — обе стороны, включая прошлые реплики Live-
  // ассистента и прошлые команды; ещё не взятая user-речь в него не входит
  // (это следующая реплика).
  takeTurn(offsetMs: number): { command: string; context: string } {
    const taken = this.fragments.filter(
      (f) => f.speaker === 'user' && !f.consumed && (f.startMs === undefined || f.startMs <= offsetMs),
    );
    const takenSet = new Set(taken);
    for (const f of taken) f.consumed = true;

    const command = taken
      .map((f) => f.text)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    return { command, context: this.buildContext(takenSet) };
  }

  private buildContext(exclude: Set<Fragment>): string {
    const turns: { speaker: LiveSpeaker; text: string }[] = [];
    for (const f of this.fragments) {
      if (exclude.has(f)) continue;
      if (f.speaker === 'user' && !f.consumed) continue;
      const last = turns[turns.length - 1];
      if (last && last.speaker === f.speaker) last.text += f.text;
      else turns.push({ speaker: f.speaker, text: f.text });
    }
    const lines = turns
      .map((t) => ({ speaker: t.speaker, text: t.text.replace(/\s+/g, ' ').trim() }))
      .filter((t) => t.text)
      .slice(-MAX_CONTEXT_TURNS)
      .map((t) => `${t.speaker === 'user' ? 'User' : 'Assistant'}: ${t.text}`);

    // Обрезка с начала (свежее важнее): выкидываем самые старые ходы целиком.
    let total = lines.reduce((sum, l) => sum + l.length + 1, 0);
    while (lines.length > 1 && total > MAX_CONTEXT_CHARS) {
      total -= (lines.shift() as string).length + 1;
    }
    const joined = lines.join('\n');
    return joined.length > MAX_CONTEXT_CHARS ? joined.slice(joined.length - MAX_CONTEXT_CHARS) : joined;
  }

  private trim(): void {
    const newestEnd = this.fragments.reduce((m, f) => Math.max(m, f.endMs ?? f.startMs ?? -1), -1);
    if (newestEnd >= 0) {
      this.fragments = this.fragments.filter((f) => {
        const t = f.endMs ?? f.startMs;
        return t === undefined || newestEnd - t <= WINDOW_MS || !f.consumed;
      });
    }
    if (this.fragments.length > MAX_FRAGMENTS) this.fragments = this.fragments.slice(-MAX_FRAGMENTS);
    let total = this.fragments.reduce((sum, f) => sum + f.text.length, 0);
    while (total > MAX_TOTAL_CHARS && this.fragments.length > 1) {
      total -= (this.fragments.shift() as Fragment).text.length;
    }
  }
}
