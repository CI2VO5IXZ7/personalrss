# Social RSS Bridge

将小红书和 Instagram 的帖子转为标准 RSS 2.0 Feed，部署在 Cloudflare Workers 上。

## 功能

- **Instagram RSS**：通过官方内部 API 获取公开 profile 帖子（无需登录）
- **小红书 RSS**：通过 TikHub API 获取用户笔记（含完整图文内容）
- **图片代理**：所有 RSS 图片通过 Worker 代理，解决 CDN 签名过期和跨域问题
- **D1 数据库**：使用 Cloudflare D1 存储订阅配置和帖子缓存
- **Telegram Bot**：通过 Bot 命令动态管理订阅、查看状态、手动刷新
- **定时刷新**：每小时自动刷新缓存

## 部署

### 前置要求

- Cloudflare Workers 付费计划（$5/月）
- [TikHub](https://user.tikhub.io) 账号和 API Token（小红书数据抓取）
- Telegram Bot

### Cloudflare API Token 权限

在 [Cloudflare Dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) 中创建 **Custom Token**，需包含以下权限：

| 权限 | 说明 |
|------|------|
| `Account / Workers Scripts / Edit` | 部署 Worker 代码 |
| `Account / D1 / Edit` | 创建和读写 D1 数据库 |

### 步骤

1. **配置 `.env`**
   ```bash
   cp .env.example .env
   nano .env   # 填入 Cloudflare、TikHub、Telegram 等信息
   ```

2. **一键部署**
   ```bash
   ./deploy.sh
   ```
   脚本会自动完成：安装依赖 → 创建 D1 数据库 → 执行迁移 → 部署 Worker → 设置 Secrets → 配置 Telegram Webhook。

3. **通过 Telegram Bot 添加订阅**

   部署完成后，在 Telegram 中向 Bot 发送命令：
   ```
   /add_ig jjlin 林俊杰的ins
   /add_ig Silencewang.0917 汪苏泷的ins
   /add_xhs 62b97a76000000001b02b560 罗曼城氛围组
   /add_xhs 6979812a000000002102c464 罗曼星球
   ```

   - **Instagram `username`**：用户主页 URL 中 `instagram.com/` 后面的部分
   - **小红书 `userId`**：用户主页 URL 中 `user/profile/` 后面的 24 位 ID

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
| `GET /admin/refresh?token=` | 手动刷新所有缓存 |

## Telegram Bot 命令

| 命令 | 说明 |
|------|------|
| `/add_ig <username> [displayName]` | 添加 Instagram 订阅 |
| `/add_xhs <userId> [displayName]` | 添加小红书订阅 |
| `/remove_ig <username>` | 删除 Instagram 订阅 |
| `/remove_xhs <userId>` | 删除小红书订阅 |
| `/list` | 列出所有订阅账号 |
| `/feeds` | 列出所有 RSS 订阅链接 |
| `/status` | 查看服务状态 |
| `/refresh` | 立即刷新所有缓存 |
| `/help` | 显示帮助 |

## 架构

```
CF Worker
├── Hono 路由
├── Instagram 内部 API（无需登录）
├── TikHub Xiaohongshu-App-V2-API（小红书抓取）
├── Cloudflare D1（订阅配置 + 帖子缓存）
├── 图片代理（/img?url=）
├── Telegram Webhook（订阅管理 + 状态查看）
└── Cron Trigger（每小时刷新）
```
