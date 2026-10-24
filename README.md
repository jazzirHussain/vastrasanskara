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

## Test and lint

```bash
npm test            # all workspaces
npm run test:tz     # shared suite under a non-IST timezone
npm run lint
```
