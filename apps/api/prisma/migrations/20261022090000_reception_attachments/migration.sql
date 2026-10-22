-- CreateTable
CREATE TABLE "ReceptionAttachment" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceptionAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReceptionAttachment_fileId_key" ON "ReceptionAttachment"("fileId");

-- CreateIndex
CREATE INDEX "ReceptionAttachment_requestId_createdAt_idx" ON "ReceptionAttachment"("requestId", "createdAt");

-- AddForeignKey
ALTER TABLE "ReceptionAttachment" ADD CONSTRAINT "ReceptionAttachment_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ReceptionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceptionAttachment" ADD CONSTRAINT "ReceptionAttachment_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

