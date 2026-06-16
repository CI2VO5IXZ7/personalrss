# CLAUDE.md — AI Assistant Guide for personalrss

## Project Overview

**personalrss** (package name: `social-rss-bridge`) is a Cloudflare Workers application that converts Instagram social media profiles into RSS 2.0 feeds, with a Telegram Bot interface for subscription management.

> Note: Xiaohongshu (小红书 / TikHub) support has been removed. Only Instagram remains. The `accounts.platform` / `posts_cache.platform` columns and a few historical migrations (e.g. `0003_api_usage.sql`) still exist for backward compatibility but are no longer exercised.

**Runtime**: Cloudflare Workers (edge serverless, V8 isolates)
**Language**: JavaScript ES Modules
**Framework**: Hono 4.x
**Database**: Cloudflare D1 (SQLite dialect)
**Node version**: 20 (see `.nvmrc`), CI uses 22

---

## Repository Structure

```
src/
  index.js              # Main Hono app: HTTP routes, cron handler, Telegram command dispatch
  db.js                 # All D1 database operations (accounts, posts cache, crawl status)
  rss.js                # RSS 2.0 XML generation (Hono XML response, Beijing timezone)
  telegram.js           # Telegram Bot API HTTP wrappers (sendMessage, setWebhook, etc.)
  telegram_commands.js  # Bot command definitions and /help builder
  proxy.js              # Image & video proxy handlers with host whitelisting
  log.js                # Structured JSON logging (info/warn/error)
  html.js               # escapeHtml, stripHtml utilities
  crawlers/
    instagram.js        # Instagram scraper (unofficial internal API, no auth)

migrations/
  0001_init.sql                        # Initial schema (accounts, posts_cache, settings)
  0002_fix_unique_constraint.sql       # Add user_id to posts_cache unique key
  0003_api_usage.sql                   # api_usage table (legacy, no longer written to)
  0004_post_meta_and_crawl_status.sql  # canonical_id, content_hash, media_type; crawl_status table

.github/workflows/deploy.yml  # Manual GitHub Actions deploy (workflow_dispatch only)
wrangler.toml                 # Cloudflare Workers configuration (bindings, cron, vars)
deploy.sh                     # One-click setup + deploy shell script
.env.example                  # Template for deployment environment variables
.dev.vars.example             # Template for local development secrets
```

---

## Development Commands

```bash
npm run dev          # Local dev server with local D1 (http://127.0.0.1:8787)
npm run dev:remote   # Local dev server against remote Cloudflare resources
npm run check        # Dry-run deployment check (validates wrangler config)
npm run deploy       # Deploy to Cloudflare Workers production
npm run tail         # Stream live worker logs (wrangler tail)
```

There are **no tests** and **no linter** configured. `npm run check` (dry-run) is the closest to validation.

**Local dev note**: The worker requires secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ADMIN_TOKEN`) in a `.dev.vars` file (copy from `.dev.vars.example`). The D1 database is auto-created locally by `wrangler dev --local`.

---

## Architecture & Key Concepts

### Request Flow

1. **RSS endpoint** (`GET /rss/ig/:username`):
   - Account must be in the whitelist (D1 `accounts` table)
   - Returns cached posts immediately
   - Triggers background refresh if cache is stale (`CACHE_TTL_MINUTES`)

2. **Cron trigger** (`*/10 * * * *`): Refreshes all whitelisted accounts in parallel (bounded by `REFRESH_CONCURRENCY`)

3. **Telegram webhook** (`POST /telegram`): Handles subscription commands from the authorized chat only

### Caching & Deduplication

Posts are deduplicated across three dimensions before insert:
- `canonical_id` — platform-native ID
- `content_hash` — SHA-256 of `title + link`
- `media_type` — `image` | `video`

The cache is trimmed to `CACHE_MAX_POSTS` newest posts per account after each refresh.

### Media Proxy

All images and videos in generated RSS feeds are routed through `/img` and `/media` proxy endpoints. This:
- Prevents dead links if the CDN URL changes
- Bypasses hotlink protection on Instagram CDNs
- Supports HTTP Range requests for video streaming

The proxy enforces a host whitelist — only approved CDN domains are proxied.

---

## Database Schema

### `accounts`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| platform | TEXT | `instagram` (XHS removed) |
| user_id | TEXT | Platform-native user identifier |
| display_name | TEXT | Human-readable label |
| created_at | TEXT | ISO timestamp |
| UNIQUE(platform, user_id) | | |

### `posts_cache`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| platform | TEXT | |
| user_id | TEXT | |
| post_id | TEXT | |
| canonical_id | TEXT | Dedup by platform ID |
| content_hash | TEXT | SHA-256 of title+link |
| media_type | TEXT | `image` or `video` |
| title | TEXT | |
| description | TEXT | |
| link | TEXT | |
| image | TEXT | Proxied URL |
| raw_images | TEXT | JSON array |
| date | TEXT | ISO timestamp |
| fetched_at | TEXT | |
| UNIQUE(platform, user_id, post_id) | | |

### `crawl_status`
Tracks per-account crawl health:
- `last_result`: `success` | `error` | `empty`
- `consecutive_failures`: integer, triggers Telegram alert at `FAILURE_ALERT_THRESHOLD`
- `last_error`, `last_error_at`, `last_duration_ms`, etc.

### `api_usage`
Legacy table from the removed TikHub/XHS integration. No longer written to or read by the application code.

---

## Configuration

### `wrangler.toml` Variables (non-secret)

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | (set in wrangler.toml) | Public worker URL, used in RSS/webhook links |
| `CACHE_TTL_MINUTES` | `60` | Minutes before cached feed is considered stale |
| `CACHE_MAX_POSTS` | `100` | Max posts retained per account in D1 |
| `REFRESH_CONCURRENCY` | `3` | Max simultaneous account refreshes |
| `FAILURE_ALERT_THRESHOLD` | `3` | Consecutive crawl failures before Telegram alert |

### Secrets (set via `wrangler secret put` or `deploy.sh`)

| Secret | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Numeric ID of authorized chat (admin only) |
| `ADMIN_TOKEN` | Token for `/admin/*` HTTP endpoints and webhook verification |

---

## HTTP API

### RSS Feeds
- `GET /rss/ig/:username` — Instagram RSS (account must be in whitelist)

### Proxy
- `GET /img?url=...` — Image proxy (CDN whitelist enforced)
- `GET /media?url=...` — Video proxy (supports Range requests)

### Telegram
- `POST /telegram` — Webhook (requires `X-Telegram-Bot-Api-Secret-Token: <ADMIN_TOKEN>`)
- `POST /setup-webhook` — Configure bot webhook + sync commands (requires `Authorization: Bearer <ADMIN_TOKEN>`)
- `POST /admin/sync-telegram-commands` — Sync command menu only (requires `Authorization: Bearer <ADMIN_TOKEN>`)

### Admin
- `POST /admin/refresh` — Trigger manual full refresh (requires `Authorization: Bearer <ADMIN_TOKEN>`)

---

## Telegram Bot Commands

| Command | Description |
|---|---|
| `/add_ig <username>` | Subscribe to Instagram profile |
| `/remove_ig <username>` | Remove Instagram subscription |
| `/list` | List all subscribed accounts |
| `/feeds` | Show RSS feed URLs |
| `/status` | Show crawl status per account |
| `/refresh` | Force refresh all accounts |
| `/refresh_ig <username>` | Force refresh one Instagram account |
| `/purge_ig` | Delete all cached Instagram posts |
| `/sync_commands` | Re-sync bot command menu |
| `/help` | Show help message |

---

## Deployment

### First-time Setup
```bash
cp .env.example .env
# Fill in .env with your credentials
./deploy.sh
```
`deploy.sh` handles: D1 database creation, migrations, worker deploy, secret injection, Telegram webhook setup.

### Subsequent Deploys
```bash
npm run deploy
# Or via GitHub Actions: Actions → Deploy → Run workflow
```

### Applying Migrations
```bash
wrangler d1 migrations apply social-rss-bridge-db --remote
```

### CI/CD
GitHub Actions workflow (`.github/workflows/deploy.yml`) is manual-trigger only (`workflow_dispatch`). It uses `pnpm` and Node 22 in CI. Automatic deploys are disabled.

---

## Code Conventions

- **ES Modules throughout**: all files use `import`/`export`, no CommonJS
- **No TypeScript**: plain JavaScript; no type annotations
- **No tests**: no test framework installed; validate logic manually or with dry-run
- **No linter**: no ESLint/Prettier config; maintain consistent style with existing code
- **Logging**: use `log.info()`, `log.warn()`, `log.error()` from `src/log.js` — not `console.log`
- **Database access**: all D1 operations go through `src/db.js`; never write raw SQL in `index.js`
- **Error handling**: crawl errors are caught and stored in `crawl_status`; they do not crash the worker
- **Cloudflare globals**: use `crypto.subtle` for hashing, `fetch` for HTTP — these are available natively in Workers
- **Timezone**: all user-facing dates use Beijing time (UTC+8); internal storage uses ISO UTC
- **Language**: Telegram messages, comments in crawler files, and operational strings are in Chinese (中文); code identifiers and HTTP API are in English

---

## Common Tasks

### Add a new platform crawler
1. Create `src/crawlers/<platform>.js` following the pattern of `instagram.js`
2. Add account CRUD functions to `db.js` (or reuse existing with a new `platform` value)
3. Add RSS route in `index.js`
4. Add Telegram commands in `telegram_commands.js` and handlers in `index.js`
5. Write a migration if new schema is needed

### Add a new database column
1. Create `migrations/000N_description.sql` with `ALTER TABLE` statements
2. Apply locally: `wrangler d1 migrations apply social-rss-bridge-db --local`
3. Apply remotely after deploy: `wrangler d1 migrations apply social-rss-bridge-db --remote`
4. Update the relevant functions in `db.js`

### Debugging live issues
```bash
npm run tail           # Stream structured JSON logs from the live worker
# Or in Cloudflare dashboard: Workers → personalrss → Logs
```

### Testing locally
```bash
cp .dev.vars.example .dev.vars
# Fill in .dev.vars with real credentials
npm run dev
# Access: http://127.0.0.1:8787
```

---

## Important Constraints

- **Whitelist enforced**: RSS endpoints return 403 if the account is not in `accounts` table. Add accounts via Telegram `/add_ig` — never bypass the whitelist.
- **Single authorized chat**: Telegram commands only work from the configured `TELEGRAM_CHAT_ID`. This is intentional — do not add multi-user auth without careful review.
- **No KV store**: A previous version used Cloudflare KV; it has been fully migrated to D1. Do not reintroduce KV.
- **Worker CPU limits**: Cloudflare Workers have a 10–50ms CPU time budget per request. Avoid heavy synchronous computation; use `waitUntil` for background work (already done in refresh logic).
