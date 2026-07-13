# Social RSS Bridge

将 Instagram 账号内容转成 RSS 2.0 Feed，运行在 Cloudflare Workers 上，并通过 Telegram Bot 完成订阅管理、状态查看和运维操作。

## 当前功能

- Instagram RSS：抓取公开账号主页内容并输出 RSS。
- 缓存去重：基于 `canonical_id`、`content_hash`、`media_type` 去重，减少历史别名 ID 导致的重复条目。
- 媒体代理：图片和视频分别通过 `/img`、`/media` 代理，避免直链失效。
- Telegram Bot 管理：支持添加、删除、刷新、清缓存、查看状态、查看 RSS 链接。
- Telegram 命令菜单同步：支持把机器人命令菜单同步为当前代码中的完整命令集。
- 抓取状态与告警：记录最近成功/失败、连续失败次数、最近错误，并在达到阈值时发送 Telegram 告警。
- 定时刷新：Cloudflare Cron 每 10 分钟刷新一次全部订阅缓存，保证内容时效性。
- HTTP 兜底刷新：当某账号连续触发 Instagram 401/403/429 风控时，自动通过公网 Worker URL 再尝试一次受保护的单账号刷新（best-effort）。

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
| `ENABLE_HTTP_FALLBACK_REFRESH` | 否 | `true` | 是否启用 HTTP 兜底刷新；设为 `false` 可完全关闭 |
| `FALLBACK_REFRESH_FAILURE_THRESHOLD` | 否 | `3` | 连续命中风控状态码达到该次数后触发一次 HTTP 兜底刷新 |
| `FALLBACK_REFRESH_HTTP_STATUSES` | 否 | `401,403,429` | 触发兜底的 Instagram HTTP 状态码列表（逗号分隔） |
| `FALLBACK_REFRESH_URL_BASE` | 否 | 同 `BASE_URL` | 兜底刷新请求使用的基础域名，默认复用 `BASE_URL` |
| `DEEPSEEK_DAILY_LIMIT` | 否 | `200` | 每日 DeepSeek 摘要的调用额度软上限（超额自动使用原摘要降级） |

### 3. Worker Secrets

这些变量建议通过 `wrangler secret put` 设置：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram 功能必填 | 管理 Bot Token |
| `TELEGRAM_CHAT_ID` | Telegram 功能必填 | 允许操作管理 Bot 接收消息/命令的目标 Chat ID |
| `TELEGRAM_ADMIN_USER_ID` | Telegram 功能必填 | 唯一允许执行管理命令的个人 Telegram User ID；Webhook 仅接受该用户在私聊中发送的命令，缺失配置时拒绝所有命令 |
| `ADMIN_TOKEN` | 是 | 管理接口认证 Token，同时也作为 Telegram Webhook Secret Token |
| `PUSH_TELEGRAM_BOT_TOKEN` | 是 | 专用于向私人频道推送内容的新 Bot Token |
| `PUSH_TELEGRAM_CHANNEL_ID` | 是 | 接收内容推送的目标私人频道 ID (e.g. -100xxx) |
| `DEEPSEEK_API_KEY` | 一键生产部署必填 | DeepSeek API 密钥；`deploy.sh` 会校验并配置为 Worker Secret |

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
| `POST` | `/admin/refresh_ig/:username` | `Authorization: Bearer <ADMIN_TOKEN>` | 刷新单个 Instagram 账号（也是 HTTP 兜底刷新的内部目标） |
| `POST` | `/admin/sync-telegram-commands` | `Authorization: Bearer <ADMIN_TOKEN>` | 单独同步 Telegram 命令菜单 |
| `GET` | `/admin/probe-instagram` | `Authorization: Bearer <ADMIN_TOKEN>` | Instagram 探针诊断（只读，不写缓存） |
| `GET` | `/admin/probe-stock` | `Authorization: Bearer <ADMIN_TOKEN>` | 股票价格探针诊断（只读，不写 D1） |

### 已关闭的公开页面

以下页面当前默认关闭，不再对外公开：

- `/`
- `/status`

服务状态查看统一通过 Telegram `/status` 完成。

## Telegram 命令

### Instagram 订阅管理

| 命令 | 说明 |
| --- | --- |
| `/add_ig <username> [displayName]` | 添加 Instagram 订阅 |
| `/remove_ig <username>` | 删除 Instagram 订阅 |
| `/list` | 列出当前全部 Instagram 订阅 |

### RSS 订阅管理

| 命令 | 说明 |
| --- | --- |
| `/rss_add [url]` | 添加 RSS/Atom 订阅（无参数时进入会话订阅流程） |
| `/rss_list` | 列出当前全部 RSS 订阅 |
| `/rss_remove <id>` | 删除指定 ID 的 RSS 订阅 |
| `/rss_pause <id>` | 暂停指定 ID 的 RSS 订阅 |
| `/rss_resume <id>` | 恢复指定 ID 的 RSS 订阅 |
| `/rss_refresh <id>` | 手动刷新指定 ID 的 RSS 订阅 |
| `/rss_set_interval <id> <minutes>` | 设置指定 ID 的 RSS 订阅检测刷新间隔（分钟，最小为 5 分钟） |

### 股票价格追踪

| 命令 | 说明 |
| --- | --- |
| `/stock_add <code> [gte/lte] [targetPrice]` | 添加股票价格提醒（支持 6 位代码，如 600519，无参数时进入会话订阅流程） |
| `/stock_list` | 列出当前全部股票价格提醒 |
| `/stock_pause <id>` | 暂停指定 ID 的股票提醒 |
| `/stock_resume <id>` | 恢复指定 ID 的股票提醒 |
| `/stock_remove <id>` | 删除指定 ID 的股票提醒 |
| `/stock_quote <code>` | 查询当前股票价格行情 |

### 运维命令

| 命令 | 说明 |
| --- | --- |
| `/feeds` | 列出所有 Instagram RSS 链接 |
| `/status` | 查看服务状态，包括 Instagram/RSS 订阅状态、通知队列积压、股票提醒积压及当日 AI 额度使用 |
| `/refresh` | 手动刷新全部 Instagram 缓存 |
| `/refresh_ig <username>` | 刷新单个 Instagram 订阅 |
| `/purge_ig` | 清理全部 Instagram 缓存 |
| `/sync_commands` | 同步 Telegram 机器人命令菜单 |
| `/help` | 显示帮助 |
| `/start` | 显示帮助 |

## 抓取与缓存行为

### Instagram

- RSS 请求优先读取缓存。
- 缓存过期或为空时，后台异步刷新。

### 定时刷新与 HTTP 兜底刷新

- 定时刷新：Cron 每 10 分钟刷新一次全部订阅，保证时效性。
- HTTP 兜底刷新：定时/批量刷新某账号时，如果命中 `FALLBACK_REFRESH_HTTP_STATUSES`（默认 `401,403,429`）且把本次失败计入后连续失败数达到 `FALLBACK_REFRESH_FAILURE_THRESHOLD`（默认 `3`），会自动通过公网 Worker URL（`POST /admin/refresh_ig/<username>?fallback=1`）再尝试一次刷新。
  - 兜底刷新成功则采用其结果，并且不重复记录本次失败。
  - 兜底刷新仍然失败则记录该次失败（不会重复计数）。
  - 兜底请求本身未能到达刷新路由（网络/鉴权问题）时，按原始失败正常记录一次。
- **局限性**：这是 best-effort。Cloudflare Workers 无法强制固定 colo/placement，通过公网入口再次进入只是「有可能」经由不同的请求路径/落点，从而绕开当前 colo 的 IG 风控，并不保证一定换到更好的落点。
- 兜底刷新路由本身会关闭再次兜底，避免递归与重复计数。

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
  -H "Authorization: Bearer TOKEN_PLACEHOLDER"
```

### 手动刷新单个 Instagram 账号

可用于手动测试，也是 HTTP 兜底刷新的内部目标路由。该路由不会再次触发兜底刷新。

```bash
curl -X POST "https://<your-worker-domain>/admin/refresh_ig/jjlin" \
  -H "Authorization: Bearer TOKEN_PLACEHOLDER"
```

### 单独同步 Telegram 命令菜单

```bash
curl -X POST "https://<your-worker-domain>/admin/sync-telegram-commands" \
  -H "Authorization: Bearer TOKEN_PLACEHOLDER"
```

### Instagram 探针诊断

只读探测，不会写入缓存或修改抓取状态。可从不同客户端网络调用，对比返回的 `colo`、`status` 等字段，判断 Cloudflare 边缘节点/落点是否影响 Instagram 风控。

```bash
curl -H "Authorization: Bearer TOKEN_PLACEHOLDER" \
  "https://<your-worker-domain>/admin/probe-instagram?username=jjlin"
```

### 通过 Telegram 添加订阅

```txt
/add_ig Silencewang.0917 汪苏泷的ins
```

## 说明

- 只有已加入白名单的账号才允许通过 RSS 接口访问。
- RSS 页面本身不再提供公开索引页。
