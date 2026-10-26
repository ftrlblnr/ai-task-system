'use client';

import { useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { Headphones, Mic, Paperclip, Send, Square } from 'lucide-react';
import { matchSkills, SkillSuggest, type SkillOption } from '@/components/skill-chat';
import { Alert, IconButton, FileChip, LiveVoiceBar, cx } from '@/components/ui';
import { ACCEPTED_UPLOAD_MIME_TYPES, MAX_ATTACHMENTS, type Attachments } from './attachments';
import type { LiveVoice, VoiceRecorder } from './voice-controls';

// Поле ввода ассистента: текст с подсказками навыков по «/», вложения,
// запись голоса, живой разговор, отправка/остановка ответа. Вынесено из
// app/assistant/page.tsx (W0) без изменения поведения.

const MAX_TEXTAREA_HEIGHT = 160;
// Зеркало SendMessageDto (apps/api/src/assistant/dto/send-message.dto.ts).
const MAX_TEXT_LENGTH = 4000;

interface Props {
  text: string;
  onTextChange: (text: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  // Открыт ли разговор — без него поле недоступно.
  hasConversation: boolean;
  sending: boolean;
  onSend: () => void;
  onStop: () => void;
  attachments: Attachments;
  voice: VoiceRecorder;
  live: LiveVoice;
  skillOptions: SkillOption[];
}

export function Composer({ text, onTextChange, textareaRef, hasConversation, sending, onSend, onStop, attachments, voice, live, skillOptions }: Props) {
  // Навыки (ARMS, фаза 3): «/» в начале сообщения — подсказки команд.
  const [skillActive, setSkillActive] = useState(0);
  const [skillDismissed, setSkillDismissed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const skillMatches = skillDismissed ? [] : matchSkills(text, skillOptions);

  function pickSkill(s: SkillOption) {
    onTextChange(`/${s.slug} `);
    setSkillActive(0);
    textareaRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (skillMatches.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSkillActive((i) => (i + (e.key === 'ArrowDown' ? 1 : skillMatches.length - 1)) % skillMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickSkill(skillMatches[Math.min(skillActive, skillMatches.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        setSkillDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  function onTextareaInput(e: FormEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }

  const disabled = live.active || voice.phase !== 'idle' || !hasConversation;
  const isVoiceProcessing = voice.phase === 'processing';

  return (
    <>
      {voice.error && <Alert tone="danger">{voice.error}</Alert>}
      {live.error && <Alert tone="danger">{live.error}</Alert>}

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
        {(attachments.pending.length > 0 || attachments.uploading || attachments.error) && (
          <div className="ds-task-meta">
            {attachments.pending.map((a) => (
              <FileChip key={a.fileId} name={a.name} onRemove={() => attachments.remove(a.fileId)} />
            ))}
            {attachments.uploading && <span className="ds-field-hint">Загрузка файла…</span>}
            {attachments.error && <span className="ds-field-error">{attachments.error}</span>}
          </div>
        )}
        <input ref={fileInputRef} type="file" hidden accept={ACCEPTED_UPLOAD_MIME_TYPES} onChange={attachments.onFileSelected} />
        {voice.phase !== 'idle' && (
          <p className={cx('live-transcript', !voice.liveTranscript && 'is-empty')} aria-live="polite">
            {voice.liveTranscript || (voice.phase === 'recording' ? 'Говорите…' : 'Распознаю…')}
          </p>
        )}
        {voice.phase === 'idle' && (
          <SkillSuggest options={skillMatches} active={Math.min(skillActive, Math.max(skillMatches.length - 1, 0))} onPick={pickSkill} />
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          hidden={voice.phase !== 'idle'}
          placeholder="Напишите задачу, вопрос или поручение…"
          aria-label="Сообщение ассистенту"
          value={text}
          disabled={sending || disabled}
          maxLength={MAX_TEXT_LENGTH}
          onChange={(e) => {
            onTextChange(e.target.value);
            setSkillDismissed(false);
            setSkillActive(0);
          }}
          onInput={onTextareaInput}
          onKeyDown={onKeyDown}
        />
        <div className="ds-composer-row">
          <IconButton
            icon={Paperclip}
            label="Прикрепить файл"
            size="sm"
            disabled={sending || attachments.uploading || disabled || attachments.pending.length >= MAX_ATTACHMENTS}
            onClick={() => fileInputRef.current?.click()}
          />
          {voice.phase === 'recording' ? (
            <IconButton icon={Square} label="Остановить запись" size="sm" onClick={voice.stop} />
          ) : (
            <IconButton
              icon={Mic}
              label="Надиктовать"
              size="sm"
              disabled={sending || attachments.uploading || disabled || isVoiceProcessing}
              onClick={voice.start}
            />
          )}
          {live.enabled && voice.phase === 'idle' && (
            <IconButton
              icon={Headphones}
              label="Живой голос"
              size="sm"
              disabled={sending || attachments.uploading || live.active || !hasConversation}
              onClick={live.start}
            />
          )}
          <span className="ds-spacer" />
          {voice.phase === 'recording' && (
            <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>
              {String(Math.floor(voice.elapsedSec / 60)).padStart(2, '0')}:{String(voice.elapsedSec % 60).padStart(2, '0')}
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
            <IconButton icon={Send} label="Отправить" variant="primary" size="sm" disabled={!text.trim() || disabled} onClick={onSend} />
          )}
        </div>
      </div>
    </>
  );
}
