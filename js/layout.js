// Разбор раскладки страницы по прямоугольникам слов (фото после распознавания) или
// фрагментов текста (PDF): колонки и порядок чтения (рекурсивное XY-разрезание),
// строки, абзацы, заголовки по размеру шрифта, списки, буквицы, переносы.
//
// Вход: [{ text, x0, y0, x1, y1, conf?, glue? }], y растёт вниз.
// glue: true — фрагмент PDF, пробелы между фрагментами ставим только по расстоянию.
// Выход: [{ k: 'p' | 'h1' | 'h2' | 'li', t: '...' }]

export const END_PUNCT = /[.!?…:;»”"')\]。！？]$/;
const BULLET = /^(?:[•●▪◦‣·∙■□➢►\-–—*]|\d{1,3}[.)]|[a-zа-я][)])\s+/u;

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function extent(boxes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    if (b.x0 < x0) x0 = b.x0; if (b.y0 < y0) y0 = b.y0;
    if (b.x1 > x1) x1 = b.x1; if (b.y1 > y1) y1 = b.y1;
  }
  return { x0, y0, x1, y1 };
}

// Все пустые полосы вдоль оси (с допуском на `noise` пересекающих прямоугольников),
// от самой широкой к самой узкой.
function gaps(boxes, axis, noise) {
  const k0 = axis === 'x' ? 'x0' : 'y0', k1 = axis === 'x' ? 'x1' : 'y1';
  let lo = Infinity, hi = -Infinity;
  for (const b of boxes) { if (b[k0] < lo) lo = b[k0]; if (b[k1] > hi) hi = b[k1]; }
  lo = Math.floor(lo); hi = Math.ceil(hi);
  const n = hi - lo + 2;
  if (n > 20000) return [];
  const diff = new Int32Array(n + 1);
  for (const b of boxes) { diff[Math.floor(b[k0]) - lo]++; diff[Math.ceil(b[k1]) - lo]--; }
  const out = [];
  let cov = 0, start = -1;
  for (let i = 0; i < n; i++) {
    cov += diff[i];
    if (cov <= noise) { if (start < 0) start = i; }
    else if (start >= 0) {
      if (start > 0) out.push({ pos: lo + start + (i - start) / 2, size: i - start });
      start = -1;
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

const cx = (b) => (b.x0 + b.x1) / 2;
const cy = (b) => (b.y0 + b.y1) / 2;

// Просвет между колонками не должен проходить через пробел между словами одной строки
// (например, крупного заголовка во всю ширину).
function splitsALine(L, R, pos) {
  const near = (arr, side) => arr.filter((b) => Math.abs((side < 0 ? b.x1 : b.x0) - pos) < (b.y1 - b.y0) * 4);
  const left = near(L, -1), right = near(R, 1);
  for (const r of right) {
    const hr = r.y1 - r.y0;
    for (const l of left) {
      const hl = l.y1 - l.y0;
      const overlap = Math.min(l.y1, r.y1) - Math.max(l.y0, r.y0);
      if (overlap < Math.min(hl, hr) * 0.5) continue;
      if (r.x0 - l.x1 < Math.max(hl, hr) * 0.75) return true;
    }
  }
  return false;
}

// Сначала ищем вертикальный просвет между колонками (он надёжнее), иначе режем по горизонтали.
function xyCut(boxes, col, medH, out, depth = 0) {
  if (!boxes.length) return;
  if (boxes.length > 1 && depth < 600) {
    const noise = boxes.length > 80 ? 1 : 0;
    for (const g of gaps(boxes, 'x', noise)) {
      if (g.size < medH * 0.7) break;
      const L = [], R = [];
      for (const b of boxes) (cx(b) < g.pos ? L : R).push(b);
      if (L.length < 2 || R.length < 2) continue;
      const eL = extent(L), eR = extent(R);
      const tall = (e) => e.y1 - e.y0 >= medH * 2.5;
      const wide = (e) => e.x1 - e.x0 >= medH * 5;
      if (tall(eL) && tall(eR) && wide(eL) && wide(eR) && !splitsALine(L, R, g.pos)) {
        xyCut(L, { x0: eL.x0, x1: eL.x1 }, medH, out, depth + 1);
        xyCut(R, { x0: eR.x0, x1: eR.x1 }, medH, out, depth + 1);
        return;
      }
    }
    const [h] = gaps(boxes, 'y', 0);
    if (h && h.size >= medH * 0.12) {
      const T = [], B = [];
      for (const b of boxes) (cy(b) < h.pos ? T : B).push(b);
      if (T.length && B.length) {
        xyCut(T, col, medH, out, depth + 1);
        xyCut(B, col, medH, out, depth + 1);
        return;
      }
    }
  }
  out.push({ boxes, col });
}

function joinWords(words) {
  let text = '';
  let prev = null;
  for (const w of words) {
    if (prev) {
      const h = Math.max(w.y1 - w.y0, prev.y1 - prev.y0);
      const spaced = /\s$/.test(text) || /^\s/.test(w.text);
      if (!spaced && (!w.glue || w.x0 - prev.x1 > h * 0.12)) text += ' ';
    }
    text += w.text;
    prev = w;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function linesOf(region) {
  const sorted = [...region.boxes].sort((a, b) => cy(a) - cy(b));
  const lines = [];
  let cur = null;
  for (const b of sorted) {
    const h = b.y1 - b.y0;
    if (cur && Math.abs(cy(b) - cur.yc) < Math.max(h, cur.h) * 0.5) {
      cur.words.push(b);
      cur.hs.push(h);
    } else {
      cur = { words: [b], hs: [h], yc: cy(b), h };
      lines.push(cur);
    }
  }
  return lines.map((l) => {
    l.words.sort((a, b) => a.x0 - b.x0);
    const e = extent(l.words);
    const confs = l.words.map((w) => w.conf).filter((c) => c != null);
    return {
      ...e,
      h: l.words[0].glue ? Math.max(...l.hs) : median(l.hs),
      text: joinWords(l.words),
      conf: confs.length ? confs.reduce((a, c) => a + c, 0) / confs.length : 100,
      col: region.col,
    };
  }).filter((l) => l.text);
}

const joinLines = (a, b) => (/\p{L}[-¬]$/u.test(a) && /^\p{Ll}/u.test(b) ? a.slice(0, -1) + b : a + ' ' + b);

// Большая одиночная буква в начале абзаца приклеивается к первому слову справа.
function attachDropCaps(boxes, medH) {
  const caps = boxes.filter((b) => !b.glue && /^\p{Lu}$/u.test(b.text) && b.y1 - b.y0 > medH * 1.9);
  if (!caps.length) return boxes;
  const rest = boxes.filter((b) => !caps.includes(b));
  for (const c of caps) {
    // Первое слово первой строки справа от буквицы.
    const target = rest
      .filter((w) => w.x0 >= c.x1 - medH && w.x0 < c.x1 + medH * 4 && cy(w) > c.y0 - medH && cy(w) < c.y0 + (c.y1 - c.y0) * 0.6)
      .sort((a, b) => Math.round(cy(a) / medH) - Math.round(cy(b) / medH) || a.x0 - b.x0)[0];
    if (!target) { rest.push(c); continue; }
    const standalone = /^[AIOАВИКОСУЯ]$/u.test(c.text) && !/^\p{Ll}{1,2}$/u.test(target.text);
    target.text = c.text + (standalone ? ' ' : '') + target.text;
  }
  return rest;
}

export function layoutBlocks(rawBoxes, { medH: forcedMedH } = {}) {
  let boxes = rawBoxes.filter((b) => b.text && b.text.trim() && b.x1 > b.x0 && b.y1 > b.y0);
  if (!boxes.length) return [];
  const medH = forcedMedH || median(boxes.map((b) => b.y1 - b.y0)) || 10;
  boxes = attachDropCaps(boxes, medH);

  const regions = [];
  const all = extent(boxes);
  xyCut(boxes, { x0: all.x0, x1: all.x1 }, medH, regions);
  // Строки из одного номера страницы («12», «— 7 —», «xiv») выбрасываем.
  const lines = regions.flatMap(linesOf).filter((l) => !/^[\s\-–—.|·]*(\d{1,4}|(?=[ivxlc]+[\s\-–—.|·]*$)x{0,3}(?:ix|iv|v?i{0,3})|(?=[ivxlc]+[\s\-–—.|·]*$)(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))[\s\-–—.|·]*$/i.test(l.text));

  // Обычный просвет между строками внутри колонки.
  const pitch = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    if (a.col === b.col && b.y0 >= a.y0) pitch.push(b.y0 - a.y1);
  }
  const gapMed = median(pitch.filter((g) => g > -medH && g < medH * 3)) || medH * 0.4;

  // Размер строки: в PDF — кегль, на фото — высота всей строки (у слов без «хвостиков» она меньше).
  const glue = boxes[0].glue;
  const sizeOf = (l) => (glue ? l.h : l.y1 - l.y0);
  const baseSize = glue ? medH : median(lines.map(sizeOf)) || medH;

  // Выключка колонки: по ширине (правый край ровный) или с рваным краем.
  const colInfo = new Map();
  for (const l of lines) {
    if (!colInfo.has(l.col)) colInfo.set(l.col, []);
    colInfo.get(l.col).push(l.x1);
  }
  for (const [col, xs] of colInfo) {
    const sorted = [...xs].sort((a, b) => a - b);
    const right = sorted[Math.floor(sorted.length * 0.9)] ?? col.x1;
    const flush = xs.filter((x) => right - x < medH).length / xs.length;
    colInfo.set(col, { right, justified: flush > 0.6 });
  }
  const isShort = (l) => {
    const info = colInfo.get(l.col);
    if (info.justified) return l.x1 < info.right - medH * 2;
    return l.x1 - l.col.x0 < (info.right - l.col.x0) * 0.6;
  };

  const blocks = [];
  let cur = null, prev = null;
  const push = (k, line) => {
    cur = { k, t: line.text, confs: [line.conf] };
    blocks.push(cur);
  };
  for (const line of lines) {
    const ratio = sizeOf(line) / baseSize;
    const heading = ratio >= (glue ? 1.8 : 2.0) ? 'h1' : ratio >= (glue ? 1.2 : 1.4) ? 'h2' : null;
    const bullet = BULLET.test(line.text);
    const indented = line.x0 > line.col.x0 + medH * 0.8;
    let fresh = !prev;
    if (!fresh) {
      if (heading || (cur.k === 'h1' || cur.k === 'h2')) {
        // Заголовок в несколько строк остаётся одним блоком.
        fresh = !(heading === cur.k && line.y0 - prev.y1 < medH * 1.5 && line.col === prev.col);
      } else if (bullet) fresh = true;
      else if (line.col === prev.col && line.y0 >= prev.y0) {
        const gap = line.y0 - prev.y1;
        if (gap > gapMed + medH * 0.55) fresh = true;
        else if (END_PUNCT.test(prev.text) && (indented || isShort(prev))) fresh = true;
      } else {
        // Переход в следующую колонку: текст обычно продолжается.
        fresh = END_PUNCT.test(prev.text) && (indented || isShort(prev));
      }
    }
    if (fresh) push(heading || (bullet ? 'li' : 'p'), line);
    else { cur.t = joinLines(cur.t, line.text); cur.confs.push(line.conf); }
    prev = line;
  }

  return blocks
    .filter((b) => (b.t.match(/\p{L}/gu) || []).length >= 2 && !/^\d+$/.test(b.t))
    .filter((b) => b.confs.reduce((a, c) => a + c, 0) / b.confs.length >= 45)
    .map(({ k, t }) => ({ k, t }));
}
