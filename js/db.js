// Тонкая обёртка над IndexedDB. Все данные живут только на устройстве.
const DB_NAME = 'readr';
const VERSION = 1;
export const STORES = ['texts', 'bodies', 'terms', 'cache', 'days', 'kv'];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const texts = db.createObjectStore('texts', { keyPath: 'id' });
      texts.createIndex('lang', 'lang');
      db.createObjectStore('bodies', { keyPath: 'id' });
      const terms = db.createObjectStore('terms', { keyPath: 'key' });
      terms.createIndex('lang', 'lang');
      db.createObjectStore('cache', { keyPath: 'key' });
      db.createObjectStore('days', { keyPath: 'date' });
      db.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const asPromise = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function run(store, mode, fn) {
  const db = await open();
  const tx = db.transaction(store, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const out = fn(tx.objectStore(store));
  const value = out instanceof IDBRequest ? await asPromise(out) : out;
  await done;
  return value;
}

export const db = {
  get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
  put: (store, value) => run(store, 'readwrite', (s) => s.put(value)),
  del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
  all: (store) => run(store, 'readonly', (s) => s.getAll()),
  allBy: (store, index, value) => run(store, 'readonly', (s) => s.index(index).getAll(value)),
  clear: (store) => run(store, 'readwrite', (s) => s.clear()),
  bulkPut: (store, values) => run(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); }),
  bulkDel: (store, keys) => run(store, 'readwrite', (s) => { keys.forEach((k) => s.delete(k)); }),
  async kvGet(k, fallback) {
    const row = await db.get('kv', k);
    return row ? row.v : fallback;
  },
  kvSet: (k, v) => db.put('kv', { k, v }),
  // Отметка об удалении — чтобы удаление дошло до других устройств при синхронизации.
  async tomb(kind, key) {
    const t = await db.kvGet('tombs', { texts: {}, terms: {} });
    (t[kind] ||= {})[key] = Date.now();
    await db.kvSet('tombs', t);
  },
};

// Сигнал «данные изменились на этом устройстве» — по нему запускается синхронизация.
export const changed = () => document.dispatchEvent(new Event('local-change'));
