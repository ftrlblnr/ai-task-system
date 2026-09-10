/*
  Warnings:

  - You are about to drop the `Responsibility` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Responsibility" DROP CONSTRAINT "Responsibility_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "Responsibility" DROP CONSTRAINT "Responsibility_projectId_fkey";

-- DropTable
DROP TABLE "Responsibility";

-- CreateTable
CREATE TABLE "ResponsibilityArea" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResponsibilityArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeResponsibility" (
    "employeeId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeResponsibility_pkey" PRIMARY KEY ("employeeId","areaId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResponsibilityArea_name_key" ON "ResponsibilityArea"("name");

-- AddForeignKey
ALTER TABLE "EmployeeResponsibility" ADD CONSTRAINT "EmployeeResponsibility_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeResponsibility" ADD CONSTRAINT "EmployeeResponsibility_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "ResponsibilityArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;
