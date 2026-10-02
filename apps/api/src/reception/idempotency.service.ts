import { createHash } from 'node:crypto';
import { ConflictException, HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// Запрос считается "ещё выполняется" дольше этого порога только если
// предыдущая попытка реально упала между claim'ом и записью результата
// (процесс убит и т.п.) — мутация одного обращения (create/edit/transition)
// не многошаговый процесс, порог короткий (тот же принцип, что
// STALE_TASK_FROM_MEETING_MS в assistant-tools.service.ts, там он тоже
// короткий по той же причине).
const STALE_CLAIM_MS = 30 * 1000;

export interface IdempotentResult<T> {
  statusCode: number;
  body: T;
}

function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

// Раздел 11.5 ТЗ — обобщённая идемпотентность мутирующих HTTP-действий.
// Claim-паттерн (строка создаётся ДО обработчика), тот же принцип, что
// TaskFromMeetingExecution.CLAIMED в assistant-tools.service.ts: второй
// одновременный запрос с тем же ключом не может выполнить side-эффект
// дважды, видит либо "уже выполняется", либо готовый результат.
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(
    actorId: string,
    key: string,
    action: string,
    body: unknown,
    handler: () => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    const bodyHash = hashBody(body);
    let claimId: string;
    try {
      claimId = await this.claim(actorId, key, action, bodyHash);
    } catch (err) {
      if (err instanceof StoredResult) {
        if (err.statusCode >= 200 && err.statusCode < 300) {
          return { statusCode: err.statusCode, body: err.response as T };
        }
        throw new HttpException(err.response as Record<string, unknown>, err.statusCode);
      }
      throw err;
    }

    try {
      const result = await handler();
      await this.complete(claimId, 200, result);
      return { statusCode: 200, body: result };
    } catch (err) {
      if (err instanceof HttpException) {
        const statusCode = err.getStatus();
        if (statusCode >= 400 && statusCode < 500) {
          // Определённая бизнес-ошибка (валидация/конфликт/404) — тоже
          // результат, повтор с тем же ключом должен вернуть её же, а не
          // выполнить обработчик заново.
          const response = err.getResponse();
          await this.complete(claimId, statusCode, response);
        } else {
          // 5xx/инфраструктурная ошибка — не "отравляем" ключ, снимаем
          // claim, чтобы настоящий повтор мог попробовать ещё раз.
          await this.release(claimId);
        }
      } else {
        await this.release(claimId);
      }
      throw err;
    }
  }

  // Возвращает id claimed-строки — либо только что созданной, либо чужой
  // уже завершённой (тогда бросает немедленно, сюда управление не доходит),
  // либо устаревшей чужой claimed (переиспользуем ту же строку).
  private async claim(actorId: string, key: string, action: string, bodyHash: string): Promise<string> {
    try {
      const created = await this.prisma.idempotencyKey.create({ data: { actorId, key, action, bodyHash } });
      return created.id;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
    }

    const existing = await this.prisma.idempotencyKey.findUniqueOrThrow({ where: { actorId_key: { actorId, key } } });
    if (existing.bodyHash !== bodyHash) {
      throw new ConflictException('IDEMPOTENCY_CONFLICT: повтор с тем же ключом, но другим телом запроса');
    }
    if (existing.statusCode !== null) {
      // Готовый результат предыдущей попытки — возвращаем его как есть, не
      // выполняя обработчик снова. Бросаем специальный маркер, который run()
      // перехватывает ниже.
      throw new StoredResult(existing.statusCode, existing.response);
    }
    const ageMs = Date.now() - existing.createdAt.getTime();
    if (ageMs < STALE_CLAIM_MS) {
      throw new ConflictException('IDEMPOTENCY_IN_PROGRESS: предыдущий запрос с этим ключом ещё выполняется');
    }
    // Устаревший claim (процесс упал между claim'ом и записью результата) —
    // переиспользуем ту же строку, свежий createdAt для нового окна STALE_CLAIM_MS.
    await this.prisma.idempotencyKey.update({ where: { id: existing.id }, data: { createdAt: new Date() } });
    return existing.id;
  }

  private async complete(id: string, statusCode: number, response: unknown): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { id },
      data: { statusCode, response: response as Prisma.InputJsonValue, completedAt: new Date() },
    });
  }

  private async release(id: string): Promise<void> {
    await this.prisma.idempotencyKey.delete({ where: { id } }).catch(() => undefined);
  }
}

// Внутренний маркер "результат уже есть, просто отдай его" — не уходит за
// пределы IdempotencyService.run(), оборачивается в нормальный
// IdempotentResult там же.
class StoredResult extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly response: unknown,
  ) {
    super('stored-idempotent-result');
  }
}
