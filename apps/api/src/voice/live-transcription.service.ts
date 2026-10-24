import { BadGatewayException, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiUsageService, errorText } from '../ai-usage/ai-usage.service';

// Живая расшифровка во время записи голоса (владелец 24.10.2026: «при
// использовании микрофона нет лайв транскрибирования»). Браузер стримит звук
// в OpenAI Realtime по WebRTC и показывает текст по мере речи. Ключ OpenAI в
// браузер не попадает: сервер выдаёт короткоживущий секрет сессии ТОЛЬКО
// расшифровки (type: "transcription" — без модели-собеседника и без tools).
// Это предпросмотр: сама команда, как и раньше, уходит записью в
// POST /voice/parse — пайплайн, точность и откат не меняются.

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
// gpt-live-transcribe — потоковая модель: частичный текст через ~0.5 с,
// VAD не поддерживает (turn_detection: null), конец фразы — commit от клиента.
const DEFAULT_MODEL = 'gpt-live-transcribe';
// Секрет нужен только чтобы подключиться; сама сессия живёт дольше.
const SECRET_TTL_SECONDS = 60;

export interface LiveTranscriptionSecret {
  clientSecret: string;
  expiresAt: number;
  model: string;
}

@Injectable()
export class LiveTranscriptionService {
  private readonly logger = new Logger(LiveTranscriptionService.name);

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly aiUsage?: AiUsageService,
  ) {}

  async createSecret(): Promise<LiveTranscriptionSecret> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    // LIVE_TRANSCRIPTION_ENABLED=false — аварийный выключатель; клиент тогда
    // просто записывает без предпросмотра, как раньше.
    if (!apiKey || this.config.get<string>('LIVE_TRANSCRIPTION_ENABLED') === 'false') {
      throw new ServiceUnavailableException('Живая расшифровка не настроена');
    }
    const model = this.config.get<string>('LIVE_TRANSCRIPTION_MODEL') || DEFAULT_MODEL;
    const t0 = Date.now();
    try {
      const response = await fetch(CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expires_after: { anchor: 'created_at', seconds: SECRET_TTL_SECONDS },
          session: {
            type: 'transcription',
            audio: {
              input: {
                noise_reduction: { type: 'near_field' },
                transcription: { model, languages: ['ru'], delay: 'low' },
                turn_detection: null,
              },
            },
          },
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { value?: string; expires_at?: number };
      if (!data.value) throw new Error('no client secret');
      this.aiUsage?.record({ feature: 'voice.live_transcription', model, latencyMs: Date.now() - t0, ok: true });
      return { clientSecret: data.value, expiresAt: data.expires_at ?? 0, model };
    } catch (err) {
      this.logger.warn(`live transcription secret failed: ${errorText(err)}`);
      this.aiUsage?.record({ feature: 'voice.live_transcription', model, latencyMs: Date.now() - t0, ok: false, error: errorText(err) });
      throw new BadGatewayException('Не удалось запустить живую расшифровку');
    }
  }
}
