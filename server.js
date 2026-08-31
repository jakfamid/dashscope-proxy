'use strict';

const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8787', 10);
const UPSTREAM_HOST = process.env.DASHSCOPE_UPSTREAM_HOST || 'dashscope-intl.aliyuncs.com';
// Override penuh (termasuk skema) dipakai untuk pengujian lokal terhadap mock server http://.
const UPSTREAM_ORIGIN = process.env.DASHSCOPE_UPSTREAM_ORIGIN || `https://${UPSTREAM_HOST}`;
const DASHSCOPE_API_KEYS_FILE = process.env.DASHSCOPE_API_KEYS_FILE || '.\\api-key.txt';
const PROXY_ACCESS_TOKEN = process.env.PROXY_ACCESS_TOKEN || process.env.DASHSCOPE_PROXY_TOKEN || '';
// PROXY_ACCESS_TOKEN bisa datang dari env langsung (docker-compose), dari start.sh/start.ps1,
// atau dari .env via `node --env-file-if-exists=.env` (npm start) yang hanya berisi
// DASHSCOPE_PROXY_TOKEN -- makanya perlu fallback ke situ, demi konsistensi dengan pemetaan
// yang sudah dilakukan start.ps1 / start.sh / docker-compose.yaml.
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(25 * 1024 * 1024), 10);
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '120000', 10);
const RATE_LIMIT_COOLDOWN_MS = parseInt(process.env.RATE_LIMIT_COOLDOWN_MS || String(60 * 1000), 10);
const INVALID_KEY_COOLDOWN_MS = parseInt(process.env.INVALID_KEY_COOLDOWN_MS || String(6 * 60 * 60 * 1000), 10);
// Kuota trial gratis DashScope adalah jatah SEKALI PAKAI per model (tidak reset harian --
// dikonfirmasi lewat tes langsung: key yang habis untuk qwen-plus tetap jalan normal untuk
// qwen3-max). Jadi begitu habis, kemungkinan besar PERMANEN sampai akun diisi saldo/billing,
// bukan sesuatu yang "nanti pulih sendiri". Cooldown panjang di sini cuma supaya proxy
// berhenti buang waktu mencoba kombinasi yang sudah terbukti mati, bukan klaim bahwa nanti
// pasti pulih di waktu tsb -- pakai POST /admin/reset kalau sudah menambah saldo.
const FREE_TIER_EXHAUSTED_COOLDOWN_MS = parseInt(process.env.FREE_TIER_EXHAUSTED_COOLDOWN_MS || String(30 * 24 * 60 * 60 * 1000), 10);
const MODEL_ACCESS_DENIED_COOLDOWN_MS = parseInt(process.env.MODEL_ACCESS_DENIED_COOLDOWN_MS || String(24 * 60 * 60 * 1000), 10);
// Batas total waktu rotasi per request. Tanpa ini, kalau upstream hang (bukan gagal cepat
// seperti 401/429), proxy akan mencoba SEMUA key di pool satu-satu, masing-masing menunggu
// sampai UPSTREAM_TIMEOUT_MS penuh -- dengan pool besar ini bisa jadi puluhan menit sebelum
// klien akhirnya dapat balasan 503. Timeout attempt individual TIDAK dipotong (biar respons
// lambat tapi valid tetap sempat selesai) -- yang dibatasi cuma jumlah waktu yang dihabiskan
// pindah dari satu key ke key berikutnya.
const REQUEST_MAX_DURATION_MS = parseInt(process.env.REQUEST_MAX_DURATION_MS || String(2 * UPSTREAM_TIMEOUT_MS), 10);

function loadKeys() {
  const fromEnv = (process.env.DASHSCOPE_API_KEYS || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  let fromFile = [];
  if (DASHSCOPE_API_KEYS_FILE) {
    try {
      const fs = require('fs');
      fromFile = fs
        .readFileSync(DASHSCOPE_API_KEYS_FILE, 'utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'));
    } catch (e) {
      console.error(`Gagal baca DASHSCOPE_API_KEYS_FILE: ${e.message}`);
    }
  }
  return Array.from(new Set([...fromEnv, ...fromFile]));
}

const rawKeys = loadKeys();
if (rawKeys.length === 0) {
  console.error('DASHSCOPE_API_KEYS (atau DASHSCOPE_API_KEYS_FILE) kosong -- proxy tidak bisa jalan tanpa API key.');
  process.exit(1);
}

function maskKey(k) {
  if (k.length <= 10) return `${k.slice(0, 2)}***`;
  return `${k.slice(0, 6)}...${k.slice(-4)}`;
}

const keyPool = rawKeys.map((key) => ({
  key,
  masked: maskKey(key),
  cooldownUntil: 0, // cooldown level KEY (kredensial invalid, network error) -- blokir semua model
  cooldownReason: null,
  modelCooldowns: {}, // { [model]: { until, reason } } -- kuota/akses model tsb SAJA yang mati, key lain masih hidup
  totalRequests: 0,
  totalFailures: 0,
  lastUsedAt: null,
  lastError: null,
}));

function isKeyAvailable(entry, model, now) {
  if (entry.cooldownUntil > now) return false;
  if (model && entry.modelCooldowns[model] && entry.modelCooldowns[model].until > now) return false;
  return true;
}

let rrPointer = 0;

// Round-robin di antara key yang tersedia untuk model yang diminta. Kalau semua
// cooldown, tetap kembalikan urutan (diprioritaskan yang paling cepat pulih) --
// lebih baik dicoba (bisa jadi cooldown sudah lewat) daripada langsung menyerah.
function pickKeysInOrder(model) {
  const n = keyPool.length;
  const ordered = [];
  for (let i = 0; i < n; i++) ordered.push(keyPool[(rrPointer + i) % n]);
  rrPointer = (rrPointer + 1) % n;
  const now = Date.now();
  const available = ordered.filter((k) => isKeyAvailable(k, model, now));
  const cooling = ordered
    .filter((k) => !isKeyAvailable(k, model, now))
    .sort((a, b) => {
      const untilA = model && a.modelCooldowns[model] ? Math.max(a.cooldownUntil, a.modelCooldowns[model].until) : a.cooldownUntil;
      const untilB = model && b.modelCooldowns[model] ? Math.max(b.cooldownUntil, b.modelCooldowns[model].until) : b.cooldownUntil;
      return untilA - untilB;
    });
  return [...available, ...cooling];
}

function msUntilNextUtcMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return next.getTime() - now.getTime();
}

function tryParseErrorCode(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    return (parsed && parsed.error && (parsed.error.code || parsed.error.type)) || null;
  } catch (e) {
    return null;
  }
}

// Heuristik klasifikasi kegagalan -- DashScope compatible-mode TIDAK punya endpoint resmi
// untuk cek sisa kuota per key, jadi status "habis" disimpulkan dari kode error respons.
// PENTING (dikonfirmasi lewat tes langsung ke DashScope): kuota trial gratis dialokasikan
// PER MODEL per key, bukan per key secara keseluruhan -- key yang habis kuota untuk satu
// model bisa saja masih penuh untuk model lain. Karena itu error kuota/akses model harus
// masuk cooldown level MODEL (scope:'model'), bukan mematikan seluruh key (scope:'key').
function classifyFailure(status, bodyText) {
  const code = (tryParseErrorCode(bodyText) || '').toLowerCase();

  if (code.includes('freetieronly') || code.includes('allocationquota')) {
    return { retryable: true, scope: 'model', cooldownMs: FREE_TIER_EXHAUSTED_COOLDOWN_MS, reason: 'kuota trial gratis untuk model ini habis (kemungkinan permanen sampai isi saldo -- reset manual via /admin/reset)' };
  }
  if (code.includes('access_denied') || code.includes('accessdenied')) {
    return { retryable: true, scope: 'model', cooldownMs: MODEL_ACCESS_DENIED_COOLDOWN_MS, reason: 'model tidak diaktifkan/tidak tersedia untuk akun key ini' };
  }
  if (code.includes('ratequota') || code.includes('throttling')) {
    return { retryable: true, scope: 'model', cooldownMs: RATE_LIMIT_COOLDOWN_MS, reason: 'rate limit per menit/detik untuk model ini' };
  }
  if (status === 429) {
    return { retryable: true, scope: 'model', cooldownMs: RATE_LIMIT_COOLDOWN_MS, reason: 'HTTP 429 (kode error tidak dikenali, asumsikan rate limit sementara)' };
  }
  if (status === 401) {
    return { retryable: true, scope: 'key', cooldownMs: INVALID_KEY_COOLDOWN_MS, reason: 'key ditolak (HTTP 401 -- kemungkinan kredensial tidak valid)' };
  }
  if (status === 403) {
    // 403 tanpa kode error yang cocok di atas -- perlakukan sebagai isu spesifik-model
    // (lebih aman daripada mematikan seluruh key untuk error yang belum pernah diamati).
    return { retryable: true, scope: 'model', cooldownMs: MODEL_ACCESS_DENIED_COOLDOWN_MS, reason: `HTTP 403 (kode error tidak dikenali: ${code || 'tidak ada'})` };
  }
  if (status >= 500) {
    return { retryable: true, scope: 'key', cooldownMs: 5000, reason: `error upstream (HTTP ${status})` };
  }
  return { retryable: false, scope: null, cooldownMs: 0, reason: null };
}

// fetch() sudah otomatis membongkar gzip/br saat kita baca resp.arrayBuffer(), tapi header
// upstream asli (content-encoding, content-length, transfer-encoding) masih menyebut body
// yang TERKOMPRESI. Kalau header itu diteruskan apa adanya bersama body yang sudah plain,
// klien (n8n/axios) akan mencoba gunzip ulang body yang bukan gzip lagi -> error
// "incorrect header check". Header-header itu wajib dibuang di sini.
const STRIP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);
function cleanResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

async function forwardOnce(entry, method, path, headers, bodyBuffer) {
  const url = UPSTREAM_ORIGIN + path;
  const outHeaders = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (['host', 'authorization', 'content-length', 'connection'].includes(lower)) continue;
    outHeaders.set(k, v);
  }
  outHeaders.set('Authorization', `Bearer ${entry.key}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method,
      headers: outHeaders,
      body: ['GET', 'HEAD'].includes(method) ? undefined : bodyBuffer,
      signal: controller.signal,
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    return { status: resp.status, headers: resp.headers, body: buf };
  } finally {
    clearTimeout(timer);
  }
}

function extractModel(bodyBuffer) {
  try {
    const parsed = JSON.parse(bodyBuffer.toString('utf8'));
    return (parsed && typeof parsed.model === 'string') ? parsed.model : null;
  } catch (e) {
    return null;
  }
}

async function handleProxyRequest(req, res, bodyBuffer) {
  const model = extractModel(bodyBuffer);
  const attempts = pickKeysInOrder(model);
  const log = [];
  const requestStarted = Date.now();

  for (const entry of attempts) {
    if (Date.now() - requestStarted >= REQUEST_MAX_DURATION_MS) {
      log.push(`berhenti rotasi -- batas waktu total request (${REQUEST_MAX_DURATION_MS}ms) tercapai, sisa key tidak dicoba`);
      break;
    }
    entry.totalRequests += 1;
    entry.lastUsedAt = new Date().toISOString();
    const started = Date.now();
    let result;
    try {
      result = await forwardOnce(entry, req.method, req.url, req.headers, bodyBuffer);
    } catch (err) {
      entry.totalFailures += 1;
      entry.lastError = err.message;
      entry.cooldownUntil = Date.now() + 5000;
      entry.cooldownReason = `network/timeout: ${err.message}`;
      log.push(`${entry.masked} -> gagal koneksi (${err.message})`);
      continue;
    }

    const latency = Date.now() - started;
    const bodyText = result.body.toString('utf8').slice(0, 2000);

    if (result.status >= 200 && result.status < 300) {
      entry.lastError = null;
      console.log(`[ok] ${req.method} ${req.url} key=${entry.masked} status=${result.status} ${latency}ms`);
      res.writeHead(result.status, cleanResponseHeaders(result.headers));
      res.end(result.body);
      return;
    }

    const cls = classifyFailure(result.status, bodyText);
    if (!cls.retryable) {
      console.log(`[client-error] ${req.method} ${req.url} key=${entry.masked} status=${result.status} ${latency}ms (tidak rotasi -- kesalahan request, bukan kuota)`);
      res.writeHead(result.status, cleanResponseHeaders(result.headers));
      res.end(result.body);
      return;
    }

    entry.totalFailures += 1;
    entry.lastError = `HTTP ${result.status}: ${bodyText.slice(0, 300)}`;
    if (cls.scope === 'model' && model) {
      entry.modelCooldowns[model] = { until: Date.now() + cls.cooldownMs, reason: cls.reason };
    } else {
      entry.cooldownUntil = Date.now() + cls.cooldownMs;
      entry.cooldownReason = cls.reason;
    }
    log.push(`${entry.masked} -> ${cls.reason} [scope=${cls.scope}${model ? `, model=${model}` : ''}], cooldown ${Math.round(cls.cooldownMs / 1000)}s`);
    console.log(`[rotate] ${req.method} ${req.url} key=${entry.masked} model=${model || '?'} status=${result.status} ${latency}ms reason="${cls.reason}"`);
  }

  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: {
      message: 'Semua API key DashScope di pool sedang cooldown/gagal untuk model ini. Cek GET /status untuk detail.',
      model,
      attempts: log,
    },
  }));
}

function handleStatus(req, res) {
  const now = Date.now();
  const keys = keyPool.map((k) => {
    const activeModelCooldowns = Object.entries(k.modelCooldowns)
      .filter(([, v]) => v.until > now)
      .map(([model, v]) => ({ model, cooldownUntil: new Date(v.until).toISOString(), reason: v.reason }));
    return {
      key: k.masked,
      status: k.cooldownUntil > now ? 'cooldown' : 'active',
      cooldownUntil: k.cooldownUntil > now ? new Date(k.cooldownUntil).toISOString() : null,
      cooldownReason: k.cooldownUntil > now ? k.cooldownReason : null,
      modelCooldowns: activeModelCooldowns,
      totalRequests: k.totalRequests,
      totalFailures: k.totalFailures,
      lastUsedAt: k.lastUsedAt,
      lastError: k.lastError,
    };
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    totalKeys: keyPool.length,
    availableNow: keys.filter((k) => k.status === 'active').length,
    keys,
  }, null, 2));
}

function handleResetAll(req, res) {
  for (const k of keyPool) {
    k.cooldownUntil = 0;
    k.cooldownReason = null;
    k.modelCooldowns = {};
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, message: 'Semua cooldown key (termasuk per-model) direset.' }));
}

function isAuthorized(req) {
  if (!PROXY_ACCESS_TOKEN) return true;
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  // timingSafeEqual butuh panjang buffer yang sama -- perbandingan panjang di sini masih
  // bocorin timing sedikit, tapi itu standar (lihat dok Node crypto) dan jauh lebih aman
  // daripada "===" yang bocorin timing per-karakter yang cocok.
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(PROXY_ACCESS_TOKEN);
  if (tokenBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(tokenBuf, expectedBuf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Body terlalu besar'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.url === '/status' && req.method === 'GET') {
      if (!isAuthorized(req)) { res.writeHead(401).end('Unauthorized'); return; }
      handleStatus(req, res);
      return;
    }

    if (req.url === '/admin/reset' && req.method === 'POST') {
      if (!isAuthorized(req)) { res.writeHead(401).end('Unauthorized'); return; }
      handleResetAll(req, res);
      return;
    }

    if (!isAuthorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized -- token proxy tidak cocok.' } }));
      return;
    }

    const bodyBuffer = await readBody(req);
    await handleProxyRequest(req, res, bodyBuffer);
  } catch (err) {
    const status = err.statusCode || 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
});

server.listen(PORT, () => {
  console.log(`DashScope proxy jalan di port ${PORT}, ${keyPool.length} API key dimuat, upstream=${UPSTREAM_ORIGIN}`);
  if (!PROXY_ACCESS_TOKEN) {
    console.warn('PROXY_ACCESS_TOKEN tidak diset -- endpoint proxy TERBUKA tanpa autentikasi di dalam network ini.');
  }
});
