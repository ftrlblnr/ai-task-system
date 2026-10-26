'use client';

import { useEffect, useRef, useState } from 'react';
import { isManagerRole } from '@ai-task-system/shared-types';
import { Protected } from '@/components/protected';
import { useSkillOptions } from '@/components/skill-chat';
import { useAuth } from '@/lib/auth-context';
import { useAssistantStream } from '@/components/assistant/use-assistant-stream';
import { useLiveVoice, useVoiceRecorder } from '@/components/assistant/voice-controls';
import { useAttachments } from '@/components/assistant/attachments';
import { MessageList } from '@/components/assistant/message-list';
import { Composer } from '@/components/assistant/composer';
import { ConversationList, useConversations } from '@/components/assistant/conversation-list';

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
// панель агента.

export default function AssistantPage() {
  return (
    <Protected>
      <AssistantView />
    </Protected>
  );
}

function AssistantView() {
  const convs = useConversations();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const stream = useAssistantStream({ conversationId, onTitlesChanged: convs.refreshTitles });
  const attachments = useAttachments();
  const voice = useVoiceRecorder({
    conversationId,
    onMessages: (userMessage, assistantMessage) => stream.setMessages((prev) => [...(prev ?? []), userMessage, assistantMessage]),
    onConversationCreated: setConversationId,
    onUndone: () => {
      if (conversationId) stream.loadMessages(conversationId);
    },
  });
  const live = useLiveVoice({ getConversationId: () => conversationId, refresh: stream.refreshMessagesSilently });

  const { user } = useAuth();
  const skillOptions = useSkillOptions(!!user && isManagerRole(user.role));

  async function createConversation() {
    const created = await convs.create();
    if (!created) return;
    setConversationId(created.id);
    stream.setMessages([]);
  }

  function selectConversation(id: string) {
    if (id === conversationId) return;
    setConversationId(id);
    stream.clearFailed();
    stream.loadMessages(id);
  }

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
        void createConversation().then(() => {
          setText(question);
          textareaRef.current?.focus();
        });
        return;
      }
      // ?c=<id> — ссылка «открыть ответ» навыка (запуск ▶ создаёт разговор).
      const wanted = params.get('c');
      const targetId = (wanted && list.some((c) => c.id === wanted) ? wanted : list[0]?.id) ?? null;
      if (targetId) {
        setConversationId(targetId);
        stream.loadMessages(targetId);
      } else {
        stream.setMessages([]);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function send() {
    if (stream.send(text, attachments.pending)) {
      setText('');
      attachments.clear();
    }
  }

  return (
    <div className="assistant-layout">
      <ConversationList
        conversations={convs.conversations}
        error={convs.error}
        activeId={conversationId}
        onSelect={selectConversation}
        onCreate={() => void createConversation()}
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
          voiceUndos={voice.undos}
          onVoiceUndo={(entry) => void voice.undo(entry)}
          onSkillRated={(messageId, run) => stream.setMessages((prev) => prev?.map((x) => (x.id === messageId ? { ...x, skillRun: run } : x)) ?? prev)}
          onSuggestion={setText}
        />
        <Composer
          text={text}
          onTextChange={setText}
          textareaRef={textareaRef}
          hasConversation={!!conversationId}
          sending={stream.sending}
          onSend={send}
          onStop={stream.stop}
          attachments={attachments}
          voice={voice}
          live={live}
          skillOptions={skillOptions}
        />
      </div>
    </div>
  );
}
