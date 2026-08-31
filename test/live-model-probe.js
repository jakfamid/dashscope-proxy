'use strict';

// Probe kecil ke upstream DashScope ASLI, lewat proxy, memakai 1 key saja dari api-key.txt
// (supaya tidak menyapu 119 key sekaligus dan tidak menulis cooldown massal di instance
// produksi). Tujuannya: cari model yang kuotanya masih ada untuk dipakai live-smoke.ps1.
// Jalankan: node test/live-model-probe.js [jumlahKandidatModel]

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8789;
const BASE = `http://127.0.0.1:${PORT}`;
const KEYFILE = path.join(ROOT, 'logs', 'probe.keys.txt');
const PIDFILE = path.join(ROOT, 'logs', 'probe.pid');
const MAX_MODELS = parseInt(process.argv[2] || '8', 10);

function tokenFromEnv() {
  const line = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').map((s) => s.trim()).find((l) => /^DASHSCOPE_PROXY_TOKEN=/.test(l));
  return line ? line.replace(/^DASHSCOPE_PROXY_TOKEN=/, '').replace(/^"|"$/g, '') : '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const keys = fs.readFileSync(path.join(ROOT, 'api-key.txt'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  if (!keys.length) throw new Error('api-key.txt kosong');
  fs.writeFileSync(KEYFILE, keys[0] + '\n');

  const proxy = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DASHSCOPE_API_KEYS_FILE: KEYFILE,
      PROXY_ACCESS_TOKEN: tokenFromEnv(),
      UPSTREAM_TIMEOUT_MS: '30000',
      PID_FILE: PIDFILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  proxy.stdout.on('data', (c) => log.push(c.toString()));
  proxy.stderr.on('data', (c) => log.push(c.toString()));

  const auth = { Authorization: `Bearer ${tokenFromEnv()}`, 'Content-Type': 'application/json' };

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch (e) { /* tunggu */ }
    await sleep(200);
  }

  const listResp = await fetch(`${BASE}/compatible-mode/v1/models`, { headers: auth });
  const list = await listResp.json();
  const ids = (list.data || []).map((m) => m.id);
  const prefer = [/flash/i, /turbo/i, /lite/i, /-?\d+b-instruct/i, /instruct/i, /qwen-plus/, /qwen-max/, /qwen3/];
  const picked = [];
  for (const re of prefer) for (const id of ids) if (re.test(id) && !picked.includes(id)) picked.push(id);
  const candidates = picked.slice(0, MAX_MODELS);
  console.log(`Key #1 dicoba terhadap ${candidates.length} kandidat dari ${ids.length} model:\n  ${candidates.join(', ')}\n`);

  let winner = null;
  for (const model of candidates) {
    const t0 = Date.now();
    let status, detail;
    try {
      const r = await fetch(`${BASE}/compatible-mode/v1/chat/completions`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Balas persis dengan kata: OK' }], max_tokens: 10 }),
        signal: AbortSignal.timeout(40000),
      });
      status = r.status;
      const text = await r.text();
      if (status === 200) {
        const j = JSON.parse(text);
        detail = `content=${JSON.stringify(j.choices[0].message.content)} tokens=${j.usage && j.usage.total_tokens}`;
        winner = model;
      } else {
        const j = JSON.parse(text);
        detail = `code=${(j.error && (j.error.code || j.error.message)) || 'n/a'}`;
      }
    } catch (e) { status = 'ERR'; detail = e.message; }
    console.log(`  ${String(status).padEnd(4)} ${model.padEnd(34)} ${Date.now() - t0}ms  ${detail}`);
    if (winner) break;
  }

  console.log('\n--- log proxy probe (1 key) ---');
  log.join('').split('\n').filter((l) => /^\[/.test(l)).slice(-6).forEach((l) => console.log('  ' + l));

  proxy.kill();
  await sleep(200);
  for (const f of [KEYFILE, PIDFILE]) { try { fs.unlinkSync(f); } catch (e) { /* sudah hilang */ } }
  console.log(winner ? `\nMODEL YANG MASIH PUNYA KUOTA: ${winner}` : '\nTidak ada model berkuota dari kandidat di atas (key #1).');
  process.exit(winner ? 0 : 1);
}

main().catch((e) => { console.error('Probe error:', e); process.exit(2); });
