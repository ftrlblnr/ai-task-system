'use client';

import { useEffect, useRef, useState } from 'react';
import type { ConversationMessage, VoiceActionResult, VoiceParseResponse, VoiceUndoInput, VoiceUndoResponse } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { LiveVoiceClient, type LiveVoicePhase } from '@/lib/live-voice';
import { LiveTranscriber, prefetchLiveTranscription } from '@/lib/live-transcription';
import { newClientRequestId } from './use-assistant-stream';

// Голос ассистента: запись команды (/voice/parse) с живой расшифровкой и
// живой разговор (GPT-Live). Вынесено из app/assistant/page.tsx (W0) без
// изменения поведения.

// Голос — тот же MediaRecorder-флоу и те же (desktop-формулировки, не
// Telegram-специфичные) сообщения об ошибках доступа к микрофону, что уже
// используются в apps/web/src/app/voice/page.tsx.
const MAX_VOICE_DURATION_MS = 100_000;
const VOICE_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
const VOICE_UNDO_WINDOW_MS = 30_000;
// Пока идёт живой разговор (GPT-Live), реплики/карточки появляются на сервере
// без участия браузера — лента подтягивается раз в несколько секунд.
const LIVE_POLL_INTERVAL_MS = 2_000;

function pickVoiceMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return VOICE_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

export interface VoiceUndoEntry {
  messageId: string;
  partId: string;
  undo: VoiceUndoInput;
}

function buildVoiceUndo(item: VoiceActionResult): VoiceUndoInput | null {
  if (item.type === 'chat' || !item.ok || !item.undoToken) return null;
  return { undoToken: item.undoToken };
}

interface RecorderOptions {
  conversationId: string | null;
  onMessages: (userMessage: ConversationMessage, assistantMessage: ConversationMessage) => void;
  // Голосовая команда без открытого разговора — сервер создал новый.
  onConversationCreated: (id: string) => void;
  // После отмены действия — перечитать переписку.
  onUndone: () => void;
}

export function useVoiceRecorder({ conversationId, onMessages, onConversationCreated, onUndone }: RecorderOptions) {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'processing'>('idle');
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

  // Секрет живой расшифровки — заранее, чтобы текст пошёл сразу после «запись».
  useEffect(() => {
    prefetchLiveTranscription();
  }, []);

  async function start() {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError') {
        setError('Доступ к микрофону запрещён — разрешите его в настройках браузера для этого сайта.');
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

  async function handleStop() {
    setPhase('processing');
    try {
      const actualMimeType = recorderRef.current?.mimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: actualMimeType });
      const ext = actualMimeType.includes('mp4') ? 'm4a' : actualMimeType.includes('ogg') ? 'ogg' : 'webm';
      const formData = new FormData();
      formData.append('audio', blob, `voice.${ext}`);
      formData.append('clientRequestId', newClientRequestId());
      if (conversationId) formData.append('conversationId', conversationId);

      const response = await api.postForm<VoiceParseResponse>('/voice/parse', formData);

      if (response.userMessage && response.assistantMessage) {
        const { userMessage, assistantMessage } = response;
        onMessages(userMessage, assistantMessage);
        if (!conversationId && response.conversationId) onConversationCreated(response.conversationId);

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
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось обработать голосовое сообщение.');
    } finally {
      setPhase('idle');
      setLiveTranscript('');
    }
  }

  async function undo(entry: VoiceUndoEntry) {
    setUndos((prev) => prev.filter((u) => u !== entry));
    try {
      await api.post<VoiceUndoResponse>('/voice/undo', entry.undo);
    } finally {
      onUndone();
    }
  }

  return { phase, liveTranscript, error, elapsedSec, undos, start, stop, undo };
}

export type VoiceRecorder = ReturnType<typeof useVoiceRecorder>;

interface LiveOptions {
  // Текущий разговор на момент старта.
  getConversationId: () => string | null;
  refresh: () => void;
}

// Stage 2, Phase Q — живой голос (GPT-Live по WebRTC). Кнопка видна, только
// если бэкенд включил фичу (GET /live/status).
export function useLiveVoice({ getConversationId, refresh }: LiveOptions) {
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
  }, [phase]);

  useEffect(() => {
    return () => {
      void clientRef.current?.stop();
    };
  }, []);

  function start() {
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
          setCaption((prev) => (prev && prev.who === who ? { who, text: (prev.text + delta).slice(-300) } : { who, text: delta })),
        onError: setError,
      });
    }
    void clientRef.current.start(getConversationId());
  }

  function stop() {
    void clientRef.current?.stop();
  }

  return { enabled, phase, active: phase !== 'idle', caption, error, start, stop };
}

export type LiveVoice = ReturnType<typeof useLiveVoice>;
