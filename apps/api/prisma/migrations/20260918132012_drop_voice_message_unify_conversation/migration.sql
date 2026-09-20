/*
  Warnings:

  - You are about to drop the `VoiceMessage` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "TaskHistory" DROP CONSTRAINT "TaskHistory_changedById_fkey";

-- DropForeignKey
ALTER TABLE "VoiceMessage" DROP CONSTRAINT "VoiceMessage_employeeId_fkey";

-- DropTable
DROP TABLE "VoiceMessage";

-- DropEnum
DROP TYPE "VoiceMessageRole";

-- AddForeignKey
ALTER TABLE "TaskHistory" ADD CONSTRAINT "TaskHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
