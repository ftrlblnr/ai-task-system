'use client';

import { useEffect, useRef, useState } from 'react';
import { isManagerRole } from '@ai-task-system/shared-types';
import { useAuth } from '@/lib/auth-context';
import { prefetchLiveTranscription } from '@/lib/live-transcription';
import { useAssistantRequest } from './app-shell';
import { Alert, ScreenHeader } from '@/components/ui';
import { usePendingAttachments } from './assistant/attachments';
import { Composer } from './assistant/composer';
import { MessageList } from './assistant/message-list';
import { useAssistantStream } from './assistant/use-assistant-stream';
import { useLiveVoice, useVoiceRecorder } from './assistant/voice-controls';
import { MemoryOverlay, memoryCountLabel, useMemoryCount } from './assistant/memory-overlay';

// Текстовый AI-чат поверх /assistant/* (Stage 2, Phase D — базовый чат;
// Phase E — streaming; Phase F/F.2 — вложения; Phase H — голос объединён в
// этот же экран, одна лента для обоих: раньше «Голос» была отдельной
// вкладкой со своей историей в localStorage, POST /voice/parse теперь пишет
// в ту же Conversation/Message, что и текст, см. voice.service.ts).
// Редизайн M5 (MINIAPP_REDESIGN.md §4.6): экран только собирает части из
// assistant/ — стрим, лента, поле ввода, голос, вложения.
export function AssistantScreen({ active = true }: { active?: boolean }) {
  const stream = useAssistantStream();
  const [assistantRequest, consumeAssistantRequest] = useAssistantRequest();
  const [text, setText] = useState('');
  const attachments = usePendingAttachments();
  const voice = useVoiceRecorder({ conversationId: stream.conversationId, onMessages: stream.appendMessages, onUndone: stream.load });
  const live = useLiveVoice({ conversationIdRef: stream.conversationIdRef, refresh: stream.refreshMessagesSilently });
  // Память (ARMS, фаза 1) — руководству: число пунктов в надзаголовке, тап
  // открывает список. После каждого ответа пересчитываем: «запомни…» мог
  // добавить пункт.
  const { user } = useAuth();
  const memoryEnabled = !!user && isManagerRole(user.role);
  const [memoryCount, refreshMemoryCount] = useMemoryCount(memoryEnabled, active);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const wasSending = useRef(false);
  useEffect(() => {
    if (wasSending.current && !stream.sending) refreshMemoryCount();
    wasSending.current = stream.sending;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshMemoryCount пересоздаётся каждый рендер
  }, [stream.sending]);

  function send(overrideText?: string) {
    void stream.send(overrideText ?? text, attachments.pending, undefined, () => {
      setText('');
      attachments.clear();
    });
  }

  // active приходит от AppShell (тот же приём, что tasks-screen.tsx) —
  // экран остаётся смонтированным (см. app-shell.tsx), но историю грузим при
  // каждом возвращении на вкладку, не один раз за сессию: это же покрывает
  // "второе устройство"/восстановление после долгого отсутствия (спека
  // Stage 2 §27) без отдельного механизма.
  useEffect(() => {
    if (!active) return;
    stream.load();
    prefetchLiveTranscription();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load пересоздаётся каждый рендер, перезапуск только по active
  }, [active]);

  // Текст из другого раздела («Подготовиться», «Ответить», быстрые вопросы
  // на «Сегодня») — отправляем как обычное сообщение пользователя.
  useEffect(() => {
    if (!assistantRequest || stream.sending || !stream.conversationId || stream.historyLoadedAt < assistantRequest.at) return;
    consumeAssistantRequest();
    send(assistantRequest.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send пересоздаётся каждый рендер
  }, [assistantRequest, stream.historyLoadedAt, stream.sending, stream.conversationId]);

  const kicker =
    memoryEnabled && memoryCount !== null ? (
      <button type="button" className="kicker-link" onClick={() => setMemoryOpen(true)}>
        {memoryCountLabel(memoryCount)}
      </button>
    ) : (
      'Ассистент Адъютанта'
    );
  const header = (
    <>
      <ScreenHeader kicker={kicker} title="Ассистент" />
      {memoryOpen && (
        <MemoryOverlay
          onClose={() => {
            setMemoryOpen(false);
            refreshMemoryCount();
          }}
        />
      )}
    </>
  );

  if (!stream.messages) {
    return (
      <div className="assistant-screen">
        {header}
        {stream.loadError ? <Alert tone="danger">{stream.loadError}</Alert> : <p className="ds-field-hint">Загрузка…</p>}
      </div>
    );
  }

  const failed = stream.failedSend;
  return (
    <div className="assistant-screen">
      {header}
      <MessageList
        messages={stream.messages}
        freshMessageIds={stream.freshMessageIds}
        voiceUndos={voice.undos}
        onUndo={(entry) => void voice.undo(entry)}
        failed={failed !== null}
        onRetry={() => failed && void stream.send(failed.text, failed.attachments, failed.clientRequestId)}
      />

      {voice.error && <Alert tone="danger">{voice.error}</Alert>}
      {live.error && <Alert tone="danger">{live.error}</Alert>}

      <Composer
        text={text}
        onTextChange={setText}
        onSend={() => send()}
        onPrompt={send}
        sending={stream.sending}
        onStop={stream.stopSending}
        conversationReady={!!stream.conversationId}
        attachments={attachments}
        voice={voice}
        live={live}
      />
    </div>
  );
}
