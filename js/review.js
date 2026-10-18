// Карточки с интервальным повторением (упрощённый SM-2).
import { $, esc, icon, fmt, plural } from './util.js';
import { settings, saveSettings, bump } from './state.js';
import { loadLang, dueTerms, allTerms, saveTerm, KNOWN } from './terms.js';
import { lookup } from './translate.js';
import { speak, ttsAvailable } from './tts.js';

const DAY = 864e5;

export function schedule(t, grade, now = Date.now()) {
  let ivl = t.ivl || 0, ease = t.ease || 2.5, status = t.status, due;
  if (grade === 1) { ivl = 0; ease = Math.max(1.3, ease - 0.2); status = Math.max(1, status - 1); due = now + 10 * 60e3; }
  else {
    if (grade === 2) { ivl = Math.max(1, ivl * 1.2); ease = Math.max(1.3, ease - 0.15); }
    else if (grade === 3) { ivl = ivl < 1 ? 1 : ivl < 3 ? 3 : ivl * ease; status = Math.min(KNOWN, status + 1); }
    else { ivl = ivl < 1 ? 4 : ivl * ease * 1.3; ease += 0.15; status = Math.min(KNOWN, status + 2); }
    due = now + ivl * DAY;
  }
  return { ivl: Math.round(ivl * 10) / 10, ease: Math.round(ease * 100) / 100, status, due };
}

const GRADES = [
  [1, 'Не помню'],
  [2, 'С трудом'],
  [3, 'Помню'],
  [4, 'Легко'],
];

export async function renderReview(view) {
  const lang = settings.lang;
  await loadLang(lang);
  let queue = dueTerms(lang).sort((a, b) => (a.due || 0) - (b.due || 0)).slice(0, settings.reviewSize);
  let practice = false;
  let done = 0, total = queue.length, flipped = false;
  const reverse = () => settings.reviewReverse;

  function startPractice() {
    // Повторить заранее: ближайшие по сроку слова.
    queue = allTerms(lang).filter((t) => t.status >= 1 && t.status < KNOWN)
      .sort((a, b) => (a.due || 0) - (b.due || 0)).slice(0, settings.reviewSize);
    practice = true;
    done = 0; total = queue.length;
    draw();
  }

  function draw() {
    if (!queue.length) { drawEmpty(); return; }
    const t = queue[0];
    flipped = false;
    const front = reverse() ? (t.translation || '—') : t.text;
    const sentence = t.sentence ? markWord(t.sentence, t.text) : '';
    view.innerHTML = `
      <section class="page review">
        <header class="page-head">
          <div><h1>Повторение</h1><p class="sub">${practice ? 'Сверх плана' : 'На сегодня'}: ${done} из ${total}</p></div>
          <button class="btn ghost small" id="dir">${reverse() ? 'Перевод → слово' : 'Слово → перевод'}</button>
        </header>
        <div class="review-bar"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div>
        <div class="flashcard" id="card" tabindex="0" role="button" aria-label="Перевернуть карточку">
          <div class="fc-front">
            <span class="fc-word" ${reverse() ? '' : `lang="${esc(lang)}"`}>${esc(front)}</span>
            ${!reverse() && sentence ? `<p class="fc-ctx" lang="${esc(lang)}">${sentence}</p>` : ''}
          </div>
          <div class="fc-back" id="back" hidden>
            <span class="fc-answer" ${reverse() ? `lang="${esc(lang)}"` : ''} id="answer">${esc(reverse() ? t.text : (t.translation || ''))}</span>
            ${reverse() && sentence ? `<p class="fc-ctx" lang="${esc(lang)}">${sentence}</p>` : ''}
            ${t.notes ? `<p class="fc-note">${esc(t.notes)}</p>` : ''}
          </div>
          <span class="fc-hint" id="fc-hint">Нажмите или пробел, чтобы увидеть ответ</span>
        </div>
        <div class="grades" id="grades" hidden>
          ${GRADES.map(([g, n]) => `<button class="grade g${g}" data-g="${g}"><b>${g}</b><span>${n}</span></button>`).join('')}
        </div>
        <div class="row center gap">
          ${ttsAvailable ? `<button class="btn ghost small" id="say">${icon('sound')}<span>Произнести</span></button>` : ''}
        </div>
      </section>`;

    if (!reverse() && ttsAvailable && settings.reviewAudio !== false) speak(t.text, lang);
    $('#card', view).onclick = flip;
    $('#say', view)?.addEventListener('click', () => speak(t.text, lang));
    $('#dir', view).onclick = async () => { await saveSettings({ reviewReverse: !reverse() }); draw(); };
    $('#grades', view).onclick = (e) => { const g = e.target.closest('[data-g]'); if (g) grade(+g.dataset.g); };

    if (!t.translation) {
      lookup(t.text, lang).then(async (r) => {
        if (queue[0] !== t || !r.main) return;
        t.translation = r.main;
        await saveTerm(lang, t.text, { translation: r.main });
        const a = $('#answer', view);
        if (a && !reverse()) a.textContent = r.main;
      }).catch(() => {});
    }
  }

  function flip() {
    if (flipped) return;
    flipped = true;
    $('#back', view).hidden = false;
    $('#grades', view).hidden = false;
    $('#fc-hint', view).hidden = true;
    $('#card', view).classList.add('flipped');
    if (reverse() && ttsAvailable) speak(queue[0].text, lang);
  }

  async function grade(g) {
    const t = queue.shift();
    const next = schedule(t, g);
    await saveTerm(lang, t.text, next);
    await bump('reviews');
    if (g === 1) queue.splice(Math.min(3, queue.length), 0, { ...t, ...next });
    else done++;
    draw();
  }

  function drawEmpty() {
    const learning = allTerms(lang).filter((t) => t.status >= 1 && t.status < KNOWN).length;
    const upcoming = allTerms(lang).filter((t) => t.status >= 1 && t.status < KNOWN && t.due)
      .sort((a, b) => a.due - b.due)[0];
    const when = upcoming ? new Date(upcoming.due).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
    view.innerHTML = `
      <section class="page review">
        <header class="page-head"><div><h1>Повторение</h1></div></header>
        <div class="review-empty">
          <div class="done-mark">${icon('check')}</div>
          ${done
            ? `<h2>Готово: ${done} ${plural(done, 'карточка', 'карточки', 'карточек')}</h2><p>Слова вернутся, когда придёт время их освежить.</p>`
            : learning
              ? `<h2>На сегодня всё повторено</h2><p>Следующие слова ждут ${esc(when)}.</p>`
              : `<h2>Пока нечего повторять</h2><p>Читайте тексты и отмечайте незнакомые слова статусом 1–4 — они попадут сюда.</p>`}
          <div class="row center gap wrap">
            ${learning ? `<button class="btn" id="practice">Повторить ещё ${fmt(Math.min(learning, settings.reviewSize))}</button>` : ''}
            <a class="btn primary" href="#/library">Читать</a>
          </div>
        </div>
      </section>`;
    $('#practice', view)?.addEventListener('click', startPractice);
  }

  const onKey = (e) => {
    if (e.target.closest?.('input, textarea, select') || !queue.length) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
    else if (flipped && ['1', '2', '3', '4'].includes(e.key)) grade(+e.key);
  };
  document.addEventListener('keydown', onKey);
  draw();
  return () => document.removeEventListener('keydown', onKey);
}

function markWord(sentence, word) {
  const i = sentence.toLowerCase().indexOf(word.toLowerCase());
  if (i < 0) return esc(sentence);
  return esc(sentence.slice(0, i)) + '<mark>' + esc(sentence.slice(i, i + word.length)) + '</mark>' + esc(sentence.slice(i + word.length));
}
