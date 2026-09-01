# Daftarkan autostart dashscope-proxy lewat Task Scheduler supaya proxy jalan
# otomatis setiap kali Windows nyala, tanpa perlu dijalankan manual dari terminal.
#
# Dua varian:
#   .\install-autostart.ps1              -> task dipicu saat user LOGIN, berjalan
#                                           sebagai user yang menginstal. Ini
#                                           default karena proses dimiliki user
#                                           biasa, jadi stop.ps1/restart.ps1 tetap
#                                           bisa mematikannya tanpa admin.
#   .\install-autostart.ps1 -AtStartup   -> task dipicu saat BOOT (sebelum login),
#                                           berjalan sebagai SYSTEM -- cocok kalau
#                                           mesin dipakai sebagai server/headless.
#                                           Efek samping: proses dimiliki SYSTEM,
#                                           jadi stop.ps1 harus dijalankan sebagai
#                                           administrator untuk mematikannya.
#
# Task-nya memanggil start.ps1 (baca .env + set default + node server.js) lewat
# launcher VBS kecil yang dibuat otomatis (autostart-launcher.vbs) supaya tidak
# ada jendela console yang muncul/flash saat login. Konfigurasi penting: tanpa
# batas waktu eksekusi (default Task Scheduler 3 hari akan mematikan server!),
# tetap jalan saat pakai baterai, tidak dobel kalau instance lama masih hidup,
# dan retry otomatis sampai 3x kalau gagal start.
#
# Hapus autostart lagi lewat .\remove-autostart.ps1.

param(
    [switch]$AtStartup
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$TaskName    = "DashscopeProxy Autostart"
$StartScript = Join-Path $PSScriptRoot "start.ps1"
$LauncherVbs = Join-Path $PSScriptRoot "autostart-launcher.vbs"

if (-not (Test-Path $StartScript)) {
    Write-Error "start.ps1 tidak ditemukan di $PSScriptRoot -- autostart tidak bisa didaftarkan."
    exit 1
}

# Register-ScheduledTask butuh administrator -- elevasi otomatis lewat UAC kalau
# belum (script dijalankan ulang sebagai admin dengan argumen yang sama).
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    Write-Host "Butuh hak administrator untuk mendaftar Task Scheduler -- elevasi otomatis..."
    $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    if ($AtStartup) { $argList += " -AtStartup" }
    Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argList
    exit 0
}

# Launcher VBS: jalankan start.ps1 lewat PowerShell dengan window hidden
# (argumen 0) dan tanpa menunggu selesai (argumen False). Path di dalam string
# VBS dikunci dengan kutip ganda ("") supaya aman kalau path mengandung spasi.
$vbs = @"
' Dibuat otomatis oleh install-autostart.ps1 -- jangan diedit manual.
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$StartScript""", 0, False
"@
Set-Content -Path $LauncherVbs -Value $vbs -Encoding ASCII

# PT0S (TimeSpan nol) = tanpa batas waktu eksekusi; IgnoreNew = jangan buat
# instance kedua kalau proxy dari trigger sebelumnya masih jalan.
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable

$Action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "//B //Nologo `"$LauncherVbs`"" -WorkingDirectory $PSScriptRoot

if ($AtStartup) {
    $Trigger = New-ScheduledTaskTrigger -AtStartup
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -User "SYSTEM" -Description "Menjalankan dashscope-proxy (start.ps1 -> node server.js) otomatis saat Windows boot." -Force | Out-Null
    $mode = "saat Windows boot (sebagai SYSTEM, tanpa perlu login)"
} else {
    $Trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Menjalankan dashscope-proxy (start.ps1 -> node server.js) otomatis saat user login." -Force | Out-Null
    $mode = "saat user login (sebagai user $env:USERNAME)"
}

Write-Host ""
Write-Host "OK: task '$TaskName' terdaftar -- proxy akan jalan otomatis $mode."
Write-Host "    Test manual tanpa reboot : Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "    Cek status task          : Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "    Hapus autostart          : .\remove-autostart.ps1"
