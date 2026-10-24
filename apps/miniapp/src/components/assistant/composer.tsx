'use client';

import type { FormEvent, KeyboardEvent } from 'react';
import { Headphones, Mic, Send, Square } from 'lucide-react';
import { IconButton, LiveVoiceBar, cx } from '@/components/ui';
import { AttachButton, PendingAttachmentsRow, type PendingAttachments } from './attachments';
import { formatElapsed, type useLiveVoice, type useVoiceRecorder } from './voice-controls';

// Поле ввода ассистента: текст, вложения, запись голоса, живой голос и
// отправка/остановка ответа. Вынесено из assistant-screen.tsx (редизайн M5,
// §4.6) без изменения поведения.

const MAX_TEXTAREA_HEIGHT = 140;
// Зеркало бэкенд-лимита SendMessageDto.text (@MaxLength(4000)) в
// apps/api/src/assistant/dto/send-message.dto.ts (аудит 16.09.2026).
export const MAX_TEXT_LENGTH = 4000;

export function Composer({
  text,
  onTextChange,
  onSend,
  sending,
  onStop,
  conversationReady,
  attachments,
  voice,
  live,
}: {
  text: string;
  onTextChange: (text: string) => void;
  onSend: () => void;
  sending: boolean;
  onStop: () => void;
  conversationReady: boolean;
  attachments: PendingAttachments;
  voice: ReturnType<typeof useVoiceRecorder>;
  live: ReturnType<typeof useLiveVoice>;
}) {
  const composerDisabled = live.active || voice.phase !== 'idle';

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  function onInput(e: FormEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }

  return (
    <div className={cx('ds-composer', sending && 'is-busy')}>
      {live.active && (
        <LiveVoiceBar
          status={live.phase === 'connecting' ? 'Подключаюсь…' : live.phase === 'closing' ? 'Завершаю…' : 'Идёт разговор'}
          caption={live.caption ? `${live.caption.who === 'user' ? 'Вы' : 'Ассистент'}: ${live.caption.text}` : ''}
          amp={null}
          onStop={live.stop}
          stopDisabled={live.phase === 'closing'}
        />
      )}
      <PendingAttachmentsRow attachments={attachments} />
      {voice.phase !== 'idle' && (
        <p className={cx('live-transcript', !voice.liveTranscript && 'is-empty')} aria-live="polite">
          {voice.liveTranscript || (voice.phase === 'recording' ? 'Говорите…' : 'Распознаю…')}
        </p>
      )}
      <textarea
        rows={1}
        hidden={voice.phase !== 'idle'}
        placeholder="Напишите задачу, вопрос или поручение…"
        aria-label="Сообщение ассистенту"
        value={text}
        disabled={sending || composerDisabled}
        maxLength={MAX_TEXT_LENGTH}
        onChange={(e) => onTextChange(e.target.value)}
        onInput={onInput}
        onKeyDown={onKeyDown}
      />
      <div className="ds-composer-row">
        <AttachButton attachments={attachments} disabled={sending || composerDisabled} />
        {voice.phase === 'recording' ? (
          <IconButton icon={Square} label="Остановить запись" size="sm" onClick={voice.stop} />
        ) : (
          <IconButton
            icon={Mic}
            label="Надиктовать"
            size="sm"
            disabled={sending || attachments.uploading || composerDisabled}
            onClick={voice.start}
          />
        )}
        {live.enabled && voice.phase === 'idle' && (
          <IconButton
            icon={Headphones}
            label="Живой голос"
            size="sm"
            disabled={sending || attachments.uploading || live.active || !conversationReady}
            onClick={live.start}
          />
        )}
        <span className="ds-spacer" />
        {voice.phase === 'recording' && (
          <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>
            {formatElapsed(voice.elapsedSec)}
          </span>
        )}
        {text.length > MAX_TEXT_LENGTH - 200 && (
          <span className={cx('ds-composer-count', text.length > MAX_TEXT_LENGTH && 'is-over')}>
            {text.length}/{MAX_TEXT_LENGTH}
          </span>
        )}
        {sending ? (
          <IconButton icon={Square} label="Остановить ответ" variant="outline" size="sm" onClick={onStop} />
        ) : (
          <IconButton icon={Send} label="Отправить" variant="primary" size="sm" disabled={!text.trim() || composerDisabled} onClick={onSend} />
        )}
      </div>
    </div>
  );
}
