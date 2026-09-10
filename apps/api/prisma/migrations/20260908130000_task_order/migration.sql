-- AlterTable: ручной порядок внутри колонки канбана.
ALTER TABLE "Task" ADD COLUMN "order" INTEGER NOT NULL DEFAULT 0;
