-- CreateEnum
CREATE TYPE "LegalReviewStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "LegalReviewRun" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "conversationId" TEXT,
    "fileId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "focus" TEXT,
    "status" "LegalReviewStatus" NOT NULL DEFAULT 'QUEUED',
    "dedupeKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "result" JSONB,
    "reportFileId" TEXT,
    "findingsCount" INTEGER,
    "unverifiedCount" INTEGER,
    "error" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "LegalReviewRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LegalReviewRun_dedupeKey_key" ON "LegalReviewRun"("dedupeKey");

-- CreateIndex
CREATE INDEX "LegalReviewRun_status_lockedAt_idx" ON "LegalReviewRun"("status", "lockedAt");

-- CreateIndex
CREATE INDEX "LegalReviewRun_employeeId_createdAt_idx" ON "LegalReviewRun"("employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "LegalReviewRun_finishedAt_notifiedAt_idx" ON "LegalReviewRun"("finishedAt", "notifiedAt");

-- AddForeignKey
ALTER TABLE "LegalReviewRun" ADD CONSTRAINT "LegalReviewRun_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

