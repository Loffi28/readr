import { $, $$, esc, icon, toast, download, today, confirmDialog, fmt } from './util.js';
import { settings, saveSettings } from './state.js';
import { langOptions } from './langs.js';
import { db } from './db.js';
import { forgetCache } from './terms.js';
import { listTexts, repaginate } from './texts.js';
import { translateText } from './translate.js';
import { voicesFor, speak, ttsAvailable } from './tts.js';
import { openTypeDialog } from './reader.js';
import { installState, promptInstall } from './install.js';
import { connect, disconnect, syncNow, syncReady, syncRunning, TOKEN_URL } from './sync.js';
import { AI_PROVIDERS, testAi, providerForKey, defaultModel } from './llm.js';

const BACKUP_STORES = ['texts', 'bodies', 'terms', 'days', 'kv'];

export async function renderSettings(view) {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const inst = installState();

  view.innerHTML = `
    <section class="page settings">
      <header class="page-head"><div><h1>Настройки</h1></div></header>

      <div class="set-group">
        <h2>Языки</h2>
        <label class="set-row"><span>Изучаю</span><select class="input" id="s-lang">${langOptions(settings.lang, { exclude: settings.native })}</select></label>
        <label class="set-row"><span>Переводить на</span><select class="input" id="s-native">${langOptions(settings.native)}</select></label>
      </div>

      <div class="set-group">
        <h2>Переводчик</h2>
        <div class="set-row"><span>Сервис</span>
          <div class="seg small" id="s-provider">
            ${[['google', 'Google'], ['mymemory', 'MyMemory'], ['libre', 'LibreTranslate']].map(([v, n]) => `<button data-p="${v}" aria-selected="${settings.provider === v}">${n}</button>`).join('')}
          </div>
        </div>
        <p class="set-note">Все варианты бесплатные и без регистрации. Если основной сервис не ответит, перевод возьмётся из запасного. LibreTranslate — для своего сервера.</p>
        <div id="libre-box" ${settings.provider === 'libre' ? '' : 'hidden'}>
          <label class="set-row"><span>Адрес сервера</span><input class="input" id="s-libre-url" value="${esc(settings.libreUrl)}"></label>
          <label class="set-row"><span>Ключ (если нужен)</span><input class="input" id="s-libre-key" value="${esc(settings.libreKey)}"></label>
        </div>
        <div class="set-row"><span></span><button class="btn ghost small" id="s-test">Проверить перевод</button></div>
      </div>

      <div class="set-group" id="ai-group">
        <h2>ИИ-помощник</h2>
        <p class="set-note">Необязательно. С ИИ слово переводится по смыслу в конкретном предложении, с подсказкой словарной формы и нюансов. Предложения и абзацы переводятся живее, а текст с фото очищается от ошибок распознавания. Нужен ваш ключ; он хранится только на этом устройстве, текст уходит выбранному сервису.</p>
        <label class="set-row"><span>Сервис</span>
          <select class="input" id="s-ai-provider">
            <option value="off">Выключен</option>
            ${Object.entries(AI_PROVIDERS).map(([k, p]) => `<option value="${k}" ${settings.aiProvider === k ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </label>
        <div id="ai-fields"></div>
      </div>

      <div class="set-group">
        <h2>Чтение</h2>
        <label class="set-row"><span>Слов на странице</span>
          <select class="input" id="s-wpp">${[120, 180, 220, 300, 400, 600].map((n) => `<option ${n === settings.wordsPerPage ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </label>
        <label class="set-row switch"><span>Перелистнул — значит знаю<small>Незнакомые слова, на которые вы не нажали, отмечаются как известные. Так работает LingQ.</small></span>
          <input type="checkbox" id="s-auto" ${settings.autoKnown ? 'checked' : ''}>
        </label>
        <div class="set-row"><span>Шрифт, размер, тема</span><button class="btn ghost small" id="s-type">${icon('type')}<span>Настроить</span></button></div>
      </div>

      ${ttsAvailable ? `
      <div class="set-group">
        <h2>Озвучка</h2>
        <div class="set-row"><span>Голос</span>
          <div class="seg small" id="s-engine">
            ${[['google', 'Живой голос Google'], ['system', 'Голоса системы']].map(([v, n]) => `<button data-e="${v}" aria-selected="${settings.ttsEngine === v}">${n}</button>`).join('')}
          </div>
        </div>
        <p class="set-note" id="engine-note"></p>
        <label class="set-row" id="voice-row"><span>Голос системы</span><select class="input" id="s-voice"></select></label>
        <label class="set-row"><span>Скорость <output id="s-rate-out">${settings.ttsRate}</output></span>
          <input type="range" id="s-rate" min="0.5" max="1.4" step="0.05" value="${settings.ttsRate}">
        </label>
        <div class="set-row"><span></span><button class="btn ghost small" id="s-listen">${icon('sound')}<span>Прослушать</span></button></div>
      </div>` : ''}

      <div class="set-group">
        <h2>Цели</h2>
        <label class="set-row"><span>Новых слов в день</span><input class="input narrow" type="number" min="1" max="200" id="s-goal" value="${settings.dailyGoal}"></label>
        <label class="set-row"><span>Карточек за раз</span><input class="input narrow" type="number" min="5" max="200" id="s-review" value="${settings.reviewSize}"></label>
      </div>

      <div class="set-group" id="sync-group">
        <h2>Синхронизация</h2>
        <div id="sync-box"></div>
      </div>

      <div class="set-group">
        <h2>Данные</h2>
        <p class="set-note">Тексты и словарь хранятся только на этом устройстве${est ? ` (занято ${fmt(Math.round(est.usage / 1048576))} МБ)` : ''}. Копия пригодится как запасной вариант или для переноса без синхронизации: сохраните её и откройте на другом устройстве — данные объединятся.</p>
        <div class="row gap wrap">
          <button class="btn" id="s-backup">${icon('download')}<span>Сохранить копию</span></button>
          <label class="btn ghost">${icon('upload')}<span>Загрузить копию</span><input type="file" accept=".json,application/json" id="s-restore" hidden></label>
        </div>
        <div class="row gap wrap top-gap">
          <button class="btn ghost small" id="s-cache">Очистить кэш переводов</button>
          <button class="btn ghost small danger" id="s-wipe">Удалить все данные</button>
        </div>
        ${persisted === false ? '<p class="set-note">Совет: установите приложение на экран «Домой» — так система не удалит данные при нехватке места.</p>' : ''}
      </div>

      <div class="set-group">
        <h2>Установка</h2>
        ${inst.installed ? '<p class="set-note">Приложение уже установлено и работает без браузера.</p>' : `
        ${inst.canPrompt ? `<button class="btn primary" id="s-install">${icon('download')}<span>Установить на этот компьютер</span></button>` : ''}
        <ul class="install-steps">
          <li><strong>iPhone и iPad:</strong> откройте эту страницу в Safari, нажмите «Поделиться» и выберите «На экран Домой».</li>
          <li><strong>Windows:</strong> в Edge или Chrome нажмите значок установки справа в адресной строке или «Меню → Приложения → Установить».</li>
          <li><strong>Android:</strong> «Меню → Добавить на главный экран».</li>
        </ul>`}
      </div>

      <p class="set-foot">Readr — бесплатная читалка для изучения языков. Работает офлайн, кроме перевода и распознавания новых языков.</p>
    </section>`;

  $('#s-lang', view).onchange = (e) => saveSettings({ lang: e.target.value }).then(() => renderSettings(view));
  $('#s-native', view).onchange = (e) => saveSettings({ native: e.target.value }).then(() => renderSettings(view));
  $('#s-provider', view).onclick = (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    saveSettings({ provider: b.dataset.p });
    $$('[data-p]', view).forEach((x) => x.setAttribute('aria-selected', x === b));
    $('#libre-box', view).hidden = b.dataset.p !== 'libre';
  };
  $('#s-libre-url', view).onchange = (e) => saveSettings({ libreUrl: e.target.value.trim() });
  $('#s-libre-key', view).onchange = (e) => saveSettings({ libreKey: e.target.value.trim() });
  $('#s-test', view).onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const sample = { en: 'Good morning, how are you?', de: 'Guten Morgen, wie geht es dir?', fr: 'Bonjour, comment ça va ?', es: 'Buenos días, ¿cómo estás?' }[settings.lang] || 'Hello';
      const tr = await translateText(sample + ' ' + Date.now() % 7, settings.lang);
      toast('Работает: ' + tr);
    } catch { toast('Переводчик не отвечает. Проверьте интернет или выберите другой сервис.', 'error'); }
    b.disabled = false;
  };
  const drawAi = () => {
    const box = $('#ai-fields', view);
    const id = settings.aiProvider;
    const p = AI_PROVIDERS[id];
    if (!p) { box.innerHTML = ''; return; }
    const model = settings.aiModel || p.model || p.models?.[0][0] || '';
    box.innerHTML = `
      <label class="set-row"><span>Ключ API${p.keyUrl ? `<small><a href="${p.keyUrl}" target="_blank" rel="noopener">Где взять ключ</a></small>` : '<small>Если сервер требует</small>'}</span>
        <input class="input" type="password" id="s-ai-key" autocomplete="off" spellcheck="false" value="${esc(settings.aiKey)}" placeholder="Вставьте ключ">
      </label>
      ${id === 'custom' ? `<label class="set-row"><span>Адрес сервера</span><input class="input" id="s-ai-base" value="${esc(settings.aiBaseUrl || p.base)}"></label>` : ''}
      <label class="set-row"><span>Модель${p.modelsUrl ? `<small><a href="${p.modelsUrl}" target="_blank" rel="noopener">Бесплатные модели</a></small>` : ''}</span>
        ${p.models
          ? `<select class="input" id="s-ai-model">${p.models.map(([v, n]) => `<option value="${v}" ${v === model ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`
          : `<input class="input" id="s-ai-model" value="${esc(model)}" spellcheck="false">`}
      </label>
      <label class="set-row switch"><span>Слово по смыслу в предложении</span><input type="checkbox" data-ai="aiWords" ${settings.aiWords ? 'checked' : ''}></label>
      <label class="set-row switch"><span>Перевод предложений и абзацев<small>Вместо Google; если ИИ не ответит, перевод возьмётся из Google.</small></span><input type="checkbox" data-ai="aiSentences" ${settings.aiSentences ? 'checked' : ''}></label>
      <label class="set-row switch"><span>Исправлять текст с фото и сканов</span><input type="checkbox" data-ai="aiOcr" ${settings.aiOcr ? 'checked' : ''}></label>
      <div class="set-row"><span></span><button class="btn ghost small" id="s-ai-test">Проверить</button></div>`;
    $('#s-ai-key', box).onchange = async (e) => {
      const key = e.target.value.trim();
      const guess = providerForKey(key);
      if (guess && guess !== settings.aiProvider) {
        await saveSettings({ aiKey: key, aiProvider: guess, aiModel: defaultModel(guess) });
        $('#s-ai-provider', view).value = guess;
        toast('Это ключ ' + AI_PROVIDERS[guess].name.split(' (')[0] + ' — сервис выбран автоматически');
        drawAi();
      } else await saveSettings({ aiKey: key });
    };
    $('#s-ai-model', box).onchange = (e) => saveSettings({ aiModel: e.target.value.trim() });
    $('#s-ai-base', box)?.addEventListener('change', (e) => saveSettings({ aiBaseUrl: e.target.value.trim() }));
    box.querySelectorAll('[data-ai]').forEach((c) => { c.onchange = () => saveSettings({ [c.dataset.ai]: c.checked }); });
    $('#s-ai-test', box).onclick = async (e) => {
      const b = e.currentTarget;
      const key = $('#s-ai-key', box).value.trim();
      const guess = providerForKey(key);
      if (guess && guess !== settings.aiProvider) {
        await saveSettings({ aiKey: key, aiProvider: guess, aiModel: defaultModel(guess) });
        $('#s-ai-provider', view).value = guess;
        drawAi();
        return $('#s-ai-test', view).click();
      }
      await saveSettings({ aiKey: key, aiModel: $('#s-ai-model', box).value.trim() });
      b.disabled = true;
      b.textContent = 'Проверяю…';
      try { toast('ИИ работает: apple — ' + (await testAi())); }
      catch (err) { toast(err.message || 'Нет связи', 'error'); }
      b.disabled = false;
      b.textContent = 'Проверить';
    };
  };
  drawAi();
  $('#s-ai-provider', view).onchange = async (e) => {
    const prov = e.target.value;
    // У каждого сервиса свой ключ и своя модель по умолчанию — ключи не теряются при переключении.
    const keys = { ...(settings.aiKeys || {}), [settings.aiProvider]: settings.aiKey };
    await saveSettings({
      aiProvider: prov,
      aiKeys: keys,
      aiKey: keys[prov] || '',
      aiModel: AI_PROVIDERS[prov]?.model || AI_PROVIDERS[prov]?.models?.[0][0] || '',
    });
    drawAi();
  };
  const drawSync = () => {
    const box = $('#sync-box', view);
    if (!box) return;
    if (!syncReady()) {
      box.innerHTML = `
        <p class="set-note">Ноутбук и телефон будут обмениваться словарём, текстами и прогрессом через секретное хранилище (gist) в вашем GitHub. Нужно один раз создать токен и вставить его на каждом устройстве.</p>
        <ol class="install-steps">
          <li>Откройте <a href="${TOKEN_URL}" target="_blank" rel="noopener">создание токена на GitHub</a> — галочка gist уже стоит.</li>
          <li>В поле Expiration выберите No expiration и нажмите Generate token внизу страницы.</li>
          <li>Скопируйте токен (начинается с ghp_) и вставьте сюда. На втором устройстве — тот же токен.</li>
        </ol>
        <div class="row gap wrap top-gap">
          <input class="input" type="password" id="s-sync-token" autocomplete="off" spellcheck="false" placeholder="ghp_…" style="flex:1;min-width:200px">
          <button class="btn primary" id="s-sync-connect">Подключить</button>
        </div>`;
      $('#s-sync-connect', box).onclick = async (e) => {
        const b = e.currentTarget;
        const token = $('#s-sync-token', box).value.trim();
        if (!token) { $('#s-sync-token', box).focus(); return; }
        b.disabled = true;
        b.textContent = 'Подключаю…';
        try {
          const r = await connect(token);
          toast(r?.changes ? `Подключено, получено изменений: ${r.changes}` : 'Подключено. Данные синхронизируются');
        } catch (err) {
          toast(err.message || 'Не удалось подключиться', 'error');
          if (!settings.syncGistId) await disconnect();
        }
        drawSync();
      };
      return;
    }
    const when = settings.syncLast
      ? new Date(settings.syncLast).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
      : 'ещё не было';
    box.innerHTML = `
      <p class="set-note">Подключено к GitHub <b>${esc(settings.syncLogin || '')}</b>. Синхронизация идёт сама: при открытии приложения, при возврате к нему и через несколько секунд после изменений.</p>
      <p class="sync-status ${settings.syncError ? 'bad' : ''}">${syncRunning() ? 'Синхронизирую…' : settings.syncError ? 'Ошибка: ' + esc(settings.syncError) : 'Последняя синхронизация: ' + esc(when)}</p>
      <div class="row gap wrap">
        <button class="btn" id="s-sync-now" ${syncRunning() ? 'disabled' : ''}>Синхронизировать сейчас</button>
        <button class="btn ghost small" id="s-sync-off">Отключить</button>
      </div>`;
    $('#s-sync-now', box).onclick = () => syncNow().then((r) => toast(r?.changes ? `Готово, изменений: ${r.changes}` : 'Всё уже синхронизировано')).catch((err) => toast(err.message, 'error'));
    $('#s-sync-off', box).onclick = async () => {
      if (!(await confirmDialog('Отключить синхронизацию на этом устройстве? Данные здесь и в GitHub сохранятся.', 'Отключить'))) return;
      await disconnect();
      drawSync();
    };
  };
  drawSync();
  const onSyncState = () => { if (document.body.contains(view) && $('#sync-box', view)) drawSync(); };
  document.addEventListener('sync-state', onSyncState);

  $('#s-wpp', view).onchange = async (e) => {
    await saveSettings({ wordsPerPage: +e.target.value });
    for (const t of await listTexts()) await repaginate(t.id);
    toast('Страницы пересобраны');
  };
  $('#s-auto', view).onchange = (e) => saveSettings({ autoKnown: e.target.checked });
  $('#s-type', view).onclick = openTypeDialog;
  $('#s-goal', view).onchange = (e) => saveSettings({ dailyGoal: Math.max(1, +e.target.value || 15) });
  $('#s-review', view).onchange = (e) => saveSettings({ reviewSize: Math.max(5, +e.target.value || 20) });

  if (ttsAvailable) {
    const fillVoices = () => {
      const vs = voicesFor(settings.lang);
      $('#s-voice', view).innerHTML = `<option value="">Автоматически</option>` +
        vs.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === settings.ttsVoice ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
    };
    fillVoices();
    document.addEventListener('voices', fillVoices, { once: true });
    const sample = () => ({
      en: 'Every evening, just before the sun touched the sea, Martha climbed the old lighthouse.',
      de: 'In einer schmalen Gasse am Rand der Altstadt gab es einen kleinen Buchladen.',
      fr: 'Tous les dimanches matin, la petite place du village se transforme en marché.',
      es: 'Era una tarde tranquila de septiembre y el sol todavía calentaba la arena.',
    }[settings.lang] || 'Hello, this is how I sound.');
    const showEngine = () => {
      const g = settings.ttsEngine !== 'system';
      $('#engine-note', view).textContent = g
        ? 'Естественный голос, как в Google Переводчике. Нужен интернет; без сети включится голос системы.'
        : 'Работает без интернета, но звучит более механически. На iPhone качественные голоса можно скачать: «Настройки → Универсальный доступ → Устный контент → Голоса». В Windows лучшие голоса — в браузере Edge (с пометкой Natural).';
      $('#voice-row', view).hidden = g;
    };
    showEngine();
    $('#s-engine', view).onclick = async (e) => {
      const b = e.target.closest('[data-e]');
      if (!b) return;
      await saveSettings({ ttsEngine: b.dataset.e });
      $$('[data-e]', view).forEach((x) => x.setAttribute('aria-selected', x === b));
      showEngine();
      speak(sample(), settings.lang);
    };
    $('#s-voice', view).onchange = async (e) => {
      await saveSettings({ ttsVoice: e.target.value });
      speak(sample(), settings.lang);
    };
    $('#s-listen', view).onclick = () => speak(sample(), settings.lang);
    $('#s-rate', view).oninput = (e) => { $('#s-rate-out', view).textContent = e.target.value; saveSettings({ ttsRate: +e.target.value }); };
  }

  $('#s-backup', view).onclick = async () => {
    const data = { app: 'readr', version: 1, exported: new Date().toISOString() };
    for (const s of BACKUP_STORES) data[s] = await db.all(s);
    // Ключ ИИ в копию не кладём.
    data.kv = data.kv.map((row) => (row.k === 'settings' ? { ...row, v: { ...row.v, aiKey: '', aiKeys: {}, syncToken: '' } } : row));
    download(`readr-backup-${today()}.json`, JSON.stringify(data));
  };
  $('#s-restore', view).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'readr') throw new Error();
      // Слова объединяем: побеждает более свежая правка.
      const existing = new Map((await db.all('terms')).map((t) => [t.key, t]));
      const terms = (data.terms || []).filter((t) => !existing.has(t.key) || (existing.get(t.key).updated || 0) < (t.updated || 0));
      await db.bulkPut('terms', terms);
      await db.bulkPut('texts', data.texts || []);
      await db.bulkPut('bodies', data.bodies || []);
      const days = new Map((await db.all('days')).map((d) => [d.date, d]));
      for (const d of data.days || []) {
        const cur = days.get(d.date);
        if (!cur) days.set(d.date, d);
        else for (const k of ['read', 'known', 'lookups', 'reviews', 'added']) cur[k] = Math.max(cur[k] || 0, d[k] || 0);
      }
      await db.bulkPut('days', [...days.values()]);
      forgetCache();
      document.dispatchEvent(new Event('local-change'));
      toast(`Загружено: ${(data.texts || []).length} текстов, ${terms.length} слов обновлено`);
      renderSettings(view);
    } catch { toast('Это не файл копии Readr', 'error'); }
  };
  $('#s-cache', view).onclick = async () => { await db.clear('cache'); toast('Кэш переводов очищен'); };
  $('#s-wipe', view).onclick = async () => {
    if (!(await confirmDialog('Удалить все тексты, словарь и статистику на этом устройстве? Это нельзя отменить.', 'Удалить всё'))) return;
    for (const s of ['texts', 'bodies', 'terms', 'cache', 'days', 'kv']) await db.clear(s);
    forgetCache();
    location.hash = '#/library';
    location.reload();
  };
  $('#s-install', view)?.addEventListener('click', promptInstall);
  return () => document.removeEventListener('sync-state', onSyncState);
}
