# Hentikan proxy yang sedang jalan, dikenali lewat PID file yang ditulis server.js
# saat start (".dashscope-proxy.pid" di folder ini secara default, override lewat
# $env:PID_FILE) -- jadi bekerja tidak peduli proxy dijalankan lewat npm start,
# start.sh, start.ps1, atau "node server.js" langsung.
#
# CATATAN: Stop-Process di Windows mematikan proses secara paksa (setara TerminateProcess),
# bukan mengirim sinyal graceful seperti SIGTERM di Linux -- jadi request yang sedang
# berjalan langsung terputus. Proxy ini tidak menyimpan state persisten (semua di
# memori), jadi ini aman.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$PidFile = if ($env:PID_FILE) { $env:PID_FILE } else { ".dashscope-proxy.pid" }

if (-not (Test-Path $PidFile)) {
    Write-Host "Tidak ada $PidFile -- proxy sepertinya tidak sedang jalan."
    exit 0
}

$ProxyPid = (Get-Content $PidFile -Raw).Trim()
$proc = Get-Process -Id $ProxyPid -ErrorAction SilentlyContinue

if (-not $proc) {
    Write-Host "Proses PID $ProxyPid (dari $PidFile) sudah tidak jalan -- membersihkan pidfile basi."
    Remove-Item $PidFile -Force
    exit 0
}

Write-Host "Menghentikan proxy (PID $ProxyPid)..."
Stop-Process -Id $ProxyPid -Force
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
Write-Host "Proxy berhenti."
