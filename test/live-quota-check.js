'use strict';

// Cek kuota/akses per model terhadap DashScope ASLI lewat instance proxy SEMENTARA yang
// cuma memakai sebagian kecil key dari api-key.txt -- jadi cooldown yang timbul tidak
// mengenai instance produksi (state cooldown ada di memori tiap proses).
//
// Logika probe & spawn proxy sementara dipindah ke lib/quota-probe.js (INTERFACE.md
// §2.6 bagian 5) supaya dipakai bersama dengan endpoint POST /admin/probe.
//
//   node test/live-quota-check.js                      -> model bawaan di bawah
//   node test/live-quota-check.js qwen3.8-flash,qwen-max
//   node test/live-quota-check.js --keys 15 qwen-plus  -> cek apakah ADA key lain yang masih punya kuota

const fs = require('fs');
const path = require('path');
const { DEFAULT_PROBE_PORT, spawnProbeProxy, waitForHealth, cleanupProbeFiles, probeModels } = require('../lib/quota-probe');

const ROOT = path.resolve(__dirname, '..');
const PORT = DEFAULT_PROBE_PORT;
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

async function main() {
  const { nKeys, models } = parseArgs(process.argv.slice(2));
  const all = fs.readFileSync(path.join(ROOT, 'api-key.txt'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  if (!all.length) throw new Error('api-key.txt kosong');
  if (!fs.existsSync(path.join(ROOT, 'logs'))) fs.mkdirSync(path.join(ROOT, 'logs'));

  const token = tokenFromEnv();
  const proxy = spawnProbeProxy({
    root: ROOT,
    port: PORT,
    keys: all.slice(0, Math.max(1, nKeys)),
    keysFile: TMP_KEYS,
    pidFile: TMP_PID,
    token,
  });

  let alive = 0;
  try {
    await waitForHealth(BASE, 15000);
    console.log(`Probe ${models.length} model lewat proxy sementara (port ${PORT}, ${Math.min(nKeys, all.length)} dari ${all.length} key):\n`);
    const rows = await probeModels({ baseUrl: BASE, token, models, timeoutMs: 60000 });
    for (const row of rows) {
      console.log(`  ${String(row.status).padEnd(4)} ${row.model.padEnd(32)} ${String(row.ms).padStart(6)}ms  ${row.note}`);
      if (row.alive) alive += 1;
    }
  } finally {
    proxy.kill();
    await new Promise((r) => setTimeout(r, 200));
    cleanupProbeFiles([TMP_KEYS, TMP_PID]);
  }

  console.log(`\nHIDUP: ${alive}/${models.length}`);
  process.exit(alive ? 0 : 1);
}
main().catch((e) => { console.error('Quota check error:', e); process.exit(2); });
