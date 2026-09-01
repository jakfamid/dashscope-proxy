# dashscope-proxy

Reverse proxy ringan (Node.js murni, tanpa dependency npm) untuk DashScope
compatible-mode (OpenAI-compatible). Merotasi beberapa API key DashScope
secara otomatis saat salah satu kena rate limit atau kuota trial gratis
habis, sehingga klien (mis. n8n) cukup memanggil satu endpoint tetap.

## Cara kerja singkat

- Klien memanggil proxy ini pakai token gerbang (`PROXY_ACCESS_TOKEN`), **bukan**
  API key DashScope asli.
- Proxy meneruskan request ke DashScope memakai salah satu key dari pool,
  round-robin.
- Kalau key yang dipakai kena rate limit / kuota habis / ditolak, proxy
  otomatis coba key berikutnya di pool untuk request yang sama.
- Kegagalan diklasifikasikan jadi cooldown level **key** (kredensial invalid,
  network error) atau level **model** (kuota trial habis / rate limit /
  akses model ditolak untuk model tsb saja) -- karena kuota trial DashScope
  dialokasikan per model per key, bukan per key secara keseluruhan.
- Ada batas waktu total rotasi per request (`REQUEST_MAX_DURATION_MS`) supaya
  kalau upstream hang, klien tidak menunggu sampai *semua* key di pool habis
  timeout satu-satu.

## Setup

1. Salin `.env.example` jadi `.env`, isi `DASHSCOPE_PROXY_TOKEN` dengan
   string acak panjang (`openssl rand -hex 32`). Ini token yang dipakai
   klien, bukan API key DashScope.
2. Buat file `api-key.txt` di folder ini, isi API key DashScope asli
   (satu key per baris; baris diawali `#` diabaikan). File ini **jangan**
   pernah di-commit (sudah masuk `.gitignore`).

## Menjalankan

### Dengan Docker (direkomendasikan untuk deployment)

```bash
docker compose up -d --build
```

`docker-compose.yaml` menyambungkan container ke network eksternal
`dental-ai-lab_ai-network` (dibuat oleh project HomeLab-AI-Dental) supaya
n8n di sana bisa memanggil proxy ini lewat nama service `dashscope-proxy`.
Kalau dipakai berdiri sendiri tanpa HomeLab-AI-Dental, hapus bagian
`networks` di `docker-compose.yaml`.

### Tanpa Docker (native)

Butuh Node.js >= 18 (pakai `fetch`/`Headers`/`AbortController` bawaan, tidak
ada dependency npm sama sekali).

```bash
./start.sh        # Linux/macOS/Git Bash
```

```powershell
.\start.ps1       # Windows PowerShell
```

Kedua script membaca `.env`, memetakan `DASHSCOPE_PROXY_TOKEN` jadi
`PROXY_ACCESS_TOKEN` (nama variabel yang beneran dibaca `server.js`), lalu
menjalankan `node server.js`. Ini perlu dijembatani manual karena Node
tidak otomatis baca `.env`, dan pemetaan nama variabel yang sama biasanya
ditangani `docker-compose.yaml` lewat `${DASHSCOPE_PROXY_TOKEN}` -- yang
tidak berlaku kalau `server.js` dijalankan langsung.

Atau jalankan manual tanpa script, set env var langsung:

```bash
PORT=8787 DASHSCOPE_API_KEYS_FILE=./api-key.txt PROXY_ACCESS_TOKEN=<token> node server.js
```

### Stop & restart

`server.js` menulis PID-nya sendiri ke file `.dashscope-proxy.pid` di folder ini
begitu mulai listen (override lokasinya lewat env var `PID_FILE`) -- jadi
`stop`/`restart` bekerja tidak peduli proxy dijalankan lewat `npm start`,
`start.sh`, `start.ps1`, atau `node server.js` langsung.

```bash
./stop.sh         # atau: npm run stop
./restart.sh      # atau: npm run restart
```

```powershell
.\stop.ps1
.\restart.ps1
```

`restart` menghentikan proses lama (kalau sedang jalan) lalu menjalankan ulang
lewat `start.sh`/`start.ps1` -- tetap berjalan di foreground seperti start
biasa (perlu dijalankan lagi setelah edit `server.js`, tidak ada hot-reload).
Kalau dijalankan dengan Docker, pakai `docker compose stop` / `docker compose
restart` seperti biasa, bukan script ini.

### Autostart di Windows (Task Scheduler)

Supaya proxy jalan otomatis setiap kali Windows nyala:

```powershell
.\install-autostart.ps1              # start otomatis saat user login
.\install-autostart.ps1 -AtStartup   # start otomatis saat boot, sebelum login (jalan sebagai SYSTEM)
```

Script minta elevasi administrator (UAC) lalu mendaftarkan task
`DashscopeProxy Autostart` di Task Scheduler yang memanggil `start.ps1`
lewat launcher VBS kecil (`autostart-launcher.vbs`, dibuat otomatis,
sudah masuk `.gitignore`) supaya tidak muncul jendela console. Task
dikonfigurasi tanpa batas waktu eksekusi (default Task Scheduler 3 hari
akan mematikan server), tetap jalan saat pakai baterai, tidak dobel
kalau instance sebelumnya masih hidup, dan retry otomatis 3x kalau
gagal start. Hapus autostart kapan saja:

```powershell
.\remove-autostart.ps1
```

Varian default berjalan sebagai user yang menginstal sehingga `stop.ps1`
tetap bekerja tanpa admin; varian `-AtStartup` berjalan sebagai SYSTEM
(proxy sudah siap sebelum login, cocok untuk mesin server) --
konsekuensinya `stop.ps1` harus dijalankan sebagai administrator untuk
mematikannya.

## Endpoint

| Endpoint | Auth | Keterangan |
|---|---|---|
| `*` (semua path lain) | Bearer token | Diteruskan ke DashScope dengan rotasi key |
| `GET /healthz` | tidak perlu | Health check, balas `ok` |
| `GET /status` | Bearer token | Status tiap key (masked): cooldown, jumlah request/gagal, error terakhir |
| `POST /admin/reset` | Bearer token | Reset semua cooldown (key & model) -- pakai setelah isi saldo/billing DashScope |
| `POST /admin/reset/model` | Bearer token | Reset cooldown satu model di semua key (`{"model":"..."}`) |
| `POST /admin/reset/key` | Bearer token | Reset cooldown satu key, terima bentuk masked (`{"key":"sk-abc...wxyz"}`) |
| `GET /admin/models` | Bearer token | Katalog model hidup: daftar upstream + metadata kurasi + status per model; filter `q`, `category`, `status` |
| `GET /admin/models/{id}` | Bearer token | Ketersediaan satu model: verdict, alasan cooldown per key, sample |
| `POST /admin/keys/reload` | Bearer token | Muat ulang `api-key.txt` tanpa restart; statistik & cooldown key lama dipertahankan |
| `POST /admin/probe` | Bearer token | Mulai job probe kuota (`{"models":[...],"keys":N}`) -> `202` + `jobId`; hanya satu job aktif (`409` bila masih jalan) |
| `GET /admin/probe/{jobId}` | Bearer token | Status & hasil job probe (`running`/`done`, baris hasil per model, `error` bila ada) |
| `GET /metrics` | tidak perlu | Metrik agregat format Prometheus (request/gagal per model & kode alasan, rotasi, latency bucket, jumlah key/cooldown aktif) -- tanpa rahasia |
| `GET /dashboard` | tidak perlu | Web dashboard satu file (login pakai `PROXY_ACCESS_TOKEN`, token hanya disimpan di `sessionStorage` browser) |

Auth pakai header `Authorization: Bearer <PROXY_ACCESS_TOKEN>`. Kalau
`PROXY_ACCESS_TOKEN` tidak diset, semua endpoint terbuka tanpa autentikasi
(cocok untuk network privat, proxy akan cetak warning saat start).

## Model

Daftar lengkap 164 model yang terlihat oleh pool key ini, dikategorikan berdasarkan
fungsinya (teks, reasoning, coding, vision, OCR, omni, ASR/TTS, terjemahan, embedding,
image generation, model pihak ketiga) plus status kuota hasil tes nyata, ada di
**[MODELS.md](MODELS.md)**. Daftar mentah kapan pun:
`GET /compatible-mode/v1/models`.

Batas yang perlu diketahui sebelum memilih model:

- **Proxy ini hanya meneruskan HTTP.** Model berakhiran `-realtime` (24 id: asr/tts/omni/
  livetranslate/s2s) butuh WebSocket ke `wss://.../api-ws/v1/inference` dan membalas
  `400 current user api does not support http call` kalau dipanggil lewat HTTP -- jadi
  tidak bisa dipakai lewat proxy ini.
- **Task async tidak ikut rotasi key.** Model image async (mis. `wan2.7-image`) dibuat oleh
  satu key lalu di-poll lewat `GET /api/v1/tasks/<id>`; karena proxy memilih key secara
  round-robin, poll bisa jatuh ke key lain dan membalas `task_status: UNKNOWN`.
- Sebagian model butuh parameter khusus: open-weight Qwen3 menolak non-stream tanpa
  `enable_thinking: false`, `qvq-max` dan omni butuh `stream: true`, TTS/image memakai
  endpoint native `/api/v1/services/aigc/...`, embedding memakai
  `/compatible-mode/v1/embeddings`. Detail per kategori ada di MODELS.md.

Proposal pengembangan interface sistem ini (admin API, dashboard web, CLI,
plus rencana afinitas task async & WebSocket realtime) ada di
**[INTERFACE.md](INTERFACE.md)** — katalog model (§2.1–2.2), reset selektif
(§2.3–2.7), CLI (§4, `npm run cli`), dan seluruh P1 — reload key (§2.4),
`/metrics` (§2.5), probe terkelola (§2.6), dashboard (§3) — sudah
diimplementasi; tersisa P2 (afinitas task async & WebSocket realtime).

### Dashboard web

Buka `http://<host>:<PORT>/dashboard`, masukkan `PROXY_ACCESS_TOKEN` di form
login. Halaman HTML-nya sendiri publik dan tidak mengandung rahasia apa pun —
semua data ditarik browser dari endpoint admin ber-token, dan token hanya
disimpan di `sessionStorage` tab tersebut. Tab yang tersedia: Ringkasan
(kesehatan pool + tombol reset/reload), Keys, Models (katalog + detail cooldown),
dan Probe (menjalankan job probe kuota tanpa menyentuh terminal). Karena
dashboard memakai token proxy penuh, hanya publikasikan di network tepercaya.

## Variabel lingkungan

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `8787` | Port HTTP proxy |
| `DASHSCOPE_API_KEYS` | - | Daftar key, pisah koma/baris baru |
| `DASHSCOPE_API_KEYS_FILE` | - | Path file berisi key (satu per baris) -- digabung dengan `DASHSCOPE_API_KEYS` kalau dua-duanya diisi |
| `PROXY_ACCESS_TOKEN` | - | Token gerbang untuk klien; kosong = tanpa auth |
| `DASHSCOPE_UPSTREAM_HOST` | `dashscope-intl.aliyuncs.com` | Host DashScope asli |
| `DASHSCOPE_UPSTREAM_ORIGIN` | `https://<UPSTREAM_HOST>` | Override penuh (termasuk skema) -- buat tes lokal ke mock server `http://` |
| `MAX_BODY_BYTES` | `26214400` (25MB) | Batas ukuran body request |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Timeout per percobaan ke upstream |
| `REQUEST_MAX_DURATION_MS` | `2 x UPSTREAM_TIMEOUT_MS` | Batas total waktu rotasi antar key per request |
| `RATE_LIMIT_COOLDOWN_MS` | `60000` | Cooldown model saat kena rate limit |
| `INVALID_KEY_COOLDOWN_MS` | `21600000` (6 jam) | Cooldown key saat kredensial ditolak (401) |
| `FREE_TIER_EXHAUSTED_COOLDOWN_MS` | `2592000000` (30 hari) | Cooldown model saat kuota trial gratis habis (biasanya permanen sampai isi saldo -- pakai `/admin/reset` setelah itu) |
| `MODEL_ACCESS_DENIED_COOLDOWN_MS` | `86400000` (24 jam) | Cooldown model saat model tidak diaktifkan untuk akun key tsb |
| `PID_FILE` | `.dashscope-proxy.pid` | Lokasi file PID yang ditulis saat start, dibaca `stop.sh`/`stop.ps1`/`restart.sh`/`restart.ps1` |
| `PROBE_CHILD_PORT` | `8794` | Port instance proxy sementara yang dijalankan job `POST /admin/probe` (harus bebas; default dipilih di luar PORT umum) |
| `PROBE_JOB_TIMEOUT_MS` | `300000` (5 menit) | Batas waktu satu job probe; hasil parsial tetap dilaporkan bila timeout |

## Keamanan

- `api-key.txt` dan `.env` sudah masuk `.gitignore` -- jangan pernah commit.
- Perbandingan token pakai `crypto.timingSafeEqual`, bukan `===` biasa.
- `/status` dan `/admin/reset` selalu butuh token yang sama dengan proxy.
