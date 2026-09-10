'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Mic, Square } from 'lucide-react';
import type {
  CalendarEvent,
  CreateEventInput,
  CreateTaskInput,
  MeetingDetail,
  TaskDetail,
  VoiceParseResponse,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { useAuth } from '@/lib/auth-context';

type Phase = 'idle' | 'recording' | 'processing' | 'error';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: 'pending' | 'error';
  // Подтверждение удаления голосом (владелец 09.09.2026) — кнопками в
  // чате, не второй голосовой репликой (см. draft-extraction.service.ts:
  // "да"/"нет" ненадёжно как подтверждение, ещё один шанс на ошибку
  // распознавания поверх уже состоявшейся). Пока не null — ничего не
  // удалено, DELETE вызывается только по клику "Удалить".
  pendingAction?: { kind: 'task' | 'event'; targetId: string; targetTitle: string } | null;
}

// Ограничивает худший случай по стоимости/задержке Whisper+Claude на одну
// голосовую заметку — то же значение, что в apps/miniapp/voice-screen.tsx.
const MAX_DURATION_MS = 100_000;

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

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
    // приватный режим / переполненная квота — переписка просто не переживёт закрытие вкладки
  }
}

// Веб-версия голосового режима apps/miniapp/voice-screen.tsx (раздел 14.2
// ТЗ / Адъютант) — тот же бэкенд (POST /voice/parse), тот же принцип «как в
// чате» без формы ревью (владелец, 01.09.2026). Отличия от Mini App: нет
// Telegram-хаптики (обычный браузер), localStorage вместо sessionStorage
// для истории — веб и так хранит токен в localStorage, а не пересоздаётся
// при каждом открытии, как Mini App.
function VoiceView() {
  const { user } = useAuth();
  const userId = user!.id;
  // Диктовка со страницы встречи (владелец 09.09.2026, /voice?meetingId=...)
  // — саммари этой встречи передаётся Claude как контекст, а созданная
  // задача получает sourceMeetingId (см. confirmDraft ниже).
  const meetingId = useSearchParams().get('meetingId') ?? undefined;
  const [meetingTitle, setMeetingTitle] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadStoredMessages(userId));

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!meetingId) return;
    api
      .get<MeetingDetail>(`/meetings/${meetingId}`)
      .then((m) => setMeetingTitle(m.title))
      .catch(() => setMeetingTitle(null));
  }, [meetingId]);

  // chat.scrollTo(), а не scrollEndRef.scrollIntoView() — то же самое
  // изменение, что и в apps/miniapp/voice-screen.tsx: scrollIntoView()
  // поднимается по всей цепочке скроллируемых предков, а не только по
  // самому известному нам контейнеру — в miniapp это ломало позиционирование
  // свайп-трека, здесь применено ради того же паттерна на будущее.
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
      const amp = sum / data.length / 255;
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
        setErrorMessage('Доступ к микрофону запрещён — разрешите его в настройках браузера для этого сайта.');
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

  function pushMessage(msg: ChatMessage) {
    setMessages((prev) => [...prev, msg]);
  }
  function updateMessage(id: string, patch: Partial<ChatMessage>) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  async function handleStop() {
    setPhase('processing');
    try {
      const actualMimeType = recorderRef.current?.mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: actualMimeType });
      const ext = actualMimeType.includes('mp4') ? 'm4a' : actualMimeType.includes('ogg') ? 'ogg' : 'webm';
      const formData = new FormData();
      formData.append('audio', blob, `voice.${ext}`);
      if (meetingId) formData.append('meetingId', meetingId);

      const result = await api.postForm<VoiceParseResponse>('/voice/parse', formData);
      setPhase('idle');

      pushMessage({ id: crypto.randomUUID(), role: 'user', text: result.transcript });

      // Не всё сказанное — попытка поставить задачу/событие: вопрос,
      // реплика, реакция на прошлый ответ. Раньше на это тоже создавалась
      // задача-заглушка («Уточнить формулировку») — владелец 07.09.2026
      // указал, что ожидал вместо этого живой ответ, а не мусор в списке
      // задач. draft.type === 'chat' — просто реплика, ничего не создаём.
      if (result.draft.type === 'chat') {
        pushMessage({ id: crypto.randomUUID(), role: 'assistant', text: result.draft.reply });
        return;
      }

      // Удаление ничего не удаляет само по себе — только показывает
      // кнопки подтверждения в баббле (владелец 09.09.2026, см. комментарий
      // у ChatMessage.pendingAction).
      if (result.draft.action === 'delete') {
        const draft = result.draft;
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
        text: describeInFlight(result.draft.type, result.draft.action),
        status: 'pending',
      });
      await confirmDraft(result, assistantId);
    } catch (err) {
      setPhase('error');
      const msg = err instanceof ApiError ? err.message : 'Не удалось обработать голосовое сообщение.';
      setErrorMessage(msg);
      pushMessage({ id: crypto.randomUUID(), role: 'assistant', text: msg, status: 'error' });
    }
  }

  // action='delete' сюда не попадает — уходит отдельной веткой в handleStop
  // (см. комментарий у ChatMessage.pendingAction).
  async function confirmDraft(result: VoiceParseResponse, assistantId: string) {
    try {
      const draft = result.draft;
      if (draft.type === 'task_action') {
        if (draft.action === 'create') {
          const payload: CreateTaskInput = {
            title: draft.title,
            description: draft.description || undefined,
            assigneeId: draft.assigneeId || undefined,
            priority: draft.priority || undefined,
            dueDate: draft.dueDate || undefined,
            sourceMeetingId: draft.sourceMeetingId || undefined,
          };
          await api.post<TaskDetail>('/tasks', payload);
        } else {
          const payload: Partial<CreateTaskInput> = {};
          if (draft.title !== '') payload.title = draft.title;
          if (draft.description !== '') payload.description = draft.description;
          if (draft.assigneeId !== null) payload.assigneeId = draft.assigneeId;
          if (draft.dueDate !== null) payload.dueDate = draft.dueDate;
          if (draft.priority !== null) payload.priority = draft.priority;
          await api.patch(`/tasks/${draft.targetTaskId}`, payload);
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
        } else {
          const payload: Partial<CreateEventInput> = {};
          if (draft.title !== '') payload.title = draft.title;
          if (draft.description !== '') payload.description = draft.description;
          if (draft.location !== '') payload.location = draft.location;
          if (draft.startAt !== null) payload.startAt = draft.startAt;
          if (draft.endAt !== null) payload.endAt = draft.endAt;
          if (draft.allDay !== null) payload.allDay = draft.allDay;
          if (Object.keys(payload).length > 0) await api.patch(`/events/${draft.targetEventId}`, payload);
          for (const employeeId of draft.addParticipantIds) {
            await api.post(`/events/${draft.targetEventId}/participants`, { employeeId }).catch(() => {});
          }
          for (const employeeId of draft.removeParticipantIds) {
            await api.delete(`/events/${draft.targetEventId}/participants/${employeeId}`).catch(() => {});
          }
        }
      }
      updateMessage(assistantId, { text: describeSuccess(result), status: undefined });
    } catch (err) {
      updateMessage(assistantId, {
        text: `Не получилось сохранить: ${err instanceof ApiError ? err.message : 'попробуйте ещё раз'}`,
        status: 'error',
      });
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
      updateMessage(messageId, { text: `Удалил «${action.targetTitle}».`, status: undefined });
    } catch (err) {
      updateMessage(messageId, {
        text: `Не получилось удалить: ${err instanceof ApiError ? err.message : 'попробуйте ещё раз'}`,
        status: 'error',
      });
    }
  }

  function cancelDelete(messageId: string) {
    updateMessage(messageId, { text: 'Отменено.', pendingAction: null });
  }

  function describeSuccess(result: VoiceParseResponse): string {
    const { draft } = result;
    let base: string;
    if (draft.type === 'task_action' && draft.action === 'create') {
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
      // отдельными ветками в handleStop) — сюда попасть не должны, но TS
      // не знает об этом на уровне сигнатур.
      base = '';
    }
    if (result.clarificationReason) base += ` ${result.clarificationReason}`;
    return base;
  }

  const minutes = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
  const seconds = String(elapsedSec % 60).padStart(2, '0');

  return (
    <div className="voice-page">
      <div className="voice-header">
        <div className="page-header">
          <h1>Голос</h1>
        </div>
        {messages.length === 0 && (
          <p className="page-subtitle">
            Продиктуйте задачу или событие — Адъютант сам создаст запись, ничего подтверждать не нужно.
          </p>
        )}
        {meetingId && (
          <span className="badge badge-muted" style={{ marginTop: 4 }}>
            Контекст: {meetingTitle ?? 'встреча'}
          </span>
        )}
      </div>

      {/* flex:1 + overflow-y:auto — длинная переписка скроллится сама по
          себе, не растягивая страницу до бесконечности (владелец
          07.09.2026). Рендерится всегда, даже пустым — иначе без этого
          flex:1-соседа сфера ниже не прижималась бы к низу. */}
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
          </div>
        ))}
      </div>

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
          <p className="error" style={{ marginTop: 8, maxWidth: 320, textAlign: 'center' }}>
            {errorMessage}
          </p>
        )}
      </div>
    </div>
  );
}

export default function VoicePage() {
  return (
    <Protected>
      <Suspense fallback={<p className="hint">Загрузка…</p>}>
        <VoiceView />
      </Suspense>
    </Protected>
  );
}
