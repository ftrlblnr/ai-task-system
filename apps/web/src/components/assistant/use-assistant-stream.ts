'use client';

import { useEffect, useRef, useState } from 'react';
import type { AgentPageContext, ConversationMessage, MessagePart, StreamEvent, UploadedFileInfo } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useRealtime } from '@/lib/use-realtime';

// Переписка с ассистентом: история с сервера и отправка со стримингом (SSE).
// Вынесено из app/assistant/page.tsx (редизайн web W0, docs/WEB_REDESIGN.md)
// без изменения поведения — общий код страницы /assistant и будущей панели
// агента (W2).

export interface FailedSend {
  clientRequestId: string;
  text: string;
  attachments: UploadedFileInfo[];
  // Контекст страницы на момент отправки — «Повторить» шлёт тот же.
  context?: AgentPageContext;
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

interface Options {
  conversationId: string | null;
  // Сервер мог сменить заголовок разговора (после первого ответа, фоновые
  // сообщения) — обновить список разговоров.
  onTitlesChanged: () => void;
}

export function useAssistantStream({ conversationId, onTitlesChanged }: Options) {
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [failedSend, setFailedSend] = useState<FailedSend | null>(null);
  // Дизайн-система «Адъютант» (владелец 04.10.2026, implementation.md шаг 7)
  // — кнопка «Остановить ответ» в Composer; AbortController, не React state
  // (нужен только внутри текущего send(), ре-рендер не требуется).
  const sendAbortRef = useRef<AbortController | null>(null);
  const userStoppedRef = useRef(false);
  // "Создано только что" (материализация, agent-motion.md) — id сообщений,
  // завершённых ЖИВЫМ стримом в этой сессии. Не React state: мутируется в
  // handleEvent синхронно с setMessages из того же вызова, тот же ре-рендер
  // подхватывает оба изменения; при обычной загрузке истории (loadMessages)
  // сюда ничего не попадает, поэтому старые сообщения никогда не "фреш".
  // Стабильный Set из useState, а не ref: его читает рендер ленты.
  const [freshMessageIds] = useState(() => new Set<string>());
  const conversationIdRef = useRef<string | null>(null);
  conversationIdRef.current = conversationId;

  // Тихое обновление ленты (без setMessages(null) — без «мигающего» Loading).
  function refreshMessagesSilently() {
    const id = conversationIdRef.current;
    if (!id) return;
    api
      .get<ConversationMessage[]>(`/assistant/conversations/${id}/messages`)
      .then((msgs) => {
        if (conversationIdRef.current !== id) return;
        setMessages((prev) => {
          const last = (list: ConversationMessage[] | null) => list?.[list.length - 1];
          const a = last(prev);
          const b = last(msgs);
          const unchanged = prev && prev.length === msgs.length && a?.id === b?.id && a?.updatedAt === b?.updatedAt;
          return unchanged ? prev : msgs;
        });
      })
      .catch(() => undefined);
  }

  // Фоновые сообщения (итог разбора договора агентом-юристом) — сигнал
  // сервера по личной теме. Во время отправки ленту не трогаем, иначе
  // перезапрос затёр бы ещё не сохранённый ответ; подтягиваем после.
  const sendingRef = useRef(false);
  sendingRef.current = sending;
  const missedRefreshRef = useRef(false);
  useRealtime('assistant', () => {
    if (sendingRef.current) {
      missedRefreshRef.current = true;
      return;
    }
    refreshMessagesSilently();
    onTitlesChanged();
  });
  useEffect(() => {
    if (sending || !missedRefreshRef.current) return;
    missedRefreshRef.current = false;
    refreshMessagesSilently();
    onTitlesChanged();
  }, [sending]);

  function loadMessages(id: string) {
    setMessages(null);
    api
      .get<ConversationMessage[]>(`/assistant/conversations/${id}/messages`)
      .then((msgs) => {
        setMessages(msgs);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить переписку'));
  }

  // Возвращает false, если отправка не началась (пусто, уже идёт ответ, нет
  // разговора) — тогда вызывающий не очищает поле ввода.
  // context — на что смотрит пользователь (панель агента, W2): сервер сам
  // проверит права и добавит сводку только для модели.
  function send(text: string, attachments: UploadedFileInfo[], retryClientRequestId?: string, context?: AgentPageContext): boolean {
    const value = text.trim();
    if (!value || sending || !conversationId) return false;
    void run(conversationId, value, attachments, retryClientRequestId, context);
    return true;
  }

  async function run(
    conversationId: string,
    value: string,
    attachments: UploadedFileInfo[],
    retryClientRequestId?: string,
    context?: AgentPageContext,
  ) {
    const isRetry = Boolean(retryClientRequestId);
    const clientRequestId = retryClientRequestId ?? newClientRequestId();
    const assistantPlaceholderId = `optimistic-assistant-${clientRequestId}`;

    setSending(true);
    setFailedSend(null);

    setMessages((prev) => {
      const base = prev ?? [];
      const withUser = isRetry ? base : [...base, optimisticUserMessage(conversationId, clientRequestId, value, attachments)];
      return [...withUser, optimisticAssistantMessage(conversationId, clientRequestId)];
    });

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
          freshMessageIds.add(event.message.id);
          setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId).concat(event.message));
          onTitlesChanged();
          break;
        case 'message.failed':
          terminal = true;
          setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId));
          setFailedSend({ clientRequestId, text: value, attachments, context });
          break;
        case 'message.started':
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
        { text: value, clientRequestId, attachmentIds: attachments.map((a) => a.fileId), context },
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

      if (!terminal) {
        setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId));
        setFailedSend({ clientRequestId, text: value, attachments, context });
      }
    } catch (err) {
      // Остановлено самим пользователем (кнопка «Остановить ответ») — не
      // сбой: оставляем накопленный к этому моменту текст как обычный
      // завершённый ответ, без «Ответ был прерван» / «Повторить».
      if (userStoppedRef.current) {
        terminal = true;
        setMessages((prev) =>
          (prev ?? []).map((m) =>
            m.id === assistantPlaceholderId ? { ...m, status: 'completed', parts: buildLiveParts(toolStates, liveText) } : m,
          ),
        );
      } else if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId));
        setFailedSend({ clientRequestId, text: value, attachments, context });
      }
    } finally {
      sendAbortRef.current = null;
      setSending(false);
    }
  }

  function retry() {
    if (failedSend) send(failedSend.text, failedSend.attachments, failedSend.clientRequestId, failedSend.context);
  }

  function stop() {
    userStoppedRef.current = true;
    sendAbortRef.current?.abort();
  }

  return {
    messages,
    setMessages,
    loadError,
    loadMessages,
    refreshMessagesSilently,
    sending,
    send,
    stop,
    failedSend,
    clearFailed: () => setFailedSend(null),
    retry,
    freshMessageIds,
  };
}

export type AssistantStream = ReturnType<typeof useAssistantStream>;
