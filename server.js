'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const catalog = require('./lib/model-catalog');

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
// Ditulis begitu server mulai listen, dibaca oleh stop.sh/stop.ps1/restart.sh/restart.ps1
// supaya proses bisa dihentikan tanpa peduli cara start-nya (npm start, start.sh,
// start.ps1, atau "node server.js" langsung).
const PID_FILE = process.env.PID_FILE || '.dashscope-proxy.pid';
const STARTED_AT = Date.now();
// Untuk field `version` di GET /status (INTERFACE.md §2.7) -- dibaca sekali saat start;
// gagal baca tidak kritis, cukup fallback ke nilai default.
let VERSION = '0.0.0';
try { VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || VERSION; } catch (e) { /* biarkan default */ }

function loadKeys() {
  const fromEnv = (process.env.DASHSCOPE_API_KEYS || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  let fromFile = [];
  if (DASHSCOPE_API_KEYS_FILE) {
    try {
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

// Cuma melakukan fetch dan mengembalikan resp + timer -- BELUM membaca body, supaya
// respons sukses (mis. stream: true / SSE) bisa langsung di-pipe ke klien tanpa
// ditahan/dibuffer penuh dulu (lihat pipeSuccessBody). Body baru dibaca terpisah oleh
// pemanggil: untuk respons error dibuffer (perlu dibaca buat klasifikasi), untuk
// respons sukses di-pipe. Timer HARUS di-clear oleh pemanggil setelah selesai membaca
// body (bukan di sini), supaya UPSTREAM_TIMEOUT_MS tetap membatasi total waktu
// fetch + baca body, termasuk saat streaming.
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
    return { resp, timer };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Pipe body respons sukses langsung ke klien tanpa dibuffer penuh -- perlu untuk
// stream: true (SSE) supaya token mengalir bertahap, bukan menumpuk lalu dikirim
// sekaligus di akhir (dan berisiko kena UPSTREAM_TIMEOUT_MS untuk respons panjang).
// Konsekuensinya: begitu fungsi ini dipanggil, header sudah dikirim ke klien, jadi
// kalau stream gagal di tengah jalan, request TIDAK bisa dirotasi ke key lain lagi --
// itu trade-off yang melekat pada streaming (lihat handleProxyRequest).
async function pipeSuccessBody(resp, res) {
  if (!resp.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(resp.body), res);
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
    let fwd;
    try {
      fwd = await forwardOnce(entry, req.method, req.url, req.headers, bodyBuffer);
    } catch (err) {
      entry.totalFailures += 1;
      entry.lastError = err.message;
      entry.cooldownUntil = Date.now() + 5000;
      entry.cooldownReason = `network/timeout: ${err.message}`;
      log.push(`${entry.masked} -> gagal koneksi (${err.message})`);
      continue;
    }

    const { resp, timer } = fwd;

    // Sukses: header respons sudah diketahui (fetch() resolve begitu header upstream
    // tiba, sebelum body selesai) -- pipe body langsung ke klien tanpa dibuffer, supaya
    // stream: true (SSE) mengalir bertahap. Setelah titik ini rotasi TIDAK mungkin lagi
    // karena header sudah dikirim ke klien.
    if (resp.status >= 200 && resp.status < 300) {
      entry.lastError = null;
      const latency = Date.now() - started;
      console.log(`[ok] ${req.method} ${req.url} key=${entry.masked} status=${resp.status} ${latency}ms`);
      res.writeHead(resp.status, cleanResponseHeaders(resp.headers));
      try {
        await pipeSuccessBody(resp, res);
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    // Error: body upstream untuk error biasanya kecil (JSON) dan HARUS dibaca penuh
    // dulu supaya classifyFailure() bisa menentukan apakah perlu dirotasi -- belum ada
    // apa pun yang dikirim ke klien di titik ini, jadi masih aman untuk dicoba key lain.
    const buf = Buffer.from(await resp.arrayBuffer());
    clearTimeout(timer);
    const latency = Date.now() - started;
    const bodyText = buf.toString('utf8').slice(0, 2000);

    const cls = classifyFailure(resp.status, bodyText);
    if (!cls.retryable) {
      console.log(`[client-error] ${req.method} ${req.url} key=${entry.masked} status=${resp.status} ${latency}ms (tidak rotasi -- kesalahan request, bukan kuota)`);
      res.writeHead(resp.status, cleanResponseHeaders(resp.headers));
      res.end(buf);
      return;
    }

    entry.totalFailures += 1;
    entry.lastError = `HTTP ${resp.status}: ${bodyText.slice(0, 300)}`;
    let appliedCooldownMs = cls.cooldownMs;
    if (cls.scope === 'model' && model) {
      entry.modelCooldowns[model] = { until: Date.now() + cls.cooldownMs, reason: cls.reason };
    } else if (cls.scope === 'model') {
      // Model tidak diketahui dari body request (mis. GET tanpa body, atau body bukan
      // JSON) -- tidak bisa cooldown per-model dengan aman, jadi JANGAN pakai
      // cls.cooldownMs (bisa sampai 30 hari) untuk cooldown level KEY, karena itu akan
      // mematikan key untuk SEMUA model gara-gara satu request yang tidak jelas modelnya.
      // Pakai cooldown pendek sebagai gantinya.
      appliedCooldownMs = RATE_LIMIT_COOLDOWN_MS;
      entry.cooldownUntil = Date.now() + appliedCooldownMs;
      entry.cooldownReason = `${cls.reason} (model tidak diketahui dari request, cooldown key dipersingkat)`;
    } else {
      entry.cooldownUntil = Date.now() + cls.cooldownMs;
      entry.cooldownReason = cls.reason;
    }
    log.push(`${entry.masked} -> ${cls.reason} [scope=${cls.scope}${model ? `, model=${model}` : ''}], cooldown ${Math.round(appliedCooldownMs / 1000)}s`);
    console.log(`[rotate] ${req.method} ${req.url} key=${entry.masked} model=${model || '?'} status=${resp.status} ${latency}ms reason="${cls.reason}"`);
  }

  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: {
      message: 'Semua API key DashScope di pool sedang cooldown/gagal untuk model ini. Cek GET /status untuk detail.',
      code: 'pool_exhausted',
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
    // §2.7 INTERFACE.md: hitungan ringkas di level atas supaya operator (dan dashboard)
    // tidak perlu memindai array `keys` satu-satu; struktur lama tidak berubah.
    modelCooldownCount: keys.reduce((a, k) => a + k.modelCooldowns.length, 0),
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    version: VERSION,
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

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Bentuk error admin mengikuti kontrak INTERFACE.md §1: { error: { message, code } }.
function sendError(res, status, code, message) {
  sendJson(res, status, { error: { message, code } });
}

// Baca + parse body JSON untuk endpoint admin. Mengembalikan {} kalau body kosong
// (field wajib tetap divalidasi pemanggil), atau null kalau parse gagal -- dalam kasus
// itu respons 400 sudah ditulis di sini dan pemanggil harus langsung return.
async function readJsonBody(req, res) {
  const buf = await readBody(req); // melempar {statusCode:413} kalau kebesaran -> ditangkap handler server
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    sendError(res, 400, 'bad_request', 'Body bukan JSON yang valid.');
    return null;
  }
}

// Reset selektif (INTERFACE.md §2.3, P0-1) -- melengkapi POST /admin/reset yang global.
// Reset per-model adalah operasi paling berharga: cooldown free_tier_exhausted 30 hari,
// dan setelah isi saldo biasanya hanya sebagian model yang pulih.
async function handleResetModel(req, res) {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  if (typeof body.model !== 'string' || !body.model.trim() || body.model.trim().length > 200) {
    sendError(res, 400, 'bad_request', 'Field "model" (string) wajib diisi.');
    return;
  }
  const model = body.model.trim();
  let cleared = 0;
  for (const k of keyPool) {
    if (k.modelCooldowns[model]) { delete k.modelCooldowns[model]; cleared += 1; }
  }
  if (cleared === 0) {
    sendError(res, 404, 'not_found', `Tidak ada key yang sedang cooldown untuk model "${model}" -- tidak ada yang perlu direset.`);
    return;
  }
  sendJson(res, 200, { ok: true, model, cleared, message: `Cooldown model "${model}" dihapus dari ${cleared} key.` });
}

async function handleResetKey(req, res) {
  const body = await readJsonBody(req, res);
  if (body === null) return;
  if (typeof body.key !== 'string' || !body.key.trim()) {
    sendError(res, 400, 'bad_request', 'Field "key" (string) wajib diisi -- pakai bentuk masked dari GET /status.');
    return;
  }
  const wanted = body.key.trim();
  // Menerima bentuk masked (keluaran /status, alurnya: lihat -> salin -> reset) maupun
  // key mentah kalau operator memang memegangnya; respons hanya menyebut masked.
  const entry = keyPool.find((k) => k.masked === wanted || k.key === wanted);
  if (!entry) {
    sendError(res, 404, 'not_found', `Key "${wanted}" tidak ada di pool. Pakai bentuk masked dari GET /status.`);
    return;
  }
  // Hanya membersihkan cooldown LEVEL KEY -- cooldown per-model key ini sengaja tidak
  // disentuh (itu ranah /admin/reset/model), sesuai pembagian §2.3.
  const wasCooling = entry.cooldownUntil > Date.now();
  entry.cooldownUntil = 0;
  entry.cooldownReason = null;
  sendJson(res, 200, {
    ok: true,
    key: entry.masked,
    cleared: wasCooling ? 1 : 0,
    message: wasCooling
      ? `Cooldown key ${entry.masked} dihapus (cooldown per-model, bila ada, tidak disentuh).`
      : `Key ${entry.masked} memang tidak sedang cooldown level key.`,
  });
}

// ---------------- P0-2: katalog model hidup (INTERFACE.md §2.1-2.2) ----------------

// Cache daftar id model dari upstream dengan TTL -- hindari memukul DashScope setiap
// kali admin membuka katalog. Sumber: GET {upstream}/compatible-mode/v1/models
// (request paling ringan; tidak kena throttle kuota -- diverifikasi saat survei katalog).
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
let modelsCache = { fetchedAt: 0, ids: [], source: 'none', error: null };

async function fetchUpstreamModelIds() {
  // Pakai key pertama yang tidak sedang cooldown key-level; kalau semua dingin, pakai
  // key pertama saja (GET /models ringan, kemungkinan besar tetap lolos).
  const now = Date.now();
  const entry = keyPool.find((k) => k.cooldownUntil <= now) || keyPool[0];
  if (!entry) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`${UPSTREAM_ORIGIN}/compatible-mode/v1/models`, {
      headers: { Authorization: `Bearer ${entry.key}` },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} dari upstream /models`);
    const j = await resp.json();
    const ids = (j.data || []).map((m) => m && m.id).filter((x) => typeof x === 'string' && x);
    if (!ids.length) throw new Error('upstream /models membalas tanpa data');
    return ids;
  } finally {
    clearTimeout(timer);
  }
}

async function getModelIds() {
  const fresh = Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS && modelsCache.ids.length;
  if (fresh) return modelsCache;
  try {
    const ids = await fetchUpstreamModelIds();
    modelsCache = { fetchedAt: Date.now(), ids, source: 'live', error: null };
  } catch (e) {
    // Gagal ambil: pertahankan cache lama (lebih baik daripada daftar kosong) dan
    // tandai sumbernya supaya operator tahu datanya basi/gagal.
    modelsCache = {
      fetchedAt: modelsCache.fetchedAt,
      ids: modelsCache.ids,
      source: modelsCache.ids.length ? 'stale' : 'error',
      error: e.message,
    };
  }
  return modelsCache;
}

function blockedInfoFor(modelId, now) {
  const blocked = keyPool.filter(
    (k) => k.modelCooldowns[modelId] && k.modelCooldowns[modelId].until > now
  );
  const reasons = [...new Set(blocked.map((k) => k.modelCooldowns[modelId].reason))];
  return { blocked, reasons };
}

async function handleAdminModels(req, res, query) {
  const cache = await getModelIds();
  const now = Date.now();

  const rows = cache.ids.map((id) => {
    const meta = catalog.classify(id);
    const { blocked, reasons } = blockedInfoFor(id, now);
    return {
      id,
      category: meta.category,
      transport: meta.transport,
      status: catalog.statusFor(id, blocked.length, keyPool.length),
      keysBlocked: blocked.length,
      keysTotal: keyPool.length,
      blockedReasons: reasons,
      recommended: catalog.taskLabelFor(id),
      notes: meta.notes,
    };
  });

  // Filter opsional: category (eksak), q (substring id), status (CSV), recommended (bool).
  const q = (query.q || '').toLowerCase();
  const category = query.category || '';
  const statusFilter = (query.status || '').split(',').map((s) => s.trim()).filter(Boolean);
  const recommendedOnly = query.recommended === 'true' || query.recommended === '1';

  const filtered = rows.filter((row) => {
    if (category && row.category !== category) return false;
    if (q && !row.id.toLowerCase().includes(q)) return false;
    if (statusFilter.length && !statusFilter.includes(row.status)) return false;
    if (recommendedOnly && !row.recommended) return false;
    return true;
  });

  const summary = { ok: 0, partial: 0, exhausted: 0, special: 0 };
  for (const row of rows) {
    if (summary[row.status] !== undefined) summary[row.status] += 1;
  }

  sendJson(res, 200, {
    asOf: new Date(cache.fetchedAt || Date.now()).toISOString(),
    source: cache.source,
    upstreamError: cache.error,
    totalModels: rows.length,
    filtered: filtered.length,
    summary,
    models: filtered,
  });
}

async function handleAdminModelDetail(req, res, modelId) {
  const cache = await getModelIds();
  const now = Date.now();
  const meta = catalog.classify(modelId);
  // "Dikenal" = ada di daftar upstream ATAU terkurasi di katalog (mis. rerank yang tidak
  // muncul di /models tapi terkurasi di MODELS.md §10).
  const known = cache.ids.includes(modelId) || meta.category !== 'unknown';
  if (!known) {
    sendError(res, 404, 'not_found',
      `Model "${modelId}" tidak dikenal: tidak ada di daftar upstream dan tidak ada di kurasi katalog.`);
    return;
  }

  const blocked = keyPool.filter(
    (k) => k.modelCooldowns[modelId] && k.modelCooldowns[modelId].until > now
  );
  const reasonBreakdown = {};
  for (const k of blocked) {
    const reason = k.modelCooldowns[modelId].reason;
    reasonBreakdown[reason] = (reasonBreakdown[reason] || 0) + 1;
  }

  sendJson(res, 200, {
    id: modelId,
    verdict: catalog.statusFor(modelId, blocked.length, keyPool.length),
    category: meta.category,
    transport: meta.transport,
    recommended: catalog.taskLabelFor(modelId),
    notes: meta.notes,
    keysTotal: keyPool.length,
    keysBlocked: blocked.length,
    reasonBreakdown,
    sample: blocked.slice(0, 5).map((k) => ({
      key: k.masked,
      reason: k.modelCooldowns[modelId].reason,
      cooldownUntil: new Date(k.modelCooldowns[modelId].until).toISOString(),
    })),
  });
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
    let overflowed = false;
    req.on('data', (chunk) => {
      if (overflowed) return; // sisa body tidak ditumpuk di memori lagi
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        overflowed = true;
        // PAUSE, jangan destroy(): destroy() memutus koneksi SEBELUM respons 413 sempat
        // terkirim, sehingga klien (undici/axios/n8n) cuma melihat "connection reset" dan
        // tidak tahu bahwa penyebabnya body terlalu besar. Dengan pause, respons 413 di
        // bawah (yang memakai Connection: close) tetap flushed dulu, baru socket ditutup.
        req.pause();
        reject(Object.assign(new Error('Body terlalu besar'), { statusCode: 413 }));
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

    if (req.url === '/admin/reset/model' && req.method === 'POST') {
      if (!isAuthorized(req)) { res.writeHead(401).end('Unauthorized'); return; }
      await handleResetModel(req, res);
      return;
    }

    if (req.url === '/admin/reset/key' && req.method === 'POST') {
      if (!isAuthorized(req)) { res.writeHead(401).end('Unauthorized'); return; }
      await handleResetKey(req, res);
      return;
    }

    // ---- P0-2: katalog model (INTERFACE.md §2.1-2.2) ----
    // Pathname & query dipisah di sini karena rute model butuh query string
    // (?category=...&q=...) dan id di path; rute lama di atas membandingkan string penuh.
    const qIdx = req.url.indexOf('?');
    const pathname = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
    const query = qIdx === -1 ? {} : Object.fromEntries(new URLSearchParams(req.url.slice(qIdx + 1)));

    if (pathname === '/admin/models' && req.method === 'GET') {
      if (!isAuthorized(req)) { res.writeHead(401).end('Unauthorized'); return; }
      await handleAdminModels(req, res, query);
      return;
    }

    if (pathname.startsWith('/admin/models/') && req.method === 'GET') {
      if (!isAuthorized(req)) { res.writeHead(401).end('Unauthorized'); return; }
      let modelId;
      try {
        // decode supaya id ber-%2F (mis. "kimi/kimi-k3", "ZHIPU/GLM-5.3") tetap utuh.
        modelId = decodeURIComponent(pathname.slice('/admin/models/'.length));
      } catch {
        sendError(res, 400, 'bad_request', 'Pengkodean URL model id tidak valid.');
        return;
      }
      if (!modelId) { sendError(res, 404, 'not_found', 'Path tidak dikenal.'); return; }
      await handleAdminModelDetail(req, res, modelId);
      return;
    }

    // Namespace /admin/* khusus admin API: path tak dikenal di dalamnya TIDAK boleh
    // jatuh ke pass-through upstream — bisa memicu request tak disengaja ke DashScope
    // dan membingungkan operator. Mis. POST /admin/probe sebelum P1 ada -> 404 jelas.
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      sendError(res, 404, 'not_found', `Path admin tidak dikenal: ${pathname} (metode ${req.method}).`);
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
    if (res.headersSent) {
      console.error(`Error setelah respons mulai dikirim: ${err.message}`);
      res.destroy();
      return;
    }
    const status = err.statusCode || 500;
    const headers = { 'Content-Type': 'application/json' };
    // Body 413: request belum selesai dibaca, jadi socket wajib ditutup setelah respons
    // diflush (Connection: close) -- kalau tidak, koneksi keep-alive menggantung sisa upload.
    if (status === 413) headers.Connection = 'close';
    res.writeHead(status, headers);
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
});

function writePidFile() {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (e) {
    // Gagal tulis pidfile (mis. filesystem read-only di sebagian setup container) tidak
    // fatal buat proxy itu sendiri -- cuma bikin stop.sh/stop.ps1 tidak bisa otomatis
    // menemukan proses ini.
    console.warn(`Tidak bisa menulis PID file ${PID_FILE}: ${e.message}`);
  }
}

function removePidFile() {
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch (e) {
    // Pidfile sudah tidak ada / tidak kebaca -- tidak masalah, tidak ada yang perlu dibersihkan.
  }
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Menerima ${signal}, menutup server...`);
  removePidFile();
  server.close(() => process.exit(0));
  // Jaga-jaga kalau ada koneksi keep-alive yang bikin server.close() tidak pernah
  // selesai -- tetap keluar setelah beberapa detik daripada proses menggantung selamanya.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', removePidFile);

server.listen(PORT, () => {
  console.log(`DashScope proxy jalan di port ${PORT}, ${keyPool.length} API key dimuat, upstream=${UPSTREAM_ORIGIN}`);
  if (!PROXY_ACCESS_TOKEN) {
    console.warn('PROXY_ACCESS_TOKEN tidak diset -- endpoint proxy TERBUKA tanpa autentikasi di dalam network ini.');
  }
  writePidFile();
});
