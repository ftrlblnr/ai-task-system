-- CreateEnum
CREATE TYPE "PlaudSyncStatus" AS ENUM ('WAITING_FOR_CONTENT', 'SYNCED', 'FAILED');

-- CreateTable
CREATE TABLE "PlaudSyncItem" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "plaudRecordingId" TEXT NOT NULL,
    "plaudCreatedAt" TIMESTAMP(3) NOT NULL,
    "status" "PlaudSyncStatus" NOT NULL,
    "contentHash" TEXT,
    "errorMessage" TEXT,
    "meetingId" TEXT,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaudSyncItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlaudSyncItem_plaudRecordingId_key" ON "PlaudSyncItem"("plaudRecordingId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaudSyncItem_meetingId_key" ON "PlaudSyncItem"("meetingId");

-- AddForeignKey
ALTER TABLE "PlaudSyncItem" ADD CONSTRAINT "PlaudSyncItem_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE SET NULL ON UPDATE CASCADE;
