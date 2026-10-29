import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Another lockfile higher up the folder tree would otherwise be taken as the project root.
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["argon2", "bullmq"],
  poweredByHeader: false,
  async headers() {
    return [
      // lead.js is embedded on client sites; cache briefly so fixes roll out quickly.
      { source: "/lead.js", headers: [{ key: "Cache-Control", value: "public, max-age=300" }] },
      {
        source: "/((?!api/ingest|api/hook|lead.js|demo).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
