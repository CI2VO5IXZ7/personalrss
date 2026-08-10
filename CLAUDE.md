# CLAUDE.md — AI Assistant Guide for personalrss

## Project Overview

**personalrss** (package: `social-rss-bridge`) is a Cloudflare Workers app that converts Instagram profiles and A-share stock quotes into standard RSS 2.0 feeds. It uses a Generator provider pattern and a web admin panel for management.

- **Generator**: Produces RSS 2.0 feeds from registered providers (Instagram, Stock) under `/feeds/<id>.xml`.
- **Web Admin**: Dark-themed management UI at `/admin` with Bearer token auth.

**Runtime**: Cloudflare Workers (edge serverless, V8 isolates)
**Language**: JavaScript ES Modules
**Framework**: Hono 4.x
**Database**: Cloudflare D1 (SQLite)
**Node version**: 20 (`.nvmrc`), CI uses 22

---

## Repository Structure

```
src/
  index.js                               # Hono app: routes, cron handler
  admin/routes.js                         # Admin API (CRUD, status) with Bearer auth
  admin/page.js                           # Single HTML template — dark theme admin panel
  proxy.js                                # Image & video proxy (Instagram CDN whitelist)
  log.js                                  # Structured JSON logging (info/warn/error)
  html.js                                 # escapeHtml, stripHtml
  security/url.js                         # SSRF protection: DoH resolution, safeFetch, redactUrl
  generators/
    core/contract.js                      # Provider interface contract + item normalization
    core/renderer.js                      # RSS 2.0 XML renderer (Beijing timezone)
    core/repository.js                    # D1 CRUD for generator_instances/items/status
    core/routes.js                        # Public feed routes (/feeds/:id.xml)
    core/scheduler.js                     # Cron scheduler (concurrent refresh with rate limiting)
    core/service.js                       # Generator orchestration (create/list/refresh/pause/resume/remove)
    providers/
      instagram/index.js                  # Instagram provider (scrapes public profiles)
      instagram/fetcher.js                # Low-level IG API calls (no auth required)
      stock/index.js                      # A-share stock provider (Sina/Tencent quotes)
    registry.js                           # Static provider registry (instagram, stock)

migrations/                               # D1 SQL migrations (0001_init → 0011_remove_monitor)
.github/workflows/deploy.yml              # GitHub Actions deploy workflow
wrangler.toml                             # Cloudflare Workers config
deploy.sh                                 # One-click setup + deploy script
```

---

## Development Commands

```bash
npm run dev          # Local dev (http://127.0.0.1:8787) with local D1
npm run dev:remote   # Local dev against remote Cloudflare resources
npm run check        # Dry-run deployment check
npm run deploy       # Deploy to production
npm run tail         # Stream live worker logs
npm test             # Vitest test suite (14 files, 275 tests)
```

**Local dev**: Requires `ADMIN_TOKEN` in `.dev.vars` (copy from `.dev.vars.example`). D1 is auto-created by `wrangler dev --local`.

---

## Architecture

### Request Flow

1. **RSS Feed** (`GET /feeds/:id.xml`) — Public. Renders cached items as RSS 2.0 XML from D1.
2. **Admin Panel** (`GET /admin`) — Bearer auth. Self-contained HTML page with inline CSS/JS.
3. **Admin API** (`/api/*`) — Bearer auth (`Authorization: Bearer <ADMIN_TOKEN>`). CRUD for generators.
4. **Proxy** (`/img`, `/media`) — Public. Whitelisted to Instagram CDN domains only.

### Cron

- Trigger: `*/10 * * * *`
- Runs Generator refresh for all due instances
- Concurrent execution with configurable limit (`REFRESH_CONCURRENCY`, default 3)
- Each instance: fetch → normalize → save items → trim to `CACHE_MAX_POSTS`

### Generator Provider Contract

Each provider implements:
- `type` — string identifier (e.g. `instagram`, `stock`)
- `displayName` — human-readable name
- `validateConfig(config, context)` — validate and normalize config
- `fetchItems(instance, context)` — return `{items: [...], meta: {...}}`
- `normalizeItem(raw, instance, context)` — convert raw data to normalized item
- `buildFeedMeta(instance, context)` — return `{title, link, description, language}`

---

## Configuration

### Runtime Secret

| Secret | Purpose |
|:---|:---|
| `ADMIN_TOKEN` | Bearer token for `/admin` and `/api/*` endpoints |

### Wrangler Vars

| Var | Default | Purpose |
|:---|:---|:---|
| `CACHE_MAX_POSTS` | 100 | Max cached items per generator |
| `REFRESH_CONCURRENCY` | 3 | Max concurrent generator refreshes |
| `BASE_URL` | (deployed URL) | Worker base URL |

---

## Testing

- **Framework**: Vitest
- **14 test files, 275 tests**
- Key test areas: generator contract/service/repository/renderer/scheduler, stock/instagram providers, admin API, migrations, security/URL, cron

---

## Code Conventions

- **ES Modules** throughout (`import`/`export`)
- **Plain JavaScript** — no TypeScript
- **No linter** configured
- Tests follow existing patterns with vitest mocks
