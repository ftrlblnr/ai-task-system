-- DropForeignKey
ALTER TABLE "ExtractedFact" DROP CONSTRAINT "ExtractedFact_materialId_fkey";

-- AlterTable
ALTER TABLE "ExtractedFact" ALTER COLUMN "materialId" DROP NOT NULL;
