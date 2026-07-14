# CLAUDE.md — AI Assistant Guide for personalrss

## Project Overview

**personalrss** (package name: `social-rss-bridge`) is a Cloudflare Workers application designed around the **PersonalRSS Three Assemblies (三总成): Generator / Monitor / Push**. It supports subscription management, target tracking, and push notifications via a Telegram Bot.

- **Generator**: Generates RSS 2.0 feeds from targets (e.g. Instagram profiles) served under public paths `/feeds/<id>.xml`.
- **Monitor**: Tracks external data sources (e.g. stocks) and triggers alerts when target conditions are met.
- **Push**: Subscribes to RSS feeds (both external feeds and internal Generator feeds) and pushes updates to a Telegram channel.

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
  db.js                 # All D1 database operations
  rss.js                # RSS 2.0 XML generation (Hono XML response, Beijing timezone)
  telegram.js           # Telegram Bot API HTTP wrappers (sendMessage, setWebhook, etc.)
  telegram_commands.js  # Bot command definitions and /help builder
  proxy.js              # Image & video proxy handlers with host whitelisting
  log.js                # Structured JSON logging (info/warn/error)
  html.js               # escapeHtml, stripHtml utilities
  crawlers/
    instagram.js        # Instagram scraper (unofficial internal API, no auth)

migrations/             # D1 SQL migrations
.github/workflows/deploy.yml  # GitHub Actions deploy workflow
wrangler.toml                 # Cloudflare Workers configuration
deploy.sh                     # One-click setup + deploy shell script
.env.example                  # Template for deployment environment variables
.dev.vars.example             # Template for local development secrets
```

---

## Development & Test Commands

```bash
npm run dev          # Local dev server with local D1 (http://127.0.0.1:8787)
npm run dev:remote   # Local dev server against remote Cloudflare resources
npm run check        # Dry-run deployment check (validates wrangler config)
npm run deploy       # Deploy to Cloudflare Workers production
npm run tail         # Stream live worker logs (wrangler tail)
npm test             # Run test suite via Vitest
```

**Local dev note**: The worker requires secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ADMIN_TOKEN`, etc.) in a `.dev.vars` file (copy from `.dev.vars.example`). The D1 database is auto-created locally by `wrangler dev --local`.

---

## Architecture & Key Concepts

### Request Flow

1. **Public RSS Feed** (`GET /feeds/:id.xml`):
   - Accesses D1 database to serve the cached XML feeds.
   - Note: The old endpoint `/rss/ig/:username` is **DELETED**.

2. **Cron trigger** (`*/5 * * * *`):
   - Triggered every **5 minutes** by Cloudflare Scheduler.
   - Runs Monitor evaluations (`monitor`), Push RSS updates (`push_rss`), and processed Notification Queue (`notification_queue`) every 5 minutes.
   - Runs Generator updates (`generator`) every **10 minutes** (triggered when `minute % 10 === 0`).

3. **Telegram webhook** (`POST /telegram`): Handles subscription commands from the authorized user/chat only.
   - The webhook secret token is validated against a SHA-256 derived key (derived from `ADMIN_TOKEN` via `crypto.subtle.digest`).

### Caching & Deduplication

Posts are deduplicated across three dimensions before insert:
- `canonical_id` — platform-native ID
- `content_hash` — SHA-256 of `title + link`
- `media_type` — `image` | `video`

The cache is trimmed to `CACHE_MAX_POSTS` newest posts per account after each refresh.

### Media Proxy

All images and videos in generated RSS feeds are routed through `/img` and `/media` proxy endpoints.

---

## Configuration & Secrets

### The 7 Runtime Secrets

These secrets must be set via `wrangler secret put` or via GitHub Actions Secrets:

1. `TELEGRAM_BOT_TOKEN` — Telegram Bot token from @BotFather for bot management.
2. `TELEGRAM_CHAT_ID` — Numeric ID of authorized chat (admin only) for alerts.
3. `TELEGRAM_ADMIN_USER_ID` — Only user allowed to issue bot commands (security constraint).
4. `ADMIN_TOKEN` — Token used to authenticate `/admin/*` API calls and to derive the webhook secret using SHA-256.
5. `DEEPSEEK_API_KEY` — API key for generating AI post summaries.
6. `PUSH_TELEGRAM_BOT_TOKEN` — Bot token used specifically for the Push assembly to push updates.
7. `PUSH_TELEGRAM_CHANNEL_ID` — The ID of the private Telegram channel where updates are pushed (e.g. -100xxx).

---

## HTTP API

### RSS Feeds
- `GET /feeds/:id.xml` — Public RSS Feed (replaces deleted `/rss/ig/:username`).

### Proxy
- `GET /img?url=...` — Image proxy (CDN whitelist enforced)
- `GET /media?url=...` — Video proxy (supports Range requests)

### Telegram Webhook & Setup
- `POST /telegram` — Webhook endpoint (authenticated with derived SHA-256 secret header `X-Telegram-Bot-Api-Secret-Token`).
- `POST /setup-webhook` — Configures webhook URL and registers the commands (requires `Authorization: Bearer ***`).
- `POST /admin/sync-telegram-commands` — Sync command menu (requires `Authorization: Bearer ***`).

### Admin
- `GET /admin/probe-stock?code=<code>` — Read-only stock quote probe (requires `Authorization: Bearer ***`).

---

## Telegram Bot Commands

### 🧩 RSS Generator Commands
- `/gen_add instagram <username> [displayName]` — Subscribe/add an Instagram Generator. (Note: Old `/add_ig` is **DELETED**).
- `/gen_list` — List all Generators. (Note: Old `/list` is **DELETED**).
- `/gen_feed <id>` — Show RSS feed path (`/feeds/<id>.xml`). (Note: Old `/feeds` is **DELETED**).
- `/gen_refresh <id>` — Manually refresh a Generator instance. (Note: Old `/refresh_ig` is **DELETED**).
- `/gen_pause <id>` — Pause a Generator.
- `/gen_resume <id>` — Resume a Generator.
- `/gen_remove <id>` — Remove a Generator. (Note: Old `/purge_ig` is **DELETED**).

### 📡 Information Monitor Commands (Monitor Stocks)
- `/monitor_add stock <code> <gte|lte> <price>` — Add a stock monitor alert rule (monitors prices). (Note: Old `/stock_*` commands are **DELETED**).
- `/monitor_list` — List active monitor rules.
- `/monitor_quote stock <code>` — Query real-time stock price行情.
- `/monitor_pause <id>` — Pause a monitor rule.
- `/monitor_resume <id>` — Resume a monitor rule.
- `/monitor_remove <id>` — Remove a monitor rule.

### 📨 Information Push Commands
- `/push_add rss <url>` — Add an RSS feed (such as `/feeds/<id>.xml`) to Push. When first added, **only pushes the latest 1 item** for the first time. (Note: Old `/rss_*` commands are **DELETED**).
- `/push_list` — List active Push subscriptions.
- `/push_refresh <id>` — Force refresh a Push subscription.
- `/push_pause <id>` — Pause a Push subscription.
- `/push_resume <id>` — Resume a Push subscription.
- `/push_remove <id>` — Remove a Push subscription.

### ⚙️ System Commands
- `/status` — Show system status.
- `/help` — Display help (completely removed `/start`).
- `/cancel` — Cancel current conversation flow.
- `/sync_commands` — Force sync Telegram bot commands list.

---

## Deployment

### GitHub Actions Deployment
The project is configured to deploy via GitHub Actions workflow (`.github/workflows/deploy.yml`).
1. Make sure to define the 7 runtime secrets in your GitHub repository secrets.
2. In the repository Actions page, select **Deploy** and click **Run workflow**.

### Local Setup & Manual Deploy
```bash
cp .env.example .env
# Fill in .env details
./deploy.sh
```

---

## Code Conventions

- **ES Modules throughout**: all files use `import`/`export`, no CommonJS
- **No TypeScript**: plain JavaScript; no type annotations
- **Tests**: Vitest-based tests under `tests/`. Run with `npm test`.
- **No linter**: no ESLint/Prettier config; maintain consistent style with existing code
- **Logging**: use `log.info()`, `log.warn()`, `log.error()` from `src/log.js`
- **Database access**: all D1 operations go through `src/db.js`
- **Timezone**: all user-facing dates use Beijing time (UTC+8); internal storage uses ISO UTC
- **Language**: Telegram messages and comments are in Chinese (中文); code identifiers and HTTP API are in English
- **Single authorized chat**: Telegram commands only work from the configured `TELEGRAM_CHAT_ID`.

---

## Database & Migrations

- **Database**: Cloudflare D1 (SQLite dialect).
- **Migrations**: SQL files under `migrations/`.
  - **Migration 0008** (`migrations/0008_drop_legacy_instagram_tables.sql`): Destructive migration that drops legacy Instagram/TikHub tables (`accounts`, `posts_cache`, `crawl_status`, `api_usage`) to clean up runtime footprint. Core tables and their data are preserved: `generator_instances`, `tracker_rules`, `rss_subscriptions`, `notification_queue`, `bot_sessions`, and `daily_usage`.
