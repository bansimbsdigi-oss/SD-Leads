# Deploy Sabhi Leads on zbot.sabhidigital.com (replacing the Zoom bot)

A **separate second copy** of Sabhi Leads, next to the existing `sabhi-leads-*` stack. It lives in
`/opt/sabhi-leads-zbot`, has its own database, and is routed by the shared Traefik. No DNS change is needed
(`zbot` already points at 187.127.153.240 and Traefik already holds its certificate).

Files used: `docker-compose.yml` (base) + `deploy/zbot/docker-compose.zbot.yml` (override) + `.env` (from `deploy/zbot/env.zbot.example`).

The override: drops the bundled Caddy (Traefik owns 80/443), joins `traefik-proxy`, adds the Traefik labels for
`zbot.sabhidigital.com` → port 3000, publishes no host ports, caps memory, and shrinks Postgres to fit a shared box.
`COMPOSE_PROJECT_NAME` and `IMAGE_PREFIX` in `.env` keep its containers, volumes and image names apart from the existing stack.

Run everything from your Mac unless noted. Replace `SERVER` with `root@187.127.153.240`.

## 1. Upload the code

From a clone of this repo on your Mac, on the branch with these files:

```bash
git fetch origin claude/vibrant-allen-1dw8l3 && git checkout claude/vibrant-allen-1dw8l3
```

```bash
ssh root@187.127.153.240 "mkdir -p /opt/sabhi-leads-zbot"
```

```bash
git archive --format=tar.gz HEAD | ssh root@187.127.153.240 "cd /opt/sabhi-leads-zbot && tar xzf -"
```

## 2. Create the `.env` on the server

```bash
ssh root@187.127.153.240 "cd /opt/sabhi-leads-zbot && cp deploy/zbot/env.zbot.example .env && chmod 600 .env"
```

Generate the secrets on the server and write them into `.env` (they are never printed here or committed):

```bash
ssh root@187.127.153.240 'cd /opt/sabhi-leads-zbot && \
  sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=$(openssl rand -base64 32)|; \
          s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -hex 32)|; \
          s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|; \
          s|^POSTGRES_APP_PASSWORD=.*|POSTGRES_APP_PASSWORD=$(openssl rand -hex 24)|" .env && \
  grep -c "=$" .env'
```

Back up `ENCRYPTION_KEY` somewhere safe: losing it makes stored integration secrets unreadable.
Add `TURNSTILE_SECRET_KEY` later when you have the real key (empty = check skipped).

## 3. Build the images (Zoom bot still running, no downtime yet)

```bash
ssh root@187.127.153.240 "cd /opt/sabhi-leads-zbot && docker compose -f docker-compose.yml -f deploy/zbot/docker-compose.zbot.yml build app worker"
```

Needs a few GB of free disk; the server has about 20 GB.

## 4. Back up the Zoom bot data, then stop it

```bash
ssh root@187.127.153.240 "cd /opt/zoombot && docker compose exec -T db pg_dump -U zoombot zoombot | gzip > /root/zoombot-backup-\$(date +%F).sql.gz && ls -lh /root/zoombot-backup-*.sql.gz"
```

Check the file size is not tiny, then stop the old stack. `down` without `-v` keeps its data volume:

```bash
ssh root@187.127.153.240 "cd /opt/zoombot && docker compose down"
```

## 5. Start the new copy

```bash
ssh root@187.127.153.240 "cd /opt/sabhi-leads-zbot && docker compose -f docker-compose.yml -f deploy/zbot/docker-compose.zbot.yml up -d db redis"
```

Migrate (runs as the owner role):

```bash
ssh root@187.127.153.240 "cd /opt/sabhi-leads-zbot && docker compose -f docker-compose.yml -f deploy/zbot/docker-compose.zbot.yml run --rm worker sh -c 'DATABASE_URL=\$MIGRATE_URL node_modules/.bin/prisma migrate deploy'"
```

```bash
ssh root@187.127.153.240 "cd /opt/sabhi-leads-zbot && docker compose -f docker-compose.yml -f deploy/zbot/docker-compose.zbot.yml up -d app worker && docker compose -f docker-compose.yml -f deploy/zbot/docker-compose.zbot.yml ps"
```

## 6. Create the first super admin (do not run `db:seed`, it makes demo users)

SSH to the server and type the password at the prompt so it stays out of shell history:

```bash
ssh root@187.127.153.240
```

```bash
cd /opt/sabhi-leads-zbot
read -rsp "Admin password (12+ chars): " P; echo
docker compose -f docker-compose.yml -f deploy/zbot/docker-compose.zbot.yml run --rm \
  -e ADMIN_EMAIL=aditya@sabhidigital.com -e ADMIN_NAME="Aditya" -e ADMIN_PASSWORD="$P" \
  worker sh -c 'DATABASE_URL=$MIGRATE_URL node_modules/.bin/tsx scripts/create-admin.ts'
unset P
```

## 7. Check

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://zbot.sabhidigital.com/api/health
```

Expect `200`, then log in at https://zbot.sabhidigital.com. If it fails:

```bash
ssh root@187.127.153.240 "docker logs --since 5m traefik-qbbp-traefik-1 2>&1 | tail -20"
```

```bash
ssh root@187.127.153.240 "cd /opt/sabhi-leads-zbot && docker compose -f docker-compose.yml -f deploy/zbot/docker-compose.zbot.yml logs --tail=50 app"
```

Common causes: `app` not on `traefik-proxy`, the old zoombot stack still running (two containers claiming the host), wrong port label.

## Roll back to the Zoom bot

```bash
ssh root@187.127.153.240 "cd /opt/sabhi-leads-zbot && docker compose -f docker-compose.yml -f deploy/zbot/docker-compose.zbot.yml down && cd /opt/zoombot && docker compose up -d"
```

Works as long as the old volume and images were not deleted. Do **not** run the Zoom bot cleanup (`down -v`, image removal) until
you are sure the new tool is the one you keep.

## Updating later

Repeat step 1 (upload), then build, migrate and `up -d app worker` from step 3/5. Always include both `-f` files;
running plain `docker compose up` here would start Caddy and fight Traefik for ports 80/443.

## Notes

- **Ingest host:** the app, the ingest API (`/api/hook/*`, `/api/ingest/*`), and `lead.js` all share `zbot.sabhidigital.com`.
  The base Caddy setup splits them onto `ingest.` for isolation; add a second Traefik router (host `ingest...`, path allow-list) if you want that back.
- **Backups:** the bundled `backup` service is disabled (needs `deploy/rclone.conf` for Backblaze B2). Until set up, take a manual dump:
  `docker compose -f docker-compose.yml -f deploy/zbot/docker-compose.zbot.yml exec -T db pg_dump -U sabhi sabhi_leads | gzip > /root/sabhi-leads-zbot-$(date +%F).sql.gz`
- **Rate limiting** is in-memory per process; fine for one app container.
