#!/usr/bin/env bash
# Hentikan proxy yang sedang jalan, dikenali lewat PID file yang ditulis server.js
# saat start (".dashscope-proxy.pid" di folder ini secara default, override lewat
# $PID_FILE) -- jadi bekerja tidak peduli proxy dijalankan lewat npm start, start.sh,
# start.ps1, atau "node server.js" langsung.
set -euo pipefail
cd "$(dirname "$0")"

PID_FILE="${PID_FILE:-.dashscope-proxy.pid}"

# Di Git Bash/MSYS (Windows), "kill -0"/"kill -TERM" ke PID proses Win32 native (mis.
# dijalankan lewat PowerShell/cmd, bukan lewat MSYS) tidak reliable -- bisa salah
# lapor "sudah tidak jalan" padahal masih hidup. tasklist/taskkill jauh lebih
# konsisten buat kasus itu.
is_windows() {
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

process_alive() {
  if is_windows; then
    tasklist //FI "PID eq $1" //NH 2>/dev/null | grep -q "$1"
  else
    kill -0 "$1" 2>/dev/null
  fi
}

if [ ! -f "$PID_FILE" ]; then
  echo "Tidak ada $PID_FILE -- proxy sepertinya tidak sedang jalan."
  exit 0
fi

PID="$(cat "$PID_FILE")"

if ! process_alive "$PID"; then
  echo "Proses PID $PID (dari $PID_FILE) sudah tidak jalan -- membersihkan pidfile basi."
  rm -f "$PID_FILE"
  exit 0
fi

echo "Menghentikan proxy (PID $PID)..."

if is_windows; then
  # Force-kill, sama seperti stop.ps1 (Stop-Process -Force) -- di Windows tidak ada
  # padanan graceful SIGTERM yang reliable buat proses yang tidak dijalankan lewat MSYS,
  # jadi pidfile juga tidak akan dibersihkan sendiri oleh server.js (proses langsung
  # diputus, exit handler-nya tidak sempat jalan) -- makanya di-rm manual di bawah.
  taskkill //PID "$PID" //F >/dev/null 2>&1 || true
else
  kill -TERM "$PID"
  for _ in $(seq 1 20); do
    if ! process_alive "$PID"; then
      echo "Proxy berhenti."
      rm -f "$PID_FILE"
      exit 0
    fi
    sleep 0.25
  done
  echo "Proxy tidak berhenti dalam 5 detik, paksa kill -9..."
  kill -9 "$PID" 2>/dev/null || true
fi

rm -f "$PID_FILE"
echo "Proxy berhenti."
