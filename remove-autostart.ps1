# Hapus autostart dashscope-proxy yang dibuat install-autostart.ps1: unregister
# task "DashscopeProxy Autostart" dari Task Scheduler dan buang launcher VBS-nya.
# Proses proxy yang SEDANG jalan tidak ikut dimatikan -- pakai .\stop.ps1 untuk itu.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$TaskName    = "DashscopeProxy Autostart"
$LauncherVbs = Join-Path $PSScriptRoot "autostart-launcher.vbs"

# Elevasi otomatis lewat UAC kalau belum admin (sama seperti install-autostart.ps1).
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    Write-Host "Butuh hak administrator untuk menghapus Task Scheduler -- elevasi otomatis..."
    Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit 0
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "OK: task '$TaskName' dihapus dari Task Scheduler."
} else {
    Write-Host "Task '$TaskName' tidak ditemukan -- sepertinya autostart belum pernah dipasang."
}

if (Test-Path $LauncherVbs) {
    Remove-Item $LauncherVbs -Force
    Write-Host "Launcher '$LauncherVbs' dihapus."
}

Write-Host "Proxy yang sedang jalan TIDAK ikut dimatikan -- jalankan .\stop.ps1 kalau mau menghentikannya."
