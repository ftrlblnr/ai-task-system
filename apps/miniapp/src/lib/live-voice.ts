import { api, ApiError } from '@/lib/api';

// Stage 2, Phase Q (roadmap v13 "GPT-Live/WebRTC", 24.09.2026) — клиент живого
// голоса для Telegram Mini App (порт apps/web/src/lib/live-voice.ts — те же
// backend-эндпоинты; дублирование между приложениями — тот же компромисс, что
// у остальных клиентских модулей, общий пакет содержит только типы). Браузер говорит с OpenAI напрямую по WebRTC (аудио + data channel
// "oai-events"), но SDP обменивает НАШ сервер (POST /live/sessions) — ключ
// OpenAI сюда не попадает. Что делать с делегированными запросами
// (tools/данные) — целиком на бэкенде (LiveService → Assistant Core), здесь
// только звук, субтитры и статус.

export type LiveVoicePhase = 'idle' | 'connecting' | 'live' | 'closing';

export interface LiveVoiceCallbacks {
  onPhase: (phase: LiveVoicePhase) => void;
  onCaption: (who: 'user' | 'assistant', delta: string) => void;
  onError: (message: string) => void;
}

interface CreateLiveSessionResponse {
  sessionId: string;
  sdp: string;
}

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError') return 'Доступ к микрофону запрещён — разрешите его в настройках браузера для этого сайта.';
  if (name === 'NotFoundError') return 'Микрофон не найден на этом устройстве.';
  return 'Не удалось получить доступ к микрофону.';
}

// SDP-offer уходит на сервер одним запросом (trickle-ICE сервер не поддерживает),
// поэтому перед отправкой ждём завершения сбора ICE-кандидатов — как в
// официальном примере OpenAI (таймаут 10 с).
const ICE_GATHERING_TIMEOUT_MS = 10_000;

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onState);
      reject(new Error('ice-timeout'));
    }, ICE_GATHERING_TIMEOUT_MS);
    function onState() {
      if (pc.iceGatheringState !== 'complete') return;
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onState);
      resolve();
    }
    pc.addEventListener('icegatheringstatechange', onState);
  });
}

export class LiveVoiceClient {
  private pc: RTCPeerConnection | null = null;
  private events: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private sessionId: string | null = null;
  private phase: LiveVoicePhase = 'idle';
  // Поколение попытки: stop() (и новый start()) увеличивают его, поэтому
  // «поздние» продолжения устаревшего start() — после getUserMedia/ICE/POST —
  // видят, что уже неактуальны, и ничего не делают с текущим состоянием.
  private generation = 0;

  constructor(private readonly callbacks: LiveVoiceCallbacks) {}

  private setPhase(phase: LiveVoicePhase) {
    this.phase = phase;
    this.callbacks.onPhase(phase);
  }

  async start(conversationId: string | null): Promise<void> {
    if (this.phase !== 'idle') return;
    const gen = ++this.generation;
    const isStale = () => gen !== this.generation;
    this.setPhase('connecting');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (isStale()) return;
      this.callbacks.onError(micErrorMessage(err));
      this.teardown();
      return;
    }
    if (isStale()) {
      // Stop нажат, пока ждали разрешение на микрофон — освободить его.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;

    let createdSessionId: string | null = null;
    try {
      const pc = new RTCPeerConnection();
      this.pc = pc;

      const audio = document.createElement('audio');
      audio.autoplay = true;
      // iOS WebView: без playsInline звук может уйти в полноэкранный плеер.
      audio.setAttribute('playsinline', 'true');
      this.audio = audio;
      pc.ontrack = (e) => {
        if (isStale()) return;
        audio.srcObject = e.streams[0];
        // В мобильных WebView autoplay удаётся не всегда — явный play() и
        // понятная ошибка вместо «ассистент молчит».
        void audio.play().catch(() => {
          if (!isStale()) this.callbacks.onError('Не удалось воспроизвести звук ассистента — проверьте, что звук на устройстве включён.');
        });
      };
      pc.onconnectionstatechange = () => {
        if (isStale()) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          if (this.phase === 'live' || this.phase === 'connecting') {
            this.callbacks.onError('Соединение с голосовым ассистентом потеряно.');
            void this.stop();
          }
        }
      };

      for (const track of stream.getTracks()) pc.addTrack(track, stream);

      const events = pc.createDataChannel('oai-events');
      this.events = events;
      events.addEventListener('message', (e) => {
        if (!isStale()) this.onEvent(e.data);
      });

      const offer = await pc.createOffer();
      if (isStale()) return;
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      if (isStale()) return;

      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error('no-local-sdp');
      const created = await api.post<CreateLiveSessionResponse>('/live/sessions', {
        sdp,
        ...(conversationId ? { conversationId } : {}),
      });
      createdSessionId = created.sessionId;

      if (isStale()) {
        // Stop нажат, пока POST был в полёте: серверная сессия уже создана —
        // закрываем её, к закрытому pc ничего не применяем.
        await api.delete(`/live/sessions/${created.sessionId}`).catch(() => undefined);
        return;
      }
      this.sessionId = created.sessionId;
      await pc.setRemoteDescription({ type: 'answer', sdp: created.sdp });
      if (isStale()) {
        await api.delete(`/live/sessions/${created.sessionId}`).catch(() => undefined);
      }
    } catch (err) {
      if (isStale()) {
        if (createdSessionId) await api.delete(`/live/sessions/${createdSessionId}`).catch(() => undefined);
        return;
      }
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error && err.message === 'ice-timeout'
            ? 'Не удалось подготовить соединение (сетевые кандидаты не собраны). Проверьте сеть и попробуйте ещё раз.'
            : 'Не удалось запустить живой голос.';
      this.callbacks.onError(message);
      await this.stop();
    }
  }

  private onEvent(raw: unknown) {
    if (typeof raw !== 'string') return;
    let event: { type?: string; delta?: unknown };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (event.type === 'session.started') {
      this.setPhase('live');
    } else if (event.type === 'session.closed') {
      void this.stop();
    } else if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
      this.callbacks.onCaption('user', event.delta);
    } else if (event.type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
      this.callbacks.onCaption('assistant', event.delta);
    }
  }

  async stop(): Promise<void> {
    if (this.phase === 'idle' || this.phase === 'closing') return;
    // Инвалидируем все ещё не завершённые шаги start() (getUserMedia/ICE/POST).
    this.generation++;
    this.setPhase('closing');
    const sessionId = this.sessionId;
    try {
      if (this.events?.readyState === 'open') this.events.send(JSON.stringify({ type: 'session.close' }));
    } catch {
      // канал уже закрыт — серверный DELETE ниже всё равно закроет сессию
    }
    // UI возвращается в idle сразу (повторный Start работает без ожидания), а
    // серверное закрытие — фоном; поздний ответ POST /live/sessions, если он
    // ещё в полёте, закроет свою сессию сам (см. start()).
    this.teardown();
    if (sessionId) await api.delete(`/live/sessions/${sessionId}`).catch(() => undefined);
  }

  private teardown() {
    this.events?.close();
    this.pc?.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.audio) this.audio.srcObject = null;
    this.events = null;
    this.pc = null;
    this.stream = null;
    this.audio = null;
    this.sessionId = null;
    this.setPhase('idle');
  }
}
