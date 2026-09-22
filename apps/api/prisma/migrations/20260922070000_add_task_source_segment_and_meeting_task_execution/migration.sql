-- CreateEnum
CREATE TYPE "TaskFromMeetingStatus" AS ENUM ('CLAIMED', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "sourceSegmentId" TEXT;

-- CreateTable
CREATE TABLE "TaskFromMeetingExecution" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "TaskFromMeetingStatus" NOT NULL DEFAULT 'CLAIMED',
    "taskId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskFromMeetingExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskFromMeetingExecution_conversationId_dedupeKey_key" ON "TaskFromMeetingExecution"("conversationId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_sourceSegmentId_fkey" FOREIGN KEY ("sourceSegmentId") REFERENCES "MeetingSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskFromMeetingExecution" ADD CONSTRAINT "TaskFromMeetingExecution_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
