-- Lead lookup: sheets can be uploaded as files; optional automatic check of every new SD-Leads lead.
ALTER TABLE "lookup_configs" ADD COLUMN "mentor_file_name" TEXT;
ALTER TABLE "lookup_configs" ADD COLUMN "sub_mentor_file_name" TEXT;
ALTER TABLE "lookup_configs" ADD COLUMN "auto_check_leads" BOOLEAN NOT NULL DEFAULT false;
