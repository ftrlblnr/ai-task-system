'use client';

import { useEffect, useRef, useState } from 'react';
import type { ConversationMessage, FilePartData } from '@ai-task-system/shared-types';
import { Alert, AgentMessage, Button, UserMessage } from '@/components/ui';
import { FilePartView, MessagePartsList } from '../assistant-message-part';
import type { VoiceUndoEntry } from './voice-controls';

// Лента переписки с ассистентом: пустое приглашение, сообщения, «Повторить»
// и кнопка «↓ Новые сообщения». Вынесено из assistant-screen.tsx (редизайн
// M5, §4.6) без изменения поведения.

// Дизайн-система «Адъютант» (владелец 04.10.2026, implementation.md шаг 7)
// — пустой чат: приглашение + подсказки-чипы с типовыми поручениями
// (примеры, не настоящие данные). Клик — подставляет текст в композер.
const SUGGESTION_PROMPTS = [
  'Поставь задачу Ивану на завтра',
  'Что по задачам на этой неделе?',
  'Какие встречи у меня сегодня?',
];

// Порог "у низа" — тот же порядок величины, что визуально ощущается как
// "почти внизу", не точный 0 (иначе любой суб-пиксельный скролл во время
// стрима считался бы "ушёл вверх").
const NEAR_BOTTOM_THRESHOLD_PX = 80;

function userBubbleText(m: ConversationMessage): string {
  const part = m.parts[0]?.data as { content?: string } | undefined;
  return part?.content ?? '';
}

export function MessageList({
  messages,
  freshMessageIds,
  voiceUndos,
  onUndo,
  failed,
  onRetry,
  onSuggestion,
}: {
  messages: ConversationMessage[];
  freshMessageIds: Set<string>;
  voiceUndos: VoiceUndoEntry[];
  onUndo: (entry: VoiceUndoEntry) => void;
  failed: boolean;
  onRetry: () => void;
  onSuggestion: (text: string) => void;
}) {
  const chatRef = useRef<HTMLDivElement>(null);
  // P1.5 (аудит 16.09.2026, находка про автоскролл во время стрима) — в
  // ref, не state: значение читается только внутри эффекта на [messages],
  // пересчитывать его на каждый пиксель скролла в state означало бы
  // ре-рендер экрана на каждое scroll-событие. showJumpButton — отдельный,
  // редко меняющийся state только для того, чтобы показать/скрыть кнопку ↓
  // (меняется только при пересечении порога, не на каждый пиксель).
  const isNearBottomRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

  // P1.5 (аудит 16.09.2026) — слушатель скролла живёт всё время монтирования
  // ленты (не только во время стрима): пользователь может пролистать
  // историю вверх и вне стрима, кнопка ↓ должна появляться и в этом случае.
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
  }, []);

  useEffect(() => {
    // chat.scrollTo(), не scrollIntoView() — scrollIntoView() прокручивает и
    // всех предков (баг 08.09.2026 со свайп-треком); в AppShell это сдвинуло
    // бы .app-screen вместе с лентой.
    // isNearBottomRef — не дёргаем вниз, если пользователь специально
    // пролистал историю вверх во время долгого стрима (та же находка
    // аудита, что и кнопка ↓ ниже).
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
      {messages.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 16px' }}>
          {/* "display" — типографика только для экрана входа и этого места
              (project/README.md); utility-класса под неё нет в ds.css
              (значения баковые per-компонент), поэтому здесь — инлайн. */}
          <p style={{ margin: '0 0 8px', fontSize: 32, lineHeight: '38px', fontWeight: 650, letterSpacing: '-0.025em' }}>
            Чем помочь?
          </p>
          <p className="ds-field-hint" style={{ margin: '0 0 16px' }}>
            Спросите текстом или надиктуйте задачу/встречу голосом.
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
            {m.parts.map((part) => {
              const undo = voiceUndos.find((u) => u.messageId === m.id && u.partId === part.id);
              if (!undo) return null;
              // Голос (Stage 2, Phase H) — "Отменить" рядом с картой/
              // текстом только что выполненного действия, временно
              // (VOICE_UNDO_WINDOW_MS), не персистентно.
              return (
                <div key={`undo-${part.id}`} className="voice-confirm-actions">
                  <Button size="sm" variant="ghost" onClick={() => onUndo(undo)}>
                    Отменить
                  </Button>
                </div>
              );
            })}
          </AgentMessage>
        );
      })}
      {failed && (
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
