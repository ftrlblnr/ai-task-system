-- AlterTable
ALTER TABLE "Task" ADD COLUMN "sourceExecutionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Task_sourceExecutionId_key" ON "Task"("sourceExecutionId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_sourceExecutionId_fkey" FOREIGN KEY ("sourceExecutionId") REFERENCES "TaskFromMeetingExecution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
