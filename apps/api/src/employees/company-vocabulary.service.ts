import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Stage 2, Phase I (внешний аудит 21.09.2026, "Company/STT vocabulary") —
// Whisper регулярно ошибается на именах сотрудников и корпоративных/
// проектных терминах, которых не было в его обучающих данных (обычные
// слова, похожие по звучанию, побеждают редкие имена собственные). OpenAI
// Whisper API принимает необязательный `prompt` — короткую строку-подсказку
// словаря, которая склоняет распознавание в сторону перечисленных слов
// (см. WhisperService.transcribe). Здесь строится и кэшируется эта строка:
// имена активных сотрудников + известные алиасы (EmployeeAlias) + короткий
// список терминов компании/проекта.
//
// Кэш, не запрос к БД перед каждым /voice/parse (аудит явно предостерегает
// от этого) — TTL, не событийная инвалидация: имена сотрудников меняются
// редко, отставание в несколько минут не создаёт заметной проблемы, а
// TTL-подход не требует протягивать инвалидацию во все места, где может
// измениться Employee/EmployeeAlias (создание, обновление, добавление
// алиаса) — одна точка (эта), не несколько.
@Injectable()
export class CompanyVocabularyService {
  private cache: { value: string; expiresAt: number } | null = null;

  private static readonly TTL_MS = 10 * 60 * 1000;

  // Хардкод, не отдельная таблица — раздел ТЗ/аудит явно приводит это как
  // короткий фиксированный список (компания, партнёры, IT/BIM/стройка), не
  // то, что часто меняется и нуждается в UI управления, в отличие от
  // сотрудников/алиасов.
  private static readonly STATIC_TERMS = ['GLB', 'Plaud', 'IDAT', 'Revit', 'BIM'];

  // Whisper API документирует лимит prompt ~224 токена. Кириллица кодируется
  // в токены менее эффективно, чем латиница (обычно дороже по токенам на
  // символ) — 400 символов кириллического текста уже приближается к этому
  // пределу с запасом, не впритык.
  private static readonly MAX_LENGTH = 400;

  constructor(private readonly prisma: PrismaService) {}

  async getPrompt(): Promise<string> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.value;
    }
    const value = await this.build();
    this.cache = { value, expiresAt: Date.now() + CompanyVocabularyService.TTL_MS };
    return value;
  }

  private async build(): Promise<string> {
    const [employees, aliases] = await Promise.all([
      this.prisma.employee.findMany({ where: { status: 'ACTIVE' }, select: { fullName: true } }),
      this.prisma.employeeAlias.findMany({ select: { alias: true } }),
    ]);

    const terms = new Set<string>();
    for (const e of employees) terms.add(e.fullName);
    for (const a of aliases) terms.add(a.alias);
    for (const t of CompanyVocabularyService.STATIC_TERMS) terms.add(t);

    let result = '';
    for (const term of terms) {
      const candidate = result ? `${result}, ${term}` : term;
      if (candidate.length > CompanyVocabularyService.MAX_LENGTH) break;
      result = candidate;
    }
    return result;
  }
}
