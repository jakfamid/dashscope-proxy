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

## Endpoint

| Endpoint | Auth | Keterangan |
|---|---|---|
| `*` (semua path lain) | Bearer token | Diteruskan ke DashScope dengan rotasi key |
| `GET /healthz` | tidak perlu | Health check, balas `ok` |
| `GET /status` | Bearer token | Status tiap key (masked): cooldown, jumlah request/gagal, error terakhir |
| `POST /admin/reset` | Bearer token | Reset semua cooldown (key & model) -- pakai setelah isi saldo/billing DashScope |

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

## Keamanan

- `api-key.txt` dan `.env` sudah masuk `.gitignore` -- jangan pernah commit.
- Perbandingan token pakai `crypto.timingSafeEqual`, bukan `===` biasa.
- `/status` dan `/admin/reset` selalu butuh token yang sama dengan proxy.
