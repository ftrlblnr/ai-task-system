'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationMessage, ConversationSummary, MessagePart, StreamEvent, UploadedFileInfo } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { haptic } from '@/lib/telegram';
import { onAssistantRefresh } from '@/lib/assistant-refresh';

// Переписка с ассистентом: история с сервера и отправка со стримингом (SSE).
// Вынесено из assistant-screen.tsx (редизайн M5, MINIAPP_REDESIGN.md §4.6)
// без изменения поведения — комментарии с историей решений сохранены.

export interface FailedSend {
  clientRequestId: string;
  text: string;
  attachments: UploadedFileInfo[];
}

export function newClientRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function optimisticUserMessage(
  conversationId: string,
  clientRequestId: string,
  text: string,
  attachments: UploadedFileInfo[],
): ConversationMessage {
  const parts: MessagePart[] = [{ id: 'optimistic-text', type: 'markdown', order: 0, data: { content: text } }];
  attachments.forEach((a, i) =>
    parts.push({
      id: `optimistic-file-${i}`,
      type: 'file',
      order: i + 1,
      data: { fileId: a.fileId, name: a.name, mimeType: a.mimeType, size: a.size },
    }),
  );
  return {
    id: `optimistic-user-${clientRequestId}`,
    conversationId,
    role: 'user',
    status: 'completed',
    clientRequestId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    parts,
  };
}

function optimisticAssistantMessage(conversationId: string, clientRequestId: string): ConversationMessage {
  return {
    id: `optimistic-assistant-${clientRequestId}`,
    conversationId,
    role: 'assistant',
    status: 'pending',
    clientRequestId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    parts: [],
  };
}

// "Живые" части ответа, пока стрим ещё идёт (Stage 2, Phase E) — статусы
// инструментов в порядке вызова, затем накопленный на данный момент текст.
// Карточки задач/событий здесь не появляются: они не стримятся токен за
// токеном, а приходят готовыми в message.completed вместе с остальным
// финальным сообщением (спека не требует стримить карточки по частям).
function buildLiveParts(toolStates: { name: string; label: string | null }[], liveText: string): MessagePart[] {
  const parts: MessagePart[] = toolStates.map((t, i) => ({
    id: `live-tool-${i}`,
    type: 'tool_activity',
    order: i,
    data: { label: t.label ?? 'Проверяю…' },
  }));
  parts.push({ id: 'live-text', type: 'markdown', order: toolStates.length, data: { content: liveText } });
  return parts;
}

// История — с сервера (Phase B), не localStorage: refresh/другое устройство
// видят ту же переписку (спека §27), в том числе голосовые реплики.
export function useAssistantStream() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Когда последний раз догрузилась история — запрос из другого раздела
  // (useAssistantRequest) отправляем только после неё, иначе ответ load()
  // затёр бы только что добавленное сообщение.
  const [historyLoadedAt, setHistoryLoadedAt] = useState(0);
  const [sending, setSending] = useState(false);
  // Сетевой сбой самой отправки/обрыв стрима (не серверная ошибка внутри
  // уже полученного сообщения — та пришла бы как обычный FAILED
  // assistant-message с ErrorPart) — спека §28: сообщение пользователя не
  // удаляется, кнопка «Повторить» шлёт тот же clientRequestId,
  // идемпотентность (Phase B, уточнена в Phase E — см. backend) не даёт
  // дубля и реально повторяет попытку, если предыдущая не удалась.
  const [failedSend, setFailedSend] = useState<FailedSend | null>(null);
  // Дизайн-система «Адъютант» (владелец 04.10.2026, implementation.md шаг 7)
  // — кнопка «Остановить ответ» в Composer; AbortController, не React state
  // (нужен только внутри текущего send(), ре-рендер не требуется).
  const sendAbortRef = useRef<AbortController | null>(null);
  const userStoppedRef = useRef(false);
  // "Создано только что" (материализация, agent-motion.md) — id сообщений,
  // завершённых ЖИВЫМ стримом в этой сессии. Не React state: мутируется в
  // handleEvent синхронно с setMessages из того же вызова, тот же ре-рендер
  // подхватывает оба изменения; при обычной загрузке истории (load())
  // сюда ничего не попадает, поэтому старые сообщения никогда не "фреш".
  const freshMessageIdsRef = useRef<Set<string>>(new Set());
  const conversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  // Тихое обновление ленты (без сброса в «загрузку» — экран не мигает).
  const refreshMessagesSilently = useCallback(() => {
    const id = conversationIdRef.current;
    if (!id) return;
    api
      .get<ConversationMessage[]>(`/assistant/conversations/${id}/messages`)
      .then((msgs) => {
        if (conversationIdRef.current !== id) return;
        setMessages((prev) => {
          const a = prev?.[prev.length - 1];
          const b = msgs[msgs.length - 1];
          const unchanged = prev && prev.length === msgs.length && a?.id === b?.id && a?.updatedAt === b?.updatedAt;
          return unchanged ? prev : msgs;
        });
      })
      .catch(() => undefined);
  }, []);

  // «Отменить» на карточке задачи (единый агент A2): сервер дописал
  // «Отменено.» — подтягиваем. Пока идёт ответ, не перечитываем (затёрли бы
  // стрим) — сообщение появится при следующей загрузке.
  const sendingRef = useRef(false);
  sendingRef.current = sending;
  useEffect(
    () =>
      onAssistantRefresh(() => {
        if (!sendingRef.current) refreshMessagesSilently();
      }),
    [refreshMessagesSilently],
  );

  // .then()-цепочка, не async/await — тот же стиль, что tasks-screen.tsx
  // (тоже вызывается из useEffect по active): react-hooks/set-state-in-effect
  // не всегда прослеживает setState через await до конца цепочки внутри
  // async-функции, вызванной из эффекта, и ложно считает это "синхронным"
  // вызовом setState прямо в эффекте.
  function load() {
    api
      .get<ConversationSummary[]>('/assistant/conversations')
      .then((conversations) => {
        const id = conversations[0]?.id;
        if (!id) return undefined;
        setConversationId(id);
        return api.get<ConversationMessage[]>(`/assistant/conversations/${id}/messages`).then(setMessages);
      })
      .then(() => {
        setLoadError(null);
        setHistoryLoadedAt(Date.now());
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить переписку'));
  }

  // Готовые сообщения со стороны (голос: userMessage + assistantMessage из
  // POST /voice/parse) — в ту же ленту, без отдельного рендер-пути.
  function appendMessages(added: ConversationMessage[], newConversationId?: string | null) {
    setMessages((prev) => [...(prev ?? []), ...added]);
    if (!conversationId && newConversationId) setConversationId(newConversationId);
  }

  // onAccepted — сообщение принято к отправке (не повтор): экран очищает
  // поле ввода и вложения в тот же момент, что и раньше.
  async function send(rawText: string, attachments: UploadedFileInfo[], retryClientRequestId?: string, onAccepted?: () => void) {
    const isRetry = Boolean(retryClientRequestId);
    const value = rawText.trim();
    if (!value || sending || !conversationId) return;

    const clientRequestId = retryClientRequestId ?? newClientRequestId();
    const assistantPlaceholderId = `optimistic-assistant-${clientRequestId}`;

    setSending(true);
    setFailedSend(null);
    if (!isRetry) onAccepted?.();

    setMessages((prev) => {
      const base = prev ?? [];
      const withUser = isRetry ? base : [...base, optimisticUserMessage(conversationId, clientRequestId, value, attachments)];
      return [...withUser, optimisticAssistantMessage(conversationId, clientRequestId)];
    });

    // Живое состояние на время стрима — обычные переменные, не React state:
    // React state нужен только для того, что реально рендерится
    // (parts текущего "живого" сообщения), сам накопитель — просто буфер.
    let liveText = '';
    const toolStates: { name: string; label: string | null }[] = [];
    let terminal = false;

    function renderLive() {
      setMessages((prev) =>
        (prev ?? []).map((m) =>
          m.id === assistantPlaceholderId ? { ...m, status: 'streaming', parts: buildLiveParts(toolStates, liveText) } : m,
        ),
      );
    }

    // P1.7 (аудит 16.09.2026) — text-delta приходит от Anthropic по
    // несколько раз в секунду на каждый маленький токен; setMessages на
    // каждый chunk означал лишний ре-рендер всего списка сообщений чаще,
    // чем экран физически успевает перерисоваться. Копим дельты в liveText
    // (обычная переменная выше), реально вызываем setMessages не чаще
    // одного раза за кадр — сам SSE-транспорт и бэкенд не меняются.
    let renderScheduled = false;
    function scheduleRender() {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(() => {
        renderScheduled = false;
        renderLive();
      });
    }

    function handleEvent(event: StreamEvent) {
      switch (event.event) {
        case 'part.started':
          liveText = '';
          scheduleRender();
          break;
        case 'part.delta':
          liveText += event.delta;
          scheduleRender();
          break;
        case 'tool.started':
          toolStates.push({ name: event.tool, label: null });
          scheduleRender();
          break;
        case 'tool.completed': {
          const pending = toolStates.find((t) => t.name === event.tool && t.label === null);
          if (pending) pending.label = event.label;
          scheduleRender();
          break;
        }
        case 'message.completed':
          terminal = true;
          freshMessageIdsRef.current.add(event.message.id);
          setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId).concat(event.message));
          break;
        case 'message.failed':
          terminal = true;
          setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId));
          setFailedSend({ clientRequestId, text: value, attachments });
          break;
        case 'message.started':
          // Phase F.2 (аудит 17.09.2026, P2.10) — заменяет optimistic
          // user-бабл авторитетным сообщением с сервера (тот же принцип,
          // что message.completed уже делает для ответа ассистента выше)
          // — до этого события бабл оставался локальным черновиком до
          // следующего getMessages()/refresh, метаданные вложений могли
          // не совпадать с тем, что реально сохранил бэкенд.
          setMessages((prev) => (prev ?? []).map((m) => (m.id === `optimistic-user-${clientRequestId}` ? event.userMessage : m)));
          break;
      }
    }

    const controller = new AbortController();
    sendAbortRef.current = controller;
    userStoppedRef.current = false;

    try {
      const response = await api.postStream(
        `/assistant/conversations/${conversationId}/messages/stream`,
        { text: value, clientRequestId, attachmentIds: attachments.map((a) => a.fileId) },
        controller.signal,
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Поток ответа недоступен');
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (chunk) buffer += decoder.decode(chunk, { stream: true });
        let frameEnd: number;
        while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          handleEvent(JSON.parse(dataLine.slice(5).trim()) as StreamEvent);
        }
        if (done) break;
      }

      // Соединение закрылось, не дойдя ни до message.completed, ни до
      // message.failed (обрыв сети, сервер упал до финального события) —
      // тот же "Повторить"-путь, что и обычный сетевой сбой.
      if (!terminal) {
        setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId));
        setFailedSend({ clientRequestId, text: value, attachments });
      }
    } catch (err) {
      // Остановлено самим пользователем (кнопка «Остановить ответ») — не
      // сбой: оставляем накопленный к этому моменту текст как обычный
      // завершённый ответ, без "Ответ был прерван" / "Повторить".
      if (userStoppedRef.current) {
        terminal = true;
        setMessages((prev) =>
          (prev ?? []).map((m) =>
            m.id === assistantPlaceholderId ? { ...m, status: 'completed', parts: buildLiveParts(toolStates, liveText) } : m,
          ),
        );
      } else if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId));
        setFailedSend({ clientRequestId, text: value, attachments });
      }
    } finally {
      sendAbortRef.current = null;
      setSending(false);
    }
  }

  function stopSending() {
    haptic('light');
    userStoppedRef.current = true;
    sendAbortRef.current?.abort();
  }

  return {
    conversationId,
    conversationIdRef,
    messages,
    loadError,
    historyLoadedAt,
    sending,
    failedSend,
    freshMessageIds: freshMessageIdsRef.current,
    load,
    refreshMessagesSilently,
    appendMessages,
    send,
    stopSending,
  };
}
