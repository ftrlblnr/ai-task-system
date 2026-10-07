-- CreateTable
CREATE TABLE "CalendarPolicy" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "timeZoneOffsetMinutes" INTEGER NOT NULL DEFAULT 300,
    "workingHours" JSONB NOT NULL,
    "bufferMinutes" INTEGER NOT NULL DEFAULT 15,
    "minNoticeHours" INTEGER NOT NULL DEFAULT 4,
    "slotStepMinutes" INTEGER NOT NULL DEFAULT 15,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CalendarPolicy_ownerId_key" ON "CalendarPolicy"("ownerId");

-- AddForeignKey
ALTER TABLE "CalendarPolicy" ADD CONSTRAINT "CalendarPolicy_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
