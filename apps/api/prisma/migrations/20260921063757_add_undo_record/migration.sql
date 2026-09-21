-- CreateEnum
CREATE TYPE "UndoKind" AS ENUM ('TASK', 'EVENT');

-- CreateEnum
CREATE TYPE "UndoRecordAction" AS ENUM ('CREATE', 'UPDATE');

-- CreateTable
CREATE TABLE "UndoRecord" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" "UndoKind" NOT NULL,
    "action" "UndoRecordAction" NOT NULL,
    "entityId" TEXT NOT NULL,
    "previous" JSONB,
    "addedParticipantIds" JSONB,
    "removedParticipantIds" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UndoRecord_pkey" PRIMARY KEY ("id")
);
