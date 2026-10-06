-- CreateEnum
CREATE TYPE "MailActionType" AS ENUM ('ARCHIVE', 'MOVE', 'CREATE_FOLDER', 'SET_READ', 'SET_UNREAD', 'FLAG', 'UNFLAG', 'TRASH', 'CREATE_TASK', 'SAVE_ATTACHMENT', 'DRAFT_REPLY', 'SEND_REPLY', 'FORWARD', 'PROPOSE_MEETING', 'CREATE_EVENT', 'WATCH_REPLY', 'WATCH_COMMITMENT', 'DRAFT_REMINDER');

-- CreateEnum
CREATE TYPE "MailActionGroupType" AS ENUM ('MAILBOX_ORDER', 'WORK_OBJECTS', 'EXTERNAL_SEND', 'TRASH');

-- CreateEnum
CREATE TYPE "MailActionPlanStatus" AS ENUM ('ANALYZING', 'READY', 'EXECUTING', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MailActionItemStatus" AS ENUM ('DRAFT', 'NEEDS_REVIEW', 'APPROVED', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'SKIPPED_CHANGED', 'BLOCKED_DEPENDENCY', 'CANCELLED', 'COMPENSATED');

-- CreateEnum
CREATE TYPE "MailActionRelevance" AS ENUM ('RECOMMENDED', 'KEEP', 'NEEDS_REVIEW', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "MailActionApprovalStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "MailActionAttemptOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MailActionExecutionState" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'STOPPED');

-- CreateEnum
CREATE TYPE "MailDraftState" AS ENUM ('DRAFT', 'SENT', 'DISCARDED');

-- CreateEnum
CREATE TYPE "MailWatchStatus" AS ENUM ('ACTIVE', 'NEEDS_REVIEW', 'SATISFIED', 'STOPPED', 'CANNOT_VERIFY');

-- CreateEnum
CREATE TYPE "MailActionCompensationStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'NOT_POSSIBLE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EmailFolderRole" ADD VALUE 'ARCHIVE';
ALTER TYPE "EmailFolderRole" ADD VALUE 'DRAFTS';
ALTER TYPE "EmailFolderRole" ADD VALUE 'JUNK';
ALTER TYPE "EmailFolderRole" ADD VALUE 'TRASH';

-- CreateTable
CREATE TABLE "MailActionPlan" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "requestText" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "modelVersion" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "MailActionPlanStatus" NOT NULL DEFAULT 'ANALYZING',
    "coverage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailActionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailActionItem" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "type" "MailActionType" NOT NULL,
    "groupType" "MailActionGroupType" NOT NULL,
    "stableObjectIds" TEXT[],
    "sourceLocators" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB,
    "relevance" "MailActionRelevance",
    "parameters" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "dependsOnItemIds" TEXT[],
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "status" "MailActionItemStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "approvalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailActionApproval" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "planVersion" INTEGER NOT NULL,
    "groupType" "MailActionGroupType" NOT NULL,
    "itemIds" TEXT[],
    "immutableActionSnapshot" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" "MailActionApprovalStatus" NOT NULL DEFAULT 'ACTIVE',
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailActionApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailActionExecution" (
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "state" "MailActionExecutionState" NOT NULL DEFAULT 'QUEUED',
    "countersByType" JSONB,
    "cancelRequestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "MailActionExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailActionAttempt" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "intent" JSONB NOT NULL,
    "providerResult" JSONB,
    "destinationLocator" JSONB,
    "errorCode" TEXT,
    "outcome" "MailActionAttemptOutcome",
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "MailActionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailDraft" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "fromAddress" TEXT,
    "toAddresses" TEXT[],
    "ccAddresses" TEXT[],
    "bccAddresses" TEXT[],
    "subject" TEXT,
    "body" TEXT,
    "signature" TEXT,
    "attachments" JSONB,
    "state" "MailDraftState" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailWatch" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "sourceIds" TEXT[],
    "expectation" TEXT NOT NULL,
    "deadline" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" "MailWatchStatus" NOT NULL DEFAULT 'ACTIVE',
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailWatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailActionCompensation" (
    "id" TEXT NOT NULL,
    "originalActionId" TEXT NOT NULL,
    "selectedCompensation" TEXT NOT NULL,
    "approvalId" TEXT,
    "status" "MailActionCompensationStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailActionCompensation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailActionPlan_ownerId_mailboxId_createdAt_idx" ON "MailActionPlan"("ownerId", "mailboxId", "createdAt");

-- CreateIndex
CREATE INDEX "MailActionItem_planId_groupType_status_idx" ON "MailActionItem"("planId", "groupType", "status");

-- CreateIndex
CREATE INDEX "MailActionApproval_planId_groupType_idx" ON "MailActionApproval"("planId", "groupType");

-- CreateIndex
CREATE UNIQUE INDEX "MailActionExecution_approvalId_key" ON "MailActionExecution"("approvalId");

-- CreateIndex
CREATE INDEX "MailActionExecution_state_idx" ON "MailActionExecution"("state");

-- CreateIndex
CREATE INDEX "MailActionAttempt_actionId_attemptNumber_idx" ON "MailActionAttempt"("actionId", "attemptNumber");

-- AddForeignKey
ALTER TABLE "MailActionPlan" ADD CONSTRAINT "MailActionPlan_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailActionPlan" ADD CONSTRAINT "MailActionPlan_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailActionItem" ADD CONSTRAINT "MailActionItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MailActionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailActionItem" ADD CONSTRAINT "MailActionItem_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "MailActionApproval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailActionApproval" ADD CONSTRAINT "MailActionApproval_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailActionApproval" ADD CONSTRAINT "MailActionApproval_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MailActionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailActionExecution" ADD CONSTRAINT "MailActionExecution_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "MailActionApproval"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailActionAttempt" ADD CONSTRAINT "MailActionAttempt_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "MailActionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDraft" ADD CONSTRAINT "MailDraft_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailWatch" ADD CONSTRAINT "MailWatch_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailWatch" ADD CONSTRAINT "MailWatch_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailActionCompensation" ADD CONSTRAINT "MailActionCompensation_originalActionId_fkey" FOREIGN KEY ("originalActionId") REFERENCES "MailActionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
