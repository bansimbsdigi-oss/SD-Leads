-- Any number field ("Number", "Contact", "Mob No", "WhatsApp No"…) holding a real phone number fills Mobile.
-- Same rules as isPhoneLikeKey (lib/ingest/fieldKeys.ts); only Indian mobile numbers are recognised here.
CREATE FUNCTION pg_temp.phone_like_key(k text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT k ~ '(^|_)(phone|mobile|mob|cell|tel|telephone|contact|number|num|no|whats_?app\w*)(_|$)'
     AND k !~ 'formatted|opt|consent|link|button|group|community|channel|message|msg|status|chat|updates'
     AND k !~ '(^|_)(of|count|age|pin|pincode|zip|postal|code|otp|order|roll|id|invoice|amount|year|date|time|house|flat|room|seat|ticket|aadhar|aadhaar|pan|gst|account|card|policy|registration|reg|email|mail|name)(_|$)'
$$;

CREATE FUNCTION pg_temp.india_mobile(v text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN d ~ '^[6-9][0-9]{9}$' THEN '+91' || d
    WHEN d ~ '^91[6-9][0-9]{9}$' THEN '+' || d
    WHEN d ~ '^0[6-9][0-9]{9}$' THEN '+91' || substr(d, 2)
  END
  FROM (SELECT regexp_replace(coalesce(v, ''), '[^0-9]', '', 'g') AS d) x
$$;

-- Leads with no Mobile: take the first number field (a WhatsApp field only when there's no other).
UPDATE leads l
SET phone_normalised = p.phone
FROM (
  SELECT DISTINCT ON (l2.id) l2.id, pg_temp.india_mobile(a.value) AS phone
  FROM leads l2
  CROSS JOIN LATERAL jsonb_each_text(l2.answers) a
  WHERE l2.phone_normalised IS NULL
    AND jsonb_typeof(l2.answers) = 'object'
    AND pg_temp.phone_like_key(a.key)
    AND pg_temp.india_mobile(a.value) IS NOT NULL
  ORDER BY l2.id, (a.key ~ 'whats') -- false (not WhatsApp) first
) p
WHERE l.id = p.id;

-- Those fields now feed Mobile, so they no longer get a column of their own.
UPDATE form_fields f
SET role = 'phone'
WHERE f.role IS NULL
  AND pg_temp.phone_like_key(f.field_key)
  AND EXISTS (
    SELECT 1 FROM leads l
    WHERE l.lp_id = f.lp_id AND pg_temp.india_mobile(l.answers ->> f.field_key) IS NOT NULL
  );
