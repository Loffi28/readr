// Связь с Anki.
// Ноутбук: дополнение AnkiConnect (http://127.0.0.1:8765) — добавление и обновление карточек,
// а прогресс из Anki возвращается в словарь (выученное там становится «Знаю»).
// iPhone: AnkiMobile по ссылке anki://x-callback-url/addnote — одна карточка за раз.
import { settings, saveSettings } from './state.js';
import { langName } from './langs.js';
import { allTerms, loadLang, patchTerm, saveTerm, KNOWN, IGNORED } from './terms.js';

const ENDPOINT = 'http://127.0.0.1:8765';
export const MODEL = 'Readr';
const FIELDS = ['Word', 'Meaning', 'Sentence', 'Lemma', 'Notes', 'Audio', 'Reverse', 'ReadrKey'];
export const ANKICONNECT_CODE = '2055492159';

export class AnkiError extends Error {}

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const deckFor = (lang) => `${settings.ankiDeck || 'Readr'}::${langName(lang)}`;

// ---------- AnkiConnect ----------
async function ac(action, params = {}, timeout = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let r;
  try {
    // Без Content-Type: так запрос «простой» и Anki не нужно отвечать на предварительную проверку.
    r = await fetch(ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ action, version: 6, params }),
      signal: ctrl.signal,
      targetAddressSpace: 'loopback',
    });
  } catch {
    throw new AnkiError('Anki не отвечает. Запустите Anki с дополнением AnkiConnect.');
  } finally { clearTimeout(t); }
  const j = await r.json().catch(() => null);
  if (!j) throw new AnkiError('Anki ответил непонятно');
  if (j.error) throw new AnkiError(j.error);
  return j.result;
}

let reachable = null;
export async function ankiReachable() {
  try { await ac('version', {}, 2500); reachable = true; } catch { reachable = false; }
  return reachable;
}
export const ankiLastReachable = () => reachable;

// Просим доступ: Anki сам покажет окно «Разрешить сайту…».
export async function connectAnki() {
  const res = await ac('requestPermission', {}, 60000);
  if (res?.permission !== 'granted') throw new AnkiError('В Anki отказали в доступе');
  await saveSettings({ ankiEnabled: true });
  reachable = true;
  return res;
}

const CSS = `.card { font-family: "Literata", Georgia, serif; font-size: 22px; color: #2F2A25; background: #F6F1E9; text-align: center; line-height: 1.5; padding: 18px; }
.word { font-size: 38px; font-weight: 500; letter-spacing: -0.01em; margin: 10px 0 14px; }
.ctx { font-size: 19px; color: #5A524A; max-width: 34em; margin: 0 auto; }
.ctx b { background: #F8D9C3; font-weight: 500; border-radius: 4px; padding: 0 3px; }
.meaning { font-size: 28px; color: #B95F3C; margin: 14px 0 8px; }
.lemma { font-size: 16px; color: #877D73; }
.notes { font-family: -apple-system, "Segoe UI", sans-serif; font-size: 15px; color: #5A524A; max-width: 30em; margin: 12px auto 0; }
hr#answer { border: 0; border-top: 1px dashed #D8CCBA; margin: 18px auto; width: 60%; }
.nightMode.card, .night_mode .card { color: #EDE6DB; background: #22201D; }
.nightMode .ctx, .night_mode .ctx { color: #C9BFB2; }
.nightMode .ctx b, .night_mode .ctx b { background: rgba(232,146,96,.31); }
.nightMode .meaning, .night_mode .meaning { color: #E3936E; }`;

const TEMPLATES = [
  {
    Name: 'Узнать слово',
    Front: '<div class="word">{{Word}}</div>{{#Sentence}}<div class="ctx">{{Sentence}}</div>{{/Sentence}}{{Audio}}',
    Back: '{{FrontSide}}<hr id="answer"><div class="meaning">{{Meaning}}</div>{{#Lemma}}<div class="lemma">{{Lemma}}</div>{{/Lemma}}{{#Notes}}<div class="notes">{{Notes}}</div>{{/Notes}}',
  },
  {
    Name: 'Вспомнить слово',
    Front: '{{#Reverse}}<div class="meaning">{{Meaning}}</div>{{/Reverse}}',
    Back: '{{FrontSide}}<hr id="answer"><div class="word">{{Word}}</div>{{#Sentence}}<div class="ctx">{{Sentence}}</div>{{/Sentence}}{{Audio}}{{#Notes}}<div class="notes">{{Notes}}</div>{{/Notes}}',
  },
];

async function ensureSetup(lang) {
  const models = await ac('modelNames');
  if (!models.includes(MODEL)) {
    await ac('createModel', { modelName: MODEL, inOrderFields: FIELDS, css: CSS, isCloze: false, cardTemplates: TEMPLATES });
  }
  await ac('createDeck', { deck: deckFor(lang) });
}

const escHtml = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function sentenceHtml(t) {
  const s = escHtml(t.sentence);
  if (!s) return '';
  const i = s.toLowerCase().indexOf(escHtml(t.text).toLowerCase());
  return i < 0 ? s : `${s.slice(0, i)}<b>${s.slice(i, i + escHtml(t.text).length)}</b>${s.slice(i + escHtml(t.text).length)}`;
}

function fieldsOf(t) {
  return {
    Word: escHtml(t.text),
    Meaning: escHtml(t.translation),
    Sentence: sentenceHtml(t),
    Lemma: escHtml(t.lemma && t.lemma.toLowerCase() !== t.text.toLowerCase() ? t.lemma : ''),
    Notes: escHtml(t.notes),
    Reverse: settings.ankiReverse ? 'y' : '',
    ReadrKey: t.key,
  };
}
const hashOf = (f) => JSON.stringify(f);

const ttsUrl = (text, lang) => 'https://translate.googleapis.com/translate_tts?'
  + new URLSearchParams({ client: 'gtx', ie: 'UTF-8', tl: { zh: 'zh-CN', he: 'iw' }[lang] || lang, q: text });

function noteOf(t) {
  const note = {
    deckName: deckFor(t.lang),
    modelName: MODEL,
    fields: fieldsOf(t),
    options: { allowDuplicate: false, duplicateScope: 'deck' },
    tags: ['readr', t.lang],
  };
  // Озвучку Anki скачивает сам и кладёт в карточку.
  if (settings.ankiAudio) {
    const name = `readr-${t.lang}-${t.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 40)}.mp3`;
    note.audio = [{ url: ttsUrl(t.text, t.lang), filename: name, fields: ['Audio'] }];
  }
  return note;
}

export const shouldBeInAnki = (t) => t.status >= 1 && t.status < KNOWN && !!t.translation;

// Добавить одно слово или обновить его карточку.
export async function sendTerm(t) {
  await ensureSetup(t.lang);
  const fields = fieldsOf(t);
  if (t.ankiId) {
    const [info] = await ac('notesInfo', { notes: [t.ankiId] });
    if (info?.noteId) {
      await ac('updateNoteFields', { note: { id: t.ankiId, fields } });
      await patchTerm(t.lang, t.text, { ankiHash: hashOf(fields) });
      return 'updated';
    }
  }
  let id;
  try { id = await ac('addNote', { note: noteOf(t) }); }
  catch (e) {
    if (!/duplicate/i.test(e.message)) throw e;
    // Такая карточка уже есть (например, добавлена с другого устройства) — привязываемся к ней.
    [id] = await ac('findNotes', { query: `"deck:${deckFor(t.lang)}" "ReadrKey:${t.key}"` });
    if (!id) [id] = await ac('findNotes', { query: `"deck:${deckFor(t.lang)}" "Word:${fields.Word}"` });
    if (!id) throw e;
    await ac('updateNoteFields', { note: { id, fields } });
  }
  await patchTerm(t.lang, t.text, { ankiId: id, ankiHash: hashOf(fields) });
  return 'added';
}

// Карточка в Anki знает интервал повторения — переводим его в статус слова.
function statusFromInterval(ivl) {
  if (ivl >= 21) return KNOWN;
  if (ivl >= 10) return 4;
  if (ivl >= 4) return 3;
  if (ivl >= 1) return 2;
  return 1;
}

let running = null;
// Полная синхронизация с Anki: новые слова — туда, правки — туда, прогресс — обратно.
export function syncAnki(lang = settings.lang) {
  if (running) return running;
  running = (async () => {
    await loadLang(lang);
    await ensureSetup(lang);
    const terms = allTerms(lang);
    const res = { added: 0, updated: 0, statuses: 0 };

    // 1. Прогресс из Anki.
    const linked = terms.filter((t) => t.ankiId);
    if (linked.length) {
      const infos = await ac('notesInfo', { notes: linked.map((t) => t.ankiId) });
      const cardIds = infos.flatMap((n) => n?.cards || []);
      const cards = cardIds.length ? await ac('cardsInfo', { cards: cardIds }) : [];
      const byNote = new Map();
      for (const c of cards) if (c.ord === 0 || !byNote.has(c.note)) byNote.set(c.note, c);
      for (let i = 0; i < linked.length; i++) {
        const t = linked[i];
        if (!infos[i]?.noteId) { await patchTerm(lang, t.text, { ankiId: null, ankiHash: null }); continue; }
        const card = byNote.get(t.ankiId);
        if (!settings.ankiStatuses || !card || t.status === IGNORED) continue;
        if (card.queue === 0 && card.type === 0) continue; // ещё не изучалась в Anki
        const st = statusFromInterval(card.interval);
        if (st !== t.status) { await saveTerm(lang, t.text, { status: st }); res.statuses++; }
      }
    }

    // 2. Новые слова и правки — в Anki (одним пакетом).
    const fresh = allTerms(lang);
    const toAdd = fresh.filter((t) => shouldBeInAnki(t) && !t.ankiId);
    const toUpdate = fresh.filter((t) => t.ankiId && t.ankiHash !== hashOf(fieldsOf(t)));
    if (toAdd.length) {
      const out = await ac('multi', { actions: toAdd.map((t) => ({ action: 'addNote', version: 6, params: { note: noteOf(t) } })) });
      for (let i = 0; i < toAdd.length; i++) {
        const r = out[i];
        const id = r && typeof r === 'object' && 'result' in r ? r.result : r;
        if (typeof id === 'number') { await patchTerm(lang, toAdd[i].text, { ankiId: id, ankiHash: hashOf(fieldsOf(toAdd[i])) }); res.added++; }
        else {
          // Дубликат — найдём существующую карточку и привяжемся.
          try { if (await sendTerm(toAdd[i])) res.added++; } catch { /* слово пропускаем */ }
        }
      }
    }
    for (const t of toUpdate) {
      try { await ac('updateNoteFields', { note: { id: t.ankiId, fields: fieldsOf(t) } }); await patchTerm(lang, t.text, { ankiHash: hashOf(fieldsOf(t)) }); res.updated++; }
      catch { /* карточку удалили в Anki — привязку снимем при следующей синхронизации */ }
    }
    await saveSettings({ ankiLast: Date.now(), ankiError: '' });
    return res;
  })()
    .catch(async (e) => { await saveSettings({ ankiError: e.message }); throw e; })
    .finally(() => { running = null; document.dispatchEvent(new Event('anki-state')); });
  return running;
}

// ---------- AnkiMobile (iPhone) ----------
export function ankiMobileUrl(t) {
  const f = fieldsOf(t);
  const p = new URLSearchParams();
  if (settings.ankiMobileBasic) {
    p.set('type', 'Basic');
    p.set('fldFront', [f.Word, f.Sentence].filter(Boolean).join('<br><br>'));
    p.set('fldBack', [f.Meaning, f.Lemma, f.Notes].filter(Boolean).join('<br>'));
  } else {
    p.set('type', MODEL);
    for (const [k, v] of Object.entries(f)) p.set('fld' + k, v);
  }
  p.set('deck', deckFor(t.lang));
  p.set('tags', `readr ${t.lang}`);
  return 'anki://x-callback-url/addnote?' + p.toString().replace(/\+/g, '%20');
}
