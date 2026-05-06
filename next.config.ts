import type { NextConfig } from "next";
import { execSync } from "node:child_process";

function resolveBuildId(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return Date.now().toString(36);
  }
}

const buildId = resolveBuildId();

const nextConfig: NextConfig = {
  env: {
    BUILD_ID: buildId,
  },
  generateBuildId: async () => buildId,
  async redirects() {
    return [
      // /stats and /settings were merged into /hub. Keep the old paths working
      // for bookmarks and any external links. /stats?tab=completed used to
      // drive the in-page tab; that view now has its own URL.
      {
        source: "/stats",
        has: [{ type: "query", key: "tab", value: "completed" }],
        destination: "/hub/completed",
        permanent: true,
      },
      { source: "/stats", destination: "/hub", permanent: true },
      { source: "/settings", destination: "/hub/settings", permanent: true },
    ];
  },
};

export default nextConfig;
