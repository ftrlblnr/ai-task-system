'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import type {
  ConversationMessage,
  VoiceActionResult,
  VoiceParseResponse,
  VoiceUndoInput,
  VoiceUndoResponse,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { haptic, notificationHaptic } from '@/lib/telegram';
import { LiveVoiceClient, type LiveVoicePhase } from '@/lib/live-voice';
import { LiveTranscriber } from '@/lib/live-transcription';
import { newClientRequestId } from './use-assistant-stream';

// Голос ассистента: запись команды (POST /voice/parse) и живой разговор
// (GPT-Live). Вынесено из assistant-screen.tsx (редизайн M5, §4.6) без
// изменения поведения.

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
// Пока идёт живой разговор (GPT-Live), реплики/карточки появляются на сервере
// без участия приложения — лента подтягивается раз в несколько секунд.
const LIVE_POLL_INTERVAL_MS = 2_000;

export type VoicePhase = 'idle' | 'recording' | 'processing';

function pickVoiceMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return VOICE_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

// Undo привязан к конкретной части конкретного assistant-сообщения (не ко
// всему сообщению) — один голосовой ответ может содержать несколько
// независимых действий в одном транскрипте ("удали встречу с Петром и
// создай новую на пятницу"), каждое со своей карточкой и своей кнопкой
// "Отменить".
export interface VoiceUndoEntry {
  messageId: string;
  partId: string;
  undo: VoiceUndoInput;
}

// Stage 2, Phase H.4 (внешний аудит 21.09.2026, "trusted server-side
// undo") — сервер сам создаёт и хранит запись отката (UndoRecord) сразу
// после мутации; отсюда достаточно взять её id (undoToken), не собирать
// payload из previous/draft самим клиентом (previous больше не приходит
// с сервера вообще, см. VoiceTaskActionResult/VoiceEventActionResult в
// shared-types).
function buildVoiceUndo(item: VoiceActionResult): VoiceUndoInput | null {
  if (item.type === 'chat' || !item.ok || !item.undoToken) return null;
  return { undoToken: item.undoToken };
}

export function formatElapsed(sec: number): string {
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

export function useVoiceRecorder({
  conversationId,
  onMessages,
  onUndone,
}: {
  conversationId: string | null;
  onMessages: (added: ConversationMessage[], conversationId: string | null) => void;
  // После отката — перезагрузить историю (итоговый текст подтверждения пишет сервер).
  onUndone: () => void;
}) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  // Живая расшифровка во время записи (владелец 24.10.2026) — предпросмотр,
  // команду по-прежнему разбирает /voice/parse по записи.
  const [liveTranscript, setLiveTranscript] = useState('');
  const transcriberRef = useRef<LiveTranscriber | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [undos, setUndos] = useState<VoiceUndoEntry[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
      if (tickTimerRef.current) clearInterval(tickTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      transcriberRef.current?.close();
    };
  }, []);

  async function start() {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError') {
        setError(
          'Доступ к микрофону запрещён. Если в браузере разрешение выдано, но не работает — проверьте, что у самого приложения Telegram есть доступ к микрофону в настройках телефона.',
        );
      } else if (name === 'NotFoundError') {
        setError('Микрофон не найден на этом устройстве.');
      } else {
        setError('Не удалось получить доступ к микрофону.');
      }
      return;
    }

    const mimeType = pickVoiceMimeType();
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
    setLiveTranscript('');
    transcriberRef.current?.close();
    transcriberRef.current = new LiveTranscriber(setLiveTranscript);
    void transcriberRef.current.start(stream);

    setElapsedSec(0);
    setPhase('recording');
    tickTimerRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    autoStopTimerRef.current = setTimeout(() => stop(), MAX_VOICE_DURATION_MS);
  }

  function stop() {
    if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
    if (tickTimerRef.current) clearInterval(tickTimerRef.current);
    autoStopTimerRef.current = null;
    tickTimerRef.current = null;
    // Финальный текст фразы приходит после commit — пока идёт разбор записи.
    void transcriberRef.current?.finish();
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }

  // По остановке записи — POST /voice/parse (multipart), затем
  // userMessage/assistantMessage из ответа добавляются в ту же ленту, что и
  // обычная текстовая отправка (Stage 2, Phase H) — тем же
  // MessagePartsList, без отдельного рендер-пути для голоса. results[i]
  // и assistantMessage.parts[i] идут в одном порядке (см.
  // buildVoiceAssistantParts на бэкенде) — зипуем по индексу, чтобы прицепить
  // временную (не персистентную — как и раньше) кнопку "Отменить" к нужной
  // части. clientRequestId (Stage 2, Phase H.1, аудит 20.09.2026, P0) —
  // защита от повторного выполнения действия, если сеть оборвалась после
  // того, как сервер уже выполнил мутацию, но до того, как ответ дошёл
  // сюда (см. VoiceService.parse).
  async function handleStop() {
    setPhase('processing');
    haptic('light');
    try {
      const actualMimeType = recorderRef.current?.mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: actualMimeType });
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
        onMessages([userMessage, assistantMessage], response.conversationId);

        const newUndos: VoiceUndoEntry[] = [];
        response.results.forEach((item, i) => {
          const undo = buildVoiceUndo(item);
          const part = assistantMessage.parts[i];
          if (undo && part) newUndos.push({ messageId: assistantMessage.id, partId: part.id, undo });
        });
        if (newUndos.length > 0) {
          setUndos((prev) => [...prev, ...newUndos]);
          setTimeout(() => {
            setUndos((prev) => prev.filter((u) => !newUndos.includes(u)));
          }, VOICE_UNDO_WINDOW_MS);
        }
      }
      notificationHaptic(response.results.every((r) => r.type === 'chat' || r.ok) ? 'success' : 'error');
    } catch (err) {
      notificationHaptic('error');
      setError(err instanceof ApiError ? err.message : 'Не удалось обработать голосовое сообщение.');
    } finally {
      setPhase('idle');
      setLiveTranscript('');
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
  // следующей загрузке — onUndone её подтягивает.
  async function undo(entry: VoiceUndoEntry) {
    setUndos((prev) => prev.filter((u) => u !== entry));
    try {
      const response = await api.post<VoiceUndoResponse>('/voice/undo', entry.undo);
      notificationHaptic(response.ok ? 'success' : 'error');
    } catch {
      notificationHaptic('error');
    } finally {
      onUndone();
    }
  }

  return { phase, liveTranscript, error, elapsedSec, undos, start, stop, undo };
}

// Stage 2, Phase Q — живой голос (GPT-Live по WebRTC). Кнопка видна, только
// если бэкенд включил фичу (GET /live/status). Backend общий с Web.
export function useLiveVoice({
  conversationIdRef,
  refresh,
}: {
  conversationIdRef: RefObject<string | null>;
  // Стабильная функция тихой подтяжки ленты (useAssistantStream).
  refresh: () => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [phase, setPhase] = useState<LiveVoicePhase>('idle');
  const [caption, setCaption] = useState<{ who: 'user' | 'assistant'; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<LiveVoiceClient | null>(null);

  useEffect(() => {
    api
      .get<{ enabled: boolean }>('/live/status')
      .then((s) => setEnabled(s.enabled))
      .catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    if (phase !== 'live') return;
    const timer = setInterval(refresh, LIVE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [phase, refresh]);

  useEffect(() => {
    return () => {
      void clientRef.current?.stop();
    };
  }, []);

  function start() {
    haptic('medium');
    setError(null);
    setCaption(null);
    if (!clientRef.current) {
      clientRef.current = new LiveVoiceClient({
        onPhase: (next) => {
          setPhase(next);
          // Финальная подтяжка ленты после завершения разговора.
          if (next === 'idle') refresh();
        },
        onCaption: (who, delta) =>
          setCaption((prev) => (prev && prev.who === who ? { who, text: (prev.text + delta).slice(-200) } : { who, text: delta })),
        onError: (message) => {
          notificationHaptic('error');
          setError(message);
        },
      });
    }
    void clientRef.current.start(conversationIdRef.current);
  }

  function stop() {
    haptic('light');
    void clientRef.current?.stop();
  }

  return { enabled, phase, caption, error, active: phase !== 'idle', start, stop };
}
