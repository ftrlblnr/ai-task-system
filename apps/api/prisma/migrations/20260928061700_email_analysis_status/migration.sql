-- CreateEnum
CREATE TYPE "EmailAnalysisStatus" AS ENUM ('COMPLETED', 'FAILED');

-- AlterTable (EmailAnalysis has 0 rows in prod — safe to add NOT NULL "status"
-- without a default and to drop NOT NULL on the four now-nullable fields)
ALTER TABLE "EmailAnalysis"
  ADD COLUMN     "status" "EmailAnalysisStatus" NOT NULL,
  ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 1,
  ALTER COLUMN "importance" DROP NOT NULL,
  ALTER COLUMN "category" DROP NOT NULL,
  ALTER COLUMN "needsReply" DROP NOT NULL,
  ALTER COLUMN "needsAction" DROP NOT NULL;
