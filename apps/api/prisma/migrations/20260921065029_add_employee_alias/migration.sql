-- CreateTable
CREATE TABLE "EmployeeAlias" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeAlias_normalizedAlias_idx" ON "EmployeeAlias"("normalizedAlias");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeAlias_employeeId_normalizedAlias_key" ON "EmployeeAlias"("employeeId", "normalizedAlias");

-- AddForeignKey
ALTER TABLE "EmployeeAlias" ADD CONSTRAINT "EmployeeAlias_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
