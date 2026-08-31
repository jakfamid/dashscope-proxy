'use strict';

// Integrasi test untuk server.js terhadap MOCK upstream (tidak menyentuh DashScope asli,
// jadi tidak menghabiskan kuota). Jalankan: node test/proxy-integration.test.js
// (artifak sementara -- pidfile & daftar key test -- ditulis ke logs/ yang di-gitignore)
// Cover: autentikasi token, rotasi key + cooldown (key-level vs model-level), 503 saat
// semua key mati (code pool_exhausted), penerusan 4xx klien tanpa rotasi, streaming SSE,
// stripping header gzip, batas ukuran body, /status (termasuk field §2.7), katalog model
// GET /admin/models + /admin/models/{id} (P0-2), /admin/reset (global, per-model,
// per-key), dan penulisan PID file.

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 9911;
const PROXY_PORT = 9912;
const TOKEN = 'token-tes-integrasi-123';
const PIDFILE = path.join('logs', 'proxy-integration.pid');
const PID_PATH = path.join(ROOT, PIDFILE);
// Daftar key test ditulis ke file sendiri (BUKAN override env jadi string kosong):
// di Windows, env var dengan nilai "" dianggap dihapus, jadi server.js akan jatuh ke
// default '.\api-key.txt' dan pool asli (119 key) ikut termuat ke dalam tes ini.
const KEYFILE = path.join('logs', 'proxy-integration.keys.txt');
const KEY_PATH = path.join(ROOT, KEYFILE);


// Suffix unik per key supaya bisa dikenali dari bentuk masked-nya (sk-moc...0001).
const KEYS = [
  'sk-mock-good-key-0001',
  'sk-mock-bearer-401-key-0002',
  'sk-mock-server-503-key-0003',
  'sk-mock-ratequota-key-0004',
  'sk-mock-freetier-key-0005',
  'sk-mock-model403-key-0006',
];
const GOOD = KEYS[0];

function chatBody(content) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model: 'mock',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { total_tokens: 3 },
  };
}

function mockOutcome(key, model) {
  if (model === 'm-clienterr') return { status: 400, body: { error: { message: 'parameter tidak valid (mock)', code: 'InvalidParameter' } } };
  if (model === 'm-empty-pool') return { status: 429, body: { error: { message: 'free tier habis (mock)', code: 'AllocationQuota.FreeTierOnly' } } };
  if (key === GOOD) return null; // sukses
  if (key === KEYS[1]) return { status: 401, body: { error: { message: 'api key ditolak (mock)', code: 'InvalidApiKey' } } };
  if (key === KEYS[2]) return { status: 503, body: { error: { message: 'upstream mock error', code: 'InternalError' } } };
  if (key === KEYS[3]) return { status: 429, body: { error: { message: 'rate limit (mock)', code: 'Throttling.RateQuota' } } };
  if (key === KEYS[5]) return { status: 403, body: { error: { message: 'model akses ditolak (mock)', code: 'AccessDenied' } } };
  return { status: 429, body: { error: { message: 'free tier habis (mock)', code: 'AllocationQuota.FreeTierOnly' } } };
}

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    let parsed = {};
    try { parsed = JSON.parse(raw || '{}'); } catch (e) { /* body bukan JSON */ }
    const model = typeof parsed.model === 'string' ? parsed.model : null;
    const fail = mockOutcome(key, model);

    const send = (status, obj, gzipIt) => {
      const json = JSON.stringify(obj);
      if (gzipIt) {
        const z = zlib.gzipSync(Buffer.from(json));
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': z.length });
        res.end(z);
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(json);
    };

    if (req.method === 'GET') {
      if (fail) return send(fail.status, fail.body);
      // Daftar model untuk tes katalog admin (P0-2): campuran id supaya semua status
      // (ok/partial/exhausted/special) teruji. qwen-mock TETAP PERTAMA karena tes lama
      // 'GET /models diteruskan' mengecek data[0].id === 'qwen-mock'.
      const ids = ['qwen-mock', 'm-good', 'm-empty-pool', 'qwen3-tts-flash-realtime', 'zzz-uncurated', 'kimi/kimi-k3'];
      return send(200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
    }
    if (model === 'm-gzip') return send(200, chatBody('halo dari mock gzip'), true);
    if (fail) return send(fail.status, fail.body);
    if (parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const pieces = ['ha', 'lo ', 'dari ', 'SSE ', 'mock ', 'test ', 'satu ', 'lagi'];
      pieces.forEach((p, i) => {
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: p } }] })}\n\n`);
          if (i === pieces.length - 1) { res.write('data: [DONE]\n\n'); res.end(); }
        }, 60 * (i + 1));
      });
      return;
    }
    send(200, chatBody('halo dari mock'));
  });
});

let passCount = 0;
let failCount = 0;
function check(name, cond, extra = '') {
  if (cond) { passCount += 1; console.log(`  PASS  ${name}`); }
  else { failCount += 1; console.log(`  FAIL  ${name}${extra ? ` -- ${extra}` : ''}`); }
}

const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const CHAT = '/compatible-mode/v1/chat/completions';

function request(pathname, { method = 'GET', body, token = TOKEN } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  return fetch(BASE + pathname, { method, headers, body: payload });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForHealth(timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch (e) { /* belum listen */ }
    await sleep(150);
  }
  return false;
}

async function main() {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
  fs.writeFileSync(KEY_PATH, KEYS.join('\n') + '\n');


  const proxy = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PROXY_PORT),
      DASHSCOPE_UPSTREAM_ORIGIN: `http://127.0.0.1:${MOCK_PORT}`,
      DASHSCOPE_API_KEYS_FILE: KEYFILE,

      PROXY_ACCESS_TOKEN: TOKEN,
      MAX_BODY_BYTES: '2048',
      UPSTREAM_TIMEOUT_MS: '5000',
      REQUEST_MAX_DURATION_MS: '20000',
      RATE_LIMIT_COOLDOWN_MS: '60000',
      PID_FILE: PIDFILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const proxyLog = [];
  proxy.stdout.on('data', (c) => proxyLog.push(c.toString()));
  proxy.stderr.on('data', (c) => proxyLog.push(c.toString()));
  let exited = null;
  proxy.on('exit', (code) => { exited = code; });

  try {
    const up = await waitForHealth();
    check('proxy start + /healthz merespons', up, exited === null ? 'timeout' : `proxy keluar dengan code ${exited}`);
    if (!up) {
      if (exited === null) { proxy.kill(); }
      console.log('--- log proxy ---\n' + proxyLog.join(''));
      throw new Error('proxy gagal start -- sisanya dilewati');
    }

    // --- autentikasi ---
    let r = await request('/healthz', { token: null });
    check('GET /healthz terbuka tanpa token', r.status === 200 && (await r.text()) === 'ok', `status=${r.status}`);

    r = await request('/status', { token: null });
    check('GET /status tanpa token -> 401', r.status === 401, `status=${r.status}`);

    r = await request(CHAT, { method: 'POST', token: 'token-salah', body: { model: 'm-good', messages: [] } });
    check('POST proxy dengan token salah -> 401 + JSON error', r.status === 401 && !!(await r.json()).error, `status=${r.status}`);

    // --- rotasi key sampai ketemu yang hidup ---
    // Beberapa request supaya round-robin menyapu SEMUA key (pointer maju 1 per request),
    // jadi cooldown di bawah ini bisa diamati untuk setiap key.
    let rotasiOk = true;
    let j = {};
    for (let i = 0; i < KEYS.length / 2; i++) {
      r = await request(CHAT, { method: 'POST', body: { model: 'm-good', messages: [{ role: 'user', content: 'hai' }] } });
      j = await r.json().catch(() => ({}));
      if (r.status !== 200 || !j.choices || j.choices[0].message.content !== 'halo dari mock') rotasiOk = false;
    }
    check('rotasi key: key mati dilewati, key hidup -> 200 (3x berturut-turut)', rotasiOk, `status=${r.status}`);

    // --- /status mencerminkan cooldown dua level ---
    r = await request('/status');
    let st = await r.json();
    const bySuffix = (sfx) => st.keys.find((k) => k.key.endsWith(sfx)) || {};
    check('GET /status dengan token -> ringkas pool penuh', r.status === 200 && st.totalKeys === KEYS.length, JSON.stringify({ total: st.totalKeys, avail: st.availableNow }));
    check('HTTP 401 -> cooldown LEVEL KEY (6 jam default)', bySuffix('0002').status === 'cooldown' && /HTTP 401/.test(bySuffix('0002').cooldownReason || ''), JSON.stringify(bySuffix('0002')));
    check('kuota free-tier -> cooldown LEVEL MODEL (key tetap active)', bySuffix('0005').status === 'active' && bySuffix('0005').modelCooldowns.some((m) => m.model === 'm-good'), JSON.stringify(bySuffix('0005')));
    check('AccessDenied -> cooldown model 24 jam untuk key tsb', bySuffix('0006').modelCooldowns.some((m) => m.model === 'm-good' && /model tidak diaktifkan/.test(m.reason)), JSON.stringify(bySuffix('0006')));
    check('key yang belum pernah sukses tetap tercatat statistiknya', st.keys.every((k) => k.totalRequests >= 1));
    check('GET /status memuat modelCooldownCount, uptimeSec, version (INTERFACE.md §2.7)',
      typeof st.modelCooldownCount === 'number' && st.modelCooldownCount > 0 && typeof st.uptimeSec === 'number' && !!st.version,
      JSON.stringify({ m: st.modelCooldownCount, u: st.uptimeSec, v: st.version }));

    // --- semua key mati -> 503 + daftar percobaan ---
    r = await request(CHAT, { method: 'POST', body: { model: 'm-empty-pool', messages: [] } });
    j = await r.json().catch(() => ({}));
    check('semua key gagal -> 503 + code pool_exhausted + attempts per key', r.status === 503 && j.error.code === 'pool_exhausted' && Array.isArray(j.error.attempts) && j.error.attempts.length === KEYS.length, `status=${r.status} code=${j.error && j.error.code} attempts=${j.error && j.error.attempts && j.error.attempts.length}`);

    // --- error klien (400) diteruskan apa adanya, TANPA rotasi ---
    const before = await (await request('/status')).json();
    r = await request(CHAT, { method: 'POST', body: { model: 'm-clienterr', messages: [] } });
    j = await r.json().catch(() => ({}));
    const after = await (await request('/status')).json();
    check('HTTP 400 InvalidParameter diteruskan apa adanya', r.status === 400 && j.error && j.error.code === 'InvalidParameter', `status=${r.status}`);
    check('HTTP 400 tidak memicu rotasi (total request naik tepat 1)',
      after.keys.reduce((a, k) => a + k.totalRequests, 0) - before.keys.reduce((a, k) => a + k.totalRequests, 0) === 1);

    // --- streaming SSE ---
    r = await request(CHAT, { method: 'POST', body: { model: 'm-stream', messages: [], stream: true } });
    const t0 = Date.now();
    const chunkTimes = [];
    let sseText = '';
    for await (const c of r.body) { chunkTimes.push(Date.now() - t0); sseText += Buffer.from(c).toString(); }
    const span = chunkTimes.length > 1 ? chunkTimes[chunkTimes.length - 1] - chunkTimes[0] : 0;
    // Chunks bisa tercoalesce oleh TCP/undici, jadi yang diukur adalah SEBARAN waktunya:
    // kalau proxy menahan (buffer) body, klien cuma dapat 1 baca di akhir -> span ~0ms.
    check('stream:true dialirkan bertahap (SSE tidak dibuffer penuh)',
      r.status === 200 && chunkTimes.length >= 2 && span >= 200 && sseText.includes('[DONE]'), `chunks=${chunkTimes.length} span=${span}ms`);
    // Catatan: 'transfer-encoding' yang dilihat klien berasal dari hop terakhir (Node menambah
    // chunked untuk respons streaming), BUKAN diteruskan proxy -- yang wajib dibuang adalah
    // content-encoding upstream, supaya klien tidak mencoba gunzip body yang sudah plain.
    check('header content-encoding upstream dibuang dari respons stream',
      !r.headers.get('content-encoding'), JSON.stringify([...r.headers]));

    // --- upstream gzip tidak bikin klien "incorrect header check" ---
    r = await request(CHAT, { method: 'POST', body: { model: 'm-gzip', messages: [] } });
    j = await r.json().catch(() => ({}));
    check('respons gzip upstream diurai bersih untuk klien',
      r.status === 200 && j.choices && j.choices[0].message.content === 'halo dari mock gzip' && !r.headers.get('content-encoding'), `status=${r.status}`);

    // --- batas ukuran body ---
    // DITEMUKAN saat tes: readBody() memanggil req.destroy() SEBELUM respons 413 ditulis,
    // jadi koneksi mati duluan dan klien (fetch/axios/n8n) melihat "connection reset",
    // bukan kode 413 yang jelas.
    let oversized = 'koneksi-terputus';
    try {
      const rr = await request(CHAT, { method: 'POST', body: 'x'.repeat(5000) });
      oversized = String(rr.status);
    } catch (e) {
      oversized = `fetch gagal: ${(e.cause && e.cause.code) || e.message}`;
    }
    check('body > MAX_BODY_BYTES -> balas 413 (bukan memutus koneksi)', oversized === '413', oversized);

    // --- GET diteruskan (tanpa body/model) ---
    r = await request('/compatible-mode/v1/models');
    j = await r.json().catch(() => ({}));
    check('GET /models diteruskan ke upstream', r.status === 200 && j.data && j.data[0].id === 'qwen-mock', `status=${r.status}`);

    // --- P0-2: katalog model hidup (INTERFACE.md §2.1-2.2) ---
    // State saat ini: m-good partial (cooldown model di key 0004/0005/0006),
    // m-empty-pool exhausted (SEMUA key kena cooldown model), qwen3-tts-flash-realtime
    // WebSocket-only (selalu 'special'), zzz-uncurated tidak ada di kurasi katalog.
    r = await request('/admin/models', { token: null });
    check('GET /admin/models tanpa token -> 401', r.status === 401, `status=${r.status}`);
    r = await request('/admin/models');
    j = await r.json().catch(() => ({}));
    const row = (id) => (j.models || []).find((m) => m.id === id) || {};
    check('GET /admin/models: daftar upstream + metadata katalog + summary',
      r.status === 200 && j.totalModels === 6 && j.source === 'live' && typeof j.asOf === 'string'
        && j.summary.ok === 3 && j.summary.partial === 1 && j.summary.exhausted === 1 && j.summary.special === 1,
      JSON.stringify({ total: j.totalModels, summary: j.summary, source: j.source }));
    check('katalog: m-good partial dengan blockedReasons terisi',
      row('m-good').status === 'partial' && row('m-good').keysBlocked === 3 && row('m-good').blockedReasons.length >= 2,
      JSON.stringify(row('m-good')));
    check('katalog: m-empty-pool exhausted (semua key kena cooldown)',
      row('m-empty-pool').status === 'exhausted' && row('m-empty-pool').keysBlocked === KEYS.length,
      JSON.stringify({ s: row('m-empty-pool').status, b: row('m-empty-pool').keysBlocked }));
    check('katalog: model realtime WebSocket-only selalu status special',
      row('qwen3-tts-flash-realtime').status === 'special' && row('qwen3-tts-flash-realtime').transport === 'websocket' && row('qwen3-tts-flash-realtime').category === 'realtime',
      JSON.stringify(row('qwen3-tts-flash-realtime')));
    check('katalog: id tak terkurasi tetap tampil dengan category unknown',
      row('zzz-uncurated').category === 'unknown' && row('zzz-uncurated').status === 'ok',
      JSON.stringify(row('zzz-uncurated')));
    r = await request('/admin/models?category=realtime');
    j = await r.json().catch(() => ({}));
    check('filter category bekerja', r.status === 200 && j.filtered === 1 && j.models[0].id === 'qwen3-tts-flash-realtime',
      JSON.stringify(j.models && j.models.map((m) => m.id)));
    r = await request('/admin/models?q=empty&status=exhausted,partial');
    j = await r.json().catch(() => ({}));
    check('filter q + status (CSV) bekerja', r.status === 200 && j.filtered === 1 && j.models[0].id === 'm-empty-pool',
      JSON.stringify(j.models && j.models.map((m) => m.id)));
    r = await request('/admin/models?q=zzz-tidak-ada');
    j = await r.json().catch(() => ({}));
    check('filter tanpa hasil -> models kosong, totalModels tetap utuh',
      r.status === 200 && j.filtered === 0 && j.models.length === 0 && j.totalModels === 6, JSON.stringify({ filtered: j.filtered }));

    r = await request('/admin/models/m-good');
    j = await r.json().catch(() => ({}));
    check('GET /admin/models/{id}: verdict partial + reasonBreakdown + sample',
      r.status === 200 && j.id === 'm-good' && j.verdict === 'partial' && j.keysBlocked === 3
        && Object.keys(j.reasonBreakdown).length >= 2 && j.sample.length === 3,
      JSON.stringify({ v: j.verdict, rb: j.reasonBreakdown }));
    r = await request('/admin/models/' + encodeURIComponent('kimi/kimi-k3'));
    j = await r.json().catch(() => ({}));
    check('id mengandung "/" (percent-encoded) tetap terjawab',
      r.status === 200 && j.id === 'kimi/kimi-k3' && j.category === 'third-party', JSON.stringify({ id: j.id, c: j.category }));
    r = await request('/admin/models/qwen3-rerank');
    j = await r.json().catch(() => ({}));
    check('model terkurasi tapi tak ada di daftar upstream tetap dikenal (rerank)',
      r.status === 200 && j.category === 'rerank' && j.verdict === 'ok', JSON.stringify({ c: j.category }));
    r = await request('/admin/models/model-tidak-dikenal-xyz');
    j = await r.json().catch(() => ({}));
    check('GET /admin/models/{id} tak dikenal -> 404 not_found', r.status === 404 && j.error.code === 'not_found', `status=${r.status}`);

    // --- P0-2 lanjut: CLI bin/dsp.js (INTERFACE.md §4) ---
    const DSP = path.join(ROOT, 'bin', 'dsp.js');
    const dsp = (...args) => spawnSync(process.execPath, [DSP, ...args, '--base-url', BASE, '--token', TOKEN], { encoding: 'utf8' });
    let c = dsp('models');
    check('CLI models: tabel katalog + status baris, exit 0',
      c.status === 0 && /ID\s+KATEGORI/.test(c.stdout) && c.stdout.includes('qwen3-tts-flash-realtime') && /partial/.test(c.stdout),
      (c.stdout + c.stderr).slice(0, 400));
    c = dsp('models', '--category', 'realtime');
    check('CLI models --category memfilter', c.status === 0 && c.stdout.includes('qwen3-tts-flash-realtime') && !c.stdout.includes('m-empty-pool'), c.stdout.slice(0, 300));
    c = dsp('models', 'm-good');
    check('CLI models <id>: detail partial + alasan cooldown',
      c.status === 0 && /verdict: partial/.test(c.stdout) && /3\/6/.test(c.stdout) && /Alasan cooldown/.test(c.stdout), c.stdout.slice(0, 400));
    c = dsp('models', 'model-tidak-dikenal-xyz');
    check('CLI models <id> tak dikenal -> exit 1', c.status === 1 && /tidak dikenal/.test(c.stderr), c.stderr.slice(0, 200));
    c = dsp('status');
    check('CLI status: ringkasan pool + key bermasalah', c.status === 0 && /key siap/.test(c.stdout) && /0002/.test(c.stdout), c.stdout.slice(0, 300));
    c = dsp('recommend');
    check('CLI recommend: kurasi katalog + status live', c.status === 0 && /chat-cepat/.test(c.stdout) && /tdk di daftar/.test(c.stdout), c.stdout.slice(0, 300));
    c = dsp();
    check('CLI tanpa argumen -> usage + exit 2', c.status === 2 && /Pemakaian/.test(c.stdout + c.stderr), `exit=${c.status}`);
    c = dsp('help');
    check('CLI help -> usage + exit 0', c.status === 0 && /Pemakaian/.test(c.stdout), `exit=${c.status}`);

    // --- P0-1: reset selektif per-model / per-key (INTERFACE.md §2.3) ---
    // State saat ini: key 0002 cooldown LEVEL KEY (401); beberapa key punya cooldown
    // LEVEL MODEL untuk m-good (429 free-tier, 429 rate, 403 AccessDenied).
    r = await request('/admin/reset/model', { method: 'POST', token: null, body: { model: 'm-good' } });
    check('POST /admin/reset/model tanpa token -> 401', r.status === 401, `status=${r.status}`);
    r = await request('/admin/reset/model', { method: 'POST', body: { bukan: 'field-model' } });
    j = await r.json().catch(() => ({}));
    check('POST /admin/reset/model tanpa field model -> 400 bad_request', r.status === 400 && j.error.code === 'bad_request', `status=${r.status}`);
    r = await request('/admin/reset/model', { method: 'POST', body: 'ini-bukan-json' });
    j = await r.json().catch(() => ({}));
    check('POST /admin/reset/model body bukan JSON -> 400 bad_request', r.status === 400 && j.error.code === 'bad_request', `status=${r.status}`);
    r = await request('/admin/reset/model', { method: 'POST', body: { model: 'tidak-pernah-cooldown' } });
    j = await r.json().catch(() => ({}));
    check('POST /admin/reset/model tanpa cooldown apa pun -> 404 not_found', r.status === 404 && j.error.code === 'not_found', `status=${r.status}`);

    r = await request('/admin/reset/model', { method: 'POST', body: { model: 'm-good' } });
    j = await r.json().catch(() => ({}));
    st = await (await request('/status')).json();
    check('POST /admin/reset/model menghapus model tsb dari semua key',
      r.status === 200 && j.ok === true && j.cleared >= 2 && st.keys.every((k) => !k.modelCooldowns.some((m) => m.model === 'm-good')),
      JSON.stringify({ ok: j.ok, cleared: j.cleared }));
    check('reset per-model tidak menyentuh cooldown level key (key 401 tetap cooldown)',
      bySuffix('0002').status === 'cooldown', JSON.stringify(bySuffix('0002').status));

    r = await request('/admin/reset/key', { method: 'POST', body: { key: 'sk-tidak...pool' } });
    j = await r.json().catch(() => ({}));
    check('POST /admin/reset/key key tidak dikenal -> 404 not_found', r.status === 404 && j.error.code === 'not_found', `status=${r.status}`);
    const masked0002 = bySuffix('0002').key; // bentuk masked persis keluaran /status
    r = await request('/admin/reset/key', { method: 'POST', body: { key: masked0002 } });
    j = await r.json().catch(() => ({}));
    st = await (await request('/status')).json();
    check('POST /admin/reset/key dengan masked menghapus cooldown level key tsb',
      r.status === 200 && j.ok === true && j.cleared === 1 && bySuffix('0002').status === 'active',
      JSON.stringify(j));

    // --- /admin/reset ---
    r = await request('/admin/reset', { method: 'POST', token: null });
    check('POST /admin/reset tanpa token -> 401', r.status === 401, `status=${r.status}`);
    r = await request('/admin/reset', { method: 'POST' });
    j = await r.json().catch(() => ({}));
    check('POST /admin/reset -> 200 ok', r.status === 200 && j.ok === true, `status=${r.status}`);
    st = await (await request('/status')).json();
    check('setelah reset: semua cooldown (key & model) bersih',
      st.availableNow === st.totalKeys && st.keys.every((k) => k.modelCooldowns.length === 0), JSON.stringify({ avail: st.availableNow, total: st.totalKeys }));

    // --- P0-3: CLI mutasi & path admin tak dikenal (INTERFACE.md §4) ---
    let c2 = dsp('reset');
    check('CLI reset global (pool sudah bersih) -> exit 0', c2.status === 0 && /cooldown/i.test(c2.stdout), (c2.stdout + c2.stderr).slice(0, 200));
    c2 = dsp('reset', '--model', 'm-good');
    check('CLI reset --model tanpa cooldown -> exit 1 + pesan 404', c2.status === 1 && /404/.test(c2.stderr), c2.stderr.slice(0, 200));
    c2 = dsp('keys', 'reload');
    check('CLI keys reload -> pesan endpoint P1 belum tersedia + exit 1', c2.status === 1 && /belum tersedia/i.test(c2.stderr), c2.stderr.slice(0, 200));
    c2 = dsp('probe', 'm-good', '--keys', '2');
    check('CLI probe -> pesan endpoint P1 belum tersedia + exit 1', c2.status === 1 && /belum tersedia/i.test(c2.stderr), c2.stderr.slice(0, 200));
    c2 = dsp('probe');
    check('CLI probe tanpa model -> exit 2', c2.status === 2, `exit=${c2.status}`);
    r = await request('/admin/tidak-ada', { token: null });
    check('path /admin/* tak dikenal -> 404 (bukan pass-through)', r.status === 404, `status=${r.status}`);

    // --- pidfile ---
    check('PID file ditulis begitu server listen',
      fs.existsSync(PID_PATH) && fs.readFileSync(PID_PATH, 'utf8').trim() === String(proxy.pid));

    console.log('\n--- log proxy (keputusan rotasi) ---');
    proxyLog.join('').split('\n').filter((l) => /^\[(ok|rotate|client-error)\]/.test(l)).slice(0, 12).forEach((l) => console.log('  ' + l));
  } finally {
    proxy.kill();
    await sleep(300);
    mock.close();
    if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
    if (fs.existsSync(KEY_PATH)) fs.unlinkSync(KEY_PATH);
  }

  console.log(`\nHASIL: ${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => { console.error('Test error:', err); process.exit(2); });
