import { $, $$, esc, icon, modal, toast, download, fmt, debounce, today } from './util.js';
import { wordKeys } from './tokenize.js';
import { settings } from './state.js';
import { langName } from './langs.js';
import { loadLang, allTerms, saveTerm, deleteTerm, STATUS_LABEL, KNOWN, IGNORED, counts } from './terms.js';
import { speak, ttsAvailable } from './tts.js';

const FILTERS = [
  ['learning', 'Изучаю'],
  ['phrases', 'Фразы'],
  ['known', 'Знаю'],
  ['ignored', 'Игнор'],
  ['all', 'Все'],
];

const statusClass = (s) => (s === IGNORED ? 'si' : s >= KNOWN ? 's5' : 's' + s);

export async function renderWords(view) {
  const lang = settings.lang;
  await loadLang(lang);
  let filter = 'learning';
  let query = '';
  let sort = 'recent';
  let limit = 150;

  const c = counts(lang);
  view.innerHTML = `
    <section class="page words">
      <header class="page-head">
        <div>
          <h1>Словарь</h1>
          <p class="sub">${esc(langName(lang))}: ${fmt(c.learning)} изучаю, ${fmt(c.known)} знаю</p>
        </div>
        <div class="row gap">
          <button class="btn ghost" id="import-btn">${icon('upload')}<span>Импорт</span></button>
          <button class="btn ghost" id="export-btn">${icon('download')}<span>Экспорт</span></button>
        </div>
      </header>
      <div class="toolbar">
        <label class="search">${icon('search')}<input class="input" id="q" type="search" placeholder="Найти слово или перевод"></label>
        <div class="seg small" id="filters">${FILTERS.map(([v, n]) => `<button data-f="${v}" aria-selected="${v === filter}">${n}</button>`).join('')}</div>
        <select class="input small" id="sort" aria-label="Сортировка">
          <option value="recent">Сначала новые</option>
          <option value="alpha">По алфавиту</option>
          <option value="status">По статусу</option>
        </select>
      </div>
      <ul class="term-list" id="list"></ul>
      <div class="row center"><button class="btn ghost" id="more" hidden>Показать ещё</button></div>
    </section>`;

  const list = $('#list', view);

  function filtered() {
    const q = query.toLowerCase();
    let rows = allTerms(lang).filter((t) => {
      if (filter === 'learning' && !(t.status >= 1 && t.status < KNOWN)) return false;
      if (filter === 'known' && t.status !== KNOWN) return false;
      if (filter === 'ignored' && t.status !== IGNORED) return false;
      if (filter === 'phrases' && !(t.words?.length > 1)) return false;
      if (q && !t.text.toLowerCase().includes(q) && !(t.translation || '').toLowerCase().includes(q)) return false;
      return true;
    });
    if (sort === 'alpha') rows.sort((a, b) => a.text.localeCompare(b.text, lang));
    else if (sort === 'status') rows.sort((a, b) => a.status - b.status || b.updated - a.updated);
    else rows.sort((a, b) => b.updated - a.updated);
    return rows;
  }

  function draw() {
    const rows = filtered();
    if (!rows.length) {
      list.innerHTML = `<li class="empty-note">${query ? 'Ничего не нашлось.' : filter === 'learning'
        ? 'Пока пусто. Откройте текст в библиотеке и нажимайте на незнакомые слова — они появятся здесь.'
        : 'В этом разделе пока нет слов.'}</li>`;
      $('#more', view).hidden = true;
      return;
    }
    list.innerHTML = rows.slice(0, limit).map((t) => `
      <li class="term" data-text="${esc(t.text)}">
        <button class="pill ${statusClass(t.status)}" data-cycle title="${esc(STATUS_LABEL[t.status])}. Нажмите, чтобы повысить">${t.status === KNOWN ? icon('check') : t.status === IGNORED ? '–' : t.status}</button>
        <div class="term-main">
          <span class="term-text" lang="${esc(lang)}">${esc(t.text)}</span>
          <span class="term-tr">${esc(t.translation || '')}</span>
          ${t.sentence ? `<span class="term-ctx" lang="${esc(lang)}">${esc(t.sentence)}</span>` : ''}
        </div>
        ${ttsAvailable ? `<button class="icon-btn small" data-say aria-label="Произнести">${icon('sound')}</button>` : ''}
      </li>`).join('');
    $('#more', view).hidden = rows.length <= limit;
  }

  $('#q', view).addEventListener('input', debounce((e) => { query = e.target.value.trim(); limit = 150; draw(); }, 200));
  $('#filters', view).onclick = (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    filter = b.dataset.f;
    limit = 150;
    $$('[data-f]', view).forEach((x) => x.setAttribute('aria-selected', x === b));
    draw();
  };
  $('#sort', view).onchange = (e) => { sort = e.target.value; draw(); };
  $('#more', view).onclick = () => { limit += 300; draw(); };
  list.onclick = async (e) => {
    const li = e.target.closest('.term');
    if (!li) return;
    const text = li.dataset.text;
    if (e.target.closest('[data-say]')) { speak(text, lang); return; }
    if (e.target.closest('[data-cycle]')) {
      const t = allTerms(lang).find((x) => x.text === text);
      const next = t.status === IGNORED ? 1 : t.status >= KNOWN ? 1 : t.status + 1;
      await saveTerm(lang, text, { status: next });
      draw();
      return;
    }
    editTerm(lang, text, draw);
  };
  $('#export-btn', view).onclick = () => exportDialog(lang);
  $('#import-btn', view).onclick = () => importDialog(lang, draw);
  draw();
}

function editTerm(lang, text, onDone) {
  const t = allTerms(lang).find((x) => x.text === text);
  if (!t) return;
  const m = modal({
    title: t.text,
    body: `
      <form class="stack" id="edit-form">
        <label class="field">Перевод<textarea class="input" name="translation" rows="2">${esc(t.translation)}</textarea></label>
        <label class="field">Заметка<textarea class="input" name="notes" rows="2">${esc(t.notes || '')}</textarea></label>
        ${t.sentence ? `<p class="term-ctx" lang="${esc(lang)}">${esc(t.sentence)}</p>` : ''}
        <div class="wp-status">
          ${[1, 2, 3, 4].map((n) => `<button type="button" class="st st${n} ${t.status === n ? 'on' : ''}" data-st="${n}">${n}</button>`).join('')}
          <button type="button" class="st st5 ${t.status === KNOWN ? 'on' : ''}" data-st="5">${icon('check')}<span>Знаю</span></button>
          <button type="button" class="st sti ${t.status === IGNORED ? 'on' : ''}" data-st="-1">Игнор</button>
        </div>
        <div class="row between">
          <button type="button" class="btn ghost danger" data-del>${icon('trash')}<span>Удалить</span></button>
          <button class="btn primary">Сохранить</button>
        </div>
      </form>`,
  });
  const f = $('#edit-form', m.body);
  let status = t.status;
  f.onclick = async (e) => {
    const st = e.target.closest('[data-st]');
    if (st) {
      status = +st.dataset.st;
      $$('[data-st]', f).forEach((b) => b.classList.toggle('on', b === st));
    }
    if (e.target.closest('[data-del]')) {
      await deleteTerm(lang, t.text);
      m.close();
      toast('Удалено');
      onDone();
    }
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    await saveTerm(lang, t.text, { translation: f.translation.value.trim(), notes: f.notes.value.trim(), status });
    m.close();
    onDone();
  };
}

const csvCell = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;

function exportDialog(lang) {
  const m = modal({
    title: 'Экспорт словаря',
    body: `
      <div class="menu-list">
        <button class="menu-item" data-x="csv"><strong>Таблица CSV</strong><span>Откроется в Excel или Google Таблицах</span></button>
        <button class="menu-item" data-x="anki"><strong>Для Anki</strong><span>Файл с карточками: слово, перевод, пример. Только слова, которые изучаете</span></button>
      </div>`,
  });
  m.body.onclick = (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (!x) return;
    const terms = allTerms(lang);
    if (x === 'csv') {
      const rows = [['term', 'translation', 'status', 'notes', 'sentence'].join(',')]
        .concat(terms.map((t) => [t.text, t.translation, t.status, t.notes, t.sentence].map(csvCell).join(',')));
      download(`readr-${lang}-${today()}.csv`, '﻿' + rows.join('\n'), 'text/csv');
    } else {
      const rows = terms.filter((t) => t.status >= 1 && t.status < KNOWN && t.translation)
        .map((t) => [t.text, t.translation, (t.sentence || '').replace(esc(t.text), `<b>${esc(t.text)}</b>`)].map((s) => String(s).replace(/[\t\n]/g, ' ')).join('\t'));
      download(`readr-anki-${lang}-${today()}.txt`, '#separator:tab\n#html:true\n' + rows.join('\n'), 'text/plain');
    }
    m.close();
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function importDialog(lang, onDone) {
  const m = modal({
    title: 'Импорт слов',
    body: `
      <p class="hint">Файл CSV или TXT: в первой колонке слово, во второй перевод, в третьей (необязательно) статус 1–5. Подойдёт экспорт из LingQ, Lute или Anki.</p>
      <label class="dropzone">
        <input type="file" accept=".csv,.txt,.tsv" hidden id="imp-file">
        ${icon('upload', 'big')}<strong>Выбрать файл</strong>
      </label>`,
  });
  $('#imp-file', m.body).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const rows = parseCsv((await f.text()).replace(/^﻿/, ''));
    let n = 0;
    for (const r of rows) {
      const [term, tr, st] = r.map((c) => c.trim());
      if (!term || term.startsWith('#') || /^(term|word|слово)$/i.test(term)) continue;
      const status = Math.min(5, Math.max(1, parseInt(st, 10) || 1));
      const keys = wordKeys(term, lang);
      const words = keys.length > 1 ? keys : undefined;
      await saveTerm(lang, term, { translation: tr || '', status, ...(words ? { words } : {}) });
      n++;
    }
    m.close();
    toast(`Импортировано слов: ${n}`);
    onDone();
  };
}
