# RPPC One-Stop Operations System

This is a test repo for RPPC system.

Spec: [docs/SPEC.md](docs/SPEC.md) (v0.5) · rules for contributors and Claude Code: [CLAUDE.md](CLAUDE.md) · status: [docs/CHANGELOG.md](docs/CHANGELOG.md)

TypeScript monorepo: `apps/web` (Next.js UI + `/api/v1`), `packages/db` (migrations + domain services), `packages/core` (RBAC catalog, guards, state machines, pure rules), `packages/pdf` (DR / gate pass), `scripts` (setup, seed, worker, checks).

## Run it locally
Needs Node 22, pnpm 10, PostgreSQL 16 (or `docker compose -f ops/docker-compose.yml up -d`). Chromium via Playwright for PDFs.

```bash
pnpm install
cp .env.example .env            # then set APP_ENCRYPTION_KEY=$(openssl rand -base64 32) and FILE_SCAN=dev-skip
pnpm db:setup                   # creates the DB, applies migrations, sets the app_user password
pnpm db:seed-demo               # dev only: a user per role + a client, proposal, two trips (prints logins)
pnpm build && pnpm start        # http://localhost:3000
pnpm worker                     # background jobs (weekly payroll, reminders, nightly audit check)
```
Office roles that require MFA set up TOTP at first sign-in. Field users sign in with the PIN and the device ID printed by the seed.

## Checks (§19.4)
```bash
pnpm run check   # static route-permission check + typecheck + 111 tests against a real Postgres
```
`scripts/smoke-http.ts` drives the whole order-to-delivery flow over HTTP against a running server.
