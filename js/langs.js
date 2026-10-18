// code — ISO для перевода, tess — язык распознавания Tesseract, speech — голос озвучки.
export const LANGS = [
  { code: 'en', name: 'Английский', tess: 'eng', speech: 'en-US' },
  { code: 'de', name: 'Немецкий', tess: 'deu', speech: 'de-DE' },
  { code: 'fr', name: 'Французский', tess: 'fra', speech: 'fr-FR' },
  { code: 'es', name: 'Испанский', tess: 'spa', speech: 'es-ES' },
  { code: 'it', name: 'Итальянский', tess: 'ita', speech: 'it-IT' },
  { code: 'pt', name: 'Португальский', tess: 'por', speech: 'pt-PT' },
  { code: 'nl', name: 'Нидерландский', tess: 'nld', speech: 'nl-NL' },
  { code: 'sv', name: 'Шведский', tess: 'swe', speech: 'sv-SE' },
  { code: 'no', name: 'Норвежский', tess: 'nor', speech: 'nb-NO' },
  { code: 'da', name: 'Датский', tess: 'dan', speech: 'da-DK' },
  { code: 'fi', name: 'Финский', tess: 'fin', speech: 'fi-FI' },
  { code: 'pl', name: 'Польский', tess: 'pol', speech: 'pl-PL' },
  { code: 'cs', name: 'Чешский', tess: 'ces', speech: 'cs-CZ' },
  { code: 'uk', name: 'Украинский', tess: 'ukr', speech: 'uk-UA' },
  { code: 'ru', name: 'Русский', tess: 'rus', speech: 'ru-RU' },
  { code: 'tr', name: 'Турецкий', tess: 'tur', speech: 'tr-TR' },
  { code: 'el', name: 'Греческий', tess: 'ell', speech: 'el-GR' },
  { code: 'ja', name: 'Японский', tess: 'jpn', speech: 'ja-JP' },
  { code: 'zh', name: 'Китайский', tess: 'chi_sim', speech: 'zh-CN' },
  { code: 'ko', name: 'Корейский', tess: 'kor', speech: 'ko-KR' },
  { code: 'ar', name: 'Арабский', tess: 'ara', speech: 'ar-SA' },
  { code: 'he', name: 'Иврит', tess: 'heb', speech: 'he-IL' },
  { code: 'hi', name: 'Хинди', tess: 'hin', speech: 'hi-IN' },
  { code: 'vi', name: 'Вьетнамский', tess: 'vie', speech: 'vi-VN' },
  { code: 'id', name: 'Индонезийский', tess: 'ind', speech: 'id-ID' },
  { code: 'la', name: 'Латынь', tess: 'lat', speech: 'it-IT' },
];

export const langByCode = (code) => LANGS.find((l) => l.code === code) || { code, name: code, tess: 'eng', speech: code };
export const langName = (code) => langByCode(code).name;

export function langOptions(selected, { exclude } = {}) {
  return LANGS.filter((l) => l.code !== exclude)
    .map((l) => `<option value="${l.code}" ${l.code === selected ? 'selected' : ''}>${l.name}</option>`)
    .join('');
}

// Языки без пробелов между словами — им нужна другая разбивка на страницы.
export const isCJK = (code) => ['ja', 'zh', 'ko'].includes(code);
