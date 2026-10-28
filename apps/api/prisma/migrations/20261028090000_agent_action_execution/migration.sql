-- Единый агент A2: защита от повторов изменений задач из чата и разговор карточки для «Отменено.»
-- CreateEnum
CREATE TYPE "AgentActionStatus" AS ENUM ('CLAIMED', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "UndoRecord" ADD COLUMN     "conversationId" TEXT;

-- CreateTable
CREATE TABLE "AgentActionExecution" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "status" "AgentActionStatus" NOT NULL DEFAULT 'CLAIMED',
    "resultJson" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentActionExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentActionExecution_conversationId_dedupeKey_key" ON "AgentActionExecution"("conversationId", "dedupeKey");

