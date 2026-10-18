export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

export function html(str) {
  const t = document.createElement('template');
  t.innerHTML = str.trim();
  return t.content.firstElementChild;
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const fmt = (n) => new Intl.NumberFormat('ru-RU').format(n);

export function toast(msg, kind = '') {
  const box = document.getElementById('toasts');
  const el = html(`<div class="toast ${kind}" role="status">${esc(msg)}</div>`);
  box.append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
}

// Модальное окно. На телефоне выезжает снизу как лист.
export function modal({ title, body, wide = false, onClose } = {}) {
  const el = html(`
    <div class="modal-wrap" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal ${wide ? 'wide' : ''}">
        <header class="modal-head">
          <h2>${esc(title)}</h2>
          <button class="icon-btn" data-close aria-label="Закрыть">${icon('close')}</button>
        </header>
        <div class="modal-body"></div>
      </div>
    </div>`);
  const bodyEl = el.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  const close = () => {
    el.classList.add('closing');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => el.remove(), 180);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(el);
  return { el, body: bodyEl, close };
}

export function confirmDialog(text, okLabel = 'Удалить') {
  return new Promise((resolve) => {
    let answered = false;
    const m = modal({
      title: 'Подтвердите',
      body: `<p class="confirm-text">${esc(text)}</p>
        <div class="row end gap"><button class="btn ghost" data-close>Отмена</button><button class="btn danger" data-ok>${esc(okLabel)}</button></div>`,
      onClose: () => { if (!answered) resolve(false); },
    });
    m.body.querySelector('[data-ok]').onclick = () => { answered = true; resolve(true); m.close(); };
  });
}

export function download(filename, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Не удалось загрузить ' + src));
    document.head.append(s);
  });
}

export const isTouch = () => matchMedia('(hover: none)').matches;
export const isNarrow = () => matchMedia('(max-width: 860px)').matches;
