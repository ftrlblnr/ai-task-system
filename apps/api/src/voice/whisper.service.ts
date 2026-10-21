import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';
import { AiUsageService, errorText } from '../ai-usage/ai-usage.service';

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
const STT_MODEL = 'gpt-transcribe';

// keywords: одна строка на термин, без переводов строк и угловых скобок.
function toKeywords(vocabulary: string | undefined): string[] {
  if (!vocabulary) return [];
  return vocabulary
    .split(',')
    .map((t) => t.replace(/[<>\r\n]/g, ' ').trim())
    .filter(Boolean);
}

@Injectable()
export class WhisperService {
  private client: OpenAI | null = null;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly aiUsage?: AiUsageService,
  ) {}

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

  // gpt-transcribe вместо whisper-1 (21.10.2026): на тишине и шуме он
  // возвращает пустую строку, а whisper-1 — «субтитровые» галлюцинации
  // («Редактор субтитров…», «С вами был…»), из-за которых ломался голосовой
  // ответ в приёмной; в среднем ~1,1 с против ~1,8 с на тех же записях.
  //
  // vocabulary (Stage 2, Phase I, "Company/STT vocabulary") — строка
  // CompanyVocabularyService через запятую; gpt-transcribe принимает такой
  // словарь отдельным полем keywords (имена сотрудников, термины компании) —
  // на замере исправил «Мьюлайн» → «Ньюлайн», «веншахтам» → «вентшахтам».
  // Длительность аудио — из usage.seconds (метрика audioDurationMs).
  async transcribe(buffer: Buffer, mimetype: string, originalName: string, vocabulary?: string): Promise<TranscriptionResult> {
    const ext = mimetype.split('/')[1]?.split(';')[0] || 'webm';
    const file = await toFile(buffer, originalName || `voice.${ext}`, { type: mimetype });
    const keywords = toKeywords(vocabulary);
    const started = Date.now();
    let result: OpenAI.Audio.Transcriptions.Transcription;
    try {
      result = await this.getClient().audio.transcriptions.create({
        file,
        model: STT_MODEL,
        languages: ['ru'],
        response_format: 'json',
        ...(keywords.length > 0 ? { keywords } : {}),
      });
    } catch (err) {
      this.aiUsage?.record({ feature: 'stt', model: STT_MODEL, latencyMs: Date.now() - started, ok: false, error: errorText(err) });
      throw err;
    }
    const audioMs = result.usage?.type === 'duration' ? Math.round(result.usage.seconds * 1000) : null;
    this.aiUsage?.record({ feature: 'stt', model: STT_MODEL, latencyMs: Date.now() - started, ok: true, audioMs });
    return { text: result.text, durationMs: audioMs };
  }
}
