/*
  Warnings:

  - You are about to drop the `EmployeeResponsibility` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ResponsibilityArea` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "EmployeeResponsibility" DROP CONSTRAINT "EmployeeResponsibility_areaId_fkey";

-- DropForeignKey
ALTER TABLE "EmployeeResponsibility" DROP CONSTRAINT "EmployeeResponsibility_employeeId_fkey";

-- DropTable
DROP TABLE "EmployeeResponsibility";

-- DropTable
DROP TABLE "ResponsibilityArea";
