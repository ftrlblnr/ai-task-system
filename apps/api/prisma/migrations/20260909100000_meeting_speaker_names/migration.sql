-- Владелец 09.09.2026: имена спикеров ("Speaker N" -> реальное имя),
-- сопоставление хранится отдельно, enhancedSummary пересчитывается из него.

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "speakerNames" JSONB;
