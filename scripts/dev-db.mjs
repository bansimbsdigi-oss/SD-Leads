// Local Postgres 16 without Docker. Data lives in .data/pg.
// Usage: pnpm db:start  (keeps running until Ctrl+C)
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";

const dataDir = new URL("../.data/pg", import.meta.url).pathname;
const port = Number(process.env.DEV_DB_PORT ?? 5433);
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "sabhi", password: "sabhi", port, persistent: true });

const fresh = !existsSync(dataDir);
if (fresh) await pg.initialise();
await pg.start();
for (const db of ["sabhi_leads", "sabhi_leads_test"]) {
  try { await pg.createDatabase(db); } catch { /* already exists */ }
}
console.log(`Postgres ready on postgresql://sabhi:sabhi@localhost:${port}/sabhi_leads`);

const stop = async () => { await pg.stop(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
