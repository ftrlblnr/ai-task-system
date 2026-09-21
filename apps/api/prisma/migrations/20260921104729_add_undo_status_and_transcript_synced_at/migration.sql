-- CreateEnum
CREATE TYPE "UndoRecordStatus" AS ENUM ('AVAILABLE', 'CLAIMED', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "UndoRecord" ADD COLUMN "status" "UndoRecordStatus" NOT NULL DEFAULT 'AVAILABLE';

-- Существующие строки: те, что уже consumedAt IS NOT NULL, были откачены
-- по старой логике (claim=consume) — считаем их COMPLETED, не AVAILABLE
-- (иначе задним числом стали бы повторно доступны для отмены).
UPDATE "UndoRecord" SET "status" = 'COMPLETED' WHERE "consumedAt" IS NOT NULL;

-- AlterTable
ALTER TABLE "PlaudSyncItem" ADD COLUMN "transcriptSyncedAt" TIMESTAMP(3);
