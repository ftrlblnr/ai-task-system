-- CreateEnum
CREATE TYPE "VoiceExecutionStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'EXECUTING', 'COMPLETED', 'FAILED', 'NEEDS_RECONCILIATION');

-- CreateTable
CREATE TABLE "VoiceExecution" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "status" "VoiceExecutionStatus" NOT NULL DEFAULT 'RECEIVED',
    "resultJson" JSONB,
    "userMessageId" TEXT,
    "assistantMessageId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceExecution_conversationId_clientRequestId_key" ON "VoiceExecution"("conversationId", "clientRequestId");
