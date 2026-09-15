'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import type { ConversationMessage, ConversationSummary } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { MessagePartRenderer } from './assistant-message-part';

const MAX_TEXTAREA_HEIGHT = 140;

function newClientRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function optimisticUserMessage(conversationId: string, clientRequestId: string, text: string): ConversationMessage {
  return {
    id: `optimistic-user-${clientRequestId}`,
    conversationId,
    role: 'user',
    status: 'completed',
    clientRequestId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    parts: [{ id: 'optimistic', type: 'markdown', order: 0, data: { content: text } }],
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

function userBubbleText(m: ConversationMessage): string {
  const part = m.parts[0]?.data as { content?: string } | undefined;
  return part?.content ?? '';
}

// Текстовый AI-чат поверх /assistant/* (Stage 2, Phase D) — отдельная
// вкладка от «Голос» (владелец 15.09.2026: голос трогать не обязательно в
// этой фазе, объединение — Phase H). История — с сервера (Phase B), не
// localStorage: refresh/другое устройство видят ту же переписку (спека §27).
export function AssistantScreen({ active = true }: { active?: boolean }) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Сетевой сбой самой отправки (обрыв/таймаут — не серверная ошибка,
  // которая уже пришла бы как обычный FAILED assistant-message с ErrorPart)
  // — спека §28: сообщение пользователя не удаляется, кнопка «Повторить»
  // шлёт тот же clientRequestId, идемпотентность (Phase B) не даёт дубля.
  const [failedSend, setFailedSend] = useState<{ clientRequestId: string; text: string } | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const conversations = await api.get<ConversationSummary[]>('/assistant/conversations');
      const id = conversations[0]?.id;
      if (!id) return;
      setConversationId(id);
      const history = await api.get<ConversationMessage[]>(`/assistant/conversations/${id}/messages`);
      setMessages(history);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить переписку');
    }
  }

  // active приходит от SwipeShell (тот же приём, что tasks-screen.tsx) —
  // экран смонтирован всегда (см. swipe-shell.tsx), но историю грузим при
  // каждом возвращении на вкладку, не один раз за сессию: это же покрывает
  // "второе устройство"/восстановление после долгого отсутствия (спека
  // Stage 2 §27) без отдельного механизма.
  useEffect(() => {
    if (active) load();
  }, [active]);

  useEffect(() => {
    // chat.scrollTo(), не scrollIntoView() — SwipeShell держит все экраны
    // смонтированными одновременно (см. комментарий в swipe-shell.tsx про
    // баг 08.09.2026: scrollIntoView() внутри неактивного экрана ломало
    // позиционирование свайп-трека через паразитный scrollLeft предка).
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function send(overrideText?: string, overrideClientRequestId?: string) {
    const isRetry = Boolean(overrideClientRequestId);
    const value = (overrideText ?? text).trim();
    if (!value || sending || !conversationId) return;

    const clientRequestId = overrideClientRequestId ?? newClientRequestId();
    const assistantPlaceholderId = `optimistic-assistant-${clientRequestId}`;

    setSending(true);
    setFailedSend(null);
    if (!isRetry) setText('');

    setMessages((prev) => {
      const base = prev ?? [];
      const withUser = isRetry ? base : [...base, optimisticUserMessage(conversationId, clientRequestId, value)];
      return [...withUser, optimisticAssistantMessage(conversationId, clientRequestId)];
    });

    try {
      const result = await api.post<{ userMessage: ConversationMessage; assistantMessage: ConversationMessage }>(
        `/assistant/conversations/${conversationId}/messages`,
        { text: value, clientRequestId },
      );
      setMessages((prev) =>
        (prev ?? [])
          .filter((m) => m.id !== `optimistic-user-${clientRequestId}` && m.id !== assistantPlaceholderId)
          .concat(result.userMessage, result.assistantMessage),
      );
    } catch {
      setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId));
      setFailedSend({ clientRequestId, text: value });
    } finally {
      setSending(false);
    }
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  function onTextareaInput(e: FormEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }

  if (!messages) {
    return (
      <div className="assistant-screen">
        {loadError ? <p className="error">{loadError}</p> : <p className="hint">Загрузка…</p>}
      </div>
    );
  }

  return (
    <div className="assistant-screen">
      <div className="assistant-chat" ref={chatRef}>
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="assistant-user-bubble">
              {userBubbleText(m)}
            </div>
          ) : (
            <div key={m.id} className="assistant-response">
              {m.status === 'pending' ? (
                <p className="assistant-pending">Печатает…</p>
              ) : (
                m.parts.map((part) => <MessagePartRenderer key={part.id} part={part} />)
              )}
            </div>
          ),
        )}
        {failedSend && (
          <div className="assistant-error">
            Ответ был прерван.
            <button type="button" className="assistant-card-open" onClick={() => send(failedSend.text, failedSend.clientRequestId)}>
              Повторить
            </button>
          </div>
        )}
      </div>
      <div className="assistant-composer">
        <textarea
          rows={1}
          placeholder="Спросите что-нибудь…"
          value={text}
          disabled={sending}
          onChange={(e) => setText(e.target.value)}
          onInput={onTextareaInput}
          onKeyDown={onComposerKeyDown}
        />
        <button type="button" className="assistant-send-btn" disabled={sending || !text.trim()} onClick={() => send()}>
          <Send size={18} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}
