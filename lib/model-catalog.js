'use strict';

// Katalog metadata model terkurasi -- sumber datanya survei MODELS.md per 31-08-2026
// (164 id dari GET /compatible-mode/v1/models). INTERFACE.md §5: modul ini adalah sumber
// kebenaran kategori/transport/rekomendasi & kosakata status untuk GET /admin/models.
// Id baru dari upstream yang belum terkurasi tampil dengan category 'unknown' -- status
// pool-nya tetap dihitung dari modelCooldowns, jadi katalog basi pun tidak menyesatkan.

const statusCodes = ['ok', 'partial', 'exhausted', 'special', 'realtime_ws_only'];

// Rekomendasi harian (MODELS.md "Rekomendasi harian") -- label tugas -> model.
const recommendations = {
  'chat-cepat': { id: 'qwen3.8-flash', why: '+-1,3s; function calling + JSON mode' },
  'chat-terbaik': { id: 'qwen3.8-max', why: '+-2,3s' },
  'reasoning-murah': { id: 'deepseek-v4-flash', why: 'beri max_tokens besar; isi di reasoning_content' },
  'reasoning-kuat': { id: 'qwen3.8-2.4t-a95b', why: '+-3,0s' },
  'coding': { id: 'qwen3-coder-plus', why: '+-0,6s' },
  'baca-gambar': { id: 'qwen3-vl-plus', why: 'content array image_url' },
  'ocr-dokumen': { id: 'qwen-vl-ocr-2025-11-20', why: '+-1,3s dengan gambar' },
  'embedding-rag': { id: 'text-embedding-v4', why: 'POST /compatible-mode/v1/embeddings (dim 1024)' },
  'terjemahan-teks': { id: 'qwen-mt-plus', why: 'wajib translation_options {source_lang,target_lang}' },
  'suara-tts': { id: 'qwen3-tts-flash', why: 'endpoint native + input.voice' },
  'gambar-t2i': { id: 'qwen-image-2.0', why: 'endpoint native multimodal-generation' },
};

// Open-weight (MODELS.md §2). Varian dasar qwen3 menolak panggilan non-stream tanpa
// enable_thinking:false; varian -instruct/-thinking dan keluarga 3.5/3.6 tidak butuh.
const OPEN_WEIGHT_ALL = [
  'qwen2-7b-instruct',
  'qwen3-8b', 'qwen3-14b', 'qwen3-32b', 'qwen3-30b-a3b', 'qwen3-235b-a22b',
  'qwen3-30b-a3b-instruct-2507', 'qwen3-30b-a3b-thinking-2507',
  'qwen3-235b-a22b-instruct-2507', 'qwen3-235b-a22b-thinking-2507',
  'qwen3-next-80b-a3b-instruct', 'qwen3-next-80b-a3b-thinking',
  'qwen3.5-27b', 'qwen3.5-35b-a3b', 'qwen3.5-122b-a10b', 'qwen3.5-397b-a17b',
  'qwen3.6-27b', 'qwen3.6-35b-a3b',
];
const OPEN_WEIGHT_NEED_THINKING_FALSE = new Set([
  'qwen3-8b', 'qwen3-14b', 'qwen3-32b', 'qwen3-30b-a3b', 'qwen3-235b-a22b',
]);

// Klasifikasi berbasis aturan (bukan peta 164 entri) supaya id snapshot/bertanggal baru
// tetap terklasifikasi benar selama mengikuti pola penamaan DashScope. Urutan aturan
// penting: yang paling spesifik dulu (realtime -> wan async -> image -> ...).
function classify(modelId) {
  const id = String(modelId || '');
  const low = id.toLowerCase();

  // 1) *-realtime (24 id): HANYA WebSocket (MODELS.md §13) -- tidak bisa di-proxy HTTP.
  if (low.includes('-realtime')) {
    return {
      category: 'realtime', transport: 'websocket', special: true,
      notes: 'Hanya WebSocket (wss://.../api-ws/v1/inference); HTTP dibalas 400 "current user api does not support http call" -- rencana INTERFACE.md §6.2 (P2-2)',
    };
  }

  // 2) wan2.7 image: async task (MODELS.md §14) -- belum reliabel tanpa afinitas task->key.
  if (low.startsWith('wan2.7-image')) {
    return {
      category: 'image-generation', transport: 'native-async', special: true,
      notes: 'POST /api/v1/services/aigc/image-generation/generation + header X-DashScope-Async: enable -> task_id, lalu GET /api/v1/tasks/<id>; butuh afinitas task->key (P2-1); parameters.size minimal ~590 ribu pixel',
    };
  }

  // 3) image-edit native.
  if (low.startsWith('qwen-image-edit')) {
    return {
      category: 'image-edit', transport: 'native', special: true,
      notes: 'Endpoint native /api/v1/services/aigc/multimodal-generation/generation; content {image:<url>} + {text:<instruksi>}',
    };
  }

  // 4) text-to-image native (qwen-image*, z-image*).
  if (low.startsWith('qwen-image') || low.startsWith('z-image')) {
    return {
      category: 'image-generation', transport: 'native', special: true,
      notes: 'Endpoint native /api/v1/services/aigc/multimodal-generation/generation (endpoint chat menolak: input.messages.0.content)',
    };
  }

  // 5) embeddings (MODELS.md §10).
  if (low.startsWith('text-embedding') || low === 'qwen3.7-text-embedding') {
    return {
      category: 'embeddings', transport: 'openai-embeddings', special: false,
      notes: 'POST /compatible-mode/v1/embeddings (dim 1024)',
    };
  }

  // 6) rerank (tidak muncul di daftar /models upstream, tapi terkurasi di survei).
  if (low.includes('rerank')) {
    return {
      category: 'rerank', transport: 'native', special: true,
      notes: 'POST /api/v1/services/rerank/text-rerank/text-rerank; tidak muncul di daftar /models upstream',
    };
  }

  // 7) terjemahan teks qwen-mt-* (MODELS.md §8).
  if (low.startsWith('qwen-mt-')) {
    return {
      category: 'translation', transport: 'http-chat', special: true,
      notes: 'WAJIB translation_options {source_lang,target_lang}; tanpa itu jadi chat biasa',
    };
  }

  // 8) livetranslate audio non-realtime (MODELS.md §8).
  if (low.includes('livetranslate')) {
    return {
      category: 'livetranslate', transport: 'http-chat', special: true,
      notes: 'Input audio (input_audio), max_tokens wajib 10-16384, translation_options justru tidak didukung',
    };
  }

  // 9) OCR (MODELS.md §6) -- cara panggil sama dengan VLM.
  if (low.startsWith('qwen-vl-ocr')) {
    return {
      category: 'ocr', transport: 'http-chat', special: false,
      notes: 'content array image_url + instruksi teks',
    };
  }

  // 10) qvq: reasoning visual, wajib stream (MODELS.md §3).
  if (low.startsWith('qvq')) {
    return {
      category: 'reasoning', transport: 'http-chat', special: true,
      notes: 'WAJIB stream:true; selain itu 400 "current user api does not support http call"',
    };
  }

  // 11) vision-language (MODELS.md §5).
  if (low.startsWith('qwen3-vl') || low.startsWith('qwen-vl')) {
    return {
      category: 'vision', transport: 'http-chat', special: false,
      notes: 'content array [{type:"image_url",...},{type:"text",...}]',
    };
  }

  // 12) omni non-realtime (MODELS.md §11) -- semua butuh stream:true.
  if (low.includes('-omni')) {
    return {
      category: 'omni', transport: 'http-chat', special: true,
      notes: 'Butuh stream:true; modalities ["text"] atau ["text","audio"]; qwen-omni-turbo max_tokens 10-2048; captioner butuh input audio',
    };
  }

  // 13) ASR non-realtime (MODELS.md §12).
  if (low.startsWith('qwen3-asr') || low.startsWith('qwen-audio')) {
    return {
      category: 'asr', transport: 'http-chat', special: true,
      notes: 'Part {type:"input_audio",input_audio:{data:<url>,format:"wav"}} (format wajib); endpoint /audio/transcriptions tidak disediakan',
    };
  }

  // 14) TTS non-realtime (MODELS.md §12) -- endpoint native.
  if (low.startsWith('qwen3-tts') || low.startsWith('cosyvoice')) {
    return {
      category: 'tts', transport: 'native', special: true,
      notes: 'Endpoint native /api/v1/services/aigc/multimodal-generation/generation; input {text,voice} (voice wajib); balas URL audio',
    };
  }

  // 15) s2s non-realtime (semua varian saat ini realtime, aturan jaga-jaga).
  if (low.includes('-s2s')) {
    return {
      category: 's2s', transport: 'http-chat', special: true,
      notes: 'Speech-to-speech; input audio',
    };
  }

  // 16) coding/agent (MODELS.md §4).
  if (low.includes('coder') || low === 'kimi-k2.7-code') {
    return {
      category: 'coding', transport: 'http-chat', special: false,
      notes: 'Coding/agent; endpoint chat biasa',
    };
  }

  // 17) qwq reasoning (MODELS.md §3).
  if (low.startsWith('qwq')) {
    return {
      category: 'reasoning', transport: 'http-chat', special: true,
      notes: 'Isi di reasoning_content + content; snapshot 2025-03-05 menolak stream:false',
    };
  }

  // 18) open-weight (MODELS.md §2).
  if (OPEN_WEIGHT_ALL.includes(low)) {
    if (OPEN_WEIGHT_NEED_THINKING_FALSE.has(low)) {
      return {
        category: 'open-weight', transport: 'http-chat', special: true,
        notes: 'Non-stream butuh "enable_thinking":false (400 parameter.enable_thinking must be set to false)',
      };
    }
    return {
      category: 'open-weight', transport: 'http-chat', special: false,
      notes: 'Varian -instruct/-thinking atau keluarga 3.5/3.6: tanpa syarat tambahan',
    };
  }

  // 19) pihak ketiga (MODELS.md §7) -- deepseek, glm, kimi, ZHIPU.
  if (low.startsWith('deepseek')) {
    return {
      category: 'third-party', transport: 'http-chat', special: false,
      notes: low.includes('v4') ? 'Reasoning; beri max_tokens besar supaya content tidak kosong' : 'Jawaban langsung di content',
    };
  }
  if (low.startsWith('glm') || low.startsWith('kimi') || low.startsWith('zhipu/')) {
    return {
      category: 'third-party', transport: 'http-chat', special: false,
      notes: 'Dipanggil seperti model Qwen (endpoint chat yang sama)',
    };
  }

  // 20) lainnya (MODELS.md §15).
  if (low === 'tongyi-tingwu-slp') {
    return {
      category: 'misc', transport: 'http-chat', special: true,
      notes: 'Pipeline transkripsi Tingwu; balas "[]" tanpa format input khusus',
    };
  }

  // 21) karakter/roleplay (MODELS.md §9) -- parameter chat biasa, persona kuat.
  if (low.endsWith('-character')) {
    return {
      category: 'text-generation', transport: 'http-chat', special: false,
      notes: 'Persona/roleplay; parameter sama dengan chat biasa',
    };
  }
  if (low === 'ccai-pro') {
    return {
      category: 'text-generation', transport: 'http-chat', special: false,
      notes: 'Model domain spesifik (kemungkinan kontak/pusat layanan); nama tidak informatif',
    };
  }

  // 22) catch-all keluarga qwen: flagship/alias (MODELS.md §1).
  if (low.startsWith('qwen')) {
    return {
      category: 'text-generation', transport: 'http-chat', special: false,
      notes: 'Chat umum; dukung tools + response_format json_object',
    };
  }

  // 23) tidak terkurasi.
  return { category: 'unknown', transport: 'unknown', special: false, notes: null };
}

// Label rekomendasi untuk satu model (null kalau tidak direkomendasikan).
function taskLabelFor(modelId) {
  for (const [task, v] of Object.entries(recommendations)) {
    if (v.id === modelId) return task;
  }
  return null;
}

// Status ketersediaan dari state pool saja (tanpa metadata katalog).
function poolStatus(keysBlocked, keysTotal) {
  if (keysTotal === 0 || keysBlocked === 0) return 'ok';
  if (keysBlocked < keysTotal) return 'partial';
  return 'exhausted';
}

// Status gabungan ala INTERFACE.md §5: model WebSocket-only selalu 'special' karena
// tidak bisa dites lewat pool HTTP; sisanya murni dari state cooldown pool.
function statusFor(modelId, keysBlocked, keysTotal) {
  if (classify(modelId).transport === 'websocket') return 'special';
  return poolStatus(keysBlocked, keysTotal);
}

module.exports = { statusCodes, recommendations, classify, taskLabelFor, poolStatus, statusFor };
