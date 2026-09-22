-- AlterEnum
ALTER TYPE "UndoRecordStatus" ADD VALUE 'PARTIAL';

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "latestSummary" TEXT;
