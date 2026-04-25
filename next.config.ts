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
};

export default nextConfig;
