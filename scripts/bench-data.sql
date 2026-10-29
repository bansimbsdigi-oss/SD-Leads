-- 1M synthetic leads for scripts/bench-leads.ts. Load into an empty, migrated database.
INSERT INTO clients (id,name,slug,status,webhook_token,created_at)
SELECT 'c'||i, 'Client '||i, 'client-'||i, 'active', md5('t'||i)||md5('u'||i), now() FROM generate_series(1,12) i;

INSERT INTO pipeline_stages (id, client_id, name, position, is_won, is_lost)
SELECT 's'||c||'_'||p, 'c'||c, (ARRAY['New','Contacted','Qualified','Won','Lost'])[p+1], p, p=3, p=4
FROM generate_series(1,12) c, generate_series(0,4) p;

INSERT INTO landing_pages (id, client_id, name, lp_key, allowed_domains, status, auto_created, created_at)
SELECT 'lp'||c||'_'||k, 'c'||c, 'LP '||k, 'client-'||c||'-lp-'||k, ARRAY['example.com'], 'active', false, now()
FROM generate_series(1,12) c, generate_series(1,5) k;

INSERT INTO form_fields (id, lp_id, field_key, label, input_type, options, position, first_seen_at, last_seen_at, is_hidden, role)
SELECT 'ff'||c||'_'||k||'_'||f.key, 'lp'||c||'_'||k, f.key, f.label, f.type, f.opts, f.pos, now(), now(), false, f.role::"FieldRole"
FROM generate_series(1,12) c, generate_series(1,5) k,
(VALUES ('name','Name','text',NULL::jsonb,0,'name'),('phone','Phone','tel',NULL,1,'phone'),('email','Email','email',NULL,2,'email'),
        ('city','City','text',NULL,3,NULL),('budget','Budget','select','["<1L","1-5L","5L+"]'::jsonb,4,NULL),
        ('q1','How often do you post?','radio','["Never","Weekly","Daily"]'::jsonb,5,NULL),
        ('goal','Your goal','textarea',NULL,6,NULL),('platforms','Platforms','checkbox','["Instagram","YouTube","LinkedIn"]'::jsonb,7,NULL)) AS f(key,label,type,opts,pos,role);

INSERT INTO leads (id, client_id, lp_id, status_id, submission_id, name, phone_normalised, email_normalised, answers, tracking, consent, scores, total_score, source, is_duplicate, created_at, updated_at, last_activity_at)
SELECT 'l'||g, 'c'||c, 'lp'||c||'_'||(1 + g % 5), 's'||c||'_'||(g % 5), 'sub'||g,
  fn || ' ' || ln,
  '+9198' || lpad((g % 100000000)::text, 8, '0'),
  lower(fn) || '.' || lower(ln) || g || '@gmail.com',
  jsonb_build_object(
    'name', fn || ' ' || ln, 'phone', '98' || lpad((g % 100000000)::text, 8, '0'),
    'city', (ARRAY['Pune','Mumbai','Delhi','Jaipur','Indore','Bengaluru','Chennai','Kolkata','Lucknow','Surat'])[1 + g % 10],
    'budget', (ARRAY['<1L','1-5L','5L+'])[1 + g % 3],
    'q1', (ARRAY['Never','Weekly','Daily'])[1 + (g / 3) % 3],
    'goal', (ARRAY['Grow my coaching business','Get more clients on Instagram','Launch a course','Build a personal brand'])[1 + g % 4] || ' ' || g,
    'platforms', CASE g % 3 WHEN 0 THEN '["Instagram"]'::jsonb WHEN 1 THEN '["Instagram","YouTube"]'::jsonb ELSE '["LinkedIn"]'::jsonb END),
  jsonb_build_object('utm_source', (ARRAY['meta','google','organic'])[1 + g % 3], 'utm_campaign', 'camp-' || (g % 40)),
  '{}', jsonb_build_object('q1', g % 4), g % 4, 'webhook', g % 17 = 0,
  ts, ts, ts
FROM (
  SELECT g,
    CASE WHEN g % 10 < 3 THEN 1 ELSE 2 + (g % 11) END AS c,
    (ARRAY['Asha','Ravi','Priya','Karan','Meena','Rohit','Neha','Amit','Sneha','Vikram','Pooja','Arjun'])[1 + g % 12] AS fn,
    (ARRAY['Sharma','Verma','Gupta','Patel','Singh','Iyer','Reddy','Nair','Das','Joshi'])[1 + (g / 12) % 10] AS ln,
    now() - ((g % 365) || ' days')::interval - ((g % 86400) || ' seconds')::interval AS ts
  FROM generate_series(1, 1000000) g
) x;
UPDATE leads l SET search_text = left(lower(concat_ws(' ',
  l.name, l.email_normalised, ltrim(l.phone_normalised, '+'),
  (SELECT string_agg(CASE WHEN jsonb_typeof(a.value) = 'array'
            THEN (SELECT string_agg(x, ' ') FROM jsonb_array_elements_text(a.value) x)
            ELSE a.value #>> '{}' END, ' ')
     FROM jsonb_each(l.answers) a))), 4000);
ANALYZE;
