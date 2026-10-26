'use client';

import { useEffect, useRef } from 'react';
import { Protected } from '@/components/protected';
import { useAssistantSession } from '@/components/assistant/use-assistant-session';
import { MessageList } from '@/components/assistant/message-list';
import { Composer } from '@/components/assistant/composer';
import { ConversationList } from '@/components/assistant/conversation-list';

// Stage 2, Phase M (Web Assistant parity, 22.09.2026) — desktop-порт
// apps/miniapp/src/components/assistant-screen.tsx. Тот же backend-
// контракт (GET/POST /assistant/conversations[...], SSE .../stream),
// та же транспортная логика (стрим/optimistic-сообщения/retry/вложения/
// голос), но с двумя desktop-специфичными отличиями:
// 1. Список разговоров слева — Mini App всегда берёт conversations[0]
//    (один непрерывный тред на сотрудника), backend уже поддерживает
//    несколько Conversation — здесь это используется по полной (раздел
//    40 спеки Phase M, desktop может позволить себе более богатый UI).
// 2. Никакой Telegram-хаптики/SwipeShell — обычный React-компонент,
//    история грузится на монтирование и при смене conversationId.
// Части — в components/assistant/* (редизайн W0), их же переиспользует
// панель агента (W2): эта страница — её полноэкранный режим.

export default function AssistantPage() {
  return (
    <Protected>
      <AssistantView />
    </Protected>
  );
}

function AssistantView() {
  const session = useAssistantSession();
  const { convs, conversationId, stream } = session;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Первая загрузка страницы — выбирает и грузит переписку выбранного/
  // первого разговора.
  useEffect(() => {
    void convs.load().then((list) => {
      if (!list) return;
      // ?q=<текст> — строка «Спросить агента» на пульте: новый разговор с
      // подставленным текстом, отправляет сам человек (Enter).
      const params = new URLSearchParams(window.location.search);
      const question = params.get('q')?.trim();
      if (question) {
        window.history.replaceState(null, '', '/assistant');
        void session.createConversation().then(() => {
          session.setText(question);
          textareaRef.current?.focus();
        });
        return;
      }
      // ?c=<id> — ссылка «открыть ответ» навыка (запуск ▶ создаёт разговор)
      // и «развернуть» из панели агента.
      const wanted = params.get('c');
      const targetId = (wanted && list.some((c) => c.id === wanted) ? wanted : list[0]?.id) ?? null;
      if (targetId) {
        session.setConversationId(targetId);
        stream.loadMessages(targetId);
      } else {
        stream.setMessages([]);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="assistant-layout">
      <ConversationList
        conversations={convs.conversations}
        error={convs.error}
        activeId={conversationId}
        onSelect={session.selectConversation}
        onCreate={() => void session.createConversation()}
        onRename={(id, title) => void convs.rename(id, title)}
      />

      <div className="assistant-chat-pane">
        <MessageList
          conversationId={conversationId}
          messages={stream.messages}
          loadError={stream.loadError}
          freshMessageIds={stream.freshMessageIds}
          failedSend={stream.failedSend}
          onRetry={stream.retry}
          voiceUndos={session.voice.undos}
          onVoiceUndo={(entry) => void session.voice.undo(entry)}
          onSkillRated={(messageId, run) => stream.setMessages((prev) => prev?.map((x) => (x.id === messageId ? { ...x, skillRun: run } : x)) ?? prev)}
          onSuggestion={session.setText}
          voicePending={session.voice.phase === 'processing' ? session.voice.liveTranscript : null}
        />
        <Composer
          text={session.text}
          onTextChange={session.setText}
          textareaRef={textareaRef}
          hasConversation={!!conversationId}
          sending={stream.sending}
          onSend={() => session.send()}
          onStop={stream.stop}
          attachments={session.attachments}
          voice={session.voice}
          live={session.live}
          skillOptions={session.skillOptions}
        />
      </div>
    </div>
  );
}
