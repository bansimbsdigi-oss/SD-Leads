-- One-time repair: some forms send the page/form title as "page_name" or "form_name" next to the person's
-- "name". Older ingest code picked the title as the lead's name. Restore the real name where the saved name
-- is exactly that title and a real name was sent. Answers themselves are not changed.
UPDATE "leads"
SET "name" = left(btrim("answers" ->> 'name'), 200),
    "updated_at" = now()
WHERE COALESCE(btrim("answers" ->> 'name'), '') <> ''
  AND "name" IS NOT NULL
  AND "name" <> btrim("answers" ->> 'name')
  AND (
    "name" = btrim("answers" ->> 'page_name')
    OR "name" = btrim("answers" ->> 'form_name')
    OR "name" = btrim("answers" ->> 'pagename')
    OR "name" = btrim("answers" ->> 'page_title')
  );
