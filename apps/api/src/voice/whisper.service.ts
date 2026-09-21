import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';

// Результат transcribe() (владелец 15.09.2026, observability-этап
// голосового пайплайна) — text остаётся обязательным полем, durationMs
// добавлен рядом, а не заменил старый string-контракт, чтобы не менять
// вызывающий код больше, чем нужно для метрики audioDurationMs.
export interface TranscriptionResult {
  text: string;
  durationMs: number | null;
}

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

  // response_format: 'verbose_json' вместо дефолтного 'json' — единственная
  // причина: доступ к result.duration (секунды исходного аудио) для метрики
  // audioDurationMs (observability-этап, владелец 15.09.2026, раздел 2 ТЗ
  // этапа). Whisper-модель и язык распознавания не меняются.
  //
  // prompt (Stage 2, Phase I, внешний аудит 21.09.2026, "Company/STT
  // vocabulary") — необязательная строка-подсказка словаря (имена
  // сотрудников/алиасы/термины компании, см. CompanyVocabularyService) —
  // Whisper API документирует её как способ склонить распознавание в
  // сторону перечисленных слов. Не меняет язык/модель, чисто аддитивная
  // подсказка — при пустой строке API ведёт себя как раньше.
  async transcribe(buffer: Buffer, mimetype: string, originalName: string, prompt?: string): Promise<TranscriptionResult> {
    const ext = mimetype.split('/')[1]?.split(';')[0] || 'webm';
    const file = await toFile(buffer, originalName || `voice.${ext}`, { type: mimetype });
    const result = await this.getClient().audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'ru',
      response_format: 'verbose_json',
      ...(prompt ? { prompt } : {}),
    });
    return {
      text: result.text,
      durationMs: typeof result.duration === 'number' ? Math.round(result.duration * 1000) : null,
    };
  }
}
