'use strict';

// Integrasi test untuk server.js terhadap MOCK upstream (tidak menyentuh DashScope asli,
// jadi tidak menghabiskan kuota). Jalankan: node test/proxy-integration.test.js
// (artifak sementara -- pidfile & daftar key test -- ditulis ke logs/ yang di-gitignore)
// Cover: autentikasi token, rotasi key + cooldown (key-level vs model-level), 503 saat
// semua key mati, penerusan 4xx klien tanpa rotasi, streaming SSE, stripping header
// gzip, batas ukuran body, /status, /admin/reset, dan penulisan PID file.

const { spawn } = require('child_process');
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
      return send(200, { object: 'list', data: [{ id: 'qwen-mock', object: 'model' }] });
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

    // --- semua key mati -> 503 + daftar percobaan ---
    r = await request(CHAT, { method: 'POST', body: { model: 'm-empty-pool', messages: [] } });
    j = await r.json().catch(() => ({}));
    check('semua key gagal -> 503 dengan attempts per key', r.status === 503 && Array.isArray(j.error.attempts) && j.error.attempts.length === KEYS.length, `status=${r.status} attempts=${j.error && j.error.attempts && j.error.attempts.length}`);

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

    // --- /admin/reset ---
    r = await request('/admin/reset', { method: 'POST', token: null });
    check('POST /admin/reset tanpa token -> 401', r.status === 401, `status=${r.status}`);
    r = await request('/admin/reset', { method: 'POST' });
    j = await r.json().catch(() => ({}));
    check('POST /admin/reset -> 200 ok', r.status === 200 && j.ok === true, `status=${r.status}`);
    st = await (await request('/status')).json();
    check('setelah reset: semua cooldown (key & model) bersih',
      st.availableNow === st.totalKeys && st.keys.every((k) => k.modelCooldowns.length === 0), JSON.stringify({ avail: st.availableNow, total: st.totalKeys }));

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
