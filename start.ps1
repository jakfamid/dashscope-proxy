# Jalankan proxy langsung dengan Node (tanpa Docker), buat pengguna PowerShell/Windows.
# Baca ".env" (kalau ada) buat ambil DASHSCOPE_PROXY_TOKEN, lalu petakan ke
# PROXY_ACCESS_TOKEN -- nama variabel yang beneran dibaca server.js.
# (docker-compose.yaml melakukan pemetaan yang sama lewat "${DASHSCOPE_PROXY_TOKEN}",
# tapi itu cuma jalan lewat Compose; jalan "node server.js" langsung TIDAK baca .env
# sama sekali, jadi perlu dijembatani manual di sini.)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], "Process")
        }
    }
}

if (-not $env:PORT) { $env:PORT = "8787" }
if (-not $env:DASHSCOPE_UPSTREAM_HOST) { $env:DASHSCOPE_UPSTREAM_HOST = "dashscope-intl.aliyuncs.com" }
if (-not $env:DASHSCOPE_API_KEYS_FILE) { $env:DASHSCOPE_API_KEYS_FILE = ".\api-key.txt" }
if (-not $env:PROXY_ACCESS_TOKEN) { $env:PROXY_ACCESS_TOKEN = $env:DASHSCOPE_PROXY_TOKEN }

node server.js
