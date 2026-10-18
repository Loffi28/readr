// ИИ-помощник (по желанию, со своим ключом): перевод слова по контексту,
// перевод предложений и абзацев, исправление текста после распознавания фото.
// Ключ хранится только на этом устройстве и уходит лишь выбранному сервису.
import { db } from './db.js';
import { settings } from './state.js';

export const AI_PROVIDERS = {
  claude: {
    name: 'Claude (Anthropic)',
    models: [['claude-haiku-5-5', 'Haiku 5.5 — дешёвый и быстрый'], ['claude-sonnet-5-5', 'Sonnet 5.5 — точнее'], ['claude-opus-5-5', 'Opus 5.5 — самый умный, дороже']],
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  openrouter: {
    name: 'OpenRouter (есть бесплатные модели)',
    base: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash-lite',
    keyUrl: 'https://openrouter.ai/settings/keys',
    modelsUrl: 'https://openrouter.ai/models?max_price=0',
  },
  gemini: {
    name: 'Google Gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash-lite',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  custom: {
    name: 'Свой сервер (совместимый с OpenAI)',
    base: 'http://localhost:11434/v1',
    model: 'llama3.1',
  },
};

const ANTHROPIC_SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.39.0/+esm';

export const aiReady = () => settings.aiProvider && settings.aiProvider !== 'off'
  && (settings.aiKey || settings.aiProvider === 'custom');
export const aiFor = (feature) => aiReady() && settings[feature] !== false;

const langEn = (code) => {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
};

export class AiError extends Error {}

let anthropicMod = null;
async function claudeComplete(system, user, maxTokens) {
  if (!anthropicMod) anthropicMod = await import(ANTHROPIC_SDK);
  const Anthropic = anthropicMod.default;
  const client = new Anthropic({ apiKey: settings.aiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  try {
    const r = await client.messages.create({
      model: settings.aiModel || 'claude-haiku-5-5',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      // Короткие задачи: минимальное «обдумывание» — быстрее и дешевле.
      output_config: { effort: 'low' },
    });
    if (r.stop_reason === 'refusal') throw new AiError('Модель отказалась отвечать на этот текст');
    return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new AiError('Ключ Claude не подходит');
    if (e instanceof Anthropic.PermissionDeniedError) throw new AiError('Нет доступа к Claude из вашего региона или по этому ключу');
    if (e instanceof Anthropic.RateLimitError) throw new AiError('Слишком много запросов к Claude, подождите минуту');
    if (e instanceof Anthropic.BadRequestError) throw new AiError('Claude не принял запрос: ' + e.message);
    if (e instanceof Anthropic.APIError) throw new AiError(`Claude: ошибка ${e.status ?? 'сети'}`);
    throw e;
  }
}

async function openaiComplete(system, user, maxTokens) {
  const p = AI_PROVIDERS[settings.aiProvider];
  const base = (settings.aiProvider === 'custom' ? settings.aiBaseUrl || p.base : p.base).replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (settings.aiKey) headers.Authorization = 'Bearer ' + settings.aiKey;
  if (settings.aiProvider === 'openrouter') headers['X-Title'] = 'Readr';
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.aiModel || p.model,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error?.message || j[0]?.error?.message || '';
    if (r.status === 401 || r.status === 403 || /api.?key/i.test(msg)) throw new AiError('Ключ не подходит' + (msg ? `: ${msg}` : ''));
    if (r.status === 429) throw new AiError('Лимит запросов исчерпан, подождите или смените модель');
    if (r.status === 404) throw new AiError('Модель не найдена: проверьте название');
    throw new AiError(`Ошибка ${r.status}${msg ? `: ${msg}` : ''}`);
  }
  return j.choices?.[0]?.message?.content || '';
}

export function complete(system, user, maxTokens = 1024) {
  if (!aiReady()) throw new AiError('ИИ не настроен');
  return settings.aiProvider === 'claude'
    ? claudeComplete(system, user, maxTokens)
    : openaiComplete(system, user, maxTokens);
}

function parseJson(text) {
  const m = text.match(/[[{][\s\S]*[\]}]/);
  if (!m) throw new AiError('ИИ ответил не по формату');
  return JSON.parse(m[0]);
}

async function cached(key, fn) {
  const full = `ai|${settings.aiProvider}|${settings.aiModel}|${key}`;
  const hit = await db.get('cache', full).catch(() => null);
  if (hit) return hit.v;
  const v = await fn();
  if (v) db.put('cache', { key: full, v, at: Date.now() }).catch(() => {});
  return v;
}

// Перевод выбранного слова или фразы именно в этом предложении.
export function wordInContext(word, sentence, from, to = settings.native) {
  return cached(`w|${from}|${to}|${word.toLowerCase()}|${sentence}`, async () => {
    const out = await complete(
      'You are a concise bilingual dictionary for language learners. Reply with JSON only, no prose.',
      `Text language: ${langEn(from)}. Learner's native language: ${langEn(to)}.
Sentence: """${sentence}"""
Selected ${word.includes(' ') ? 'phrase' : 'word'}: "${word}"

Return a JSON object:
{"meaning": "translation of the selected item into ${langEn(to)} exactly as it is used in this sentence, 1-4 words",
 "lemma": "dictionary form in ${langEn(from)} (repeat the item if it is already the base form)",
 "pos": "part of speech, in ${langEn(to)}, abbreviated",
 "alternatives": ["up to 4 other common translations into ${langEn(to)}"],
 "note": "one short sentence in ${langEn(to)} about an idiom, phrasal verb, grammar form or nuance worth knowing here; empty string if nothing useful"}`,
      400,
    );
    const j = parseJson(out);
    return {
      meaning: String(j.meaning || '').trim(),
      lemma: String(j.lemma || '').trim(),
      pos: String(j.pos || '').trim(),
      alternatives: (Array.isArray(j.alternatives) ? j.alternatives : []).map(String).filter(Boolean).slice(0, 4),
      note: String(j.note || '').trim(),
    };
  });
}

// Перевод предложения или абзаца с сохранением смысла и интонации.
export function aiTranslate(text, from, to = settings.native) {
  return cached(`t|${from}|${to}|${text}`, async () => (await complete(
    `You are a professional literary translator. Translate the user's text from ${langEn(from)} into ${langEn(to)}. `
    + 'Keep the meaning, tone and register; make it read naturally. If the text contains obvious OCR typos, translate what was clearly meant. '
    + 'Output only the translation, with no comments or quotes.',
    text,
    Math.min(8000, 400 + Math.ceil(text.length * 1.2)),
  )).trim());
}

// Исправление текста после распознавания: опечатки OCR, разорванные слова, мусор.
export async function cleanBlocks(blocks, lang, onProgress) {
  const chunks = [];
  let cur = [], size = 0;
  for (const b of blocks) {
    if (size + b.t.length > 5000 && cur.length) { chunks.push(cur); cur = []; size = 0; }
    cur.push(b);
    size += b.t.length;
  }
  if (cur.length) chunks.push(cur);
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(`ИИ исправляет текст: часть ${i + 1} из ${chunks.length}`, (i + 1) / chunks.length);
    try {
      const reply = await complete(
        `You clean up OCR output of a scanned or photographed page written in ${langEn(lang)}. `
        + 'Fix misrecognized letters and broken or merged words, rejoin words split by hyphenation, and remove junk that is clearly not part of the text '
        + '(stray symbols, page numbers, running headers, fragments of image captions). '
        + 'Merge blocks that were wrongly split in the middle of a sentence. Never translate, summarize or rephrase, and never add text. '
        + 'Input and output are JSON arrays of blocks {"k": kind, "t": text}; kinds: p (paragraph), h1, h2, h3 (headings), li (list item), quote, verse. '
        + 'Reply with the JSON array only.',
        JSON.stringify(chunks[i]),
        Math.min(16000, 600 + Math.ceil(JSON.stringify(chunks[i]).length * 0.8)),
      );
      const fixed = parseJson(reply);
      const valid = Array.isArray(fixed) && fixed.every((b) => b && typeof b.t === 'string');
      out.push(...(valid ? fixed.map((b) => ({ k: ['p', 'h1', 'h2', 'h3', 'li', 'quote', 'verse'].includes(b.k) ? b.k : 'p', t: b.t })) : chunks[i]));
    } catch (e) {
      if (e instanceof AiError && i === 0) throw e;
      out.push(...chunks[i]);
    }
  }
  return out.filter((b) => b.t.trim());
}

export async function testAi() {
  const out = await complete('Reply with one word.', 'Translate "apple" into Russian.', 20);
  if (!out.trim()) throw new AiError('Пустой ответ');
  return out.trim();
}
