# PodAds

Cloudflare-first monorepo for podcast feed registration, background episode processing, and canonical de-aded feed delivery.

## Workspace

- `ui`: React + Vite frontend with CSS Modules and shared design tokens
- `workers/api`: public API, RSS rendering, audio proxying, and scheduled feed refresh
- `workers/processor`: queue consumer for transcript, ad-detection, and rewrite work
- `packages/shared`: shared API contracts and queue message types

## Core Scripts

- `bun run dev:ui`: start the frontend locally
- `bun run typecheck`: run TypeScript checks across the workspace
- `bun run lint`: run the current lint/type validation commands
- `bun run types`: regenerate Cloudflare Worker binding types with Wrangler

## CI Deploys

Pushes to `main` trigger `.github/workflows/deploy.yml`, which:

- typechecks the Bun workspace
- typechecks `services/transcriber`
- builds and deploys `ui` to Cloudflare Pages
- deploys `workers/api` to Cloudflare Workers
- deploys `workers/processor` to Cloudflare Workers
- deploys `services/transcriber` to Railway

Required GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `RAILWAY_TOKEN`

## Database

The initial D1 schema lives at `workers/api/schema/001_initial.sql`.

The API worker is configured with `migrations_dir: "./schema"` so future `wrangler d1 migrations` commands target that directory.

No migrations are applied automatically from this repo. Apply them intentionally when you are ready.
