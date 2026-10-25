import { Injectable, NotFoundException } from '@nestjs/common';
import { MemoryKind, MemorySource, MemoryStatus, Prisma, type MemoryItem } from '@prisma/client';
import type { MemoryItemView } from '@ai-task-system/shared-types';
import { MEMORY_TEXT_MAX } from './memory-index';
import { PrismaService } from '../prisma/prisma.service';
import { buildMemoryIndex, memorySimilarity, MEMORY_DUPLICATE_THRESHOLD, MEMORY_SIMILAR_THRESHOLD } from './memory-index';

// Память ассистента (ARMS, фаза 1). Все методы — от имени владельца:
// пункт другого сотрудника не виден и не изменяется (404, как несуществующий).
// LLM — не граница безопасности: id из инструментов перепроверяются здесь же.

export const MEMORY_DETAILS_MAX = 2000;
const RECALL_LIMIT = 10;

export function toMemoryView(item: MemoryItem): MemoryItemView {
  return {
    id: item.id,
    kind: item.kind,
    text: item.text,
    details: item.details,
    source: item.source,
    status: item.status,
    pinned: item.pinned,
    useCount: item.useCount,
    lastUsedAt: item.lastUsedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MEMORY_TEXT_MAX);
}

export interface RememberResult {
  item: MemoryItem;
  duplicate: boolean;
  replaced: MemoryItem | null;
  similar: MemoryItem[];
}

@Injectable()
export class MemoryService {
  constructor(private readonly prisma: PrismaService) {}

  list(ownerId: string, filter: { status?: MemoryStatus; q?: string } = {}): Promise<MemoryItem[]> {
    const q = filter.q?.trim();
    return this.prisma.memoryItem.findMany({
      where: {
        ownerId,
        ...(filter.status ? { status: filter.status } : {}),
        ...(q ? { OR: [{ text: { contains: q, mode: 'insensitive' } }, { details: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
    });
  }

  countActive(ownerId: string): Promise<number> {
    return this.prisma.memoryItem.count({ where: { ownerId, status: MemoryStatus.ACTIVE } });
  }

  private async findOwned(ownerId: string, id: string): Promise<MemoryItem> {
    const item = await this.prisma.memoryItem.findUnique({ where: { id } });
    if (!item || item.ownerId !== ownerId) throw new NotFoundException('Пункт памяти не найден');
    return item;
  }

  create(ownerId: string, input: { kind: MemoryKind; text: string; details?: string }): Promise<MemoryItem> {
    return this.prisma.memoryItem.create({
      data: {
        ownerId,
        kind: input.kind,
        text: cleanText(input.text),
        details: input.details?.trim().slice(0, MEMORY_DETAILS_MAX) || null,
        source: MemorySource.MANUAL,
        status: MemoryStatus.ACTIVE,
      },
    });
  }

  async update(
    ownerId: string,
    id: string,
    patch: { kind?: MemoryKind; text?: string; details?: string | null; pinned?: boolean; status?: 'ACTIVE' | 'ARCHIVED' },
  ): Promise<MemoryItem> {
    await this.findOwned(ownerId, id);
    return this.prisma.memoryItem.update({
      where: { id },
      data: {
        ...(patch.kind ? { kind: patch.kind } : {}),
        ...(patch.text !== undefined ? { text: cleanText(patch.text) } : {}),
        ...(patch.details !== undefined ? { details: patch.details?.trim().slice(0, MEMORY_DETAILS_MAX) || null } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        ...(patch.status ? { status: patch.status } : {}),
      },
    });
  }

  async remove(ownerId: string, id: string): Promise<void> {
    await this.findOwned(ownerId, id);
    await this.prisma.memoryItem.delete({ where: { id } });
  }

  // Предложение ИИ: принять — в память, отклонить — в архив (не предлагать
  // повторно: memory-suggest сверяет новые предложения и с архивом).
  async decide(ownerId: string, id: string, accept: boolean): Promise<MemoryItem> {
    const item = await this.findOwned(ownerId, id);
    if (item.status !== MemoryStatus.PENDING) return item;
    return this.prisma.memoryItem.update({ where: { id }, data: { status: accept ? MemoryStatus.ACTIVE : MemoryStatus.ARCHIVED } });
  }

  async buildIndex(ownerId: string): Promise<string | null> {
    const items = await this.prisma.memoryItem.findMany({
      where: { ownerId, status: MemoryStatus.ACTIVE },
      select: { id: true, kind: true, text: true, pinned: true, lastUsedAt: true, createdAt: true },
    });
    return buildMemoryIndex(items);
  }

  // Инструмент remember. sourceKey — идемпотентность повтора того же ответа.
  // Почти такой же активный пункт уже есть — не дублируем, возвращаем его;
  // похожие — модели как кандидаты на замену (аналог /calibrate из видео).
  async remember(
    ownerId: string,
    input: { kind: MemoryKind; text: string; details?: string; replacesId?: string },
    sourceKey: string,
  ): Promise<RememberResult> {
    const existingByKey = await this.prisma.memoryItem.findUnique({ where: { sourceKey } });
    if (existingByKey) {
      if (existingByKey.ownerId !== ownerId) throw new NotFoundException('Пункт памяти не найден');
      return { item: existingByKey, duplicate: false, replaced: null, similar: [] };
    }
    const text = cleanText(input.text);
    const replaced = input.replacesId ? await this.findOwned(ownerId, input.replacesId) : null;

    const active = await this.prisma.memoryItem.findMany({ where: { ownerId, status: MemoryStatus.ACTIVE } });
    const scored = active
      .filter((m) => m.id !== replaced?.id)
      .map((m) => ({ m, score: memorySimilarity(text, m.text) }))
      .sort((a, b) => b.score - a.score);
    const duplicate = scored.find((s) => s.score >= MEMORY_DUPLICATE_THRESHOLD);
    if (duplicate && !replaced) {
      return { item: duplicate.m, duplicate: true, replaced: null, similar: [] };
    }

    let item: MemoryItem;
    try {
      item = await this.prisma.$transaction(async (tx) => {
        if (replaced) await tx.memoryItem.update({ where: { id: replaced.id }, data: { status: MemoryStatus.ARCHIVED } });
        return tx.memoryItem.create({
          data: {
            ownerId,
            kind: input.kind,
            text,
            details: input.details?.trim().slice(0, MEMORY_DETAILS_MAX) || null,
            source: MemorySource.EXPLICIT,
            status: MemoryStatus.ACTIVE,
            pinned: replaced?.pinned ?? false,
            sourceKey,
          },
        });
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const raced = await this.prisma.memoryItem.findUnique({ where: { sourceKey } });
      if (!raced || raced.ownerId !== ownerId) throw err;
      return { item: raced, duplicate: false, replaced: null, similar: [] };
    }
    const similar = scored.filter((s) => s.score >= MEMORY_SIMILAR_THRESHOLD && s.score < MEMORY_DUPLICATE_THRESHOLD).slice(0, 3).map((s) => s.m);
    return { item, duplicate: false, replaced, similar };
  }

  // Инструмент recall_memory: детали, которых нет в индексе. Найденное
  // считается использованным — поднимается в индексе выше.
  async recall(ownerId: string, query: string): Promise<{ items: MemoryItem[]; totalCount: number }> {
    const words = query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .slice(0, 6);
    if (words.length === 0) return { items: [], totalCount: 0 };
    const where: Prisma.MemoryItemWhereInput = {
      ownerId,
      status: MemoryStatus.ACTIVE,
      OR: words.flatMap((w) => [{ text: { contains: w, mode: 'insensitive' as const } }, { details: { contains: w, mode: 'insensitive' as const } }]),
    };
    const [items, totalCount] = await Promise.all([
      this.prisma.memoryItem.findMany({ where, orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }], take: RECALL_LIMIT }),
      this.prisma.memoryItem.count({ where }),
    ]);
    if (items.length > 0) {
      await this.prisma.memoryItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { useCount: { increment: 1 }, lastUsedAt: new Date() } });
    }
    return { items, totalCount };
  }

  // Инструмент forget_memory: в архив, не удаление — пункт можно вернуть
  // на странице «Память». Повтор безопасен.
  async forget(ownerId: string, id: string): Promise<MemoryItem> {
    const item = await this.findOwned(ownerId, id);
    if (item.status === MemoryStatus.ARCHIVED) return item;
    return this.prisma.memoryItem.update({ where: { id }, data: { status: MemoryStatus.ARCHIVED } });
  }
}
