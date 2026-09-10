-- CreateTable
CREATE TABLE "GoogleOAuthAppConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "clientId" TEXT NOT NULL,
    "clientSecretEncrypted" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleOAuthAppConfig_pkey" PRIMARY KEY ("id")
);
