import { $, $$, esc, icon, fmt, plural, today } from './util.js';
import { settings } from './state.js';
import { db } from './db.js';
import { langName } from './langs.js';
import { loadLang, counts, dueTerms } from './terms.js';
import { listTexts } from './texts.js';

const METRICS = [
  ['read', 'Прочитано слов'],
  ['added', 'Новых слов в словарь'],
  ['known', 'Стало знакомыми'],
  ['reviews', 'Повторений'],
];

function lastDays(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d);
    x.setDate(d.getDate() - i);
    out.push(today(x));
  }
  return out;
}

function streak(byDate) {
  let s = 0;
  const d = new Date();
  // Сегодня ещё не занимались — серия не сгорает до конца дня.
  if (!active(byDate[today(d)])) d.setDate(d.getDate() - 1);
  while (active(byDate[today(d)])) { s++; d.setDate(d.getDate() - 1); }
  return s;
}
const active = (r) => r && (r.read || r.reviews || r.added || r.known);

export async function renderStats(view) {
  const lang = settings.lang;
  await loadLang(lang);
  const c = counts(lang);
  const days = await db.all('days');
  const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
  const t = byDate[today()] || {};
  const texts = (await listTexts()).filter((x) => x.lang === lang);
  const finished = texts.filter((x) => x.finished).length;
  const totalRead = days.reduce((a, d) => a + (d.read || 0), 0);
  const st = streak(byDate);
  const goal = settings.dailyGoal;
  const goalPct = Math.min(100, Math.round(((t.added || 0) / goal) * 100));
  let metric = 'read';

  view.innerHTML = `
    <section class="page stats">
      <header class="page-head"><div><h1>Прогресс</h1><p class="sub">${esc(langName(lang))}</p></div></header>

      <div class="hero-stat">
        <div class="hero-num">${fmt(c.known)}</div>
        <div class="hero-label">${plural(c.known, 'слово вы знаете', 'слова вы знаете', 'слов вы знаете')}</div>
        <p class="hero-sub">${fmt(c.learning)} в изучении${c.phrases ? `, из них ${fmt(c.phrases)} ${plural(c.phrases, 'фраза', 'фразы', 'фраз')}` : ''}. ${dueTerms(lang).length ? `<a href="#/review">${fmt(dueTerms(lang).length)} ждут повторения</a>` : ''}</p>
      </div>

      <div class="tiles">
        <div class="tile">
          <span class="tile-label">Цель на сегодня</span>
          <span class="tile-num">${fmt(t.added || 0)}<small> из ${goal} новых слов</small></span>
          <span class="bar"><i style="width:${goalPct}%"></i></span>
        </div>
        <div class="tile">
          <span class="tile-label">${icon('flame')} Дней подряд</span>
          <span class="tile-num">${st}</span>
        </div>
        <div class="tile">
          <span class="tile-label">Прочитано сегодня</span>
          <span class="tile-num">${fmt(t.read || 0)}<small> ${plural(t.read || 0, 'слово', 'слова', 'слов')}</small></span>
        </div>
        <div class="tile">
          <span class="tile-label">Всего прочитано</span>
          <span class="tile-num">${fmt(totalRead)}<small> слов, ${finished} ${plural(finished, 'текст', 'текста', 'текстов')}</small></span>
        </div>
      </div>

      <div class="chart-card">
        <div class="chart-head">
          <h2 id="chart-title">Последние 14 дней</h2>
          <div class="seg small" id="metric">${METRICS.map(([k, n]) => `<button data-m="${k}" aria-selected="${k === metric}">${n}</button>`).join('')}</div>
        </div>
        <div class="chart" id="chart"></div>
      </div>
    </section>`;

  const drawChart = () => {
    const keys = lastDays(14);
    const vals = keys.map((k) => byDate[k]?.[metric] || 0);
    const max = Math.max(1, ...vals);
    const nice = niceMax(max);
    const W = 640, H = 220, padL = 36, padB = 26, padT = 10;
    const plotW = W - padL - 8, plotH = H - padB - padT;
    const step = plotW / keys.length;
    const bw = Math.max(6, step - 6);
    const y = (v) => padT + plotH - (v / nice) * plotH;
    const ticks = [0, nice / 2, nice];
    const bars = keys.map((k, i) => {
      const v = vals[i];
      const x = padL + i * step + (step - bw) / 2;
      const h = Math.max(v ? 2 : 0, (v / nice) * plotH);
      const top = padT + plotH - h;
      const r = Math.min(4, h, bw / 2);
      const d = new Date(k + 'T12:00');
      const label = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
      const path = h ? `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${top + h} Z` : '';
      return `
        <g class="bar-g" data-tip="${esc(label)}: ${fmt(v)}">
          <rect class="hit" x="${padL + i * step}" y="${padT}" width="${step}" height="${plotH}" />
          ${path ? `<path class="bar-mark ${k === today() ? 'is-today' : ''}" d="${path}" />` : ''}
          ${i % 2 === (keys.length - 1) % 2 ? `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${d.getDate()}</text>` : ''}
        </g>`;
    }).join('');
    $('#chart', view).innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(METRICS.find((m) => m[0] === metric)[1])} по дням">
        ${ticks.map((v) => `<line class="grid" x1="${padL}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}" /><text class="axis" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${fmtShort(v)}</text>`).join('')}
        ${bars}
      </svg>
      <div class="tip" id="tip" hidden></div>`;
    const tip = $('#tip', view);
    $$('.bar-g', view).forEach((g) => {
      g.addEventListener('pointerenter', () => {
        const box = g.getBoundingClientRect(), host = $('#chart', view).getBoundingClientRect();
        tip.textContent = g.dataset.tip;
        tip.hidden = false;
        tip.style.left = box.left - host.left + box.width / 2 + 'px';
        tip.style.top = '0px';
        g.classList.add('hover');
      });
      g.addEventListener('pointerleave', () => { tip.hidden = true; g.classList.remove('hover'); });
    });
  };

  $('#metric', view).onclick = (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    metric = b.dataset.m;
    $$('[data-m]', view).forEach((x) => x.setAttribute('aria-selected', x === b));
    drawChart();
  };
  drawChart();
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
const fmtShort = (v) => (v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : String(Math.round(v)));
