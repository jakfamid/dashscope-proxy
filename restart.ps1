# Hentikan proxy (kalau sedang jalan) lalu jalankan lagi lewat start.ps1.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

& "$PSScriptRoot\stop.ps1"
& "$PSScriptRoot\start.ps1"
