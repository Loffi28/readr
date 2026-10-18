import { $, $$, toast, plural } from './util.js';
import { loadSettings, settings, saveSettings } from './state.js';
import { applyAppearance } from './appearance.js';
import { langName } from './langs.js';
import { loadLang, dueTerms } from './terms.js';
import './install.js';
import { providerForKey, defaultModel } from './llm.js';
import { syncReady, syncNow } from './sync.js';

const routes = {
  library: () => import('./library.js').then((m) => m.renderLibrary),
  read: () => import('./reader.js').then((m) => m.renderReader),
  words: () => import('./words.js').then((m) => m.renderWords),
  review: () => import('./review.js').then((m) => m.renderReview),
  stats: () => import('./stats.js').then((m) => m.renderStats),
  settings: () => import('./settings-view.js').then((m) => m.renderSettings),
};

let cleanup = null;
let navSeq = 0;

async function route() {
  const seq = ++navSeq;
  const [, name = 'library', arg] = location.hash.replace(/^#\/?/, '#/').split('/');
  const key = routes[name] ? name : 'library';
  const view = $('#view');
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  document.body.dataset.route = key;
  $$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === key || (key === 'read' && a.dataset.route === 'library')));
  const render = await routes[key]();
  if (seq !== navSeq) return;
  view.classList.remove('enter');
  void view.offsetWidth;
  view.classList.add('enter');
  cleanup = await render(view, arg && decodeURIComponent(arg));
  if (key !== 'read') view.focus({ preventScroll: true });
  updateBadge();
}

async function updateBadge() {
  await loadLang(settings.lang);
  const n = dueTerms(settings.lang).length;
  const b = $('#due-badge');
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : n;
  $('#rail-lang').textContent = langName(settings.lang);
}

// Синхронизация с другими устройствами: при запуске, при возврате в приложение и после правок.
function setupSync() {
  let timer = null;
  const run = () => {
    clearTimeout(timer);
    timer = null;
    if (syncReady() && navigator.onLine !== false) syncNow().catch(() => {});
  };
  document.addEventListener('local-change', () => { clearTimeout(timer); timer = setTimeout(run, 8000); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (timer) run(); } // уходим из приложения — отправляем несохранённое
    else if (Date.now() - (settings.syncLast || 0) > 20000) run();
  });
  window.addEventListener('online', run);
  document.addEventListener('synced', (e) => {
    const where = document.body.dataset.route;
    const n = e.detail.changes;
    toast(`Синхронизировано: ${n} ${plural(n, 'изменение', 'изменения', 'изменений')} с другого устройства`);
    // Библиотеку, словарь и статистику перерисовываем; чтение и настройки не трогаем.
    if (!['read', 'settings'].includes(where) && !document.querySelector('.modal-wrap')) route();
    updateBadge();
  });
  run();
}

async function start() {
  await loadSettings();
  // Ключ, вставленный не в тот сервис (например, ключ посредника в «Claude»), переносим в нужный.
  const guess = settings.aiKey && providerForKey(settings.aiKey);
  if (guess && guess !== settings.aiProvider && settings.aiProvider !== 'off') {
    await saveSettings({ aiProvider: guess, aiModel: defaultModel(guess) });
  }
  applyAppearance();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance);
  document.addEventListener('terms-changed', () => updateBadge());
  document.addEventListener('settings', (e) => { if ('lang' in e.detail) updateBadge(); });
  window.addEventListener('hashchange', route);
  if (!location.hash) history.replaceState(null, '', '#/library');
  await route();
  setupSync();
  navigator.storage?.persist?.().catch(() => {});
  // Windows: «Открыть с помощью Readr» для PDF, EPUB и TXT.
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const files = await Promise.all(params.files.map((h) => h.getFile()));
      const { openAddDialog } = await import('./library.js');
      openAddDialog({ files });
    });
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // Вышла новая версия — перезапускаемся, чтобы не работать на старом коде.
    let hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloading) { reloading = true; location.reload(); }
      hadController = true;
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // Установленное приложение на телефоне может неделями не перезагружаться — проверяем обновления при возврате.
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
  }
}

start().catch((e) => {
  console.error(e);
  $('#view').innerHTML = `<section class="page"><h1>Не удалось запустить</h1><p>${String(e.message || e)}</p></section>`;
});
