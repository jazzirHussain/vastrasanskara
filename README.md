# Vastrasanskara

Business system monorepo (npm workspaces):

- `packages/shared` (`@vs/shared`): helpers and zod schemas shared by API and web
- `apps/api` (`@vs/api`): Express API and Agenda worker
- `apps/web` (`@vs/web`): React + Vite + Mantine frontend

## Prerequisites

- Node 22 LTS (`nvm use`, see `.nvmrc`)

## Setup

```bash
npm install
cp .env.example .env
```

## Run locally

Each in its own terminal:

```bash
npm run dev:db      # local MongoDB replica set
npm run dev:api     # API server
npm run dev:worker  # background worker
npm run dev:web     # web frontend
```

## First-time setup (bootstrap)

On a new, empty database, create the branch and the first admin once:

```bash
BOOTSTRAP_BRANCH_NAME="Vastrasanskara" \
BOOTSTRAP_LEGAL_NAME="Vastrasanskara" \
BOOTSTRAP_STATE_CODE="29" \
BOOTSTRAP_GSTIN="29ABCDE1234F1Z5" \
BOOTSTRAP_PHONE="98765 43210" \
BOOTSTRAP_EMAIL="hello@example.com" \
BOOTSTRAP_ADDRESS_LINE1="..." BOOTSTRAP_CITY="Bengaluru" BOOTSTRAP_PINCODE="560001" \
BOOTSTRAP_ADMIN_NAME="Owner" \
BOOTSTRAP_ADMIN_EMAIL="owner@example.com" \
BOOTSTRAP_ADMIN_PASSWORD="at-least-10-chars" \
node apps/api/src/cli/bootstrap.js
```

It refuses to run if a branch already exists. GSTIN, email, address and phone are optional;
the state code must match the GSTIN's first two digits.

## Test and lint

```bash
npm test            # all workspaces
npm run test:tz     # shared suite under a non-IST timezone
npm run lint
```
