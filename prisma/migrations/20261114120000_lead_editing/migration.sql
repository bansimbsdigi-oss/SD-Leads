-- Manual tags on leads, and timeline events for edits and tag changes.
ALTER TYPE "LeadEventType" ADD VALUE 'edited';
ALTER TYPE "LeadEventType" ADD VALUE 'tags_changed';

ALTER TABLE "leads" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "leads_tags_idx" ON "leads" USING GIN ("tags");
