-- Приёмная: ручной порядок очереди, шаблоны ответов, задача вместе с ответом.
ALTER TYPE "ReceptionEventType" ADD VALUE 'REORDERED';

ALTER TABLE "ReceptionRequest" ADD COLUMN "taskId" TEXT;
ALTER TABLE "ReceptionRequest" ADD CONSTRAINT "ReceptionRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ReceptionAnswerTemplate" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReceptionAnswerTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReceptionAnswerTemplate_sortOrder_idx" ON "ReceptionAnswerTemplate"("sortOrder");

-- Стартовый набор — руководитель правит его прямо в карточке ответа.
INSERT INTO "ReceptionAnswerTemplate" ("id", "text", "sortOrder", "updatedAt") VALUES
  ('rat_default_1', 'Согласовано.', 1, CURRENT_TIMESTAMP),
  ('rat_default_2', 'Согласовано, оформляйте.', 2, CURRENT_TIMESTAMP),
  ('rat_default_3', 'Не согласовано.', 3, CURRENT_TIMESTAMP),
  ('rat_default_4', 'Зайдите после обеда.', 4, CURRENT_TIMESTAMP),
  ('rat_default_5', 'Подготовьте служебную записку.', 5, CURRENT_TIMESTAMP),
  ('rat_default_6', 'Обсудим на планёрке.', 6, CURRENT_TIMESTAMP);
