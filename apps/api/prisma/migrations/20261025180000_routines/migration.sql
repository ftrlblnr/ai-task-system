-- CreateEnum
CREATE TYPE "RoutineMode" AS ENUM ('ACTIVE', 'PASSIVE');

-- CreateEnum
CREATE TYPE "RoutineChannel" AS ENUM ('FEED', 'TELEGRAM', 'BOTH');

-- CreateEnum
CREATE TYPE "RoutineState" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "RoutineRunTrigger" AS ENUM ('SCHEDULE', 'BUTTON');

-- CreateEnum
CREATE TYPE "RoutineRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'SILENT', 'SKIPPED_CAP', 'FAILED');

-- CreateTable
CREATE TABLE "Routine" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "skillId" TEXT,
    "prompt" TEXT,
    "schedule" TEXT,
    "mode" "RoutineMode" NOT NULL,
    "channel" "RoutineChannel" NOT NULL,
    "weeklyTokenCap" INTEGER,
    "state" "RoutineState" NOT NULL DEFAULT 'ACTIVE',
    "sourceKey" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "capNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Routine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutineRun" (
    "id" TEXT NOT NULL,
    "routineId" TEXT NOT NULL,
    "trigger" "RoutineRunTrigger" NOT NULL,
    "status" "RoutineRunStatus" NOT NULL DEFAULT 'QUEUED',
    "slot" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION,
    "summary" TEXT,
    "conversationId" TEXT,
    "error" TEXT,
    "lockedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "RoutineRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Routine_sourceKey_key" ON "Routine"("sourceKey");

-- CreateIndex
CREATE INDEX "Routine_state_nextRunAt_idx" ON "Routine"("state", "nextRunAt");

-- CreateIndex
CREATE INDEX "Routine_ownerId_idx" ON "Routine"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "RoutineRun_idempotencyKey_key" ON "RoutineRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RoutineRun_routineId_createdAt_idx" ON "RoutineRun"("routineId", "createdAt");

-- CreateIndex
CREATE INDEX "RoutineRun_status_lockedAt_idx" ON "RoutineRun"("status", "lockedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RoutineRun_routineId_slot_key" ON "RoutineRun"("routineId", "slot");

-- AddForeignKey
ALTER TABLE "Routine" ADD CONSTRAINT "Routine_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Routine" ADD CONSTRAINT "Routine_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutineRun" ADD CONSTRAINT "RoutineRun_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "Routine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

