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
    },
    fileParallelism: false,
  },
});
