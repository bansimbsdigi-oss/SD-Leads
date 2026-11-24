-- Lead lookup: several Google Sheet links per list (e.g. two Mentor sheets and one Sub-mentor sheet),
-- each kept with its last good copy. A single link set earlier moves into the new lists.
ALTER TABLE "lookup_configs" ADD COLUMN "mentor_links" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "lookup_configs" ADD COLUMN "sub_mentor_links" JSONB NOT NULL DEFAULT '[]';

UPDATE "lookup_configs"
SET "mentor_links" = jsonb_build_array(jsonb_build_object('url', "mentor_sheet_url", 'rows', COALESCE("mentor_rows", '[]'::jsonb), 'readAt', "mentor_read_at", 'error', "mentor_error"))
WHERE "mentor_sheet_url" IS NOT NULL;
UPDATE "lookup_configs"
SET "sub_mentor_links" = jsonb_build_array(jsonb_build_object('url', "sub_mentor_sheet_url", 'rows', COALESCE("sub_mentor_rows", '[]'::jsonb), 'readAt', "sub_mentor_read_at", 'error', "sub_mentor_error"))
WHERE "sub_mentor_sheet_url" IS NOT NULL;

ALTER TABLE "lookup_configs"
  DROP COLUMN "mentor_sheet_url", DROP COLUMN "sub_mentor_sheet_url",
  DROP COLUMN "mentor_rows", DROP COLUMN "sub_mentor_rows",
  DROP COLUMN "mentor_read_at", DROP COLUMN "sub_mentor_read_at",
  DROP COLUMN "mentor_error", DROP COLUMN "sub_mentor_error";
