import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    globalSetup: ["tests/globalSetup.ts"],
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://sabhi:sabhi@localhost:5433/sabhi_leads_test",
      REDIS_URL: "",
      TURNSTILE_SECRET_KEY: "",
      LOG_LEVEL: "silent",
      // Tests call job handlers directly; a local .env with INLINE_JOBS=1 must not fire them in the background.
      INLINE_JOBS: "0",
      ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    },
    fileParallelism: false,
  },
});
