'use strict';

// lib/quota-probe.js -- logika probe kuota model, dipakai bersama oleh:
//   1. POST /admin/probe di server.js (INTERFACE.md §2.6) -- probe terkelola via HTTP
//   2. test/live-quota-check.js -- tool operator dari terminal
// Satu implementasi, dua pintu (INTERFACE.md §2.6 bagian 5).
//
// Prinsip (sama dengan tooling lama): probe dijalankan lewat INSTANCE PROXY SEMENTARA
// di port lain yang hanya memakai SUBSET key dari pool, sehingga cooldown yang timbul
// akibat probing TIDAK mencemari instance produksi (state cooldown hidup di memori
// tiap proses).

const { spawn } = require('child_process');
const fs = require('fs');

const DEFAULT_PROBE_PORT = parseInt(process.env.PROBE_CHILD_PORT || '8794', 10);

// Jalankan satu proxy sementara: tulis subset key ke keysFile, lalu spawn server.js
// dengan port & pidfile tersendiri. Env lain (upstream origin, timeout, dsb.) diwarisi
// dari proses induk. Mengembalikan ChildProcess.
function spawnProbeProxy({ root, port, keys, keysFile, pidFile, token }) {
  fs.writeFileSync(keysFile, keys.join('\n') + '\n');
  return spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DASHSCOPE_API_KEYS_FILE: keysFile,
      PROXY_ACCESS_TOKEN: token || '',
      PID_FILE: pidFile,
      UPSTREAM_TIMEOUT_MS: '30000',
      REQUEST_MAX_DURATION_MS: '120000',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

// Poll /healthz sampai proxy siap (atau lempar error setelah timeout).
async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${baseUrl}/healthz`);
      if (r.ok) return true;
    } catch (e) { /* belum listen */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`proxy sementara di ${baseUrl} tidak sehat dalam ${timeoutMs}ms`);
}

function cleanupProbeFiles(files) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch (e) { /* sudah hilang -- tidak masalah */ }
  }
}

// Probe daftar model terhadap proxy yang sudah jalan di baseUrl. Model ber-"embedding"
// dites lewat /compatible-mode/v1/embeddings, sisanya lewat /chat/completions dengan
// body sekecil mungkin (pola live-quota-check.js lama).
// Mengembalikan satu baris per model:
//   { model, alive, status, keysAlive, attempts, note, ms }
async function probeModels({ baseUrl, token, models, timeoutMs = 60000 }) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const rows = [];
  for (const model of models) {
    const t0 = Date.now();
    const isEmbed = /embedding/.test(model);
    const url = `${baseUrl}${isEmbed ? '/compatible-mode/v1/embeddings' : '/compatible-mode/v1/chat/completions'}`;
    const body = isEmbed
      ? { model, input: 'tes' }
      : { model, messages: [{ role: 'user', content: 'Balas persis dengan kata: OK' }], max_tokens: 16 };
    let status = 'ERR';
    let note = '';
    let attempts = 0;
    try {
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      status = r.status;
      let j = {};
      try { j = await r.json(); } catch (e) { /* respons bukan JSON */ }
      if (r.status === 200) {
        note = isEmbed
          ? `vektor[${((j.data && j.data[0] && j.data[0].embedding) || []).length}] usage=${j.usage && j.usage.total_tokens}`
          : `isi=${JSON.stringify(String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').slice(0, 24))} usage=${j.usage && j.usage.total_tokens}`;
      } else {
        const att = (j.error && j.error.attempts) || [];
        attempts = att.length;
        const reasons = [...new Set(att.map((a) => String(a).split(' -> ')[1] || String(a)))].join(' | ');
        note = `${(j.error && (j.error.code || j.error.message)) || `HTTP ${r.status}`}${reasons ? ` (${reasons.slice(0, 120)})` : ''}`;
      }
    } catch (e) {
      note = `${e.name}: ${e.message}`;
    }
    rows.push({
      model,
      alive: status === 200,
      status,
      // keysAlive: dari satu probe per model kita hanya bisa memastikan "ada/tidaknya
      // key yang lolos" -- angka pasti per-key butuh audit terpisah (di luar cakupan
      // probe cepat ini). 1 = minimal satu key hidup untuk model ini.
      keysAlive: status === 200 ? 1 : 0,
      attempts,
      note,
      ms: Date.now() - t0,
    });
  }
  return rows;
}

module.exports = { DEFAULT_PROBE_PORT, spawnProbeProxy, waitForHealth, cleanupProbeFiles, probeModels };
