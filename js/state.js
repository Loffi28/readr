import { db } from './db.js';
import { today } from './util.js';

export const DEFAULTS = {
  lang: 'en',            // язык, который изучаю
  native: 'ru',          // мой язык
  provider: 'google',    // google | mymemory | libre
  libreUrl: 'https://libretranslate.com',
  libreKey: '',
  wordsPerPage: 220,
  autoKnown: true,       // при перелистывании незнакомые слова → «знаю»
  fontSize: 21,
  lineHeight: 1.75,
  readerFont: 'serif',   // serif | sans
  theme: 'auto',         // auto | light | dark
  ttsEngine: 'google',  // google | system
  ttsRate: 0.95,
  ttsVoice: '',
  dailyGoal: 15,         // новых слов в день
  reviewSize: 20,
  parallel: false,
  reviewReverse: false,  // карточки «перевод → слово»
  reviewAudio: true,
  aiProvider: 'off',     // off | claude | openrouter | gemini | custom
  aiKey: '',
  aiModel: '',
  aiBaseUrl: '',
  aiWords: true,         // перевод слова по контексту
  aiSentences: true,     // перевод предложений и абзацев
  aiOcr: true,           // исправлять текст с фото и сканов
};

export const settings = { ...DEFAULTS };

export async function loadSettings() {
  Object.assign(settings, DEFAULTS, await db.kvGet('settings', {}));
  return settings;
}

export async function saveSettings(patch) {
  Object.assign(settings, patch);
  await db.kvSet('settings', { ...settings });
  document.dispatchEvent(new CustomEvent('settings', { detail: patch }));
}

// Дневная активность для статистики и серии дней подряд.
export async function bump(field, n = 1) {
  if (!n) return;
  const date = today();
  const row = (await db.get('days', date)) || { date, read: 0, known: 0, lookups: 0, reviews: 0, added: 0 };
  row[field] = (row[field] || 0) + n;
  await db.put('days', row);
}
