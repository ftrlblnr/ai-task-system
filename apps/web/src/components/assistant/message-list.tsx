'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ConversationMessage, FilePartData, SkillRunRef } from '@ai-task-system/shared-types';
import { MessagePartsList, FilePartView } from '@/components/assistant-message-part';
import { SkillRating } from '@/components/skill-chat';
import { Alert, Button, UserMessage, AgentMessage } from '@/components/ui';
import type { FailedSend } from './use-assistant-stream';
import type { VoiceUndoEntry } from './voice-controls';

// Лента переписки с ассистентом: пустое состояние с подсказками, сообщения,
// «Повторить», кнопка «↓ Новые сообщения». Вынесено из
// app/assistant/page.tsx (W0) без изменения поведения.

// Дизайн-система «Адъютант» (владелец 04.10.2026, implementation.md шаг 7)
// — пустой чат: приглашение + 3-4 подсказки-чипа с типовыми поручениями
// (project/README.md: примеры, не настоящие данные). Клик — подставляет
// текст в композер, не отправляет сам: пользователь может его поправить.
const SUGGESTION_PROMPTS = [
  'Поставь задачу Ивану на завтра',
  'Что по задачам на этой неделе?',
  'Какие встречи у меня сегодня?',
  'Кто сейчас перегружен задачами?',
];
const NEAR_BOTTOM_THRESHOLD_PX = 80;

function userBubbleText(m: ConversationMessage): string {
  const part = m.parts[0]?.data as { content?: string } | undefined;
  return part?.content ?? '';
}

interface Props {
  conversationId: string | null;
  messages: ConversationMessage[] | null;
  loadError: string | null;
  freshMessageIds: Set<string>;
  failedSend: FailedSend | null;
  onRetry: () => void;
  voiceUndos: VoiceUndoEntry[];
  onVoiceUndo: (entry: VoiceUndoEntry) => void;
  onSkillRated: (messageId: string, run: SkillRunRef) => void;
  onSuggestion: (text: string) => void;
  // Своё пустое состояние вместо «Чем помочь?» (узкая панель агента).
  emptyState?: ReactNode;
}

export function MessageList({
  conversationId,
  messages,
  loadError,
  freshMessageIds,
  failedSend,
  onRetry,
  voiceUndos,
  onVoiceUndo,
  onSkillRated,
  onSuggestion,
  emptyState,
}: Props) {
  const chatRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
      isNearBottomRef.current = nearBottom;
      setShowJumpButton((prev) => (prev === !nearBottom ? prev : !nearBottom));
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [conversationId]);

  useEffect(() => {
    if (!isNearBottomRef.current) return;
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  function scrollToBottom() {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
    isNearBottomRef.current = true;
    setShowJumpButton(false);
  }

  return (
    <div className="ds-thread" ref={chatRef}>
      {!messages ? (
        <p className="ds-field-hint">Загрузка…</p>
      ) : (
        <>
          {messages.length === 0 && emptyState}
          {messages.length === 0 && !emptyState && (
            <div style={{ textAlign: 'center', padding: '48px 16px' }}>
              {/* "display" — типографика только для этого места и экрана
                  входа (project/README.md); отдельного CSS-класса под
                  неё нет нигде в ds.css (значения баковые per-компонент,
                  не utility-классы), поэтому здесь — инлайн по tokens.json. */}
              <p style={{ margin: '0 0 8px', fontSize: 32, lineHeight: '38px', fontWeight: 650, letterSpacing: '-0.025em' }}>
                Чем помочь?
              </p>
              <p className="ds-field-hint" style={{ margin: '0 0 16px' }}>
                Спросите что-нибудь текстом или надиктуйте задачу/встречу голосом.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                {SUGGESTION_PROMPTS.map((p) => (
                  <button key={p} type="button" className="ds-chip" onClick={() => onSuggestion(p)}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => {
            if (m.role === 'user') {
              return (
                <UserMessage
                  key={m.id}
                  attachments={m.parts.filter((p) => p.type === 'file').map((p) => <FilePartView key={p.id} data={p.data as FilePartData} />)}
                >
                  {userBubbleText(m)}
                </UserMessage>
              );
            }
            const fresh = freshMessageIds.has(m.id);
            const lastPart = m.parts[m.parts.length - 1];
            const streamingPartId = m.status === 'streaming' && lastPart?.type === 'markdown' ? lastPart.id : null;
            return (
              <AgentMessage key={m.id} state={m.status === 'completed' ? 'done' : m.status === 'failed' ? 'error' : m.status} actions={false}>
                {m.status === 'pending' ? null : <MessagePartsList parts={m.parts} fresh={fresh} streamingPartId={streamingPartId} />}
                {m.skillRun && m.status === 'completed' && <SkillRating run={m.skillRun} onRated={(run) => onSkillRated(m.id, run)} />}
                {m.parts.map((part) => {
                  const undo = voiceUndos.find((u) => u.messageId === m.id && u.partId === part.id);
                  if (!undo) return null;
                  return (
                    <div key={`undo-${part.id}`} className="voice-confirm-actions">
                      <Button size="sm" variant="ghost" onClick={() => onVoiceUndo(undo)}>
                        Отменить
                      </Button>
                    </div>
                  );
                })}
              </AgentMessage>
            );
          })}
          {loadError && <Alert tone="danger">{loadError}</Alert>}
        </>
      )}
      {failedSend && (
        <Alert
          tone="danger"
          action={
            <Button size="sm" onClick={onRetry}>
              Повторить
            </Button>
          }
        >
          Ответ был прерван.
        </Alert>
      )}
      {showJumpButton && (
        <button type="button" className="assistant-scroll-down" onClick={scrollToBottom}>
          ↓ Новые сообщения
        </button>
      )}
    </div>
  );
}
