'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import type {
  CalendarEvent,
  CreateEventInput,
  CreateTaskInput,
  LogVoiceMessageInput,
  TaskDetail,
  TaskPriority,
  VoiceDraft,
  VoiceEventActionDraft,
  VoiceParseResponse,
  VoiceTaskActionDraft,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { haptic, notificationHaptic } from '@/lib/telegram';
import { useAuth } from '@/lib/auth-context';
import { TaskDetailOverlay } from './task-detail-overlay';

type Phase = 'idle' | 'recording' | 'processing' | 'error';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: 'pending' | 'error';
  // Подтверждение удаления голосом (владелец 09.09.2026) — кнопками в
  // чате, не второй голосовой репликой (ненадёжно как распознавание
  // поверх уже состоявшейся ошибки). Пока не null — ничего не удалено.
  pendingAction?: { kind: 'task' | 'event'; targetId: string; targetTitle: string } | null;
  // Undo (аудит 10.09.2026, п. 4.2) — та же логика, что apps/web/src/app/
  // voice/page.tsx, см. комментарии там. Активно ~30 секунд после действия.
  undo?: UndoInfo | null;
}

interface TaskRevertPayload {
  title?: string;
  description?: string;
  assigneeId?: string | null;
  dueDate?: string | null;
  priority?: TaskPriority;
}
interface EventRevertPayload {
  title?: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  allDay?: boolean;
}

type UndoInfo =
  | { kind: 'task'; action: 'create'; id: string }
  | { kind: 'task'; action: 'update'; id: string; previous: TaskRevertPayload }
  | { kind: 'event'; action: 'create'; id: string }
  | {
      kind: 'event';
      action: 'update';
      id: string;
      previous: EventRevertPayload;
      addedParticipantIds: string[];
      removedParticipantIds: string[];
    };

const UNDO_WINDOW_MS = 30_000;

// Держит переписку в localStorage, а не только в React-стейте — Mini App
// переоткрывается из Telegram заново при каждом запуске (тот же комментарий,
// что у sessionStorage-токена в auth-context.tsx), и без этого история
// голосового чата стиралась при каждом закрытии/открытии. localStorage,
// а не sessionStorage — сознательно: токен обязан истекать вместе с
// сессией, а переписка, наоборот, должна её пережить. Ключ содержит id
// пользователя — на случай, если несколько сотрудников когда-нибудь войдут
// с одного устройства, у каждого своя лента. Хранится не более
// MAX_STORED_MESSAGES последних сообщений — без ограничения переписка
// росла бы в localStorage бесконечно.
const MAX_STORED_MESSAGES = 60;

function chatStorageKey(userId: string): string {
  return `voice-chat-history:${userId}`;
}

function loadStoredMessages(userId: string): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(chatStorageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    // Обрубленное pending-сообщение (вкладка закрыта до ответа сервера) не
    // должно навсегда зависнуть в "Понял вас, создаю…" — считаем его
    // потерянным и помечаем ошибкой при загрузке.
    return parsed.map((m) => (m.status === 'pending' ? { ...m, status: 'error' as const } : m));
  } catch {
    return [];
  }
}

function persistMessages(userId: string, messages: ChatMessage[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(chatStorageKey(userId), JSON.stringify(messages.slice(-MAX_STORED_MESSAGES)));
  } catch {
    // Приватный режим браузера / переполненная квота — переписка просто не
    // переживёт закрытие, не критично для работы самого голосового режима.
  }
}

// Ограничивает худший случай по стоимости/задержке Whisper+Claude на одну
// голосовую заметку — не просто UX-деталь.
const MAX_DURATION_MS = 100_000;

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

// Владелец 01.09.2026: аудиозапись сама по себе — весь пользовательский путь,
// без формы ревью — «как в чате». Разбор, создание задачи/события и любые
// уточнения происходят на фоне; результат — реплика ассистента, а не форма
// на подтверждение. Это сознательный отход от раздела 10.3 ТЗ («значимые
// действия требуют подтверждения человеком перед созданием») специально для
// голосового ввода — решение владельца о собственном рабочем процессе, не
// распространяется на остальные пути создания задач/событий (ручные формы
// остаются как есть). RBAC-ограничение на события для не-OWNER остаётся
// жёсткой границей на бэкенде (VoiceService.enforceEventRbac), а не просто
// шагом ревью — здесь ничего не меняется.
export function VoiceScreen() {
  const { user } = useAuth();
  // VoiceScreen рендерится только когда user уже есть (см. page.tsx), но
  // TypeScript этого не знает — user.id внутри компонента безопасен.
  const userId = user!.id;

  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadStoredMessages(userId));
  // "Открыть" для задачи (аудит 10.09.2026, п. 4.2) — здесь нет роутинга по
  // страницам (см. tasks-screen.tsx), задача открывается тем же оверлеем.
  // Для событий такого оверлея нет нигде в приложении — кнопки "Открыть"
  // undo.kind==='event' сознательно не показывает.
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  // Амплитуда голоса в реальном времени — двигает сферу/кольца через
  // CSS-переменную --amp напрямую на DOM-узле (orbRef), в обход React-стейта:
  // это ~30-60 обновлений в секунду, ре-рендер компонента на каждый кадр
  // забил бы event loop на слабом WebView-устройстве.
  const orbRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      cleanupTimers();
      stopAmplitudeLoop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // chat.scrollTo(), а не scrollEndRef.scrollIntoView() — владелец 08.09.2026:
  // "свайп криво работает и вкладки открывают не те вкладки". Root cause:
  // SwipeShell монтирует ВСЕ экраны сразу (прячет неактивные через
  // transform, не условным рендером), поэтому этот эффект срабатывает и
  // тогда, когда экран «Голос» не активен. scrollIntoView() поднимается по
  // всей цепочке скроллируемых предков — включая .swipe-viewport
  // (overflow:hidden, но программно всё равно скроллится) — и выставлял
  // там паразитный scrollLeft, ломая translateX-позиционирование трека.
  // Прямой scrollTo() трогает только сам .voice-chat, не затрагивая предков.
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
    persistMessages(userId, messages);
  }, [messages, userId]);

  function cleanupTimers() {
    if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
    if (tickTimerRef.current) clearInterval(tickTimerRef.current);
    autoStopTimerRef.current = null;
    tickTimerRef.current = null;
  }

  function startAmplitudeLoop(stream: MediaStream) {
    // webkitAudioContext — ещё нужен на части iOS WebView (тот же класс
    // риска, что и с MediaRecorder mimeType ниже: Telegram на iOS живёт в
    // WKWebView с отставанием от актуального Safari).
    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    const ctx = new AudioContextCtor();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    audioCtxRef.current = ctx;
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const amp = sum / data.length / 255; // 0..1
      orbRef.current?.style.setProperty('--amp', amp.toFixed(3));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  function stopAmplitudeLoop() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
    orbRef.current?.style.setProperty('--amp', '0');
  }

  async function startRecording() {
    setErrorMessage(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError') {
        setErrorMessage(
          'Доступ к микрофону запрещён. Если в браузере разрешение выдано, но не работает — проверьте, что у самого приложения Telegram есть доступ к микрофону в настройках телефона.',
        );
      } else if (name === 'NotFoundError') {
        setErrorMessage('Микрофон не найден на этом устройстве.');
      } else {
        setErrorMessage('Не удалось получить доступ к микрофону.');
      }
      setPhase('error');
      return;
    }

    const mimeType = pickMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => void handleStop();

    streamRef.current = stream;
    recorderRef.current = recorder;
    recorder.start();
    haptic('medium');
    startAmplitudeLoop(stream);

    setElapsedSec(0);
    setPhase('recording');
    tickTimerRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    autoStopTimerRef.current = setTimeout(() => stopRecording(), MAX_DURATION_MS);
  }

  function stopRecording() {
    cleanupTimers();
    stopAmplitudeLoop();
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }

  // Память диалога (аудит 10.09.2026, п. 2.9) — сервер сам пишет реплику
  // пользователя (транскрипт) в VoiceService.parse; финальный текст ответа
  // ассистента пишем здесь, в момент, когда он становится окончательным.
  // Fire-and-forget — сбой логирования истории не должен мешать чату.
  function logAssistant(text: string) {
    const payload: LogVoiceMessageInput = { text };
    api.post('/voice/messages', payload).catch(() => {});
  }

  function pushMessage(msg: ChatMessage) {
    setMessages((prev) => [...prev, msg]);
  }
  function updateMessage(id: string, patch: Partial<ChatMessage>) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  async function handleStop() {
    setPhase('processing');
    haptic('light');
    try {
      // Фактический mimeType рекордера может отличаться от запрошенного
      // (иногда браузер выбирает сам) — берём его же для Blob/FormData, а не
      // исходный кандидат.
      const actualMimeType = recorderRef.current?.mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: actualMimeType });
      const ext = actualMimeType.includes('mp4') ? 'm4a' : actualMimeType.includes('ogg') ? 'ogg' : 'webm';
      const formData = new FormData();
      formData.append('audio', blob, `voice.${ext}`);

      const result = await api.postForm<VoiceParseResponse>('/voice/parse', formData);
      setPhase('idle');

      pushMessage({ id: crypto.randomUUID(), role: 'user', text: result.transcript });

      // drafts — массив, не одно действие (владелец 10.09.2026, найдено в
      // проде: "удали встречу с Петром и создай новую на пятницу" в одной
      // заметке — выполнилось только удаление, создание терялось). Каждый
      // элемент — своя реплика ассистента, обрабатываем по очереди; сбой
      // одного действия не блокирует остальные (try/catch внутри
      // confirmDraft/confirmDelete).
      for (const draft of result.drafts) {
        await processDraft(draft);
      }

      // Общая оценка неуверенности на весь транскрипт целиком (не про
      // конкретное действие — те уже объяснены каждое в своём баббле выше).
      if (result.clarificationNeeded && result.clarificationReason) {
        pushMessage({ id: crypto.randomUUID(), role: 'assistant', text: result.clarificationReason });
        logAssistant(result.clarificationReason);
      }
    } catch (err) {
      notificationHaptic('error');
      setPhase('error');
      const msg = err instanceof ApiError ? err.message : 'Не удалось обработать голосовое сообщение.';
      setErrorMessage(msg);
      pushMessage({ id: crypto.randomUUID(), role: 'assistant', text: msg, status: 'error' });
    }
  }

  // Один элемент result.drafts — своя реплика ассистента в чате.
  async function processDraft(draft: VoiceDraft) {
    // Не всё сказанное — попытка поставить задачу/событие: вопрос,
    // реплика, реакция на прошлый ответ. Раньше на это тоже создавалась
    // задача-заглушка («Уточнить формулировку») — владелец 07.09.2026
    // указал, что ожидал вместо этого живой ответ, а не мусор в списке
    // задач. draft.type === 'chat' — просто реплика, ничего не создаём.
    if (draft.type === 'chat') {
      pushMessage({ id: crypto.randomUUID(), role: 'assistant', text: draft.reply });
      logAssistant(draft.reply);
      return;
    }

    // Удаление ничего не удаляет само по себе — только показывает кнопки
    // подтверждения в баббле (владелец 09.09.2026).
    if (draft.action === 'delete') {
      const targetId = draft.type === 'task_action' ? draft.targetTaskId : draft.targetEventId;
      pushMessage({
        id: crypto.randomUUID(),
        role: 'assistant',
        text: `Удалить «${draft.targetTitle}»?`,
        pendingAction: { kind: draft.type === 'task_action' ? 'task' : 'event', targetId, targetTitle: draft.targetTitle },
      });
      return;
    }

    const assistantId = crypto.randomUUID();
    pushMessage({
      id: assistantId,
      role: 'assistant',
      text: describeInFlight(draft.type, draft.action),
      status: 'pending',
    });
    await confirmDraft(draft, assistantId);
  }

  // Создаёт/обновляет задачу/событие сразу, без экрана ревью (см.
  // комментарий над компонентом) — реплика ассистента в чате и есть
  // подтверждение. Удаление — отдельная ветка (см. processDraft), сюда не
  // попадает: confirmDelete ниже вызывается только по клику в баббле.
  async function confirmDraft(draft: VoiceTaskActionDraft | VoiceEventActionDraft, assistantId: string) {
    try {
      let undo: UndoInfo | null = null;

      if (draft.type === 'task_action') {
        if (draft.action === 'create') {
          const payload: CreateTaskInput = {
            title: draft.title,
            description: draft.description || undefined,
            assigneeId: draft.assigneeId || undefined,
            priority: draft.priority || undefined,
            dueDate: draft.dueDate || undefined,
          };
          const created = await api.post<TaskDetail>('/tasks', payload);
          undo = { kind: 'task', action: 'create', id: created.id };
        } else {
          const payload: Partial<CreateTaskInput> = {};
          if (draft.title !== '') payload.title = draft.title;
          if (draft.description !== '') payload.description = draft.description;
          if (draft.assigneeId !== null) payload.assigneeId = draft.assigneeId;
          if (draft.dueDate !== null) payload.dueDate = draft.dueDate;
          if (draft.priority !== null) payload.priority = draft.priority;
          const before = await api.get<TaskDetail>(`/tasks/${draft.targetTaskId}`);
          const previous: TaskRevertPayload = {};
          if (payload.title !== undefined) previous.title = before.title;
          if (payload.description !== undefined) previous.description = before.description ?? '';
          if (payload.assigneeId !== undefined) previous.assigneeId = before.assignee?.id ?? null;
          if (payload.dueDate !== undefined) previous.dueDate = before.dueDate ?? null;
          if (payload.priority !== undefined) previous.priority = before.priority;
          await api.patch(`/tasks/${draft.targetTaskId}`, payload);
          undo = { kind: 'task', action: 'update', id: draft.targetTaskId, previous };
        }
      } else if (draft.type === 'event_action') {
        if (draft.action === 'create') {
          const payload: CreateEventInput = {
            title: draft.title,
            description: draft.description || undefined,
            location: draft.location || undefined,
            startAt: draft.startAt ?? '',
            endAt: draft.endAt ?? '',
            allDay: draft.allDay ?? false,
          };
          const created = await api.post<CalendarEvent>('/events', payload);
          for (const employeeId of draft.addParticipantIds) {
            await api.post(`/events/${created.id}/participants`, { employeeId }).catch(() => {});
          }
          undo = { kind: 'event', action: 'create', id: created.id };
        } else {
          const payload: Partial<CreateEventInput> = {};
          if (draft.title !== '') payload.title = draft.title;
          if (draft.description !== '') payload.description = draft.description;
          if (draft.location !== '') payload.location = draft.location;
          if (draft.startAt !== null) payload.startAt = draft.startAt;
          if (draft.endAt !== null) payload.endAt = draft.endAt;
          if (draft.allDay !== null) payload.allDay = draft.allDay;
          const previous: EventRevertPayload = {};
          if (Object.keys(payload).length > 0) {
            const before = await api.get<CalendarEvent>(`/events/${draft.targetEventId}`).catch(() => null);
            if (before) {
              if (payload.title !== undefined) previous.title = before.title;
              if (payload.description !== undefined) previous.description = before.description ?? '';
              if (payload.location !== undefined) previous.location = before.location ?? '';
              if (payload.startAt !== undefined) previous.startAt = before.startAt;
              if (payload.endAt !== undefined) previous.endAt = before.endAt;
              if (payload.allDay !== undefined) previous.allDay = before.allDay;
            }
            await api.patch(`/events/${draft.targetEventId}`, payload);
          }
          for (const employeeId of draft.addParticipantIds) {
            await api.post(`/events/${draft.targetEventId}/participants`, { employeeId }).catch(() => {});
          }
          for (const employeeId of draft.removeParticipantIds) {
            await api.delete(`/events/${draft.targetEventId}/participants/${employeeId}`).catch(() => {});
          }
          undo = {
            kind: 'event',
            action: 'update',
            id: draft.targetEventId,
            previous,
            addedParticipantIds: draft.addParticipantIds,
            removedParticipantIds: draft.removeParticipantIds,
          };
        }
      }

      const successText = describeSuccess(draft);
      updateMessage(assistantId, { text: successText, status: undefined, undo });
      logAssistant(successText);
      notificationHaptic('success');
      if (undo) {
        setTimeout(() => updateMessage(assistantId, { undo: null }), UNDO_WINDOW_MS);
      }
    } catch (err) {
      notificationHaptic('error');
      const errorText = `Не получилось сохранить: ${err instanceof ApiError ? err.message : 'попробуйте ещё раз'}`;
      updateMessage(assistantId, { text: errorText, status: 'error' });
      logAssistant(errorText);
    }
  }

  async function performUndo(messageId: string, undo: UndoInfo) {
    updateMessage(messageId, { undo: null });
    try {
      if (undo.kind === 'task') {
        if (undo.action === 'create') await api.delete(`/tasks/${undo.id}`);
        else await api.patch(`/tasks/${undo.id}`, undo.previous);
      } else {
        if (undo.action === 'create') {
          await api.delete(`/events/${undo.id}`);
        } else {
          if (Object.keys(undo.previous).length > 0) await api.patch(`/events/${undo.id}`, undo.previous);
          for (const employeeId of undo.addedParticipantIds) {
            await api.delete(`/events/${undo.id}/participants/${employeeId}`).catch(() => {});
          }
          for (const employeeId of undo.removedParticipantIds) {
            await api.post(`/events/${undo.id}/participants`, { employeeId }).catch(() => {});
          }
        }
      }
      const text = 'Отменено.';
      pushMessage({ id: crypto.randomUUID(), role: 'assistant', text });
      logAssistant(text);
      notificationHaptic('success');
    } catch (err) {
      notificationHaptic('error');
      const text = `Не получилось отменить: ${err instanceof ApiError ? err.message : 'попробуйте ещё раз'}`;
      pushMessage({ id: crypto.randomUUID(), role: 'assistant', text, status: 'error' });
      logAssistant(text);
    }
  }

  function describeInFlight(type: 'task_action' | 'event_action', action: 'create' | 'update' | 'delete'): string {
    if (type === 'task_action') return action === 'create' ? 'Понял вас — создаю задачу…' : 'Понял вас — обновляю задачу…';
    return action === 'create' ? 'Понял вас — создаю событие…' : 'Понял вас — обновляю встречу…';
  }

  async function confirmDelete(messageId: string, action: NonNullable<ChatMessage['pendingAction']>) {
    updateMessage(messageId, { pendingAction: null, status: 'pending' });
    try {
      if (action.kind === 'task') {
        await api.delete(`/tasks/${action.targetId}`);
      } else {
        await api.delete(`/events/${action.targetId}`);
      }
      const successText = `Удалил «${action.targetTitle}».`;
      updateMessage(messageId, { text: successText, status: undefined });
      logAssistant(successText);
      notificationHaptic('success');
    } catch (err) {
      notificationHaptic('error');
      const errorText = `Не получилось удалить: ${err instanceof ApiError ? err.message : 'попробуйте ещё раз'}`;
      updateMessage(messageId, { text: errorText, status: 'error' });
      logAssistant(errorText);
    }
  }

  function cancelDelete(messageId: string) {
    updateMessage(messageId, { text: 'Отменено.', pendingAction: null });
    logAssistant('Отменено.');
  }

  function describeSuccess(draft: VoiceTaskActionDraft | VoiceEventActionDraft): string {
    let base: string;
    if (draft.type === 'task_action' && draft.action === 'create') {
      // Имя сотрудника из БД нельзя корректно склонить программно
      // («для Иван Иванов» вместо «для Ивана Иванова») — формулировка
      // построена так, чтобы не требовать падежа от имени.
      const parts = [`Создал задачу «${draft.title}».`];
      if (draft.assigneeName) parts.push(`Исполнитель: ${draft.assigneeName}.`);
      if (draft.dueDate) parts.push(`Срок — до ${new Date(draft.dueDate).toLocaleDateString('ru-RU')}.`);
      base = parts.join(' ');
    } else if (draft.type === 'task_action') {
      base = `Обновил задачу «${draft.targetTitle}».`;
    } else if (draft.type === 'event_action' && draft.action === 'create') {
      const when = draft.startAt
        ? new Date(draft.startAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
        : '';
      base = `Создал событие «${draft.title}»${when ? ` на ${when}` : ''}.`;
      if (draft.addParticipantNames.length > 0) base += ` Участники: ${draft.addParticipantNames.join(', ')}.`;
    } else if (draft.type === 'event_action') {
      const parts = [`Обновил встречу «${draft.targetTitle}».`];
      if (draft.addParticipantNames.length > 0) parts.push(`Добавил: ${draft.addParticipantNames.join(', ')}.`);
      if (draft.removeParticipantNames.length > 0) parts.push(`Убрал: ${draft.removeParticipantNames.join(', ')}.`);
      base = parts.join(' ');
    } else {
      // describeSuccess вызывается только из confirmDraft, а тот — только
      // для action='create'/'update' (chat и action='delete' уходят
      // отдельными ветками в processDraft) — сюда попасть не должны, но TS
      // не знает об этом на уровне сигнатур (action='delete' — валидное
      // значение типа, просто недостижимое на практике здесь).
      base = '';
    }
    return base;
  }

  const minutes = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
  const seconds = String(elapsedSec % 60).padStart(2, '0');

  return (
    <div className="voice-screen">
      <div className="voice-header">
        <h1 style={{ margin: '10px 0 4px' }}>Голос</h1>
        {messages.length === 0 && (
          <p className="hint" style={{ marginBottom: 4 }}>
            Продиктуйте задачу или событие — Адъютант сам создаст запись, ничего подтверждать не нужно.
          </p>
        )}
      </div>

      {/* flex:1 + overflow-y:auto — длинная переписка скроллится сама по
          себе, не растягивая всю страницу до бесконечности (владелец
          07.09.2026: страница «тянется в бесконечность» при длинном чате).
          Рендерится всегда, даже пустым — иначе без этого flex:1-соседа
          сфера ниже не прижималась бы к низу экрана при пустом чате. */}
      <div className="voice-chat" ref={chatRef}>
        {messages.map((m) => (
          <div key={m.id} className={`voice-bubble voice-bubble-${m.role} ${m.status ?? ''}`}>
            {m.text}
            {m.pendingAction && (
              <div className="voice-confirm-actions">
                <button type="button" className="btn-secondary btn-small" onClick={() => confirmDelete(m.id, m.pendingAction!)}>
                  Удалить
                </button>
                <button type="button" className="btn-secondary btn-small" onClick={() => cancelDelete(m.id)}>
                  Отмена
                </button>
              </div>
            )}
            {m.undo && (
              <div className="voice-confirm-actions">
                {m.undo.kind === 'task' && (
                  <button type="button" className="btn-secondary btn-small" onClick={() => setOpenTaskId(m.undo!.id)}>
                    Открыть
                  </button>
                )}
                <button type="button" className="btn-secondary btn-small" onClick={() => performUndo(m.id, m.undo!)}>
                  Отменить
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {openTaskId && <TaskDetailOverlay taskId={openTaskId} onClose={() => setOpenTaskId(null)} />}

      <div className="voice-center">
        <div ref={orbRef} className={`voice-orb-wrap ${phase}`}>
          <div className="voice-orb-glow" />
          <div className="voice-orb-ring voice-orb-ring-1" />
          <div className="voice-orb-ring voice-orb-ring-2" />
          <div className="voice-orb-ring voice-orb-ring-3" />
          <button
            className="voice-orb-core"
            onClick={phase === 'recording' ? stopRecording : startRecording}
            disabled={phase === 'processing'}
            aria-label={phase === 'recording' ? 'Остановить запись' : 'Начать запись'}
          >
            {phase === 'recording' ? <Square size={16} strokeWidth={2} /> : <Mic size={20} strokeWidth={2} />}
          </button>
        </div>

        {phase === 'recording' && (
          <p className="mono" style={{ marginTop: 8, fontWeight: 600 }}>
            {minutes}:{seconds}
          </p>
        )}
        {phase === 'processing' && (
          <p className="hint" style={{ marginTop: 8 }}>
            Расшифровываем и извлекаем детали…
          </p>
        )}
        {phase === 'idle' && messages.length === 0 && (
          <p className="hint" style={{ marginTop: 8 }}>
            Нажмите, чтобы начать
          </p>
        )}
        {phase === 'error' && errorMessage && (
          <p className="error" style={{ marginTop: 8, maxWidth: 280, textAlign: 'center' }}>
            {errorMessage}
          </p>
        )}
      </div>
    </div>
  );
}
