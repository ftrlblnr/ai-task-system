-- Аудит 10.09.2026, п. 2.9: память голосового диалога — переписка была
-- только в localStorage браузера, на сервер не возвращалась, поэтому
-- модель не видела, что говорилось раньше в этом же разговоре.
CREATE TYPE "VoiceMessageRole" AS ENUM ('USER', 'ASSISTANT');

CREATE TABLE "VoiceMessage" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "role" "VoiceMessageRole" NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VoiceMessage_employeeId_createdAt_idx" ON "VoiceMessage"("employeeId", "createdAt");

ALTER TABLE "VoiceMessage" ADD CONSTRAINT "VoiceMessage_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
