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

// Строки области: слова с близким центром по вертикали.
function rowsOf(boxes) {
  const sorted = [...boxes].sort((a, b) => cy(a) - cy(b));
  const rows = [];
  let cur = null;
  for (const b of sorted) {
    const h = b.y1 - b.y0;
    if (cur && Math.abs(cy(b) - cur.yc) < Math.max(h, cur.h) * 0.5) { cur.boxes.push(b); cur.h = Math.max(cur.h, h); }
    else { cur = { yc: cy(b), h, boxes: [b] }; rows.push(cur); }
  }
  return rows;
}

// Настоящий промежуток между колонками есть в каждой строке и шире пробела между словами.
// «Реки» из выровненных по ширине пробелов, заголовки во всю ширину и т. п. он отсеивает.
function isGutter(L, R, pos, medH) {
  const rowsL = rowsOf(L).length, rowsR = rowsOf(R).length;
  if (rowsL < 3 || rowsR < 3) return false;
  const dists = [];
  for (const row of rowsOf([...L, ...R])) {
    let l = -Infinity, r = Infinity;
    for (const b of row.boxes) {
      if (cx(b) < pos) l = Math.max(l, b.x1); else r = Math.min(r, b.x0);
    }
    if (l === -Infinity || r === Infinity) continue;
    const d = r - l;
    if (d < row.h * 0.55) return false; // строку режет пробел между словами
    dists.push(d);
  }
  return !dists.length || median(dists) >= medH * 0.9;
}

// Порядок чтения: сначала отрезаем шапку или подвал (заголовок, подпись автора над колонкой),
// потом ищем колонки, иначе режем по горизонтали.
function xyCut(boxes, col, medH, out, depth = 0, noV = false) {
  if (!boxes.length) return;
  if (boxes.length > 1 && depth < 600) {
    const e = extent(boxes);
    const hGaps = gaps(boxes, 'y', 0);
    // Узкий просвет — обычный промежуток между строками одной колонки: внутри таких
    // кусков колонки больше не ищем, иначе случайные «реки» пробелов разрежут строки.
    // Обычный промежуток между строками в этой области (у мелкого шрифта с просторным интервалом он больше).
    const rowGaps = [];
    const rows = rowsOf(boxes).map((r) => extent(r.boxes));
    for (let i = 1; i < rows.length; i++) if (rows[i].y0 > rows[i - 1].y1) rowGaps.push(rows[i].y0 - rows[i - 1].y1);
    const lineGap = median(rowGaps) || 0;
    const splitY = (pos, size) => {
      const T = [], B = [];
      for (const b of boxes) (cy(b) < pos ? T : B).push(b);
      if (!T.length || !B.length) return false;
      const inner = noV || size < Math.max(medH * 0.8, lineGap * 1.5);
      xyCut(T, col, medH, out, depth + 1, inner);
      xyCut(B, col, medH, out, depth + 1, inner);
      return true;
    };
    for (const h of hGaps) {
      if (h.size < medH * 1.2) break;
      const top = h.pos - e.y0, bottom = e.y1 - h.pos;
      if (Math.min(top, bottom) <= medH * 4.5 && Math.max(top, bottom) > medH * 6 && splitY(h.pos, h.size)) return;
    }
    const noise = boxes.length > 80 ? 1 : 0;
    for (const g of noV ? [] : gaps(boxes, 'x', noise)) {
      if (g.size < medH * 0.7) break;
      const L = [], R = [];
      for (const b of boxes) (cx(b) < g.pos ? L : R).push(b);
      if (L.length < 3 || R.length < 3) continue;
      const eL = extent(L), eR = extent(R);
      const wide = (x) => x.x1 - x.x0 >= medH * 5;
      if (wide(eL) && wide(eR) && isGutter(L, R, g.pos, medH)) {
        xyCut(L, { x0: eL.x0, x1: eL.x1 }, medH, out, depth + 1);
        xyCut(R, { x0: eR.x0, x1: eR.x1 }, medH, out, depth + 1);
        return;
      }
    }
    const [h] = hGaps;
    if (h && h.size >= medH * 0.12 && splitY(h.pos, h.size)) return;
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
  // Слово входит в строку, если по высоте заметно перекрывается с её «ядром» (медианой рамок):
  // так раздутая распознавателем рамка не уводит слово в отдельную строку.
  for (const b of sorted) {
    const h = b.y1 - b.y0;
    if (cur) {
      const ov = Math.min(b.y1, cur.y1) - Math.max(b.y0, cur.y0);
      if (ov >= Math.min(h, cur.y1 - cur.y0) * 0.5) {
        cur.words.push(b);
        cur.hs.push(h);
        cur.y0 = median(cur.words.map((w) => w.y0));
        cur.y1 = median(cur.words.map((w) => w.y1));
        continue;
      }
    }
    cur = { words: [b], hs: [h], y0: b.y0, y1: b.y1 };
    lines.push(cur);
  }
  return lines.map((l) => {
    l.words.sort((a, b) => a.x0 - b.x0);
    const e = extent(l.words);
    const confs = l.words.map((w) => w.conf).filter((c) => c != null);
    const chars = l.words.reduce((a, w) => a + w.text.length, 0);
    return {
      ...e,
      cw: chars ? l.words.reduce((a, w) => a + (w.x1 - w.x0), 0) / chars : 0,
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

// Для отладки: на какие области и в каком порядке разрезана страница.
export function debugRegions(rawBoxes) {
  const boxes = rawBoxes.filter((b) => b.text && b.text.trim());
  const medH = median(boxes.map((b) => b.y1 - b.y0)) || 10;
  const regions = [];
  const all = extent(boxes);
  xyCut(attachDropCaps(boxes.map((b) => ({ ...b })), medH), { x0: all.x0, x1: all.x1 }, medH, regions);
  return { medH, regions: regions.map((r) => ({ col: [Math.round(r.col.x0), Math.round(r.col.x1)], text: [...r.boxes].sort((a, b) => cy(a) - cy(b) || a.x0 - b.x0).map((b) => b.text).join(' ').slice(0, 80) })) };
}

// Распознаватель иногда растягивает рамку слова вверх или вниз, на соседнюю строку. Такое слово
// выше соседей по строке (у них общий верх или низ) — подрезаем до их высоты, иначе строки слипнутся.
function fixInflatedBoxes(boxes, medH) {
  if (boxes[0]?.glue) return boxes;
  return boxes.map((b) => {
    const h = b.y1 - b.y0;
    if (h < medH * 1.6) return b;
    const close = (o) => o !== b && Math.min(Math.abs(o.x0 - b.x1), Math.abs(b.x0 - o.x1)) < medH * 6 && o.y1 - o.y0 < h * 0.75;
    const top = boxes.filter((o) => close(o) && Math.abs(o.y0 - b.y0) < medH * 0.4);
    const bottom = boxes.filter((o) => close(o) && Math.abs(o.y1 - b.y1) < medH * 0.4);
    if (top.length >= bottom.length && top.length) return { ...b, y1: b.y0 + median(top.map((o) => o.y1 - o.y0)) };
    if (bottom.length) return { ...b, y0: b.y1 - median(bottom.map((o) => o.y1 - o.y0)) };
    return b;
  });
}

export function layoutBlocks(rawBoxes, { medH: forcedMedH } = {}) {
  let boxes = rawBoxes.filter((b) => b.text && b.text.trim() && b.x1 > b.x0 && b.y1 > b.y0);
  if (!boxes.length) return [];
  const medH = forcedMedH || median(boxes.map((b) => b.y1 - b.y0)) || 10;
  // Мелкие неуверенные обрывки (остатки буквицы, пятна) мешают найти колонки и строки.
  boxes = boxes.filter((b) => b.glue || !(b.conf != null && b.conf < 60 && b.text.trim().length <= 2 && b.y1 - b.y0 < medH * 0.7));
  boxes = fixInflatedBoxes(attachDropCaps(boxes, medH), medH);

  const regions = [];
  const all = extent(boxes);
  xyCut(boxes, { x0: all.x0, x1: all.x1 }, medH, regions);
  // Строки из одного номера страницы («12», «— 7 —», «xiv») выбрасываем.
  const lines = regions.flatMap(linesOf).filter((l) => !/^[\s\-–—.|·]*(\d{1,4}|(?=[ivxlc]+[\s\-–—.|·]*$)x{0,3}(?:ix|iv|v?i{0,3})|(?=[ivxlc]+[\s\-–—.|·]*$)(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))[\s\-–—.|·]*$/i.test(l.text));
  if (!lines.length) return [];

  // Размер строки: в PDF — кегль, на фото — высота всей строки (у слов без «хвостиков» она меньше).
  const glue = boxes[0].glue;
  const sizeOf = (l) => (glue ? l.h : l.y1 - l.y0);

  // У каждой колонки свой кегль, интервал и выключка: на одной странице бывают
  // основной текст и цитата мелким шрифтом.
  const byCol = new Map();
  for (const l of lines) {
    if (!byCol.has(l.col)) byCol.set(l.col, []);
    byCol.get(l.col).push(l);
  }
  const pitchOf = (ls) => {
    const p = [];
    for (let i = 1; i < ls.length; i++) if (ls[i].y0 >= ls[i - 1].y0) p.push(ls[i].y0 - ls[i - 1].y1);
    return p.filter((g) => g > -medH && g < medH * 3);
  };
  const globalSize = glue ? medH : median(lines.map(sizeOf)) || medH;
  const globalGap = median(pitchOf(lines)) || medH * 0.4;
  const colInfo = new Map();
  for (const [col, ls] of byCol) {
    const xs = ls.map((l) => l.x1).sort((a, b) => a - b);
    const right = xs[Math.floor(xs.length * 0.9)] ?? col.x1;
    const flush = ls.filter((l) => right - l.x1 < medH).length / ls.length;
    const many = ls.length >= 4;
    colInfo.set(col, {
      right,
      justified: flush > 0.6,
      size: many && !glue ? median(ls.map(sizeOf)) : globalSize,
      cw: median((many ? ls : lines).map((l) => l.cw)) || 1,
      gap: many ? median(pitchOf(ls)) ?? globalGap : globalGap,
    });

    // Буквица, которую распознавание пропустило: 2–4 строки подряд с большим отступом слева,
    // а дальше обычные строки. Запоминаем это место, чтобы распознать букву отдельно.
    for (let i = 0; i < ls.length; i++) {
      const prevLine = ls[i - 1];
      if (prevLine && !END_PUNCT.test(prevLine.text)) continue;
      let j = i;
      while (j < ls.length && j - i < 4 && ls[j].x0 > col.x0 + medH * 2.5) j++;
      const run = j - i;
      if (run < 2 || !ls[j] || ls[j].x0 > col.x0 + medH) continue;
      const hgt = ls[i].y1 - ls[i].y0;
      ls[i].cap = { x0: col.x0 - medH * 0.6, y0: ls[i].y0 - hgt * 0.5, x1: Math.min(...ls.slice(i, j).map((l) => l.x0)) - medH * 0.1, y1: ls[j - 1].y1 + hgt * 0.35 };
      for (let k = i; k < j; k++) ls[k].inCap = true;
      i = j;
    }
  }
  const isShort = (l) => {
    const info = colInfo.get(l.col);
    if (info.justified) return l.x1 < info.right - medH * 2;
    return l.x1 - l.col.x0 < (info.right - l.col.x0) * 0.6;
  };

  const blocks = [];
  let cur = null, prev = null;
  const push = (k, line) => {
    cur = { k, t: line.text, confs: [line.conf], cap: line.cap };
    blocks.push(cur);
  };
  for (const line of lines) {
    const info = colInfo.get(line.col);
    const ratio = sizeOf(line) / info.size;
    // На фото рамки бывают раздуты — крупный шрифт подтверждаем ещё и шириной букв.
    const wider = glue || line.cw / info.cw >= 1.25;
    const heading = !wider ? null : ratio >= (glue ? 1.8 : 2.0) ? 'h1' : ratio >= (glue ? 1.2 : 1.4) ? 'h2' : null;
    const bullet = BULLET.test(line.text);
    const indented = !line.inCap && line.x0 > line.col.x0 + medH * 0.8;
    // Строка целиком заглавными (подпись автора, рубрика) — всегда отдельный блок.
    const caps = (t) => t.length <= 60 && /\p{L}{3}/u.test(t) && t === t.toLocaleUpperCase();
    let fresh = !prev || !!line.cap || caps(line.text) || caps(prev.text);
    if (!fresh) {
      if (heading || (cur.k === 'h1' || cur.k === 'h2')) {
        // Заголовок в несколько строк остаётся одним блоком.
        fresh = !(heading === cur.k && line.y0 - prev.y1 < medH * 1.5 && line.col === prev.col);
      } else if (bullet) fresh = true;
      else if (line.col === prev.col && line.y0 >= prev.y0) {
        const gap = line.y0 - prev.y1;
        if (gap > info.gap + medH * 0.55) fresh = true;
        else if (END_PUNCT.test(prev.text) && (indented || isShort(prev))) fresh = true;
      } else {
        // Переход из конца колонки в начало следующей (правее) — текст обычно продолжается.
        // Из шапки или подписи над колонками в текст — новый блок.
        const flows = line.col.x0 > prev.col.x0 + medH && byCol.get(prev.col)?.at(-1) === prev && byCol.get(line.col)?.[0] === line;
        fresh = !flows || (END_PUNCT.test(prev.text) && (indented || isShort(prev)));
      }
    }
    if (fresh) push(heading || (bullet ? 'li' : 'p'), line);
    else { cur.t = joinLines(cur.t, line.text); cur.confs.push(line.conf); }
    prev = line;
  }

  return blocks
    .filter((b) => (b.t.match(/\p{L}/gu) || []).length >= 2 && !/^\d+$/.test(b.t))
    .filter((b) => b.confs.reduce((a, c) => a + c, 0) / b.confs.length >= 45)
    .map(({ k, t, cap }) => (cap ? { k, t, cap } : { k, t }));
}
