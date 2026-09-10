import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';

// STT для голосового режима Mini App (раздел 14.2 ТЗ / «Адъютант»).
// language: 'ru' зафиксирован сознательно, не авто-детект — весь проект
// русскоязычный (UI, ТЗ, комментарии), фиксированный язык даёт Whisper
// точнее и быстрее распознать речь, чем auto-detect.
@Injectable()
export class WhisperService {
  private client: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  // Ленивая инициализация, а не в конструкторе: Nest создаёт провайдеры при
  // старте приложения, поэтому getOrThrow() в конструкторе уронил бы весь
  // API-процесс при отсутствии OPENAI_API_KEY, а не только этот эндпоинт —
  // тот же паттерн, что GoogleOAuthService.newClient(): без ключа отказывает
  // только конкретная функция, а не весь сервер.
  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({ apiKey: this.config.getOrThrow<string>('OPENAI_API_KEY') });
    }
    return this.client;
  }

  async transcribe(buffer: Buffer, mimetype: string, originalName: string): Promise<string> {
    const ext = mimetype.split('/')[1]?.split(';')[0] || 'webm';
    const file = await toFile(buffer, originalName || `voice.${ext}`, { type: mimetype });
    const result = await this.getClient().audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'ru',
    });
    return result.text;
  }
}
