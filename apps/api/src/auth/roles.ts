import { Role } from '@prisma/client';

// Владелец 20.10.2026 — «управляющие» роли: руководитель и администратор
// (правая рука руководителя, весь её функционал, кроме «Стола
// руководителя»). Всё, что раньше было закрыто на OWNER, кроме «Стола»,
// открыто обоим.
export const MANAGER_ROLES: Role[] = [Role.OWNER, Role.ADMIN];

export function isManager(role: Role): boolean {
  return role === Role.OWNER || role === Role.ADMIN;
}
