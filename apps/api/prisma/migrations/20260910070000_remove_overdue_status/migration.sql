-- Аудит 10.09.2026, п. 2.1: TasksOverdueCron каждые 30 минут переводил в
-- OVERDUE всё с истёкшим dueDate, включая задачи, которые сотрудник уже
-- взял в работу (IN_PROGRESS) — крон перетирал этот статус обратно при
-- следующем прогоне. Хранимый статус OVERDUE убран из схемы совсем,
-- просрочка теперь вычисляется на лету (dueDate < now && status not in
-- DONE/CANCELLED) в TasksService — единственный источник истины вместо
-- прежних двух конкурирующих (крон на бэкенде + isOverdue() на фронте).
--
-- Владелец подтвердил 10.09.2026: все текущие задачи тестовые, задачи с
-- истёкшим сроком (статус OVERDUE) можно просто удалить, не мигрировать
-- обратно в предыдущий статус. Подзадачи таких задач (если есть) удалятся
-- каскадом благодаря предыдущей миграции (20260910060000).
DELETE FROM "Task" WHERE "status" = 'OVERDUE';

-- Postgres не даёт удалить одно значение enum напрямую — пересоздаём тип
-- без OVERDUE и переключаем на него колонку.
ALTER TABLE "Task" ALTER COLUMN "status" DROP DEFAULT;
CREATE TYPE "TaskStatus_new" AS ENUM ('DRAFT', 'NEW', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'RETURNED', 'CANCELLED');
ALTER TABLE "Task" ALTER COLUMN "status" TYPE "TaskStatus_new" USING ("status"::text::"TaskStatus_new");
DROP TYPE "TaskStatus";
ALTER TYPE "TaskStatus_new" RENAME TO "TaskStatus";
ALTER TABLE "Task" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- overdueNotifiedAt: TasksOverdueCron больше не меняет статус, только шлёт
-- Telegram-уведомление один раз (не каждые 30 минут заново) — эта колонка
-- заменяет прежний способ отличать "уже уведомили" от "ещё нет". null —
-- ещё не уведомляли по текущему dueDate; сбрасывается в null при любом
-- изменении dueDate (см. TasksService.update), чтобы уведомление могло
-- сработать заново, если задача снова станет просроченной.
ALTER TABLE "Task" ADD COLUMN "overdueNotifiedAt" TIMESTAMP(3);
