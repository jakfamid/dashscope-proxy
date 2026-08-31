#!/usr/bin/env bash
# Hentikan proxy (kalau sedang jalan) lalu jalankan lagi lewat start.sh.
set -euo pipefail
cd "$(dirname "$0")"

./stop.sh
exec ./start.sh
