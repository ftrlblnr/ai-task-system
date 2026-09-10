-- CreateTable
CREATE TABLE "TelegramInvite" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramInvite_tokenHash_key" ON "TelegramInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "TelegramInvite_employeeId_idx" ON "TelegramInvite"("employeeId");

-- AddForeignKey
ALTER TABLE "TelegramInvite" ADD CONSTRAINT "TelegramInvite_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
