-- Lead lookup is global now (webhook in, webhook out); results are no longer stored on each lead.
ALTER TABLE "leads" DROP COLUMN "lookup_type",
DROP COLUMN "mentor_name",
DROP COLUMN "sub_mentor_name",
DROP COLUMN "lookup_matched_by",
DROP COLUMN "lookup_at";
