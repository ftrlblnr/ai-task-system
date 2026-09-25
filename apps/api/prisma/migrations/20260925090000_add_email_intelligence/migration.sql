-- CreateEnum
CREATE TYPE "MailProvider" AS ENUM ('MAIL_RU');

-- CreateEnum
CREATE TYPE "MailboxSyncState" AS ENUM ('IDLE', 'SYNCING', 'ERROR', 'PAUSED');

-- CreateEnum
CREATE TYPE "EmailFolderRole" AS ENUM ('INBOX', 'SENT', 'OTHER');

-- CreateEnum
CREATE TYPE "EmailReplyStatus" AS ENUM ('AWAITING_MY_REPLY', 'REPLIED', 'NO_REPLY_REQUIRED', 'AWAITING_THEIR_REPLY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "EmailRecipientType" AS ENUM ('TO', 'CC', 'BCC');

-- CreateEnum
CREATE TYPE "EmailImportance" AS ENUM ('CRITICAL', 'IMPORTANT', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "EmailCategory" AS ENUM ('ACTION_REQUIRED', 'DECISION_REQUIRED', 'INFORMATION', 'DOCUMENT', 'COMMERCIAL', 'LEGAL', 'FINANCE', 'PROJECT', 'MEETING', 'NEWSLETTER', 'OTHER');

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "provider" "MailProvider" NOT NULL DEFAULT 'MAIL_RU',
    "appPasswordEncrypted" TEXT NOT NULL,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "syncState" "MailboxSyncState" NOT NULL DEFAULT 'IDLE',
    "lastError" TEXT,
    "consecutiveAuthFailures" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "initialDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailFolder" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "role" "EmailFolderRole" NOT NULL,
    "uidValidity" TEXT,
    "lastUid" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EmailFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailThread" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "subjectNorm" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3),
    "lastIncomingAt" TIMESTAMP(3),
    "lastOutgoingAt" TIMESTAMP(3),
    "replyStatus" "EmailReplyStatus" NOT NULL DEFAULT 'UNKNOWN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "uid" INTEGER NOT NULL,
    "providerMessageId" TEXT,
    "internetMessageId" TEXT,
    "subject" TEXT,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "textBody" TEXT,
    "htmlBody" TEXT,
    "bodyTruncated" BOOLEAN NOT NULL DEFAULT false,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "isOutgoing" BOOLEAN NOT NULL DEFAULT false,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "isAutomated" BOOLEAN NOT NULL DEFAULT false,
    "inReplyTo" TEXT,
    "referencesIds" TEXT[],
    "threadId" TEXT,
    "providerMissing" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailRecipient" (
    "id" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "type" "EmailRecipientType" NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT,

    CONSTRAINT "EmailRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAttachment" (
    "id" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "providerPartId" TEXT,
    "fileArtifactId" TEXT,
    "extractedText" TEXT,
    "summary" TEXT,

    CONSTRAINT "EmailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAnalysis" (
    "id" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "summary" TEXT,
    "importance" "EmailImportance" NOT NULL,
    "category" "EmailCategory" NOT NULL,
    "needsReply" BOOLEAN NOT NULL,
    "needsAction" BOOLEAN NOT NULL,
    "actionSummary" TEXT,
    "deadline" TIMESTAMP(3),
    "inputHash" TEXT,
    "model" TEXT,
    "analyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDigest" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "content" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailDigest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_employeeId_key" ON "Mailbox"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailFolder_mailboxId_path_key" ON "EmailFolder"("mailboxId", "path");

-- CreateIndex
CREATE INDEX "EmailThread_mailboxId_lastMessageAt_idx" ON "EmailThread"("mailboxId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "EmailThread_mailboxId_replyStatus_idx" ON "EmailThread"("mailboxId", "replyStatus");

-- CreateIndex
CREATE INDEX "EmailMessage_mailboxId_receivedAt_idx" ON "EmailMessage"("mailboxId", "receivedAt");

-- CreateIndex
CREATE INDEX "EmailMessage_mailboxId_internetMessageId_idx" ON "EmailMessage"("mailboxId", "internetMessageId");

-- CreateIndex
CREATE INDEX "EmailMessage_threadId_idx" ON "EmailMessage"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_folderId_uid_key" ON "EmailMessage"("folderId", "uid");

-- CreateIndex
CREATE INDEX "EmailRecipient_emailMessageId_idx" ON "EmailRecipient"("emailMessageId");

-- CreateIndex
CREATE INDEX "EmailRecipient_address_idx" ON "EmailRecipient"("address");

-- CreateIndex
CREATE INDEX "EmailAttachment_emailMessageId_idx" ON "EmailAttachment"("emailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAnalysis_emailMessageId_key" ON "EmailAnalysis"("emailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDigest_mailboxId_periodFrom_periodTo_key" ON "EmailDigest"("mailboxId", "periodFrom", "periodTo");

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailFolder" ADD CONSTRAINT "EmailFolder_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "EmailFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailRecipient" ADD CONSTRAINT "EmailRecipient_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAttachment" ADD CONSTRAINT "EmailAttachment_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAnalysis" ADD CONSTRAINT "EmailAnalysis_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDigest" ADD CONSTRAINT "EmailDigest_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

