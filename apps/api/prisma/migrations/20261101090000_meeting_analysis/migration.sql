-- Поручения из встреч B1: запуск разбора по кнопке и предложенные поручения
-- CreateEnum
CREATE TYPE "MeetingAnalysisStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "MeetingProposalStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "MeetingAnalysisRun" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "requestedById" TEXT,
    "status" "MeetingAnalysisStatus" NOT NULL DEFAULT 'QUEUED',
    "inputHash" TEXT NOT NULL,
    "hadTranscript" BOOLEAN NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "speakerSuggestions" JSONB,
    "error" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "MeetingAnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingProposal" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assigneeId" TEXT,
    "assigneeRawText" TEXT,
    "dueDate" TIMESTAMP(3),
    "priority" "TaskPriority",
    "confidence" "ConfidenceLevel" NOT NULL,
    "sourceContext" TEXT NOT NULL,
    "sourceSegmentId" TEXT,
    "sourceTimestamp" TEXT,
    "similarTaskId" TEXT,
    "status" "MeetingProposalStatus" NOT NULL DEFAULT 'PROPOSED',
    "taskId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeetingAnalysisRun_meetingId_createdAt_idx" ON "MeetingAnalysisRun"("meetingId", "createdAt");

-- CreateIndex
CREATE INDEX "MeetingAnalysisRun_status_createdAt_idx" ON "MeetingAnalysisRun"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingProposal_taskId_key" ON "MeetingProposal"("taskId");

-- CreateIndex
CREATE INDEX "MeetingProposal_meetingId_status_idx" ON "MeetingProposal"("meetingId", "status");

-- CreateIndex
CREATE INDEX "MeetingProposal_runId_idx" ON "MeetingProposal"("runId");

-- AddForeignKey
ALTER TABLE "MeetingAnalysisRun" ADD CONSTRAINT "MeetingAnalysisRun_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingAnalysisRun" ADD CONSTRAINT "MeetingAnalysisRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingProposal" ADD CONSTRAINT "MeetingProposal_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingProposal" ADD CONSTRAINT "MeetingProposal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MeetingAnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingProposal" ADD CONSTRAINT "MeetingProposal_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingProposal" ADD CONSTRAINT "MeetingProposal_sourceSegmentId_fkey" FOREIGN KEY ("sourceSegmentId") REFERENCES "MeetingSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingProposal" ADD CONSTRAINT "MeetingProposal_similarTaskId_fkey" FOREIGN KEY ("similarTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingProposal" ADD CONSTRAINT "MeetingProposal_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingProposal" ADD CONSTRAINT "MeetingProposal_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

