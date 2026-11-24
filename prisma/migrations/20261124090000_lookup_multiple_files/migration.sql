-- Lead lookup: several uploaded files per list (e.g. two Mentor sheets and one Sub-mentor sheet).
-- A single file uploaded earlier (rows kept in the link's columns) moves into the new lists.
ALTER TABLE "lookup_configs" ADD COLUMN "mentor_files" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "lookup_configs" ADD COLUMN "sub_mentor_files" JSONB NOT NULL DEFAULT '[]';

UPDATE "lookup_configs"
SET "mentor_files" = jsonb_build_array(jsonb_build_object('name', "mentor_file_name", 'rows', COALESCE("mentor_rows", '[]'::jsonb), 'uploadedAt', COALESCE("mentor_read_at", now()))),
    "mentor_rows" = NULL, "mentor_read_at" = NULL
WHERE "mentor_file_name" IS NOT NULL;
UPDATE "lookup_configs"
SET "sub_mentor_files" = jsonb_build_array(jsonb_build_object('name', "sub_mentor_file_name", 'rows', COALESCE("sub_mentor_rows", '[]'::jsonb), 'uploadedAt', COALESCE("sub_mentor_read_at", now()))),
    "sub_mentor_rows" = NULL, "sub_mentor_read_at" = NULL
WHERE "sub_mentor_file_name" IS NOT NULL;

ALTER TABLE "lookup_configs" DROP COLUMN "mentor_file_name", DROP COLUMN "sub_mentor_file_name";
