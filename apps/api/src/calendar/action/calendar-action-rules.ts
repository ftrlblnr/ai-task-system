import { createHash } from 'node:crypto';
import { CalendarActionType } from '@prisma/client';

// Календарный агент — чистые функции плана/действий, тот же приём, что
// mail/action/mail-action-rules.ts (почтовый агент, этот же проект):
// бизнес-правило тестируется без БД.

export function computeCalendarActionPayloadHash(type: CalendarActionType, parameters: unknown): string {
  return createHash('sha256').update(JSON.stringify({ type, parameters })).digest('hex');
}

export function computeCalendarSnapshotHash(snapshot: unknown): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

// Раздел 13 ТЗ — перенос/правка/отмена чужого организованного события
// недопустима молча; здесь — только порядок исполнения внутри ОДНОГО
// плана по dependsOnActionIds (обычно пустой список — "одиночная встреча"
// не нуждается в зависимостях).
export function topoSortCalendarActions<T extends { localId: string; dependsOnActionIds: string[] }>(actions: T[]): T[] {
  const byLocalId = new Map(actions.map((a) => [a.localId, a]));
  const result: T[] = [];
  const visited = new Set<string>();

  const visit = (action: T): void => {
    if (visited.has(action.localId)) return;
    visited.add(action.localId);
    for (const depId of action.dependsOnActionIds) {
      const dep = byLocalId.get(depId);
      if (dep) visit(dep);
    }
    result.push(action);
  };

  for (const action of actions) visit(action);
  return result;
}
