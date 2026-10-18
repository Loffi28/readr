// Синхронизация между устройствами через секретный gist в GitHub пользователя.
// Словарь, тексты, прогресс и статистика сливаются по времени изменения;
// удаления передаются через отметки (tombs). Настройки и ключи не синхронизируются.
import { db } from './db.js';
import { settings, saveSettings } from './state.js';
import { forgetCache, loadLang } from './terms.js';
import { paginate } from './texts.js';

const API = 'https://api.github.com';
const DESC = 'Readr — синхронизация (не удалять)';
const F = { meta: 'readr-meta.json', terms: 'readr-terms.json', texts: 'readr-texts.json', days: 'readr-days.json' };
const bodyFile = (id) => `body-${id}.json`;
export const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=Readr%20sync';

export class SyncError extends Error {}

export const syncReady = () => !!(settings.syncToken && settings.syncGistId);

async function gh(path, { method = 'GET', body, token = settings.syncToken } = {}) {
  let r;
  try {
    r = await fetch(API + path, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new SyncError('Нет связи с GitHub'); }
  if (r.status === 401) throw new SyncError('Токен GitHub не подходит или истёк');
  if (r.status === 403 || r.status === 404) {
    const j = await r.json().catch(() => ({}));
    throw new SyncError(path.startsWith('/gists/') && r.status === 404
      ? 'Хранилище синхронизации не найдено — подключитесь заново'
      : 'GitHub не дал доступ: у токена должно быть право gist' + (j.message ? ` (${j.message})` : ''));
  }
  if (!r.ok) throw new SyncError('GitHub ответил ошибкой ' + r.status);
  return r.status === 204 ? null : r.json();
}

async function fileText(f) {
  if (!f) return null;
  if (!f.truncated) return f.content;
  const r = await fetch(f.raw_url, { cache: 'no-store' });
  if (!r.ok) throw new SyncError('Не удалось скачать ' + f.filename);
  return r.text();
}

const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
// Детерминированная запись: одинаковые данные дают одинаковую строку, лишних загрузок нет.
const dump = (arr, key) => JSON.stringify([...arr].sort((a, b) => String(a[key]).localeCompare(String(b[key]))));

// ---------- Подключение ----------
export async function connect(token) {
  const user = await gh('/user', { token });
  let gist = null;
  for (let page = 1; page <= 5 && !gist; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`, { token });
    gist = list.find((g) => g.description === DESC);
    if (list.length < 100) break;
  }
  if (!gist) {
    gist = await gh('/gists', {
      method: 'POST',
      token,
      body: { description: DESC, public: false, files: { [F.meta]: { content: JSON.stringify({ app: 'readr', version: 1, tombs: { texts: {}, terms: {} } }) } } },
    });
  }
  await saveSettings({ syncToken: token, syncGistId: gist.id, syncLogin: user.login, syncError: '' });
  return syncNow();
}

export async function disconnect() {
  await saveSettings({ syncToken: '', syncGistId: '', syncLogin: '', syncLast: 0, syncError: '' });
}

// ---------- Слияние ----------
const stamp = (x) => x.updated || x.created || 0;
// Число страниц у каждого устройства своё (свой размер страницы) — в общие данные не идёт.
const strip = (t) => { const { pagesTotal, ...rest } = t; return rest; };

function mergeRecords(local, remote, key, tomb, isDead) {
  const map = new Map();
  for (const r of [...remote, ...local]) {
    const prev = map.get(r[key]);
    if (!prev || stamp(r) > stamp(prev)) map.set(r[key], r);
  }
  for (const [k, r] of map) if (isDead(r, tomb[k])) map.delete(k);
  return map;
}

function mergeTexts(local, remote, tomb) {
  const byId = new Map(remote.map((t) => [t.id, t]));
  const merged = mergeRecords(local, remote, 'id', tomb, (r, ts) => ts != null);
  for (const [id, t] of merged) {
    // Прогресс не откатываем: берём самую дальнюю прочитанную страницу.
    const other = byId.get(id) === t ? local.find((x) => x.id === id) : byId.get(id);
    if (other) merged.set(id, { ...t, maxPage: Math.max(t.maxPage || 0, other.maxPage || 0), finished: !!(t.finished || other.finished) });
  }
  return merged;
}

function mergeDays(local, remote) {
  const map = new Map(remote.map((d) => [d.date, { ...d }]));
  for (const d of local) {
    const cur = map.get(d.date);
    if (!cur) { map.set(d.date, { ...d }); continue; }
    for (const k of ['read', 'known', 'lookups', 'reviews', 'added']) cur[k] = Math.max(cur[k] || 0, d[k] || 0);
  }
  return map;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let running = null;
export function syncNow() {
  if (!syncReady()) return Promise.resolve(null);
  if (running) return running;
  running = doSync()
    .then(async (res) => { await saveSettings({ syncLast: Date.now(), syncError: '' }); return res; })
    .catch(async (e) => { await saveSettings({ syncError: e.message || 'Ошибка синхронизации' }); throw e; })
    .finally(() => { running = null; document.dispatchEvent(new Event('sync-state')); });
  document.dispatchEvent(new Event('sync-state'));
  return running;
}
export const syncRunning = () => !!running;

async function doSync() {
  const gist = await gh(`/gists/${settings.syncGistId}`);
  const files = gist.files || {};
  const raw = {};
  for (const k of Object.keys(F)) raw[k] = await fileText(files[F[k]]);
  const remote = {
    meta: parse(raw.meta, { tombs: { texts: {}, terms: {} } }),
    terms: parse(raw.terms, []),
    texts: parse(raw.texts, []).map(strip),
    days: parse(raw.days, []),
  };
  const local = {
    terms: await db.all('terms'),
    texts: (await db.all('texts')).map(strip),
    days: await db.all('days'),
    tombs: await db.kvGet('tombs', { texts: {}, terms: {} }),
  };

  // Отметки об удалении — объединяем, берём самую позднюю.
  const tombs = { texts: { ...remote.meta.tombs?.texts }, terms: { ...remote.meta.tombs?.terms } };
  for (const kind of ['texts', 'terms']) {
    for (const [k, ts] of Object.entries(local.tombs[kind] || {})) tombs[kind][k] = Math.max(tombs[kind][k] || 0, ts);
  }

  const terms = mergeRecords(local.terms, remote.terms, 'key', tombs.terms, (r, ts) => ts != null && ts >= stamp(r));
  const texts = mergeTexts(local.texts, remote.texts, tombs.texts);
  const days = mergeDays(local.days, remote.days);

  // ---- Применяем к этому устройству ----
  let changes = 0;
  const localTerms = new Map(local.terms.map((t) => [t.key, t]));
  const putTerms = [...terms.values()].filter((t) => !same(localTerms.get(t.key), t));
  const delTerms = local.terms.filter((t) => !terms.has(t.key)).map((t) => t.key);
  if (putTerms.length) await db.bulkPut('terms', putTerms);
  if (delTerms.length) await db.bulkDel('terms', delTerms);
  changes += putTerms.length + delTerms.length;

  const localTexts = new Map(local.texts.map((t) => [t.id, t]));
  const putTexts = [...texts.values()].filter((t) => !same(localTexts.get(t.id), t));
  const delTexts = local.texts.filter((t) => !texts.has(t.id)).map((t) => t.id);
  // Текст пришёл с другого устройства — скачиваем его содержимое и делим на страницы по местным настройкам.
  const ready = [];
  for (const t of putTexts) {
    let body = await db.get('bodies', t.id);
    if (!body) {
      body = parse(await fileText(files[bodyFile(t.id)]), null);
      if (!body) continue;
      body.pages = paginate(body.counts, settings.wordsPerPage, body.kinds || []);
      await db.put('bodies', body);
    }
    const fitted = { ...t, page: Math.min(t.page || 0, body.pages.length - 1) };
    // Отличается только номер страницы, урезанный под здешние страницы, — это не изменение.
    if (same(localTexts.get(t.id), fitted)) continue;
    ready.push({ ...fitted, pagesTotal: body.pages.length });
  }
  if (ready.length) await db.bulkPut('texts', ready);
  if (delTexts.length) { await db.bulkDel('texts', delTexts); await db.bulkDel('bodies', delTexts); }
  changes += ready.length + delTexts.length;

  const localDays = new Map(local.days.map((d) => [d.date, d]));
  const putDays = [...days.values()].filter((d) => !same(localDays.get(d.date), d));
  if (putDays.length) await db.bulkPut('days', putDays);
  await db.kvSet('tombs', tombs);

  // ---- Отправляем в GitHub то, что изменилось ----
  const out = {};
  const want = {
    terms: dump(terms.values(), 'key'),
    // Номер страницы на устройствах разный (свой размер страниц) — в облако идёт и он, при слиянии побеждает свежий.
    texts: dump(texts.values(), 'id'),
    days: dump(days.values(), 'date'),
    meta: JSON.stringify({ app: 'readr', version: 1, tombs }),
  };
  for (const k of Object.keys(want)) if (want[k] !== raw[k]) out[F[k]] = { content: want[k] };
  for (const t of texts.values()) {
    if (files[bodyFile(t.id)]) continue;
    const body = await db.get('bodies', t.id);
    if (body) out[bodyFile(t.id)] = { content: JSON.stringify(body) };
  }
  for (const name of Object.keys(files)) {
    const m = name.match(/^body-(.+)\.json$/);
    if (m && !texts.has(m[1])) out[name] = null;
  }
  if (Object.keys(out).length) await gh(`/gists/${settings.syncGistId}`, { method: 'PATCH', body: { files: out } });

  if (changes) {
    forgetCache();
    await loadLang(settings.lang);
    // '*' — словарь обновился целиком, читалка перерисует страницу.
    document.dispatchEvent(new CustomEvent('terms-changed', { detail: { lang: settings.lang, keys: ['*'] } }));
    document.dispatchEvent(new CustomEvent('synced', { detail: { changes } }));
  }
  return { changes, uploaded: Object.keys(out).length };
}
