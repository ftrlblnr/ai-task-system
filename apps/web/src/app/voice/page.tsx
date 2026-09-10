'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mic, Square } from 'lucide-react';
import type {
  EventRevertPayload,
  LogVoiceMessageInput,
  MeetingDetail,
  TaskRevertPayload,
  VoiceActionResult,
  VoiceEventActionDraft,
  VoiceParseResponse,
  VoiceTaskActionDraft,
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
  // Undo (аудит 10.09.2026, п. 4.2) — после голосового создания/правки
  // сообщение "Создал задачу «X»" раньше было тупиком: нет ссылки, нет
  // отмены. Активно ~30 секунд после действия (см. UNDO_WINDOW_MS), потом
  // само гаснет — таймер в renderResult. Удаление не даёт undo (см.
  // buildUndo ниже) — откат удаления означал бы полное восстановление
  // задачи/встречи со всеми комментариями/подзадачами/участниками, это
  // отдельная, более тяжёлая фича, не часть этого захода.
  undo?: UndoInfo | null;
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
    // Обрубленное pending-сообщение теоретически возможно только из
    // localStorage, сохранённого до перехода на серверное исполнение
    // (аудит 10.09.2026, п. 2.11) — новый код 'pending' больше не пишет,
    // это защита от старых данных, а не текущий путь.
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
  const router = useRouter();
  // Диктовка со страницы встречи (владелец 09.09.2026, /voice?meetingId=...)
  // — саммари этой встречи передаётся Claude как контекст, а созданная
  // задача получает sourceMeetingId (см. VoiceService.attachSourceMeeting
  // на бэкенде — выполняется уже там, не здесь).
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

  // Память диалога (аудит 10.09.2026, п. 2.9) — сервер сам пишет реплику
  // пользователя (транскрипт) в VoiceService.parse; финальный текст ответа
  // ассистента пишем здесь, в момент, когда он становится окончательным.
  // Fire-and-forget — сбой логирования истории не должен мешать самому чату.
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
    try {
      const actualMimeType = recorderRef.current?.mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: actualMimeType });
      const ext = actualMimeType.includes('mp4') ? 'm4a' : actualMimeType.includes('ogg') ? 'ogg' : 'webm';
      const formData = new FormData();
      formData.append('audio', blob, `voice.${ext}`);
      if (meetingId) formData.append('meetingId', meetingId);

      // Сервер уже выполнил все действия к моменту ответа (аудит
      // 10.09.2026, п. 2.11 — раньше /voice/parse только возвращал
      // черновик, а создание/правку/удаление отдельным запросом делал
      // фронтенд; при потере сети между ними Whisper+Claude были уже
      // оплачены, а задача не создана). Здесь только рендерим итог.
      const result = await api.postForm<VoiceParseResponse>('/voice/parse', formData);
      setPhase('idle');

      pushMessage({ id: crypto.randomUUID(), role: 'user', text: result.transcript });

      // results — массив, не один элемент (владелец 10.09.2026, найдено в
      // проде: "удали встречу с Петром и создай новую на пятницу" в одной
      // заметке — выполнилось только удаление, создание терялось). Каждый
      // элемент уже содержит исход выполнения — просто рендерим по порядку.
      for (const item of result.results) {
        renderResult(item);
      }

      // Общая оценка неуверенности на весь транскрипт целиком (не про
      // конкретное действие — те уже объяснены каждое в своём баббле выше).
      if (result.clarificationNeeded && result.clarificationReason) {
        pushMessage({ id: crypto.randomUUID(), role: 'assistant', text: result.clarificationReason });
        logAssistant(result.clarificationReason);
      }
    } catch (err) {
      setPhase('error');
      const msg = err instanceof ApiError ? err.message : 'Не удалось обработать голосовое сообщение.';
      setErrorMessage(msg);
      pushMessage({ id: crypto.randomUUID(), role: 'assistant', text: msg, status: 'error' });
    }
  }

  // Один элемент result.results → одна реплика ассистента в чате. Действие
  // (если это не chat) сервер уже выполнил — здесь только текст, undo и
  // необязательное "Открыть".
  function renderResult(item: VoiceActionResult) {
    if (item.type === 'chat') {
      pushMessage({ id: crypto.randomUUID(), role: 'assistant', text: item.reply });
      logAssistant(item.reply);
      return;
    }

    const text = item.ok ? describeOutcome(item.draft) : `Не получилось выполнить: ${item.error}`;
    const undo = item.ok ? buildUndo(item) : null;
    const messageId = crypto.randomUUID();

    pushMessage({ id: messageId, role: 'assistant', text, status: item.ok ? undefined : 'error', undo });
    logAssistant(text);
    if (undo) {
      setTimeout(() => updateMessage(messageId, { undo: null }), UNDO_WINDOW_MS);
    }
  }

  // create/update дают undo; delete — нет (см. комментарий у ChatMessage.undo).
  function buildUndo(item: VoiceActionResult): UndoInfo | null {
    if (item.type === 'chat') return null;
    if (item.type === 'task_action') {
      if (item.draft.action === 'create' && item.taskId) return { kind: 'task', action: 'create', id: item.taskId };
      if (item.draft.action === 'update' && item.taskId && item.previous) {
        return { kind: 'task', action: 'update', id: item.taskId, previous: item.previous };
      }
      return null;
    }
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

  // "Отменить" в баббле (аудит 10.09.2026, п. 4.2). create — просто удаляет
  // только что созданное; update — откатывает снятые на бэкенде (см.
  // VoiceService.executeTaskAction/executeEventAction) значения тем же
  // PATCH-эндпоинтом плюс инвертирует изменения участников.
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
    } catch (err) {
      const text = `Не получилось отменить: ${err instanceof ApiError ? err.message : 'попробуйте ещё раз'}`;
      pushMessage({ id: crypto.randomUUID(), role: 'assistant', text, status: 'error' });
      logAssistant(text);
    }
  }

  function describeOutcome(draft: VoiceTaskActionDraft | VoiceEventActionDraft): string {
    if (draft.type === 'task_action') {
      if (draft.action === 'create') {
        const parts = [`Создал задачу «${draft.title}».`];
        if (draft.assigneeName) parts.push(`Исполнитель: ${draft.assigneeName}.`);
        if (draft.dueDate) parts.push(`Срок — до ${new Date(draft.dueDate).toLocaleDateString('ru-RU')}.`);
        return parts.join(' ');
      }
      if (draft.action === 'update') return `Обновил задачу «${draft.targetTitle}».`;
      return `Удалил задачу «${draft.targetTitle}».`;
    }
    if (draft.action === 'create') {
      const when = draft.startAt
        ? new Date(draft.startAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
        : '';
      let base = `Создал событие «${draft.title}»${when ? ` на ${when}` : ''}.`;
      if (draft.addParticipantNames.length > 0) base += ` Участники: ${draft.addParticipantNames.join(', ')}.`;
      return base;
    }
    if (draft.action === 'update') {
      const parts = [`Обновил встречу «${draft.targetTitle}».`];
      if (draft.addParticipantNames.length > 0) parts.push(`Добавил: ${draft.addParticipantNames.join(', ')}.`);
      if (draft.removeParticipantNames.length > 0) parts.push(`Убрал: ${draft.removeParticipantNames.join(', ')}.`);
      return parts.join(' ');
    }
    return `Удалил встречу «${draft.targetTitle}».`;
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
            {m.undo && (
              <div className="voice-confirm-actions">
                {m.undo.kind === 'task' && (
                  <button type="button" className="btn-secondary btn-small" onClick={() => router.push(`/tasks/${m.undo!.id}`)}>
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
