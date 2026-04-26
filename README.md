# Todo PWA

A Next.js 16 PWA with TOTP auth, Turso (libSQL) storage, and a daily cleanup cron.

## Local development

No Turso account or external services required — the app falls back to a local SQLite file and TOTP auth runs entirely on-device.

```bash
cp .env.example .env.local      # then fill in APP_SECRET and APP_USERNAME
npm install
npm run db:migrate              # create the local SQLite schema at data/local.db
npm run dev
```

Open http://localhost:3000 — you'll be redirected to `/setup` on the first visit. Scan the QR code with any TOTP app (Google Authenticator, 1Password, Bitwarden, etc.), enter the 6-digit code, and save the recovery codes. After that, `/login` accepts your username + current 6-digit code.

To test from a phone on the same network, hit `http://<your-laptop-ip>:3000/setup` instead. The session cookie's `secure` flag is off when `NODE_ENV !== "production"`, so HTTP over LAN works.

To reset auth state, delete `data/local.db` and re-run `npm run db:migrate`.

### Env vars

See `.env.example` for the full list. Generate `APP_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- `APP_SECRET` – secret used for session/crypto (required)
- `APP_USERNAME` – comma-separated list of allowed usernames (defaults to `admin`)
- `TURSO_DATABASE_URL` – libSQL URL; leave blank locally to use `file:./data/local.db`
- `TURSO_AUTH_TOKEN` – Turso auth token; omit for the local file DB
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
