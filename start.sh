#!/usr/bin/env bash
# Jalankan proxy langsung dengan Node (tanpa Docker).
# Baca ".env" (kalau ada) buat ambil DASHSCOPE_PROXY_TOKEN, lalu petakan ke
# PROXY_ACCESS_TOKEN -- nama variabel yang beneran dibaca server.js.
# (docker-compose.yaml melakukan pemetaan yang sama lewat "${DASHSCOPE_PROXY_TOKEN}",
# tapi itu cuma jalan lewat Compose; jalan "node server.js" langsung TIDAK baca .env
# sama sekali, jadi perlu dijembatani manual di sini.)
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

export PORT="${PORT:-8787}"
export DASHSCOPE_UPSTREAM_HOST="${DASHSCOPE_UPSTREAM_HOST:-dashscope-intl.aliyuncs.com}"
export DASHSCOPE_API_KEYS_FILE="${DASHSCOPE_API_KEYS_FILE:-./api-key.txt}"
export PROXY_ACCESS_TOKEN="${PROXY_ACCESS_TOKEN:-${DASHSCOPE_PROXY_TOKEN:-}}"

exec node server.js
