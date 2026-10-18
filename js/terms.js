// Личный словарь: слова и фразы со статусами изучения.
// Статус: нет записи — новое; 1–4 — изучаю; 5 — знаю; -1 — игнорирую.
import { db, changed } from './db.js';
import { bump } from './state.js';
import { normKey } from './tokenize.js';

export const KNOWN = 5;
export const IGNORED = -1;

export const STATUS_LABEL = {
  0: 'Новое', 1: 'Только начал', 2: 'Узнаю', 3: 'Помню', 4: 'Почти знаю', 5: 'Знаю', [-1]: 'Игнор',
};

const byLang = new Map();   // lang → Map(key → term)
const phrases = new Map();  // lang → Map(firstWord → [term])

export const termKey = (lang, text) => `${lang}|${normKey(text)}`;

function indexPhrase(lang, term, add = true) {
  if (!term.words || term.words.length < 2) return;
  if (!phrases.has(lang)) phrases.set(lang, new Map());
  const m = phrases.get(lang);
  const first = term.words[0];
  const list = (m.get(first) || []).filter((t) => t.key !== term.key);
  if (add) list.push(term);
  list.sort((a, b) => b.words.length - a.words.length);
  if (list.length) m.set(first, list); else m.delete(first);
}

export async function loadLang(lang) {
  if (byLang.has(lang)) return byLang.get(lang);
  const rows = await db.allBy('terms', 'lang', lang);
  const map = new Map();
  for (const t of rows) {
    map.set(normKey(t.text), t);
    indexPhrase(lang, t);
  }
  byLang.set(lang, map);
  return map;
}

export function forgetCache() { byLang.clear(); phrases.clear(); }

export const getTerm = (lang, text) => byLang.get(lang)?.get(normKey(text));
export const statusOf = (lang, key) => byLang.get(lang)?.get(key)?.status ?? 0;
export const phrasesStartingWith = (lang, key) => phrases.get(lang)?.get(key) || [];
export const allTerms = (lang) => [...(byLang.get(lang)?.values() || [])];

export async function saveTerm(lang, text, patch = {}) {
  const map = await loadLang(lang);
  const k = normKey(text);
  const prev = map.get(k);
  const now = Date.now();
  const term = {
    key: termKey(lang, text),
    lang,
    text: prev?.text || text.trim(),
    words: prev?.words || patch.words,
    translation: '',
    notes: '',
    sentence: '',
    status: 1,
    created: now,
    ...prev,
    ...patch,
    updated: now,
  };
  if (!term.words) delete term.words;
  // Статистика: новое выученное и новое добавленное.
  if (term.status === KNOWN && prev?.status !== KNOWN) bump('known');
  if (!prev && term.status >= 1 && term.status < KNOWN) bump('added');
  if (term.status >= 1 && term.status < KNOWN && !term.due) term.due = now;
  map.set(k, term);
  indexPhrase(lang, term);
  await db.put('terms', term);
  changed();
  document.dispatchEvent(new CustomEvent('terms-changed', { detail: { lang, keys: [k] } }));
  return term;
}

export async function deleteTerm(lang, text) {
  const map = await loadLang(lang);
  const k = normKey(text);
  const t = map.get(k);
  if (!t) return;
  map.delete(k);
  indexPhrase(lang, t, false);
  await db.del('terms', t.key);
  await db.tomb('terms', t.key);
  changed();
  document.dispatchEvent(new CustomEvent('terms-changed', { detail: { lang, keys: [k] } }));
}

// Массово отметить новые слова как известные (при перелистывании страницы).
export async function markKnown(lang, keys) {
  const map = await loadLang(lang);
  const now = Date.now();
  const rows = [];
  for (const k of new Set(keys)) {
    if (map.has(k)) continue;
    const t = { key: `${lang}|${k}`, lang, text: k, translation: '', notes: '', sentence: '', status: KNOWN, created: now, updated: now };
    map.set(k, t);
    rows.push(t);
  }
  if (!rows.length) return 0;
  await db.bulkPut('terms', rows);
  await bump('known', rows.length);
  changed();
  document.dispatchEvent(new CustomEvent('terms-changed', { detail: { lang, keys: rows.map((r) => normKey(r.text)) } }));
  return rows.length;
}

export function counts(lang) {
  const c = { known: 0, learning: 0, ignored: 0, phrases: 0 };
  for (const t of byLang.get(lang)?.values() || []) {
    if (t.status === KNOWN) c.known++;
    else if (t.status === IGNORED) c.ignored++;
    else c.learning++;
    if (t.words?.length > 1) c.phrases++;
  }
  return c;
}

export function dueTerms(lang, now = Date.now()) {
  return allTerms(lang).filter((t) => t.status >= 1 && t.status < KNOWN && (t.due ?? 0) <= now);
}
