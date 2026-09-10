/*
  Warnings:

  - You are about to drop the column `projectId` on the `Meeting` table. All the data in the column will be lost.
  - You are about to drop the column `projectId` on the `Task` table. All the data in the column will be lost.
  - You are about to drop the `Project` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Meeting" DROP CONSTRAINT "Meeting_projectId_fkey";

-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_projectId_fkey";

-- DropIndex
DROP INDEX "Meeting_projectId_idx";

-- DropIndex
DROP INDEX "Task_projectId_idx";

-- AlterTable
ALTER TABLE "Meeting" DROP COLUMN "projectId";

-- AlterTable
ALTER TABLE "Task" DROP COLUMN "projectId";

-- DropTable
DROP TABLE "Project";

-- DropEnum
DROP TYPE "ProjectStatus";
