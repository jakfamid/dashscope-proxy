'use strict';

// Cek kuota/akses per model terhadap DashScope ASLI lewat instance proxy SEMENTARA yang
// cuma memakai sebagian kecil key dari api-key.txt -- jadi cooldown yang timbul tidak
// mengenai instance produksi (state cooldown ada di memori tiap proses).
//
//   node test/live-quota-check.js                      -> model bawaan di bawah
//   node test/live-quota-check.js qwen3.8-flash,qwen-max
//   node test/live-quota-check.js --keys 15 qwen-plus  -> cek apakah ADA key lain yang masih punya kuota
//
// Model ber-`embedding` dites lewat /compatible-mode/v1/embeddings, sisanya lewat
// /compatible-mode/v1/chat/completions dengan body sekecil mungkin.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.QUOTA_CHECK_PORT || '8794', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_KEYS = path.join(ROOT, 'logs', 'quota-check.keys.txt');
const TMP_PID = path.join(ROOT, 'logs', 'quota-check.pid');

const DEFAULT_MODELS = [
  'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen-plus-latest',
  'qwen3-coder-plus', 'qwen3-vl-plus', 'qwen-vl-ocr-2025-11-20', 'qwq-plus',
  'deepseek-v4-flash', 'glm-5.2', 'kimi-k3', 'text-embedding-v4',
];

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Pakai: node test/live-quota-check.js [--keys N] model1,model2 ...
  --keys N   jumlah key dari api-key.txt yang ikut di-rotasi (default 1)
  tanpa argumen -> pakai daftar model bawaan; exit 0 kalau ada >=1 model yang hidup`);
    process.exit(0);
  }
  let nKeys = 1;
  const models = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keys') { nKeys = parseInt(argv[++i], 10) || 1; continue; }
    models.push(...argv[i].split(',').map((s) => s.trim()).filter(Boolean));
  }
  return { nKeys, models: models.length ? models : DEFAULT_MODELS };
}

function tokenFromEnv() {
  try {
    const line = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').map((s) => s.trim()).find((l) => /^DASHSCOPE_PROXY_TOKEN=/.test(l));
    return line ? line.replace(/^DASHSCOPE_PROXY_TOKEN=/, '').replace(/^"|"$/g, '') : '';
  } catch (e) { return ''; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { nKeys, models } = parseArgs(process.argv.slice(2));
  const all = fs.readFileSync(path.join(ROOT, 'api-key.txt'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  if (!all.length) throw new Error('api-key.txt kosong');
  if (!fs.existsSync(path.join(ROOT, 'logs'))) fs.mkdirSync(path.join(ROOT, 'logs'));
  fs.writeFileSync(TMP_KEYS, all.slice(0, nKeys).join('\n') + '\n');

  const token = tokenFromEnv();
  const proxy = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DASHSCOPE_API_KEYS_FILE: TMP_KEYS, PROXY_ACCESS_TOKEN: token,
      UPSTREAM_TIMEOUT_MS: '60000', REQUEST_MAX_DURATION_MS: '180000', PID_FILE: TMP_PID,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  let alive = 0;
  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch (e) { /* tunggu */ }
      await sleep(200);
    }
    console.log(`Probe ${models.length} model lewat proxy sementara (port ${PORT}, ${Math.min(nKeys, all.length)} dari ${all.length} key):\n`);

    for (const model of models) {
      const t0 = Date.now();
      const isEmbed = /embedding/.test(model);
      let status, note;
      try {
        const r = isEmbed
          ? await fetch(`${BASE}/compatible-mode/v1/embeddings`, { method: 'POST', headers: auth, body: JSON.stringify({ model, input: 'tes' }), signal: AbortSignal.timeout(60000) })
          : await fetch(`${BASE}/compatible-mode/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Balas persis dengan kata: OK' }], max_tokens: 16 }), signal: AbortSignal.timeout(60000) });
        status = r.status;
        const text = await r.text();
        const j = JSON.parse(text);
        if (status === 200) {
          note = isEmbed
            ? `vektor[${(j.data[0].embedding || []).length}] usage=${j.usage && j.usage.total_tokens}`
            : `isi=${JSON.stringify(String(j.choices[0].message.content || '').slice(0, 24))} usage=${j.usage && j.usage.total_tokens}`;
          alive++;
        } else {
          const attempts = (j.error && j.error.attempts) || [];
          const reasons = [...new Set(attempts.map((a) => String(a).split(' -> ')[1] || String(a)))].join(' | ');
          note = `${j.error && (j.error.code || j.error.message) || text.slice(0, 80)}${attempts.length ? ` (key dicoba: ${attempts.length}; ${reasons.slice(0, 120)})` : ''}`;
        }
      } catch (e) { status = 'ERR'; note = `${e.name}: ${e.message}`; }
      console.log(`  ${String(status).padEnd(4)} ${model.padEnd(32)} ${String(Date.now() - t0).padStart(6)}ms  ${note}`);
    }
  } finally {
    proxy.kill();
    await sleep(200);
    for (const f of [TMP_KEYS, TMP_PID]) { try { fs.unlinkSync(f); } catch (e) { /* sudah hilang */ } }
  }

  console.log(`\nHIDUP: ${alive}/${models.length}`);
  process.exit(alive ? 0 : 1);
}
main().catch((e) => { console.error('Quota check error:', e); process.exit(2); });
