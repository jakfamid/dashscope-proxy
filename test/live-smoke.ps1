# Smoke test terhadap proxy yang SEDANG JALAN dengan upstream DashScope asli.
# Pemakaian: .\test\live-smoke.ps1 [-Model qwen3.8-flash] [-Port 8787]
# Catatan: call chat/completions benar-benar memakai kuota trial key.
param(
    [int]$Port = 8787,
    [string]$Model = ""
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-Location -Path (Split-Path -Parent $PSScriptRoot)

# Ambil token dari .env tanpa menampilkannya ke layar.
$token = ""
if (Test-Path ".env") {
    $line = Get-Content ".env" | Where-Object { $_ -match '^\s*DASHSCOPE_PROXY_TOKEN\s*=' } | Select-Object -Last 1
    if ($line) {
        $token = ($line -replace '^\s*DASHSCOPE_PROXY_TOKEN\s*=', '').Trim()
        if ($token -match '^"(.*)"$' -or $token -match "^'(.*)'$") { $token = $Matches[1] }
    }
}
if (-not $token) { Write-Host "GAGAL: DASHSCOPE_PROXY_TOKEN tidak ditemukan di .env"; exit 1 }

$base = "http://127.0.0.1:$Port"
$H = @{ Authorization = "Bearer $token" }
$fails = 0

function Step($name, $block) {
    try {
        & $block
        Write-Host ("  PASS  {0}" -f $name)
    } catch {
        $script:fails++
        Write-Host ("  FAIL  {0} -- {1}" -f $name, $_.Exception.Message)
    }
}

Write-Host "`n=== Live smoke test: $base (upstream DashScope asli) ==="

Step "healthz membalas ok" {
    $r = Invoke-WebRequest -Uri "$base/healthz" -UseBasicParsing
    if ($r.StatusCode -ne 200 -or $r.Content -ne 'ok') { throw "status=$($r.StatusCode) body=$($r.Content)" }
}

Step "request tanpa token ditolak 401" {
    try {
        Invoke-WebRequest -Uri "$base/status" -UseBasicParsing | Out-Null
        throw "malah diterima (seharusnya 401)"
    } catch {
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 401) { return }
        throw "bukan 401: $($_.Exception.Message)"
    }
}

$status = $null
Step "GET /status (dengan token) -> ringkasan pool" {
    $script:status = (Invoke-WebRequest -Uri "$base/status" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
    if ($script:status.totalKeys -lt 1) { throw "totalKeys=$($script:status.totalKeys)" }
    Write-Host ("        totalKeys={0} availableNow={1}" -f $script:status.totalKeys, $script:status.availableNow)
}

Step "GET /compatible-mode/v1/models -> daftar model upstream" {
    $m = (Invoke-WebRequest -Uri "$base/compatible-mode/v1/models" -Headers $H -UseBasicParsing).Content | ConvertFrom-Json
    Write-Host ("        {0} model terlihat, contoh: {1}" -f $m.data.Count, (($m.data | Select-Object -First 6 | ForEach-Object { $_.id }) -join ", "))
    if (-not $script:Model -and $m.data.Count -gt 0) { $script:Model = "qwen3.8-flash" }
    if ($m.data.Count -lt 1) { throw "daftar model kosong" }
}

Step "POST /compatible-mode/v1/chat/completions (model: $Model) -> balasan asli" {
    $body = @{ model = $Model; messages = @(@{ role = "user"; content = "Balas persis dengan kata: OK" }); max_tokens = 10 } | ConvertTo-Json -Depth 5
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $c = (Invoke-WebRequest -Uri "$base/compatible-mode/v1/chat/completions" -Method Post -Headers $H -ContentType "application/json" -Body $body -UseBasicParsing).Content
    $sw.Stop()
    $j = $c | ConvertFrom-Json
    $txt = $j.choices[0].message.content
    Write-Host ("        {0}ms -> '{1}' (tokens: {2})" -f $sw.ElapsedMilliseconds, $txt, $j.usage.total_tokens)
    if (-not $txt) { throw "balasan kosong: $($c.Substring(0, [Math]::Min(200, $c.Length)))" }
}

Step "POST stream:true -> chunk SSE mengalir + diakhiri [DONE]" {
    $body = @{ model = $Model; messages = @(@{ role = "user"; content = "Sebutkan 3 angka." }); stream = $true } | ConvertTo-Json -Depth 5
    $resp = Invoke-WebRequest -Uri "$base/compatible-mode/v1/chat/completions" -Method Post -Headers $H -ContentType "application/json" -Body $body -UseBasicParsing
    $lines = ($resp.Content -split "`n") | Where-Object { $_ -match '^data: ' }
    Write-Host ("        {0} baris data SSE, berakhir: {1}" -f $lines.Count, $lines[-1])
    if ($resp.Headers['Content-Type'] -notmatch 'event-stream') { throw "Content-Type=$($resp.Headers['Content-Type'])" }
    if ($lines.Count -lt 2) { throw "chunk terlalu sedikit: $($resp.Content.Substring(0, [Math]::Min(200, $resp.Content.Length)))" }
    if ($lines[-1] -notmatch '\[DONE\]') { throw "tidak ada penanda [DONE]" }
}

Write-Host ("`nHASIL: {0} PASS, {1} FAIL" -f (5 - $fails), $fails)
if ($status) {
    Write-Host "`n=== Kondisi pool key (ringkas) ==="
    $status.keys | Group-Object status | ForEach-Object { Write-Host ("  {0}: {1} key" -f $_.Name, $_.Count) }
    foreach ($k in ($status.keys | Where-Object { $_.status -eq 'cooldown' } | Select-Object -First 5)) {
        Write-Host ("  cooldown {0}: {1}" -f $k.key, $k.cooldownReason)
    }
    foreach ($k in ($status.keys | Where-Object { $_.modelCooldowns.Count -gt 0 } | Select-Object -First 5)) {
        foreach ($mc in $k.modelCooldowns) { Write-Host ("  model-cooldown {0} [{1}]: {2} s/d {3}" -f $k.key, $mc.model, $mc.reason, $mc.cooldownUntil) }
    }
}
exit $(if ($fails -eq 0) { 0 } else { 1 })
