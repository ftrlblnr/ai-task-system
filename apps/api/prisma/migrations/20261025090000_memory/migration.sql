-- ARMS, фаза 1: долговременная память ассистента и сводка старой переписки.
CREATE TYPE "MemoryKind" AS ENUM ('PREFERENCE', 'FACT', 'PERSON', 'RULE', 'CONTEXT');
CREATE TYPE "MemorySource" AS ENUM ('EXPLICIT', 'SUGGESTED', 'MANUAL');
CREATE TYPE "MemoryStatus" AS ENUM ('ACTIVE', 'PENDING', 'ARCHIVED');

CREATE TABLE "MemoryItem" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "kind" "MemoryKind" NOT NULL,
    "text" TEXT NOT NULL,
    "details" TEXT,
    "source" "MemorySource" NOT NULL,
    "status" "MemoryStatus" NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "sourceKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MemoryItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MemoryItem_sourceKey_key" ON "MemoryItem"("sourceKey");
CREATE INDEX "MemoryItem_ownerId_status_idx" ON "MemoryItem"("ownerId", "status");
ALTER TABLE "MemoryItem" ADD CONSTRAINT "MemoryItem_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MemoryScanState" (
    "ownerId" TEXT NOT NULL,
    "scannedUpTo" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MemoryScanState_pkey" PRIMARY KEY ("ownerId")
);

ALTER TABLE "Conversation" ADD COLUMN "summary" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "summaryUpToAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "summaryUpdatedAt" TIMESTAMP(3);

-- Запись кэша с TTL 1 час — для оценки стоимости на экране «Расход ИИ».
ALTER TABLE "AiCall" ADD COLUMN "cacheWrite1hTokens" INTEGER;
