# Proposal interface untuk dashscope-proxy

Status: **implementasi bertahap** — §2.1–2.7 (katalog model + reset selektif
per-model/per-key + field `/status`) & §4 CLI sudah diimplementasi (P0-1 s.d.
P0-3); dashboard, probe/metrics, dan sisanya masih proposal. Dibuat berdasar
pembacaan `server.js`
dan hasil survei `MODELS.md` per 31-08-2026. Tujuan: menjadikan proxy ini bisa
dioperasikan, dipantau, dan dipilih modelnya lewat interface yang konsisten —
bukan cuma lewat curl manual ke endpoint wildcard.

## 0. Kondisi interface saat ini

| Endpoint | Auth | Fungsi |
|---|---|---|
| `*` (semua path) | Bearer | Pass-through ke DashScope + rotasi key |
| `GET /healthz` | publik | Health check, balas `ok` |
| `GET /status` | Bearer | Kondisi tiap key (masked), cooldown key & per-model |
| `POST /admin/reset` | Bearer | Reset SEMUA cooldown |

Kesenjangan yang terlihat langsung dari kode:

1. **Reset cuma bisa global.** Setelah isi saldo, satu model yang pulih ikut
   me-reset cooldown 30 hari milik 118 model lain yang memang masih habis.
2. **Key pool beku sejak start.** `loadKeys()` dipanggil sekali; menambah key
   ke `api-key.txt` butuh restart proses.
3. **Katalog model statis.** `MODELS.md` adalah hasil survei manual; tidak ada
   cara bertanya "model mana yang SEKARANG tersedia menurut state pool" selain
   grep JSON `/status` satu-satu.
4. **Tidak ada metrics.** Tidak ada counter request/gagal/latensi yang bisa
   dipantau (mis. oleh Prometheus di samping docker-compose).
5. **Dua limitasi protokol** yang sudah terdokumentasi di MODELS.md/README:
   task async (`wan2.7-image`) tidak punya afinitas task→key, dan 24 model
   `*-realtime` tidak terjangkau karena proxy ini HTTP-only.

## 1. Prinsip desain

- **Nol dependency baru.** Semua interface dibangun dari `node:http`/`fs` yang
  sudah dipakai; dashboard = satu file HTML statis tanpa build step.
- **Satu token untuk semua.** Endpoint admin & dashboard memakai
  `PROXY_ACCESS_TOKEN` yang sama, validasi `timingSafeEqual` yang sudah ada.
  Tidak ada mekanisme auth kedua.
- **Key tidak pernah keluar mentah.** Semua interface hanya menampilkan bentuk
  masked (`sk-abc1...wxyz`) — melanjutkan kebijakan `maskKey()` di `server.js`.
- **Kontrak error yang sudah ada dipertahankan & diperluas**, bukan diganti:
  `{ "error": { "message", "code", "model", "attempts" } }`. Field `code`
  ditambahkan dengan kosakata stabil:
  `pool_exhausted`, `invalid_key`, `free_tier_exhausted`, `rate_limited`,
  `model_access_denied`, `upstream_error`, `realtime_ws_only`,
  `not_found`, `bad_request`.
- **GET idempoten & murah, POST untuk mutasi.** Respons mutasi selalu
  `{ "ok": true, ... }` plus hitungan efek (`cleared`, `added`, `removed`).
- Semua endpoint baru di bawah prefix `/admin/*` (kecuali `/metrics` dan
  `/dashboard`) supaya tidak pernah bertabrakan dengan path upstream DashScope
  yang diteruskan wildcard.

## 2. HTTP admin API (perluasan `server.js`)

Semua endpoint baru: auth Bearer, `Content-Type: application/json`, UTF-8.
Tidak ada pagination (164 model & ~119 key masih muat dalam satu respons).

### 2.1 `GET /admin/models` — katalog hidup *(P0)*

Menggantikan grep manual `/status`. Sumber data: hasil `GET
/compatible-mode/v1/models` upstream (di-cache beberapa menit) disilangkan
dengan `modelCooldowns` seluruh pool dan metadata kategori dari modul katalog
(bagian 5).

```
GET /admin/models?category=vision&q=ocr&status=ok
```

```json
{
  "asOf": "2026-08-31T12:00:00Z",
  "totalModels": 164,
  "summary": { "ok": 128, "partial": 6, "exhausted": 6, "special": 24 },
  "models": [
    {
      "id": "qwen3-vl-plus",
      "category": "vision",
      "transport": "http-chat",
      "status": "ok",
      "keysBlocked": 0,
      "keysTotal": 119,
      "blockedReasons": [],
      "recommended": "baca-gambar",
      "notes": "pakai content array image_url"
    }
  ]
}
```

- `status`: `ok` (0 key terblokir) · `partial` (sebagian key kena cooldown
  model ini) · `exhausted` (semua key) · `special` (butuh endpoint/parameter
  khusus atau WebSocket-only — dari metadata katalog).
- Query param: `category`, `q` (substring id), `status`, `recommended`
  (hanya yang ada label rekomendasinya).

### 2.2 `GET /admin/models/{id}` — ketersediaan satu model *(P0)*

```json
{
  "id": "qwen-plus",
  "verdict": "exhausted",
  "keysTotal": 119,
  "keysBlocked": 119,
  "reasonBreakdown": { "free_tier_exhausted": 119 },
  "sample": [
    { "key": "sk-abc1...wxyz", "reason": "kuota trial habis", "cooldownUntil": "2026-09-30T00:00:00Z" }
  ]
}
```

`404 not_found` kalau id tidak dikenal upstream. `sample` dibatasi 5 entri.

### 2.3 Reset selektif *(P0)*

Melengkapi `POST /admin/reset` yang sudah ada (tetap dipertahankan sebagai
"nuklir option"):

```
POST /admin/reset/model   {"model":"qwen-plus"}          -> {"ok":true,"cleared":119}
POST /admin/reset/key     {"key":"sk-abc1...wxyz"}        -> {"ok":true,"cleared":1}
```

- `key` menerima bentuk masked yang persis sama dengan keluaran `/status`,
  sehingga alurnya: lihat di `/status` → salin → reset. Key mentah tidak
  pernah dibutuhkan di interface.
- Reset per-model adalah operasi paling berharga di sini: cooldown
  `free_tier_exhausted` diset 30 hari, dan setelah isi saldo biasanya hanya
  sebagian model yang pulih.
- `400 bad_request` kalau body tidak valid; `404 not_found` kalau model/key
  tidak ada di pool.

### 2.4 `POST /admin/keys/reload` — muat ulang `api-key.txt` tanpa restart *(P1)*

```json
{ "ok": true, "added": 2, "removed": 0, "kept": 119, "total": 121 }
```

Implementasi: panggil ulang `loadKeys()`; key lama dipertahankan beserta
statistik & cooldown-nya (dicocokkan lewat key mentah di memori), key baru
masuk dengan state bersih, key yang hilang dari file dibuang. Ini mengubah
perilaku "restart untuk tambah key" jadi satu panggilan HTTP.

### 2.5 `GET /metrics` — format Prometheus *(P1)*

Text format `text/plain; version=0.0.4`, tanpa rahasia (label hanya nama
model & kode alasan):

```
dsp_proxy_requests_total{model="qwen3.8-flash"} 1234
dsp_proxy_failures_total{model="qwen-plus",code="free_tier_exhausted"} 57
dsp_proxy_rotations_total 89
dsp_proxy_upstream_latency_ms_bucket{le="1000"} 900
dsp_proxy_upstream_latency_ms_bucket{le="5000"} 1150
dsp_proxy_upstream_latency_ms_bucket{le="+Inf"} 1234
dsp_proxy_key_cooldowns_active 2
dsp_proxy_model_cooldowns_active 53
dsp_proxy_keys_loaded 119
```

Counter `totalRequests`/`totalFailures` sudah ada per key di `keyPool`;
yang perlu ditambah hanya agregasi per model + histogram latency sederhana
(bucket tetap, tanpa library).

### 2.6 `POST /admin/probe` — cek kuota dari dalam proxy *(P1)*

Versi terkelola dari `test/live-quota-check.js`, supaya operator tidak perlu
SSH/akses mesin:

```
POST /admin/probe  {"models":["qwen-plus","qwen-turbo"],"keys":3}
-> 202 {"ok":true,"jobId":"probe-8f3a"}
GET  /admin/probe/probe-8f3a
-> {"status":"running"|"done","results":[{"model":"qwen-plus","alive":false,"keysAlive":0,"attempts":3}, ...]}
```

- Logika probe dipindah dari `test/live-quota-check.js` ke modul bersama
  `lib/quota-probe.js` (bagian 5) supaya dipakai bergantian oleh endpoint ini
  dan CLI — satu implementasi, dua pintu.
- Probe tetap menjalankan **instance proxy sementara di port lain dengan
  subset key** (prinsip yang sama dengan tooling sekarang) sehingga cooldown
  produksi tidak tercemar.
- Guard: hanya satu job aktif pada satu waktu → `409` kalau ada yang jalan;
  timeout job 5 menit.

### 2.7 Penambahan kecil pada endpoint yang sudah ada

- `GET /status`: tambah field ringkas di level atas: `modelCooldownCount`,
  `uptimeSec`, `version` (dari `package.json`). Struktur lama tidak berubah.
- Respons 503 rotasi: tambah `"code": "pool_exhausted"` di objek `error`
  (field `message`/`model`/`attempts` tetap).


## 3. Web dashboard (`GET /dashboard`) *(P1)*

Satu file `public/dashboard.html` yang disajikan `server.js` (tanpa build,
tanpa dependency, tanpa CDN — supaya tetap jalan di container terisolasi).
Auth: halaman menampilkan form token; token disimpan di `sessionStorage` dan
dikirim sebagai `Authorization: Bearer` di setiap `fetch`. Halaman tidak
mengandung rahasia apa pun — semua data diambil dari endpoint bagian 2.

Empat tab, auto-refresh 15 detik:

### Tab "Ringkasan"
- Angka besar: key aktif / total, model `ok` / `partial` / `exhausted`,
  uptime. Sumber: `GET /status` + `GET /admin/models`.
- Bar kesehatan pool + tombol aksi cepat: **Reset semua cooldown**,
  **Muat ulang key**.

### Tab "Keys"
- Tabel dari `GET /status`: masked key, status badge (`active`/`cooldown`),
  `cooldownUntil` (dihitung jadi "pulih dalam 2 jam"), alasan,
  `totalRequests`, `totalFailures`, `lastError` terpotong dengan tooltip.
- Tombol per baris: **Reset key ini** → `POST /admin/reset/key`.
- Filter: semua / active / cooldown.

### Tab "Models"
- Katalog dari `GET /admin/models` dengan kolom: id (klik = salin), kategori
  (chip), transport, status badge, `keysBlocked/keysTotal`, label
  rekomendasi.
- Pencarian teks + filter kategori/status; klik baris membuka detail
  (`GET /admin/models/{id}`) termasuk `sample` key yang memblokir dan tombol
  **Reset cooldown model ini**.
- Setiap model punya tombol **Salin curl** yang menghasilkan contoh request
  sesuai transport-nya (chat / embeddings / native image) — menerjemahkan
  MODELS.md jadi aksi.

### Tab "Probe"
- Form: daftar model (textarea, satu per baris) + jumlah key sample →
  `POST /admin/probe`, lalu polling `GET /admin/probe/{jobId}` tiap 2 detik
  sampai `done`; hasil tampil sebagai tabel hidup/mati per model dengan
  alasan. Ini versi UI dari `npm run test:quota`.

Batasan yang disengaja: dashboard **read-mostly** — tidak ada edit key,
tidak ada upload file. Mutasi hanya reset cooldown & reload key (dua
endpoint yang memang aman). Menambah/menghapus key tetap lewat edit file +
reload, supaya jejak perubahan key ada di filesystem.

## 4. CLI (`bin/dsp.js`) *(P0)*

Satu file Node tanpa dependency, membaca `PORT` + `DASHSCOPE_PROXY_TOKEN`
dari `.env` (pola parser yang sama dengan `start.ps1`) atau dari flag
`--base-url`/`--token`. Dipanggil via `node bin/dsp.js …` atau alias npm.

```
node bin/dsp.js status                     # ringkasan pool + hanya key bermasalah
node bin/dsp.js models                     # katalog: id | kategori | status | blocked
node bin/dsp.js models --category vision   # filter kategori
node bin/dsp.js models qwen-plus           # detail satu model (= GET /admin/models/{id})
node bin/dsp.js recommend                  # hanya model berlabel rekomendasi
node bin/dsp.js probe qwen-plus qwen-turbo --keys 3
node bin/dsp.js reset                      # semua cooldown
node bin/dsp.js reset --model qwen-plus    # satu model
node bin/dsp.js reset --key sk-abc1...wxyz # satu key (masked)
node bin/dsp.js keys reload                # muat ulang api-key.txt
```

Perilaku: output tabel teks rata kolom (tanpa library), exit code
`0` sukses / `1` ada yang gagal / `2` argumen salah — sehingga bisa dipakai
di script CI/cron (mis. setelah isi saldo: `dsp reset --model …`).
Alias npm di `package.json`:

```json
"cli": "node bin/dsp.js",
"keys:reload": "node bin/dsp.js keys reload",
"models": "node bin/dsp.js models",
"recommend": "node bin/dsp.js recommend"
```


## 5. Susunan file yang diusulkan

```
server.js                 # + route /admin/models, /admin/models/{id},
                          #   /admin/reset/model, /admin/reset/key,
                          #   /admin/keys/reload, /admin/probe, /metrics,
                          #   /dashboard (sajikan file statis)
lib/model-catalog.js      # BARU -- sumber kebenaran kategori/transport/
                          # rekomendasi & kosakata status; data awalnya
                          # diturunkan dari survei MODELS.md (164 id)
lib/quota-probe.js        # BARU -- logika dipindah dari test/live-quota-check.js;
                          # dipakai bersama oleh POST /admin/probe dan CLI
lib/metrics.js            # BARU -- counter/histogram sederhana + render Prometheus
bin/dsp.js                # BARU -- CLI (bagian 4)
public/dashboard.html     # BARU -- dashboard satu-file (bagian 3)
test/                     # + test unit untuk katalog & probe (mock, tanpa network)
```

`lib/model-catalog.js` berbentuk data + fungsi kecil:

```js
module.exports = {
  statusCodes: ['ok', 'partial', 'exhausted', 'special', 'realtime_ws_only'],
  categories: {
    'qwen3-vl-plus': { category: 'vision', transport: 'http-chat', notes: 'content array image_url' },
    // ... 164 entri dari survei MODELS.md
  },
  recommendations: { 'fast-chat': 'qwen3.8-flash', 'coding': 'qwen3-coder-plus' /* ... */ },
  classify(modelId, keysBlocked, keysTotal) { /* kembalikan ok/partial/exhausted/special */ },
};
```

Catatan: katalog ini **kurasi**, bukan hasil generate otomatis — id baru dari
upstream yang belum ada di kurasi tampil dengan `category: "unknown"` dan
tetap dihitung statusnya dari state pool. Skrip generator (`npm run
catalog:refresh`) bisa menyusul (P2-3), tapi kurasi manual lebih dulu berguna
karena survei MODELS.md sudah selesai.

## 6. Pekerjaan level protokol *(P2 — perubahan arsitektur)*

Dua item ini bukan sekadar endpoint baru; keduanya mengubah cara proxy
meneruskan traffic. Dicatat sebagai interface masa depan.

### 6.1 Afinitas task→key untuk model async

Masalah (terverifikasi): task `wan2.7-image` yang dibuat oleh key A lalu
di-poll lewat key B membalas `task_status: UNKNOWN`.

Rancangan:
- Saat respons upstream mengandung `output.task_id` (jalur async), simpan
  peta `taskId → indeks key` di memori proxy (TTL 24 jam).
- Saat ada request `GET /api/v1/tasks/<id>` (atau request yang membawa task
  id dikenal), abaikan round-robin dan pakai key pemilik task; fallback ke
  rotasi biasa hanya bila key itu sudah dibuang.
- **Tidak ada perubahan interface klien** — itulah tujuannya: klien tetap
  memanggil endpoint DashScope apa adanya.
- Sinyal observasi baru: counter `dsp_proxy_task_affinity_hits_total` dan
  field `affinity: true/false` di log `[rotate]`.

### 6.2 Proxy WebSocket untuk model `*-realtime`

Masalah: 24 model realtime menolak HTTP (`400 current user api does not
support http call`); percobaan upgrade di proxy sekarang berakhir `503`.

Rancangan:
- `server.on('upgrade')` di `server.js` untuk path
  `/compatible-mode/v1/realtime` dan `/api-ws/v1/inference`: validasi token,
  pilih key dengan logika pool yang sama, sambungkan ke upstream, lalu pipe
  dua arah.
- Karena `node:http` tidak memecah frame WS, cukup forward byte mentah
  setelah handshake — tidak perlu parser WebSocket penuh.
- Interface baru untuk klien:
  `wss://<proxy>:8787/compatible-mode/v1/realtime?model=qwen3-tts-flash-realtime`
  dengan header `Authorization: Bearer <token>`.
- Key rotation mid-session tidak masuk akal (session stateful), jadi satu
  koneksi WS menempel di satu key; kalau key mati di tengah sesi, tutup
  dengan close code `4503` + alasan.

Keduanya menaikkan kompleksitas nyata — dijadwalkan setelah bagian 2–4
stabil dan punya test.


## 7. Prioritas implementasi

Urutan dipilih berdasarkan (nilai operasional ÷ ukuran diff), dengan
ketergantungan antar item:

| Tahap | Item | Nilai | Perkiraan ukuran | Ketergantungan |
|---|---|---|---|---|
| **P0-1** | `POST /admin/reset/model` & `/admin/reset/key` | tinggi — operasi paling sering setelah isi saldo | ~50 baris | — |
| **P0-2** | `lib/model-catalog.js` + `GET /admin/models` & `/{id}` | tinggi — mengubah MODELS.md jadi data hidup | ~200 baris (termasuk kurasi) | — |
| **P0-3** | `bin/dsp.js` (status/models/recommend/reset) | tinggi — akses harian tanpa curl | ~180 baris | P0-1, P0-2 |
| **P1-1** | `POST /admin/keys/reload` | sedang — hapus keharusan restart | ~50 baris | — |
| **P1-2** | `GET /metrics` (Prometheus) | sedang — observability deployment docker | ~100 baris | — |
| **P1-3** | `POST /admin/probe` + pindah logika ke `lib/quota-probe.js` | sedang — probe tanpa akses mesin | ~150 baris refactor | P0-2 |
| **P1-4** | `GET /dashboard` (`public/dashboard.html`) | sedang — visualisasi untuk non-CLI | ~350 baris HTML/JS | P0-1..P0-3, P1-1, P1-3 |
| **P2-1** | Afinitas task→key | tinggi untuk `wan*` (bila model async mau dipakai) | ~120 baris + sniffing body respons | — |
| **P2-2** | Proxy WebSocket realtime | membuka 24 model, risiko tertinggi | ~200 baris, perlu test WS | — |
| **P2-3** | Generator katalog otomatis dari `/models` upstream | rendah — kurasi manual masih cukup | satu skrip | P0-2 |

Saran pembagian commit: satu tahap = satu commit (pola repo ini), masing-masing
ditutup dengan `npm test` + `npm run test:live`.

## 8. Keamanan

- Tidak ada token baru, tidak ada role: semua interface memakai
  `PROXY_ACCESS_TOKEN` tunggal yang sudah ada. Konsekuensinya dashboard hanya
  boleh dipublikasikan di network tepercaya; bila perlu, tambahkan env
  `LISTEN_ADDR` (default `0.0.0.0`, set `127.0.0.1` untuk localhost-only).
- Key mentah tidak pernah ditulis ke respons interface mana pun (kebijakan
  `maskKey()` diteruskan ke semua endpoint baru).
- Body admin divalidasi ketat (tipe & panjang), respons `400` dengan pesan
  eksplisit — tidak ada fallback diam-diam.
- `/admin/probe` menjalankan proses anak: batasi satu job aktif (`409`) dan
  timeout job 5 menit supaya tidak jadi vektor beban.
- `/metrics` hanya memuat nama model & kode alasan; tidak memuat key, header,
  atau body request.

## 9. Yang sengaja TIDAK diusulkan

- **Multi-user / RBAC / API key per klien** — overkill untuk satu token
  gerbang di network privat; menambah kompleksitas auth tanpa masalah nyata.
- **UI manajemen key (tambah/hapus lewat web)** — jejak perubahan key lebih
  aman di filesystem (`api-key.txt`, sudah git-ignored); UI cukup trigger
  reload.
- **Gateway features** (rate limiting klien, caching respons, retry
  klien-side) — di luar fokus sistem ini sebagai rotator key transparan.
- **Database** — semua state tetap in-memory seperti sekarang; restart
  mengosongkan cooldown adalah perilaku yang benar dan sudah terdokumentasi.

