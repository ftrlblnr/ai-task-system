-- CreateEnum
CREATE TYPE "ReceptionRequestType" AS ENUM ('DECISION', 'APPROVAL', 'DISCUSSION', 'HELP');

-- CreateEnum
CREATE TYPE "ReceptionRequestStatus" AS ENUM ('WAITING', 'CALLED', 'COMPLETED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ReceptionEventType" AS ENUM ('CREATED', 'EDITED', 'MOVED_TO_END', 'CALLED', 'REJECTED', 'WITHDRAWN', 'COMPLETED', 'RETURNED_TO_QUEUE');

-- CreateEnum
CREATE TYPE "ReceptionNotificationKind" AS ENUM ('CALLED', 'REJECTED', 'RETURNED_TO_QUEUE');

-- CreateEnum
CREATE TYPE "ReceptionNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "ReceptionQueue" (
    "id" TEXT NOT NULL,
    "nextOrder" BIGINT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionRequest" (
    "id" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requestType" "ReceptionRequestType" NOT NULL,
    "expectedMinutes" INTEGER,
    "desiredBy" TIMESTAMP(3),
    "urgencyReason" TEXT,
    "status" "ReceptionRequestStatus" NOT NULL DEFAULT 'WAITING',
    "queueOrder" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastCalledAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceptionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "type" "ReceptionEventType" NOT NULL,
    "fromStatus" "ReceptionRequestStatus",
    "toStatus" "ReceptionRequestStatus" NOT NULL,
    "requestVersion" INTEGER NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceptionNotification" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'TELEGRAM',
    "kind" "ReceptionNotificationKind" NOT NULL,
    "status" "ReceptionNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastErrorCode" TEXT,
    "providerMessageId" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "ReceptionNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "statusCode" INTEGER,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceptionRequest_queueId_status_queueOrder_id_idx" ON "ReceptionRequest"("queueId", "status", "queueOrder", "id");

-- CreateIndex
CREATE INDEX "ReceptionRequest_authorId_status_createdAt_idx" ON "ReceptionRequest"("authorId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ReceptionRequest_queueId_closedAt_id_idx" ON "ReceptionRequest"("queueId", "closedAt", "id");

-- At most one CALLED request per queue — enforced at the DB level (раздел
-- 7.1 ТЗ: "на уровне серверной транзакции, а не только UI"), not
-- representable in schema.prisma (no partial-index syntax), hand-written
-- here. A second concurrent "call" hits this constraint (P2002) and is
-- translated to 409 RECEPTION_BUSY by the service.
CREATE UNIQUE INDEX "ReceptionRequest_one_called_per_queue" ON "ReceptionRequest"("queueId") WHERE "status" = 'CALLED';

-- CreateIndex
CREATE INDEX "ReceptionEvent_requestId_createdAt_idx" ON "ReceptionEvent"("requestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReceptionNotification_eventId_recipientId_channel_kind_key" ON "ReceptionNotification"("eventId", "recipientId", "channel", "kind");

-- CreateIndex
CREATE INDEX "ReceptionNotification_status_nextAttemptAt_idx" ON "ReceptionNotification"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_actorId_key_key" ON "IdempotencyKey"("actorId", "key");

-- AddForeignKey
ALTER TABLE "ReceptionRequest" ADD CONSTRAINT "ReceptionRequest_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "ReceptionQueue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionRequest" ADD CONSTRAINT "ReceptionRequest_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionEvent" ADD CONSTRAINT "ReceptionEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ReceptionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionEvent" ADD CONSTRAINT "ReceptionEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionNotification" ADD CONSTRAINT "ReceptionNotification_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "ReceptionEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionNotification" ADD CONSTRAINT "ReceptionNotification_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ReceptionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionNotification" ADD CONSTRAINT "ReceptionNotification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
