#!/bin/bash
# ============================================================
# GCA 发版脚本——gitea Release 创建/更新 + 附件上传
#
# 用法: bash scripts/release-gitea.sh <版本名> <tag> <body.json(UTF-8)> [附件...]
# 例:
#   bash scripts/release-gitea.sh "B0.4.0" "B0.4.0" scripts/release-body.example.json \
#       releases/gca-setup-0.4.0.exe releases/gca-server-0.4.0.zip
#
# 踩坑记录（2026-08-12）:
#   - body 必须从 UTF-8 文件读取（--data-binary @file）！
#     命令行内嵌中文在 Windows 按 GBK 发送 → gitea 页面乱码（�）
#   - release 已存在时本脚本自动转 PATCH（更新 body）
#   - prerelease/draft 标记在 body.json 中控制
# ============================================================
set -e

NAME="$1"; TAG="$2"; BODY="$3"; shift 3 || true
if [ -z "$NAME" ] || [ -z "$TAG" ] || [ -z "$BODY" ]; then
  echo "用法: bash scripts/release-gitea.sh <版本名> <tag> <body.json> [附件...]"
  exit 1
fi
[ -f "$BODY" ] || { echo "body 文件不存在: $BODY（必须 UTF-8 编码，含 tag_name/name/body 字段）"; exit 1; }

REPO_URL=$(git remote get-url origin)
TOKEN=$(echo "$REPO_URL" | sed -E 's#https://[^:]+:([^@]+)@.*#\1#')
API="https://git.childish-ghost.com/api/v1/repos/LukeMackin/Yuzu-GCA-Service"

# 1. 已存在则 PATCH，否则创建
EXIST_ID=$(curl -sS -H "Authorization: token $TOKEN" "$API/releases/tags/$TAG" | grep -oE '"id":[0-9]+' | head -1 | cut -d: -f2)
if [ -n "$EXIST_ID" ]; then
  echo "Release $TAG 已存在（id=$EXIST_ID），PATCH 更新 body ..."
  RID=$EXIST_ID
  curl -sS -X PATCH "$API/releases/$RID" \
    -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
    --data-binary "@$BODY" >/dev/null
else
  echo "创建 Release $TAG ..."
  RID=$(curl -sS -X POST "$API/releases" \
    -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
    --data-binary "@$BODY" | grep -oE '"id":[0-9]+' | head -1 | cut -d: -f2)
fi
[ -n "$RID" ] || { echo "[错误] release 创建/更新失败（检查 body.json 与 token）"; exit 1; }
echo "Release id=$RID ✓"

# 2. 上传附件
for f in "$@"; do
  [ -f "$f" ] || { echo "跳过（文件不存在）: $f"; continue; }
  FN=$(basename "$f")
  echo "上传 $FN ..."
  curl -sS -X POST "$API/releases/$RID/assets?name=$FN" \
    -H "Authorization: token $TOKEN" \
    -F "attachment=@$f" >/dev/null && echo "  ✓ $FN"
done

echo "完成: $API/releases/tag/$TAG"
