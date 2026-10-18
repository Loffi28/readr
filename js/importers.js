// Импорт: текст, TXT/MD/SRT/VTT/HTML, PDF (в т.ч. сканы), EPUB, FB2, DOCX, фото (OCR), веб-страница.
// Каждый импортёр возвращает { title, blocks: [{ k, t }], source }, где k — вид блока:
// p — абзац, h1/h2/h3 — заголовки, li — пункт списка, quote — цитата, verse — строка стиха.
import { loadScript } from './util.js';
import { langByCode } from './langs.js';
import { layoutBlocks, END_PUNCT } from './layout.js';

const CDN = {
  pdf: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/legacy/build/pdf.min.mjs',
  pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/legacy/build/pdf.worker.min.mjs',
  tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  jszip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
};

const BULLET = /^(?:[•●▪◦‣·∙■□➢►\-–—*]|\d{1,3}[.)])\s+/u;
const P = (t) => ({ k: 'p', t });
const clean1 = (s) => s.replace(/\s+/g, ' ').trim();
const joinLines = (a, b) => (/\p{L}[-¬]$/u.test(a) && /^\p{Ll}/u.test(b) ? a.slice(0, -1) + b : a + ' ' + b);

// ---------- Простой текст ----------
// Склеивает строки, разорванные переносом; узнаёт заголовки, списки и стихи.
export function reflow(text) {
  const src = text.replace(/\r\n?/g, '\n').replace(/­/g, '').replace(/\t/g, ' ').replace(/[  ]{2,}/g, ' ');
  const out = [];
  for (const block of src.split(/\n[ \t]*\n+/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    // Короткая одиночная строка без точки — заголовок («Chapter 1», «Глава вторая»).
    if (lines.length === 1 && lines[0].length <= 70 && lines[0].split(' ').length <= 10
      && !END_PUNCT.test(lines[0]) && !/[,\-–]$/.test(lines[0]) && /\p{L}/u.test(lines[0]) && !BULLET.test(lines[0])) {
      out.push({ k: 'h2', t: lines[0] });
      continue;
    }
    // Список.
    if (lines.filter((l) => BULLET.test(l)).length >= Math.max(1, lines.length * 0.5) && BULLET.test(lines[0])) {
      for (const l of lines) {
        if (BULLET.test(l)) out.push({ k: 'li', t: l.replace(/^[•●▪◦‣·∙■□➢►\-–—*]\s+/u, '') });
        else out[out.length - 1].t = joinLines(out[out.length - 1].t, l);
      }
      continue;
    }
    const sorted = lines.map((l) => l.length).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const openEnds = lines.filter((l) => !END_PUNCT.test(l)).length;
    const hardWrapped = lines.length > 1 && median >= 35 && openEnds >= lines.length * 0.4;

    if (hardWrapped) {
      let para = '';
      for (const line of lines) {
        para = para ? joinLines(para, line) : line;
        if (END_PUNCT.test(line) && line.length < median * 0.6) { out.push(P(para)); para = ''; }
      }
      if (para) out.push(P(para));
      continue;
    }
    // Короткие строки подряд — стихи или песня.
    if (lines.length >= 3 && sorted[sorted.length - 1] <= 60 && lines.some((l) => /^\p{Lu}/u.test(l))) {
      lines.forEach((l) => out.push({ k: 'verse', t: l }));
      out[out.length - 1].end = true;
      continue;
    }
    // Иначе каждая строка — абзац, но строку, оборванную на полуслове, продолжаем.
    for (const line of lines) {
      const prev = out[out.length - 1];
      if (prev && prev.k === 'p' && !END_PUNCT.test(prev.t) && /^\p{Ll}/u.test(line)) prev.t = joinLines(prev.t, line);
      else out.push(P(line));
    }
  }
  return out.filter((b) => b.t.trim());
}

function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1251').decode(buf); }
}

const baseName = (name) => name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();

const stripInline = (s) => s
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/(\*\*|__)(.+?)\1/g, '$2')
  .replace(/(\*|_)(.+?)\1/g, '$2')
  .replace(/`([^`]+)`/g, '$1');

function fromMarkdown(md) {
  const out = [];
  const src = md.replace(/\r\n?/g, '\n').replace(/```[\s\S]*?```/g, '');
  for (const block of src.split(/\n\s*\n+/)) {
    const lines = block.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length || /^([-*_=]\s*){3,}$/.test(lines[0].trim())) continue;
    const head = lines[0].match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      out.push({ k: head[1].length === 1 ? 'h1' : head[1].length === 2 ? 'h2' : 'h3', t: stripInline(head[2]) });
      if (lines.length > 1) out.push(...reflow(stripInline(lines.slice(1).join('\n'))));
      continue;
    }
    if (lines.every((l) => /^\s*>/.test(l))) {
      out.push({ k: 'quote', t: clean1(stripInline(lines.map((l) => l.replace(/^\s*>\s?/, '')).join(' '))) });
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(lines[0])) {
      for (const l of lines) {
        const m = l.match(/^\s*(?:[-*+]|(\d+[.)]))\s+(.*)$/);
        if (m) out.push({ k: 'li', t: stripInline((m[1] ? m[1] + ' ' : '') + m[2]) });
        else if (out.length) out[out.length - 1].t += ' ' + stripInline(l.trim());
      }
      continue;
    }
    out.push(...reflow(stripInline(lines.join('\n'))));
  }
  return out;
}

function fromSubtitles(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) =>
    l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^WEBVTT/.test(l) && !/^(NOTE|STYLE)\b/.test(l));
  const plain = lines.map((l) => l.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim()).filter(Boolean);
  // Реплики склеиваем в абзацы по ~5 штук.
  const out = [];
  for (let i = 0; i < plain.length; i += 5) out.push(P(plain.slice(i, i + 5).join(' ')));
  return out;
}

// ---------- HTML / EPUB / DOCX ----------
const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,dt,dd,figcaption,td';
const TAG_KIND = { h1: 'h1', h2: 'h1', h3: 'h2', h4: 'h3', h5: 'h3', h6: 'h3', li: 'li', dt: 'h3', blockquote: 'quote' };

export function blocksFromDom(root) {
  if (!root) return [];
  root.querySelectorAll('script,style,nav,noscript,svg,footer,aside,form,button,sup.noteref,a.noteref').forEach((n) => n.remove());
  const els = [...root.querySelectorAll(BLOCK_SEL)].filter((el) => !el.querySelector(BLOCK_SEL));
  if (!els.length) return reflow(root.textContent || '');
  const out = [];
  for (const el of els) {
    const t = clean1(el.textContent);
    if (!t) continue;
    let k = TAG_KIND[el.localName] || 'p';
    if (k === 'p' && el.closest('blockquote')) k = 'quote';
    if (k === 'p' && /\b(title|heading|chapter|head)\b/i.test(el.className) && t.length < 120) k = 'h2';
    // Стихи в EPUB часто свёрстаны как <p class="line"> / <span class="verse">.
    if (k === 'p' && /\b(verse|poem|stanza|line)\b/i.test(el.className + ' ' + (el.parentElement?.className || ''))) k = 'verse';
    out.push({ k, t });
  }
  return out;
}

async function fromHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return { title: doc.title, blocks: blocksFromDom(doc.body) };
}

async function fromEpub(file, { onProgress }) {
  await loadScript(CDN.jszip);
  const zip = await window.JSZip.loadAsync(file);
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const container = xml(await zip.file('META-INF/container.xml').async('string'));
  const opfPath = container.querySelector('rootfile').getAttribute('full-path');
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = xml(await zip.file(opfPath).async('string'));
  const title = opf.getElementsByTagNameNS('*', 'title')[0]?.textContent?.trim() || baseName(file.name);
  const manifest = {};
  opf.querySelectorAll('manifest > item').forEach((it) => { manifest[it.getAttribute('id')] = it.getAttribute('href'); });
  const spine = [...opf.querySelectorAll('spine > itemref')].map((r) => manifest[r.getAttribute('idref')]).filter(Boolean);
  const blocks = [];
  for (let i = 0; i < spine.length; i++) {
    onProgress?.(`Глава ${i + 1} из ${spine.length}`, (i + 1) / spine.length);
    const path = decodeURIComponent(dir + spine[i]).replace(/[^/]+\/\.\.\//g, '');
    const f = zip.file(path);
    if (!f) continue;
    const doc = new DOMParser().parseFromString(await f.async('string'), 'text/html');
    blocks.push(...blocksFromDom(doc.body));
  }
  return { title, blocks, source: 'epub' };
}

async function fromFb2(text, name) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const title = doc.getElementsByTagName('book-title')[0]?.textContent?.trim() || baseName(name);
  const bodies = [...doc.getElementsByTagName('body')].filter((b) => b.getAttribute('name') !== 'notes');
  const blocks = [];
  const depth = (el) => { let d = 0; for (let p = el.parentElement; p; p = p.parentElement) if (p.localName === 'section') d++; return d; };
  for (const body of bodies) {
    for (const el of body.getElementsByTagName('*')) {
      const name = el.localName;
      const t = clean1(el.textContent);
      if (!t) continue;
      if (name === 'title') blocks.push({ k: depth(el) <= 1 ? 'h1' : 'h2', t });
      else if (el.parentElement?.localName === 'title') continue;
      else if (name === 'subtitle') blocks.push({ k: 'h3', t });
      else if (name === 'v') blocks.push({ k: 'verse', t });
      else if (name === 'text-author') blocks.push({ k: 'quote', t });
      else if (name === 'p') blocks.push({ k: el.closest('epigraph, cite') ? 'quote' : 'p', t });
    }
  }
  return { title, blocks, source: 'fb2' };
}

async function fromDocx(file) {
  await loadScript(CDN.mammoth);
  const { value } = await window.mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  const doc = new DOMParser().parseFromString(value, 'text/html');
  return { title: baseName(file.name), blocks: blocksFromDom(doc.body), source: 'docx' };
}

// ---------- PDF ----------
let pdfjs;
async function loadPdf() {
  if (!pdfjs) {
    pdfjs = await import(CDN.pdf);
    pdfjs.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
  }
  return pdfjs;
}

// Колонтитулы: одинаковые строки (с точностью до цифр) вверху или внизу многих страниц.
function dropRunningHeads(pages) {
  if (pages.length < 3) return pages;
  const norm = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const freq = new Map();
  for (const blocks of pages) {
    const edge = new Set([...blocks.slice(0, 2), ...blocks.slice(-2)].map((b) => norm(b.t)));
    edge.forEach((n) => freq.set(n, (freq.get(n) || 0) + 1));
  }
  const limit = Math.max(3, pages.length * 0.4);
  return pages.map((blocks) => blocks.filter((b, i) => {
    const atEdge = i < 2 || i >= blocks.length - 2;
    return !(atEdge && (freq.get(norm(b.t)) || 0) >= limit && b.t.length < 120);
  }));
}

// Склеиваем абзац, оборванный на краю страницы или фото.
function joinPages(pages) {
  const out = [];
  for (const blocks of pages) {
    const first = blocks[0];
    const last = out[out.length - 1];
    if (first && last && last.k === 'p' && first.k === 'p' && !END_PUNCT.test(last.t) && /^\p{Ll}/u.test(first.t)) {
      last.t = joinLines(last.t, first.t);
      out.push(...blocks.slice(1));
    } else out.push(...blocks);
  }
  return out;
}

async function fromPdf(file, { lang, onProgress, ocr }) {
  const lib = await loadPdf();
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  let title = baseName(file.name);
  try { const meta = await pdf.getMetadata(); if (meta?.info?.Title?.trim()) title = meta.info.Title.trim(); } catch {}

  const pagesBoxes = [];
  const heights = [];
  let chars = 0;
  for (let p = 1; p <= pdf.numPages; p++) {
    onProgress?.(`Читаю страницу ${p} из ${pdf.numPages}`, p / pdf.numPages);
    const page = await pdf.getPage(p);
    const H = page.getViewport({ scale: 1 }).height;
    const tc = await page.getTextContent();
    const boxes = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const [a, b, c, d, e, f] = it.transform;
      if (Math.abs(b) > Math.abs(a) * 0.2) continue; // повёрнутый текст на полях
      const h = Math.hypot(c, d) || it.height || 10;
      boxes.push({ text: it.str, x0: e, x1: e + (it.width || h * it.str.length * 0.5), y0: H - f - h * 0.8, y1: H - f + h * 0.2, glue: true });
      heights.push([h, it.str.length]);
      chars += it.str.trim().length;
    }
    pagesBoxes.push(boxes);
  }

  // Почти нет текстового слоя — это скан, распознаём как картинки.
  if (chars < pdf.numPages * 40 || ocr) {
    const canvases = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      onProgress?.(`Готовлю скан страницы ${p} из ${pdf.numPages}`, p / pdf.numPages);
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      canvases.push(canvas);
    }
    return { title, blocks: await recognize(canvases, lang, onProgress), source: 'scan' };
  }

  // Основной кегль документа — взвешенная медиана по количеству символов.
  heights.sort((x, y) => x[0] - y[0]);
  const total = heights.reduce((s, x) => s + x[1], 0);
  let acc = 0, medH = 10;
  for (const [h, n] of heights) { acc += n; if (acc >= total / 2) { medH = h; break; } }

  const pages = pagesBoxes.map((boxes) => layoutBlocks(boxes, { medH }));
  return { title, blocks: joinPages(dropRunningHeads(pages)), source: 'pdf' };
}

// ---------- Фото и сканы ----------
// Поворачиваем по EXIF (фото с iPhone) и уменьшаем огромные снимки, чтобы распознавание не падало.
async function toCanvas(src, maxSide = 3000) {
  if (src instanceof HTMLCanvasElement) return src;
  let bmp;
  try { bmp = await createImageBitmap(src, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(src);
    bmp = new Image();
    bmp.src = url;
    await bmp.decode();
    URL.revokeObjectURL(url);
  }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas;
}

function wordsOf(data) {
  if (data.words?.length) return data.words;
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) out.push(...(l.words || []));
  return out;
}

export async function recognize(images, lang, onProgress) {
  await loadScript(CDN.tesseract);
  const code = langByCode(lang).tess;
  let idx = 0;
  onProgress?.('Загружаю распознавание текста (один раз, ~10 МБ)', 0);
  const worker = await window.Tesseract.createWorker(code, 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress?.(`Распознаю ${idx + 1} из ${images.length}`, (idx + m.progress) / images.length);
      else if (/loading|initializ/.test(m.status)) onProgress?.('Загружаю язык распознавания…', m.progress || 0);
    },
  });
  const pages = [];
  try {
    for (idx = 0; idx < images.length; idx++) {
      onProgress?.(`Готовлю изображение ${idx + 1} из ${images.length}`, idx / images.length);
      const canvas = await toCanvas(images[idx]);
      const { data } = await worker.recognize(canvas, { rotateAuto: true }, { text: true, blocks: true });
      const boxes = wordsOf(data)
        .filter((w) => w.confidence >= 20 && (w.confidence >= 50 || /\p{L}/u.test(w.text)))
        .map((w) => ({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, conf: w.confidence }));
      pages.push(boxes.length ? layoutBlocks(boxes) : reflow(data.text || ''));
    }
  } finally { await worker.terminate(); }
  return joinPages(pages);
}

// ---------- Точки входа ----------
export async function importFile(file, opts = {}) {
  const name = file.name.toLowerCase();
  const ext = name.split('.').pop();
  if (file.type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'bmp', 'gif'].includes(ext)) {
    return { title: baseName(file.name), blocks: await recognize([file], opts.lang, opts.onProgress), source: 'photo' };
  }
  if (ext === 'pdf') return fromPdf(file, opts);
  if (ext === 'epub') return fromEpub(file, opts);
  if (ext === 'docx') return fromDocx(file);
  if (ext === 'zip') {
    await loadScript(CDN.jszip);
    const zip = await window.JSZip.loadAsync(file);
    const fb2 = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith('.fb2'));
    if (!fb2) throw new Error('В архиве нет файла FB2');
    return fromFb2(decodeText(await fb2.async('uint8array')), fb2.name);
  }
  const text = decodeText(await file.arrayBuffer());
  if (ext === 'fb2') return fromFb2(text, file.name);
  if (ext === 'srt' || ext === 'vtt') return { title: baseName(file.name), blocks: fromSubtitles(text), source: 'subs' };
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return { ...(await fromHtml(text)), title: baseName(file.name), source: 'web' };
  if (ext === 'md' || ext === 'markdown') return { title: baseName(file.name), blocks: fromMarkdown(text), source: 'text' };
  return { title: baseName(file.name), blocks: reflow(text), source: 'text' };
}

export async function importImages(files, opts = {}) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const blocks = await recognize(sorted, opts.lang, opts.onProgress);
  const d = new Date();
  const first = blocks.find((b) => b.k === 'h1' || b.k === 'h2');
  return {
    title: first?.t.slice(0, 80) || `Фото ${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`,
    blocks, source: 'photo',
  };
}

export async function importUrl(url) {
  // Публичный сервис r.jina.ai достаёт чистый текст статьи и разрешает запросы из браузера.
  const r = await fetch('https://r.jina.ai/' + url, { headers: { Accept: 'text/plain' } });
  if (!r.ok) throw new Error('Страница не открылась (HTTP ' + r.status + ')');
  const raw = await r.text();
  const title = raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || new URL(url).hostname;
  const body = raw.split(/^Markdown Content:\s*$/m)[1] ?? raw;
  return { title, blocks: fromMarkdown(body), source: 'web', url };
}

export function importPlain(text, title) {
  const looksMd = /^#{1,6}\s|\n#{1,6}\s|\n\s*[-*]\s/.test(text);
  const blocks = looksMd ? fromMarkdown(text) : reflow(text);
  return { title: title || (blocks[0]?.t || 'Без названия').slice(0, 60), blocks, source: 'text' };
}

export const ACCEPT = '.txt,.md,.pdf,.epub,.fb2,.zip,.docx,.srt,.vtt,.html,.htm,image/*';
