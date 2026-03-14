# Social RSS Bridge

将小红书和 Instagram 的帖子转为标准 RSS 2.0 Feed，部署在 Cloudflare Workers 上。

## 功能

- **Instagram RSS**：通过官方内部 API 获取公开 profile 帖子（无需登录）
- **小红书 RSS**：通过 CF Browser Rendering 抓取（需要 Cookie）
- **图片代理**：所有 RSS 图片通过 Worker 代理，解决 CDN 签名过期和跨域问题
- **去重合并**：新旧数据合并去重，保留最新 50 条
- **Telegram Bot**：管理 Cookie、查看状态、手动刷新
- **定时刷新**：每小时自动刷新缓存，Cookie 失效自动通知

## 部署

### 前置要求

- Cloudflare Workers 付费计划（$5/月）
- Telegram Bot（通过 [@BotFather](https://t.me/BotFather) 创建）

### Cloudflare API Token 权限

在 [Cloudflare Dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) 中创建一个 **Custom Token**，填入 `.env` 的 `CF_API_TOKEN`，需包含以下权限：
| 权限 | 说明 |
|------|------|
| `Account / Workers Scripts / Edit` | 部署 Worker 代码 |
| `Account / Workers KV Storage / Edit` | 创建和读写 KV 命名空间 |
| `Account / Cloudflare Browser Rendering / Edit` | 使用 Browser Rendering API 抓取小红书 |

> 💡 创建时选择 **Custom token** → 添加以上三个权限 → Zone Resources 选 **All zones**（或不选，因为这些是 Account 级权限）。

**CF_ACCOUNT_ID** 获取方式：登录 Cloudflare Dashboard → 右侧边栏 → Account ID。

### 步骤

1. **配置 `.env`**
   ```bash
   cd worker
   cp .env.example .env
   nano .env   # 填入你的 Cloudflare、Telegram 等信息
   ```

2. **一键部署**
   ```bash
   ./deploy.sh
   ```
   脚本会自动完成：安装依赖 → 创建 KV → 部署 Worker → 设置 Secrets → 配置 Telegram Webhook。

3. **配置订阅账号**

   编辑 `wrangler.toml` 中的 `ACCOUNTS_JSON` 变量，格式如下：

   ```json
   {
     "instagram": [
       { "username": "jjlin", "displayName": "JJ Lin" },
       { "username": "Silencewang.0917", "displayName": "Silence Wang" }
     ],
     "xiaohongshu": [
       { "userId": "62b97a76000000001b02b560", "displayName": "用户A" },
       { "userId": "6979812a000000002102c464", "displayName": "用户B" }
     ]
   }
   ```

   - **Instagram `username`**：用户主页 URL 中 `instagram.com/` 后面的部分
   - **小红书 `userId`**：用户主页 URL 中 `user/profile/` 后面的 24 位 ID
   - **`displayName`**：RSS Feed 中显示的名称，随便填

   部署后也可以在 CF 控制台修改：Workers → 你的 Worker → Settings → Variables → `ACCOUNTS_JSON`。

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /` | 列出所有 RSS 链接 |
| `GET /status` | 服务状态 |
| `GET /rss/ig/:username` | Instagram RSS |
| `GET /rss/xhs/:userId` | 小红书 RSS |
| `GET /img?url=xxx` | 图片代理 |
| `POST /telegram` | Telegram Webhook |
| `GET /setup-webhook?token=` | 设置 Telegram Webhook |
| `POST /admin/set-xhs-cookies?token=` | 手动上传 XHS Cookie |
| `GET /admin/refresh?token=` | 手动刷新所有缓存 |

## Telegram Bot 命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/status` | 查看服务和 Cookie 状态 |
| `/feeds` | 列出所有 RSS 订阅链接 |
| `/refresh_xhs` | 触发小红书扫码登录 |
| `/confirm_xhs` | 扫码后确认登录 |
| `/refresh` | 立即刷新所有缓存 |

## 架构

```
CF Worker
├── Hono 路由
├── Instagram 内部 API（无需登录）
├── CF Browser Rendering（XHS 抓取）
├── Workers KV（缓存 + Cookie）
├── 图片代理（/img?url=）
├── Telegram Webhook
└── Cron Trigger（每小时刷新）
```
