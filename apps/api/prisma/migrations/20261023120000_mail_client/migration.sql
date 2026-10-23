-- CreateEnum
CREATE TYPE "MailDraftMode" AS ENUM ('NEW', 'REPLY', 'REPLY_ALL', 'FORWARD');

-- AlterEnum
ALTER TYPE "MailDraftState" ADD VALUE 'SENDING';

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "isAnswered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isFlagged" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MailDraft" DROP COLUMN "attachments",
DROP COLUMN "fromAddress",
DROP COLUMN "signature",
ADD COLUMN     "fileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "forwardAttachmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "mode" "MailDraftMode" NOT NULL DEFAULT 'NEW',
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "sentMessageId" TEXT;

-- CreateIndex
CREATE INDEX "MailDraft_mailboxId_state_updatedAt_idx" ON "MailDraft"("mailboxId", "state", "updatedAt");
