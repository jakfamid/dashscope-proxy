# Daftar model yang bisa dipakai lewat proxy ini

Diambil dari `GET /compatible-mode/v1/models` upstream DashScope pada **31-08-2026**
(164 id) dan dicoba langsung lewat proxy. Kolom status:

| Tanda | Arti |
|---|---|
| ✅ | tes nyata hari ini balas `200` |
| ⚙️ | hidup, tapi butuh endpoint/parameter khusus (lihat catatan kategori) |
| 🟡 | id bertanggal/snapshot serumacam, belum dites satu-satu |
| ❌ | dites dan **tidak** bisa dipakai sekarang (kuota trial habis / tidak ada akses) |

Cara pakai (semua kategori): `POST http://<proxy>:8787/compatible-mode/v1/chat/completions`
dengan header `Authorization: Bearer <PROXY_ACCESS_TOKEN>` dan field `model` seperti di
bawah ini — kecuali yang memang butuh endpoint native (disebutkan eksplisit).

## Rekomendasi harian

| Kebutuhan | Model | Catatan |
|---|---|---|
| Chat cepat & murah (default) | `qwen3.8-flash` | ✅ 1,3s, dukung function calling + JSON mode |
| Chat kualitas tertinggi | `qwen3.8-max` | ✅ 2,3s |
| Reasoning murah | `deepseek-v4-flash` | ✅ beri `max_tokens` cukup besar; isinya jalan di `reasoning_content` |
| Reasoning kuat | `qwen3.8-2.4t-a95b` | ✅ 3,0s |
| Coding / agent | `qwen3-coder-plus` | ✅ 0,6s |
| Baca gambar | `qwen3-vl-plus` | ✅ 0,3–1,9s (via `content` array `image_url`) |
| OCR dokumen | `qwen-vl-ocr-2025-11-20` | ✅ ~1,3s (request dengan gambar) |
| Embedding / RAG | `text-embedding-v4` | ✅ `/compatible-mode/v1/embeddings` |
| Terjemahan teks | `qwen-mt-plus` | ✅ lebih akurat dengan `translation_options` |
| Suara (TTS) | `qwen3-tts-flash` | ⚙️ endpoint native, bukan chat |
| Gambar (text-to-image) | `qwen-image-2.0` | ⚙️ endpoint native |

---

## 1. Teks generatif — bendera (flagship) ✅

Model chat umum, dukung system/user/assistant, `tools` (function calling), dan
`response_format: {"type":"json_object"}` — ketiganya diverifikasi balas 200 pada
`qwen3.8-flash` (prompt pendek, ~1s).

**3.8** · `qwen3.8-max` ✅ · `qwen3.8-flash` ✅ · `qwen3.8-27b` ✅ · `qwen3.8-2.4t-a95b` ✅
**3.7** · `qwen3.7-max` ✅ · `qwen3.7-max-preview` ✅ · `qwen3.7-max-2026-05-17` ✅ ·
`qwen3.7-max-2026-05-20` ✅ · `qwen3.7-max-2026-06-08` ✅ · `qwen3.7-plus` ✅ ·
`qwen3.7-plus-2026-05-26` ✅ · `qwen3.7-flash` ✅ · `qwen3.7-flash-2026-07-15` ✅
**3.6** · `qwen3.6-max-preview` ✅ · `qwen3.6-plus` ✅ · `qwen3.6-plus-2026-04-02` ✅ ·
`qwen3.6-flash` ✅ · `qwen3.6-flash-2026-04-16` ✅
**3.5** · `qwen3.5-plus` ✅ · `qwen3.5-plus-2026-02-15` ✅ · `qwen3.5-plus-2026-04-20` ✅ ·
`qwen3.5-flash` ✅ · `qwen3.5-flash-2026-02-23` ✅
**3 / generasi lama** · `qwen3-max` ✅ · `qwen3-max-preview` ✅ ·
`qwen3-max-2025-09-23` 🟡 · `qwen3-max-2026-01-23` ✅ · `qwen-plus-latest` ✅ ·
`qwen-plus-2025-12-01` ✅ · `qwen-plus-2025-09-11` ✅ · `qwen-plus-2025-07-14` ✅ ·
`qwen-plus-2025-04-28` ✅ · `qwen-max` ✅ · `qwen-flash` ✅
**Lainnya** · `ccai-pro` ✅ (model domain spesifik, nama tidak informatif)

### ❌ Kuota trial habis untuk SEMUA key yang dites (15 key dari pool 119)

`qwen-plus` · `qwen-plus-2025-01-25` · `qwen-turbo`

Ketiganya masih muncul di daftar model dan masih bisa dipanggil, tapi upstream balas
`429 AllocationQuota.FreeTierOnly` di semua key sample → proxy merotasi lalu menyerah
dengan `503`. Pakai varian lain di atas (mis. `qwen-plus-latest` atau `qwen3.5-plus`),
atau isi saldo billing lalu `POST /admin/reset`.

## 2. Open-weight (dense & MoE) — butuh `enable_thinking`

Qwen3 open-weight adalah model *hybrid*: panggilan non-stream **ditolak** dengan
`400 parameter.enable_thinking must be set to false for non-streaming calls`.

✅ dites balas `200` setelah `enable_thinking: false` (juga lolos dengan `stream: true`):
`qwen3-32b`. ⚙️ Ditolak non-stream dengan pesan yang sama persis, jadi butuh parameter
yang sama, tapi belum dites ulang satu per satu: `qwen3-8b` · `qwen3-14b` ·
`qwen3-30b-a3b` · `qwen3-235b-a22b`.
✅ hidup tanpa perlu parameter itu (varian `-instruct` / `-thinking` yang jelas):
`qwen3-235b-a22b-instruct-2507` · `qwen3-235b-a22b-thinking-2507` ·
`qwen3-30b-a3b-instruct-2507` · `qwen3-30b-a3b-thinking-2507` ·
`qwen3-next-80b-a3b-instruct` · `qwen3-next-80b-a3b-thinking`
✅ tanpa syarat tambahan: `qwen3.5-397b-a17b` · `qwen3.5-122b-a10b` · `qwen3.5-35b-a3b` ·
`qwen3.5-27b` · `qwen3.6-27b` · `qwen3.6-35b-a3b`
❌ `qwen2-7b-instruct` → `404 model_not_found` (tidak ada akses untuk akun-akun ini)

## 3. Reasoning murni (chain-of-thought)

`qwq-plus` ✅ · `qwq-plus-2025-03-05` ⚙️ (balas `400 This model only support stream mode`
kalau `stream: false`) — isi jawaban ada di `reasoning_content` + `content`.
`qvq-max` ⚙️ (reasoning visual; **wajib** `stream: true`, selain itu
`400 current user api does not support http call`).

## 4. Coding / agent

`qwen3-coder-plus` ✅ · `qwen3-coder-plus-2025-09-23` ✅ · `qwen3-coder-plus-2025-07-22` ✅ ·
`qwen3-coder-flash` ✅ · `qwen3-coder-next` ✅ · `qwen3-coder-480b-a35b-instruct` ✅ ·
`qwen-coder-plus` ✅ · `kimi-k2.7-code` ✅

## 5. Vision-language (gambar → teks) ✅

Panggil lewat endpoint chat yang sama, isi `content` berupa array
`[{type:"image_url",image_url:{url:...}},{type:"text",text:"..."}]` — diverifikasi 200.

`qwen3-vl-plus` ✅ · `qwen3-vl-plus-2025-12-19` ✅ · `qwen3-vl-plus-2025-09-23` ✅ ·
`qwen3-vl-flash` ✅ · `qwen3-vl-flash-2025-10-15` 🟡 · `qwen3-vl-flash-2026-01-22` 🟡 ·
`qwen3-vl-235b-a22b-instruct` ✅ · `qwen3-vl-235b-a22b-thinking` ✅ (20,7s — paling lambat) ·
`qwen-vl-max` ✅ · `qwen-vl-plus` ✅

## 6. OCR

`qwen-vl-ocr-2025-11-20` ✅ — sama seperti VLM (`image_url` + instruksi teks).

---

## 7. Model pihak ketiga ✅

Dipanggil persis seperti model Qwen (endpoint chat yang sama).

| Model | Status | Laten tes | Catatan |
|---|---|---|---|
| `deepseek-v3.2` | ✅ | 0,6s | jawaban langsung di `content` |
| `deepseek-v4-flash` | ✅ | 1,1s | reasoning → `content` kosong kalau `max_tokens` kecil |
| `deepseek-v4-flash-0731` | ✅ | 1,4s | snapshot |
| `deepseek-v4-pro` | ✅ | 1,1s | reasoning |
| `deepseek-v4-pro-0813` | ✅ | 0,8s | snapshot |
| `glm-5.1` | ✅ | 6,6s | reasoning (`reasoning_content`) |
| `glm-5.2` | ✅ | 0,6s | reasoning |
| `glm-5.2-fast-preview` | ❌ | 1,3s | kuota trial habis di 15/15 key sample |
| `kimi-k3` | ✅ | 3,9s | |
| `kimi/kimi-k3` | ❌ | 1,3s | id "bernamespace" ini jalur kuotanya beda & sudah habis |
| `ZHIPU/GLM-5.3` | ❌ | 1,5s | kuota trial habis di 15/15 key sample |

## 8. Terjemahan

**Teks (`qwen-mt-*`)** ✅ — WAJIB kirim
`translation_options: {source_lang, target_lang}`, kalau tidak, model ini berubah jadi
chat biasa. Terbukti: `qwen-mt-plus` + `"Halo, apa kabar?"` tanpa opsi → membalas
"Halo! Saya baik-baik saja, terima kasih..." (bukan terjemahan); dengan
`translation_options: {source_lang:"indonesian", target_lang:"english"}` → `"Hello, how
are you?"`.
`qwen-mt-plus` ✅ · `qwen-mt-flash` ✅ · `qwen-mt-lite` ✅ · `qwen-mt-turbo` ✅

**Livetranslate (audio)** ⚙️ — `qwen3-livetranslate-flash` hidup (kuota ada) tapi bukan
untuk prompt teks biasa: `max_tokens` wajib 10–16384 (di bawah itu ditolak) dan
`translation_options` justru **tidak** didukung model ini; inputnya harus audio
(`input_audio`). Varian `-realtime` hanya bisa lewat WebSocket (lihat §13).
`qwen3-livetranslate-flash` ⚙️ · `qwen3-livetranslate-flash-2025-12-01` ⚙️ ·
`qwen3-livetranslate-flash-realtime` 🔒 · `qwen3-livetranslate-flash-realtime-2025-09-22` 🔒 ·
`qwen3.5-livetranslate-flash-realtime` 🔒 · `qwen3.5-livetranslate-flash-realtime-2026-05-19` 🔒

## 9. Karakter / roleplay ✅

`qwen-plus-character` ✅ · `qwen-flash-character` ✅ — persona kuat, parameter sama
dengan chat biasa.

## 10. Embedding & rerank (RAG)

| Model | Status | Endpoint |
|---|---|---|
| `text-embedding-v3` | ✅ (dim 1024) | `POST /compatible-mode/v1/embeddings` |
| `text-embedding-v4` | ✅ (dim 1024) | sama |
| `qwen3.7-text-embedding` | ✅ (dim 1024) | sama |
| `qwen3-rerank` | ✅ skor relevan | `POST /api/v1/services/rerank/text-rerank/text-rerank` (native; tidak muncul di daftar `/models`) |

## 11. Omni (teks + audio + gambar sekaligus)

Semua butuh `stream: true`. `modalities: ["text"]` cukup untuk teks;
`["text","audio"]` untuk keluaran suara.

`qwen3.5-omni-plus` ✅ · `qwen3.5-omni-plus-2026-03-15` ✅ · `qwen3.5-omni-flash` ✅ ·
`qwen3.5-omni-flash-2026-03-15` 🟡 · `qwen3-omni-flash` ✅ ·
`qwen3-omni-flash-2025-09-15` 🟡 · `qwen3-omni-flash-2025-12-01` ✅ ·
`qwen-omni-turbo` ⚙️ (`max_tokens` harus 10–2048) ·
`qwen3-omni-30b-a3b-captioner` ⚙️ (butuh input audio, bukan teks) ·
semua varian `-realtime` 🔒 (lihat §13)

## 12. Audio: ASR (speech-to-text) & TTS (text-to-speech)

**ASR** ⚙️ lewat endpoint chat dengan part
`{type:"input_audio", input_audio:{data:<url>, format:"wav"}}` (field `format` wajib;
URL harus bisa diunduh upstream).
`qwen3-asr-flash-2026-02-10` ⚙️ · `qwen-audio-3.0-asr-flash` ⚙️
(kalau `format` dikosongkan: `400 UNSUPPORTED_FORMAT: format is empty`) · varian
`-realtime` 🔒. Endpoint OpenAI `POST /compatible-mode/v1/audio/transcriptions` **tidak**
disediakan DashScope (`404`).

**TTS** ⚙️ **endpoint native**, bukan chat:
`POST /api/v1/services/aigc/multimodal-generation/generation` dengan
`{"model":"qwen3-tts-flash","input":{"text":"...","voice":"Cherry"}}` → balas 200 berisi
URL file audio. Field `voice` **wajib** (`400 The voice property is required`).
`qwen3-tts-flash` ✅ · `qwen3-tts-flash-2025-09-18` 🟡 · `qwen3-tts-flash-2025-11-27` 🟡 ·
`qwen3-tts-instruct-flash` ⚙️ · `qwen3-tts-instruct-flash-2026-01-26` 🟡 ·
`qwen3-tts-vc-2026-01-22` ⚙️ (voice cloning, perlu suara referensi) ·
`qwen3-tts-vd-2026-01-26` ⚙️ (voice design) · semua `-realtime-*` 🔒

## 13. 🔒 Model `*-realtime`: TIDAK bisa lewat proxy ini

24 id berakhiran `-realtime` (asr / tts / omni / livetranslate / s2s) hanya menerima
**WebSocket** (`wss://.../api-ws/v1/inference`). Lewat HTTP biasa upstream membalas
`400 current user api does not support http call`, dan `server.js` hanya meneruskan HTTP
reguler — percobaan `Upgrade: websocket` ke `http://127.0.0.1:8787/api-ws/v1/inference`
dibalas `503`, tidak pernah jadi `101 Switching Protocols`. Jadi untuk ini panggil
DashScope langsung, atau tambahkan penanganan WS ke proxy.

Daftar: `qwen3-asr-flash-realtime` (+2 snapshot) · `qwen3-tts-flash-realtime` (+2) ·
`qwen3-tts-instruct-flash-realtime` (+1) · `qwen3-tts-vc-realtime-2025-11-27` ·
`qwen3-tts-vc-realtime-2026-01-15` · `qwen3-tts-vd-realtime-2025-12-16` ·
`qwen3-tts-vd-realtime-2026-01-15` · `qwen3-omni-flash-realtime` (+2) ·
`qwen3.5-omni-flash-realtime` (+1) · `qwen3.5-omni-plus-realtime` (+1) ·
`qwen3-livetranslate-flash-realtime` (+1) · `qwen3.5-livetranslate-flash-realtime` (+1) ·
`qwen3-s2s-flash-realtime`

## 14. Gambar: text-to-image & image-edit ⚙️

Semuanya **endpoint native** — endpoint chat menolak dengan
`400 Input should be a valid list: input.messages.0.content`.

| Jalur | Model | Status |
|---|---|---|
| sinkron `POST /api/v1/services/aigc/multimodal-generation/generation`, body `input.messages[].content[].text` | `qwen-image-2.0` | ✅ 3,7s |
| sama | `z-image-turbo` | ✅ 1,7s |
| sama | `qwen-image-2.0-2026-03-03` · `qwen-image-2.0-pro` (+3 snapshot) · `qwen-image-3.0` · `qwen-image-3.0-pro` · `qwen-image-max` (+1) · `qwen-image-plus` (+1) | 🟡 |
| edit: sama, content `{image:<url>}` + `{text:<instruksi>}` | `qwen-image-edit` | ✅ 15,6s |
| sama | `qwen-image-edit-max` (+1) · `qwen-image-edit-plus` (+2) | 🟡 |
| **async** `POST /api/v1/services/aigc/image-generation/generation` + header `X-DashScope-Async: enable`, body `input.messages` → `task_id`, lalu `GET /api/v1/tasks/<task_id>` | `wan2.7-image` | ✅ tapi ⚠️ |
| sama | `wan2.7-image-pro` | 🟡 |

Ukuran gambar (khusus `wan2.7-*`): `parameters.size` minimal ~589824 pixel total
(`512*512` ditolak: `Total pixels (262144) must be between 589824 and 16777216`) —
pakai `1024*1024`. `qwen-image-*` menerima `512*512`.

⚠️ **Jalur async belum reliabel di balik rotasi key.** Task dibuat oleh satu key, dan
saat di-poll proxy bisa memilih key lain. Terbukti hari ini: task yang dibuat & di-poll
dengan key yang sama jalan `PENDING → RUNNING → SUCCEEDED` (3 polls, ~24s), tetapi task
yang sama di-poll lewat pool 119 key membalas `task_status: UNKNOWN` (3x berturut-turut).
Perlu afinitas task→key di proxy sebelum model `wan*` bisa dipakai dengan benar.

## 15. Lainnya

`tongyi-tingwu-slp` ✅ (balas 200 dengan `"[]"` — pipeline transkripsi Tingwu, perlu
format input khusus) · `ccai-pro` ✅ (sudah dicatat di §1; nama tidak menjelaskan
fungsinya, kemungkinan model kontak/pusat layanan) · `qwen3.8-2.4t-a95b` ✅ (MoE sangat
besar, tetap ~3s untuk prompt pendek)

---

## Cara cek ulang (jangan telan tabel ini mentah-mentah)

Status "hidup/mati" adalah fakta harian, bukan permanen — kuota trial DashScope
dialokasikan per model per key dan tidak pulih sendiri.

```powershell
# 1. daftar id yang terlihat sekarang (164 per 31-08-2026)
curl.exe -s -H "Authorization: Bearer $tok" http://127.0.0.1:8787/compatible-mode/v1/models

# 2. model mana yang sedang dianggap habis oleh pool produksi
curl.exe -s -H "Authorization: Bearer $tok" http://127.0.0.1:8787/status |
  ConvertFrom-Json | ForEach-Object { $_.keys } |
  Where-Object { $_.modelCooldowns.Count } |
  ForEach-Object { $_.modelCooldowns.model } | Sort-Object -Unique

# 3. live smoke end-to-end
npm run test:live -- -Model qwen3.8-flash
```

Probe kuota terisolasi (key terpisah, instance sementara, tidak menyentuh pool produksi):

```powershell
node test/live-model-probe.js 8                                   # 8 kandidat, berhenti di yang lolos
node test/live-quota-check.js qwen3.8-flash qwen3-coder-plus      # daftar spesifik, semua dilaporkan
node test/live-quota-check.js --keys 15 qwen-plus qwen-turbo      # cek: adakah key lain yang masih punya kuota
```

Setelah mengisi saldo/billing DashScope: `POST /admin/reset` untuk menghapus semua
cooldown model yang tersimpan di proxy.

---

## Lampiran: id yang di atas ditulis singkat

Sesuai catatan "🟡" di bagian atas — id-id ini adalah snapshot serumacam, belum dites
satu-satu, jadi di dokumen di atas ditulis sebagai `(+1)` / `(+2)`:

```
qwen-image-2.0-pro-2026-03-03   qwen-image-2.0-pro-2026-04-22   qwen-image-2.0-pro-2026-06-22
qwen-image-edit-max-2026-01-16  qwen-image-edit-plus-2025-10-30 qwen-image-edit-plus-2025-12-15
qwen-image-max-2025-12-30       qwen-image-plus-2026-01-09
qwen3-asr-flash-realtime-2025-10-27   qwen3-asr-flash-realtime-2026-02-10
qwen3-omni-flash-realtime-2025-09-15  qwen3-omni-flash-realtime-2025-12-01
qwen3-tts-flash-realtime-2025-09-18   qwen3-tts-flash-realtime-2025-11-27
qwen3-tts-instruct-flash-realtime-2026-01-22
qwen3.5-omni-flash-realtime-2026-03-15  qwen3.5-omni-plus-realtime-2026-03-15
```

Semua id ini, plus yang sudah dites, diambil dari `GET /compatible-mode/v1/models`
(164 baris, 31-08-2026). Daftar lengkap mentahnya: `curl.exe -s -H "Authorization: Bearer
$tok" http://127.0.0.1:8787/compatible-mode/v1/models`.
