-- CreateEnum
CREATE TYPE "CalendarActionType" AS ENUM ('CREATE_EVENT', 'UPDATE_EVENT', 'RESCHEDULE_EVENT', 'CANCEL_EVENT');

-- CreateEnum
CREATE TYPE "CalendarPlanStatus" AS ENUM ('DRAFT', 'NEEDS_APPROVAL', 'APPROVED', 'EXECUTING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CalendarActionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'SKIPPED_CHANGED', 'BLOCKED_DEPENDENCY', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CalendarAuthorizationBasis" AS ENUM ('DIRECT_COMMAND', 'EXPLICIT_APPROVAL', 'BOOKING_GRANT', 'POLICY_RULE');

-- CreateEnum
CREATE TYPE "CalendarExecutionState" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'STOPPED');

-- CreateEnum
CREATE TYPE "CalendarAttemptOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "CalendarPlan" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "requestText" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "CalendarPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarAction" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "type" "CalendarActionType" NOT NULL,
    "targetEventId" TEXT,
    "beforeVersion" INTEGER,
    "parameters" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "dependsOnActionIds" TEXT[],
    "status" "CalendarActionStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "authorizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarAuthorization" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "planVersion" INTEGER NOT NULL,
    "basis" "CalendarAuthorizationBasis" NOT NULL DEFAULT 'EXPLICIT_APPROVAL',
    "actionIds" TEXT[],
    "immutableActionSnapshot" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "CalendarAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarActionExecution" (
    "id" TEXT NOT NULL,
    "authorizationId" TEXT NOT NULL,
    "state" "CalendarExecutionState" NOT NULL DEFAULT 'QUEUED',
    "cancelRequestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CalendarActionExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarExecutionAttempt" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "intent" JSONB NOT NULL,
    "providerResult" JSONB,
    "errorCode" TEXT,
    "outcome" "CalendarAttemptOutcome",
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CalendarExecutionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarPlan_ownerId_createdAt_idx" ON "CalendarPlan"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "CalendarAction_planId_status_idx" ON "CalendarAction"("planId", "status");

-- CreateIndex
CREATE INDEX "CalendarAuthorization_planId_idx" ON "CalendarAuthorization"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarActionExecution_authorizationId_key" ON "CalendarActionExecution"("authorizationId");

-- CreateIndex
CREATE INDEX "CalendarActionExecution_state_idx" ON "CalendarActionExecution"("state");

-- CreateIndex
CREATE INDEX "CalendarExecutionAttempt_actionId_attemptNumber_idx" ON "CalendarExecutionAttempt"("actionId", "attemptNumber");

-- AddForeignKey
ALTER TABLE "CalendarPlan" ADD CONSTRAINT "CalendarPlan_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarAction" ADD CONSTRAINT "CalendarAction_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CalendarPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarAction" ADD CONSTRAINT "CalendarAction_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "CalendarAuthorization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarAuthorization" ADD CONSTRAINT "CalendarAuthorization_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarAuthorization" ADD CONSTRAINT "CalendarAuthorization_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CalendarPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarActionExecution" ADD CONSTRAINT "CalendarActionExecution_authorizationId_fkey" FOREIGN KEY ("authorizationId") REFERENCES "CalendarAuthorization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarExecutionAttempt" ADD CONSTRAINT "CalendarExecutionAttempt_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "CalendarAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
