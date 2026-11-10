#!/usr/bin/env bash
# DEV ONLY: drop and recreate the local database, migrate, and seed the demo data.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
psql "${DATABASE_OWNER_URL%/*}/postgres" -q -c "DROP DATABASE IF EXISTS ${DATABASE_OWNER_URL##*/} WITH (FORCE)"
rm -rf "${STORAGE_DIR:-./storage}"
pnpm -s db:setup
pnpm -s db:seed-demo
