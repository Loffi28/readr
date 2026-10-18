// Бесплатный перевод без ключей: Google (публичный эндпоинт), MyMemory,
// либо свой сервер LibreTranslate. Результаты кэшируются на устройстве.
import { db } from './db.js';
import { settings } from './state.js';
import { aiFor, aiTranslate } from './llm.js';

const gl = (code) => ({ zh: 'zh-CN', he: 'iw', no: 'no' }[code] || code);

async function cached(key, fn) {
  const hit = await db.get('cache', key).catch(() => null);
  if (hit) return hit.v;
  const v = await fn();
  if (v) db.put('cache', { key, v, at: Date.now() }).catch(() => {});
  return v;
}

function chunks(text, max = 1400) {
  if (text.length <= max) return [text];
  const parts = [];
  let buf = '';
  for (const piece of text.split(/(?<=[.!?…。！？\n])\s*/)) {
    if ((buf + ' ' + piece).length > max && buf) { parts.push(buf); buf = ''; }
    if (piece.length > max) {
      for (let i = 0; i < piece.length; i += max) parts.push(piece.slice(i, i + max));
    } else buf = buf ? buf + ' ' + piece : piece;
  }
  if (buf) parts.push(buf);
  return parts;
}

async function getJSON(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function google(text, from, to, withDict = false) {
  const params = new URLSearchParams({ client: 'gtx', sl: gl(from), tl: gl(to), dj: '1', q: text });
  let url = 'https://translate.googleapis.com/translate_a/single?' + params + '&dt=t';
  if (withDict) url += '&dt=bd';
  const j = await getJSON(url);
  const main = (j.sentences || []).map((s) => s.trans || '').join('');
  const variants = (j.dict || []).map((d) => ({ pos: d.pos, terms: d.terms || [] }));
  return { main, variants };
}

async function mymemory(text, from, to) {
  const url = 'https://api.mymemory.translated.net/get?' + new URLSearchParams({ q: text.slice(0, 500), langpair: `${from}|${to}` });
  const j = await getJSON(url);
  const main = j.responseData?.translatedText || '';
  const alt = [...new Set((j.matches || []).map((m) => m.translation).filter((t) => t && t.toLowerCase() !== main.toLowerCase()))].slice(0, 6);
  return { main, variants: alt.length ? [{ pos: '', terms: alt }] : [] };
}

async function libre(text, from, to) {
  const base = settings.libreUrl.replace(/\/$/, '');
  const j = await getJSON(base + '/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source: from, target: to, format: 'text', api_key: settings.libreKey || undefined }),
  });
  return { main: j.translatedText || '', variants: [] };
}

const PROVIDERS = { google, mymemory, libre };

async function withFallback(text, from, to, withDict) {
  const order = [settings.provider, ...Object.keys(PROVIDERS).filter((p) => p !== settings.provider && p !== 'libre')];
  let lastErr;
  for (const p of order) {
    try {
      const r = await PROVIDERS[p](text, from, to, withDict);
      if (r.main) return r;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Перевод недоступен');
}

// Слово или фраза: основной перевод + варианты по частям речи.
export function lookup(word, from, to = settings.native) {
  return cached(`w|${from}|${to}|${word.toLowerCase()}`, () => withFallback(word, from, to, true));
}

// Предложение, абзац, страница.
export async function translateText(text, from, to = settings.native) {
  const t = text.trim();
  if (!t) return '';
  if (aiFor('aiSentences')) {
    try { return await aiTranslate(t, from, to); } catch (e) { console.warn('ИИ-перевод не удался, беру Google', e); }
  }
  return cached(`t|${from}|${to}|${t}`, async () => {
    const out = [];
    for (const part of chunks(t)) out.push((await withFallback(part, from, to, false)).main);
    return out.join(' ');
  });
}

export const POS_RU = {
  'имя существительное': 'сущ.', 'существительное': 'сущ.', 'глагол': 'глаг.', 'имя прилагательное': 'прил.',
  'прилагательное': 'прил.', 'наречие': 'нареч.', 'местоимение': 'местоим.', 'междометие': 'межд.',
  'сокращение': 'сокр.', 'фраза': 'фраза',
  noun: 'сущ.', verb: 'глаг.', adjective: 'прил.', adverb: 'нареч.', pronoun: 'местоим.',
  preposition: 'предлог', conjunction: 'союз', interjection: 'межд.', article: 'артикль',
  abbreviation: 'сокр.', phrase: 'фраза', prefix: 'приставка', suffix: 'суффикс', particle: 'частица',
};
