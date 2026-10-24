'use client';

import type { FormEvent, KeyboardEvent } from 'react';
import { Headphones, Mic, Send, Square } from 'lucide-react';
import { QUICK_PROMPTS } from '@/lib/labels';
import { LiveVoiceBar, cx } from '@/components/ui';
import { AttachButton, PendingAttachmentsRow, type PendingAttachments } from './attachments';
import { formatElapsed, type useLiveVoice, type useVoiceRecorder } from './voice-controls';

// Поле ввода ассистента (редизайн M5, MINIAPP_REDESIGN.md §4.6): над ним —
// чипы-подсказки (те же, что на «Сегодня») и «Живой голос»; поле 44px и
// одна круглая кнопка на акценте: пустое поле — микрофон, есть текст —
// «отправить», идёт ответ или запись — «стоп». Логика записи, вложений и
// отправки — прежняя (voice-controls, attachments, use-assistant-stream).

const MAX_TEXTAREA_HEIGHT = 140;
// Зеркало бэкенд-лимита SendMessageDto.text (@MaxLength(4000)) в
// apps/api/src/assistant/dto/send-message.dto.ts (аудит 16.09.2026).
export const MAX_TEXT_LENGTH = 4000;

export function Composer({
  text,
  onTextChange,
  onSend,
  onPrompt,
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
  // Чип-подсказка — сразу отправляется, как быстрые вопросы на «Сегодня».
  onPrompt: (text: string) => void;
  sending: boolean;
  onStop: () => void;
  conversationReady: boolean;
  attachments: PendingAttachments;
  voice: ReturnType<typeof useVoiceRecorder>;
  live: ReturnType<typeof useLiveVoice>;
}) {
  const composerDisabled = live.active || voice.phase !== 'idle';
  const hasText = text.trim().length > 0;
  // Подсказки мешают, только когда человек уже пишет или говорит.
  const showPrompts = !hasText && voice.phase === 'idle' && !live.active;

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

  // Одна кнопка справа — что она делает, зависит от состояния.
  const action = sending
    ? { icon: Square, label: 'Остановить ответ', run: onStop, disabled: false }
    : voice.phase === 'recording'
      ? { icon: Square, label: 'Остановить запись', run: voice.stop, disabled: false }
      : hasText
        ? { icon: Send, label: 'Отправить', run: onSend, disabled: composerDisabled }
        : { icon: Mic, label: 'Надиктовать', run: () => void voice.start(), disabled: attachments.uploading || composerDisabled };

  return (
    <div className={cx('asst-composer', sending && 'is-busy')}>
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
      {showPrompts && (
        <div className="filter-chips asst-prompts" aria-label="Подсказки">
          {live.enabled && (
            <button
              type="button"
              className="filter-chip asst-live-chip"
              disabled={sending || attachments.uploading || !conversationReady}
              onClick={live.start}
            >
              <Headphones size={16} strokeWidth={2} />
              Живой голос
            </button>
          )}
          {QUICK_PROMPTS.map((p) => (
            <button key={p} type="button" className="filter-chip" disabled={sending || !conversationReady} onClick={() => onPrompt(p)}>
              {p}
            </button>
          ))}
        </div>
      )}
      <div className="asst-input-row">
        <AttachButton attachments={attachments} disabled={sending || composerDisabled} />
        <div className={cx('asst-field', voice.phase !== 'idle' && 'is-voice')}>
          {voice.phase !== 'idle' && (
            <>
              <p className={cx('live-transcript', !voice.liveTranscript && 'is-empty')} aria-live="polite">
                {voice.liveTranscript || (voice.phase === 'recording' ? 'Говорите…' : 'Распознаю…')}
              </p>
              {voice.phase === 'recording' && <span className="asst-timer">{formatElapsed(voice.elapsedSec)}</span>}
            </>
          )}
          <textarea
            rows={1}
            hidden={voice.phase !== 'idle'}
            placeholder="Задача, вопрос или поручение…"
            aria-label="Сообщение ассистенту"
            value={text}
            disabled={sending || composerDisabled}
            maxLength={MAX_TEXT_LENGTH}
            onChange={(e) => onTextChange(e.target.value)}
            onInput={onInput}
            onKeyDown={onKeyDown}
          />
        </div>
        <button
          type="button"
          className={cx('asst-action', (sending || voice.phase === 'recording') && 'is-stop')}
          aria-label={action.label}
          title={action.label}
          disabled={action.disabled}
          onClick={action.run}
        >
          <action.icon size={20} strokeWidth={2.25} />
        </button>
      </div>
      {text.length > MAX_TEXT_LENGTH - 200 && (
        <span className={cx('ds-composer-count', 'asst-count', text.length > MAX_TEXT_LENGTH && 'is-over')}>
          {text.length}/{MAX_TEXT_LENGTH}
        </span>
      )}
    </div>
  );
}
