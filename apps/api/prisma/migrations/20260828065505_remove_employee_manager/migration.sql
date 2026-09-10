/*
  Warnings:

  - You are about to drop the column `managerId` on the `Employee` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Employee" DROP CONSTRAINT "Employee_managerId_fkey";

-- AlterTable
ALTER TABLE "Employee" DROP COLUMN "managerId";
