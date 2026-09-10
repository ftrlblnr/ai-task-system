-- Аудит 10.09.2026, п. 2.2: parentTaskId был ON DELETE SET NULL (дефолт
-- Prisma для необязательной связи) — удаление родительской задачи не
-- удаляло подзадачи, а осиротевало их в общий список/канбан как
-- самостоятельные задачи. Меняем на CASCADE: удаление задачи удаляет и её
-- подзадачи, тем же способом, что TaskComment/TaskAttachment/TaskHistory.
ALTER TABLE "Task" DROP CONSTRAINT "Task_parentTaskId_fkey";
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
