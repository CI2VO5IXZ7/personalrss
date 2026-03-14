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
REQUIRED_VARS="CF_ACCOUNT_ID CF_API_TOKEN TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID ADMIN_TOKEN"
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

# ─── 3. 创建 KV 命名空间（自动回填 wrangler.toml）─────────────────────────────

echo "[2/6] 检查 KV 命名空间..."

get_kv_id_from_list() {
  # 从 wrangler kv:namespace list 输出中查找指定 title 的 KV ID
  local TITLE=$1
  CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" \
    npx wrangler kv:namespace list 2>/dev/null | \
    python3 -c "
import sys, json
try:
    ns = json.load(sys.stdin)
    match = next((n['id'] for n in ns if n['title'] == '$TITLE'), '')
    print(match)
except:
    print('')
" 2>/dev/null
}

create_kv_if_needed() {
  local BINDING=$1
  local PLACEHOLDER="REPLACE_WITH_${BINDING}_KV_ID"
  local PREVIEW_PLACEHOLDER="REPLACE_WITH_${BINDING}_PREVIEW_ID"
  local KV_TITLE="social-rss-bridge-${BINDING}"

  # 如果 wrangler.toml 中还是占位符，说明需要填入 ID
  if grep -q "$PLACEHOLDER" wrangler.toml; then
    echo "  配置 KV: $BINDING ..."

    # 先尝试从已有列表中获取
    KV_ID=$(get_kv_id_from_list "$KV_TITLE")

    # 如果不存在，创建新的
    if [ -z "$KV_ID" ]; then
      echo "    创建新 KV 命名空间..."
      OUTPUT=$(CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" \
        npx wrangler kv:namespace create "$BINDING" 2>&1) || true
      # 从创建输出中提取 ID
      KV_ID=$(echo "$OUTPUT" | grep -oP 'id = "\K[a-f0-9]+' | head -1)
      # 如果还是没有，再查一次列表
      if [ -z "$KV_ID" ]; then
        KV_ID=$(get_kv_id_from_list "$KV_TITLE")
      fi
    fi

    if [ -n "$KV_ID" ]; then
      sed -i "s/$PLACEHOLDER/$KV_ID/g" wrangler.toml
      sed -i "s/$PREVIEW_PLACEHOLDER/$KV_ID/g" wrangler.toml
      echo "  ✅ $BINDING KV ID: $KV_ID"
    else
      echo "  ❌ 无法获取 $BINDING KV ID，请手动填入 wrangler.toml"
      echo "     运行: npx wrangler kv:namespace list 查看已有 KV"
      return 1
    fi
  else
    echo "  ✅ $BINDING KV 已配置"
  fi
}

export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"
create_kv_if_needed "CACHE"
create_kv_if_needed "COOKIES"

# 最终检查
if grep -q "REPLACE_WITH" wrangler.toml; then
  echo ""
  echo "❌ wrangler.toml 中仍有未替换的占位符，请手动填入 KV ID 后重试"
  exit 1
fi

# ─── 4. 更新 wrangler.toml 中的 BASE_URL（部署后回填）─────────────────────────

echo "[3/6] 准备部署配置..."

# ─── 5. 部署 Worker ────────────────────────────────────────────────────────────

echo "[4/6] 部署 Worker..."
DEPLOY_OUTPUT=$(CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" \
  npx wrangler deploy 2>&1) || {
  echo "❌ 部署失败："
  echo "$DEPLOY_OUTPUT"
  exit 1
}
echo "$DEPLOY_OUTPUT" | tail -5

# 提取 Worker URL
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oP 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)
if [ -n "$WORKER_URL" ]; then
  echo "  🌐 Worker URL: $WORKER_URL"
  # 回填 BASE_URL
  sed -i "s|BASE_URL = \".*\"|BASE_URL = \"$WORKER_URL\"|" wrangler.toml
fi

# ─── 6. 设置 Secrets ──────────────────────────────────────────────────────────

echo "[5/6] 设置 Secrets..."

set_secret() {
  local NAME=$1
  local VALUE=$2
  if [ -n "$VALUE" ]; then
    echo "$VALUE" | CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" \
      npx wrangler secret put "$NAME" --name social-rss-bridge 2>&1 | tail -1
    echo "  ✅ $NAME"
  fi
}

set_secret "CF_ACCOUNT_ID" "$CF_ACCOUNT_ID"
set_secret "CF_API_TOKEN" "$CF_API_TOKEN"
set_secret "TELEGRAM_BOT_TOKEN" "$TELEGRAM_BOT_TOKEN"
set_secret "TELEGRAM_CHAT_ID" "$TELEGRAM_CHAT_ID"
set_secret "ADMIN_TOKEN" "$ADMIN_TOKEN"

# 如果 BASE_URL 更新了，重新部署一次
if [ -n "$WORKER_URL" ]; then
  echo ""
  echo "  重新部署以应用 BASE_URL..."
  CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" \
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
  echo "📡 RSS 订阅链接:"
  echo "   $WORKER_URL/rss/ig/jjlin"
  echo "   $WORKER_URL/rss/ig/Silencewang.0917"
  echo "   $WORKER_URL/rss/xhs/62b97a76000000001b02b560"
  echo "   $WORKER_URL/rss/xhs/6979812a000000002102c464"
  echo ""
  echo "🤖 Telegram Bot 命令: /help /status /feeds /refresh_xhs"
fi
