-- Владелец 08.09.2026: автоматическая синхронизация встреч из Plaud —
-- тот же OAuth/connection паттерн, что уже есть для Google Calendar.

-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "plaudRecordingId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_plaudRecordingId_key" ON "Meeting"("plaudRecordingId");

-- CreateTable
CREATE TABLE "PlaudConnection" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastSyncedCreatedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncAt" TIMESTAMP(3),

    CONSTRAINT "PlaudConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlaudConnection_employeeId_key" ON "PlaudConnection"("employeeId");

-- AddForeignKey
ALTER TABLE "PlaudConnection" ADD CONSTRAINT "PlaudConnection_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "PlaudOAuthAppConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "clientId" TEXT NOT NULL,
    "clientSecretEncrypted" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaudOAuthAppConfig_pkey" PRIMARY KEY ("id")
);
