import { $, $$, esc, icon, html, modal, toast, fmt, plural, confirmDialog } from './util.js';
import { settings, saveSettings } from './state.js';
import { langName, langOptions } from './langs.js';
import { listTexts, createText, deleteText, getBody, updateText } from './texts.js';
import { loadLang, statusOf, counts } from './terms.js';
import { importFile, importImages, importUrl, importPlain, ACCEPT } from './importers.js';
import { SAMPLES } from './sample.js';
import { db } from './db.js';
import { aiFor, cleanBlocks } from './llm.js';

const SOURCE_LABEL = {
  text: 'Текст', pdf: 'PDF', scan: 'Скан PDF', epub: 'EPUB', fb2: 'FB2', docx: 'Word',
  photo: 'Фото', web: 'Статья', subs: 'Субтитры',
};

export async function renderLibrary(view) {
  const lang = settings.lang;
  await loadLang(lang);
  await ensureSample(lang);
  const texts = (await listTexts()).filter((t) => t.lang === lang)
    .sort((a, b) => (b.opened || b.created) - (a.opened || a.created));
  const c = counts(lang);
  const current = texts.find((t) => t.opened && !t.finished);

  view.innerHTML = `
    <section class="page library">
      <header class="lib-head">
        <div>
          <h1>Библиотека</h1>
          <p class="sub">
            <label class="lang-pick">Изучаю
              <select id="lib-lang" aria-label="Язык изучения">${langOptions(lang, { exclude: settings.native })}</select>
            </label>
            <span class="stat-chip known">${fmt(c.known)} ${plural(c.known, 'слово знаю', 'слова знаю', 'слов знаю')}</span>
            <span class="stat-chip learning">${fmt(c.learning)} изучаю</span>
          </p>
        </div>
        <button class="btn primary" id="add-btn">${icon('plus')}<span>Добавить</span></button>
      </header>

      ${current ? continueCard(current) : ''}

      <div class="shelf" id="shelf">
        ${texts.map(bookCard).join('')}
        <button class="book add-book" id="add-tile">
          <span class="cover">${icon('plus')}<span>Текст, PDF, книга или фото</span></span>
        </button>
      </div>
      ${texts.length ? '' : `<p class="empty-note">Здесь пока пусто. Вставьте текст, загрузите файл или сфотографируйте страницу книги — язык: ${esc(langName(lang).toLowerCase())}.</p>`}
      <div class="drop-hint" id="drop-hint">Отпустите файл, чтобы добавить его</div>
    </section>`;

  $('#lib-lang', view).onchange = async (e) => { await saveSettings({ lang: e.target.value }); renderLibrary(view); };
  $('#add-btn', view).onclick = () => openAddDialog();
  $('#add-tile', view).onclick = () => openAddDialog();
  $$('.book[data-id]', view).forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-menu]')) { e.stopPropagation(); bookMenu(el.dataset.id, view); return; }
      location.hash = '#/read/' + el.dataset.id;
    });
  });
  $('[data-continue]', view)?.addEventListener('click', (e) => { location.hash = '#/read/' + e.currentTarget.dataset.continue; });

  setupDrop(view);
  fillNewWordShare(view, texts, lang);
}

function progressOf(t) {
  if (t.finished) return 100;
  return t.pagesTotal > 1 ? Math.round((t.maxPage / (t.pagesTotal - 1)) * 100) : (t.maxPage ? 100 : 0);
}

function continueCard(t) {
  const pct = progressOf(t);
  return `
    <button class="continue tint-${t.tint}" data-continue="${t.id}">
      <span class="continue-label">Продолжить чтение</span>
      <span class="continue-title">${esc(t.title)}</span>
      <span class="continue-meta">Страница ${t.page + 1} из ${t.pagesTotal}</span>
      <span class="bar"><i style="width:${pct}%"></i></span>
    </button>`;
}

function bookCard(t) {
  const pct = progressOf(t);
  return `
    <article class="book" data-id="${t.id}" tabindex="0" role="link" aria-label="${esc(t.title)}">
      <div class="cover tint-${t.tint}">
        <span class="cover-src">${SOURCE_LABEL[t.source] || 'Текст'}</span>
        <span class="cover-title">${esc(t.title)}</span>
        ${pct ? `<span class="cover-bar"><i style="width:${pct}%"></i></span>` : ''}
      </div>
      <div class="book-meta">
        <span>${fmt(t.words)} ${plural(t.words, 'слово', 'слова', 'слов')}</span>
        <span class="new-share" data-new="${t.id}"></span>
        <button class="icon-btn small" data-menu aria-label="Действия с текстом">${icon('dots')}</button>
      </div>
    </article>`;
}

// Доля незнакомых слов — как в LingQ, помогает выбрать текст по силам.
async function fillNewWordShare(view, texts, lang) {
  for (const t of texts) {
    const el = $(`[data-new="${t.id}"]`, view);
    if (!el) continue;
    const body = await getBody(t.id);
    if (!body?.vocab?.length) continue;
    const unknown = body.vocab.filter((k) => statusOf(lang, k) === 0).length;
    const pct = Math.round((unknown / body.vocab.length) * 100);
    el.textContent = `${pct}% новых`;
    el.classList.toggle('hard', pct > 25);
  }
}

async function ensureSample(lang) {
  const key = 'sample-' + lang;
  if (await db.kvGet(key, false)) return;
  await db.kvSet(key, true);
  const s = SAMPLES[lang];
  if (s) await createText({ ...s, lang, source: 'text' });
}

function bookMenu(id, view) {
  const m = modal({
    title: 'Текст',
    body: `
      <div class="menu-list">
        <button class="menu-item" data-act="rename">Переименовать</button>
        <button class="menu-item" data-act="restart">Начать сначала</button>
        <button class="menu-item danger" data-act="delete">${icon('trash')} Удалить из библиотеки</button>
      </div>`,
  });
  m.body.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'delete') {
      m.close();
      if (await confirmDialog('Удалить текст? Слова в словаре останутся.')) {
        await deleteText(id);
        toast('Текст удалён');
        renderLibrary(view);
      }
    } else if (act === 'restart') {
      await updateText(id, { page: 0, finished: false });
      m.close();
      renderLibrary(view);
    } else if (act === 'rename') {
      const t = (await listTexts()).find((x) => x.id === id);
      m.body.innerHTML = `
        <form class="stack" id="rename-form">
          <input class="input" name="title" value="${esc(t.title)}" aria-label="Название">
          <div class="row end"><button class="btn primary">Сохранить</button></div>
        </form>`;
      const f = $('#rename-form', m.body);
      f.title.focus();
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        await updateText(id, { title: f.title.value.trim() || t.title });
        m.close();
        renderLibrary(view);
      };
    }
  };
}

function setupDrop(view) {
  const hint = $('#drop-hint', view);
  let depth = 0;
  view.ondragenter = (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; hint.classList.add('on'); } };
  view.ondragleave = () => { if (--depth <= 0) { depth = 0; hint.classList.remove('on'); } };
  view.ondragover = (e) => e.preventDefault();
  view.ondrop = (e) => {
    e.preventDefault();
    depth = 0;
    hint.classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) openAddDialog({ files });
  };
}

// ---------- Окно «Добавить» ----------
export function openAddDialog({ files, tab } = {}) {
  const m = modal({
    title: 'Добавить в библиотеку',
    wide: true,
    body: `
      <div class="seg" role="tablist">
        <button role="tab" data-tab="paste">${icon('paste')}<span>Вставить</span></button>
        <button role="tab" data-tab="file">${icon('file')}<span>Файл</span></button>
        <button role="tab" data-tab="photo">${icon('camera')}<span>Фото</span></button>
        <button role="tab" data-tab="url">${icon('link')}<span>Ссылка</span></button>
      </div>
      <label class="field inline">Язык текста
        <select class="input" id="add-lang">${langOptions(settings.lang, { exclude: settings.native })}</select>
      </label>

      <div class="tab" data-pane="paste">
        <input class="input" id="paste-title" placeholder="Название (необязательно)">
        <textarea class="input area" id="paste-text" placeholder="Вставьте текст статьи, главы, песни или диалога"></textarea>
        <div class="row end"><button class="btn primary" id="paste-go">Добавить текст</button></div>
      </div>

      <div class="tab" data-pane="file">
        <label class="dropzone">
          <input type="file" id="file-input" accept="${ACCEPT}" hidden>
          ${icon('upload', 'big')}
          <strong>Выберите файл</strong>
          <span>PDF, EPUB, FB2, DOCX, TXT, Markdown, субтитры SRT/VTT, HTML или картинка. Сканы PDF распознаются автоматически.</span>
        </label>
      </div>

      <div class="tab" data-pane="photo">
        <div class="photo-btns">
          <label class="dropzone half">
            <input type="file" id="cam-input" accept="image/*" capture="environment" hidden>
            ${icon('camera', 'big')}<strong>Сфотографировать</strong><span>Страницу книги, меню, вывеску</span>
          </label>
          <label class="dropzone half">
            <input type="file" id="gallery-input" accept="image/*" multiple hidden>
            ${icon('file', 'big')}<strong>Из галереи</strong><span>Можно несколько страниц сразу — склеятся по порядку</span>
          </label>
        </div>
        <p class="hint">Текст распознаётся прямо на устройстве. Первый раз скачивается языковой пакет, дальше работает быстрее.</p>
      </div>

      <div class="tab" data-pane="url">
        <form class="stack" id="url-form">
          <input class="input" id="url-input" type="url" inputmode="url" placeholder="https://… статья, блог, новость" required>
          <div class="row end"><button class="btn primary">Загрузить статью</button></div>
        </form>
        <p class="hint">Текст страницы извлекается через бесплатный сервис r.jina.ai.</p>
      </div>

      <div class="progress" id="add-progress" hidden>
        <span class="progress-text">Обрабатываю…</span>
        <span class="bar"><i></i></span>
      </div>`,
  });
  const b = m.body;
  const setTab = (name) => {
    $$('[data-tab]', b).forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === name));
    $$('[data-pane]', b).forEach((p) => { p.hidden = p.dataset.pane !== name; });
  };
  $$('[data-tab]', b).forEach((t) => { t.onclick = () => setTab(t.dataset.tab); });
  setTab(tab || 'paste');

  const lang = () => $('#add-lang', b).value;
  const prog = $('#add-progress', b);
  const onProgress = (text, frac) => {
    prog.hidden = false;
    $('.progress-text', prog).textContent = text;
    $('i', prog).style.width = Math.round((frac || 0) * 100) + '%';
  };
  let busy = false;
  const run = async (job) => {
    if (busy) return;
    busy = true;
    b.classList.add('busy');
    onProgress('Обрабатываю…', 0.05);
    try {
      const data = await job();
      if (!data.blocks?.length) throw new Error('Текст не найден. Попробуйте другой файл или фото почётче.');
      if ((data.source === 'photo' || data.source === 'scan') && aiFor('aiOcr')) {
        try { data.blocks = await cleanBlocks(data.blocks, lang(), onProgress); }
        catch (e) { toast('ИИ не смог исправить текст: ' + e.message, 'error'); }
      }
      onProgress('Сохраняю…', 1);
      const t = await createText({ ...data, lang: lang() });
      m.close();
      toast(`Добавлено: ${t.title}`);
      location.hash = '#/read/' + t.id;
    } catch (e) {
      console.error(e);
      prog.hidden = true;
      toast(e.message || 'Не получилось добавить', 'error');
    } finally {
      busy = false;
      b.classList.remove('busy');
    }
  };

  $('#paste-go', b).onclick = () => {
    const text = $('#paste-text', b).value;
    if (!text.trim()) { $('#paste-text', b).focus(); return; }
    run(async () => importPlain(text, $('#paste-title', b).value.trim()));
  };
  $('#file-input', b).onchange = (e) => {
    const f = e.target.files[0];
    if (f) run(() => importFile(f, { lang: lang(), onProgress }));
  };
  const photos = (e) => {
    const fs = [...e.target.files];
    if (fs.length) run(() => importImages(fs, { lang: lang(), onProgress }));
  };
  $('#cam-input', b).onchange = photos;
  $('#gallery-input', b).onchange = photos;
  $('#url-form', b).onsubmit = (e) => {
    e.preventDefault();
    run(() => importUrl($('#url-input', b).value.trim()));
  };

  if (files?.length) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === files.length && images.length > 1) {
      setTab('photo');
      run(() => importImages(images, { lang: lang(), onProgress }));
    } else {
      setTab('file');
      run(() => importFile(files[0], { lang: lang(), onProgress }));
    }
  }
}
