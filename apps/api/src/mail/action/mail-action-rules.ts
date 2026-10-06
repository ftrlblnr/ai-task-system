// Почтовый ИИ-агент v2.0 (ТЗ 05.10.2026) — раздел 7/8: группировка действий
// по трём видам согласования (+ отдельная группа для корзины) и правила
// конфликтов/зависимостей между пунктами ОДНОГО плана. Чистые функции без
// DI и без Prisma — тестируются без БД, как meeting-task-extraction.ts.

import { MailActionGroupType, MailActionType } from '@prisma/client';
import { createHash } from 'node:crypto';

// Раздел 7 ТЗ: "Порядок в почте" (архив/папки/флаги/прочитанность),
// "Рабочие объекты" (задачи/вложения/внутренние события/наблюдения),
// "Внешняя отправка" (ответы/переадресация/приглашения) — отдельная кнопка,
// и Корзина — своя явно названная группа (раздел 9: не прячем в "Порядок").
export const GROUP_BY_ACTION_TYPE: Record<MailActionType, MailActionGroupType> = {
  ARCHIVE: 'MAILBOX_ORDER',
  MOVE: 'MAILBOX_ORDER',
  CREATE_FOLDER: 'MAILBOX_ORDER',
  SET_READ: 'MAILBOX_ORDER',
  SET_UNREAD: 'MAILBOX_ORDER',
  FLAG: 'MAILBOX_ORDER',
  UNFLAG: 'MAILBOX_ORDER',
  TRASH: 'TRASH',
  CREATE_TASK: 'WORK_OBJECTS',
  SAVE_ATTACHMENT: 'WORK_OBJECTS',
  DRAFT_REPLY: 'WORK_OBJECTS',
  CREATE_EVENT: 'WORK_OBJECTS',
  WATCH_REPLY: 'WORK_OBJECTS',
  WATCH_COMMITMENT: 'WORK_OBJECTS',
  DRAFT_REMINDER: 'WORK_OBJECTS',
  SEND_REPLY: 'EXTERNAL_SEND',
  FORWARD: 'EXTERNAL_SEND',
  PROPOSE_MEETING: 'EXTERNAL_SEND',
};

// Раздел 8 ТЗ — терминальные перемещения письма: взаимоисключающие,
// максимум одно на письмо в рамках одного плана.
const TERMINAL_MOVE_TYPES: ReadonlySet<MailActionType> = new Set(['ARCHIVE', 'MOVE', 'TRASH']);

export interface MailActionCandidateItem {
  // Идентификатор внутри плана, используется только для ссылок между
  // пунктами (dependsOnItemIds) и в отчёте о конфликтах — не Prisma id,
  // элементы ещё могут не быть сохранены при валидации черновика плана.
  localId: string;
  type: MailActionType;
  stableObjectIds: string[];
  dependsOnItemIds: string[];
}

export interface MailActionConflict {
  // 'TERMINAL_MOVE' — второй архив/перемещение/корзина на то же письмо.
  // 'FLAG_STATE' — SET_READ×SET_UNREAD или FLAG×UNFLAG на то же письмо.
  // 'MISSING_DEPENDENCY' — dependsOnItemIds ссылается на localId, которого нет в плане.
  // 'DEPENDENCY_CYCLE' — зависимости образуют цикл (CREATE_FOLDER↔MOVE и т.п.).
  code: 'TERMINAL_MOVE' | 'FLAG_STATE' | 'MISSING_DEPENDENCY' | 'DEPENDENCY_CYCLE';
  itemLocalIds: string[];
  stableObjectId?: string;
}

const FLAG_STATE_OPPOSITES: Partial<Record<MailActionType, MailActionType>> = {
  SET_READ: 'SET_UNREAD',
  SET_UNREAD: 'SET_READ',
  FLAG: 'UNFLAG',
  UNFLAG: 'FLAG',
};

// Раздел 8 ТЗ — проверяет ВСЕ пункты плана целиком (не по одному), чтобы
// найти конфликты между ними до того, как план перейдёт в READY.
export function validateMailActionConflicts(items: MailActionCandidateItem[]): MailActionConflict[] {
  const conflicts: MailActionConflict[] = [];
  const byLocalId = new Map(items.map((i) => [i.localId, i]));

  // Терминальные перемещения и флаг-конфликты — группируем по каждому
  // затронутому stableObjectId независимо (один пункт может затрагивать
  // несколько объектов, например вложение + его письмо).
  const terminalByObject = new Map<string, MailActionCandidateItem[]>();
  const flagByObjectAndType = new Map<string, Map<MailActionType, MailActionCandidateItem[]>>();

  for (const item of items) {
    for (const objectId of item.stableObjectIds) {
      if (TERMINAL_MOVE_TYPES.has(item.type)) {
        const list = terminalByObject.get(objectId) ?? [];
        list.push(item);
        terminalByObject.set(objectId, list);
      }
      if (FLAG_STATE_OPPOSITES[item.type]) {
        const byType = flagByObjectAndType.get(objectId) ?? new Map();
        const list = byType.get(item.type) ?? [];
        list.push(item);
        byType.set(item.type, list);
        flagByObjectAndType.set(objectId, byType);
      }
    }
  }

  for (const [objectId, list] of terminalByObject) {
    if (list.length > 1) {
      conflicts.push({ code: 'TERMINAL_MOVE', itemLocalIds: list.map((i) => i.localId), stableObjectId: objectId });
    }
  }

  for (const [objectId, byType] of flagByObjectAndType) {
    for (const [type, list] of byType) {
      const opposite = FLAG_STATE_OPPOSITES[type];
      // Пара (SET_READ, SET_UNREAD) встречается в этом цикле дважды (раз на
      // каждый тип) — обрабатываем только в одном направлении, иначе
      // конфликт попадёт в результат дважды с переставленными id.
      if (!opposite || type >= opposite) continue;
      const oppositeList = byType.get(opposite);
      if (oppositeList?.length) {
        conflicts.push({
          code: 'FLAG_STATE',
          itemLocalIds: [...list.map((i) => i.localId), ...oppositeList.map((i) => i.localId)],
          stableObjectId: objectId,
        });
      }
    }
  }

  // Зависимости — отсутствующая ссылка и циклы (DFS с цветами).
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(items.map((i) => [i.localId, WHITE]));
  const seenMissing = new Set<string>();

  const visit = (localId: string, stack: string[]): void => {
    color.set(localId, GRAY);
    const item = byLocalId.get(localId);
    for (const depId of item?.dependsOnItemIds ?? []) {
      if (!byLocalId.has(depId)) {
        const key = `${localId}->${depId}`;
        if (!seenMissing.has(key)) {
          seenMissing.add(key);
          conflicts.push({ code: 'MISSING_DEPENDENCY', itemLocalIds: [localId] });
        }
        continue;
      }
      const depColor = color.get(depId);
      if (depColor === GRAY) {
        conflicts.push({ code: 'DEPENDENCY_CYCLE', itemLocalIds: [...stack, localId, depId] });
        continue;
      }
      if (depColor === WHITE) {
        visit(depId, [...stack, localId]);
      }
    }
    color.set(localId, BLACK);
  };

  for (const item of items) {
    if (color.get(item.localId) === WHITE) visit(item.localId, []);
  }

  return conflicts;
}

// Раздел 14 ТЗ — согласие привязано к ТОЧНОМУ набору параметров; любое
// изменение параметров требует нового согласия. Детерминированный хэш по
// типу действия + параметрам (НЕ по stableObjectIds/dependsOn — те сверяются
// отдельно, через version/snapshot).
export function computeMailActionPayloadHash(type: MailActionType, parameters: unknown): string {
  return createHash('sha256').update(JSON.stringify({ type, parameters })).digest('hex');
}

// Раздел 14 ТЗ — хэш ВСЕГО замороженного снимка согласия (не одного
// действия, как computeMailActionPayloadHash выше) — используется, чтобы
// MailActionApproval.payloadHash однозначно привязывал согласие к точному
// набору пунктов/параметров разом.
export function computeSnapshotHash(snapshot: unknown): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

// Раздел 8 ТЗ — порядок исполнения внутри одобренной группы: зависимость
// (например CREATE_FOLDER) должна быть исполнена раньше зависящего от неё
// пункта (MOVE). Вызывающий код уже знает, что цикла нет (прошёл
// validateMailActionConflicts без DEPENDENCY_CYCLE) — здесь это не
// перепроверяется, только сортировка.
export function topoSortMailActionItems<T extends { localId: string; dependsOnItemIds: string[] }>(items: T[]): T[] {
  const byLocalId = new Map(items.map((i) => [i.localId, i]));
  const result: T[] = [];
  const visited = new Set<string>();

  const visit = (item: T): void => {
    if (visited.has(item.localId)) return;
    visited.add(item.localId);
    for (const depId of item.dependsOnItemIds) {
      const dep = byLocalId.get(depId);
      if (dep) visit(dep);
    }
    result.push(item);
  };

  for (const item of items) visit(item);
  return result;
}
