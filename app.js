'use strict';

/* ---------- constants & state ---------- */
const KEY = 'gentle-taper-v1';
const SYMS = [
  ['headache', 'Headache'], ['fatigue', 'Fatigue'], ['irritability', 'Irritability'],
  ['nausea', 'Nausea'], ['focus', 'Trouble focusing'], ['mood', 'Low mood'],
];
const SEV = ['None', 'Mild', 'Moderate', 'Strong'];
// Suggestions only: a drink's type and container can be any text.
const TYPES = ['Soda', 'Coffee', 'Tea', 'Energy drink', 'Sparkling water', 'Pre-workout', 'Chocolate', 'Other'];
const TYPE_MG = { 'Soda': 40, 'Coffee': 95, 'Tea': 47, 'Energy drink': 80, 'Sparkling water': 0, 'Pre-workout': 150, 'Chocolate': 20, 'Other': 0 };
const CONTAINERS = ['Can', 'Bottle', 'Cup', 'Mug', 'Shot', 'Glass', 'Pouch'];
// Push reminders: a small Cloudflare Worker (see /worker) sends a silent push at your reminder time.
const PUSH_URL = 'https://gentle-taper-push.michellefeliciano.workers.dev';
const PUSH_KEY = 'BPHoUIzOrOvN_ZCYwSIz0MtfsQOAU7RaiAPcQBT4KvjTNUony1ux9FJ4oqvqM7JTqxvF-jakowvk4C1Eg-61KXw';
const CLOUD_KEY = 'gentle-taper-cloud'; // recovery code + last upload time (kept out of S so it never lands in exports)
let cloudT = null, cloudBusy = false, cloudPending = false;
const cv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function defaults() {
  return { v: 3, water: {}, ms: {}, pace: {}, baseline: null, plan: null, pastPlans: [], hist: {}, logs: {}, sym: {}, settings: { remind: false, time: '09:00', lastNotified: '', canMg: 40, theme: 'auto', cutoff: '14:00', waterOn: true, waterName: 'Water', waterUnit: 'glasses', evening: false, eveningTime: '20:00', touchedPing: '', lastExport: '', nudgeSnooze: '', presets: [
    { id: 'can', name: 'Caffeinated can', type: 'Soda', container: 'Can', oz: 12, mg: 40, fav: true },
    { id: 'decaf', name: 'Caffeine-free can', type: 'Soda', container: 'Can', oz: 12, mg: 0, fav: true },
    { id: 'soda', name: 'Soda', type: 'Soda', container: 'Bottle', oz: 20, mg: 57, fav: true },
    { id: 'coffee', name: 'Coffee', type: 'Coffee', container: 'Cup', oz: 8, mg: 95, fav: true },
    { id: 'energy', name: 'Energy drink', type: 'Energy drink', container: 'Can', oz: 16, mg: 160, fav: false },
    { id: 'tea', name: 'Tea', type: 'Tea', container: 'Cup', oz: 8, mg: 47, fav: false },
  ] } };
}
function normalize(s) {
  const d = defaults(), out = Object.assign(d, s, { v: s.v, settings: Object.assign(d.settings, s.settings) });
  if (!Array.isArray(out.settings.presets)) out.settings.presets = defaults().settings.presets;
  if (!Array.isArray(out.pastPlans)) out.pastPlans = [];
  ['hist', 'logs', 'sym', 'water', 'ms', 'pace'].forEach(k => { if (!out[k] || typeof out[k] !== 'object') out[k] = {}; });
  return out;
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && typeof s === 'object') return normalize(s);
  } catch (e) { /* fall through */ }
  return defaults();
}
let S = load();
// v2: targets are stored in mg instead of cans.  v3: the old "cans" counters become ordinary, editable drinks.
function migrate() {
  if (S.v === 3) return;
  const k = S.settings.canMg || 40;
  if (S.v !== 2) {
    const f = x => Math.round(x * k / 5) * 5;
    if (S.plan) S.plan.targets = S.plan.targets.map(f);
    (S.pastPlans || []).forEach(p => { p.targets = p.targets.map(f); });
    Object.keys(S.hist || {}).forEach(d => { if (S.hist[d] != null) S.hist[d] = f(S.hist[d]); });
  }
  const P = S.settings.presets;
  if (!P.some(p => p.id === 'can')) P.unshift({ id: 'can', name: 'Caffeinated can', type: 'Soda', container: 'Can', oz: 12, mg: k, fav: true });
  if (!P.some(p => p.id === 'decaf')) P.splice(Math.min(1, P.length), 0, { id: 'decaf', name: 'Caffeine-free can', type: 'Soda', container: 'Can', oz: 12, mg: 0, fav: true });
  Object.values(S.logs || {}).forEach(L => {
    L.drinks = L.drinks || {};
    if (L.caf > 0) { const e = L.drinks.can; L.drinks.can = { n: (e ? e.n : 0) + L.caf, mg: e ? e.mg : k, name: 'Caffeinated can', type: 'Soda', container: 'Can' }; }
    if (L.decaf > 0) { const e = L.drinks.decaf; L.drinks.decaf = { n: (e ? e.n : 0) + L.decaf, mg: 0, name: 'Caffeine-free can', type: 'Soda', container: 'Can' }; }
    L.caf = 0; L.decaf = 0;
  });
  S.v = 3; save();
}
migrate();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Could not save on this device'); }
  cloudDirty();
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
  return Array.from({ length: n }, (_, i) => (n === 1 ? 0 : Math.round(from * (1 - i / (n - 1)) / 5) * 5));
}
// Days logged since the baseline began. `inclToday` counts today's in-progress day (for display only).
function baselineDays(inclToday = true) {
  const b = S.baseline, t = today();
  return b ? Object.keys(S.logs).filter(d => d >= b.start && (inclToday ? d <= t : d < t)).sort() : [];
}
function checkBaseline() {
  const b = S.baseline; if (!b || S.plan) return;
  const days = baselineDays(false).slice(0, 3); if (days.length < 3) return; // only finished days count
  const mgStart = Math.round(avg(days.map(totalMg)) / 5) * 5;
  S.baseline = null;
  if (mgStart < 10) { save(); toast('You’re already near zero — nothing to taper! 🌿'); return; }
  const start = today();
  S.plan = { start, targets: gen(mgStart, b.taperDays), pausedAt: null, fromBaseline: true };
  save(); toast(`Baseline done: about ${mgStart} mg a day. Your taper starts today.`);
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
const ui = { editId: null, showCode: false, openRestart: false, followToday: true, draft: null, newOpen: false, moreOpen: false, view: 'today', date: today(), range: 14, symSel: new Set(['avg']) };

/* ---------- decoration ---------- */
function vineSVG(horizontal) {
  const leaf = (x, y, r, s, c) => `<path transform="translate(${x} ${y}) rotate(${r}) scale(${s})" d="M0 0C6-9 18-9 26 0C18 9 6 9 0 0Z" fill="${c}"/>`;
  const bloom = (x, y) => `<g transform="translate(${x} ${y})">${[0, 72, 144, 216, 288].map(a => `<ellipse cx="0" cy="-5" rx="3.4" ry="5" transform="rotate(${a})" fill="#d8cdea"/>`).join('')}<circle r="2.3" fill="#fbe7a8"/></g>`;
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
const fmtTime = t => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'am' : 'pm'}`; };
function stamp(d) {
  if (d !== today() || !S.logs[d]) return;
  const n = new Date(); S.logs[d].lastCaf = `${pad(n.getHours())}:${pad(n.getMinutes())}`; save();
}
function streakOf(ok, completeOnly) {
  let n = 0;
  for (let d = today(); n < 800; d = addDays(d, -1)) {
    if (d === today() && (completeOnly || !S.logs[d])) continue;
    if (S.logs[d] && ok(d)) n++; else break;
  }
  return n;
}
const streakNow = () => streakOf(d => target(d) != null && totalMg(d) <= target(d));
// days with no caffeine, or whose last caffeine was before the cutoff time
const cutoffStreak = () => streakOf(d => totalMg(d) === 0 || (S.logs[d].lastCaf && S.logs[d].lastCaf <= S.settings.cutoff));
const MILESTONES = [['s7', '7 days on target', 'A whole week on target — that’s real progress. 🌿'],
  ['s14', '14 days on target', 'Two weeks of steady care. Be proud of yourself. 🌱'],
  ['zero', 'First caffeine-free day', 'Your first caffeine-free day. 🌸']];
function checkMilestones() {
  if (!S.plan) return;
  const t = today(), st = streakOf(d => target(d) != null && totalMg(d) <= target(d), true);
  const set = (k, v) => { if (!S.ms[k]) { S.ms[k] = v; save(); toast(MILESTONES.find(m => m[0] === k)[2]); } };
  if (st >= 7) set('s7', t);
  if (st >= 14) set('s14', t);
  const pl = S.plan;
  if (!pl.completedOn && !pl.pausedAt && pl.start <= t && planIdx(t) >= pl.targets.length - 1) { pl.completedOn = t; save(); toast('You reached the final day of your taper! 🌸'); }
  if (!S.ms.zero) {
    const z = Object.keys(S.logs).filter(d => d >= S.plan.start && d < t && totalMg(d) === 0).sort()[0];
    if (z) set('zero', z);
  }
}
function bestStreak() {
  const ds = Object.keys(S.logs).filter(d => target(d) != null).sort();
  let best = 0, run = 0, prev = null;
  for (const d of ds) {
    if (totalMg(d) <= target(d)) { run = prev && run > 0 && diff(prev, d) === 1 ? run + 1 : 1; best = Math.max(best, run); prev = d; }
    else { run = 0; prev = null; }
  }
  return best;
}
// Went over today's target? Offer to hold the level for a day instead of stepping down again.
function slipAlert() {
  const p = S.plan, t = today();
  if (!p || p.pausedAt || p.completedOn || p.start > t || ui.date !== t || !S.logs[t]) return null;
  const tg = target(t);
  if (tg == null || tg <= 0 || planIdx(t) >= p.targets.length - 1) return null;
  if (S.pace.slip && S.pace.slip >= t) return null;
  const over = totalMg(t) - tg;
  return over > 0 ? over : null;
}
// After the taper: gently notice if caffeine creeps back in.
function maintAlert() {
  const p = S.plan, t = today();
  if (!p || !p.completedOn || ui.date !== t || (S.pace.maint && S.pace.maint >= t)) return false;
  const days = Object.keys(S.logs).filter(d => d <= t && d >= addDays(t, -4)).sort().slice(-3);
  return days.length >= 2 && days.filter(d => totalMg(d) > 0).length >= 2;
}
function weekStats(end) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(end, i - 6)), prev = days.map(d => addDays(d, -7));
  const logged = days.filter(d => S.logs[d]), pl = prev.filter(d => S.logs[d]);
  const sv = days.map(d => symVal(d, 'avg')).filter(x => x != null), psv = prev.map(d => symVal(d, 'avg')).filter(x => x != null);
  const wv = days.map(d => S.water[d]).filter(x => x > 0), tracked = logged.filter(d => target(d) != null);
  let best = null; logged.forEach(d => { if (best == null || totalMg(d) < totalMg(best)) best = d; });
  return { n: logged.length, avgMg: logged.length ? Math.round(avg(logged.map(totalMg))) : null, prevAvg: pl.length ? Math.round(avg(pl.map(totalMg))) : null,
    onT: tracked.filter(d => totalMg(d) <= target(d)).length, tracked: tracked.length, sym: sv.length ? avg(sv) : null, prevSym: psv.length ? avg(psv) : null,
    water: wv.length ? avg(wv) : null, best };
}
function weekHtml(w) {
  const li = [];
  const dm = w.prevAvg != null ? w.avgMg - w.prevAvg : null;
  li.push(`Average caffeine: <b>${w.avgMg} mg</b> a day${dm ? ` — ${Math.abs(dm)} mg ${dm < 0 ? 'lower' : 'higher'} than the week before` : ''}`);
  if (w.tracked) li.push(`${w.onT} of ${w.tracked} logged days at or under target`);
  if (w.sym != null) li.push(`Symptoms averaged ${w.sym.toFixed(1)} of 3${w.prevSym != null ? (w.sym < w.prevSym - .15 ? ' — easing 🌱' : w.sym > w.prevSym + .15 ? ' — a bit higher than the week before' : ' — steady') : ''}`);
  if (w.water != null) li.push(`${esc(S.settings.waterName || 'Water')}: about ${n1(w.water)} ${esc(S.settings.waterUnit || 'glasses')} a day`);
  if (w.best) li.push(`Lightest day: ${nice(w.best)} (${totalMg(w.best)} mg)`);
  return `<ul class="wk">${li.map(x => `<li>${x}</li>`).join('')}</ul>`;
}
function completeCard() {
  const p = S.plan, days = diff(p.start, p.completedOn) + 1;
  const zero = Object.keys(S.logs).filter(d => d >= p.start && totalMg(d) === 0).length;
  const se = Object.keys(S.sym).filter(d => S.sym[d].done && d >= p.start).sort();
  let symLine = '';
  if (se.length >= 6) {
    const a = avg(se.slice(0, 3).map(d => symVal(d, 'avg'))), b = avg(se.slice(-3).map(d => symVal(d, 'avg')));
    symLine = b < a - .15 ? 'Your symptoms are lower than when you started.' : b > a + .15 ? 'Symptoms are a bit higher than at the start — they often settle with time.' : 'Symptoms are about where they were at the start.';
  }
  return `<div class="card note"><h2>You reached zero 🌸</h2>
    <p>You brought ${p.targets[0]} mg a day down to zero over ${days} days.${zero ? ` ${zero} caffeine-free ${zero === 1 ? 'day' : 'days'} so far.` : ''} ${symLine}</p>
    <p class="muted" style="margin:0">Keep logging if you like — I’ll gently let you know if caffeine creeps back in.</p></div>`;
}

// Suggest easing off when the last three check-ins have been rough.
function paceAlert() {
  const p = S.plan, t = today();
  if (!p || p.pausedAt || p.start > t || ui.date !== t) return null;
  if (planIdx(t) >= p.targets.length - 1) return null;
  if (S.pace.snooze && S.pace.snooze >= t) return null;
  const days = Object.keys(S.sym).filter(d => S.sym[d].done && d <= t && d >= addDays(t, -4)).sort().slice(-3);
  if (days.length < 3) return null;
  const m = avg(days.map(d => symVal(d, 'avg')));
  const peaks = days.filter(d => SYMS.some(([k]) => (S.sym[d][k] ?? 0) >= 3)).length;
  return m >= 1.5 || peaks >= 2 ? { m } : null;
}

/* ---------- automatic safety copies ---------- */
const BK = 'gentle-taper-backups';
function readBackups() { try { return JSON.parse(localStorage.getItem(BK)) || []; } catch (e) { return []; } }
let backedUpOn = '';
function pushBackup(label) {
  if (!Object.keys(S.logs).length && !S.plan) return;
  if (!label && backedUpOn === today()) return;
  try {
    let b = readBackups();
    if (!label && b.some(x => x.date === today() && !x.label)) { backedUpOn = today(); return; }
    b.push({ date: today(), label: label || '', ts: Date.now(), json: JSON.stringify(S) });
    b = [...b.filter(x => !x.label).slice(-7), ...b.filter(x => x.label).slice(-5)].sort((x, y) => x.ts - y.ts);
    localStorage.setItem(BK, JSON.stringify(b));
    if (!label) backedUpOn = today();
  } catch (e) { /* storage full: skip */ }
}

function setDrink(d, p, delta) {
  if (delta < 0 && !S.logs[d]?.drinks?.[p.id]) return;
  const L = Object.assign({ caf: 0, decaf: 0 }, S.logs[d]); const dr = Object.assign({}, L.drinks);
  const cur = dr[p.id] || { n: 0, mg: p.mg, name: p.name };
  const n = clamp(cur.n + delta, 0, 99);
  if (n) dr[p.id] = { n, mg: cur.n === 0 ? p.mg : cur.mg, name: p.name, type: p.type || '', container: p.container || '' }; else delete dr[p.id];
  setLog(d, { drinks: dr });
}
function setLog(d, patch) { S.logs[d] = Object.assign({ caf: 0, decaf: 0 }, S.logs[d], patch); save(); if (d === today()) pushTouch(); }
function setSym(d, patch) { S.sym[d] = Object.assign({}, S.sym[d], patch); save(); }

/* ---------- views ---------- */
function render() {
  checkBaseline();
  snapshot();
  checkMilestones();
  const y = window.scrollY;
  document.querySelectorAll('#tabs button').forEach(b => { const on = b.dataset.view === ui.view; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const sub = document.getElementById('subtitle');
  const p = S.plan;
  sub.textContent = !p && S.baseline ? `Getting to know your habit · ${Math.min(baselineDays().length, 3)} of 3 days logged`
    : !p ? 'A soft landing, one day at a time'
    : p.start > today() ? 'Your taper begins tomorrow'
    : p.pausedAt ? 'Taper paused — rest is part of the plan'
    : `Day ${Math.min(planIdx(today()) + 1, p.targets.length) || 1} of ${p.targets.length}`;
  const v = { today: vToday, plan: vPlan, progress: vProgress, settings: vSettings }[ui.view];
  document.getElementById('app').innerHTML = v();
  window.scrollTo(0, y);
}

function stepper(act, val, cls, extra = '', label = '') {
  return `<div class="stepper">
    <button class="round" data-act="${act}-" ${extra} aria-label="${label ? 'One less ' + esc(label) : 'Less'}">−</button>
    <span class="n">${val}</span>
    <button class="round plus ${cls || ''}" data-act="${act}+" ${extra} aria-label="${label ? 'One more ' + esc(label) : 'More'}">+</button></div>`;
}

function vToday() {
  const d = ui.date, t = target(d), L = S.logs[d], Y = S.sym[d] || {};
  const caf = L ? L.caf : 0, dec = L ? L.decaf : 0, isToday = d === today();
  const mg = totalMg(d), tot = mg, dr = L?.drinks || {};
  let hero;
  if (t == null) {
    hero = `<div class="card hero"><div class="lbl">No target set for this day</div>
      <div class="status">${S.plan ? (isToday && S.plan.start > today() ? `Baseline complete! Your taper starts tomorrow at ${S.plan.targets[0]} mg.` : 'This is before your taper began.')
        : S.baseline ? (baselineDays().length >= 3 && baselineDays(false).length < 3 ? 'Baseline logged! Your taper will be built from your average tomorrow morning.' : 'Learning your habit: log everything you normally have — no target yet.') : 'Set up a taper in the Plan tab to see daily targets.'}</div></div>`;
  } else {
    const logged = !!L;
    let msg = '';
    if (logged) msg = tot <= t ? (tot < t ? 'Under target — lovely.' : 'Right on target.') : 'A little over — that’s okay. Tomorrow is a fresh leaf.';
    else if (t === 0) msg = 'Today is a caffeine-free day.';
    hero = `<div class="card hero"><div class="lbl">${isToday ? 'Today’s' : 'That day’s'} target</div>
      <div class="big">${t}</div><div class="lbl">mg of caffeine</div>
      ${msg ? `<div class="status ${logged && tot > t ? 'over' : ''}">${msg}</div>` : ''}</div>`;
  }
  return `
    <div class="datenav">
      <button class="round" data-act="prev" aria-label="Previous day">‹</button>
      <div class="d">${isToday ? 'Today' : nice(d).split(',')[0]}<small>${nice(d)}</small></div>
      <button class="round" data-act="next" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
    </div>
    ${hero}
    ${alertCards()}
    ${drinksCard(d, t)}
    ${loggedCard(d)}
    <div class="card"><h2>How am I feeling?</h2>
      ${SYMS.map(([k, name]) => `<div class="sym" role="group" aria-label="${name}"><div class="nm">${name}</div>
        <div class="seg">${SEV.map((s, v) => `<button data-act="sev" data-k="${k}" data-v="${v}" aria-pressed="${(Y[k] ?? 0) === v}" aria-label="${name}: ${s}" class="${(Y[k] ?? 0) === v ? 'on' : ''}">${s}</button>`).join('')}</div></div>`).join('')}
      <label class="f" for="notes">Notes (optional)</label>
      <textarea id="notes" placeholder="Anything worth remembering…">${esc(Y.notes || '')}</textarea>
    </div>
    <button class="btn rose block" data-act="savecheck">${L && Y.done ? 'Update check-in' : 'Save today’s check-in'}</button>`;
}

function alertCards() {
  const t = today(); let h = '';
  MILESTONES.forEach(([k, label, msg]) => { if (S.ms[k] && S.ms[k] >= addDays(t, -1)) h += `<div class="card note"><b>${esc(label)}</b><br>${esc(msg)}</div>`; });
  const pa = paceAlert();
  if (pa) h += `<div class="card alert"><h2>Be kind to yourself</h2>
    <p>Your symptoms have been rough lately (about ${pa.m.toFixed(1)} out of 3). That’s common while tapering — you don’t have to keep stepping down on schedule.</p>
    <div class="btns"><button class="btn rose" data-act="hold">Hold steady 3 days</button><button class="btn ghost" data-act="pause">Pause taper</button><button class="btn ghost" data-act="snooze">Not now</button></div>
    <p class="muted" style="margin:10px 0 0">If symptoms ever feel severe, please check in with a doctor.</p></div>`;
  if (S.plan?.completedOn && diff(S.plan.completedOn, t) <= 7) h += completeCard();
  if (!pa) {
    const over = slipAlert();
    if (over) h += `<div class="card alert"><h2>A bumpy day is okay</h2>
      <p>You’re ${over} mg over today’s target. Slips are a normal part of tapering — they don’t undo your progress. Want to hold today’s level for one more day before stepping down?</p>
      <div class="btns"><button class="btn rose" data-act="sliphold">Hold one extra day</button><button class="btn ghost" data-act="slipkeep">Keep going</button></div></div>`;
  }
  if (maintAlert()) h += `<div class="card alert"><h2>Caffeine crept back in</h2>
    <p>You’ve logged caffeine on a few recent days. That happens! If you’d like to settle back to zero, a short new taper can help.</p>
    <div class="btns"><button class="btn rose" data-act="newtaper">Plan a new taper</button><button class="btn ghost" data-act="maintok">I’m fine</button></div></div>`;
  const wk = weekStats(t);
  if (ui.date === t && wk.n >= 4 && (!S.pace.weekly || diff(S.pace.weekly, t) >= 7))
    h += `<div class="card note"><h2>Your week so far</h2>${weekHtml(wk)}<div class="btns"><button class="btn ghost" data-act="weekok">Got it</button></div></div>`;
  const exp = S.settings.lastExport, snooze = S.settings.nudgeSnooze;
  if (ui.date === t && Object.keys(S.logs).length >= 3 && (!exp || diff(exp, t) >= 7) && !(snooze && snooze >= t))
    h += `<div class="card note"><b>Save a backup?</b><br>${exp ? `It’s been ${diff(exp, t)} days since you exported one.` : 'You haven’t exported a copy yet.'} Saving one to Files or Drive keeps your history safe.
      <div class="btns"><button class="btn" data-act="export">Export now</button><button class="btn ghost" data-act="nudgelater">Later</button></div></div>`;
  return h;
}
// A simple log of the day. Everything is read-only except how many of each drink (counting down to 0 removes it).
function loggedCard(d) {
  const L = S.logs[d]; if (!L) return '';
  const ent = Object.entries(L.drinks || {});
  if (!ent.length) return '';
  return `<div class="card"><h2>Logged this day</h2>
    <p class="muted" style="margin-top:-4px">Change how many you had. Counting down to 0 removes it.</p>
    ${ent.map(([id, e]) => `<div class="lrow"><div class="lname"><b>${esc(e.name)}</b><small>${e.n} × ${e.mg} mg = ${e.n * e.mg} mg</small></div>
      ${stepper('dr', e.n, '', `data-id="${esc(id)}"`, e.name)}</div>`).join('')}
    <div class="btns"><button class="btn danger" data-act="delday">Clear this day’s drinks</button></div></div>`;
}
const waterRow = d => S.settings.waterOn === false ? '' : `<div class="counter"><div class="name">${esc(S.settings.waterName || 'Water')}<small>${esc(S.settings.waterUnit || 'glasses')} — just a tally</small></div>${stepper('wat', S.water[d] || 0, 'sage', '', S.settings.waterName || 'water')}</div>`;
function lastCafRow(d) {
  if (totalMg(d) === 0) return '';
  const lc = S.logs[d]?.lastCaf || '', cut = S.settings.cutoff;
  const note = lc ? (lc <= cut ? `Before your ${fmtTime(cut)} cutoff 🌿` : `After your ${fmtTime(cut)} cutoff — an earlier last cup can help sleep.`) : 'Add a time to track your cutoff streak.';
  return `<div class="lastcaf"><div class="row"><label for="lastCaf" style="font-weight:600">Last caffeine at</label><input id="lastCaf" type="time" value="${lc}" style="width:auto"></div><p class="muted" style="margin:4px 0 0">${note}</p></div>`;
}

const isFav = p => p.fav !== false;
const drinkLine = p => [p.type, p.container, p.oz ? p.oz + ' oz' : '', p.mg + ' mg'].filter(Boolean).join(' · ');
const datalists = () => {
  const ty = [...new Set([...TYPES, ...S.settings.presets.map(p => p.type)].filter(Boolean))], co = [...new Set([...CONTAINERS, ...S.settings.presets.map(p => p.container)].filter(Boolean))];
  return `<datalist id="dl-types">${ty.map(x => `<option value="${esc(x)}">`).join('')}</datalist><datalist id="dl-conts">${co.map(x => `<option value="${esc(x)}">`).join('')}</datalist>`;
};
function drinkEditor(p, idx, n) {
  const id = esc(p.id);
  return `<div class="dedit">
    <div class="preset"><button class="star ${isFav(p) ? 'on' : ''}" data-act="fav" data-id="${id}" aria-pressed="${isFav(p)}" aria-label="Favorite: ${esc(p.name)}">★</button>
      <input class="pname" type="text" data-pid="${id}" data-f="name" value="${esc(p.name)}" maxlength="40" aria-label="Drink name"></div>
    <div class="preset"><input type="text" list="dl-types" data-pid="${id}" data-f="type" value="${esc(p.type || '')}" placeholder="Type (any)" maxlength="30" aria-label="Type">
      <input type="text" list="dl-conts" data-pid="${id}" data-f="container" value="${esc(p.container || '')}" placeholder="Container (any)" maxlength="30" aria-label="Container"></div>
    <div class="preset"><input class="pmg" type="number" inputmode="decimal" min="0" max="128" data-pid="${id}" data-f="oz" value="${p.oz ?? ''}" placeholder="oz" aria-label="Size in ounces"><span class="muted">oz</span>
      <input class="pmg" type="number" inputmode="numeric" min="0" max="1000" data-pid="${id}" data-f="mg" value="${p.mg}" aria-label="Caffeine in mg"><span class="muted">mg</span></div>
    <div class="preset acts"><button class="btn ghost sm" data-act="mvup" data-id="${id}" aria-label="Move ${esc(p.name)} up" ${idx === 0 ? 'disabled' : ''}>↑ Up</button>
      <button class="btn ghost sm" data-act="mvdown" data-id="${id}" aria-label="Move ${esc(p.name)} down" ${idx === n - 1 ? 'disabled' : ''}>↓ Down</button>
      <button class="btn danger sm" data-act="delpreset" data-id="${id}" aria-label="Delete ${esc(p.name)}">Delete</button></div>
  </div>`;
}
function drinkRow(p, dr) {
  const all = S.settings.presets, editing = ui.editId === p.id;
  return `<div class="counter"><div class="name"><span class="nm1"><button class="star ${isFav(p) ? 'on' : ''}" data-act="fav" data-id="${esc(p.id)}" aria-pressed="${isFav(p)}" aria-label="Favorite: ${esc(p.name)}">★</button>${esc(p.name)}<button class="edit" data-act="editdrink" data-id="${esc(p.id)}" aria-pressed="${editing}" aria-label="Edit ${esc(p.name)}">✎</button></span><small>${esc(drinkLine(p))}</small></div>${stepper('dr', dr[p.id]?.n || 0, '', `data-id="${esc(p.id)}"`, p.name)}</div>${editing ? `<div class="editwrap">${drinkEditor(p, all.indexOf(p), all.length)}<div class="btns"><button class="btn" data-act="editdone">Done</button></div></div>` : ''}`;
}
function drinksCard(d, t) {
  const L = S.logs[d], dr = L?.drinks || {}, P = S.settings.presets, mg = totalMg(d);
  const favs = P.filter(isFav), others = P.filter(p => !isFav(p));
  const open = ui.moreOpen || others.some(p => dr[p.id] || p.id === ui.editId);
  const dft = ui.draft || {};
  const form = ui.newOpen ? `<div class="newdrink">
      <label class="f" for="nd-name">What is it?</label>
      <input id="nd-name" type="text" placeholder="e.g. Diet Coke, iced latte" maxlength="40" value="${esc(dft.name || '')}">
      <div class="two"><div><label class="f" for="nd-type">Type</label><input id="nd-type" type="text" list="dl-types" maxlength="30" value="${esc(dft.type || 'Soda')}"></div>
        <div><label class="f" for="nd-cont">Container</label><input id="nd-cont" type="text" list="dl-conts" maxlength="30" value="${esc(dft.cont || 'Can')}"></div></div>
      <div class="two"><div><label class="f" for="nd-oz">Size (oz, optional)</label><input id="nd-oz" type="number" inputmode="decimal" min="0" max="128" placeholder="12" value="${esc(dft.oz || '')}"></div>
        <div><label class="f" for="nd-mg">Caffeine (mg)</label><input id="nd-mg" type="number" inputmode="numeric" min="0" max="1000" value="${esc(dft.mg ?? TYPE_MG.Soda)}"></div></div>
      <div class="switch"><label for="nd-fav">Add to my favorites</label><input id="nd-fav" type="checkbox" ${dft.fav === false ? '' : 'checked'}></div>
      <div class="btns"><button class="btn rose" data-act="savedrink">Save &amp; log one</button><button class="btn ghost" data-act="newdrink">Cancel</button></div>
    </div>` : '';
  return `<div class="card"><h2>Drinks</h2>
      <p class="muted" style="margin-top:-4px">Tap ★ to pin a favorite or ✎ to edit a drink. Each counts toward your target by its caffeine amount.</p>
      ${favs.length ? favs.map(p => drinkRow(p, dr)).join('') : '<p class="muted">No favorites yet — star a drink below or add a new one.</p>'}
      ${others.length ? `<details class="more" ${open ? 'open' : ''}><summary>More drinks (${others.length})</summary>${others.map(p => drinkRow(p, dr)).join('')}</details>` : ''}
      ${ui.newOpen ? form : '<div class="btns"><button class="btn ghost" data-act="newdrink">+ New drink</button></div>'}
      ${waterRow(d)}${lastCafRow(d)}${datalists()}
      <div class="totals"><b>${totalMg(d)} mg</b> caffeine today<br><span class="muted">${t != null ? `target ${t} mg` : 'no target yet'}${t != null && mg <= t ? ` · ${t - mg} mg to spare` : t != null ? ` · ${mg - t} mg over` : ''}</span></div>
    </div>`;
}

function vPlan() {
  const p = S.plan;
  if (!p && S.baseline) {
    const bd = baselineDays();
    return `<div class="card"><h2>Learning your habit</h2>
      <p class="muted">Log everything you normally drink for 3 days — no targets, no pressure. Then your taper is built from your average.</p>
      <div class="stats"><div class="stat"><b>${Math.min(bd.length, 3)} / 3</b><span>days logged</span></div>
        <div class="stat"><b>${bd.length ? Math.round(avg(bd.slice(0, 3).map(totalMg))) : '—'}</b><span>avg mg / day so far</span></div></div>
      <p class="muted" style="margin-top:10px">Taper length once it starts: ${S.baseline.taperDays} days.</p>
      <div class="btns"><button class="btn ghost" data-act="cancelbaseline">I know my amount — enter it instead</button></div></div>`;
  }
  if (!p) return `<div class="card"><h2>Start a taper</h2><p class="muted">Enter how much caffeine you have in a day now, or let the app learn it over 3 days. You can change any of it later.</p>${setupForm()}</div>`;
  const ti = planIdx(today()), t = today();
  const rows = p.targets.map((v, i) => {
    const date = addDays(p.start, i), past = i < ti, now = i === ti;
    return `<div class="sched ${past ? 'past' : ''} ${now ? 'now' : ''}">
      <div class="dl">Day ${i + 1}<small>${short(date)}${now ? ' · today' : ''}</small></div>
      ${past ? `<span class="n" style="font-family:var(--font-head);font-size:22px">${S.hist[date] ?? v}</span>`
        : `<div class="stepper"><button class="round" data-act="ed-" data-i="${i}" aria-label="10 mg less on day ${i + 1}">−</button><span class="n">${v}</span><button class="round plus" data-act="ed+" data-i="${i}" aria-label="10 mg more on day ${i + 1}">+</button></div>`}
    </div>`;
  }).join('');
  const cur = target(t) ?? p.targets[0];
  return `
    ${p.completedOn ? completeCard() : ''}
    <div class="card">
      <div class="row"><h2 style="margin:0">Your taper</h2>${p.pausedAt ? '<span class="pill">Paused</span>' : '<span class="pill sage">Active</span>'}</div>
      <p class="muted">${p.targets[0]} mg → 0 over ${p.targets.length} days · started ${short(p.start)}${p.fromBaseline ? ' · based on your 3-day baseline' : ''}${p.pausedAt ? ` · paused since ${short(p.pausedAt)}` : ''}</p>
      <div class="btns">
        ${p.start > t && !p.pausedAt ? '<p class="muted" style="margin:0">Your taper starts tomorrow. You can pause once it’s underway.</p>' : `<button class="btn ${p.pausedAt ? 'rose' : 'ghost'}" data-act="${p.pausedAt ? 'resume' : 'pause'}">${p.pausedAt ? 'Resume taper' : 'Pause taper'}</button>`}
      </div>
    </div>
    <details class="card"><summary>Adjust from today</summary>
      <p class="muted">Re-spreads the remaining steps. Past days and your logs are untouched.</p>
      <label class="f" for="adjFrom">Caffeine per day (mg), starting today</label>
      <input id="adjFrom" type="number" inputmode="numeric" min="0" max="2000" step="5" value="${cur}">
      <label class="f" for="adjDays">Days from today until zero</label>
      <input id="adjDays" type="number" inputmode="numeric" min="1" max="365" value="${Math.max(p.targets.length - 1 - (ti ?? 0), 1)}">
      <div class="btns"><button class="btn" data-act="adjust">Apply</button></div>
    </details>
    <details class="card" ${ui.openRestart ? 'open' : ''}><summary>Restart a new taper</summary>
      <p class="muted">Begins a fresh plan today. All past logs and symptom history are kept.</p>
      ${setupForm()}
    </details>
    <div class="card"><h2>Day-by-day targets</h2>
      <p class="muted">Tap − / + to change any upcoming day (10 mg at a time).</p>${rows}</div>`;
}
function setupForm() {
  return `<label class="f" for="stCans">Caffeine per day now (mg)</label>
    <input id="stCans" type="number" inputmode="numeric" min="5" max="2000" step="5" value="${S.plan ? S.plan.targets[0] : 200}">
    <p class="muted" style="margin:4px 0 0">For reference: a cup of coffee is ~95 mg, a can of soda ~40 mg.</p>
    <label class="f" for="stDays">Total days (the last day is zero)</label>
    <input id="stDays" type="number" inputmode="numeric" min="2" max="365" value="${S.plan ? S.plan.targets.length : 28}">
    <div class="btns"><button class="btn rose" data-act="start">${S.plan ? 'Restart taper' : 'Begin my taper'}</button>
      <button class="btn ghost" data-act="startunknown">I’m not sure — track 3 days first</button></div>`;
}

/* ---- charts ---- */
function chart({ dates, series, ymax, label }) {
  const W = 340, H = 190, Lm = 26, R = 10, T = 10, B = 24, pw = W - Lm - R, ph = H - T - B, n = dates.length;
  const x = i => Lm + (n < 2 ? pw / 2 : pw * i / (n - 1));
  const y = v => T + ph * (1 - v / ymax);
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000].find(q => ymax / q <= 5) || 2000;
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
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label || 'Chart')}">${g}${lines}</svg>`;
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
  const ymaxC = Math.max(100, ...dates.map(d => Math.max(target(d) ?? 0, totalMg(d))));
  const ymaxI = Math.ceil(ymaxC / 50) * 50;
  const cs = [
    { color: cv('--c-target'), dash: true, w: 2.5, vals: dates.map(d => target(d)) },
    { color: cv('--c-caf'), dots: true, vals: dates.map(d => S.logs[d] ? totalMg(d) : null) },
  ];

  // stats
  const logged = Object.keys(S.logs).filter(d => target(d) != null);
  const base = S.plan ? S.plan.targets[0] : 0;
  const skipped = Math.round(logged.reduce((a, d) => a + Math.max(base - totalMg(d), 0), 0));
  const onTrack = logged.filter(d => totalMg(d) <= target(d)).length;
  const recent = Object.keys(S.logs).sort().slice(-7);
  const avgMg = recent.length ? Math.round(avg(recent.map(totalMg))) : 0;
  const streak = streakNow(), cut = cutoffStreak(), longest = bestStreak(), week = weekStats(today());
  const zeroDays = Object.keys(S.logs).filter(d => totalMg(d) === 0).length;
  const wd = Object.keys(S.water).filter(d => S.water[d] > 0).sort().slice(-7);
  const avgWater = wd.length ? n1(avg(wd.map(d => S.water[d]))) : '—';

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
    <div class="chips">${ranges.map(([v, l]) => `<button class="chip ${ui.range === v ? 'on' : ''}" data-act="range" data-v="${v}" aria-pressed="${ui.range === v}">${l}</button>`).join('')}</div>
    ${week.n ? `<div class="card"><h2>This week</h2>${weekHtml(week)}</div>` : ''}
    <div class="card"><h2>Caffeine vs. target (mg)</h2>
      ${chart({ dates, series: cs, ymax: ymaxI, label: `Caffeine in milligrams against your target over ${dates.length} days` })}
      <div class="legend"><span><i class="dash" style="border-color:${cv('--c-target')}"></i>Target</span><span><i style="border-color:${cv('--c-caf')}"></i>Caffeine you had</span></div>
    </div>
    <div class="card"><h2>Highlights</h2><div class="stats">
      <div class="stat"><b>${logged.length}</b><span>days logged</span></div>
      <div class="stat"><b>${onTrack}</b><span>days at or under target</span></div>
      <div class="stat"><b>${streak}</b><span>day streak on target</span></div>
      <div class="stat"><b>${skipped}</b><span>mg cut vs. your start, in total</span></div>
      <div class="stat"><b>${avgMg}</b><span>avg mg caffeine / day (last 7 logged)</span></div>
      <div class="stat"><b>${cut}</b><span>day streak, last caffeine before ${fmtTime(S.settings.cutoff)}</span></div>
      <div class="stat"><b>${zeroDays}</b><span>caffeine-free days</span></div>
      <div class="stat"><b>${avgWater}</b><span>avg ${esc(S.settings.waterUnit || 'glasses')} of ${esc((S.settings.waterName || 'water').toLowerCase())} / day</span></div>
      <div class="stat"><b>${longest}</b><span>longest streak on target</span></div>
      <div class="stat"><b>${S.plan ? Math.max(diff(S.plan.start, today()) + 1, 0) : 0}</b><span>days since your taper started</span></div></div></div>
    <div class="card"><h2>Milestones</h2>
      ${MILESTONES.map(([k, label]) => S.ms[k] ? `<div class="ms done">🌿 ${esc(label)} <span class="muted">· ${short(S.ms[k])}</span></div>`
        : `<div class="ms">○ ${esc(label)}${k !== 'zero' ? ` <span class="muted">· ${Math.min(streak, k === 's7' ? 7 : 14)} / ${k === 's7' ? 7 : 14}</span>` : ''}</div>`).join('')}
    </div>
    <div class="card"><h2>Symptoms over time</h2>
      <p class="muted" style="margin-top:-4px">0 = none, 3 = strong. Lower is better.</p>
      <div class="chips"><button class="chip ${ui.symSel.has('avg') ? 'on' : ''}" data-act="symsel" data-k="avg" aria-pressed="${ui.symSel.has('avg')}">Overall</button>
        ${SYMS.map(([k, n]) => `<button class="chip ${ui.symSel.has(k) ? 'on' : ''}" data-act="symsel" data-k="${k}" aria-pressed="${ui.symSel.has(k)}">${n}</button>`).join('')}</div>
      ${chart({ dates, series: sSeries, ymax: 3, label: `Symptom severity from 0 to 3 over ${dates.length} days` })}
      <p class="status" style="font-size:15px">${trend}</p>
    </div>`;
}

function vSettings() {
  const st = S.settings;
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  return `
    <div class="card"><h2>Appearance</h2>
      <div class="chips" style="margin-bottom:0">${[['auto', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button class="chip ${(st.theme || 'auto') === v ? 'on' : ''}" data-act="theme" data-v="${v}" aria-pressed="${(st.theme || 'auto') === v}">${l}</button>`).join('')}</div>
    </div>
    <div class="card"><h2>Daily reminder</h2>
      <div class="switch"><label for="remOn">Remind me to log</label><input id="remOn" type="checkbox" ${st.remind ? 'checked' : ''}></div>
      <label class="f" for="remTime">Reminder time</label>
      <input id="remTime" type="time" value="${st.time}">
      ${st.push ? `<div class="switch" style="margin-top:8px"><label for="eveOn">Evening follow-up if my check-in isn’t saved</label><input id="eveOn" type="checkbox" ${st.evening ? 'checked' : ''}></div>${st.evening ? `<label class="f" for="eveTime">Follow-up time (at least 2 hours after the reminder)</label><input id="eveTime" type="time" value="${st.eveningTime}">` : ''}` : ''}
      <p class="muted" style="margin-top:10px">${!supported ? 'This browser doesn’t support notifications.' : perm === 'denied' ? 'Notifications are blocked for this site — enable them in your browser settings.' : st.remind && st.push ? 'Push reminders are on: you’ll get a notification at this time even when the app is closed (skipped once you’ve logged something that day).' : 'On a phone, add the app to your home screen first. ' + (pushSupported() ? 'Turn this on for reminders that arrive even when the app is closed.' : 'Reminders fire when the app has been opened that day; for a guaranteed daily nudge, also add it to your calendar below.')}</p>
      <div class="btns">
        <button class="btn ghost" data-act="testnotif">Send a test</button>
        <button class="btn ghost" data-act="ics">Add to calendar (.ics)</button>
      </div>
    </div>
    <div class="card"><h2>My drinks</h2>
      <p class="muted" style="margin-top:-4px">Rename, resize, reorder or delete any drink, or add your own. Type and container can be anything you like.</p>
      ${st.presets.map((p, i) => drinkEditor(p, i, st.presets.length)).join('')}
      <div class="btns"><button class="btn ghost" data-act="addpreset">+ Add a drink</button></div>
      ${datalists()}
    </div>
    <div class="card"><h2>Water &amp; caffeine cutoff</h2>
      <div class="switch"><label for="waterOn">Show a water tally</label><input id="waterOn" type="checkbox" ${st.waterOn !== false ? 'checked' : ''}></div>
      <div class="two"><div><label class="f" for="waterName">Name</label><input id="waterName" type="text" maxlength="20" value="${esc(st.waterName || 'Water')}"></div>
        <div><label class="f" for="waterUnit">Unit</label><input id="waterUnit" type="text" maxlength="20" value="${esc(st.waterUnit || 'glasses')}"></div></div>
      <label class="f" for="cutoff">Caffeine cutoff time</label>
      <input id="cutoff" type="time" value="${st.cutoff}">
      <p class="muted" style="margin:4px 0 0">Used for the “last caffeine before…” streak. Many people sleep better with none after early afternoon.</p>
    </div>
    <div class="card"><h2>Backups</h2>
      <p class="muted" style="margin-top:-4px">A safety copy is saved on this phone automatically each day (last 7), plus one before anything risky like erasing. They guard against mistakes in the app — but they live in the browser, so clearing site data removes them. Export a copy to Files or Drive now and then to keep your history safe.</p>
      <p class="muted">Last exported: ${st.lastExport ? nice(st.lastExport) : 'never'}</p>
      <div class="btns"><button class="btn" data-act="export">Export backup</button><button class="btn ghost" data-act="import">Import backup</button></div>
      <input id="importFile" type="file" accept="application/json" hidden>
      ${(() => { const b = readBackups().slice().reverse(); return b.length ? `<h3>Safety copies on this phone</h3>${b.map(x => `<div class="lrow"><div class="lname"><b>${x.label ? esc(x.label) : 'Automatic'}</b><small>${nice(x.date)}</small></div><button class="btn ghost" style="min-height:40px;padding:8px 14px" data-act="restore" data-ts="${x.ts}">Restore</button></div>`).join('')}<div class="btns"><button class="btn ghost" data-act="delbackups">Delete safety copies</button></div>` : ''; })()}
    </div>
    ${cloudCard()}
    <div class="card"><h2>Erase</h2>
      <p class="muted" style="margin-top:-4px">Removes all plans, logs and symptoms. A safety copy is kept so you can undo it.</p>
      <div class="btns"><button class="btn danger" data-act="wipe">Erase everything</button></div>
    </div>
    <div class="card"><h2>About</h2>
      <p class="muted" style="margin-top:-4px">Gentle Taper is a personal tracking tool, not medical advice. Suggestions like “hold steady” are general nudges based on what you log. Stopping caffeine can cause headaches, fatigue and low mood; if symptoms are severe, don’t ease, or you have a heart condition or take medication, please talk with a doctor or pharmacist.</p>
    </div>`;
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const tab = e.target.closest('#tabs button');
  if (tab) { ui.openRestart = false; ui.view = tab.dataset.view; render(); window.scrollTo(0, 0); return; }
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, d = ui.date, p = S.plan;
  const nm = document.getElementById('nd-name');
  if (nm) ui.draft = { name: nm.value, type: document.getElementById('nd-type').value, cont: document.getElementById('nd-cont').value,
    oz: document.getElementById('nd-oz').value, mg: document.getElementById('nd-mg').value, fav: document.getElementById('nd-fav').checked };
  const L = () => S.logs[d] || { caf: 0, decaf: 0 };
  switch (act) {
    case 'prev': ui.date = addDays(d, -1); ui.followToday = false; break;
    case 'next': if (d < today()) { ui.date = addDays(d, 1); ui.followToday = ui.date === today(); } break;
    case 'dr+': case 'dr-': {
      const id = el.dataset.id, ent = S.logs[d]?.drinks?.[id];
      const pr = S.settings.presets.find(x => x.id === id) || (ent ? { ...ent, id } : null);
      if (pr) { setDrink(d, pr, act === 'dr+' ? 1 : -1); if (act === 'dr+' && (ent ? ent.mg : pr.mg) > 0) stamp(d); }
      break;
    }
    case 'wat+': S.water[d] = Math.min((S.water[d] || 0) + 1, 30); save(); break;
    case 'wat-': if (S.water[d] > 0) { S.water[d]--; save(); } break;
    case 'hold': {
      snapshot();
      const i = planIdx(today()) ?? 0, cur = target(today());
      const head = p.targets.slice(0, i); while (head.length < i) head.push(p.targets[p.targets.length - 1] ?? 0);
      p.targets = head.concat([cur, cur], p.targets.slice(i));
      S.pace.snooze = addDays(today(), 3); snapshot(); save(); toast('Holding steady for 3 days. You’re doing fine 🌿'); break;
    }
    case 'weekok': S.pace.weekly = today(); save(); break;
    case 'slipkeep': S.pace.slip = today(); save(); break;
    case 'sliphold': {
      snapshot();
      const i = planIdx(today()), cur = target(today());
      if (i != null) { const head = p.targets.slice(0, i + 1); while (head.length < i + 1) head.push(cur); p.targets = head.concat([cur], p.targets.slice(i + 1)); }
      S.pace.slip = today(); snapshot(); save(); toast('Tomorrow holds the same level. Steady wins 🌿'); break;
    }
    case 'newtaper': ui.view = 'plan'; ui.openRestart = true; break;
    case 'maintok': S.pace.maint = addDays(today(), 3); save(); break;
    case 'snooze': S.pace.snooze = addDays(today(), 2); save(); break;
    case 'nudgelater': S.settings.nudgeSnooze = addDays(today(), 3); save(); break;
    case 'delday':
      if (confirm('Remove all drinks logged for this day? Your symptoms for the day stay.')) { delete S.logs[d]; delete S.water[d]; save(); } else return;
      break;
    case 'restore': {
      const e = readBackups().find(x => x.ts === +el.dataset.ts);
      if (e && confirm('Replace everything in the app with this safety copy? Your current data is saved as a safety copy first.')) {
        let restored; try { restored = normalize(JSON.parse(e.json)); } catch (err) { toast('That safety copy is damaged'); return; }
        pushBackup('Before restore'); S = restored; migrate(); save(); applyTheme(); ui.date = today(); ui.followToday = true; syncPushDaily(); toast('Restored');
      } else return;
      break;
    }
    case 'delbackups': if (confirm('Delete all safety copies from this phone?')) { try { localStorage.removeItem(BK); } catch (err) { /* ignore */ } } else return; break;
    case 'sev': setSym(d, { [el.dataset.k]: +el.dataset.v, done: true }); break;
    case 'savecheck': {
      setLog(d, {});
      const ta = document.getElementById('notes');
      setSym(d, { done: true, notes: ta ? ta.value : (S.sym[d]?.notes || '') });
      toast('Saved. Be gentle with yourself 🌿'); if (d === today()) pushDone();
      break;
    }
    case 'range': ui.range = +el.dataset.v; break;
    case 'symsel': {
      const k = el.dataset.k;
      if (ui.symSel.has(k)) { if (ui.symSel.size > 1) ui.symSel.delete(k); } else ui.symSel.add(k);
      break;
    }
    case 'start': {
      const rawMg = parseInt(document.getElementById('stCans').value, 10);
      if (!(rawMg >= 5)) { toast('Enter your daily caffeine in mg (5 or more)'); return; }
      const mgNow = clamp(rawMg, 5, 2000);
      const days = clamp(parseInt(document.getElementById('stDays').value, 10) || 28, 2, 365);
      if (S.plan) { snapshot(); S.pastPlans.push(S.plan); }
      S.baseline = null; ui.followToday = true;
      S.plan = { start: today(), targets: gen(mgNow, days), pausedAt: null };
      snapshot(); save(); ui.view = 'today'; ui.date = today(); toast('Your taper has begun 🌸');
      break;
    }
    case 'startunknown': {
      const days = clamp(parseInt(document.getElementById('stDays').value, 10) || 28, 2, 365);
      if (S.plan) { snapshot(); S.pastPlans.push(S.plan); S.plan = null; }
      S.baseline = { start: today(), taperDays: days }; save(); ui.view = 'today'; ui.date = today(); ui.followToday = true;
      toast('Great — log what you normally drink for 3 days 🌿'); break;
    }
    case 'cancelbaseline': S.baseline = null; save(); break;
    case 'pause': snapshot(); p.pausedAt = today(); save(); toast('Taper paused'); break;
    case 'resume': {
      snapshot();
      p.start = addDays(p.start, diff(p.pausedAt, today())); p.pausedAt = null;
      snapshot(); save(); toast('Welcome back'); break;
    }
    case 'adjust': {
      snapshot();
      const from = clamp(parseInt(document.getElementById('adjFrom').value, 10) || 0, 0, 2000);
      const n = clamp(parseInt(document.getElementById('adjDays').value, 10) || 1, 1, 365);
      const i = planIdx(today()) ?? 0;
      const head = p.targets.slice(0, i); while (head.length < i) head.push(p.targets[p.targets.length - 1] ?? 0);
      p.targets = head.concat(gen(from, n + 1));
      snapshot(); save(); toast('Schedule adjusted'); break;
    }
    case 'ed+': case 'ed-': {
      const i = +el.dataset.i;
      p.targets[i] = clamp(p.targets[i] + (act === 'ed+' ? 10 : -10), 0, 2000);
      save(); break;
    }
    case 'addpreset': S.settings.presets.push({ id: 'p' + Date.now().toString(36), name: 'New drink', type: 'Other', container: 'Can', oz: null, mg: 50, fav: false }); save(); break;
    case 'fav': { const pr = S.settings.presets.find(x => x.id === el.dataset.id); if (pr) { pr.fav = !isFav(pr); save(); } break; }
    case 'newdrink': ui.newOpen = !ui.newOpen; ui.draft = null; break;
    case 'savedrink': {
      const name = document.getElementById('nd-name').value.trim();
      if (!name) { toast('Give it a name first'); return; }
      const oz = parseFloat(document.getElementById('nd-oz').value);
      const pr = { id: 'p' + Date.now().toString(36), name, type: document.getElementById('nd-type').value, container: document.getElementById('nd-cont').value,
        oz: oz > 0 ? oz : null, mg: clamp(parseInt(document.getElementById('nd-mg').value, 10) || 0, 0, 1000), fav: document.getElementById('nd-fav').checked };
      S.settings.presets.push(pr); setDrink(d, pr, 1); if (pr.mg > 0) stamp(d); ui.newOpen = false; ui.draft = null; toast(`Logged ${name}`); break;
    }
    case 'theme': S.settings.theme = el.dataset.v; save(); applyTheme(); break;
    case 'delpreset': {
      const pr = S.settings.presets.find(x => x.id === el.dataset.id);
      if (pr && confirm(`Delete “${pr.name}” from your drinks? Days where you logged it keep it.`)) {
        S.settings.presets = S.settings.presets.filter(x => x.id !== pr.id); if (ui.editId === pr.id) ui.editId = null; save();
      } else return;
      break;
    }
    case 'editdrink': ui.editId = ui.editId === el.dataset.id ? null : el.dataset.id; break;
    case 'editdone': ui.editId = null; break;
    case 'mvup': case 'mvdown': {
      const arr = S.settings.presets, i = arr.findIndex(x => x.id === el.dataset.id), j = act === 'mvup' ? i - 1 : i + 1;
      if (i >= 0 && j >= 0 && j < arr.length) { [arr[i], arr[j]] = [arr[j], arr[i]]; save(); }
      break;
    }
    case 'cloudon': cloudOn(); return;
    case 'cloudnow': cloudBackupNow(true); return;
    case 'cloudcode': ui.showCode = !ui.showCode; break;
    case 'copycode': { const c = getCloud(); if (c && navigator.clipboard) navigator.clipboard.writeText(c.code).then(() => toast('Copied')).catch(() => toast('Select the code and copy it')); else toast('Select the code and copy it'); return; }
    case 'cloudoff': if (confirm('Turn off cloud backup and delete the cloud copy? Your data on this phone stays.')) { cloudOff(); } return;
    case 'cloudrestore': cloudRestore(+el.dataset.gen || 0); return;
    case 'testnotif': testNotif(); return;
    case 'ics': downloadICS(); return;
    case 'export': exportData(); return;
    case 'import': document.getElementById('importFile').click(); return;
    case 'wipe':
      if (confirm('Erase all plans, logs and symptoms from this device? A safety copy is kept under Backups so you can undo it.')) {
        pushBackup('Before erase'); S = defaults(); save(); applyTheme(); ui.view = 'plan'; ui.date = today(); ui.followToday = true; syncPushDaily();
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
    S.settings.lastNotified = '';
    if (S.settings.remind) {
      S.settings.push = await enablePush();
      if (pushSupported() && !S.settings.push) toast('Couldn’t reach the reminder service — using on-device reminders');
    } else { await disablePush(); S.settings.push = false; }
    save(); scheduleTrigger(); render();
  } else if (t.id === 'eveOn') {
    S.settings.evening = t.checked; save(); syncPushDaily(true); render();
  } else if (t.id === 'eveTime') {
    S.settings.eveningTime = t.value || '20:00'; save(); syncPushDaily(true); toast('Follow-up time saved');
  } else if (t.id === 'waterOn') {
    S.settings.waterOn = t.checked; save(); render();
  } else if (t.id === 'waterName') {
    S.settings.waterName = t.value.trim() || 'Water'; save(); toast('Saved');
  } else if (t.id === 'waterUnit') {
    S.settings.waterUnit = t.value.trim() || 'glasses'; save(); toast('Saved');
  } else if (t.id === 'nd-type') {
    const known = Object.keys(TYPE_MG).find(x => x.toLowerCase() === t.value.trim().toLowerCase());
    if (known !== undefined) document.getElementById('nd-mg').value = TYPE_MG[known];
  } else if (t.dataset.pid) {
    const p = S.settings.presets.find(x => x.id === t.dataset.pid), f = t.dataset.f;
    if (p) {
      if (f === 'mg') p.mg = clamp(parseInt(t.value, 10) || 0, 0, 1000);
      else if (f === 'oz') p.oz = parseFloat(t.value) > 0 ? parseFloat(t.value) : null;
      else if (f === 'name') p.name = t.value.trim() || 'Drink';
      else p[f] = t.value.trim();
      save(); toast('Saved');
    }
  } else if (t.id === 'lastCaf') {
    setLog(ui.date, { lastCaf: t.value || null }); render();
  } else if (t.id === 'cutoff') {
    S.settings.cutoff = t.value || '14:00'; save(); toast('Saved');
  } else if (t.id === 'remTime') {
    S.settings.time = t.value || '09:00'; S.settings.lastNotified = ''; save(); scheduleTrigger(); syncPushDaily(true); toast('Reminder time saved');
  } else if (t.id === 'importFile' && t.files[0]) {
    try {
      const data = JSON.parse(await t.files[0].text());
      if (!data || typeof data !== 'object' || !('logs' in data)) throw new Error('bad');
      pushBackup('Before import'); S = normalize(data); migrate(); save(); applyTheme(); ui.date = today(); ui.followToday = true; syncPushDaily(); render(); toast('Backup restored');
    } catch (err) { toast('That file doesn’t look like a backup'); }
    t.value = ''; // so choosing the same file again still works
  }
});

/* ---------- push reminders ---------- */
const swReady = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('no service worker')), 5000))]);
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !PUSH_URL.includes('REPLACE');
const keyBytes = b64 => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function pushPost(path, body) {
  const r = await fetch(PUSH_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(path + ' ' + r.status);
  return r.json();
}
async function syncPush(sub) {
  await pushPost('/subscribe', { subscription: sub.toJSON(), time: S.settings.time, evening: S.settings.evening ? S.settings.eveningTime : '', tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  S.settings.pushSynced = today(); save();
}
let pushBusy = false;
async function enablePush() {
  if (!pushSupported()) return false;
  pushBusy = true;
  try {
    const reg = await swReady();
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(PUSH_KEY) });
    await syncPush(sub); return true;
  } catch (e) { return false; } finally { pushBusy = false; }
}
async function disablePush() {
  pushBusy = true;
  try {
    const sub = await (await swReady()).pushManager.getSubscription();
    if (sub) { const ep = sub.endpoint; await sub.unsubscribe(); await pushPost('/unsubscribe', { endpoint: ep }).catch(() => {}); }
  } catch (e) { /* ignore */ } finally { pushBusy = false; }
}
let touchBusy = false;
async function pushTouch() { // first log of the day: the server then skips the main reminder
  if (touchBusy || !S.settings.push || !pushSupported() || S.settings.touchedPing === today()) return;
  touchBusy = true;
  try {
    const sub = await (await swReady()).pushManager.getSubscription();
    if (sub) { await pushPost('/touch', { endpoint: sub.endpoint, date: today() }); S.settings.touchedPing = today(); save(); }
  } catch (e) { /* ignore */ } finally { touchBusy = false; }
}
async function pushDone() { // tell the server we've checked in today so it skips the reminder
  if (!S.settings.push || !pushSupported()) return;
  try { const sub = await (await swReady()).pushManager.getSubscription(); if (sub) await pushPost('/done', { endpoint: sub.endpoint, date: today() }); } catch (e) { /* ignore */ }
}
// Keeps the server in step with this device: re-registers about once a day (stays alive, follows time-zone changes),
// and removes a leftover subscription if reminders are off (e.g. after Erase, Restore or Import).
async function syncPushDaily(force) {
  if (!pushSupported() || pushBusy) return;
  try {
    const sub = await (await swReady()).pushManager.getSubscription();
    if (!sub) { if (S.settings.push) { S.settings.push = false; save(); } return; }
    if (!(S.settings.remind && S.settings.push)) { await disablePush(); return; }
    if (force || S.settings.pushSynced !== today()) await syncPush(sub);
  } catch (e) { /* ignore */ }
}

/* ---------- encrypted cloud backup ---------- */
// Everything is encrypted on this device with a key derived from a recovery code that never leaves it.
// The service stores only ciphertext under an ID derived from the same code, so it can't read anything.
const getCloud = () => { try { return JSON.parse(localStorage.getItem(CLOUD_KEY)); } catch (e) { return null; } };
const setCloud = c => { try { localStorage.setItem(CLOUD_KEY, JSON.stringify(c)); } catch (e) { /* ignore */ } };
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const hasData = () => Object.keys(S.logs).length > 0 || !!S.plan || !!S.baseline;
const b64 = buf => { const u = new Uint8Array(buf); let out = ''; for (let i = 0; i < u.length; i += 0x8000) out += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(out); };
const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));
function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(25)); let c = '';
  for (let i = 0; i < 25; i++) { c += CROCK[r[i] & 31]; if (i % 5 === 4 && i < 24) c += '-'; }
  return c;
}
function normCode(t) { // forgiving about case, dashes, spaces and look-alike letters
  const c = String(t || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
  return c.length === 25 && [...c].every(ch => CROCK.includes(ch)) ? c : null;
}
async function cloudKeys(code) {
  const norm = normCode(code); if (!norm) throw new Error('bad code');
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(norm), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const p = info => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: new TextEncoder().encode(info) });
  const id = b64url(await crypto.subtle.deriveBits(p('gentle-taper id'), base, 256));
  const key = await crypto.subtle.deriveKey(p('gentle-taper key'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { id, key };
}
async function encryptState(key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(S)));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}
async function decryptState(key, blob) {
  const { iv, ct } = JSON.parse(blob);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function cloudBackupNow(manual) {
  const c = getCloud();
  if (!c || cloudBusy) return false;
  if (!hasData()) { if (manual) toast('Nothing to back up yet'); return false; } // never overwrite a good copy with an empty one
  cloudBusy = true;
  try {
    const { id, key } = await cloudKeys(c.code);
    await pushPost('/backup/put', { id, blob: await encryptState(key) });
    const c2 = getCloud() || c; c2.last = Date.now(); c2.lastDay = today(); setCloud(c2); cloudPending = false;
    if (manual) toast('Backed up to the cloud 🌿');
    if (ui.view === 'settings') render();
    return true;
  } catch (e) {
    if (manual) toast(String(e.message).includes('429') ? 'Just backed up — try again in a moment' : String(e.message).includes('413') ? 'Your data is too large to back up' : 'Couldn’t reach the backup service — it will retry');
    return false;
  } finally { cloudBusy = false; }
}
function cloudDirty() { // after any change, back up shortly (at most every 30 minutes)
  if (!getCloud()) return;
  cloudPending = true; clearTimeout(cloudT);
  cloudT = setTimeout(() => { const c = getCloud(); if (c && Date.now() - (c.last || 0) > 30 * 60 * 1000) cloudBackupNow(false); }, 90000);
}
function cloudDaily() { const c = getCloud(); if (c && c.lastDay !== today() && hasData()) cloudBackupNow(false); }
async function cloudOn() {
  setCloud({ code: newCode(), last: 0, lastDay: '' }); ui.showCode = true; render();
  await cloudBackupNow(true);
}
async function cloudOff() {
  const c = getCloud();
  try { if (c) await pushPost('/backup/delete', { id: (await cloudKeys(c.code)).id }); } catch (e) { toast('Couldn’t reach the service, but backups are now off here'); }
  try { localStorage.removeItem(CLOUD_KEY); } catch (e) { /* ignore */ }
  ui.showCode = false; render(); toast('Cloud backup turned off');
}
async function cloudRestore(gen) {
  const typed = document.getElementById('cloudCodeIn'), code = (typed && typed.value.trim()) || (getCloud() || {}).code;
  if (!normCode(code)) return toast('That recovery code doesn’t look right — it has 25 letters and numbers');
  let data;
  try {
    const { id, key } = await cloudKeys(code);
    const r = await pushPost('/backup/get', { id, gen });
    data = await decryptState(key, r.blob);
    if (!data || typeof data !== 'object' || !('logs' in data)) throw new Error('bad');
  } catch (e) {
    return toast(String(e.message).includes('404') ? (gen ? 'No older copy yet' : 'No backup found for that code') : String(e.message).includes('bad') || e.name === 'OperationError' ? 'Couldn’t open that backup with this code' : 'Couldn’t reach the backup service');
  }
  if (!confirm('Replace everything in the app with this cloud copy? Your current data is saved as a safety copy first.')) return;
  pushBackup('Before cloud restore');
  S = normalize(data); migrate();
  S.settings.remind = false; S.settings.push = false; S.settings.pushSynced = ''; // this device needs its own reminder setup
  save(); applyTheme(); ui.date = today(); ui.followToday = true;
  setCloud({ code: normCode(code).replace(/(.{5})(?=.)/g, '$1-'), last: Date.now(), lastDay: today() });
  syncPushDaily(); render(); toast('Restored from the cloud 🌿');
}
function cloudCard() {
  const c = getCloud();
  const note = '<p class="muted" style="margin-top:-4px">Your data is encrypted on your phone with a recovery code only you hold, then stored in the cloud. Nobody else — including me — can read it. If you lose both your phone and the code, the backup can’t be opened.</p>';
  if (!c) return `<div class="card"><h2>Cloud backup</h2>${note}
      <div class="btns"><button class="btn rose" data-act="cloudon">Turn on cloud backup</button></div>
      <h3>On a new phone?</h3>
      <label class="f" for="cloudCodeIn">Enter your recovery code</label>
      <input id="cloudCodeIn" type="text" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX">
      <div class="btns"><button class="btn ghost" data-act="cloudrestore" data-gen="0">Restore from cloud</button></div></div>`;
  const when = c.last ? new Date(c.last).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'not yet';
  return `<div class="card"><div class="row"><h2 style="margin:0">Cloud backup</h2><span class="pill sage">On</span></div>${note.replace('margin-top:-4px', 'margin-top:8px')}
      <p class="muted">Last backed up: ${when}. It also backs up by itself as you log.</p>
      ${ui.showCode ? `<div class="codebox"><div class="code">${esc(c.code)}</div>
        <p class="muted" style="margin:6px 0 0">Save this in your password manager or notes. It’s the only way to restore on a new phone.</p>
        <div class="btns"><button class="btn ghost" data-act="copycode">Copy</button><button class="btn ghost" data-act="cloudcode">Hide</button></div></div>` : ''}
      <div class="btns"><button class="btn" data-act="cloudnow">Back up now</button>${ui.showCode ? '' : '<button class="btn ghost" data-act="cloudcode">Show recovery code</button>'}</div>
      <h3>Restore from the cloud</h3>
      <div class="btns"><button class="btn ghost" data-act="cloudrestore" data-gen="0">Latest</button><button class="btn ghost" data-act="cloudrestore" data-gen="1">Previous</button><button class="btn ghost" data-act="cloudrestore" data-gen="2">Older</button></div>
      <div class="btns"><button class="btn danger" data-act="cloudoff">Turn off &amp; delete cloud copy</button></div></div>`;
}

/* ---------- reminders ---------- */
function notify(title, body) {
  const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'taper-daily' };
  const fallback = () => { try { new Notification(title, opts); } catch (e) { /* ignore */ } };
  if ('serviceWorker' in navigator) swReady().then(r => r.showNotification(title, opts)).catch(fallback); else fallback();
}
async function testNotif() {
  if (!('Notification' in window)) return toast('Notifications aren’t supported here');
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') return toast('Notifications are blocked');
  if (S.settings.push && pushSupported()) {
    try {
      const sub = await (await swReady()).pushManager.getSubscription();
      if (sub) { const r = await pushPost('/test', { endpoint: sub.endpoint }); return toast(r.ok ? 'Test push sent — it should arrive in a moment' : `The push service replied ${r.status}`); }
    } catch (e) { toast(String(e.message).includes('429') ? 'One test a minute, please' : 'Couldn’t send a test push — sending one from this device instead'); }
  }
  notify('Gentle Taper', 'A soft little reminder to log your drinks and how you feel 🌿');
}
function checkReminder() {
  const st = S.settings;
  if (!st.remind || st.push || !('Notification' in window) || Notification.permission !== 'granted') return;
  const t = today();
  if (st.lastNotified === t) return;
  const now = new Date(), [h, m] = st.time.split(':').map(Number);
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
  st.lastNotified = t; save();
  if (S.logs[t] || (S.sym[t] && S.sym[t].done)) return; // already logged something today
  notify('Gentle Taper', 'Time to log your drinks and how you’re feeling 🌿');
}
// Chrome-only experimental API; harmless no-op elsewhere.
async function scheduleTrigger() {
  try {
    if (!('showTrigger' in Notification.prototype) || typeof TimestampTrigger === 'undefined') return;
    const reg = await swReady();
    (await reg.getNotifications({ tag: 'taper-scheduled', includeTriggered: false })).forEach(n => n.close());
    if (!S.settings.remind || S.settings.push || Notification.permission !== 'granted') return;
    const [h, m] = S.settings.time.split(':').map(Number);
    for (let k = 0; k < 7; k++) {
      const at = new Date(); at.setDate(at.getDate() + k); at.setHours(h, m, 0, 0);
      if (at > new Date()) await reg.showNotification('Gentle Taper', { body: 'Time to log your drinks and how you’re feeling 🌿', tag: 'taper-scheduled', icon: 'icons/icon-192.png', showTrigger: new TimestampTrigger(at.getTime()) });
    }
  } catch (e) { /* ignore */ }
}
function downloadICS() {
  const [h, m] = S.settings.time.split(':').map(Number);
  const s = new Date(), stamp = `${fmt(s).replace(/-/g, '')}T${pad(h)}${pad(m)}00`, utc = s.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Gentle Taper//EN', 'BEGIN:VEVENT',
    `UID:gentle-taper-daily@local`, `DTSTAMP:${utc}`, `DTSTART:${stamp}`, 'DURATION:PT10M', 'RRULE:FREQ=DAILY',
    'SUMMARY:Log my drinks & symptoms 🌿', 'DESCRIPTION:Open Gentle Taper and check in.',
    'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', 'DESCRIPTION:Log my drinks & symptoms', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  saveBlob(new Blob([ics], { type: 'text/calendar' }), 'gentle-taper-reminder.ics');
}
async function exportData() {
  const json = JSON.stringify(S, null, 2), name = `gentle-taper-backup-${today()}.json`;
  const done = () => { S.settings.lastExport = today(); save(); render(); toast('Backup exported'); };
  try {
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Gentle Taper backup' }); return done(); }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  saveBlob(new Blob([json], { type: 'application/json' }), name); done();
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
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = dark ? '#1c2a21' : '#cfe5d3';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); render(); });
document.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('more')) ui.moreOpen = e.target.open; }, true);

/* ---------- boot ---------- */
applyTheme();
applyDecor();
pushBackup();
if (!S.plan && !S.baseline) ui.view = 'plan';
handleLaunchParams();
render();
checkReminder(); scheduleTrigger(); syncPushDaily(); setTimeout(cloudDaily, 4000);
// Home-screen shortcuts open the app with ?quick=<drink>; log one and tidy the URL.
function handleLaunchParams() {
  const quick = new URLSearchParams(location.search).get('quick');
  if (!quick) return;
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  const d = today();
  const pr = S.settings.presets.find(x => x.id === (quick === 'cans' ? 'can' : quick)); // 'cans' = old shortcut name
  if (!pr) return;
  setDrink(d, pr, 1); if (pr.mg > 0) stamp(d); toast(`Logged ${pr.name}`);
  ui.date = d; ui.followToday = true; if (S.plan || S.baseline) ui.view = 'today';
}
// If the app was left open past midnight, move "today" forward (unless the user is looking at an older day on purpose).
function rollover() { pushBackup(); if (ui.followToday && ui.date !== today()) { ui.date = today(); render(); } }
setInterval(() => { checkReminder(); rollover(); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { rollover(); checkReminder(); syncPushDaily(); cloudDaily(); }
  else if (cloudPending) { const c = getCloud(); if (c && Date.now() - (c.last || 0) > 5 * 60 * 1000) cloudBackupNow(false); }
});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
