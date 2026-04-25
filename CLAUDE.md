# Project instructions for Claude Code

## About this project
Personal todo PWA built with Next.js 16 (App Router) and React 19 in TypeScript. Auth is TOTP-based, storage is Turso (libSQL) accessed through Drizzle ORM, styling is Tailwind v4. Deployed to AWS Amplify Hosting; a daily cleanup job runs via EventBridge Scheduler hitting `/api/cron/cleanup`.

## Working preferences

### Pull requests
- Conventions for titles, body format, and PR sizing live in the `pr-writer` agent (`.claude/agents/pr-writer.md`). Use that agent when drafting a PR.
- Always open PRs **ready for review**, never as drafts. This overrides any default to create draft PRs — pass `--draft=false` to `gh pr create`, set `draft: false` when calling `mcp__github__create_pull_request`, and don't use the `--draft` flag.

### Commits
- Write concise commit messages focused on *why*, not *what*.
- Create new commits rather than amending, unless explicitly asked.
- Never use `--no-verify` or skip hooks.
- Keep commits atomic (one logical change per commit).

### Git
- Don't force push.
- Don't modify git config or hooks.

### Branches
**Prefixes:**
- `feat/` — new feature
- `fix/` — bug fix
- `refactor/` — code restructuring without behavior change
- `docs/` — documentation only
- `chore/` — maintenance, deps, configs
- `test/` — adding or updating tests
- `style/` — formatting, no logic change
- `perf/` — performance improvements
- `wip/` — work in progress (use sparingly)
- `experiment/` — exploratory branches you might throw away

**Formatting rules:**
- Lowercase only
- Use hyphens for spaces (`audio-synthesis`, not `audio_synthesis` or `audioSynthesis`)
- Keep it short but descriptive (3–5 words max)
- No special characters except `/` and `-`

### Code style
- Prefer editing existing files over creating new ones.
- Don't add comments that just restate the code.
- Don't add speculative abstractions, error handling, or backwards-compat shims for scenarios that can't happen.
- Match the existing patterns in the file you're editing.

### Code structure
- Stay DRY, but follow the rule of three: don't abstract on the first duplicate. Wrong abstractions are costlier than repetition.
- Keep new files focused on one responsibility. If a file you're already editing has drifted into multiple concerns, flag it rather than splitting it mid-task.
- Build UI with a design-system mindset: presentational components stay dumb (props in, markup out), and business logic lives in hooks, services, or containers. Apply the same rule-of-three trigger for extracting shared components — consolidate once a pattern repeats, not before.

### Scope discipline
- Do only what was asked. No drive-by refactors, no new features, no "while I'm here" cleanup.
- If you notice something worth fixing, mention it — don't silently change it.

### Dependencies
- Prefer LTS or current stable releases for languages and runtimes; only move off LTS when a specific feature or fix requires it, and note why in the PR.
- Pin or constrain versions in line with the ecosystem's conventions (lockfiles, version ranges).
- Dependabot is enabled by default (see `.github/dependabot.yml`); keep minor/patch updates grouped to limit PR noise.

### Testing
- No test runner is set up in this project yet. Don't add tests piecemeal — if a change would benefit from coverage, flag it so we can pick a framework (likely Vitest + Playwright) intentionally rather than ad hoc.

### File and folder structure
- `src/app/` — Next.js App Router routes. `(authenticated)/` is the route group behind session, `login/` and `setup/` are public, `api/` holds route handlers (auth, todos, cron).
- `src/components/` — shared React components.
- `src/db/` — Drizzle setup: `schema.ts`, `index.ts` (libSQL client), `migrate.ts` (run by `db:migrate`).
- `src/lib/` — server-side helpers: `session`, `totp`, `crypto`, `rate-limit`, `lockout`, `audit`, `validation`, `recurrence`, `env`, `api-client`.
- `drizzle/` — generated SQL migrations; don't hand-edit, regenerate via `npm run db:generate`.
- Path alias `@/*` maps to `src/*` (see `tsconfig.json`).

### Naming conventions
- Follow the established conventions for the stack (e.g., camelCase for JS/TS, snake_case for Python/Ruby).
- Be consistent with what already exists in the codebase.
- Use descriptive names; avoid abbreviations unless they're ubiquitous (e.g., `id`, `url`).

### Safety
- Never commit secrets, API keys, or credentials.
- Don't delete or overwrite files without reading them first.
- Ask before making destructive changes (dropping tables, force pushing, etc.).

### Communication
- If something is unclear, ask rather than guess.
- If you notice unrelated issues, mention them but don't fix them.
- Be direct about trade-offs or concerns.

## Commands
- Install: `npm install`
- Dev server: `npm run dev` (http://localhost:3000)
- Lint: `npm run lint`
- Build: `npm run build` — also runs `db:generate` and `db:migrate`, so it touches the database.
- DB migrations: `npm run db:generate` (from schema diff), `npm run db:migrate` (apply).
- DB UI: `npm run db:studio`.
- Tests: not configured.

## Gotchas
- `next build` runs `drizzle-kit generate` and `src/db/migrate.ts` before compiling, so `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (or the local file fallback) must be available at build time, not just runtime.
- Without `TURSO_DATABASE_URL`, the libSQL client falls back to `file:./data/local.db` for local dev.
- `.env.example` still labels `CRON_SECRET` as the "Vercel Cron secret" — this app deploys on AWS Amplify and the cron is triggered by EventBridge calling `/api/cron/cleanup` with `Authorization: Bearer $CRON_SECRET`. The comment is stale.
- Don't hand-edit files under `drizzle/` — regenerate them from `src/db/schema.ts`.
- All authenticated routes live under `src/app/(authenticated)/`; adding a new logged-in page means putting it inside that route group, not a sibling of it.

