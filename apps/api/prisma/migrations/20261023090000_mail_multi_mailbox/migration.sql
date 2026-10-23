-- AlterEnum
ALTER TYPE "MailProvider" ADD VALUE 'IMAP';

-- DropIndex
DROP INDEX "Mailbox_employeeId_key";

-- AlterTable
ALTER TABLE "EmailFolder" ADD COLUMN     "delimiter" TEXT,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Mailbox" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "imapHost" TEXT NOT NULL DEFAULT 'imap.mail.ru',
ADD COLUMN     "imapPort" INTEGER NOT NULL DEFAULT 993,
ADD COLUMN     "imapSecure" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "login" TEXT,
ADD COLUMN     "smtpHost" TEXT NOT NULL DEFAULT 'smtp.mail.ru',
ADD COLUMN     "smtpPort" INTEGER NOT NULL DEFAULT 465,
ADD COLUMN     "smtpSecure" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_employeeId_emailAddress_key" ON "Mailbox"("employeeId", "emailAddress");


-- Существующие ящики — Mail.ru: серверы заполнены значениями по умолчанию выше,
-- дальше хосты всегда задаёт приложение.
ALTER TABLE "Mailbox" ALTER COLUMN "imapHost" DROP DEFAULT, ALTER COLUMN "smtpHost" DROP DEFAULT;

-- Уже синхронизированные папки считаем существующими на сервере.
UPDATE "EmailFolder" SET "lastSeenAt" = CURRENT_TIMESTAMP;
