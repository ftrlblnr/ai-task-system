-- CreateEnum
CREATE TYPE "ProposedChangeEntityType" AS ENUM ('TRIP', 'TRIP_LEG', 'TRIP_EVENT', 'TRIP_STAY', 'TRIP_CONTACT');

-- CreateEnum
CREATE TYPE "ProposedChangeStatus" AS ENUM ('PENDING', 'APPLIED', 'REJECTED');

-- CreateTable
CREATE TABLE "ProposedChange" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "materialId" TEXT,
    "entityType" "ProposedChangeEntityType" NOT NULL,
    "entityId" TEXT,
    "fieldKey" TEXT,
    "previousValue" JSONB,
    "proposedValue" JSONB NOT NULL,
    "reason" TEXT,
    "consequences" TEXT,
    "status" "ProposedChangeStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByEmployeeId" TEXT,

    CONSTRAINT "ProposedChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripRevision" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "changeId" TEXT,
    "entityType" "ProposedChangeEntityType" NOT NULL,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "appliedByEmployeeId" TEXT,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProposedChange_tripId_status_idx" ON "ProposedChange"("tripId", "status");

-- CreateIndex
CREATE INDEX "TripRevision_tripId_appliedAt_idx" ON "TripRevision"("tripId", "appliedAt");

-- AddForeignKey
ALTER TABLE "ProposedChange" ADD CONSTRAINT "ProposedChange_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripRevision" ADD CONSTRAINT "TripRevision_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
