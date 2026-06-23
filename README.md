# Social RSS Bridge

将 Instagram 账号内容转成 RSS 2.0 Feed，运行在 Cloudflare Workers 上，并通过 Telegram Bot 完成订阅管理、状态查看和运维操作。

## 当前功能

- Instagram RSS：抓取公开账号主页内容并输出 RSS。
- 缓存去重：基于 `canonical_id`、`content_hash`、`media_type` 去重，减少历史别名 ID 导致的重复条目。
- 媒体代理：图片和视频分别通过 `/img`、`/media` 代理，避免直链失效。
- Telegram Bot 管理：支持添加、删除、刷新、清缓存、查看状态、查看 RSS 链接。
- Telegram 命令菜单同步：支持把机器人命令菜单同步为当前代码中的完整命令集。
- 抓取状态与告警：记录最近成功/失败、连续失败次数、最近错误，并在达到阈值时发送 Telegram 告警。
- 定时刷新：Cloudflare Cron 每 30 分钟刷新一次全部订阅缓存，避免 Instagram 对 Cloudflare/机房 IP 高频风控。

## 运行要求

- Cloudflare Workers + D1
- Telegram Bot Token
- Node.js 20

仓库内 `.nvmrc` 当前要求：

```txt
20
```

## 项目结构

```txt
Cloudflare Worker
├─ Hono 路由
├─ Instagram 抓取
├─ D1
│  ├─ accounts
│  ├─ posts_cache
│  └─ crawl_status
├─ /img 媒体图片代理
├─ /media 视频代理
├─ Telegram Webhook
└─ Cron Trigger
```

## 环境变量与 Secrets

### 1. 部署脚本使用

`deploy.sh` 支持两种 Cloudflare 认证方式：

- 浏览器授权登录：推荐。先执行 `npx wrangler login`，然后 `.env` 里不用填 `CF_ACCOUNT_ID` / `CF_API_TOKEN`
- API Token：适合 CI 或纯命令行环境

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CF_ACCOUNT_ID` | 否 | 使用 API Token 认证时需要的 Cloudflare Account ID |
| `CF_API_TOKEN` | 否 | 使用 API Token 认证时需要，需具备 Workers / D1 编辑权限 |

### 2. Worker 运行时变量

这些变量可以放在 `wrangler.toml` 的 `[vars]` 中：

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `BASE_URL` | 建议 | 当前线上域名 | RSS 链接、Webhook 设置、Telegram 输出里使用的基础域名 |
| `CACHE_TTL_MINUTES` | 否 | `60` | RSS 请求触发后台刷新时的缓存过期分钟数 |
| `CACHE_MAX_POSTS` | 否 | `100` | 每个账号在 `posts_cache` 中最多保留的帖子数量 |
| `REFRESH_CONCURRENCY` | 否 | `3` | 全量刷新时的并发账号数；Instagram 非公开接口容易 401/429，不建议调高 |
| `FAILURE_ALERT_THRESHOLD` | 否 | `3` | 连续失败达到该次数后发送 Telegram 告警 |

### 3. Worker Secrets

这些变量建议通过 `wrangler secret put` 设置：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram 功能必填 | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | Telegram 功能必填 | 允许操作机器人的目标 Chat ID |
| `ADMIN_TOKEN` | 是 | 管理接口认证 Token，同时也作为 Telegram Webhook Secret Token |

## 部署

### 1. 安装依赖

```bash
npm install
```

### 2. Cloudflare 浏览器授权登录

如果你不想手填 `CF_ACCOUNT_ID` 和 `CF_API_TOKEN`，先执行：

```bash
npx wrangler login
```

登录完成后，`.env` 里的这两个字段可以留空，`./deploy.sh` 会直接复用 Wrangler 的网页授权登录态。

### 3. 创建 D1 数据库并执行迁移

如果你不是通过 `deploy.sh` 一键部署，需要确保 D1 已创建并执行全部迁移：

```bash
npx wrangler d1 migrations apply social-rss-bridge-db
```

### 4. 部署 Worker

```bash
npx wrangler deploy
```

### 5. 设置 Telegram Webhook 并同步机器人命令菜单

部署完成后，调用：

```bash
curl -X POST "https://<your-worker-domain>/setup-webhook" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

这个接口会同时完成两件事：

- 设置 Telegram Webhook 到 `/telegram`
- 调用 Telegram `setMyCommands`，把机器人命令菜单同步成当前代码支持的命令

## 对外接口

### RSS 与代理接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/rss/ig/:username` | Instagram RSS |
| `GET` | `/img?url=...` | 图片代理 |
| `GET` | `/media?url=...` | 视频代理 |

### Telegram 与管理接口

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/telegram` | Telegram Webhook Secret | Telegram Webhook 接收入口 |
| `POST` | `/setup-webhook` | `Authorization: Bearer <ADMIN_TOKEN>` | 设置 Telegram Webhook，并同步命令菜单 |
| `POST` | `/admin/refresh` | `Authorization: Bearer <ADMIN_TOKEN>` | 手动刷新全部缓存 |
| `POST` | `/admin/sync-telegram-commands` | `Authorization: Bearer <ADMIN_TOKEN>` | 单独同步 Telegram 命令菜单 |

### 已关闭的公开页面

以下页面当前默认关闭，不再对外公开：

- `/`
- `/status`

服务状态查看统一通过 Telegram `/status` 完成。

## Telegram 命令

### 订阅管理

| 命令 | 说明 |
| --- | --- |
| `/add_ig <username> [displayName]` | 添加 Instagram 订阅 |
| `/remove_ig <username>` | 删除 Instagram 订阅 |
| `/list` | 列出当前全部订阅 |

### 运维命令

| 命令 | 说明 |
| --- | --- |
| `/feeds` | 列出所有 RSS 链接 |
| `/status` | 查看服务状态、抓取摘要和异常账号 |
| `/refresh` | 手动刷新全部缓存 |
| `/refresh_ig <username>` | 刷新单个 Instagram 订阅 |
| `/purge_ig` | 清理全部 Instagram 缓存 |
| `/sync_commands` | 同步 Telegram 机器人命令菜单 |
| `/help` | 显示帮助 |
| `/start` | 显示帮助 |

## 抓取与缓存行为

### Instagram

- RSS 请求优先读取缓存。
- 缓存过期或为空时，后台异步刷新。

### 去重与裁剪

- `posts_cache` 会存储：
  - `canonical_id`
  - `content_hash`
  - `media_type`
- 写入后会自动去重。
- 每个账号缓存会按 `CACHE_MAX_POSTS` 自动裁剪旧数据。

## 状态、日志与告警

系统会记录每个账号的：

- 最近一次尝试时间
- 最近一次成功时间
- 最近结果
- 最近错误
- 连续失败次数
- 最近帖子数
- 最近新增数
- 最近耗时

当连续失败次数达到 `FAILURE_ALERT_THRESHOLD` 时，会向 Telegram 发送告警。

## 本地开发与检查

### 安装依赖

```bash
npm install
```

### 本地启动

Wrangler 本地调试默认读取 `.dev.vars`，不是 `.env`。先复制模板：

```bash
cp .dev.vars.example .dev.vars
```

然后执行本地 D1 迁移并启动：

```bash
npx wrangler d1 migrations apply social-rss-bridge-db --local
npm run dev
```

默认地址：

```txt
http://127.0.0.1:8787
```

如果你想直接连 Cloudflare 远端资源调试，可用：

```bash
npm run dev:remote
```

### 本地构建检查

```bash
npm run check
```

### 推荐检查项

- `npm install`
- `npx wrangler d1 migrations apply social-rss-bridge-db --local`
- `npm run check`
- Telegram 命令菜单同步后，手动在机器人里执行 `/help` 和 `/sync_commands`

## 常见运维操作

### 手动刷新全部缓存

```bash
curl -X POST "https://<your-worker-domain>/admin/refresh" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

### 单独同步 Telegram 命令菜单

```bash
curl -X POST "https://<your-worker-domain>/admin/sync-telegram-commands" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

### 通过 Telegram 添加订阅

```txt
/add_ig Silencewang.0917 汪苏泷的ins
```

## 说明

- 只有已加入白名单的账号才允许通过 RSS 接口访问。
- RSS 页面本身不再提供公开索引页。
