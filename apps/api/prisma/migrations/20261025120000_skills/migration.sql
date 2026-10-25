-- CreateEnum
CREATE TYPE "SkillKind" AS ENUM ('PLAYBOOK', 'KNOWLEDGE', 'ACTION');

-- CreateEnum
CREATE TYPE "SkillModel" AS ENUM ('HAIKU', 'SONNET', 'OPUS');

-- CreateEnum
CREATE TYPE "SkillEffort" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "SkillOutput" AS ENUM ('CHAT', 'DOCX', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "SkillRevisionSource" AS ENUM ('MANUAL', 'FEEDBACK', 'SENT_MAIL');

-- CreateEnum
CREATE TYPE "SkillRevisionStatus" AS ENUM ('GENERATING', 'PROPOSED', 'APPLIED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "SkillRunTrigger" AS ENUM ('CHAT', 'BUTTON');

-- CreateEnum
CREATE TYPE "SkillRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SkillFeedback" AS ENUM ('UP', 'DOWN');

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "SkillKind" NOT NULL,
    "instructions" TEXT NOT NULL,
    "model" "SkillModel" NOT NULL,
    "effort" "SkillEffort" NOT NULL,
    "allowedTools" TEXT[],
    "output" "SkillOutput" NOT NULL DEFAULT 'CHAT',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillRevision" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "source" "SkillRevisionSource" NOT NULL,
    "status" "SkillRevisionStatus" NOT NULL,
    "baseVersion" INTEGER NOT NULL,
    "instructions" TEXT,
    "reason" TEXT,
    "error" TEXT,
    "createdById" TEXT,
    "lockedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "SkillRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillRun" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "trigger" "SkillRunTrigger" NOT NULL,
    "status" "SkillRunStatus" NOT NULL,
    "inputText" TEXT NOT NULL DEFAULT '',
    "conversationId" TEXT,
    "outputMessageId" TEXT,
    "error" TEXT,
    "feedback" "SkillFeedback",
    "feedbackText" TEXT,
    "feedbackAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "lockedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SkillRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Skill_ownerId_slug_key" ON "Skill"("ownerId", "slug");

-- CreateIndex
CREATE INDEX "SkillRevision_skillId_createdAt_idx" ON "SkillRevision"("skillId", "createdAt");

-- CreateIndex
CREATE INDEX "SkillRevision_status_lockedAt_idx" ON "SkillRevision"("status", "lockedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SkillRun_outputMessageId_key" ON "SkillRun"("outputMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillRun_idempotencyKey_key" ON "SkillRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SkillRun_skillId_createdAt_idx" ON "SkillRun"("skillId", "createdAt");

-- CreateIndex
CREATE INDEX "SkillRun_status_lockedAt_idx" ON "SkillRun"("status", "lockedAt");

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillRevision" ADD CONSTRAINT "SkillRevision_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillRun" ADD CONSTRAINT "SkillRun_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillRun" ADD CONSTRAINT "SkillRun_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

