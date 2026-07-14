# PersonalRSS 整合信息输出平台

PersonalRSS 是一个基于 Cloudflare Workers + D1 + Telegram Bot 的整合信息输出与推送平台。系统围绕 **PersonalRSS 三总成 (Generator / Monitor / Push)** 进行架构，提供数据生成、目标监控、信息推送的一体化服务。

---

## 核心架构：PersonalRSS 三总成

```txt
┌────────────────────────────────────────────────────────┐
│                      PersonalRSS                       │
└────────────────────────────────────────────────────────┘
        │                 │                  │
        ▼                 ▼                  ▼
  🧩 Generator      📡 Monitor          📨 Push
 产生 RSS 订阅源     监控外部数据/股票      向频道推送 RSS 消息
/feeds/<id>.xml    评估规则并触发告警     (首次仅推送最新 1 篇)
```

1. **🧩 Generator (生成器)**：负责从外部平台（如 Instagram）抓取并解析数据，生成标准的 RSS 2.0 订阅源。
   - **公开 RSS 路径**：`/feeds/<id>.xml` (替代了已删除的旧路径 `/rss/ig/:username`)。
2. **📡 Monitor (监控器)**：负责定时拉取外部数据源进行评估，如**股票行情监控**（支持 A 股 6 位代码，对接新浪/腾讯行情接口，支持 `/monitor_add stock <code> <gte|lte> <price>` 命令）。当满足设定的条件阈值时，自动向管理 Chat 推送告警。
3. **📨 Push (推送器)**：负责订阅指定的 RSS 源（包含 Generator 生成的内部源以及其他任意外部 RSS），定时检测更新并将新内容推送至 Telegram 频道。
   - 为了防止首次订阅时历史消息刷屏，**首次订阅仅推送最新 1 篇**条目。

---

## 运行与调度机制

### 1. 双层 Cron 调度机制
- **系统 Cron 触发器**：配置为**每 5 分钟**运行一次（即 `wrangler.toml` 中的 `*/5 * * * *`）。
- **Monitor / Push / 队列处理 (每 5 分钟)**：每次 Cron 触发时，系统会立即执行股票监控条件评估 (`monitor`)、RSS 推送拉取检测 (`push_rss`)、以及通知队列扫表 (`notification_queue`)。
- **Generator 抓取刷新 (每 10 分钟)**：为了防风控与节省 CPU 额度，Generator 仅在 UTC 分钟数能够被 10 整除（即 `minute % 10 === 0`）时，即**每 10 分钟**异步执行一次刷新。

### 2. 安全性与 SHA-256 Webhook 派生密钥
- 为了确保 Telegram Webhook 接入口（`/telegram`）免受恶意请求伪造，系统使用 `ADMIN_TOKEN` 作为输入源，通过 **SHA-256 算法**（`crypto.subtle.digest('SHA-256')`）在运行时派生出高强度的 Webhook Secret Token。
- 在部署与初始化时，系统自动将此 SHA-256 派生密钥绑定至 Telegram Bot，并在接收 Webhook 回调时强制校验 `X-Telegram-Bot-Api-Secret-Token` 请求头。

---

## 环境变量与 Secrets

### 1. 部署环境变量 (`.env`)
可在本地部署或 CI 中配置：
- `CF_ACCOUNT_ID`：Cloudflare Account ID (选填，使用浏览器认证时留空)。
- `CF_API_TOKEN`：Cloudflare API Token (选填)。

### 2. 7 个运行时 Secrets (Runtime Secrets)
必须通过 `wrangler secret put` 或 GitHub Actions Secrets 设置以下 **7 个 runtime secrets**：
1. `TELEGRAM_BOT_TOKEN`：管理机器人 Token（由 @BotFather 创建）。
2. `TELEGRAM_CHAT_ID`：允许接收告警消息并接收管理命令的目标 Chat ID。
3. `TELEGRAM_ADMIN_USER_ID`：唯一允许操作管理命令的个人 Telegram User ID（其他用户无法在群组或私聊中越权执行命令）。
4. `ADMIN_TOKEN`：管理接口认证 Token，同时也作为 SHA-256 派生 Webhook Secret 的原钥。
5. `DEEPSEEK_API_KEY`：DeepSeek API 密钥，用于给推送内容生成中文 AI 摘要。
6. `PUSH_TELEGRAM_BOT_TOKEN`：Push 订阅推送机器人 Token。
7. `PUSH_TELEGRAM_CHANNEL_ID`：接收 Push 消息推送的目标频道/群组 ID (例如 `-100xxxxxxxxxx`)。

---

## 部署说明

### 1. GitHub Actions 自动部署
项目完整支持通过 GitHub Actions 进行自动化部署：
1. 在 GitHub 仓库设置中，依次进入 **Settings -> Secrets and variables -> Actions**。
2. 将上述 **7 个 Runtime Secrets** 以及 Cloudflare 凭证 (`CF_ACCOUNT_ID`, `CF_API_TOKEN`) 添加为 Repository Secrets。
3. 进入仓库的 **Actions** 标签页，选择 **Deploy** 工作流，点击 **Run workflow** 手动触发部署。

### 2. 本地一键脚本部署
1. 复制模板并配置环境：
   ```bash
   cp .env.example .env
   # 编辑 .env 填入 7 个运行时 Secrets 及变量
   ```
2. 运行一键部署脚本：
   ```bash
   ./deploy.sh
   ```
   脚本将自动完成依赖安装、Cloudflare D1 数据库校验与迁移、Worker 部署、Runtime Secrets 注入以及 Webhook 注册绑定。

---

## HTTP 对外接口

| 方法 | 路径 | 认证方式 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/feeds/:id.xml` | 公开 | **Generator 订阅源** (取代旧 `/rss/ig/:username` [已删除]) |
| `GET` | `/img?url=...` | 公开 | 图片代理接口 (绕过 CDN 防盗链) |
| `GET` | `/media?url=...` | 公开 | 视频代理接口 (支持 Range 视频分片) |
| `POST` | `/telegram` | SHA256 Webhook Secret | Telegram 机器人 Webhook 接入口 |
| `POST` | `/setup-webhook` | `Bearer <ADMIN_TOKEN>` | 初始化绑定 Webhook 并同步机器人命令菜单 |
| `POST` | `/admin/sync-telegram-commands` | `Bearer <ADMIN_TOKEN>` | 同步机器人命令菜单 |
| `GET` | `/admin/probe-stock?code=<code>` | `Bearer <ADMIN_TOKEN>` | 只读股票行情探针 |

*注：旧公开页面 `/` 和 `/status` 已关闭，系统状态查询统一移至 Telegram 机器人 `/status` 命令。*

---

## Telegram 机器人命令

### 🧩 RSS Generator (生成器)
- `/gen_add instagram <username> [displayName]` — 添加 Instagram Generator 订阅。
- `/gen_list` — 列出所有活跃的 Generator。
- `/gen_feed <id>` — 查看指定 Generator 的 RSS 订阅链接（即 `/feeds/<id>.xml`）。
- `/gen_refresh <id>` — 手动强制拉取刷新指定 Generator。
- `/gen_pause <id>` — 暂停指定 Generator 抓取刷新。
- `/gen_resume <id>` — 恢复指定 Generator 抓取刷新。
- `/gen_remove <id>` — 删除指定 Generator 并自动清理 D1 中的帖子缓存。

### 📡 Information Monitor (行情/指标监控)
- `/monitor_add stock <code> <gte|lte> <price>` — 添加股票行情价格监控（例如：`/monitor_add stock 600519 gte 1800`）。
- `/monitor_list` — 列出当前全部股票监控规则。
- `/monitor_quote stock <code>` — 实时查询指定股票最新行情。
- `/monitor_pause <id>` — 暂停股票监控。
- `/monitor_resume <id>` — 恢复股票监控。
- `/monitor_remove <id>` — 删除股票监控规则。

### 📨 Information Push (通道推送)
- `/push_add rss <url>` — 添加 RSS 推送订阅（可填 `/feeds/<id>.xml` 内部源或任意外部 RSS 地址），首次推送最新 1 篇。
- `/push_list` — 列出所有 Push 订阅。
- `/push_refresh <id>` — 手动拉取刷新 Push 订阅。
- `/push_pause <id>` — 暂停 Push 推送。
- `/push_resume <id>` — 恢复 Push 推送。
- `/push_remove <id>` — 删除 Push 订阅。

### ⚙️ System (系统运维)
- `/status` — 查看服务运行状态（集成三总成健康度、队列积压、每日 AI 摘要额度）。
- `/help` — 显示本帮助消息（已完全移除旧 `/start` 命令）。
- `/cancel` — 中断并取消当前的会话交互流程。
- `/sync_commands` — 同步更新 Telegram 命令菜单列表。

---

## 历史命令与接口变更说明 [已删除/弃用]
为适配 **Generator / Monitor / Push 三总成** 架构，以下旧命令与旧路径已完全删除或停用：
- **旧抓取与源路径**：`GET /rss/ig` [已删除] -> 请使用 `/feeds/<id>.xml`。
- **旧 IG 命令**：`/add_ig`、`/refresh_ig`、`/purge_ig`、`/list`、`/feeds` [已删除] -> 请使用 `/gen_add`、`/gen_refresh`、`/gen_list`、`/gen_feed` 等 `/gen_*` 系列命令。
- **旧 RSS 命令**：`/rss_add`、`/rss_list`、`/rss_remove`、`/rss_pause`、`/rss_resume`、`/rss_refresh` [已删除] -> 请使用 `/push_add` 等 `/push_*` 系列命令。
- **旧股票命令**：`/stock_add`、`/stock_list`、`/stock_pause`、`/stock_resume`、`/stock_remove`、`/stock_quote` [已删除] -> 请使用 `/monitor_add` 等 `/monitor_*` 系列命令。
- **系统引导命令**：`/start` [已从帮助文档完全移除并作未知命令处理]。

---

## 数据库迁移与破坏性旧数据清理 (Migration 0008)

Migration `0008_drop_legacy_instagram_tables.sql` 对数据库进行了清理，永久移除了旧版架构遗留的运行时表（Legacy Tables）。

### 清理的旧表：
- `accounts`：旧版 Instagram 爬虫账户表。
- `posts_cache`：旧版 Instagram 帖子缓存表。
- `crawl_status`：旧版 Instagram 爬取状态表。
- `api_usage`：旧版 API 调用统计表。

### 保留的新表及数据：
以下新版三总成架构的核心数据表及数据会被完整保留，不受迁移影响：
- `generator_instances` / `generator_items` / `generator_status`：Generator 生成器实例和缓存数据。
- `tracker_rules` / `tracker_events`：监控规则和触发事件。
- `rss_subscriptions` / `rss_entries`：Push 推送订阅源及历史条目.
- `notification_queue`：待发送的通知队列。
- `bot_sessions`：Telegram 机器人交互会话状态。
- `daily_usage`：DeepSeek 等每日 AI 调用额度统计。
