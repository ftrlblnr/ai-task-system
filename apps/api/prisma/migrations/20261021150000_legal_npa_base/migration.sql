-- CreateTable
CREATE TABLE "NpaDocument" (
    "code" TEXT NOT NULL,
    "short" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "requisites" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "lastAmendmentDate" DATE,
    "lastAmendmentAct" TEXT,
    "sourceDate" DATE,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NpaDocument_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "NpaArticle" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "article" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "path" TEXT[],
    "text" TEXT NOT NULL,
    "footnotes" TEXT[],
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "amendedBy" JSONB NOT NULL DEFAULT '[]',
    "pendingFrom" DATE[],
    "expiresOn" DATE[],
    "links" TEXT[],
    "watch" TEXT[],
    -- Полнотекстовый поиск: заголовок статьи весомее текста. Явный regconfig
    -- делает выражение IMMUTABLE — иначе GENERATED-колонку не создать.
    "search" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('russian'::regconfig, coalesce("title", '')), 'A') ||
        setweight(to_tsvector('russian'::regconfig, coalesce("text", '')), 'B')
    ) STORED,

    CONSTRAINT "NpaArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NpaGlossaryTerm" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "definition" TEXT NOT NULL,

    CONSTRAINT "NpaGlossaryTerm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NpaArticle_code_idx" ON "NpaArticle"("code");

-- CreateIndex
CREATE INDEX "NpaArticle_search_idx" ON "NpaArticle" USING GIN ("search");

-- CreateIndex
CREATE INDEX "NpaGlossaryTerm_articleId_idx" ON "NpaGlossaryTerm"("articleId");

-- AddForeignKey
ALTER TABLE "NpaArticle" ADD CONSTRAINT "NpaArticle_code_fkey" FOREIGN KEY ("code") REFERENCES "NpaDocument"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NpaGlossaryTerm" ADD CONSTRAINT "NpaGlossaryTerm_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "NpaArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NpaGlossaryTerm" ADD CONSTRAINT "NpaGlossaryTerm_code_fkey" FOREIGN KEY ("code") REFERENCES "NpaDocument"("code") ON DELETE CASCADE ON UPDATE CASCADE;
