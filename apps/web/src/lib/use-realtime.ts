import { useEffect, useRef } from 'react';
import { api } from './api';

// Мгновенные обновления вместо опроса (владелец 21.10.2026): сервер шлёт
// «в теме что-то изменилось», экран перезапрашивает данные сам. Обрыв —
// переподключение с паузой; после переподключения onChange вызывается
// сразу, чтобы не пропустить изменения, пришедшие во время обрыва.
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;
// Несколько изменений подряд (перестановка, вызов) — один перезапрос.
const DEBOUNCE_MS = 300;

// 'assistant' и 'legal' — личные темы: сервер шлёт событие только владельцу
// (итог разбора договора пришёл в беседу, разбор сменил статус).
export type RealtimeTopic = 'reception' | 'assistant' | 'legal';

export function useRealtime(topic: RealtimeTopic, onChange: () => void) {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const controller = new AbortController();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let retryMs = RETRY_MIN_MS;
    const notify = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => onChangeRef.current(), DEBOUNCE_MS);
    };

    async function connect(isReconnect: boolean) {
      while (!controller.signal.aborted) {
        try {
          const response = await api.openEventStream(`/realtime/stream?topic=${topic}`, controller.signal);
          const reader = response.body?.getReader();
          if (!reader) throw new Error('no-stream');
          if (isReconnect) notify();
          retryMs = RETRY_MIN_MS;
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (value) buffer += decoder.decode(value, { stream: true });
            let frameEnd: number;
            while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, frameEnd);
              buffer = buffer.slice(frameEnd + 2);
              if (frame.split('\n').some((l) => l === 'event: change')) notify();
            }
            if (done) break;
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        isReconnect = true;
        await new Promise((r) => setTimeout(r, retryMs));
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    }

    void connect(false);
    return () => {
      controller.abort();
      if (debounce) clearTimeout(debounce);
    };
  }, [topic]);
}
