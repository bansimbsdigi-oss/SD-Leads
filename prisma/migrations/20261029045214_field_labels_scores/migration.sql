-- AlterTable
ALTER TABLE "form_fields" ADD COLUMN     "display_label" TEXT;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "scores" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "total_score" INTEGER;
