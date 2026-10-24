import { api } from '@/lib/api';

// Живая расшифровка во время записи голоса (владелец 24.10.2026). Тот же
// микрофонный поток, что пишет MediaRecorder, параллельно уходит по WebRTC в
// OpenAI Realtime (сессия только расшифровки, короткоживущий секрет выдаёт
// POST /voice/live-transcription), и текст появляется по мере речи. Это
// предпросмотр: команду, как и раньше, разбирает POST /voice/parse по записи.
// Любой сбой здесь не мешает записи — просто нет предпросмотра.
// Зеркало apps/miniapp/src/lib/live-transcription.ts.

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
// После «стоп» ждём финальный текст фразы не дольше этого.
const FINAL_WAIT_MS = 1500;

interface SecretResponse {
  clientSecret: string;
}

// Секрет запрашиваем заранее (экран с микрофоном открылся) — это ~0.5 с из
// ~2 с до первого текста. Секрет годен 60 с на подключение, берём с запасом.
const SECRET_FRESH_MS = 40_000;
let prefetched: { promise: Promise<SecretResponse>; at: number } | null = null;

export function prefetchLiveTranscription() {
  if (prefetched && Date.now() - prefetched.at < SECRET_FRESH_MS) return;
  const promise = api.post<SecretResponse>('/voice/live-transcription', {});
  promise.catch(() => undefined);
  prefetched = { promise, at: Date.now() };
}

function takeSecret(): Promise<SecretResponse> {
  const cached = prefetched;
  prefetched = null;
  if (cached && Date.now() - cached.at < SECRET_FRESH_MS) return cached.promise.catch(() => api.post<SecretResponse>('/voice/live-transcription', {}));
  return api.post<SecretResponse>('/voice/live-transcription', {});
}

interface TranscriptionEvent {
  type: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
}

export class LiveTranscriber {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  // Текст по item_id в порядке появления: фразы могут завершаться не по порядку.
  private items = new Map<string, string>();
  private finished = new Set<string>();
  private closed = false;
  private onFinal: (() => void) | null = null;

  constructor(private readonly onText: (text: string) => void) {}

  async start(stream: MediaStream): Promise<void> {
    try {
      const track = stream.getAudioTracks()[0];
      if (!track || typeof RTCPeerConnection === 'undefined') return;
      const { clientSecret } = await takeSecret();
      if (this.closed) return;

      const pc = new RTCPeerConnection();
      this.pc = pc;
      // addTrack (sendrecv), не addTransceiver(sendonly): с sendonly OpenAI
      // соединение принимает, но звук в буфер не попадает (проверено 24.10.2026,
      // input_audio_buffer_commit_empty).
      pc.addTrack(track, stream);
      const channel = pc.createDataChannel('oai-events');
      this.channel = channel;
      channel.onmessage = (e) => this.handle(e.data);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const response = await fetch(REALTIME_CALLS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' },
        body: offer.sdp,
      });
      if (!response.ok) throw new Error(`calls ${response.status}`);
      const answer = await response.text();
      if (this.closed) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (err) {
      console.warn('live transcription unavailable', err);
      this.close();
    }
  }

  // «Стоп»: commit — конец фразы (VAD у модели нет), ждём финальный текст и
  // закрываем соединение.
  async finish(): Promise<void> {
    if (this.closed || !this.channel || this.channel.readyState !== 'open') {
      this.close();
      return;
    }
    this.channel.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FINAL_WAIT_MS);
      this.onFinal = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.close();
  }

  close() {
    this.closed = true;
    this.onFinal = null;
    try {
      this.channel?.close();
      this.pc?.close();
    } catch {
      // Соединение уже закрыто — нечего освобождать.
    }
    this.channel = null;
    this.pc = null;
  }

  private handle(raw: unknown) {
    if (typeof raw !== 'string') return;
    let event: TranscriptionEvent;
    try {
      event = JSON.parse(raw) as TranscriptionEvent;
    } catch {
      return;
    }
    const id = event.item_id;
    if (!id) return;
    if (event.type === 'conversation.item.input_audio_transcription.delta' && event.delta) {
      if (this.finished.has(id)) return;
      this.items.set(id, (this.items.get(id) ?? '') + event.delta);
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      this.items.set(id, event.transcript ?? this.items.get(id) ?? '');
      this.finished.add(id);
      this.onFinal?.();
    } else {
      return;
    }
    this.onText([...this.items.values()].join(' ').replace(/\s+/g, ' ').trim());
  }
}
