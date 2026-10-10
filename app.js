'use strict';

/* ---------- constants & state ---------- */
const KEY = 'gentle-taper-v1';
const SYMS = [
  ['headache', 'Headache'], ['fatigue', 'Fatigue'], ['irritability', 'Irritability'],
  ['nausea', 'Nausea'], ['focus', 'Trouble focusing'], ['mood', 'Low mood'],
];
const SEV = ['None', 'Mild', 'Moderate', 'Strong'];
const TYPES = ['Soda', 'Coffee', 'Tea', 'Energy drink', 'Sparkling water', 'Other'];
const TYPE_MG = { 'Soda': 40, 'Coffee': 95, 'Tea': 47, 'Energy drink': 80, 'Sparkling water': 0, 'Other': 0 };
const CONTAINERS = ['Can', 'Bottle', 'Cup', 'Shot', 'Glass'];
const cv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function defaults() {
  return { plan: null, pastPlans: [], hist: {}, logs: {}, sym: {}, settings: { remind: false, time: '09:00', lastNotified: '', canMg: 40, theme: 'auto', presets: [
    { id: 'soda', name: 'Soda', type: 'Soda', container: 'Bottle', oz: 20, mg: 57, fav: true },
    { id: 'coffee', name: 'Coffee', type: 'Coffee', container: 'Cup', oz: 8, mg: 95, fav: true },
    { id: 'energy', name: 'Energy drink', type: 'Energy drink', container: 'Can', oz: 16, mg: 160, fav: false },
    { id: 'tea', name: 'Tea', type: 'Tea', container: 'Cup', oz: 8, mg: 47, fav: false },
  ] } };
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) { const d = defaults(); return Object.assign(d, s, { settings: Object.assign(d.settings, s.settings) }); }
  } catch (e) { /* fall through */ }
  return defaults();
}
let S = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Could not save on this device'); }
}

/* ---------- dates ---------- */
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => fmt(new Date());
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
const diff = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const nice = s => parse(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const short = s => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- plan logic ---------- */
function gen(from, n) {
  return Array.from({ length: n }, (_, i) => (n === 1 ? 0 : Math.round(from * (1 - i / (n - 1)))));
}
function planIdx(date) {
  const p = S.plan; if (!p || date < p.start) return null;
  let i = diff(p.start, date);
  if (p.pausedAt) i = Math.min(i, diff(p.start, p.pausedAt));
  return i;
}
function targetRaw(date) {
  const i = planIdx(date); if (i === null) return null;
  const t = S.plan.targets;
  return t[Math.min(i, t.length - 1)];
}
// Past days stay frozen at what the target was then, so reshaping the plan never rewrites history.
function snapshot() {
  const p = S.plan; if (!p) return;
  const t = today();
  for (let d = p.start, guard = 0; d <= t && guard < 800; d = addDays(d, 1), guard++) {
    if (d === t || S.hist[d] == null) S.hist[d] = targetRaw(d);
  }
}
function target(date) {
  if (date < today() && S.hist[date] != null) return S.hist[date];
  return targetRaw(date);
}

/* ---------- ui state ---------- */
const ui = { newOpen: false, moreOpen: false, view: 'today', date: today(), range: 14, symSel: new Set(['avg']), showDecaf: false };

/* ---------- decoration ---------- */
function vineSVG(horizontal) {
  const leaf = (x, y, r, s, c) => `<path transform="translate(${x} ${y}) rotate(${r}) scale(${s})" d="M0 0C6-9 18-9 26 0C18 9 6 9 0 0Z" fill="${c}"/>`;
  const bloom = (x, y) => `<g transform="translate(${x} ${y})">${[0, 72, 144, 216, 288].map(a => `<ellipse cx="0" cy="-5" rx="3.4" ry="5" transform="rotate(${a})" fill="#f2b8c6"/>`).join('')}<circle r="2.3" fill="#fbe7a8"/></g>`;
  const greens = ['#a9c3a3', '#8fb08a', '#bfd3b8', '#9dbb97'];
  let stem = [], parts = [];
  for (let y = 0; y <= 400; y += 8) stem.push(`${y ? 'L' : 'M'}${(30 + 13 * Math.sin(y / 200 * 2 * Math.PI)).toFixed(1)} ${y}`);
  for (let k = 0; k < 10; k++) {
    const y = 20 + k * 40, x = 30 + 13 * Math.sin(y / 200 * 2 * Math.PI), side = k % 2 ? 1 : -1;
    parts.push(leaf(x, y, side > 0 ? 30 : 150, .85 + (k % 3) * .12, greens[k % 4]));
    if (k % 3 === 1) parts.push(bloom(x + side * 14, y + 12));
    if (k % 3 === 2) parts.push(leaf(x, y + 14, side > 0 ? -20 : 200, .6, greens[(k + 1) % 4]));
  }
  const body = `<path d="${stem.join('')}" fill="none" stroke="#93b08d" stroke-width="2" stroke-linecap="round"/>${parts.join('')}`;
  return horizontal
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 60"><g transform="translate(0 60) rotate(-90)">${body}</g></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 400">${body}</svg>`;
}
function applyDecor() {
  const url = svg => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  const r = document.documentElement.style;
  r.setProperty('--vine', url(vineSVG(false)));
  r.setProperty('--vine-h', url(vineSVG(true)));
}

/* ---------- helpers ---------- */
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}
const n1 = v => String(Math.round(v * 10) / 10);
function drinkMg(d) { const dr = S.logs[d]?.drinks || {}; return Object.values(dr).reduce((a, x) => a + x.n * x.mg, 0); }
function totalMg(d) { const L = S.logs[d]; return L ? Math.round(L.caf * S.settings.canMg + drinkMg(d)) : 0; }
// Everything caffeinated, expressed in "cans" so it can be compared with the daily target.
function total(d) { const L = S.logs[d]; return L ? Math.round((L.caf + drinkMg(d) / S.settings.canMg) * 10) / 10 : null; }
function setDrink(d, p, delta) {
  const L = Object.assign({ caf: 0, decaf: 0 }, S.logs[d]); const dr = Object.assign({}, L.drinks);
  const cur = dr[p.id] || { n: 0, mg: p.mg, name: p.name };
  const n = clamp(cur.n + delta, 0, 99);
  if (n) dr[p.id] = { n, mg: cur.n === 0 ? p.mg : cur.mg, name: p.name, type: p.type || '', container: p.container || '' }; else delete dr[p.id];
  setLog(d, { drinks: dr });
}
function setLog(d, patch) { S.logs[d] = Object.assign({ caf: 0, decaf: 0 }, S.logs[d], patch); save(); }
function setSym(d, patch) { S.sym[d] = Object.assign({}, S.sym[d], patch); save(); }

/* ---------- views ---------- */
function render() {
  snapshot();
  const y = window.scrollY;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === ui.view));
  const sub = document.getElementById('subtitle');
  const p = S.plan;
  sub.textContent = !p ? 'A soft landing, one day at a time'
    : p.pausedAt ? 'Taper paused — rest is part of the plan'
    : `Day ${Math.min(planIdx(today()) + 1, p.targets.length) || 1} of ${p.targets.length}`;
  const v = { today: vToday, plan: vPlan, progress: vProgress, settings: vSettings }[ui.view];
  document.getElementById('app').innerHTML = v();
  window.scrollTo(0, y);
}

function stepper(act, val, cls, extra = '') {
  return `<div class="stepper">
    <button class="round" data-act="${act}-" ${extra} aria-label="less">−</button>
    <span class="n">${val}</span>
    <button class="round plus ${cls || ''}" data-act="${act}+" ${extra} aria-label="more">+</button></div>`;
}

function vToday() {
  const d = ui.date, t = target(d), L = S.logs[d], Y = S.sym[d] || {};
  const caf = L ? L.caf : 0, dec = L ? L.decaf : 0, isToday = d === today();
  const tot = total(d) ?? 0, mg = totalMg(d), dr = L?.drinks || {};
  let hero;
  if (t == null) {
    hero = `<div class="card hero"><div class="lbl">No target set for this day</div>
      <div class="status">${S.plan ? 'This is before your taper began.' : 'Set up a taper in the Plan tab to see daily targets.'}</div></div>`;
  } else {
    const logged = !!L;
    let msg = '';
    if (logged) msg = tot <= t ? (tot < t ? 'Under target — lovely.' : 'Right on target.') : 'A little over — that’s okay. Tomorrow is a fresh leaf.';
    else if (t === 0) msg = 'Today is a caffeine-free day.';
    hero = `<div class="card hero"><div class="lbl">${isToday ? 'Today’s' : 'That day’s'} target</div>
      <div class="big">${t}</div><div class="lbl">caffeinated ${t === 1 ? 'can' : 'cans'}</div>
      ${msg ? `<div class="status ${logged && tot > t ? 'over' : ''}">${msg}</div>` : ''}</div>`;
  }
  return `
    <div class="datenav">
      <button class="round" data-act="prev" aria-label="Previous day">‹</button>
      <div class="d">${isToday ? 'Today' : nice(d).split(',')[0]}<small>${nice(d)}</small></div>
      <button class="round" data-act="next" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
    </div>
    ${hero}
    <div class="card"><h2>Cans I had</h2>
      <div class="counter"><div class="name">Caffeinated cans<small>quick count, no details</small></div>${stepper('caf', caf)}</div>
      <div class="counter"><div class="name">Caffeine-free<small>just for the record</small></div>${stepper('dec', dec, 'sage')}</div>
    </div>
    ${drinksCard(d, t)}
    <div class="card"><h2>How am I feeling?</h2>
      ${SYMS.map(([k, name]) => `<div class="sym"><div class="nm">${name}</div>
        <div class="seg">${SEV.map((s, v) => `<button data-act="sev" data-k="${k}" data-v="${v}" class="${(Y[k] ?? 0) === v ? 'on' : ''}">${s}</button>`).join('')}</div></div>`).join('')}
      <label class="f" for="notes">Notes (optional)</label>
      <textarea id="notes" placeholder="Anything worth remembering…">${esc(Y.notes || '')}</textarea>
    </div>
    <button class="btn rose block" data-act="savecheck">${L && Y.done ? 'Update check-in' : 'Save today’s check-in'}</button>`;
}

const isFav = p => p.fav !== false;
const drinkLine = p => [p.type, p.container, p.oz ? p.oz + ' oz' : '', p.mg + ' mg'].filter(Boolean).join(' · ');
function drinkRow(p, dr) {
  return `<div class="counter"><div class="name"><span class="nm1"><button class="star ${isFav(p) ? 'on' : ''}" data-act="fav" data-id="${esc(p.id)}" aria-label="Toggle favorite">★</button>${esc(p.name)}</span><small>${esc(drinkLine(p))}</small></div>${stepper('dr', dr[p.id]?.n || 0, '', `data-id="${esc(p.id)}"`)}</div>`;
}
function drinksCard(d, t) {
  const L = S.logs[d], dr = L?.drinks || {}, P = S.settings.presets;
  const favs = P.filter(isFav), others = P.filter(p => !isFav(p));
  const open = ui.moreOpen || others.some(p => dr[p.id]);
  const opt = (arr, sel) => arr.map(x => `<option ${x === sel ? 'selected' : ''}>${x}</option>`).join('');
  const form = ui.newOpen ? `<div class="newdrink">
      <label class="f" for="nd-name">What is it?</label>
      <input id="nd-name" type="text" placeholder="e.g. Diet Coke, iced latte" maxlength="40">
      <div class="two"><div><label class="f" for="nd-type">Type</label><select id="nd-type">${opt(TYPES, 'Soda')}</select></div>
        <div><label class="f" for="nd-cont">Container</label><select id="nd-cont">${opt(CONTAINERS, 'Can')}</select></div></div>
      <div class="two"><div><label class="f" for="nd-oz">Size (oz, optional)</label><input id="nd-oz" type="number" inputmode="decimal" min="0" max="128" placeholder="12"></div>
        <div><label class="f" for="nd-mg">Caffeine (mg)</label><input id="nd-mg" type="number" inputmode="numeric" min="0" max="1000" value="${TYPE_MG.Soda}"></div></div>
      <div class="switch"><label for="nd-fav">Add to my favorites</label><input id="nd-fav" type="checkbox" checked></div>
      <div class="btns"><button class="btn rose" data-act="savedrink">Save &amp; log one</button><button class="btn ghost" data-act="newdrink">Cancel</button></div>
    </div>` : '';
  return `<div class="card"><h2>Drinks</h2>
      <p class="muted" style="margin-top:-4px">Tap ★ to pin a drink as a favorite. Each counts toward your target by caffeine amount.</p>
      ${favs.length ? favs.map(p => drinkRow(p, dr)).join('') : '<p class="muted">No favorites yet — star a drink below or add a new one.</p>'}
      ${others.length ? `<details class="more" ${open ? 'open' : ''}><summary>More drinks (${others.length})</summary>${others.map(p => drinkRow(p, dr)).join('')}</details>` : ''}
      ${ui.newOpen ? form : '<div class="btns"><button class="btn ghost" data-act="newdrink">+ New drink</button></div>'}
      <div class="totals"><b>${totalMg(d)} mg</b> caffeine today<br><span class="muted">≈ ${n1(total(d) ?? 0)} can-equivalents${t != null ? ` · target ${t}` : ''}</span></div>
    </div>`;
}

function vPlan() {
  const p = S.plan;
  if (!p) return `<div class="card"><h2>Start a taper</h2><p class="muted">Pick where you are now and how long you’d like to take. You can change any of it later.</p>${setupForm()}</div>`;
  const ti = planIdx(today()), t = today();
  const rows = p.targets.map((v, i) => {
    const date = addDays(p.start, i), past = i < ti, now = i === ti;
    return `<div class="sched ${past ? 'past' : ''} ${now ? 'now' : ''}">
      <div class="dl">Day ${i + 1}<small>${short(date)}${now ? ' · today' : ''}</small></div>
      ${past ? `<span class="n" style="font-family:var(--font-head);font-size:22px">${S.hist[date] ?? v}</span>`
        : `<div class="stepper"><button class="round" data-act="ed-" data-i="${i}">−</button><span class="n">${v}</span><button class="round plus" data-act="ed+" data-i="${i}">+</button></div>`}
    </div>`;
  }).join('');
  const cur = target(t) ?? 0;
  return `
    <div class="card">
      <div class="row"><h2 style="margin:0">Your taper</h2>${p.pausedAt ? '<span class="pill">Paused</span>' : '<span class="pill sage">Active</span>'}</div>
      <p class="muted">${p.targets[0]} cans → 0 over ${p.targets.length} days · started ${short(p.start)}${p.pausedAt ? ` · paused since ${short(p.pausedAt)}` : ''}</p>
      <div class="btns">
        <button class="btn ${p.pausedAt ? 'rose' : 'ghost'}" data-act="${p.pausedAt ? 'resume' : 'pause'}">${p.pausedAt ? 'Resume taper' : 'Pause taper'}</button>
      </div>
    </div>
    <details class="card"><summary>Adjust from today</summary>
      <p class="muted">Re-spreads the remaining steps. Past days and your logs are untouched.</p>
      <label class="f" for="adjFrom">Cans per day, starting today</label>
      <input id="adjFrom" type="number" inputmode="numeric" min="0" max="30" value="${cur}">
      <label class="f" for="adjDays">Days from today until zero</label>
      <input id="adjDays" type="number" inputmode="numeric" min="1" max="365" value="${Math.max(p.targets.length - 1 - (ti ?? 0), 1)}">
      <div class="btns"><button class="btn" data-act="adjust">Apply</button></div>
    </details>
    <details class="card"><summary>Restart a new taper</summary>
      <p class="muted">Begins a fresh plan today. All past logs and symptom history are kept.</p>
      ${setupForm()}
    </details>
    <div class="card"><h2>Day-by-day targets</h2>
      <p class="muted">Tap − / + to change any upcoming day.</p>${rows}</div>`;
}
function setupForm() {
  return `<label class="f" for="stCans">Caffeinated cans per day now</label>
    <input id="stCans" type="number" inputmode="numeric" min="1" max="30" value="${S.plan ? S.plan.targets[0] : 4}">
    <label class="f" for="stDays">Total days (the last day is zero)</label>
    <input id="stDays" type="number" inputmode="numeric" min="2" max="365" value="${S.plan ? S.plan.targets.length : 28}">
    <div class="btns"><button class="btn rose" data-act="start">${S.plan ? 'Restart taper' : 'Begin my taper'}</button></div>`;
}

/* ---- charts ---- */
function chart({ dates, series, ymax }) {
  const W = 340, H = 190, Lm = 26, R = 10, T = 10, B = 24, pw = W - Lm - R, ph = H - T - B, n = dates.length;
  const x = i => Lm + (n < 2 ? pw / 2 : pw * i / (n - 1));
  const y = v => T + ph * (1 - v / ymax);
  const step = ymax <= 4 ? 1 : Math.ceil(ymax / 4);
  let g = '';
  for (let v = 0; v <= ymax; v += step) g += `<line x1="${Lm}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${cv('--line')}" stroke-width="1"/><text x="${Lm - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
  const lab = Math.min(n, 5);
  for (let k = 0; k < lab; k++) {
    const i = lab === 1 ? 0 : Math.round(k * (n - 1) / (lab - 1));
    g += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${short(dates[i])}</text>`;
  }
  const lines = series.map(s => {
    let d = '', pen = false, dots = '';
    s.vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`; pen = true;
      if (s.dots) dots += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${n > 40 ? 2 : 3.2}" fill="${s.color}"/>`;
    });
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w || 2.5}" stroke-linecap="round" stroke-linejoin="round" ${s.dash ? 'stroke-dasharray="5 5"' : ''}/>${dots}`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${g}${lines}</svg>`;
}
function rangeDates() {
  const t = today();
  const first = [S.plan?.start, ...Object.keys(S.logs), ...Object.keys(S.sym)].filter(Boolean).sort()[0] || t;
  const start = ui.range === 0 ? first : addDays(t, -(ui.range - 1));
  const out = [];
  for (let d = ui.range === 0 ? first : start; d <= t; d = addDays(d, 1)) out.push(d);
  return out.length ? out : [t];
}
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
function symVal(d, k) {
  const e = S.sym[d]; if (!e || !e.done) return null;
  if (k === 'avg') return avg(SYMS.map(([s]) => e[s] ?? 0));
  return e[k] ?? 0;
}

function vProgress() {
  if (!S.plan && !Object.keys(S.logs).length) return `<div class="card"><h2>Progress</h2><p class="muted">Charts will bloom here once you’ve set up a taper and logged a few days.</p></div>`;
  const dates = rangeDates();
  const ranges = [[7, '7 days'], [14, '14 days'], [30, '30 days'], [0, 'All']];
  const ymaxC = Math.max(2, ...dates.map(d => Math.max(target(d) ?? 0, total(d) ?? 0, ui.showDecaf ? S.logs[d]?.decaf ?? 0 : 0)));
  const ymaxI = Math.ceil(ymaxC);
  const cs = [
    { color: cv('--c-target'), dash: true, w: 2.5, vals: dates.map(d => target(d)) },
    { color: cv('--c-caf'), dots: true, vals: dates.map(d => total(d)) },
  ];
  if (ui.showDecaf) cs.push({ color: cv('--c-decaf'), dots: true, w: 1.8, vals: dates.map(d => S.logs[d]?.decaf ?? null) });

  // stats
  const logged = Object.keys(S.logs).filter(d => target(d) != null);
  const base = S.plan ? S.plan.targets[0] : 0;
  const skipped = Math.round(logged.reduce((a, d) => a + Math.max(base - total(d), 0), 0));
  const onTrack = logged.filter(d => total(d) <= target(d)).length;
  const recent = Object.keys(S.logs).sort().slice(-7);
  const avgMg = recent.length ? Math.round(avg(recent.map(totalMg))) : 0;
  let streak = 0;
  for (let d = today(); ; d = addDays(d, -1)) {
    if (d === today() && !S.logs[d]) continue;
    if (S.logs[d] && target(d) != null && total(d) <= target(d)) streak++; else break;
    if (streak > 800) break;
  }

  // symptom trend
  const keys = [...ui.symSel];
  const sSeries = keys.map(k => {
    const idx = k === 'avg' ? 0 : SYMS.findIndex(s => s[0] === k) + 1;
    return { color: k === 'avg' ? cv('--c-avg') : cv('--s' + (idx - 1)), dots: true, w: k === 'avg' ? 3 : 2, vals: dates.map(d => symVal(d, k)) };
  });
  const t = today();
  const wk = (from, to) => { const v = []; for (let i = from; i < to; i++) { const x = symVal(addDays(t, -i), 'avg'); if (x != null) v.push(x); } return avg(v); };
  const thisW = wk(0, 7), lastW = wk(7, 14);
  let trend = 'Log a few more check-ins to see how things are trending.';
  if (thisW != null && lastW != null) {
    const dlt = thisW - lastW;
    trend = dlt < -0.15 ? 'Symptoms are easing compared with the week before. 🌱'
      : dlt > 0.15 ? 'Symptoms are a bit higher than last week — common during a taper. Consider pausing or slowing the steps.'
      : 'Symptoms are holding steady compared with last week.';
  } else if (thisW != null) trend = `Average symptom level this week: ${thisW.toFixed(1)} of 3.`;

  return `
    <div class="chips">${ranges.map(([v, l]) => `<button class="chip ${ui.range === v ? 'on' : ''}" data-act="range" data-v="${v}">${l}</button>`).join('')}</div>
    <div class="card"><h2>Cans vs. target</h2>
      ${chart({ dates, series: cs, ymax: ymaxI })}
      <div class="legend"><span><i class="dash" style="border-color:${cv('--c-target')}"></i>Target</span><span><i style="border-color:${cv('--c-caf')}"></i>Caffeinated (cans + drinks)</span>${ui.showDecaf ? `<span><i style="border-color:${cv('--c-decaf')}"></i>Caffeine-free</span>` : ''}</div>
      <div class="chips" style="margin-top:10px"><button class="chip ${ui.showDecaf ? 'on' : ''}" data-act="decaf">Show caffeine-free</button></div>
    </div>
    <div class="card"><h2>Highlights</h2><div class="stats">
      <div class="stat"><b>${logged.length}</b><span>days logged</span></div>
      <div class="stat"><b>${onTrack}</b><span>days at or under target</span></div>
      <div class="stat"><b>${streak}</b><span>day streak on target</span></div>
      <div class="stat"><b>${skipped}</b><span>cans skipped vs. start</span></div>
      <div class="stat"><b>${avgMg}</b><span>avg mg caffeine / day (last 7 logged)</span></div></div></div>
    <div class="card"><h2>Symptoms over time</h2>
      <p class="muted" style="margin-top:-4px">0 = none, 3 = strong. Lower is better.</p>
      <div class="chips"><button class="chip ${ui.symSel.has('avg') ? 'on' : ''}" data-act="symsel" data-k="avg">Overall</button>
        ${SYMS.map(([k, n]) => `<button class="chip ${ui.symSel.has(k) ? 'on' : ''}" data-act="symsel" data-k="${k}">${n}</button>`).join('')}</div>
      ${chart({ dates, series: sSeries, ymax: 3 })}
      <p class="status" style="font-size:15px">${trend}</p>
    </div>`;
}

function vSettings() {
  const st = S.settings;
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  return `
    <div class="card"><h2>Appearance</h2>
      <div class="chips" style="margin-bottom:0">${[['auto', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button class="chip ${(st.theme || 'auto') === v ? 'on' : ''}" data-act="theme" data-v="${v}">${l}</button>`).join('')}</div>
    </div>
    <div class="card"><h2>Daily reminder</h2>
      <div class="switch"><label for="remOn">Remind me to log</label><input id="remOn" type="checkbox" ${st.remind ? 'checked' : ''}></div>
      <label class="f" for="remTime">Reminder time</label>
      <input id="remTime" type="time" value="${st.time}">
      <p class="muted" style="margin-top:10px">${!supported ? 'This browser doesn’t support notifications.' : perm === 'denied' ? 'Notifications are blocked for this site — enable them in your browser settings.' : 'On a phone, add the app to your home screen first. Reminders fire when the app has been opened that day; for a guaranteed daily nudge, also add it to your calendar below.'}</p>
      <div class="btns">
        <button class="btn ghost" data-act="testnotif">Send a test</button>
        <button class="btn ghost" data-act="ics">Add to calendar (.ics)</button>
      </div>
    </div>
    <div class="card"><h2>Caffeine amounts</h2>
      <p class="muted" style="margin-top:-4px">Used to turn drinks into can-equivalents. Adjust to match what you actually drink.</p>
      <label class="f" for="canMg">Caffeine in one can (mg)</label>
      <input id="canMg" type="number" inputmode="numeric" min="1" max="500" value="${st.canMg}">
      <h3>My drinks</h3>
      ${st.presets.map(p => `<div class="dedit">
        <div class="preset"><button class="star ${isFav(p) ? 'on' : ''}" data-act="fav" data-id="${esc(p.id)}" aria-label="Toggle favorite">★</button>
          <input class="pname" data-pid="${esc(p.id)}" data-f="name" value="${esc(p.name)}" aria-label="Drink name">
          <button class="round" data-act="delpreset" data-id="${esc(p.id)}" aria-label="Remove">×</button></div>
        <div class="preset"><select data-pid="${esc(p.id)}" data-f="type" aria-label="Type">${[...new Set([...TYPES, p.type].filter(Boolean))].map(x => `<option ${x === p.type ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
          <select data-pid="${esc(p.id)}" data-f="container" aria-label="Container">${[...new Set([...CONTAINERS, p.container].filter(Boolean))].map(x => `<option ${x === p.container ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
        <div class="preset"><input class="pmg" type="number" inputmode="decimal" min="0" max="128" data-pid="${esc(p.id)}" data-f="oz" value="${p.oz ?? ''}" placeholder="oz" aria-label="Ounces"><span class="muted">oz</span>
          <input class="pmg" type="number" inputmode="numeric" min="0" max="1000" data-pid="${esc(p.id)}" data-f="mg" value="${p.mg}" aria-label="mg"><span class="muted">mg</span></div>
      </div>`).join('')}
      <div class="btns"><button class="btn ghost" data-act="addpreset">+ Add a drink</button></div>
    </div>
    <div class="card"><h2>Your data</h2>
      <p class="muted">Everything lives only on this device.</p>
      <div class="btns">
        <button class="btn ghost" data-act="export">Export backup</button>
        <button class="btn ghost" data-act="import">Import backup</button>
      </div>
      <input id="importFile" type="file" accept="application/json" hidden>
      <div class="btns"><button class="btn danger" data-act="wipe">Erase everything</button></div>
    </div>`;
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const tab = e.target.closest('#tabs button');
  if (tab) { ui.view = tab.dataset.view; render(); window.scrollTo(0, 0); return; }
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, d = ui.date, p = S.plan;
  const L = () => S.logs[d] || { caf: 0, decaf: 0 };
  switch (act) {
    case 'prev': ui.date = addDays(d, -1); break;
    case 'next': if (d < today()) ui.date = addDays(d, 1); break;
    case 'caf+': setLog(d, { caf: Math.min(L().caf + 1, 99) }); break;
    case 'caf-': setLog(d, { caf: Math.max(L().caf - 1, 0) }); break;
    case 'dr+': case 'dr-': { const pr = S.settings.presets.find(x => x.id === el.dataset.id); if (pr) setDrink(d, pr, act === 'dr+' ? 1 : -1); break; }
    case 'dec+': setLog(d, { decaf: Math.min(L().decaf + 1, 99) }); break;
    case 'dec-': setLog(d, { decaf: Math.max(L().decaf - 1, 0) }); break;
    case 'sev': setSym(d, { [el.dataset.k]: +el.dataset.v, done: true }); break;
    case 'savecheck': {
      setLog(d, {});
      const ta = document.getElementById('notes');
      setSym(d, { done: true, notes: ta ? ta.value : (S.sym[d]?.notes || '') });
      toast('Saved. Be gentle with yourself 🌿');
      break;
    }
    case 'range': ui.range = +el.dataset.v; break;
    case 'decaf': ui.showDecaf = !ui.showDecaf; break;
    case 'symsel': {
      const k = el.dataset.k;
      if (ui.symSel.has(k)) { if (ui.symSel.size > 1) ui.symSel.delete(k); } else ui.symSel.add(k);
      break;
    }
    case 'start': {
      const cans = clamp(parseInt(document.getElementById('stCans').value, 10) || 0, 1, 30);
      const days = clamp(parseInt(document.getElementById('stDays').value, 10) || 0, 2, 365);
      if (S.plan) { snapshot(); S.pastPlans.push(S.plan); }
      S.plan = { start: today(), targets: gen(cans, days), pausedAt: null };
      snapshot(); save(); ui.view = 'today'; ui.date = today(); toast('Your taper has begun 🌸');
      break;
    }
    case 'pause': snapshot(); p.pausedAt = today(); save(); toast('Taper paused'); break;
    case 'resume': {
      snapshot();
      p.start = addDays(p.start, diff(p.pausedAt, today())); p.pausedAt = null;
      snapshot(); save(); toast('Welcome back'); break;
    }
    case 'adjust': {
      snapshot();
      const from = clamp(parseInt(document.getElementById('adjFrom').value, 10) || 0, 0, 30);
      const n = clamp(parseInt(document.getElementById('adjDays').value, 10) || 1, 1, 365);
      const i = planIdx(today());
      p.targets = p.targets.slice(0, i).concat(gen(from, n + 1));
      snapshot(); save(); toast('Schedule adjusted'); break;
    }
    case 'ed+': case 'ed-': {
      const i = +el.dataset.i;
      p.targets[i] = clamp(p.targets[i] + (act === 'ed+' ? 1 : -1), 0, 30);
      save(); break;
    }
    case 'addpreset': S.settings.presets.push({ id: 'p' + Date.now().toString(36), name: 'New drink', type: 'Other', container: 'Can', oz: null, mg: 50, fav: false }); save(); break;
    case 'fav': { const pr = S.settings.presets.find(x => x.id === el.dataset.id); if (pr) { pr.fav = !isFav(pr); save(); } break; }
    case 'newdrink': ui.newOpen = !ui.newOpen; break;
    case 'savedrink': {
      const name = document.getElementById('nd-name').value.trim();
      if (!name) { toast('Give it a name first'); return; }
      const oz = parseFloat(document.getElementById('nd-oz').value);
      const pr = { id: 'p' + Date.now().toString(36), name, type: document.getElementById('nd-type').value, container: document.getElementById('nd-cont').value,
        oz: oz > 0 ? oz : null, mg: clamp(parseInt(document.getElementById('nd-mg').value, 10) || 0, 0, 1000), fav: document.getElementById('nd-fav').checked };
      S.settings.presets.push(pr); setDrink(d, pr, 1); ui.newOpen = false; toast(`Logged ${name}`); break;
    }
    case 'theme': S.settings.theme = el.dataset.v; save(); applyTheme(); break;
    case 'delpreset': S.settings.presets = S.settings.presets.filter(x => x.id !== el.dataset.id); save(); break;
    case 'testnotif': testNotif(); return;
    case 'ics': downloadICS(); return;
    case 'export': exportData(); return;
    case 'import': document.getElementById('importFile').click(); return;
    case 'wipe':
      if (confirm('Erase all plans, logs and symptoms from this device? This can’t be undone.')) {
        S = defaults(); save(); ui.view = 'today'; ui.date = today();
      } else return;
      break;
  }
  render();
});

document.addEventListener('input', e => {
  if (e.target.id === 'notes') setSym(ui.date, { notes: e.target.value });
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'remOn') {
    if (t.checked && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    S.settings.remind = t.checked && 'Notification' in window && Notification.permission === 'granted';
    if (t.checked && !S.settings.remind) toast('Please allow notifications to turn this on');
    S.settings.lastNotified = ''; save(); scheduleTrigger(); render();
  } else if (t.id === 'canMg') {
    S.settings.canMg = clamp(parseInt(t.value, 10) || 40, 1, 500); save(); toast('Saved');
  } else if (t.id === 'nd-type') {
    document.getElementById('nd-mg').value = TYPE_MG[t.value] ?? 0;
  } else if (t.dataset.pid) {
    const p = S.settings.presets.find(x => x.id === t.dataset.pid), f = t.dataset.f;
    if (p) {
      if (f === 'mg') p.mg = clamp(parseInt(t.value, 10) || 0, 0, 1000);
      else if (f === 'oz') p.oz = parseFloat(t.value) > 0 ? parseFloat(t.value) : null;
      else if (f === 'name') p.name = t.value.trim() || 'Drink';
      else p[f] = t.value;
      save(); toast('Saved');
    }
  } else if (t.id === 'remTime') {
    S.settings.time = t.value || '09:00'; S.settings.lastNotified = ''; save(); scheduleTrigger(); toast('Reminder time saved');
  } else if (t.id === 'importFile' && t.files[0]) {
    try {
      const data = JSON.parse(await t.files[0].text());
      if (!data || typeof data !== 'object' || !('logs' in data)) throw new Error('bad');
      S = Object.assign(defaults(), data); save(); render(); toast('Backup restored');
    } catch (err) { toast('That file doesn’t look like a backup'); }
  }
});

/* ---------- reminders ---------- */
function notify(title, body) {
  const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'taper-daily' };
  if (navigator.serviceWorker && navigator.serviceWorker.ready) {
    navigator.serviceWorker.ready.then(r => r.showNotification(title, opts)).catch(() => { try { new Notification(title, opts); } catch (e) { /* ignore */ } });
  } else { try { new Notification(title, opts); } catch (e) { /* ignore */ } }
}
async function testNotif() {
  if (!('Notification' in window)) return toast('Notifications aren’t supported here');
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') return toast('Notifications are blocked');
  notify('Gentle Taper', 'A soft little reminder to log your cans and how you feel 🌿');
}
function checkReminder() {
  const st = S.settings;
  if (!st.remind || !('Notification' in window) || Notification.permission !== 'granted') return;
  const t = today();
  if (st.lastNotified === t) return;
  const now = new Date(), [h, m] = st.time.split(':').map(Number);
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
  st.lastNotified = t; save();
  if (S.logs[t] && S.sym[t] && S.sym[t].done) return; // already checked in
  notify('Gentle Taper', 'Time to log your cans and how you’re feeling 🌿');
}
// Chrome-only experimental API; harmless no-op elsewhere.
async function scheduleTrigger() {
  try {
    if (!('showTrigger' in Notification.prototype) || typeof TimestampTrigger === 'undefined') return;
    const reg = await navigator.serviceWorker.ready;
    (await reg.getNotifications({ tag: 'taper-scheduled', includeTriggered: false })).forEach(n => n.close());
    if (!S.settings.remind || Notification.permission !== 'granted') return;
    const [h, m] = S.settings.time.split(':').map(Number);
    for (let k = 0; k < 7; k++) {
      const at = new Date(); at.setDate(at.getDate() + k); at.setHours(h, m, 0, 0);
      if (at > new Date()) await reg.showNotification('Gentle Taper', { body: 'Time to log your cans and how you’re feeling 🌿', tag: 'taper-scheduled', icon: 'icons/icon-192.png', showTrigger: new TimestampTrigger(at.getTime()) });
    }
  } catch (e) { /* ignore */ }
}
function downloadICS() {
  const [h, m] = S.settings.time.split(':').map(Number);
  const s = new Date(); const stamp = `${fmt(s).replace(/-/g, '')}T${pad(h)}${pad(m)}00`;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gentle Taper//EN', 'BEGIN:VEVENT',
    `UID:gentle-taper-daily@local`, `DTSTAMP:${stamp}`, `DTSTART:${stamp}`, 'DURATION:PT10M', 'RRULE:FREQ=DAILY',
    'SUMMARY:Log my cans & symptoms 🌿', 'DESCRIPTION:Open Gentle Taper and check in.',
    'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', 'DESCRIPTION:Log my cans & symptoms', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  saveBlob(new Blob([ics], { type: 'text/calendar' }), 'gentle-taper-reminder.ics');
}
function exportData() {
  saveBlob(new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' }), `gentle-taper-backup-${today()}.json`);
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- theme ---------- */
function applyTheme() {
  const pref = S.settings.theme || 'auto';
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = dark ? '#2a1b22' : '#f3c9d3';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); render(); });
document.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('more')) ui.moreOpen = e.target.open; }, true);

/* ---------- boot ---------- */
applyTheme();
applyDecor();
if (!S.plan) ui.view = 'plan';
render();
checkReminder(); scheduleTrigger();
setInterval(checkReminder, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (ui.date === today() || ui.date > today()) ui.date = today();
    checkReminder(); render();
  }
});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
