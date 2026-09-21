-- CreateTable
CREATE TABLE "MeetingSegment" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "speakerLabel" TEXT NOT NULL,
    "speakerEmployeeId" TEXT,
    "text" TEXT NOT NULL,

    CONSTRAINT "MeetingSegment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeetingSegment_meetingId_order_idx" ON "MeetingSegment"("meetingId", "order");

-- AddForeignKey
ALTER TABLE "MeetingSegment" ADD CONSTRAINT "MeetingSegment_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingSegment" ADD CONSTRAINT "MeetingSegment_speakerEmployeeId_fkey" FOREIGN KEY ("speakerEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
