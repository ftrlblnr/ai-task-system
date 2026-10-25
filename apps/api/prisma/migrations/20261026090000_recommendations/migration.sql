-- CreateEnum
CREATE TYPE "RecommendationArea" AS ENUM ('APPS', 'ROUTINES', 'MEMORY', 'SKILLS');

-- CreateEnum
CREATE TYPE "RecommendationAction" AS ENUM ('CREATE_ROUTINE', 'REVISE_SKILL', 'ADD_MEMORY', 'ARCHIVE_MEMORY', 'DOWNGRADE_SKILL_MODEL', 'SET_ROUTINE_CAP', 'DISABLE_SKILL', 'DEV_TASK');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('NEW', 'IN_CART', 'APPLIED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RecommendationEffort" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "RecommendationBatchStatus" AS ENUM ('GENERATING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "RecommendationBatchTrigger" AS ENUM ('SCHEDULE', 'BUTTON');

-- AlterEnum
ALTER TYPE "SkillRevisionSource" ADD VALUE 'RECOMMENDATION';

-- CreateTable
CREATE TABLE "RecommendationBatch" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "trigger" "RecommendationBatchTrigger" NOT NULL,
    "status" "RecommendationBatchStatus" NOT NULL DEFAULT 'GENERATING',
    "weekKey" TEXT,
    "error" TEXT,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION,
    "lockedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "RecommendationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "area" "RecommendationArea" NOT NULL,
    "action" "RecommendationAction" NOT NULL,
    "title" TEXT NOT NULL,
    "benefit" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "effort" "RecommendationEffort" NOT NULL,
    "priority" INTEGER NOT NULL,
    "tokenSaving" INTEGER,
    "payload" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'NEW',
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecommendationBatch_status_lockedAt_idx" ON "RecommendationBatch"("status", "lockedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationBatch_ownerId_weekKey_key" ON "RecommendationBatch"("ownerId", "weekKey");

-- CreateIndex
CREATE INDEX "Recommendation_ownerId_status_idx" ON "Recommendation"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Recommendation_ownerId_fingerprint_idx" ON "Recommendation"("ownerId", "fingerprint");

-- AddForeignKey
ALTER TABLE "RecommendationBatch" ADD CONSTRAINT "RecommendationBatch_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RecommendationBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

