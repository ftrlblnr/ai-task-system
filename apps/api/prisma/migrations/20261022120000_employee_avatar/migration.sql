-- CreateTable
CREATE TABLE "EmployeeAvatar" (
    "key" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeAvatar_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeAvatar_employeeId_key" ON "EmployeeAvatar"("employeeId");

-- AddForeignKey
ALTER TABLE "EmployeeAvatar" ADD CONSTRAINT "EmployeeAvatar_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

