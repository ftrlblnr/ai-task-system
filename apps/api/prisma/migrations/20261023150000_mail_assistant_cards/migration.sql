-- Почта, этап 3: карточки предложений ассистента в чате.
ALTER TYPE "MessagePartType" ADD VALUE 'MAIL_PLAN_CARD';
ALTER TYPE "MessagePartType" ADD VALUE 'MAIL_DRAFT_CARD';

ALTER TABLE "MailActionPlan" ADD COLUMN "sourceKey" TEXT;
CREATE UNIQUE INDEX "MailActionPlan_sourceKey_key" ON "MailActionPlan"("sourceKey");

ALTER TABLE "MailDraft" ADD COLUMN "sourceKey" TEXT;
CREATE UNIQUE INDEX "MailDraft_sourceKey_key" ON "MailDraft"("sourceKey");
