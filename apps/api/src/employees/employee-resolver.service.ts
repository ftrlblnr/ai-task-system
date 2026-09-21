import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface EmployeeCandidate {
  id: string;
  fullName: string;
}

export type EmployeeResolutionStatus = 'RESOLVED' | 'AMBIGUOUS' | 'NOT_FOUND';

export interface EmployeeResolution {
  status: EmployeeResolutionStatus;
  employeeId: string | null;
}

// Отдельная экспортируемая функция, не метод класса — EmployeesService
// использует её же при сохранении EmployeeAlias.normalizedAlias (иначе
// пришлось бы либо дублировать нормализацию, либо тянуть DI-зависимость
// от EmployeeResolverService только ради чистой функции).
export function normalizeAliasText(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[.,!?"'«»]/g, '')
    .replace(/\s+/g, ' ');
}

// Stage 2, Phase I (внешний аудит 21.09.2026, "Employee Resolver") —
// раньше assigneeId целиком доверялся тому, что вернула модель из
// показанного ей списка сотрудников: если модель ошибалась или
// возвращала несуществующий id, VoiceService.validateReferences тихо
// превращал его в null, и задача создавалась БЕЗ исполнителя, хотя
// пользователь явно назвал имя. Этот сервис — независимая от LLM
// проверка: по буквальному тексту имени (assigneeRawText, см.
// draft-extraction.service.ts) ищет сотрудника среди РЕАЛЬНО ВИДИМЫХ
// пользователю кандидатов (тот же список, что уже показан модели —
// resolve не расширяет видимость сам по себе).
//
// Морфология — не полноценный морфологический анализатор (для этого
// понадобилась бы отдельная библиотека уровня pymorphy2, которой в этом
// проекте нет), а прагматичная эвристика: общий ПРЕФИКС двух слов вместо
// попытки угадать и срезать конкретное падежное окончание. Падежные
// окончания в русском — всегда суффиксы, поэтому неизменная часть слова
// (морфологический корень+основа) всегда является общим началом всех
// падежных форм: "Амир"/"Амиру"/"Амиром" общий префикс "амир", "Алексей"/
// "Алексею" общий префикс "алексе". Свободный от угадывания конкретного
// суффикса подход — попытка сначала завести куратируемый список типичных
// окончаний ("а","у","ом","ей" и т.п.) ломается ровно на таких словах:
// суффикс, срезанный с одной формы, не совпадает с суффиксом, срезанным
// с другой (например, "Алексей" теряет "ей" по списку, а "Алексею" теряет
// только "ю" — разные остатки), либо суффикс совпадает с окончанием самой
// основы (фамилии на "-ов"/"-ев" — эта часть основы, не падежное
// окончание). Общий префикс с ограничением на длину "хвоста" (не длиннее
// 3 символов — падежные окончания русских имён/фамилий length ≤3) не
// подвержен этой асимметрии. При осечке (нестандартное окончание,
// иностранное имя и т.п.) резолвер просто вернёт NOT_FOUND/AMBIGUOUS, что
// приводит к уточняющему вопросу пользователю — безопасный fallback, не
// молчаливая ошибка.
@Injectable()
export class EmployeeResolverService {
  constructor(private readonly prisma: PrismaService) {}

  normalize(raw: string): string {
    return normalizeAliasText(raw);
  }

  private commonPrefixLength(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  // Слова короче 3 символов не сравниваются эвристически вовсе (слишком
  // велик риск случайного совпадения короткого префикса) — только через
  // точное совпадение (уже проверено раньше в resolve) или явный alias.
  //
  // Находка №6 пятого внешнего аудита (Stage 2, Phase L) — фиксированный
  // допуск "хвост ≤2 символа, разница длин ≤3" был откалиброван на именах
  // длиной 6-7 букв ("Алексей"/"Алексею") и давал реальные ложные
  // срабатывания на коротких словах, где те же 2 символа — существенная
  // доля всей длины: "Ким" (3 буквы) и "Кирилл" (6 букв) имеют общий
  // префикс "ки" (2 буквы) — под старой формулой (prefixLen ≥ minLen-2 = 1)
  // это засчитывалось как совпадение. Допуск теперь масштабируется по
  // длине КОРОТКОГО слова: для 3-4-буквенных слов требуем, чтобы оно
  // целиком было префиксом более длинного (без хвоста вообще), для 5-6 —
  // хвост ≤1, для 7+ — прежний хвост ≤2 (поведение для длинных имён не
  // меняется).
  private wordsMatch(a: string, b: string): boolean {
    if (a === b) return true;
    const minLen = Math.min(a.length, b.length);
    if (minLen < 3) return false;
    const prefixLen = this.commonPrefixLength(a, b);
    const maxTail = minLen <= 4 ? 0 : minLen <= 6 ? 1 : 2;
    const maxLenDiff = minLen <= 4 ? 2 : 3;
    return prefixLen >= minLen - maxTail && Math.abs(a.length - b.length) <= maxLenDiff;
  }

  private words(fullName: string): string[] {
    return this.normalize(fullName).split(' ').filter(Boolean);
  }

  // candidates — уже отфильтрованный по видимости список (тот же, что
  // показан модели в draft-extraction.service.ts) — resolve сам НИЧЕГО не
  // запрашивает у Prisma сверх EmployeeAlias, не расширяет набор
  // возможных сотрудников.
  async resolve(rawText: string, candidates: EmployeeCandidate[]): Promise<EmployeeResolution> {
    const normalized = this.normalize(rawText);
    if (!normalized || candidates.length === 0) {
      return { status: 'NOT_FOUND', employeeId: null };
    }
    const candidateIds = candidates.map((c) => c.id);

    // 1. Явные алиасы (ручные/известные короткие формы) — самый надёжный
    // источник, проверяется первым.
    const aliasMatches = await this.prisma.employeeAlias.findMany({
      where: { normalizedAlias: normalized, employeeId: { in: candidateIds } },
      select: { employeeId: true },
    });
    const aliasEmployeeIds = [...new Set(aliasMatches.map((a) => a.employeeId))];
    if (aliasEmployeeIds.length === 1) return { status: 'RESOLVED', employeeId: aliasEmployeeIds[0] };
    if (aliasEmployeeIds.length > 1) return { status: 'AMBIGUOUS', employeeId: null };

    // 2. Точное совпадение с полным именем (после нормализации).
    const exact = candidates.filter((c) => this.normalize(c.fullName) === normalized);
    if (exact.length === 1) return { status: 'RESOLVED', employeeId: exact[0].id };
    if (exact.length > 1) return { status: 'AMBIGUOUS', employeeId: null };

    // 3. Эвристика общего префикса (см. комментарий класса) — каждое
    // слово запроса должно найти соответствие среди слов полного имени
    // кандидата (порядок слов не важен: "Жаксылыкову Жанну" и "Жанна
    // Жаксылыкова" дают те же пары).
    const queryWords = this.words(normalized);
    const fuzzy = candidates.filter((c) => {
      const nameWords = this.words(c.fullName);
      return queryWords.every((qw) => nameWords.some((nw) => this.wordsMatch(qw, nw)));
    });
    if (fuzzy.length === 1) return { status: 'RESOLVED', employeeId: fuzzy[0].id };
    if (fuzzy.length > 1) return { status: 'AMBIGUOUS', employeeId: null };

    return { status: 'NOT_FOUND', employeeId: null };
  }
}
