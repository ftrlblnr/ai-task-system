-- Владелец 08.09.2026: транскрипт убран из проекта — Plaud уже делает
-- саммари сам. В проде на момент удаления не было ни одной записи Meeting,
-- миграция безопасна.
ALTER TABLE "Meeting" DROP COLUMN "rawTranscript";
ALTER TABLE "Meeting" DROP COLUMN "enhancedTranscript";
