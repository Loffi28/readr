// Разбивка текста на предложения и слова через Intl.Segmenter
// (умеет и японский/китайский), с запасным вариантом на регулярках.
const segCache = new Map();
const hasSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl;
const LETTER = /\p{L}/u;

function segmenter(lang, granularity) {
  const key = lang + granularity;
  if (!segCache.has(key)) {
    try { segCache.set(key, new Intl.Segmenter(lang, { granularity })); }
    catch { segCache.set(key, new Intl.Segmenter('en', { granularity })); }
  }
  return segCache.get(key);
}

export const normKey = (s) => s.toLocaleLowerCase().replace(/[’ʼ`]/g, "'").trim();

// [{ t: 'word', w: true, k: 'word' }, { t: ', ', w: false }]
export function tokenize(text, lang) {
  const out = [];
  if (hasSegmenter) {
    for (const seg of segmenter(lang, 'word').segment(text)) {
      const isWord = seg.isWordLike && LETTER.test(seg.segment);
      out.push(isWord ? { t: seg.segment, w: true, k: normKey(seg.segment) } : { t: seg.segment, w: false });
    }
  } else {
    const re = /([\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*)|([^\p{L}\p{M}]+)/gu;
    let m;
    while ((m = re.exec(text))) {
      out.push(m[1] ? { t: m[1], w: true, k: normKey(m[1]) } : { t: m[2], w: false });
    }
  }
  // Склеиваем соседние не-слова, чтобы DOM был легче.
  const merged = [];
  for (const tok of out) {
    const last = merged[merged.length - 1];
    if (!tok.w && last && !last.w) last.t += tok.t; else merged.push(tok);
  }
  return merged;
}

export function sentences(text, lang) {
  if (hasSegmenter) {
    return [...segmenter(lang, 'sentence').segment(text)].map((s) => s.segment);
  }
  return text.match(/[^.!?…]+[.!?…]+["»”')\]]*\s*|[^.!?…]+$/g) || [text];
}

export function wordKeys(text, lang) {
  return tokenize(text, lang).filter((t) => t.w).map((t) => t.k);
}

export function countWords(text, lang) {
  return wordKeys(text, lang).length;
}
