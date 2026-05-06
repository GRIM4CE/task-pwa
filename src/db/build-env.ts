// Shared guard for build-time DB scripts.
//
// `migrate.ts` and `reenroll.ts` both fall back to `file:./data/local.db` when
// TURSO_DATABASE_URL is unset, which is the right behavior for local dev. In a
// hosted build (e.g. Amplify), that fallback silently writes to a throwaway
// SQLite file inside the disposable build container — every migration appears
// to apply but production stays on the prior schema. This is exactly the
// failure mode that hid migration 0010 from production for an entire release
// cycle.
//
// Calling this at the top of a build-time script makes that misconfiguration
// loud: if we're running in any CI/hosted build and TURSO_DATABASE_URL is
// missing, abort with a clear error before any work happens.

export function assertTursoConfiguredInHostedBuild(): void {
  // Amplify Gen 2 + CodeBuild doesn't reliably expose `AWS_BRANCH` /
  // `AMPLIFY_APP_ID` to npm-script subprocesses, but `CI=true` and
  // `CODEBUILD_BUILD_ID` are. Detect a hosted build via any of these so
  // the safety check can't be skipped just because Amplify renamed an
  // env var.
  const inHostedBuild = Boolean(
    process.env.AWS_BRANCH ||
      process.env.AMPLIFY_APP_ID ||
      process.env.AWS_APP_ID ||
      process.env.CODEBUILD_BUILD_ID ||
      process.env.CI === "true" ||
      process.env.CI === "1"
  );
  if (!inHostedBuild) return;

  const missing: string[] = [];
  if (!process.env.TURSO_DATABASE_URL) missing.push("TURSO_DATABASE_URL");
  if (!process.env.TURSO_AUTH_TOKEN) missing.push("TURSO_AUTH_TOKEN");
  if (missing.length === 0) return;

  console.error(
    `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set in this hosted build environment.\n` +
    "Without TURSO_DATABASE_URL, db scripts silently fall back to a local SQLite file " +
    "in the build container, so migrations and writes never reach production. " +
    "TURSO_AUTH_TOKEN is required alongside it to authenticate against the remote DB. " +
    "Aborting before any work happens.\n" +
    "Fix: set both as plaintext environment variables in the Amplify app settings, then redeploy."
  );
  process.exit(1);
}
