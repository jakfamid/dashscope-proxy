#!/usr/bin/env node
'use strict';

// CLI dashscope-proxy — INTERFACE.md §4 (P0-3).
// Satu file Node tanpa dependency, bicara ke admin API proxy lewat HTTP.
// Konfigurasi koneksi: flag --base-url/--token/--port menang; kalau tidak ada,
// dibaca dari ".env" di root repo (pola parser sama dengan start.ps1), lalu
// dari env proses. Exit code: 0 sukses · 1 eksekusi gagal · 2 argumen salah —
// sehingga bisa dipakai di script CI/cron (mis. setelah isi saldo: dsp reset --model …).

const fs = require('fs');
const path = require('path');
const catalog = require('../lib/model-catalog');

const ROOT = path.resolve(__dirname, '..');

// ---------------- util ----------------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[a.slice(2)] = argv[i + 1];
        i += 1;
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// Parser ".env" minimal: KEY=VALUE, "#" komentar, kutip pembungkus dilepas —
// pola yang sama dengan start.ps1 (dan node --env-file-if-exists).
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const quoted = value.match(/^"(.*)"$/) || value.match(/^'(.*)'$/);
    if (quoted) value = quoted[1];
    out[m[1]] = value;
  }
  return out;
}

function fail(msg, code) {
  console.error(`dsp: ${msg}`);
  process.exit(code);
}

// Tabel teks rata kolom tanpa library (INTERFACE.md §4).
function table(headers, rows) {
  const cells = rows.map((r) => r.map((v) => String(v == null ? '' : v)));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i].length)));
  const line = (cols) => cols.map((v, i) => v.padEnd(widths[i])).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.map(line)].join('\n');
}

const USAGE = `Pemakaian: node bin/dsp.js <perintah> [arg] [flag]

Perintah:
  status                      Ringkasan pool + hanya key bermasalah
  models                      Katalog: id | kategori | status | blokir
  models <id>                 Detail satu model (= GET /admin/models/{id})
  recommend                   Model berlabel rekomendasi katalog + alasan
  probe <model...> --keys N   Probe ketersediaan model (butuh endpoint P1)
  reset [--model X|--key X]   Reset semua / satu model / satu key cooldown
  keys reload                 Muat ulang api-key.txt (butuh endpoint P1)

Flag koneksi: --base-url URL, --token TOKEN, --port N
  (default: http://127.0.0.1:$PORT, PORT dari .env/env atau 8787)
Filter models: --category, --q, --status (CSV), --recommended
Exit code: 0 sukses · 1 gagal · 2 argumen salah`;

// ---------------- main ----------------

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const dotEnv = loadDotEnv();
  // Urutan sumber: flag > .env > env proses > default (start.ps1 menimpa env
  // dengan .env, jadi .env diutamakan daripada env proses yang sudah ada).
  const pick = (flagName, envNames, def) => {
    if (flags[flagName] !== undefined && flags[flagName] !== true) return String(flags[flagName]);
    for (const n of envNames) {
      if (dotEnv[n] !== undefined) return dotEnv[n];
      if (process.env[n] !== undefined) return process.env[n];
    }
    return def;
  };
  const port = pick('port', ['PORT'], '8787');
  const baseUrl = pick('base-url', ['DASHSCOPE_PROXY_BASE_URL'], `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  const token = pick('token', ['PROXY_ACCESS_TOKEN', 'DASHSCOPE_PROXY_TOKEN'], '');

  async function api(method, pathname, body, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(baseUrl + pathname, {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* respons bukan JSON */ }
      return { status: resp.status, json, text };
    } catch (e) {
      const why = e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : ((e.cause && (e.cause.message || e.cause.code)) || e.message);
      fail(`gagal menghubungi proxy di ${baseUrl}: ${why}`, 1);
    } finally {
      clearTimeout(timer);
    }
  }
  const apiError = (r) => (r.json && r.json.error && r.json.error.message) || r.text || `HTTP ${r.status}`;

  const cmd = positional[0];
  if (!cmd || cmd === 'help' || flags.help) {
    console.log(USAGE);
    // Tanpa argumen sama sekali -> exit 2 (salah pakai); help eksplisit -> 0.
    process.exit(cmd || flags.help ? 0 : 2);
  }

  // -------- status --------
  if (cmd === 'status') {
    const r = await api('GET', '/status');
    if (r.status !== 200) fail(`GET /status gagal (${r.status}): ${apiError(r)}`, 1);
    const st = r.json;
    console.log(`dashscope-proxy v${st.version} — ${st.availableNow}/${st.totalKeys} key siap, ${st.modelCooldownCount} cooldown model, uptime ${st.uptimeSec}s`);
    const bad = st.keys.filter((k) => k.status !== 'active' || k.modelCooldowns.length);
    if (!bad.length) {
      console.log('Semua key aktif — tidak ada cooldown.');
      return;
    }
    console.log(`\n${bad.length} key bermasalah:`);
    console.log(table(['KEY', 'STATUS', 'COOLDOWN SAMPAI', 'ALASAN', 'MODEL TERBLOKIR'], bad.map((k) => [
      k.key,
      k.status,
      k.cooldownUntil || '-',
      k.cooldownReason || '-',
      k.modelCooldowns.length ? k.modelCooldowns.map((m) => m.model).join(', ') : '-',
    ])));
    return;
  }

  // -------- models [id] --------
  if (cmd === 'models') {
    const id = positional[1];
    if (id) {
      const r = await api('GET', `/admin/models/${encodeURIComponent(id)}`);
      if (r.status === 404) fail(apiError(r), 1);
      if (r.status !== 200) fail(`GET /admin/models/${id} gagal (${r.status}): ${apiError(r)}`, 1);
      const d = r.json;
      console.log(`${d.id} — kategori ${d.category}, transport ${d.transport}`);
      console.log(`verdict: ${d.verdict} · key terblokir: ${d.keysBlocked}/${d.keysTotal}`);
      if (d.recommended) console.log(`rekomendasi untuk: ${d.recommended}`);
      if (d.notes) console.log(`catatan: ${d.notes}`);
      const reasons = Object.entries(d.reasonBreakdown || {});
      if (!reasons.length) {
        console.log('Tidak ada key yang terblokir untuk model ini.');
        return;
      }
      console.log('\nAlasan cooldown:');
      for (const [reason, n] of reasons) console.log(`  ${n} key — ${reason}`);
      console.log('\nContoh key terblokir (maks 5):');
      console.log(table(['KEY', 'SAMPAI', 'ALASAN'], (d.sample || []).map((s) => [s.key, s.cooldownUntil, s.reason])));
      return;
    }
    const qs = new URLSearchParams();
    if (flags.category) qs.set('category', String(flags.category));
    if (flags.q) qs.set('q', String(flags.q));
    if (flags.status) qs.set('status', String(flags.status));
    if (flags.recommended) qs.set('recommended', 'true');
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const r = await api('GET', `/admin/models${suffix}`);
    if (r.status !== 200) fail(`GET /admin/models gagal (${r.status}): ${apiError(r)}`, 1);
    const j = r.json;
    const sm = j.summary || {};
    console.log(`asOf ${j.asOf} · sumber ${j.source} · total ${j.totalModels} · ditampilkan ${j.filtered}`);
    console.log(`ok ${sm.ok || 0} · partial ${sm.partial || 0} · exhausted ${sm.exhausted || 0} · special ${sm.special || 0}`);
    if (j.source !== 'live') console.log(`PERHATIAN: daftar upstream ${j.source}${j.upstreamError ? ` — ${j.upstreamError}` : ''}`);
    if (!j.models.length) {
      console.log('Tidak ada model yang cocok dengan filter.');
      return;
    }
    console.log('');
    console.log(table(['ID', 'KATEGORI', 'STATUS', 'BLOKIR', 'LABEL'], j.models.map((m) => [
      m.id, m.category, m.status, `${m.keysBlocked}/${m.keysTotal}`, m.recommended || '-',
    ])));
    return;
  }

  // -------- recommend --------
  if (cmd === 'recommend') {
    const r = await api('GET', '/admin/models');
    if (r.status !== 200) fail(`GET /admin/models gagal (${r.status}): ${apiError(r)}`, 1);
    const byId = {};
    for (const m of r.json.models) byId[m.id] = m;
    const rows = Object.entries(catalog.recommendations).map(([task, v]) => {
      const live = byId[v.id];
      return [task, v.id, live ? live.status : 'tdk di daftar', live ? `${live.keysBlocked}/${live.keysTotal}` : '-', v.why];
    });
    console.log('Rekomendasi katalog (kurasi MODELS.md):');
    console.log(table(['TUGAS', 'MODEL', 'STATUS', 'BLOKIR', 'KENAPA'], rows));
    return;
  }

  // -------- probe --------
  if (cmd === 'probe') {
    const models = positional.slice(1);
    if (!models.length) fail('probe butuh minimal satu model, mis.: dsp probe qwen-plus --keys 3', 2);
    const keys = parseInt(flags.keys === true || flags.keys === undefined ? '3' : flags.keys, 10);
    if (!Number.isInteger(keys) || keys < 1) fail('--keys harus bilangan bulat >= 1', 2);
    const r = await api('POST', '/admin/probe', { models, keysPerModel: keys }, 120000);
    if (r.status === 404) fail('endpoint /admin/probe belum tersedia di server versi ini (rencana P1)', 1);
    if (r.status !== 200) fail(`POST /admin/probe gagal (${r.status}): ${apiError(r)}`, 1);
    const j = r.json || {};
    if (Array.isArray(j.results)) {
      console.log(table(['MODEL', 'HIDUP', 'KEY HIDUP', 'PERCOBAAN'], j.results.map((x) => [
        x.model, x.alive ? 'ya' : 'tidak', x.keysAlive == null ? '?' : String(x.keysAlive), x.attempts == null ? '' : String(x.attempts),
      ])));
    } else {
      console.log(JSON.stringify(j, null, 2));
    }
    return;
  }

  // -------- reset --------
  if (cmd === 'reset') {
    let pathname = '/admin/reset';
    let body;
    if (flags.model) { pathname = '/admin/reset/model'; body = { model: String(flags.model) }; }
    else if (flags.key) { pathname = '/admin/reset/key'; body = { key: String(flags.key) }; }
    const r = await api('POST', pathname, body);
    if (r.status !== 200) fail(`reset gagal (${r.status}): ${apiError(r)}`, 1);
    const j = r.json || {};
    console.log(j.message || (j.ok ? 'Reset berhasil.' : JSON.stringify(j)));
    if (typeof j.cleared === 'number') console.log(`Cooldown yang dihapus: ${j.cleared}`);
    return;
  }

  // -------- keys --------
  if (cmd === 'keys') {
    if (positional[1] !== 'reload') fail('subperintah keys yang dikenal hanya: keys reload', 2);
    const r = await api('POST', '/admin/keys/reload');
    if (r.status === 404) fail('endpoint /admin/keys/reload belum tersedia di server versi ini (rencana P1)', 1);
    if (r.status !== 200) fail(`POST /admin/keys/reload gagal (${r.status}): ${apiError(r)}`, 1);
    console.log((r.json && r.json.message) || 'Key dimuat ulang.');
    if (r.json && typeof r.json.totalKeys === 'number') console.log(`Total key sekarang: ${r.json.totalKeys}`);
    return;
  }

  fail(`perintah tidak dikenal: "${cmd}" — jalankan tanpa argumen untuk daftar perintah`, 2);
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e), 1));
