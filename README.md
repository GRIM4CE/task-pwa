# Todo PWA

A Next.js 16 PWA with TOTP auth, Turso (libSQL) storage, and a daily cleanup cron.

## Local development

```bash
npm install
npm run dev
```

Open http://localhost:3000.

Required env vars (see `src/lib/env.ts` and `src/db/index.ts`):

- `APP_SECRET` – secret used for session/crypto
- `APP_USERNAME` – comma-separated list of allowed usernames
- `TURSO_DATABASE_URL` – libSQL URL (falls back to `file:./data/local.db` locally)
- `TURSO_AUTH_TOKEN` – Turso auth token (omit for the local file DB)
- `CRON_SECRET` – shared secret the scheduled cleanup job presents as `Authorization: Bearer …`

## Deploy on AWS Amplify Hosting

1. Push this repo to GitHub (already done) and in the Amplify console choose **Host web app → GitHub** and pick the branch you want to deploy (e.g. `main`).
2. Amplify detects Next.js and uses the `amplify.yml` in the repo root. The SSR compute runtime is selected automatically.
3. Set the env vars above under **App settings → Environment variables**. The build runs `npm run db:migrate` against Turso, so `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` must be present at build time as well as runtime.
4. Attach a custom domain under **App settings → Domain management** for a stable URL (the generated `*.amplifyapp.com` URL is also stable per branch).

### Scheduled cleanup (replaces Vercel Cron)

Amplify has no built-in cron, so schedule the cleanup with **Amazon EventBridge Scheduler**:

- Schedule: `cron(0 0 * * ? *)` (daily at 00:00 UTC)
- Target: **HTTPS → API destination** pointing at `https://<your-domain>/api/cron/cleanup`
- Method: `GET`
- Header: `Authorization: Bearer <CRON_SECRET>` (store the secret in AWS Secrets Manager and reference it from the connection)
