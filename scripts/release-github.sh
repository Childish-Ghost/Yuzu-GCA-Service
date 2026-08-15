#!/bin/bash
# ============================================================
# GCA 发版脚本——GitHub Release 创建/更新 + 附件上传（双地址发布的 GitHub 侧）
#
# 用法: bash scripts/release-github.sh <版本名> <tag> <body.json(UTF-8)> [附件...]
# 例:
#   bash scripts/release-github.sh "B0.5.0" "B0.5.0" scripts/release-body.B0.5.0.json \
#       releases/gca-setup-win-B0.5.0.exe releases/gca-server-0.5.0.zip
#
# 认证：环境变量 GITHUB_TOKEN（PAT，repo 权限）或 ~/.github-token
# 注意：github.com 网页可能不可达（网络限制），但 api.github.com 可用——全部走 API
# ============================================================
set -e

NAME="$1"; TAG="$2"; BODY="$3"; shift 3 || true
if [ -z "$NAME" ] || [ -z "$TAG" ] || [ -z "$BODY" ]; then
  echo "用法: bash scripts/release-github.sh <版本名> <tag> <body.json> [附件...]"
  exit 1
fi
[ -f "$BODY" ] || { echo "body 文件不存在: $BODY"; exit 1; }

GITHUB_TOKEN="${GITHUB_TOKEN:-$(cat ~/.github-token 2>/dev/null || true)}"
if [ -z "$GITHUB_TOKEN" ]; then
  echo "错误：需要 GitHub token（GITHUB_TOKEN 环境变量或 ~/.github-token）"
  exit 1
fi
REPO="Childish-Ghost/Yuzu-GCA-Service"
API="https://api.github.com/repos/$REPO"

# 1. 已存在则 PATCH，否则创建
EXIST_ID=$(curl -sS -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "$API/releases/tags/$TAG" | grep -oE '"id": [0-9]+' | head -1 | cut -d' ' -f2)
if [ -n "$EXIST_ID" ]; then
  echo "Release $TAG 已存在（id=$EXIST_ID），PATCH 更新 body ..."
  RID=$EXIST_ID
  curl -sS -X PATCH "$API/releases/$RID" \
    -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" \
    --data-binary "@$BODY" >/dev/null
else
  echo "创建 Release $TAG ..."
  RID=$(curl -sS -X POST "$API/releases" \
    -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" \
    --data-binary "@$BODY" | grep -oE '"id": [0-9]+' | head -1 | cut -d' ' -f2)
  [ -n "$RID" ] || { echo "创建失败"; exit 1; }
  echo "Release id=$RID ✓"
fi

# 2. 上传附件（同名覆盖：先删后传）
for f in "$@"; do
  [ -f "$f" ] || { echo "跳过（文件不存在）: $f"; continue; }
  NAME_ENC=$(basename "$f" | sed 's/ /%20/g')
  echo "上传 $f ..."
  EXIST=$(curl -sS -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "$API/releases/$RID/assets?per_page=100" | grep -oE "\"name\": \"$(basename "$f")\"")
  if [ -n "$EXIST" ]; then
    AID=$(curl -sS -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "$API/releases/$RID/assets?per_page=100" | python -c "import json,sys; name='$(basename "$f")'; [print(a['id']) for a in json.load(sys.stdin) if a['name']==name]" | head -1)
    curl -sS -X DELETE -H "Authorization: token $GITHUB_TOKEN" "$API/releases/assets/$AID" >/dev/null && echo "  ✓ 覆盖旧附件"
  fi
  curl -sS -X POST -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$f" "$API/releases/$RID/assets?name=$NAME_ENC" | grep -oE '"name": "[^"]+"' | head -1
done

echo "完成: https://github.com/$REPO/releases/tag/$TAG"
