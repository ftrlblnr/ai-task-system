-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('RECEIVED', 'EXTRACTING', 'MATCHING', 'COMPOSING', 'READY', 'READY_WITH_ISSUES', 'FAILED');

-- CreateEnum
CREATE TYPE "TripMaterialStatus" AS ENUM ('PENDING', 'EXTRACTED', 'FAILED', 'UNREADABLE');

-- CreateEnum
CREATE TYPE "TripPeriodPrecision" AS ENUM ('UNKNOWN', 'APPROXIMATE', 'EXACT');

-- CreateEnum
CREATE TYPE "TripAccessRole" AS ENUM ('ORGANIZER', 'EDITOR', 'APPROVER', 'VIEWER');

-- CreateEnum
CREATE TYPE "TripLegMode" AS ENUM ('FLIGHT', 'TRAIN', 'CAR', 'OTHER');

-- CreateEnum
CREATE TYPE "TripBookingStatus" AS ENUM ('BOOKED', 'PROPOSED', 'UNCONFIRMED');

-- CreateEnum
CREATE TYPE "TripContactRole" AS ENUM ('ORGANIZER_HOST', 'RECEIVING_PARTY', 'DELEGATE', 'OTHER');

-- CreateEnum
CREATE TYPE "ExtractedFactStatus" AS ENUM ('EXTRACTED', 'CONFIRMED', 'DISPUTED', 'OUTDATED');

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "canCreateTrips" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL,
    "humanCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "purposeSummary" TEXT,
    "organizerId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "periodPrecision" "TripPeriodPrecision" NOT NULL DEFAULT 'UNKNOWN',
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripMember" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "accessRole" "TripAccessRole" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripContact" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "TripContactRole" NOT NULL DEFAULT 'OTHER',
    "organization" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "sourceMaterialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripLeg" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "mode" "TripLegMode" NOT NULL DEFAULT 'OTHER',
    "fromLocation" TEXT,
    "toLocation" TEXT,
    "departAt" TIMESTAMP(3),
    "departTimeZoneOffsetMinutes" INTEGER,
    "arriveAt" TIMESTAMP(3),
    "arriveTimeZoneOffsetMinutes" INTEGER,
    "carrier" TEXT,
    "referenceCode" TEXT,
    "bookingStatus" "TripBookingStatus" NOT NULL DEFAULT 'UNCONFIRMED',
    "sourceMaterialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripLeg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripEvent" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startAt" TIMESTAMP(3),
    "startTimeZoneOffsetMinutes" INTEGER,
    "dateOnly" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "location" TEXT,
    "notes" TEXT,
    "sourceMaterialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripStay" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "name" TEXT,
    "address" TEXT,
    "checkInAt" TIMESTAMP(3),
    "checkOutAt" TIMESTAMP(3),
    "bookingStatus" "TripBookingStatus" NOT NULL DEFAULT 'UNCONFIRMED',
    "sourceMaterialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripStay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripMaterial" (
    "id" TEXT NOT NULL,
    "tripId" TEXT,
    "agentRunId" TEXT NOT NULL,
    "fileArtifactId" TEXT NOT NULL,
    "processingStatus" "TripMaterialStatus" NOT NULL DEFAULT 'PENDING',
    "addedByEmployeeId" TEXT NOT NULL,
    "extractionIssue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedFact" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "factKey" TEXT NOT NULL,
    "factValue" TEXT NOT NULL,
    "status" "ExtractedFactStatus" NOT NULL DEFAULT 'EXTRACTED',
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractedFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "tripId" TEXT,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'RECEIVED',
    "initiatorId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "errorSummary" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Trip_humanCode_key" ON "Trip"("humanCode");

-- CreateIndex
CREATE INDEX "Trip_organizerId_cancelledAt_idx" ON "Trip"("organizerId", "cancelledAt");

-- CreateIndex
CREATE INDEX "Trip_periodStart_periodEnd_idx" ON "Trip"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "TripMember_employeeId_idx" ON "TripMember"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "TripMember_tripId_employeeId_key" ON "TripMember"("tripId", "employeeId");

-- CreateIndex
CREATE INDEX "TripLeg_tripId_departAt_idx" ON "TripLeg"("tripId", "departAt");

-- CreateIndex
CREATE INDEX "TripEvent_tripId_startAt_idx" ON "TripEvent"("tripId", "startAt");

-- CreateIndex
CREATE INDEX "TripEvent_tripId_dateOnly_idx" ON "TripEvent"("tripId", "dateOnly");

-- CreateIndex
CREATE INDEX "TripStay_tripId_checkInAt_idx" ON "TripStay"("tripId", "checkInAt");

-- CreateIndex
CREATE INDEX "TripMaterial_tripId_idx" ON "TripMaterial"("tripId");

-- CreateIndex
CREATE INDEX "TripMaterial_agentRunId_idx" ON "TripMaterial"("agentRunId");

-- CreateIndex
CREATE INDEX "ExtractedFact_tripId_idx" ON "ExtractedFact"("tripId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_idempotencyKey_key" ON "AgentRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentRun_status_lockedAt_idx" ON "AgentRun"("status", "lockedAt");

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripMember" ADD CONSTRAINT "TripMember_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripMember" ADD CONSTRAINT "TripMember_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripContact" ADD CONSTRAINT "TripContact_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripLeg" ADD CONSTRAINT "TripLeg_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripEvent" ADD CONSTRAINT "TripEvent_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripStay" ADD CONSTRAINT "TripStay_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripMaterial" ADD CONSTRAINT "TripMaterial_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripMaterial" ADD CONSTRAINT "TripMaterial_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripMaterial" ADD CONSTRAINT "TripMaterial_addedByEmployeeId_fkey" FOREIGN KEY ("addedByEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "TripMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
