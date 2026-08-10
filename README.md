# PersonalRSS — 个人 RSS 生成器

PersonalRSS 是一个基于 Cloudflare Workers + D1 的轻量 RSS 生成平台，将 Instagram 公开主页和 A 股行情转换为标准 RSS 2.0 订阅源，配合 Web 管理面板进行管理。

---

## 核心架构

```
┌────────────────────────────────────┐
│           PersonalRSS              │
│     Cloudflare Workers + D1        │
└────────────────┬───────────────────┘
                 │
     ┌───────────┼───────────┐
     ▼           ▼           ▼
  Generator   Web Admin    Proxy
  Instagram   /admin       /img
  A股行情     /api/*       /media
```

- **Generator**：从 Instagram 公开主页抓取帖子、从新浪/腾讯获取 A 股实时行情，生成标准 RSS 2.0 订阅源（`/feeds/<id>.xml`）
- **Web Admin**：暗色主题 Web 管理面板，支持添加/暂停/恢复/删除 Generator，手动刷新
- **Proxy**：图片和视频代理，绕过 Instagram CDN 防盗链

---

## 运行与调度

- **Cron 触发器**：每 10 分钟触发一次（`*/10 * * * *`）
- Generator 到期实例自动刷新，数据缓存保留最近 100 条
- 股票行情在非交易时段自动跳过

---

## HTTP 接口

| 方法 | 路径 | 认证 | 说明 |
|:---|:---|:---|:---|
| `GET` | `/feeds/:id.xml` | 公开 | RSS 订阅源 |
| `GET` | `/admin` | Bearer Token | Web 管理面板 |
| `GET` | `/api/generators` | Bearer Token | 列出所有 Generator |
| `POST` | `/api/generators` | Bearer Token | 添加 Generator |
| `POST` | `/api/generators/:id/refresh` | Bearer Token | 手动刷新 |
| `POST` | `/api/generators/:id/pause` | Bearer Token | 暂停 |
| `POST` | `/api/generators/:id/resume` | Bearer Token | 恢复 |
| `DELETE` | `/api/generators/:id` | Bearer Token | 删除 |
| `GET` | `/api/status` | Bearer Token | 服务状态 |
| `GET` | `/img?url=...` | 公开 | 图片代理 |
| `GET` | `/media?url=...` | 公开 | 视频代理 |

---

## 环境变量与 Secrets

| Secret | 说明 |
|:---|:---|
| `ADMIN_TOKEN` | Web 管理面板和 API 的 Bearer Token 认证密钥 |

Wrangler 变量（`[vars]`）：
- `CACHE_MAX_POSTS` — 每个 Generator 最大缓存帖子数（默认 100）
- `REFRESH_CONCURRENCY` — 并发刷新数（默认 3）
- `BASE_URL` — Worker 部署域名

---

## 部署

### GitHub Actions
1. 在仓库 Secrets 中配置：`CF_API_TOKEN`、`CF_ACCOUNT_ID`、`ADMIN_TOKEN`
2. 进入 Actions → Deploy → Run workflow

### 本地一键部署
```bash
cp .env.example .env
# 编辑 .env
./deploy.sh
```

---

## 开发

```bash
npm run dev          # 本地开发 (http://127.0.0.1:8787)
npm run dev:remote   # 连接远程 Cloudflare 资源
npm run check        # 部署前检查
npm run deploy       # 部署到生产
npm test             # 运行测试 (Vitest)
```

---

## 项目结构

```
src/
  index.js                         # Hono 主应用
  admin/routes.js                  # 管理 API 路由
  admin/page.js                    # Web 管理面板 HTML
  proxy.js                         # 图片/视频代理
  log.js                           # 结构化日志
  html.js                          # HTML 工具函数
  security/url.js                  # SSRF 防护 & URL 安全
  generators/
    core/                          # Generator 核心（服务/仓储/路由/调度/渲染）
    providers/
      instagram/                   # Instagram → RSS Provider
      stock/                       # A股行情 → RSS Provider
    registry.js                    # Provider 注册表
migrations/                        # D1 数据库迁移
tests/                             # Vitest 测试
```

**技术栈**：Cloudflare Workers · Hono 4.x · D1 (SQLite) · JavaScript ES Modules
