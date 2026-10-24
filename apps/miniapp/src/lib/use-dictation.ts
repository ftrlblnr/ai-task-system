import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { LiveTranscriber, prefetchLiveTranscription } from './live-transcription';

// Надиктовать текст: запись в браузере → POST <endpoint> (Whisper) → текст.
// Тот же MediaRecorder-флоу и формулировки ошибок, что у голоса в
// assistant/page.tsx; распознанный текст отдаётся в onText, дальше его
// можно поправить руками перед отправкой.
// Зеркало apps/web/src/lib/use-dictation.ts (Mini App — лист ответа приёмной, M4).
const MAX_DURATION_MS = 120_000;
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export type DictationPhase = 'idle' | 'recording' | 'processing';

// fields — дополнительные поля формы (например, requestId приёмной: вопрос
// служит контекстом, когда сервер приводит надиктованное к аккуратному тексту).
export function useDictation(endpoint: string, onText: (text: string) => void, fields?: Record<string, string>) {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Живая расшифровка во время записи (владелец 24.10.2026) — только
  // предпросмотр; в поле ответа уходит текст из endpoint, как и раньше.
  const [liveText, setLiveText] = useState('');
  const transcriberRef = useRef<LiveTranscriber | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timersRef = useRef<{ tick: ReturnType<typeof setInterval> | null; stop: ReturnType<typeof setTimeout> | null }>({ tick: null, stop: null });
  const cancelledRef = useRef(false);
  const onTextRef = useRef(onText);
  const fieldsRef = useRef(fields);

  useEffect(() => {
    onTextRef.current = onText;
    fieldsRef.current = fields;
  }, [onText, fields]);

  function clearTimers() {
    if (timersRef.current.tick) clearInterval(timersRef.current.tick);
    if (timersRef.current.stop) clearTimeout(timersRef.current.stop);
    timersRef.current = { tick: null, stop: null };
  }

  // Закрыли диалог посреди записи — микрофон освобождаем, текст не нужен.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      clearTimers();
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
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
      if (name === 'NotAllowedError') setError('Доступ к микрофону запрещён — разрешите его для Telegram в настройках телефона.');
      else if (name === 'NotFoundError') setError('Микрофон не найден на этом устройстве.');
      else setError('Не удалось получить доступ к микрофону.');
      return;
    }
    const mimeType = typeof MediaRecorder !== 'undefined' ? MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) : undefined;
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => void upload(recorder.mimeType || 'audio/webm');
    streamRef.current = stream;
    recorderRef.current = recorder;
    recorder.start();
    setLiveText('');
    transcriberRef.current?.close();
    transcriberRef.current = new LiveTranscriber(setLiveText);
    void transcriberRef.current.start(stream);
    setElapsedSec(0);
    setPhase('recording');
    timersRef.current = {
      tick: setInterval(() => setElapsedSec((s) => s + 1), 1000),
      stop: setTimeout(stop, MAX_DURATION_MS),
    };
  }

  function stop() {
    clearTimers();
    void transcriberRef.current?.finish();
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }

  async function upload(mimeType: string) {
    if (cancelledRef.current) return;
    setPhase('processing');
    try {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
      const formData = new FormData();
      formData.append('audio', blob, `voice.${ext}`);
      for (const [key, value] of Object.entries(fieldsRef.current ?? {})) formData.append(key, value);
      const { text } = await api.postForm<{ text: string }>(endpoint, formData);
      if (cancelledRef.current) return;
      if (text) onTextRef.current(text);
      else setError('Не расслышал ответ — запись пустая или слишком тихая. Проверьте, что выбран нужный микрофон, и скажите ещё раз.');
    } catch (err) {
      if (!cancelledRef.current) setError(err instanceof ApiError ? err.message : 'Не удалось распознать запись.');
    } finally {
      if (!cancelledRef.current) {
        setPhase('idle');
        setLiveText('');
      }
    }
  }

  return { phase, elapsedSec, error, liveText, start, stop };
}
