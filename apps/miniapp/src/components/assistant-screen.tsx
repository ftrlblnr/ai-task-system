'use client';

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Paperclip, Send, X } from 'lucide-react';
import type {
  ConversationMessage,
  ConversationSummary,
  FilePartData,
  MessagePart,
  StreamEvent,
  UploadedFileInfo,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { MessagePartRenderer, FilePartView } from './assistant-message-part';

const MAX_TEXTAREA_HEIGHT = 140;
// Зеркало бэкенд-лимитов (аудит 16.09.2026, находка про рассинхрон
// фронт/бэк) — SendMessageDto.text (@MaxLength(4000)) и attachmentIds
// (@ArrayMaxSize(10)) в apps/api/src/assistant/dto/send-message.dto.ts.
// Дублирование чисел, а не общий пакет ради двух констант — тот же
// компромисс, что уже принят для ALLOWED_UPLOAD_MIME_TYPES ниже.
const MAX_ATTACHMENTS = 10;
const MAX_TEXT_LENGTH = 4000;
// Зеркало apps/api/src/files/dto/upload-file.dto.ts — accept на <input
// type=file> лишь подсказка браузеру (не замена серверной проверке
// fileFilter/magic-byte, см. file-signature.ts), но избавляет пользователя
// от очевидно бессмысленного выбора файла не из списка.
const ACCEPTED_UPLOAD_MIME_TYPES =
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain,image/png,image/jpeg,image/webp,image/gif';
// Порог "у низа" — тот же порядок величины, что визуально ощущается как
// "почти внизу", не точный 0 (иначе любой суб-пиксельный скролл во время
// стрима считался бы "ушёл вверх").
const NEAR_BOTTOM_THRESHOLD_PX = 80;

function newClientRequestId(): string {
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

function userBubbleText(m: ConversationMessage): string {
  const part = m.parts[0]?.data as { content?: string } | undefined;
  return part?.content ?? '';
}

// "Живые" части ответа, пока стрим ещё идёт (Stage 2, Phase E) — статусы
// инструментов в порядке вызова, затем накопленный на данный момент текст.
// Карточки задач/событий здесь не появляются: они не стримятся токен за
// токеном, а приходят готовыми в message.completed вместе с остальным
// финальным сообщением (спека не требует стримить карточки по частям).
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

// Текстовый AI-чат поверх /assistant/* (Stage 2, Phase D — базовый чат;
// Phase E — streaming) — отдельная вкладка от «Голос» (владелец
// 15.09.2026: голос трогать не обязательно в этой фазе, объединение —
// Phase H). История — с сервера (Phase B), не localStorage: refresh/
// другое устройство видят ту же переписку (спека §27).
export function AssistantScreen({ active = true }: { active?: boolean }) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Сетевой сбой самой отправки/обрыв стрима (не серверная ошибка внутри
  // уже полученного сообщения — та пришла бы как обычный FAILED
  // assistant-message с ErrorPart) — спека §28: сообщение пользователя не
  // удаляется, кнопка «Повторить» шлёт тот же clientRequestId,
  // идемпотентность (Phase B, уточнена в Phase E — см. backend) не даёт
  // дубля и реально повторяет попытку, если предыдущая не удалась.
  const [failedSend, setFailedSend] = useState<{ clientRequestId: string; text: string; attachments: UploadedFileInfo[] } | null>(
    null,
  );
  const chatRef = useRef<HTMLDivElement>(null);
  // P1.5 (аудит 16.09.2026, находка про автоскролл во время стрима) — в
  // ref, не state: значение читается только внутри эффекта на [messages] и
  // внутри scheduleRender(), пересчитывать его на каждый пиксель скролла в
  // state означало бы ре-рендер экрана на каждое scroll-событие.
  // showJumpButton — отдельный, редко меняющийся state только для того,
  // чтобы показать/скрыть кнопку ↓ (меняется только при пересечении
  // порога, не на каждый пиксель).
  const isNearBottomRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

  // Phase F — вложения, уже загруженные (POST /files/upload прошёл), но
  // ещё не отправленные вместе с сообщением — чипы над composer'ом,
  // можно снять до отправки.
  const [pendingAttachments, setPendingAttachments] = useState<UploadedFileInfo[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function onFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // даёт выбрать тот же файл повторно позже
    if (!file) return;
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      setUploadError(`Нельзя прикрепить больше ${MAX_ATTACHMENTS} файлов к одному сообщению`);
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const info = await api.postForm<UploadedFileInfo>('/files/upload', formData);
      setPendingAttachments((prev) => [...prev, info]);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : 'Не удалось загрузить файл');
    } finally {
      setUploading(false);
    }
  }

  // P1.3 (аудит 16.09.2026, находка #10 — orphan uploads) — раньше снятие
  // вложения крестиком только чистило локальный state, физический файл и
  // запись FileArtifact оставались в БД/на диске навсегда. Fire-and-forget:
  // composer уже не показывает вложение независимо от результата запроса
  // (тот же fail-safe принцип, что и молчаливый пропуск чужого/несуществу-
  // ющего attachmentId на бэкенде) — если DELETE не удался, файл всё равно
  // рано или поздно уберёт FilesCleanupCron.
  function removePendingAttachment(fileId: string) {
    setPendingAttachments((prev) => prev.filter((a) => a.fileId !== fileId));
    api.delete(`/files/${fileId}`).catch(() => undefined);
  }

  // .then()-цепочка, не async/await — тот же стиль, что tasks-screen.tsx
  // (тоже вызывается из useEffect по active): react-hooks/set-state-in-effect
  // не всегда прослеживает setState через await до конца цепочки внутри
  // async-функции, вызванной из эффекта, и ложно считает это "синхронным"
  // вызовом setState прямо в эффекте.
  function load() {
    api
      .get<ConversationSummary[]>('/assistant/conversations')
      .then((conversations) => {
        const id = conversations[0]?.id;
        if (!id) return undefined;
        setConversationId(id);
        return api.get<ConversationMessage[]>(`/assistant/conversations/${id}/messages`).then(setMessages);
      })
      .then(() => setLoadError(null))
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить переписку'));
  }

  // active приходит от SwipeShell (тот же приём, что tasks-screen.tsx) —
  // экран смонтирован всегда (см. swipe-shell.tsx), но историю грузим при
  // каждом возвращении на вкладку, не один раз за сессию: это же покрывает
  // "второе устройство"/восстановление после долгого отсутствия (спека
  // Stage 2 §27) без отдельного механизма.
  useEffect(() => {
    if (active) load();
  }, [active]);

  // P1.5 (аудит 16.09.2026) — слушатель скролла живёт всё время монтирования
  // экрана (не только во время стрима): пользователь может пролистать
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
    // chat.scrollTo(), не scrollIntoView() — SwipeShell держит все экраны
    // смонтированными одновременно (см. комментарий в swipe-shell.tsx про
    // баг 08.09.2026: scrollIntoView() внутри неактивного экрана ломало
    // позиционирование свайп-трека через паразитный scrollLeft предка).
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

  async function send(overrideText?: string, overrideClientRequestId?: string, overrideAttachments?: UploadedFileInfo[]) {
    const isRetry = Boolean(overrideClientRequestId);
    const value = (overrideText ?? text).trim();
    if (!value || sending || !conversationId) return;

    const attachments = overrideAttachments ?? pendingAttachments;
    const clientRequestId = overrideClientRequestId ?? newClientRequestId();
    const assistantPlaceholderId = `optimistic-assistant-${clientRequestId}`;

    setSending(true);
    setFailedSend(null);
    if (!isRetry) {
      setText('');
      setPendingAttachments([]);
    }

    setMessages((prev) => {
      const base = prev ?? [];
      const withUser = isRetry ? base : [...base, optimisticUserMessage(conversationId, clientRequestId, value, attachments)];
      return [...withUser, optimisticAssistantMessage(conversationId, clientRequestId)];
    });

    // Живое состояние на время стрима — обычные переменные, не React state:
    // React state нужен только для того, что реально рендерится
    // (parts текущего "живого" сообщения), сам накопитель — просто буфер.
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

    // P1.7 (аудит 16.09.2026) — text-delta приходит от Anthropic по
    // несколько раз в секунду на каждый маленький токен; setMessages на
    // каждый chunk означал лишний ре-рендер всего списка сообщений чаще,
    // чем экран физически успевает перерисоваться. Копим дельты в liveText
    // (обычная переменная выше), реально вызываем setMessages не чаще
    // одного раза за кадр — сам SSE-транспорт и бэкенд не меняются.
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
          setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId).concat(event.message));
          break;
        case 'message.failed':
          terminal = true;
          setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId));
          setFailedSend({ clientRequestId, text: value, attachments });
          break;
        case 'message.started':
          // Phase F.2 (аудит 17.09.2026, P2.10) — заменяет optimistic
          // user-бабл авторитетным сообщением с сервера (тот же принцип,
          // что message.completed уже делает для ответа ассистента ниже)
          // — до этого события бабл оставался локальным черновиком до
          // следующего getMessages()/refresh, метаданные вложений могли
          // не совпадать с тем, что реально сохранил бэкенд.
          setMessages((prev) => (prev ?? []).map((m) => (m.id === `optimistic-user-${clientRequestId}` ? event.userMessage : m)));
          break;
      }
    }

    try {
      const response = await api.postStream(`/assistant/conversations/${conversationId}/messages/stream`, {
        text: value,
        clientRequestId,
        attachmentIds: attachments.map((a) => a.fileId),
      });
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

      // Соединение закрылось, не дойдя ни до message.completed, ни до
      // message.failed (обрыв сети, сервер упал до финального события) —
      // тот же "Повторить"-путь, что и обычный сетевой сбой.
      if (!terminal) {
        setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId));
        setFailedSend({ clientRequestId, text: value, attachments });
      }
    } catch {
      setMessages((prev) => (prev ?? []).filter((m) => m.id !== assistantPlaceholderId));
      setFailedSend({ clientRequestId, text: value, attachments });
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
              {m.parts
                .filter((p) => p.type === 'file')
                .map((p) => (
                  <FilePartView key={p.id} data={p.data as FilePartData} />
                ))}
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
            <button
              type="button"
              className="assistant-card-open"
              onClick={() => send(failedSend.text, failedSend.clientRequestId, failedSend.attachments)}
            >
              Повторить
            </button>
          </div>
        )}
        {showJumpButton && (
          <button type="button" className="assistant-scroll-down" onClick={scrollToBottom}>
            ↓ Новые сообщения
          </button>
        )}
      </div>
      {(pendingAttachments.length > 0 || uploading || uploadError) && (
        <div className="assistant-pending-attachments">
          {pendingAttachments.map((a) => (
            <span key={a.fileId} className="assistant-chip assistant-pending-attachment">
              {a.name}
              <button type="button" onClick={() => removePendingAttachment(a.fileId)} aria-label="Убрать вложение">
                <X size={11} strokeWidth={2.5} />
              </button>
            </span>
          ))}
          {uploading && <span className="hint">Загрузка файла…</span>}
          {uploadError && <span className="error">{uploadError}</span>}
        </div>
      )}
      <div className="assistant-composer">
        <input ref={fileInputRef} type="file" hidden accept={ACCEPTED_UPLOAD_MIME_TYPES} onChange={onFileSelected} />
        <button
          type="button"
          className="assistant-attach-btn"
          disabled={sending || uploading || pendingAttachments.length >= MAX_ATTACHMENTS}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Прикрепить файл"
        >
          <Paperclip size={18} strokeWidth={2} />
        </button>
        <textarea
          rows={1}
          placeholder="Спросите что-нибудь…"
          value={text}
          disabled={sending}
          maxLength={MAX_TEXT_LENGTH}
          onChange={(e) => setText(e.target.value)}
          onInput={onTextareaInput}
          onKeyDown={onComposerKeyDown}
        />
        {text.length > MAX_TEXT_LENGTH - 200 && (
          <span className="hint assistant-char-counter">
            {text.length}/{MAX_TEXT_LENGTH}
          </span>
        )}
        <button type="button" className="assistant-send-btn" disabled={sending || !text.trim()} onClick={() => send()}>
          <Send size={18} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}
