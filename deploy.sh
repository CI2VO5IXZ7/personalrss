#!/bin/bash
# Social RSS Bridge 一键部署脚本
# 用法: 配好 .env 后运行 ./deploy.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "╔══════════════════════════════════════╗"
echo "║   Social RSS Bridge — 一键部署      ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ─── 1. 读取 .env ──────────────────────────────────────────────────────────────

if [ ! -f .env ]; then
  echo "❌ 未找到 .env 文件！请先从 .env.example 复制并填写："
  echo "   cp .env.example .env && nano .env"
  exit 1
fi

# 加载 .env（跳过注释和空行）
set -a
source <(grep -v '^\s*#' .env | grep -v '^\s*$')
set +a

# 校验必要变量
REQUIRED_VARS="CF_ACCOUNT_ID CF_API_TOKEN TIKHUB_API_TOKEN TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID ADMIN_TOKEN"
MISSING=""
for var in $REQUIRED_VARS; do
  if [ -z "${!var}" ]; then
    MISSING="$MISSING  - $var\n"
  fi
done
if [ -n "$MISSING" ]; then
  echo "❌ .env 中缺少以下必要变量："
  echo -e "$MISSING"
  exit 1
fi

echo "✅ .env 配置已加载"

# ─── 2. 安装依赖 ───────────────────────────────────────────────────────────────

echo ""
echo "[1/6] 安装 npm 依赖..."
npm install --silent 2>&1 | tail -1

# ─── 3. 创建 D1 数据库 ────────────────────────────────────────────────────────

echo "[2/6] 检查 D1 数据库..."

export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"

D1_DB_NAME="social-rss-bridge-db"

# 检查 wrangler.toml 中是否还是占位符
if grep -q "REPLACE_WITH_D1_DATABASE_ID" wrangler.toml; then
  echo "  创建 D1 数据库..."

  # 尝试从已有列表中获取
  D1_ID=$(npx wrangler d1 list 2>/dev/null | grep "$D1_DB_NAME" | awk '{print $1}' | head -1) || true

  # 如果不存在，创建新的
  if [ -z "$D1_ID" ]; then
    CREATE_OUTPUT=$(npx wrangler d1 create "$D1_DB_NAME" 2>&1) || true
    D1_ID=$(echo "$CREATE_OUTPUT" | grep -oP 'database_id = "\K[a-f0-9-]+' | head -1)
    # 再查一次
    if [ -z "$D1_ID" ]; then
      D1_ID=$(npx wrangler d1 list 2>/dev/null | grep "$D1_DB_NAME" | awk '{print $1}' | head -1) || true
    fi
  fi

  if [ -n "$D1_ID" ]; then
    sed -i "s/REPLACE_WITH_D1_DATABASE_ID/$D1_ID/g" wrangler.toml
    echo "  ✅ D1 Database ID: $D1_ID"
  else
    echo "  ❌ 无法获取 D1 Database ID，请手动填入 wrangler.toml"
    exit 1
  fi
else
  echo "  ✅ D1 数据库已配置"
fi

# ─── 4. 执行 D1 Migration ─────────────────────────────────────────────────────

echo "[3/6] 执行数据库迁移..."
npx wrangler d1 migrations apply "$D1_DB_NAME" --remote 2>&1 | tail -3
echo "  ✅ 数据库迁移完成"

# ─── 5. 部署 Worker ────────────────────────────────────────────────────────────

echo "[4/6] 部署 Worker..."
DEPLOY_OUTPUT=$(npx wrangler deploy 2>&1) || {
  echo "❌ 部署失败："
  echo "$DEPLOY_OUTPUT"
  exit 1
}
echo "$DEPLOY_OUTPUT" | tail -5

# 提取 Worker URL
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oP 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)
if [ -n "$WORKER_URL" ]; then
  echo "  🌐 Worker URL: $WORKER_URL"
  sed -i "s|BASE_URL = \".*\"|BASE_URL = \"$WORKER_URL\"|" wrangler.toml
fi

# ─── 6. 设置 Secrets ──────────────────────────────────────────────────────────

echo "[5/6] 设置 Secrets..."

set_secret() {
  local NAME=$1
  local VALUE=$2
  if [ -n "$VALUE" ]; then
    echo "$VALUE" | npx wrangler secret put "$NAME" --name social-rss-bridge 2>&1 | tail -1
    echo "  ✅ $NAME"
  fi
}

set_secret "TIKHUB_API_TOKEN" "$TIKHUB_API_TOKEN"
set_secret "TELEGRAM_BOT_TOKEN" "$TELEGRAM_BOT_TOKEN"
set_secret "TELEGRAM_CHAT_ID" "$TELEGRAM_CHAT_ID"
set_secret "ADMIN_TOKEN" "$ADMIN_TOKEN"

# 如果 BASE_URL 更新了，重新部署一次
if [ -n "$WORKER_URL" ]; then
  echo ""
  echo "  重新部署以应用 BASE_URL..."
  npx wrangler deploy 2>&1 | tail -2
fi

# ─── 7. 设置 Telegram Webhook ─────────────────────────────────────────────────

echo "[6/6] 设置 Telegram Webhook..."
if [ -n "$WORKER_URL" ]; then
  WEBHOOK_RESP=$(curl -sf "$WORKER_URL/setup-webhook?token=$ADMIN_TOKEN" 2>&1) || true
  if echo "$WEBHOOK_RESP" | grep -q '"ok":true'; then
    echo "  ✅ Telegram Webhook 设置成功"
  else
    echo "  ⚠️  Webhook 设置可能需要等待 Worker 生效后重试："
    echo "     curl \"$WORKER_URL/setup-webhook?token=$ADMIN_TOKEN\""
  fi
else
  echo "  ⚠️  无法获取 Worker URL，请手动设置 Webhook"
fi

# ─── 完成 ──────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════╗"
echo "║         ✅ 部署完成！               ║"
echo "╚══════════════════════════════════════╝"
echo ""
if [ -n "$WORKER_URL" ]; then
  echo "🌐 服务地址: $WORKER_URL"
  echo ""
  echo "🤖 Telegram Bot 命令:"
  echo "   /add_ig <username> [displayName]  — 添加 Instagram 订阅"
  echo "   /add_xhs <userId> [displayName]   — 添加小红书订阅"
  echo "   /list                              — 列出所有订阅"
  echo "   /feeds                             — 查看 RSS 链接"
  echo "   /help                              — 显示所有命令"
fi
