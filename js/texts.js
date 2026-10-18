import { db, changed } from './db.js';
import { uid } from './util.js';
import { settings } from './state.js';
import { wordKeys } from './tokenize.js';

const TINTS = ['sky', 'peach', 'sage', 'lilac', 'butter', 'rose'];

// Делим абзацы на страницы примерно по N слов. Длинный абзац не режем — он займёт страницу целиком.
// Глава (крупный заголовок) начинается с новой страницы, а заголовок не остаётся последним на странице.
export function paginate(paraWordCounts, perPage, kinds = []) {
  const starts = [0];
  let acc = 0;
  paraWordCounts.forEach((n, i) => {
    const k = kinds[i];
    const chapter = (k === 'h1' || k === 'h2') && acc > perPage * 0.3;
    const overflow = acc > 0 && acc + n > perPage * 1.15;
    if (chapter || overflow) {
      // Заголовки прямо перед разрывом переносим на новую страницу вместе с текстом.
      let at = i;
      while (!chapter && at - 1 > starts[starts.length - 1] && /^h/.test(kinds[at - 1] || '')) at--;
      starts.push(at);
      acc = 0;
      for (let j = at; j < i; j++) acc += paraWordCounts[j];
    }
    acc += n;
  });
  return starts;
}

export async function createText({ title, blocks, paragraphs, lang, source = 'text', url = '' }) {
  if (blocks) {
    blocks = blocks.filter((b) => b.t && b.t.trim());
    paragraphs = blocks.map((b) => b.t.trim());
  }
  if (!paragraphs?.length) throw new Error('В файле не нашлось текста');
  const kinds = blocks && blocks.some((b) => b.k !== 'p') ? blocks.map((b) => b.k) : null;
  const id = uid();
  const counts = [];
  const vocab = new Set();
  let words = 0;
  for (const p of paragraphs) {
    const keys = wordKeys(p, lang);
    counts.push(keys.length);
    words += keys.length;
    keys.forEach((k) => vocab.add(k));
  }
  const pages = paginate(counts, settings.wordsPerPage, kinds || []);
  const meta = {
    id, title: title.trim() || 'Без названия', lang, source, url,
    words, unique: vocab.size, pagesTotal: pages.length,
    page: 0, maxPage: 0, finished: false,
    tint: TINTS[Math.floor(Math.random() * TINTS.length)],
    created: Date.now(), updated: Date.now(), opened: 0,
    preview: paragraphs.join(' ').slice(0, 220),
  };
  await db.put('bodies', { id, paragraphs, kinds, counts, pages, vocab: [...vocab] });
  await db.put('texts', meta);
  changed();
  return meta;
}

export const getText = (id) => db.get('texts', id);
export const getBody = (id) => db.get('bodies', id);
export const updateText = async (id, patch) => {
  const t = await db.get('texts', id);
  if (!t) return;
  Object.assign(t, patch, { updated: Date.now() });
  await db.put('texts', t);
  changed();
  return t;
};
export async function deleteText(id) {
  await db.del('texts', id);
  await db.del('bodies', id);
  await db.tomb('texts', id);
  changed();
}
export const listTexts = () => db.all('texts');

// Пересобрать страницы, если поменяли размер страницы в настройках.
export async function repaginate(id) {
  const body = await getBody(id);
  const pages = paginate(body.counts, settings.wordsPerPage, body.kinds || []);
  body.pages = pages;
  await db.put('bodies', body);
  const t = await getText(id);
  t.pagesTotal = pages.length;
  t.page = Math.min(t.page, pages.length - 1);
  await db.put('texts', t);
  return body;
}
