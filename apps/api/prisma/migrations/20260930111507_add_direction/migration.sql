-- CreateTable
CREATE TABLE "Direction" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Direction_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "directionId" TEXT;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_directionId_fkey" FOREIGN KEY ("directionId") REFERENCES "Direction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
