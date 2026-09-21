'use client';

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Mic, Paperclip, Send, Square, X } from 'lucide-react';
import type {
  ConversationMessage,
  ConversationSummary,
  FilePartData,
  MessagePart,
  StreamEvent,
  UploadedFileInfo,
  VoiceActionResult,
  VoiceParseResponse,
  VoiceUndoInput,
  VoiceUndoResponse,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { haptic, notificationHaptic } from '@/lib/telegram';
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

// Голос (Stage 2, Phase H — перенесено из voice-screen.tsx, экран объединён
// с этим). Полноэкранная сфера/кольца с амплитудой сознательно не перенесены
// (владелец 18.09.2026: один композер с текстом и микрофоном, без отдельного
// полноэкранного состояния записи) — во время записи кнопка микрофона
// становится кнопкой "стоп" с таймером рядом, тот же принцип, что у обычных
// мессенджеров.
const MAX_VOICE_DURATION_MS = 100_000;
const VOICE_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
// Undo активен ~30 секунд после голосового действия (владелец 10.09.2026,
// см. исходный комментарий в прежнем voice-screen.tsx) — та же логика,
// перенесена без изменений: удаление undo не даёт (полное восстановление
// задачи/встречи со всеми комментариями/подзадачами/участниками — отдельная,
// более тяжёлая фича).
const VOICE_UNDO_WINDOW_MS = 30_000;

function pickVoiceMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return VOICE_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

// Undo привязан к конкретной части конкретного assistant-сообщения (не ко
// всему сообщению) — один голосовой ответ может содержать несколько
// независимых действий в одном транскрипте ("удали встречу с Петром и
// создай новую на пятницу"), каждое со своей карточкой и своей кнопкой
// "Отменить".
interface VoiceUndoEntry {
  messageId: string;
  partId: string;
  undo: VoiceUndoInput;
}

// Портировано из voice-screen.tsx без изменений — create/update дают
// undo, delete — нет (сущности уже нет, откатывать нечего); ok=false и
// type='chat' тоже не дают undo.
function buildVoiceUndo(item: VoiceActionResult): VoiceUndoInput | null {
  if (item.type === 'chat') return null;
  if (item.type === 'task_action') {
    if (!item.ok) return null;
    if (item.draft.action === 'create' && item.taskId) return { kind: 'task', action: 'create', id: item.taskId };
    if (item.draft.action === 'update' && item.taskId && item.previous) {
      return { kind: 'task', action: 'update', id: item.taskId, previous: item.previous };
    }
    return null;
  }
  if (!item.ok) return null;
  if (item.draft.action === 'create' && item.eventId) return { kind: 'event', action: 'create', id: item.eventId };
  if (item.draft.action === 'update' && item.eventId && item.previous) {
    return {
      kind: 'event',
      action: 'update',
      id: item.eventId,
      previous: item.previous,
      addedParticipantIds: item.draft.addParticipantIds,
      removedParticipantIds: item.draft.removeParticipantIds,
    };
  }
  return null;
}

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
// Phase E — streaming; Phase F/F.2 — вложения; Phase H — голос объединён в
// этот же экран, одна лента для обоих: раньше «Голос» была отдельной
// вкладкой со своей историей в localStorage, POST /voice/parse теперь пишет
// в ту же Conversation/Message, что и текст, см. voice.service.ts). История
// — с сервера (Phase B), не localStorage: refresh/другое устройство видят
// ту же переписку (спека §27) — это верно и для голосовых реплик теперь.
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

  // Голос (Stage 2, Phase H) — запись поверх того же composer'а.
  const [voicePhase, setVoicePhase] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceElapsedSec, setVoiceElapsedSec] = useState(0);
  const [voiceUndos, setVoiceUndos] = useState<VoiceUndoEntry[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceAutoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceTickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (voiceAutoStopTimerRef.current) clearTimeout(voiceAutoStopTimerRef.current);
      if (voiceTickTimerRef.current) clearInterval(voiceTickTimerRef.current);
      voiceStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function startVoiceRecording() {
    setVoiceError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError') {
        setVoiceError(
          'Доступ к микрофону запрещён. Если в браузере разрешение выдано, но не работает — проверьте, что у самого приложения Telegram есть доступ к микрофону в настройках телефона.',
        );
      } else if (name === 'NotFoundError') {
        setVoiceError('Микрофон не найден на этом устройстве.');
      } else {
        setVoiceError('Не удалось получить доступ к микрофону.');
      }
      return;
    }

    const mimeType = pickVoiceMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    voiceChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) voiceChunksRef.current.push(e.data);
    };
    recorder.onstop = () => void handleVoiceStop();

    voiceStreamRef.current = stream;
    recorderRef.current = recorder;
    recorder.start();
    haptic('medium');

    setVoiceElapsedSec(0);
    setVoicePhase('recording');
    voiceTickTimerRef.current = setInterval(() => setVoiceElapsedSec((s) => s + 1), 1000);
    voiceAutoStopTimerRef.current = setTimeout(() => stopVoiceRecording(), MAX_VOICE_DURATION_MS);
  }

  function stopVoiceRecording() {
    if (voiceAutoStopTimerRef.current) clearTimeout(voiceAutoStopTimerRef.current);
    if (voiceTickTimerRef.current) clearInterval(voiceTickTimerRef.current);
    voiceAutoStopTimerRef.current = null;
    voiceTickTimerRef.current = null;
    recorderRef.current?.stop();
    voiceStreamRef.current?.getTracks().forEach((t) => t.stop());
  }

  // По остановке записи — POST /voice/parse (multipart), затем
  // userMessage/assistantMessage из ответа добавляются в ту же ленту, что и
  // обычная текстовая отправка (Stage 2, Phase H) — тем же
  // MessagePartRenderer, без отдельного рендер-пути для голоса. results[i]
  // и assistantMessage.parts[i] идут в одном порядке (см.
  // buildVoiceAssistantParts на бэкенде) — зипуем по индексу, чтобы прицепить
  // временную (не персистентную — как и раньше) кнопку "Отменить" к нужной
  // части. clientRequestId (Stage 2, Phase H.1, аудит 20.09.2026, P0) —
  // защита от повторного выполнения действия, если сеть оборвалась после
  // того, как сервер уже выполнил мутацию, но до того, как ответ дошёл
  // сюда (см. VoiceService.parse).
  async function handleVoiceStop() {
    setVoicePhase('processing');
    haptic('light');
    try {
      const actualMimeType = recorderRef.current?.mimeType || 'audio/webm';
      const blob = new Blob(voiceChunksRef.current, { type: actualMimeType });
      const ext = actualMimeType.includes('mp4') ? 'm4a' : actualMimeType.includes('ogg') ? 'ogg' : 'webm';
      const formData = new FormData();
      formData.append('audio', blob, `voice.${ext}`);
      formData.append('clientRequestId', newClientRequestId());
      // Stage 2, Phase H.1 (аудит 20.09.2026, P2) — пишем именно в тот
      // разговор, что открыт на этом экране, а не в "последний активный"
      // (пока это одно и то же — один разговор на сотрудника — но не
      // полагаемся на эвристику там, где уже знаем точный id).
      if (conversationId) formData.append('conversationId', conversationId);

      const response = await api.postForm<VoiceParseResponse>('/voice/parse', formData);

      // userMessage/assistantMessage — null только при редком сбое
      // сохранения истории ПОСЛЕ того, как действие уже выполнено (Phase
      // H.1, P1) — само действие всё равно случилось, просто голосовая
      // реплика в этот раз не попадёт в общую ленту; результат пользователь
      // всё равно узнаёт по haptic-фидбэку ниже.
      if (response.userMessage && response.assistantMessage) {
        const { userMessage, assistantMessage } = response;
        setMessages((prev) => [...(prev ?? []), userMessage, assistantMessage]);
        if (!conversationId && response.conversationId) setConversationId(response.conversationId);

        const newUndos: VoiceUndoEntry[] = [];
        response.results.forEach((item, i) => {
          const undo = buildVoiceUndo(item);
          const part = assistantMessage.parts[i];
          if (undo && part) newUndos.push({ messageId: assistantMessage.id, partId: part.id, undo });
        });
        if (newUndos.length > 0) {
          setVoiceUndos((prev) => [...prev, ...newUndos]);
          setTimeout(() => {
            setVoiceUndos((prev) => prev.filter((u) => !newUndos.includes(u)));
          }, VOICE_UNDO_WINDOW_MS);
        }
      }
      notificationHaptic(response.results.every((r) => r.type === 'chat' || r.ok) ? 'success' : 'error');
    } catch (err) {
      notificationHaptic('error');
      setVoiceError(err instanceof ApiError ? err.message : 'Не удалось обработать голосовое сообщение.');
    } finally {
      setVoicePhase('idle');
    }
  }

  // Stage 2, Phase H.1 (аудит 20.09.2026, P0/P1) — раньше фронтенд сам
  // откатывал через PATCH/DELETE, потом отдельно просил сервер записать
  // придуманный им самим текст подтверждения через POST /voice/messages
  // (произвольный текст от клиента с ролью ASSISTANT — conversation-history
  // poisoning, особенно опасно после того, как эта лента стала общим
  // AI-контекстом). Теперь один вызов POST /voice/undo: сервер сам
  // выполняет откат и сам решает текст подтверждения — клиент только
  // получает {ok, error} для мгновенной локальной обратной связи.
  // Итоговая (полная, с текстом от сервера) запись появится в истории при
  // следующей загрузке — load() ниже её подтягивает.
  async function performVoiceUndo(entry: VoiceUndoEntry) {
    setVoiceUndos((prev) => prev.filter((u) => u !== entry));
    try {
      const response = await api.post<VoiceUndoResponse>('/voice/undo', entry.undo);
      notificationHaptic(response.ok ? 'success' : 'error');
    } catch {
      notificationHaptic('error');
    } finally {
      load();
    }
  }

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
        {messages.length === 0 && (
          <p className="hint" style={{ margin: '10px 0' }}>
            Спросите что-нибудь текстом или надиктуйте задачу/встречу голосом — кнопка микрофона рядом с полем ввода.
          </p>
        )}
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
                m.parts.map((part) => {
                  const undo = voiceUndos.find((u) => u.messageId === m.id && u.partId === part.id);
                  if (!undo) return <MessagePartRenderer key={part.id} part={part} />;
                  // Голос (Stage 2, Phase H) — "Отменить" рядом с картой/
                  // текстом только что выполненного действия, временно
                  // (VOICE_UNDO_WINDOW_MS), не персистентно — то же
                  // ограничение, что и раньше в voice-screen.tsx.
                  return (
                    <div key={part.id}>
                      <MessagePartRenderer part={part} />
                      <div className="voice-confirm-actions">
                        <button type="button" className="btn-secondary btn-small" onClick={() => performVoiceUndo(undo)}>
                          Отменить
                        </button>
                      </div>
                    </div>
                  );
                })
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
      {voiceError && (
        <div className="assistant-pending-attachments">
          <span className="error">{voiceError}</span>
        </div>
      )}
      <div className="assistant-composer">
        <input ref={fileInputRef} type="file" hidden accept={ACCEPTED_UPLOAD_MIME_TYPES} onChange={onFileSelected} />
        <button
          type="button"
          className="assistant-attach-btn"
          disabled={sending || uploading || voicePhase !== 'idle' || pendingAttachments.length >= MAX_ATTACHMENTS}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Прикрепить файл"
        >
          <Paperclip size={18} strokeWidth={2} />
        </button>
        <textarea
          rows={1}
          placeholder="Спросите что-нибудь…"
          value={text}
          disabled={sending || voicePhase !== 'idle'}
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
        {voicePhase === 'recording' && (
          <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>
            {String(Math.floor(voiceElapsedSec / 60)).padStart(2, '0')}:{String(voiceElapsedSec % 60).padStart(2, '0')}
          </span>
        )}
        {!text.trim() && (
          <button
            type="button"
            className="assistant-attach-btn"
            disabled={sending || uploading || voicePhase === 'processing'}
            onClick={voicePhase === 'recording' ? stopVoiceRecording : startVoiceRecording}
            aria-label={voicePhase === 'recording' ? 'Остановить запись' : 'Надиктовать'}
          >
            {voicePhase === 'recording' ? <Square size={16} strokeWidth={2} /> : <Mic size={18} strokeWidth={2} />}
          </button>
        )}
        {!!text.trim() && (
          <button type="button" className="assistant-send-btn" disabled={sending} onClick={() => send()}>
            <Send size={18} strokeWidth={2.2} />
          </button>
        )}
      </div>
    </div>
  );
}
