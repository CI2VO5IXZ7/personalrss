#!/bin/bash
# Social RSS Bridge 一键部署脚本
# 用法: 配好 .env 后运行 ./deploy.sh

set -euo pipefail
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

REQUIRED_VARS="ADMIN_TOKEN"
MISSING=""
for var in $REQUIRED_VARS; do
  if [ -z "${!var:-}" ]; then
    MISSING="$MISSING  - $var\n"
  fi
done
if [ -n "$MISSING" ]; then
  echo "❌ .env 中缺少以下必要变量："
  echo -e "$MISSING"
  exit 1
fi

echo "✅ .env 配置已加载"

has_real_value() {
  local value="$1"
  case "$value" in
    ""|"your_cloudflare_account_id"|"your_cloudflare_api_token")
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

upsert_wrangler_var() {
  local key="$1"
  local value="$2"

  [ -n "$value" ] || return 0

  if grep -qE "^${key} = " wrangler.toml; then
    sed -i "s|^${key} = .*|${key} = \"${value}\"|" wrangler.toml
  else
    if grep -q '^\[vars\]' wrangler.toml; then
      awk -v key="$key" -v value="$value" '
        BEGIN { inserted = 0 }
        /^\[vars\]/ {
          print
          print key " = \"" value "\""
          inserted = 1
          next
        }
        { print }
        END {
          if (!inserted) {
            print ""
            print "[vars]"
            print key " = \"" value "\""
          }
        }
      ' wrangler.toml > wrangler.toml.tmp && mv wrangler.toml.tmp wrangler.toml
    else
      {
        echo ""
        echo "[vars]"
        echo "${key} = \"${value}\""
      } >> wrangler.toml
    fi
  fi
}

# ─── 2. 安装依赖 ───────────────────────────────────────────────────────────────

echo ""
echo "[1/4] 安装 npm 依赖..."
npm install --silent 2>&1 | tail -1

echo "[1.5/4] 同步 Worker 配置变量..."
upsert_wrangler_var "CACHE_MAX_POSTS" "${CACHE_MAX_POSTS:-100}"
upsert_wrangler_var "REFRESH_CONCURRENCY" "${REFRESH_CONCURRENCY:-3}"
echo "  ✅ 已同步 wrangler.toml [vars]"

# ─── 3. 创建 D1 数据库 ────────────────────────────────────────────────────────

echo "[2/4] 检查 D1 数据库..."

D1_DB_NAME="social-rss-bridge-db"

if has_real_value "${CF_ACCOUNT_ID:-}" && has_real_value "${CF_API_TOKEN:-}"; then
  ACCOUNT_ID_VALUE="$CF_ACCOUNT_ID"
  API_TOKEN_VALUE="$CF_API_TOKEN"
  unset CF_ACCOUNT_ID
  unset CF_API_TOKEN
  export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID_VALUE"
  export CLOUDFLARE_API_TOKEN="$API_TOKEN_VALUE"
  echo "  使用 API Token 认证"
else
  unset CF_ACCOUNT_ID
  unset CF_API_TOKEN
  unset CLOUDFLARE_ACCOUNT_ID
  unset CLOUDFLARE_API_TOKEN
  echo "  使用浏览器授权认证（wrangler login）"

  if ! npx wrangler whoami >/dev/null 2>&1; then
    echo "  未检测到 Wrangler 登录态，正在打开浏览器授权..."
    npx wrangler login || {
      echo "  ❌ Wrangler 登录失败，请手动执行: npx wrangler login"
      exit 1
    }
  fi
fi

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

echo "[3/4] 执行数据库迁移..."
npx wrangler d1 migrations apply "$D1_DB_NAME" --remote 2>&1 | tail -3
echo "  ✅ 数据库迁移完成"

# ─── 5. 部署 Worker ────────────────────────────────────────────────────────────

echo "[3.5/5] 设置 ADMIN_TOKEN Secret..."
echo "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN --name social-rss-bridge 2>&1 | tail -1
echo "  ✅ ADMIN_TOKEN"

echo "[4/5] 部署 Worker..."
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

  # 重新部署一次以应用 BASE_URL
  echo ""
  echo "  重新部署以应用 BASE_URL..."
  npx wrangler deploy 2>&1 | tail -2
fi

# ─── 完成 ──────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════╗"
echo "║         ✅ 部署完成！               ║"
echo "╚══════════════════════════════════════╝"
echo ""
if [ -n "$WORKER_URL" ]; then
  echo "🌐 服务地址: $WORKER_URL"
  echo "📄 公开 RSS 路径: $WORKER_URL/feeds/<id>.xml"
fi
