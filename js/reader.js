import { $, $$, esc, icon, modal, toast, debounce, fmt, plural, isNarrow } from './util.js';
import { settings, saveSettings, bump } from './state.js';
import { applyAppearance } from './appearance.js';
import { getText, getBody, updateText } from './texts.js';
import { tokenize, sentences, normKey } from './tokenize.js';
import {
  loadLang, getTerm, statusOf, phrasesStartingWith, saveTerm, deleteTerm, markKnown,
  STATUS_LABEL, KNOWN, IGNORED,
} from './terms.js';
import { lookup, translateText, POS_RU } from './translate.js';
import { aiFor, wordInContext } from './llm.js';
import { isIOS, sendTerm, ankiMobileUrl } from './anki.js';
import { speak, speakSequence, stopSpeech, ttsAvailable } from './tts.js';

const REVERSO = {
  en: 'english', de: 'german', fr: 'french', es: 'spanish', it: 'italian', pt: 'portuguese', nl: 'dutch',
  pl: 'polish', ru: 'russian', ja: 'japanese', zh: 'chinese', tr: 'turkish', uk: 'ukrainian', he: 'hebrew',
  ar: 'arabic', sv: 'swedish',
};

const cls = (st) => (st === IGNORED ? 'si' : st >= KNOWN ? 's5' : st >= 1 ? 's' + st : 's0');

export async function renderReader(view, id) {
  const meta = await getText(id);
  if (!meta) {
    view.innerHTML = `<section class="page"><h1>Текст не найден</h1><p><a class="btn" href="#/library">В библиотеку</a></p></section>`;
    return;
  }
  const body = await getBody(id);
  const lang = meta.lang;
  await loadLang(lang);
  let page = Math.min(meta.page || 0, body.pages.length - 1);
  let sel = null;          // { p, a, b } — абзац и индексы первого/последнего слова
  let lookupToken = 0;
  let observer = null;
  let speaking = false;
  await updateText(id, { opened: Date.now() });

  view.innerHTML = `
    <section class="reader ${settings.parallel ? 'parallel' : ''}" id="reader">
      <header class="reader-bar">
        <a class="icon-btn" href="#/library" aria-label="В библиотеку">${icon('back')}</a>
        <div class="reader-title"><strong>${esc(meta.title)}</strong><span id="page-label"></span></div>
        <div class="reader-tools">
          ${ttsAvailable ? `<button class="icon-btn" id="tts-btn" title="Слушать страницу">${icon('play')}</button>` : ''}
          <button class="icon-btn toggle" id="par-btn" aria-pressed="${settings.parallel}" title="Параллельный перевод">${icon('columns')}</button>
          <button class="icon-btn" id="type-btn" title="Вид текста">${icon('type')}</button>
        </div>
      </header>
      <div class="reader-body">
        <div class="reader-scroll" id="rscroll">
          <article class="page-text" id="page-text" lang="${esc(lang)}"></article>
          <footer class="page-foot" id="page-foot">
            <button class="btn ghost" id="prev-btn">${icon('back')}<span>Назад</span></button>
            <button class="btn primary" id="next-btn"></button>
          </footer>
          <p class="foot-hint" id="foot-hint"></p>
        </div>
        <aside class="word-panel" id="panel" aria-label="Перевод" hidden></aside>
      </div>
      <div class="page-progress" aria-hidden="true"><i id="page-prog"></i></div>
    </section>`;

  const reader = $('#reader', view);
  const pageText = $('#page-text', view);
  const rscroll = $('#rscroll', view);
  const panel = $('#panel', view);

  // ---------- Отрисовка текста ----------
  function matchPhrase(toks, i) {
    for (const cand of phrasesStartingWith(lang, toks[i].k)) {
      let wi = 1, j = i, ok = true;
      while (wi < cand.words.length) {
        j++;
        if (j >= toks.length) { ok = false; break; }
        if (!toks[j].w) { if (toks[j].t.trim().length > 2) { ok = false; break; } continue; }
        if (toks[j].k !== cand.words[wi]) { ok = false; break; }
        wi++;
      }
      if (ok) return { term: cand, end: j };
    }
    return null;
  }

  const wordSpan = (t, inPh) => `<span class="w ${cls(statusOf(lang, t.k))}${inPh ? ' inph' : ''}" data-k="${esc(t.k)}">${esc(t.t)}</span>`;

  function renderParagraph(text) {
    let out = '';
    for (const s of sentences(text, lang)) {
      const toks = tokenize(s, lang);
      let h = '';
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (!t.w) { h += esc(t.t); continue; }
        const ph = matchPhrase(toks, i);
        if (ph) {
          h += `<span class="ph ${cls(ph.term.status)}" data-ph="${esc(normKey(ph.term.text))}">`;
          for (let j = i; j <= ph.end; j++) h += toks[j].w ? wordSpan(toks[j], true) : esc(toks[j].t);
          h += '</span>';
          i = ph.end;
        } else h += wordSpan(t);
      }
      out += `<span class="sent">${h}</span>`;
    }
    return out;
  }

  const pageRange = () => [body.pages[page], body.pages[page + 1] ?? body.paragraphs.length];

  function renderPage() {
    stopTts();
    closePanel();
    const [start, end] = pageRange();
    const rows = [];
    for (let pi = start; pi < end; pi++) {
      const k = body.kinds?.[pi] || 'p';
      const tag = { h1: 'h2', h2: 'h3', h3: 'h4' }[k] || 'p';
      const p = `<${tag} class="para k-${k}" data-p="${pi}">${renderParagraph(body.paragraphs[pi])}</${tag}>`;
      rows.push(settings.parallel ? `<div class="pair k-${k}">${p}<p class="para-tr k-${k}" data-tr="${pi}"><span class="shimmer"></span></p></div>` : p);
    }
    pageText.innerHTML = rows.join('');
    pageText.classList.remove('finished');
    $('#page-foot', view).hidden = false;
    $('#page-label', view).textContent = body.pages.length > 1 ? `Страница ${page + 1} из ${body.pages.length}` : '';
    $('#page-prog', view).style.width = ((page + 1) / body.pages.length) * 100 + '%';
    $('#prev-btn', view).disabled = page === 0;
    $('#next-btn', view).innerHTML = page < body.pages.length - 1
      ? `<span>Страница прочитана</span>${icon('next')}`
      : `${icon('check')}<span>Текст прочитан</span>`;
    rscroll.scrollTop = 0;
    updateHint();
    if (settings.parallel) observeTranslations();
    updateText(id, { page });
  }

  function rerenderParas() {
    $$('.para', pageText).forEach((el) => { el.innerHTML = renderParagraph(body.paragraphs[+el.dataset.p]); });
    if (sel) markSelection();
    updateHint();
  }

  function updateHint() {
    const n = new Set($$('.w.s0', pageText).map((e) => e.dataset.k)).size;
    $('#foot-hint', view).textContent = settings.autoKnown && n
      ? `${n} ${plural(n, 'новое слово', 'новых слова', 'новых слов')} на странице ${plural(n, 'станет', 'станут', 'станут')} «знакомыми», когда вы её перелистнёте. Нажмите на слово, чтобы его изучать.`
      : '';
  }

  // ---------- Параллельный перевод ----------
  function observeTranslations() {
    observer?.disconnect();
    observer = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { observer.unobserve(en.target); fillTranslation(en.target); }
    }, { root: rscroll, rootMargin: '600px 0px' });
    $$('.para-tr', pageText).forEach((el) => observer.observe(el));
  }

  async function fillTranslation(el) {
    try {
      el.textContent = await translateText(body.paragraphs[+el.dataset.tr], lang);
    } catch {
      el.innerHTML = `<button class="link-btn" data-retry>Перевод не загрузился. Повторить</button>`;
    }
  }

  // ---------- Выделение ----------
  const paraEl = (p) => $(`.para[data-p="${p}"]`, pageText);
  const selEls = () => (sel ? $$('.w', paraEl(sel.p)).slice(sel.a, sel.b + 1) : []);

  function selInfo() {
    const els = selEls();
    if (!els.length) return null;
    const range = document.createRange();
    range.setStartBefore(els[0]);
    range.setEndAfter(els[els.length - 1]);
    const text = range.toString().replace(/\s+/g, ' ').trim();
    const sents = [...new Set(els.map((e) => e.closest('.sent')))];
    return {
      els, text,
      keys: els.map((e) => e.dataset.k),
      isPhrase: els.length > 1,
      sentence: sents.map((s) => s.textContent.trim()).join(' '),
    };
  }

  function markSelection() {
    $$('.sel', pageText).forEach((e) => e.classList.remove('sel', 'sel-first', 'sel-last'));
    const els = selEls();
    els.forEach((e) => e.classList.add('sel'));
    els[0]?.classList.add('sel-first');
    els[els.length - 1]?.classList.add('sel-last');
  }

  function selectRange(elA, elB) {
    const para = elA.closest('.para');
    if (!para || para !== elB.closest('.para')) return;
    const words = $$('.w', para);
    let a = words.indexOf(elA), b = words.indexOf(elB);
    if (a > b) [a, b] = [b, a];
    if (b - a > 9) b = a + 9;
    sel = { p: +para.dataset.p, a, b };
    markSelection();
    openPanel();
  }

  function moveSelection(dir) {
    const all = $$('.para .w', pageText);
    const cur = selEls();
    if (!cur.length) return;
    const idx = all.indexOf(dir > 0 ? cur[cur.length - 1] : cur[0]) + dir;
    if (all[idx]) { selectRange(all[idx], all[idx]); all[idx].scrollIntoView({ block: 'nearest' }); }
  }

  function extend(dir) {
    if (!sel) return;
    const count = $$('.w', paraEl(sel.p)).length;
    if (dir < 0 && sel.a > 0) sel.a--;
    else if (dir > 0 && sel.b < count - 1) sel.b++;
    else return;
    markSelection();
    openPanel();
  }

  function shrink(dir) {
    if (!sel || sel.a === sel.b) return;
    if (dir < 0) sel.a++; else sel.b--;
    markSelection();
    openPanel();
  }

  // Мышью можно протянуть по нескольким словам — получится фраза.
  let drag = null;
  pageText.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const w = e.target.closest('.w');
    drag = w ? { start: w, moved: false } : null;
  });
  pageText.addEventListener('pointerover', (e) => {
    if (!drag) return;
    const w = e.target.closest('.w');
    if (w && w !== drag.start && w.closest('.para') === drag.start.closest('.para')) {
      drag.moved = true;
      const words = $$('.w', w.closest('.para'));
      let a = words.indexOf(drag.start), b = words.indexOf(w);
      if (a > b) [a, b] = [b, a];
      $$('.sel', pageText).forEach((x) => x.classList.remove('sel', 'sel-first', 'sel-last'));
      words.slice(a, b + 1).forEach((x) => x.classList.add('sel'));
    }
  });
  const endDrag = (e) => {
    if (!drag) return;
    if (drag.moved) {
      const w = e.target.closest?.('.w');
      const marked = $$('.sel', pageText);
      if (marked.length > 1) selectRange(marked[0], marked[marked.length - 1]);
      else if (w) selectRange(drag.start, w);
      drag.suppressClick = true;
      setTimeout(() => { drag = null; }, 0);
    } else drag = null;
  };
  pageText.addEventListener('pointerup', endDrag);

  pageText.addEventListener('click', (e) => {
    if (drag?.suppressClick) return;
    if (e.target.closest('[data-retry]')) { const tr = e.target.closest('.para-tr'); tr.innerHTML = '<span class="shimmer"></span>'; fillTranslation(tr); return; }
    if (e.target.closest('[data-finish]')) return;
    const w = e.target.closest('.w');
    if (!w) { if (!e.target.closest('.para-tr')) closePanel(); return; }
    if (e.shiftKey && sel) { selectRange(selEls()[0], w); return; }
    const ph = w.closest('.ph');
    if (ph && !(sel && selEls().length === 1 && selEls()[0] === w)) {
      const ws = $$('.w', ph);
      selectRange(ws[0], ws[ws.length - 1]);
    } else selectRange(w, w);
  });

  // ---------- Панель перевода ----------
  function closePanel() {
    sel = null;
    lookupToken++;
    markSelection();
    panel.hidden = true;
    reader.classList.remove('panel-open');
  }

  function linksFor(text) {
    const q = encodeURIComponent(text);
    const rv = REVERSO[lang] && REVERSO[settings.native] ? `https://context.reverso.net/translation/${REVERSO[lang]}-${REVERSO[settings.native]}/${q}` : '';
    return [
      ['Google Переводчик', `https://translate.google.com/?sl=${lang}&tl=${settings.native}&text=${q}&op=translate`],
      rv && ['Reverso Context', rv],
      ['Викисловарь', `https://${lang === 'en' ? 'en' : 'ru'}.wiktionary.org/wiki/${encodeURIComponent(text.toLowerCase())}`],
      ['Картинки', `https://www.google.com/search?tbm=isch&q=${q}`],
    ].filter(Boolean);
  }

  function markInSentence(sentence, text) {
    const i = sentence.toLowerCase().indexOf(text.toLowerCase());
    if (i < 0) return esc(sentence);
    return esc(sentence.slice(0, i)) + '<mark>' + esc(sentence.slice(i, i + text.length)) + '</mark>' + esc(sentence.slice(i + text.length));
  }

  function openPanel() {
    const info = selInfo();
    if (!info) return;
    const term = getTerm(lang, info.text);
    const status = term?.status ?? 0;
    const token = ++lookupToken;
    panel.hidden = false;
    reader.classList.add('panel-open');
    panel.innerHTML = `
      <div class="sheet-grip" aria-hidden="true"></div>
      <header class="wp-head">
        <div class="wp-word ${info.isPhrase ? 'is-phrase' : ''}" lang="${esc(lang)}">${esc(info.text)}</div>
        ${ttsAvailable ? `<button class="icon-btn" data-act="speak" title="Произнести (P)">${icon('sound')}</button>` : ''}
        <button class="icon-btn" data-act="close" title="Закрыть (Esc)">${icon('close')}</button>
      </header>
      <p class="wp-state st-text-${status}">${status === 0 ? (info.isPhrase ? 'Новая фраза' : 'Новое слово') : STATUS_LABEL[status]}</p>
      <div class="wp-status" role="group" aria-label="Насколько хорошо знаю">
        ${[1, 2, 3, 4].map((n) => `<button class="st st${n} ${status === n ? 'on' : ''}" data-st="${n}" title="${STATUS_LABEL[n]} (${n})">${n}</button>`).join('')}
        <button class="st st5 ${status === KNOWN ? 'on' : ''}" data-st="5" title="Знаю (5)">${icon('check')}<span>Знаю</span></button>
        <button class="st sti ${status === IGNORED ? 'on' : ''}" data-st="-1" title="Не изучать (I)">Игнор</button>
      </div>
      <label class="wp-label" for="wp-tr">Мой перевод</label>
      <textarea id="wp-tr" class="input wp-tr" rows="2" placeholder="Нажмите на вариант ниже или впишите свой">${esc(term?.translation || '')}</textarea>
      ${aiFor('aiWords') ? '<div class="wp-ai" id="wp-ai"><span class="ai-label">ИИ: по смыслу здесь</span><span class="shimmer"></span></div>' : ''}
      <div class="wp-sugg" id="wp-sugg"><span class="shimmer"></span><span class="shimmer short"></span></div>
      <section class="wp-ctx">
        <p class="ctx-src" lang="${esc(lang)}">${markInSentence(info.sentence, info.text)}</p>
        <p class="ctx-tr" id="ctx-tr" hidden></p>
        <button class="link-btn" data-act="sent">${icon('translate')}<span>Перевести предложение</span></button>
      </section>
      <div class="wp-extend">
        ${info.isPhrase
          ? `<div class="chips">${info.els.map((e, i) => `<button class="chip ${cls(statusOf(lang, e.dataset.k))}" data-word="${i}">${esc(e.textContent)}</button>`).join('')}</div>
             <div class="row gap"><button class="btn small ghost" data-act="shrink-l">− слева</button><button class="btn small ghost" data-act="shrink-r">− справа</button><button class="btn small ghost" data-act="ext-r">+ слово</button></div>`
          : `<span class="muted">Фраза:</span><button class="btn small ghost" data-act="ext-l">+ слово слева</button><button class="btn small ghost" data-act="ext-r">+ слово справа</button>`}
      </div>
      <details class="wp-notes" ${term?.notes ? 'open' : ''}>
        <summary>Заметка</summary>
        <textarea id="wp-note" class="input" rows="2" placeholder="Пример, грамматика, ассоциация">${esc(term?.notes || '')}</textarea>
      </details>
      <div class="wp-anki" id="wp-anki"></div>
      <nav class="wp-links">${linksFor(info.text).map(([n, u]) => `<a href="${u}" target="_blank" rel="noopener">${esc(n)}${icon('external')}</a>`).join('')}</nav>
      ${term ? `<button class="link-btn danger" data-act="del">${icon('trash')}<span>Удалить из словаря</span></button>` : ''}`;

    if (status === 0) bump('lookups');
    let mainSuggestion = '';
    let aiMeaning = '';
    let aiLemma = '';
    if (aiFor('aiWords')) {
      wordInContext(info.text, info.sentence, lang).then((r) => {
        if (token !== lookupToken) return;
        aiMeaning = r.meaning;
        aiLemma = r.lemma;
        if (aiMeaning) mainSuggestion = aiMeaning;
        const lemma = r.lemma && r.lemma.toLowerCase() !== info.text.toLowerCase() ? r.lemma : '';
        $('#wp-ai', panel).innerHTML = `
          <span class="ai-label">ИИ: по смыслу здесь</span>
          <div class="pos-group">
            <button class="chip main" data-sugg="${esc(r.meaning)}">${esc(r.meaning)}</button>
            ${r.pos ? `<span class="pos">${esc(r.pos)}</span>` : ''}
            ${r.alternatives.map((t) => `<button class="chip" data-sugg="${esc(t)}">${esc(t)}</button>`).join('')}
          </div>
          ${lemma ? `<p class="ai-lemma">Словарная форма: <b lang="${esc(lang)}">${esc(lemma)}</b></p>` : ''}
          ${r.note ? `<p class="ai-note">${esc(r.note)}</p>` : ''}`;
      }).catch((e) => {
        if (token !== lookupToken) return;
        $('#wp-ai', panel).innerHTML = `<span class="ai-label">ИИ недоступен</span><p class="muted">${esc(e.message || 'Нет ответа')}</p>`;
      });
    }
    lookup(info.text, lang).then((r) => {
      if (token !== lookupToken) return;
      if (!aiMeaning) mainSuggestion = r.main;
      const mainLc = r.main.toLowerCase();
      const groups = r.variants.slice(0, 4).map((v) => ({ ...v, terms: v.terms.filter((t) => t.toLowerCase() !== mainLc) }))
        .filter((v) => v.terms.length).map((v) => `
        <div class="pos-group">${v.pos ? `<span class="pos">${esc(POS_RU[v.pos] || v.pos)}</span>` : ''}
          ${v.terms.slice(0, 6).map((t) => `<button class="chip" data-sugg="${esc(t)}">${esc(t)}</button>`).join('')}
        </div>`).join('');
      $('#wp-sugg', panel).innerHTML = `<button class="chip main" data-sugg="${esc(r.main)}">${esc(r.main)}</button>${groups}`;
    }).catch(() => {
      if (token !== lookupToken) return;
      $('#wp-sugg', panel).innerHTML = '<p class="muted">Нет связи с переводчиком. Впишите перевод сам или откройте словарь по ссылке ниже.</p>';
    });

    const tr = $('#wp-tr', panel);
    const note = $('#wp-note', panel);
    const current = () => getTerm(lang, info.text)?.status ?? 0;
    const save = (patch) => saveTerm(lang, info.text, {
      ...(aiLemma ? { lemma: aiLemma } : {}),
      sentence: info.sentence,
      ...(info.isPhrase ? { words: info.keys } : {}),
      ...patch,
    });
    const saveTranslation = () => {
      const st = current();
      save({ translation: tr.value.trim(), notes: note.value.trim(), status: st >= 1 ? st : 1 }).then(refreshPanelStatus);
    };
    tr.addEventListener('input', debounce(saveTranslation, 600));
    note.addEventListener('input', debounce(saveTranslation, 600));

    panel.onclick = async (e) => {
      const st = e.target.closest('[data-st]');
      if (st) { await setStatus(+st.dataset.st); return; }
      const sg = e.target.closest('[data-sugg]');
      if (sg) {
        const v = sg.dataset.sugg;
        const parts = tr.value.split(/\s*[,;]\s*/).filter(Boolean);
        if (!parts.some((p) => p.toLowerCase() === v.toLowerCase())) tr.value = parts.concat(v).join(', ');
        saveTranslation();
        return;
      }
      const wd = e.target.closest('[data-word]');
      if (wd) { const el = info.els[+wd.dataset.word]; selectRange(el, el); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') closePanel();
      else if (act === 'speak') speak(info.text, lang);
      else if (act === 'sent') translateSentence();
      else if (act === 'ext-l') extend(-1);
      else if (act === 'ext-r') extend(1);
      else if (act === 'shrink-l') shrink(-1);
      else if (act === 'shrink-r') shrink(1);
      else if (act === 'del') { await deleteTerm(lang, info.text); toast('Удалено из словаря'); openPanel(); }
      else if (act === 'anki') await toAnki(e.target.closest('[data-act]'));
    };

    async function setStatus(n) {
      const patch = { status: n };
      if (n >= 1 && n < KNOWN && !tr.value.trim() && mainSuggestion) { tr.value = mainSuggestion; patch.translation = mainSuggestion; }
      else patch.translation = tr.value.trim();
      await save(patch);
      refreshPanelStatus();
    }
    panel._setStatus = setStatus;

    function refreshPanelStatus() {
      if (token !== lookupToken) return;
      const s = current();
      $$('[data-st]', panel).forEach((b) => b.classList.toggle('on', +b.dataset.st === s));
      const label = $('.wp-state', panel);
      label.className = `wp-state st-text-${s}`;
      label.textContent = s === 0 ? (info.isPhrase ? 'Новая фраза' : 'Новое слово') : STATUS_LABEL[s];
    }

    async function translateSentence() {
      const box = $('#ctx-tr', panel);
      box.hidden = false;
      box.innerHTML = '<span class="shimmer"></span>';
      try { box.textContent = await translateText(info.sentence, lang); }
      catch { box.textContent = 'Нет связи с переводчиком.'; }
    }
    panel._translateSentence = translateSentence;

    // ---- Anki ----
    function drawAnki() {
      const box = $('#wp-anki', panel);
      if (!box) return;
      const t = getTerm(lang, info.text);
      const inAnki = t?.ankiId;
      box.innerHTML = `<button class="btn small ${inAnki ? 'ghost' : ''}" data-act="anki" title="${inAnki ? 'Обновить карточку в Anki' : 'Создать карточку в Anki'}">${inAnki ? icon('check') + '<span>Обновить в Anki</span>' : icon('cards') + '<span>В Anki</span>'}</button>`;
    }
    async function toAnki(btn) {
      // Слово ещё не в словаре — добавляем как изучаемое с лучшим переводом.
      let t = getTerm(lang, info.text);
      const translation = tr.value.trim() || mainSuggestion;
      if (!translation) { toast('Сначала выберите перевод', 'error'); return; }
      if (!t || t.status < 1 || t.status >= KNOWN || !t.translation) {
        if (!tr.value.trim()) tr.value = translation;
        const st = t && t.status >= 1 && t.status < KNOWN ? t.status : 1;
        t = await save({ status: st, translation: tr.value.trim(), notes: note.value.trim() });
        refreshPanelStatus();
      }
      if (isIOS()) { location.href = ankiMobileUrl(t); return; }
      if (!settings.ankiEnabled) { toast('Подключите Anki: Настройки → Anki', 'error'); return; }
      btn.disabled = true;
      try {
        const r = await sendTerm(t);
        toast(r === 'updated' ? 'Карточка в Anki обновлена' : 'Добавлено в Anki');
      } catch (err) { toast(err.message || 'Anki не ответил', 'error'); }
      btn.disabled = false;
      drawAnki();
    }
    drawAnki();

    // На телефоне прокручиваем текст, чтобы слово не пряталось под листом.
    if (isNarrow()) {
      requestAnimationFrame(() => {
        const r = info.els[0].getBoundingClientRect();
        const sheetTop = panel.getBoundingClientRect().top;
        if (r.bottom > sheetTop - 12) rscroll.scrollBy({ top: r.bottom - sheetTop + 80, behavior: 'smooth' });
      });
    }
  }

  // Изменения словаря — перекрашиваем слова на странице.
  const onTermsChanged = (e) => {
    if (e.detail.lang !== lang) return;
    if (e.detail.keys.some((k) => k === '*' || k.includes(' '))) { rerenderParas(); return; }
    const keys = new Set(e.detail.keys);
    for (const el of $$('.w', pageText)) {
      if (keys.has(el.dataset.k)) el.className = `w ${cls(statusOf(lang, el.dataset.k))}${el.classList.contains('inph') ? ' inph' : ''}${el.classList.contains('sel') ? ' sel' : ''}`;
    }
    markSelection();
    updateHint();
  };
  document.addEventListener('terms-changed', onTermsChanged);

  // ---------- Страницы ----------
  async function nextPage() {
    const [start, end] = pageRange();
    const newKeys = $$('.w.s0', pageText).map((e) => e.dataset.k);
    if (settings.autoKnown && newKeys.length) await markKnown(lang, newKeys);
    if (page >= (meta.maxPage || 0)) {
      await bump('read', body.counts.slice(start, end).reduce((a, b) => a + b, 0));
    }
    if (page < body.pages.length - 1) {
      page++;
      meta.maxPage = Math.max(meta.maxPage || 0, page);
      await updateText(id, { page, maxPage: meta.maxPage });
      renderPage();
    } else {
      meta.finished = true;
      await updateText(id, { finished: true, maxPage: page });
      renderFinished();
    }
  }

  function renderFinished() {
    stopTts();
    closePanel();
    observer?.disconnect();
    const learning = body.vocab.filter((k) => { const s = statusOf(lang, k); return s >= 1 && s < KNOWN; }).length;
    const known = body.vocab.filter((k) => statusOf(lang, k) === KNOWN).length;
    pageText.classList.add('finished');
    pageText.innerHTML = `
      <div class="done">
        <div class="done-mark">${icon('check')}</div>
        <h2>Текст прочитан</h2>
        <p>«${esc(meta.title)}» — ${fmt(meta.words)} ${plural(meta.words, 'слово', 'слова', 'слов')}.
          Из ${fmt(body.vocab.length)} разных слов вы знаете ${fmt(known)}, изучаете ${fmt(learning)}.</p>
        <div class="row center gap wrap">
          ${learning ? `<a class="btn primary" href="#/review">Повторить слова</a>` : ''}
          <a class="btn" href="#/library">В библиотеку</a>
          <button class="btn ghost" data-finish="again">Читать заново</button>
        </div>
      </div>`;
    $('#page-foot', view).hidden = true;
    $('#foot-hint', view).textContent = '';
    $('[data-finish="again"]', pageText).onclick = () => { page = 0; renderPage(); };
  }

  $('#next-btn', view).onclick = nextPage;
  $('#prev-btn', view).onclick = () => { if (page > 0) { page--; renderPage(); } };

  // ---------- Озвучка ----------
  function stopTts() {
    if (!speaking) return;
    speaking = false;
    stopSpeech();
    $$('.sent.speaking', pageText).forEach((s) => s.classList.remove('speaking'));
    const b = $('#tts-btn', view);
    if (b) { b.innerHTML = icon('play'); b.title = 'Слушать страницу'; }
  }
  $('#tts-btn', view)?.addEventListener('click', (e) => {
    if (speaking) { stopTts(); return; }
    const sents = $$('.para .sent', pageText);
    if (!sents.length) return;
    speaking = true;
    e.currentTarget.innerHTML = icon('pause');
    e.currentTarget.title = 'Остановить';
    speakSequence(sents.map((s) => s.textContent), lang, {
      onItem: (i) => {
        sents.forEach((s) => s.classList.remove('speaking'));
        sents[i].classList.add('speaking');
        sents[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      },
      onEnd: stopTts,
    });
  });

  // ---------- Параллельный режим и вид ----------
  $('#par-btn', view).onclick = async (e) => {
    const btn = e.currentTarget;
    await saveSettings({ parallel: !settings.parallel });
    btn.setAttribute('aria-pressed', settings.parallel);
    reader.classList.toggle('parallel', settings.parallel);
    const keep = sel;
    renderPage();
    if (keep) { sel = keep; markSelection(); openPanel(); }
  };
  $('#type-btn', view).onclick = () => openTypeDialog();

  // ---------- Клавиатура ----------
  const onKey = (e) => {
    if (e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.modal-wrap')) return;
    const k = e.key.toLowerCase();
    if (sel) {
      if (['1', '2', '3', '4', '5'].includes(k)) { panel._setStatus?.(+k); e.preventDefault(); }
      else if (k === 'k' || k === 'л') panel._setStatus?.(KNOWN);
      else if (k === 'i' || k === 'ш') panel._setStatus?.(IGNORED);
      else if (k === 'arrowright') { e.preventDefault(); e.shiftKey ? extend(1) : moveSelection(1); }
      else if (k === 'arrowleft') { e.preventDefault(); e.shiftKey ? extend(-1) : moveSelection(-1); }
      else if (k === 'escape') closePanel();
      else if (k === 'p' || k === 'з') { const i = selInfo(); if (i) speak(i.text, lang); }
      else if (k === 't' || k === 'е') panel._translateSentence?.();
    } else if (k === 'arrowright' || k === 'pagedown') { if (!pageText.classList.contains('finished')) nextPage(); }
    else if (k === 'arrowleft' || k === 'pageup') { if (page > 0) { page--; renderPage(); } }
  };
  document.addEventListener('keydown', onKey);

  renderPage();

  return () => {
    stopTts();
    stopSpeech();
    observer?.disconnect();
    document.removeEventListener('terms-changed', onTermsChanged);
    document.removeEventListener('keydown', onKey);
  };
}

export function openTypeDialog() {
  const m = modal({
    title: 'Вид текста',
    body: `
      <div class="stack">
        <label class="field">Размер шрифта <output id="fs-out">${settings.fontSize}</output>
          <input type="range" id="fs" min="15" max="32" step="1" value="${settings.fontSize}">
        </label>
        <div class="field">Шрифт
          <div class="seg small">
            <button data-font="serif" aria-selected="${settings.readerFont === 'serif'}" class="serif-sample">С засечками</button>
            <button data-font="sans" aria-selected="${settings.readerFont === 'sans'}">Без засечек</button>
          </div>
        </div>
        <div class="field">Межстрочный интервал
          <div class="seg small">
            ${[[1.5, 'Плотно'], [1.75, 'Обычно'], [2.05, 'Свободно']].map(([v, n]) => `<button data-lh="${v}" aria-selected="${settings.lineHeight === v}">${n}</button>`).join('')}
          </div>
        </div>
        <div class="field">Тема
          <div class="seg small">
            ${[['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']].map(([v, n]) => `<button data-theme="${v}" aria-selected="${settings.theme === v}">${n}</button>`).join('')}
          </div>
        </div>
      </div>`,
  });
  const b = m.body;
  $('#fs', b).oninput = async (e) => { $('#fs-out', b).textContent = e.target.value; await saveSettings({ fontSize: +e.target.value }); applyAppearance(); };
  b.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-font], button[data-lh], button[data-theme]');
    if (!btn) return;
    if (btn.dataset.font) await saveSettings({ readerFont: btn.dataset.font });
    if (btn.dataset.lh) await saveSettings({ lineHeight: +btn.dataset.lh });
    if (btn.dataset.theme) await saveSettings({ theme: btn.dataset.theme });
    $$('button', btn.parentElement).forEach((x) => x.setAttribute('aria-selected', x === btn));
    applyAppearance();
  });
}
