import { api, ApiError } from '@/lib/api';

// Stage 2, Phase Q (roadmap v13 "GPT-Live/WebRTC", 24.09.2026) — клиент живого
// голоса. Браузер говорит с OpenAI напрямую по WebRTC (аудио + data channel
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

export class LiveVoiceClient {
  private pc: RTCPeerConnection | null = null;
  private events: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private sessionId: string | null = null;
  private phase: LiveVoicePhase = 'idle';

  constructor(private readonly callbacks: LiveVoiceCallbacks) {}

  private setPhase(phase: LiveVoicePhase) {
    this.phase = phase;
    this.callbacks.onPhase(phase);
  }

  async start(conversationId: string | null): Promise<void> {
    if (this.phase !== 'idle') return;
    this.setPhase('connecting');

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      this.callbacks.onError(micErrorMessage(err));
      this.teardown();
      return;
    }

    try {
      const pc = new RTCPeerConnection();
      this.pc = pc;

      const audio = document.createElement('audio');
      audio.autoplay = true;
      this.audio = audio;
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0];
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          if (this.phase === 'live' || this.phase === 'connecting') {
            this.callbacks.onError('Соединение с голосовым ассистентом потеряно.');
            void this.stop();
          }
        }
      };

      for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);

      const events = pc.createDataChannel('oai-events');
      this.events = events;
      events.addEventListener('message', (e) => this.onEvent(e.data));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const created = await api.post<CreateLiveSessionResponse>('/live/sessions', {
        sdp: offer.sdp,
        ...(conversationId ? { conversationId } : {}),
      });
      this.sessionId = created.sessionId;
      await pc.setRemoteDescription({ type: 'answer', sdp: created.sdp });
    } catch (err) {
      this.callbacks.onError(err instanceof ApiError ? err.message : 'Не удалось запустить живой голос.');
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
    this.setPhase('closing');
    const sessionId = this.sessionId;
    try {
      if (this.events?.readyState === 'open') this.events.send(JSON.stringify({ type: 'session.close' }));
    } catch {
      // канал уже закрыт — серверный DELETE ниже всё равно закроет сессию
    }
    if (sessionId) await api.delete(`/live/sessions/${sessionId}`).catch(() => undefined);
    this.teardown();
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
