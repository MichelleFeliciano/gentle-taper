'use strict';

/*
 * Gentle Taper — a private caffeine-taper tracker. One-page PWA, no build step, no accounts.
 *
 * FILES   index.html  page shell            styles.css  all styling (light + dark themes)
 *         app.js      this file             sw.js       offline cache + push notifications
 *         worker/     Cloudflare Worker: daily push reminders + encrypted cloud backup
 *
 * DATA    Everything the user owns is ONE object, `S`, saved as JSON in localStorage (see KEY). Shape (version 3):
 *   plan      { start, targets:[mg per day], pausedAt, completedOn?, fromBaseline? } or null
 *   baseline  { start, taperDays } while the app learns the user's habit for 3 days, otherwise null
 *   hist      { 'YYYY-MM-DD': mg }   the target that applied on each past day (frozen so edits never rewrite history)
 *   logs      { 'YYYY-MM-DD': { drinks:{ key:{ n, mg, name, type, container } }, adds:[{ id, t }], lastCaf:'HH:MM',
 *                               caf, decaf } }   caf/decaf are legacy counters, always 0 now (migrated into `drinks`)
 *   sym       { 'YYYY-MM-DD': { headache, fatigue, irritability, nausea, focus, mood: 0-3, done, notes } }
 *   water     { 'YYYY-MM-DD': count }   a plain tally; it is NOT a drink and never makes a day count as "logged"
 *   trash     [{ id, kind:'drink'|'day'|'entry', label, t, date?, data }]  "Recently deleted" (kept 30 days, newest first)
 *   ms, pace  milestones reached / dates the gentle prompts were dismissed
 *   settings  reminders, caffeine cutoff, theme, water labels, and `presets` (the user's editable drink list)
 *
 * RULES   Dates are local-time 'YYYY-MM-DD' strings (they sort as text). Caffeine is measured in mg.
 *         A day is "logged" once S.logs[date] exists. Today's partial day never completes a baseline or a milestone.
 *
 * FLOW    Data changes call save(); render() rebuilds the visible tab as an HTML string (the v* functions);
 *         all clicks/inputs are handled by delegated listeners on `document` (see "events").
 *
 * ALSO STORED (separate localStorage keys, never inside S or exports): gentle-taper-cloud (recovery code), gentle-taper-backups
 *   (safety copies), gentle-taper-history (journal of recent changes: labels only), gentle-taper-lock (app-lock hash).
 *
 * Sections: constants & state · dates · plan logic · ui state · decoration · helpers · safety copies · history & undo ·
 *           recently deleted · views · charts · help & search · events · push reminders · encrypted cloud backup ·
 *           import & export · app lock · updates & status · local reminders · theme · boot
 */

/* ---------- constants & state ---------- */
// localStorage key that holds the whole app state `S`. The "-v1" is historic; the data version is S.v.
const KEY = 'gentle-taper-v1';
// App version. Shown in Settings and kept equal to the number in sw.js's CACHE name (a test checks this), so "version N" always
// means "the files cached as gentle-taper-vN". Bump it with every release, together with sw.js, CHANGES below and CHANGELOG.md.
const VERSION = 19;
// What changed in each version, newest first. CHANGELOG.md says the same thing (a test keeps the two in step). `date` is the release day.
const CHANGES = [
  { v: 19, date: '2026-10-26', notes: [
    'Updates: a banner tells you when a new version is ready, with an Update now button. Settings shows the version, its date and what changed.',
    'Your data: Import now checks the file first and shows what it would add, then merges without overwriting anything. Exports carry a version number.',
    'Undo and Redo, a History list, an Undo button after deletes, and a Recently deleted list with Restore.',
    'Search across everything, a Help page, a welcome card, and a Settings check that lists what is on or off.',
    'Text size setting, an offline notice, a storage warning, and an optional PIN or password lock.',
    'Tests now run on GitHub before every deploy, and a failing test stops the deploy.',
  ] },
  { v: 18, date: '2026-10-11', notes: [
    'Colour, contrast and focus-outline fixes; wide-screen vines; landscape safe-area padding.',
    'Earlier versions: the taper plan, drink logging and favourites, symptoms, reminders, push notifications, encrypted cloud backup and dark mode.',
  ] },
];
// The file format of exports (the "format" number inside the file). Raise it only when the file layout changes in a way old versions can't read.
const FORMAT = 1;
// Where the journal of recent changes and the app lock live (outside S, so they never end up in an export).
const HIST_KEY = 'gentle-taper-history', LOCK_KEY = 'gentle-taper-lock';
// The six withdrawal symptoms checked in each day, as [storage key, label]. Each is rated 0-3.
const SYMS = [
  ['headache', 'Headache'], ['fatigue', 'Fatigue'], ['irritability', 'Irritability'],
  ['nausea', 'Nausea'], ['focus', 'Trouble focusing'], ['mood', 'Low mood'],
];
// Labels for the 0-3 severity scale, indexed by the stored value.
const SEV = ['None', 'Mild', 'Moderate', 'Strong'];
// Suggestions only: a drink's type and container can be any text.
const TYPES = ['Soda', 'Coffee', 'Tea', 'Energy drink', 'Sparkling water', 'Pre-workout', 'Chocolate', 'Other'];
// Typical caffeine (mg) per type, used only to pre-fill the "new drink" form. Never applied silently.
const TYPE_MG = { 'Soda': 40, 'Coffee': 95, 'Tea': 47, 'Energy drink': 80, 'Sparkling water': 0, 'Pre-workout': 150, 'Chocolate': 20, 'Other': 0 };
const CONTAINERS = ['Can', 'Bottle', 'Cup', 'Mug', 'Shot', 'Glass', 'Pouch'];
// Push reminders: a small Cloudflare Worker (see /worker) sends a silent push at your reminder time.
const PUSH_URL = 'https://gentle-taper-push.michellefeliciano.workers.dev';
// Public VAPID key (safe to publish): it identifies this app to the browser's push service.
const PUSH_KEY = 'BPHoUIzOrOvN_ZCYwSIz0MtfsQOAU7RaiAPcQBT4KvjTNUony1ux9FJ4oqvqM7JTqxvF-jakowvk4C1Eg-61KXw';
const CLOUD_KEY = 'gentle-taper-cloud'; // recovery code + last upload time (kept out of S so it never lands in exports)
let cloudT = null, cloudBusy = false, cloudPending = false;
// Reads a CSS custom property (e.g. '--line') so the SVG charts follow the light/dark theme.
const cv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/**
 * A brand-new, empty app state (version 3) with the starter drink list.
 * Also the template that normalize() fills missing keys from, so new settings always get a default.
 * @returns {object} a fresh state object
 */
function defaults() {
  return { v: 3, water: {}, ms: {}, pace: {}, trash: [], baseline: null, plan: null, pastPlans: [], hist: {}, logs: {}, sym: {}, settings: { textSize: 'normal', welcomed: false, seenVer: 0, remind: false, time: '09:00', lastNotified: '', canMg: 40, theme: 'auto', cutoff: '14:00', waterOn: true, waterName: 'Water', waterUnit: 'glasses', evening: false, eveningTime: '20:00', touchedPing: '', lastExport: '', nudgeSnooze: '', presets: [
    { id: 'can', name: 'Caffeinated can', type: 'Soda', container: 'Can', oz: 12, mg: 40, fav: true },
    { id: 'decaf', name: 'Caffeine-free can', type: 'Soda', container: 'Can', oz: 12, mg: 0, fav: true },
    { id: 'soda', name: 'Soda', type: 'Soda', container: 'Bottle', oz: 20, mg: 57, fav: true },
    { id: 'coffee', name: 'Coffee', type: 'Coffee', container: 'Cup', oz: 8, mg: 95, fav: true },
    { id: 'energy', name: 'Energy drink', type: 'Energy drink', container: 'Can', oz: 16, mg: 160, fav: false },
    { id: 'tea', name: 'Tea', type: 'Tea', container: 'Cup', oz: 8, mg: 47, fav: false },
  ] } };
}
/**
 * Turns any parsed state (saved data, an import, a backup, a cloud restore) into a complete, safe state object.
 * Missing keys are filled from defaults(); containers that must be objects/arrays are repaired.
 * `v` is copied as-is (not defaulted) so migrate() can tell old data from new.
 * @param {object} s parsed state of any age
 * @returns {object} complete state
 */
function normalize(s) {
  const d = defaults(), out = Object.assign(d, s, { v: s.v, settings: Object.assign(d.settings, s.settings) });
  if (!Array.isArray(out.settings.presets)) out.settings.presets = defaults().settings.presets;
  if (!Array.isArray(out.pastPlans)) out.pastPlans = [];
  if (!Array.isArray(out.trash)) out.trash = [];
  ['hist', 'logs', 'sym', 'water', 'ms', 'pace'].forEach(k => { if (!out[k] || typeof out[k] !== 'object') out[k] = {}; });
  return out;
}
/**
 * Reads the saved state from localStorage; returns an empty state if nothing is saved or the JSON is damaged.
 */
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && typeof s === 'object') return normalize(s);
  } catch (e) { /* fall through */ }
  return defaults();
}
// S is the single source of truth for all user data (see the data model at the top of this file).
let S = load();
// Bookkeeping for Undo/Redo (see "history & undo"). Declared here, before migrate() runs, because save() uses them.
let lastJson = JSON.stringify(S);   // S as last saved: the "before" picture for the next change
let undoStack = [], redoStack = []; // [{ id, label, t, json }]  json = the whole state just before that change
let chg = '';                       // label of the user action in progress ('' = a background save, which is not recorded)
let tickOpen = false, restoring = false, saveFailed = false, hid = Date.now();
// v2: targets are stored in mg instead of cans.  v3: the old "cans" counters become ordinary, editable drinks.
// Works on any state object (the live S, an imported file, a cloud copy), so imports can be upgraded before they're merged.
function migrateState(S) {
  // Idempotent: already-current data (v3) returns immediately.
  if (S.v === 3) return S;
  const k = S.settings.canMg || 40;
  // Stage 1 (data older than v2): targets and history were stored as can counts, so convert them to mg.
  if (S.v !== 2) {
    const f = x => Math.round(x * k / 5) * 5;
    if (S.plan) S.plan.targets = S.plan.targets.map(f);
    (S.pastPlans || []).forEach(p => { p.targets = p.targets.map(f); });
    Object.keys(S.hist || {}).forEach(d => { if (S.hist[d] != null) S.hist[d] = f(S.hist[d]); });
  }
  // Stage 2 (to v3): the old built-in "cans" counters become ordinary drinks, and each day's old caf/decaf counts are
  // folded into logged drink entries at the can's mg, so every day's total stays exactly the same.
  const P = S.settings.presets;
  if (!P.some(p => p.id === 'can')) P.unshift({ id: 'can', name: 'Caffeinated can', type: 'Soda', container: 'Can', oz: 12, mg: k, fav: true });
  if (!P.some(p => p.id === 'decaf')) P.splice(Math.min(1, P.length), 0, { id: 'decaf', name: 'Caffeine-free can', type: 'Soda', container: 'Can', oz: 12, mg: 0, fav: true });
  Object.values(S.logs || {}).forEach(L => {
    L.drinks = L.drinks || {};
    if (L.caf > 0) { const e = L.drinks.can; L.drinks.can = { n: (e ? e.n : 0) + L.caf, mg: e ? e.mg : k, name: 'Caffeinated can', type: 'Soda', container: 'Can' }; }
    if (L.decaf > 0) { const e = L.drinks.decaf; L.drinks.decaf = { n: (e ? e.n : 0) + L.decaf, mg: 0, name: 'Caffeine-free can', type: 'Soda', container: 'Can' }; }
    L.caf = 0; L.decaf = 0;
  });
  S.v = 3;
  return S;
}
// Upgrades the live state in place and saves it.
function migrate() {
  if (S.v === 3) return;
  migrateState(S); save();
}
// Runs once at start-up on whatever was saved (no-op when already v3).
// CAUTION: it calls save(), so everything save() touches at this point must be a hoisted function declaration, not a
// const/let defined further down the file (that caused a start-up crash once).
migrate();
/**
 * Writes S to localStorage, records the change for Undo/Redo (track), then lets the cloud-backup scheduler know something changed.
 * The hooks are wrapped so a failure there can never stop the user's data from being saved. If the browser refuses the
 * write (storage full or blocked) `saveFailed` is set and a warning banner appears.
 */
function save() {
  const json = JSON.stringify(S);
  try { localStorage.setItem(KEY, json); saveFailed = false; } catch (e) { saveFailed = true; toast('Could not save on this device'); try { paintBanners(); } catch (e2) { /* page not ready yet */ } }
  try { track(json); } catch (e) { /* history must never break saving */ }
  try { cloudDirty(); } catch (e) { /* the cloud hook must never break saving */ }
}

/* ---------- dates ---------- */
// Date/time helpers. Dates are local-time 'YYYY-MM-DD' strings, so they compare and sort as plain text.
const pad = n => String(n).padStart(2, '0');
// Date -> 'YYYY-MM-DD' (local time).
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// 'YYYY-MM-DD' -> Date at local midnight (avoids the UTC shift of `new Date('YYYY-MM-DD')`).
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
// Today's date string. Called fresh each time so the app keeps working across midnight.
const today = () => fmt(new Date());
// Date string + n days (n may be negative). Uses setDate so daylight-saving changes are handled.
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
// Whole days from a to b (b - a). Rounded so a daylight-saving hour never produces a fractional day.
const diff = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
// 'Saturday, October 10' style label, in the user's locale.
const nice = s => parse(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
// '10/10' style label for chart axes and lists.
const short = s => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
// HTML-escapes text before it is placed into an HTML string. Use on every user-supplied value.
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Limits v to the range a..b.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- plan logic ---------- */
/**
 * Builds a linear taper schedule: n days stepping from `from` mg down to exactly 0 on the last day,
 * rounded to the nearest 5 mg. A one-day schedule is just [0].
 * @param {number} from starting mg per day
 * @param {number} n total days (including the zero day)
 * @returns {number[]} mg target for each day
 */
function gen(from, n) {
  return Array.from({ length: n }, (_, i) => (n === 1 ? 0 : Math.round(from * (1 - i / (n - 1)) / 5) * 5));
}
// Days logged since the baseline began. `inclToday` counts today's in-progress day (for display only).
function baselineDays(inclToday = true) {
  const b = S.baseline, t = today();
  return b ? Object.keys(S.logs).filter(d => d >= b.start && (inclToday ? d <= t : d < t)).sort() : [];
}
/**
 * When the 3-day "learn my habit" period has three FINISHED logged days, build the taper from their average mg
 * and start it today. Only finished days count, so an early-morning check-in can't complete it with a 0.
 * If the average is already near zero there is nothing to taper, so the baseline just ends.
 */
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
/**
 * Which day of the plan (0-based) `date` falls on, or null if before the plan starts.
 * While paused the index stays frozen at the day the pause began, so the schedule resumes where it left off.
 * Not clamped to the plan length: a value past the end means the taper is finished.
 */
function planIdx(date) {
  const p = S.plan; if (!p || date < p.start) return null;
  let i = diff(p.start, date);
  if (p.pausedAt) i = Math.min(i, diff(p.start, p.pausedAt));
  return i;
}
/**
 * The plan's target mg for `date` computed from the live schedule (null before the plan starts). After the last day it stays at the final value.
 */
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
/**
 * The target to show for `date`: the frozen value from `hist` for past days, otherwise the live schedule.
 */
function target(date) {
  if (date < today() && S.hist[date] != null) return S.hist[date];
  return targetRaw(date);
}

/* ---------- ui state ---------- */
// Transient screen state (NOT saved): current tab/date, which editor is open, a half-typed new-drink form, etc.
// followToday is true while the user is looking at today, so the view can roll forward after midnight.
// q = search text; prev = the tab to return to from Search/Help; importPrev = the "check first" import preview; openSet = which
// collapsible Settings cards are open; lockKind/lockAfter = choices in the app-lock setup form.
const ui = { editId: null, showCode: false, openRestart: false, followToday: true, draft: null, newOpen: false, moreOpen: false, view: 'today', date: today(), range: 14, symSel: new Set(['avg']),
  q: '', prev: 'today', helpOpen: null, scrollTo: null, importPrev: null, openSet: {}, lockKind: 'pin', lockAfter: 1 };

/* ---------- decoration ---------- */
/**
 * Generates the decorative climbing-vine illustration as an SVG string (vertical for the side borders, horizontal for the header).
 */
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
/**
 * Publishes the vine SVGs as CSS custom properties (--vine, --vine-h) that styles.css uses as repeating backgrounds.
 */
function applyDecor() {
  const url = svg => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  const r = document.documentElement.style;
  r.setProperty('--vine', url(vineSVG(false)));
  r.setProperty('--vine-h', url(vineSVG(true)));
}

/* ---------- helpers ---------- */
// Small pop-up message at the bottom of the screen (an aria-live region, so screen readers announce it).
let toastTimer, toastAct = null;
/**
 * Shows `msg` briefly, replacing any message already showing. With `act` ({ label, fn }) the pop-up also has a button
 * (used for Undo) and stays a little longer.
 */
function toast(msg, act) {
  const t = document.getElementById('toast'), b = document.getElementById('toastBtn');
  document.getElementById('toastMsg').textContent = msg;
  toastAct = act || null; b.hidden = !act; if (act) b.textContent = act.label;
  t.classList.add('show'); t.classList.toggle('act', !!act);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.classList.remove('show'); toastAct = null; }, act ? 7000 : 1800);
}
// Rounds to one decimal place and returns it as text (7 -> '7', 3.14 -> '3.1').
const n1 = v => String(Math.round(v * 10) / 10);
/**
 * Total mg from the drinks logged on day `d` (sum of count x mg for each entry).
 */
function drinkMg(d) { const dr = S.logs[d]?.drinks || {}; return Object.values(dr).reduce((a, x) => a + x.n * x.mg, 0); }
/**
 * A day's total caffeine in mg. The `caf` term only matters for very old data that hasn't been migrated; it is 0 afterwards.
 */
function totalMg(d) { const L = S.logs[d]; return L ? Math.round((L.caf || 0) * S.settings.canMg + drinkMg(d)) : 0; }
// '14:05' -> '2:05 pm'.
const fmtTime = t => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'am' : 'pm'}`; };
// Current time (or `at`) as 'HH:MM' in local time. A named function so tests can replace it.
function hhmm(at) { const n = at || new Date(); return `${pad(n.getHours())}:${pad(n.getMinutes())}`; }
/**
 * Records WHEN a caffeinated drink was added today. `adds` is a stack of { id, t }; the newest entry is the day's "last caffeine" time.
 * Only today is stamped (we never invent times for past days).
 * @param {string} d day  @param {string} id entry key in logs[d].drinks  @param {string} [at] 'HH:MM' override
 */
function stamp(d, id, at) {
  if (d !== today() || !S.logs[d]) return;
  const L = S.logs[d], t = at || hhmm();
  L.adds = [...(L.adds || []), { id, t }]; L.lastCaf = t; save();
}
// After a drink is counted down: forget its newest time, then show the newest time still on the log.
function unstamp(d, id, removedAll) {
  const L = S.logs[d]; if (!L) return;
  let adds = (L.adds || []).slice();
  const i = adds.map(a => a.id).lastIndexOf(id);
  if (i >= 0) adds.splice(i, 1);
  if (removedAll) adds = adds.filter(a => a.id !== id);
  L.adds = adds;
  if (adds.length) L.lastCaf = adds[adds.length - 1].t;
  else if (totalMg(d) === 0) L.lastCaf = null; // no caffeine left on the day
  save();
}
/**
 * Counts consecutive logged days, ending today (or yesterday if today isn't logged yet), for which ok(date) is true.
 * @param {Function} ok predicate on a date string
 * @param {boolean} [completeOnly] skip today entirely (today is still in progress)
 */
function streakOf(ok, completeOnly) {
  let n = 0;
  for (let d = today(); n < 800; d = addDays(d, -1)) {
    if (d === today() && (completeOnly || !S.logs[d])) continue;
    if (S.logs[d] && ok(d)) n++; else break;
  }
  return n;
}
// Current streak of days at or under the day's mg target (today counts only once it's logged).
const streakNow = () => streakOf(d => target(d) != null && totalMg(d) <= target(d));
// days with no caffeine, or whose last caffeine was before the cutoff time
const cutoffStreak = () => streakOf(d => totalMg(d) === 0 || (S.logs[d].lastCaf && S.logs[d].lastCaf <= S.settings.cutoff));
// Milestones: [id, label, message]. Each is awarded once, then shown for two days and listed under Progress.
const MILESTONES = [['s7', '7 days on target', 'A whole week on target — that’s real progress. 🌿'],
  ['s14', '14 days on target', 'Two weeks of steady care. Be proud of yourself. 🌱'],
  ['zero', 'First caffeine-free day', 'Your first caffeine-free day. 🌸']];
/**
 * Awards milestones (7 and 14 days on target, first caffeine-free day) and marks the plan complete on its last day.
 * Counts finished days only, so a half-logged today can't trigger anything early. Called on every render; each award happens once.
 */
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
/**
 * Longest-ever run of consecutive days at or under target (a slip never erases it).
 */
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
/**
 * Summary of the 7 days ending `end`, compared with the 7 before: average mg, days on target, symptom average,
 * water average and the lightest day. Used for the "This week" card.
 * @param {string} end last day of the window
 */
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
/**
 * Turns a weekStats() result into a short bulleted list (HTML string).
 */
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
/**
 * The "You reached zero" summary card: start amount, days taken, caffeine-free days and the symptom change since the start.
 */
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
// localStorage key for the on-device safety copies (separate from S so they never nest inside each other).
const BK = 'gentle-taper-backups';
/**
 * All safety copies, oldest first: [{ date, label, ts, json }]. Returns [] if none or unreadable.
 */
function readBackups() { try { return JSON.parse(localStorage.getItem(BK)) || []; } catch (e) { return []; } }
// The day the automatic copy was last taken, so the 30-second timer doesn't re-read storage needlessly.
let backedUpOn = '';
/**
 * Saves a safety copy of S in this browser. Automatic copies: at most one per day, newest 7 kept.
 * Labelled copies (taken before Erase / Import / Restore): newest 5 kept. Nothing is saved for an empty state.
 * @param {string} [label] omit for the daily automatic copy
 */
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

/**
 * Which entry of a day's log a drink belongs to. A day keeps one entry per drink AND per caffeine amount, so editing a drink's
 * mg later never re-prices drinks already logged that day. Keys are `id` (first amount) or `id~mg` (any other amount).
 * @param {object} L the day's log  @param {object} p the drink (needs id and mg)
 */
function entryKey(L, p) {
  const keys = Object.keys(L.drinks || {}), mine = k => k === p.id || k.startsWith(p.id + '~');
  const hit = keys.find(k => mine(k) && L.drinks[k].mg === p.mg);
  return hit || (keys.some(mine) ? `${p.id}~${p.mg}` : p.id);
}
/**
 * Adds (+1) or removes (-1) one of drink `p` on day `d`; counting down to 0 deletes the entry.
 * Count-downs also roll the "last caffeine" time back (see unstamp).
 * @returns {string|null} the entry key that changed, or null if there was nothing to remove
 */
function setDrink(d, p, delta) {
  const L = Object.assign({ caf: 0, decaf: 0 }, S.logs[d]); const dr = Object.assign({}, L.drinks);
  const key = entryKey(L, p);
  if (delta < 0 && !dr[key]) return null;
  const cur = dr[key] || { n: 0 };
  const n = clamp(cur.n + delta, 0, 99);
  if (n) dr[key] = { n, mg: cur.n === 0 ? p.mg : cur.mg, name: p.name, type: p.type || '', container: p.container || '' }; else delete dr[key];
  setLog(d, { drinks: dr });
  if (delta < 0) unstamp(d, key, !n);
  return key;
}
/**
 * Merges `patch` into day `d`'s log (creating it, which marks the day as logged) and saves.
 * The first change on today tells the reminder service the user has logged something, so it skips the reminder.
 */
function setLog(d, patch) { S.logs[d] = Object.assign({ caf: 0, decaf: 0 }, S.logs[d], patch); save(); if (d === today()) pushTouch(); }
/**
 * Merges `patch` into day `d`'s symptom check-in and saves.
 */
function setSym(d, patch) { S.sym[d] = Object.assign({}, S.sym[d], patch); save(); }

/* ---------- history & undo ---------- */
// Every user action that changes data is recorded two ways: the whole state just BEFORE it is kept in memory (that powers Undo and
// Redo), and a one-line label goes into a small journal on the device (the History list in Settings). The in-memory pictures last
// until the app is closed; anything older can still be rolled back from the daily safety copies.
// Labels for the click actions that change data. Actions not listed (moving between days, opening panels) are never recorded.
const ACT_LABELS = {
  'dr+': 'Logged a drink', 'dr-': 'Removed a drink', 'wat+': 'Added water', 'wat-': 'Removed water', hold: 'Held steady for 3 days',
  sliphold: 'Held one extra day', delday: 'Cleared a day’s drinks', sev: 'Rated a symptom', savecheck: 'Saved a check-in',
  start: 'Started a taper', startunknown: 'Started learning my habit', cancelbaseline: 'Skipped the 3-day baseline', pause: 'Paused the taper',
  resume: 'Resumed the taper', adjust: 'Adjusted the schedule', 'ed+': 'Raised a day’s target', 'ed-': 'Lowered a day’s target',
  addpreset: 'Added a drink', fav: 'Changed a favorite', savedrink: 'Added a drink and logged it', delpreset: 'Deleted a drink',
  mvup: 'Moved a drink', mvdown: 'Moved a drink', restoretrash: 'Restored a deleted item', theme: 'Changed the theme', textsize: 'Changed the text size',
  doimport: 'Imported a file',
};
// Labels for edits made in form fields (change events), keyed by element id, or 'pid' for a drink editor field.
const FIELD_LABELS = { pid: 'Edited a drink', lastCaf: 'Changed the last caffeine time', cutoff: 'Changed the caffeine cutoff', waterOn: 'Changed the water tally',
  waterName: 'Renamed the water tally', waterUnit: 'Changed the water unit', remTime: 'Changed the reminder time' };
/**
 * Marks the user action that is about to change data, so save() records it. Cleared again right after the current event.
 */
function setChg(label) { chg = label || ''; if (chg) setTimeout(() => { chg = ''; }, 0); }
// The journal of recent changes (labels and times only, never data), oldest first. [] if none or unreadable.
function journal() { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch (e) { return []; } }
/**
 * Called by save() with the new JSON. If the user caused the change, remembers the picture from just before it.
 * Several saves inside one click count as ONE change (the first "before" is kept), so one tap is one Undo step.
 */
function track(json) {
  if (json === lastJson) return;
  if (chg && !restoring && !tickOpen) {
    tickOpen = true; setTimeout(() => { tickOpen = false; }, 0);
    const e = { id: ++hid, label: chg, t: Date.now(), json: lastJson };
    undoStack.push(e); if (undoStack.length > 40) undoStack.shift();
    redoStack = [];
    try { localStorage.setItem(HIST_KEY, JSON.stringify([...journal(), { id: e.id, t: e.t, label: e.label }].slice(-100))); } catch (err) { /* the journal is optional */ }
  }
  lastJson = json;
}
/**
 * Puts the app back to a saved picture of the state (used by Undo, Redo and "undo back to here").
 * `restoring` stops this save from being recorded as a new change.
 */
function applySnapshot(json) {
  restoring = true;
  try { S = normalize(JSON.parse(json)); migrate(); save(); } finally { restoring = false; }
  applyTheme(); syncPushDaily();
}
/**
 * Undoes the newest recorded change (moving it to the Redo list). @returns {string|null} what was undone, or null if nothing to undo
 */
function undo() {
  const e = undoStack.pop(); if (!e) return null;
  redoStack.push({ id: e.id, label: e.label, t: e.t, json: JSON.stringify(S) });
  applySnapshot(e.json); return e.label;
}
/**
 * Redoes the change that was just undone. @returns {string|null} what was redone, or null if nothing to redo
 */
function redo() {
  const e = redoStack.pop(); if (!e) return null;
  undoStack.push({ id: e.id, label: e.label, t: e.t, json: JSON.stringify(S) });
  applySnapshot(e.json); return e.label;
}
// Undoes change `id` and everything done after it (History list: "Undo back to here"). Only changes from this session can be reached.
function undoTo(id) {
  const i = undoStack.findIndex(e => e.id === id); if (i < 0) return false;
  while (undoStack.length > i) undo();
  return true;
}
/**
 * Shows a pop-up with an Undo button for the change that was just made. Pressing it only works while that change is still the
 * newest one (otherwise it points to the History list, so it can never undo something else by surprise).
 */
function undoToast(msg) {
  const top = undoStack.length ? undoStack[undoStack.length - 1].id : 0;
  toast(msg, { label: 'Undo', fn: () => {
    if (top && undoStack.length && undoStack[undoStack.length - 1].id === top) { undo(); toast('Undone'); } else toast('You’ve changed things since — see History in Settings');
    render();
  } });
}

/* ---------- recently deleted ---------- */
// Deleted drinks, cleared days and removed drink entries wait here for 30 days so they can be restored.
const TRASH_DAYS = 30;
/**
 * Puts a deleted thing in Recently deleted.
 * @param {'drink'|'day'|'entry'} kind  @param {string} label what the list shows  @param {object} data what is needed to put it back  @param {string} [date] the day it belonged to
 */
function trashAdd(kind, label, data, date) {
  S.trash.unshift({ id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind, label, t: Date.now(), date, data: JSON.parse(JSON.stringify(data)) });
  S.trash = S.trash.slice(0, 60);
}
// Drops items older than 30 days (runs at start-up).
function purgeTrash() {
  const cut = Date.now() - TRASH_DAYS * 864e5, n = S.trash.length;
  S.trash = S.trash.filter(x => x && x.t >= cut);
  if (S.trash.length !== n) save();
}
/**
 * Adds a log's drinks into day `d`. Same drink at the same amount is added to; a different amount gets its own entry, so
 * nothing already logged is ever re-priced. Creates the day if it is missing.
 */
function mergeLogInto(d, log) {
  const cur = S.logs[d];
  if (!cur) { S.logs[d] = Object.assign({ caf: 0, decaf: 0 }, log); return; }
  const dr = Object.assign({}, cur.drinks);
  for (const [k, e] of Object.entries(log.drinks || {})) {
    const key = dr[k] && dr[k].mg !== e.mg ? `${k.split('~')[0]}~${e.mg}` : k;
    dr[key] = dr[key] ? Object.assign({}, dr[key], { n: clamp(dr[key].n + e.n, 0, 99) }) : Object.assign({}, e);
  }
  S.logs[d] = Object.assign({}, cur, { drinks: dr });
}
/**
 * Restores one item from Recently deleted. A drink goes back to its old place in the list; a day or an entry is added back to that day.
 * @returns {string|null} the item's label, or null if it wasn't found
 */
function trashRestore(id) {
  const it = S.trash.find(x => x.id === id); if (!it) return null;
  if (it.kind === 'drink') {
    const P = S.settings.presets, p = it.data.preset;
    if (P.some(x => x.id === p.id)) p.id = 'p' + Date.now().toString(36);
    P.splice(clamp(it.data.index, 0, P.length), 0, p);
  } else if (it.kind === 'day') mergeLogInto(it.date, it.data);
  else if (it.kind === 'entry') mergeLogInto(it.date, { drinks: { [it.data.key]: it.data.entry } });
  S.trash = S.trash.filter(x => x.id !== id); save();
  return it.label;
}
// A short, friendly age for a timestamp: "just now", "3 hours ago", "yesterday", "5 days ago".
function ago(t) {
  const m = Math.round((Date.now() - t) / 6e4);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24); return d === 1 ? 'yesterday' : `${d} days ago`;
}

/* ---------- views ---------- */
/**
 * Redraws the current tab. First runs the checks that depend on the date (baseline completion, frozen history,
 * milestones), then replaces #app's HTML and restores the scroll position. Everything visible is rebuilt from S each time.
 */
function render() {
  if (locked) return; // the lock screen is showing: draw nothing behind it
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
  if (ui.view === 'search') sub.textContent = 'Search everything';
  if (ui.view === 'help') sub.textContent = 'Help';
  const v = { today: () => welcomeCard() + vToday(), plan: () => welcomeCard() + vPlan(), progress: vProgress, settings: vSettings, search: vSearch, help: vHelp }[ui.view] || vToday;
  document.getElementById('app').innerHTML = v();
  syncChrome();
  window.scrollTo(0, y);
  if (ui.view === 'search' && !ui.q) { const q = document.getElementById('q'); if (q) q.focus(); }
}
// Keeps the Undo / Redo buttons in the header in step with what can be undone (and says what, for screen readers and hover).
function syncChrome() {
  const u = undoStack[undoStack.length - 1], r = redoStack[redoStack.length - 1];
  [['hUndo', u, 'Undo', 'Nothing to undo'], ['hRedo', r, 'Redo', 'Nothing to redo']].forEach(([id, e, verb, none]) => {
    const b = document.getElementById(id); if (!b) return;
    b.disabled = !e; b.title = e ? `${verb}: ${e.label}` : none; b.setAttribute('aria-label', b.title);
  });
}

/**
 * HTML for a [-] value [+] control. The buttons carry data-act="<act>-" / "<act>+" for the click handler.
 * @param {string} act action prefix  @param {number} val shown count  @param {string} [cls] extra class on +
 * @param {string} [extra] extra attributes (e.g. data-id)  @param {string} [label] spoken name for screen readers
 */
function stepper(act, val, cls, extra = '', label = '') {
  return `<div class="stepper">
    <button class="round" data-act="${act}-" ${extra} aria-label="${label ? 'One less ' + esc(label) : 'Less'}">−</button>
    <span class="n">${val}</span>
    <button class="round plus ${cls || ''}" data-act="${act}+" ${extra} aria-label="${label ? 'One more ' + esc(label) : 'More'}">+</button></div>`;
}

/**
 * The Today tab: target card, prompts, drinks, the day's log, symptom check-in and save button. Works for any past day via the date arrows.
 */
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

/**
 * The gentle prompt cards at the top of Today, in priority order: new milestone, symptoms-are-rough (hold/pause), taper complete,
 * went-over-today, caffeine-crept-back, weekly recap, and the weekly "export a backup" nudge. Only shown when viewing today.
 */
function alertCards() {
  const t = today(); let h = whatsNewCard();
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
  const exp = lastBackupDay(), snooze = S.settings.nudgeSnooze;
  if (ui.date === t && Object.keys(S.logs).length >= 3 && (!exp || diff(exp, t) >= 7) && !(snooze && snooze >= t))
    h += `<div class="card note"><b>Save a backup?</b><br>${exp ? `It’s been ${diff(exp, t)} days since your last backup.` : 'You haven’t saved a backup yet.'} Saving one to Files or Drive keeps your history safe.
      <div class="btns"><button class="btn" data-act="export">Export now</button><button class="btn ghost" data-act="nudgelater">Later</button></div></div>`;
  return h;
}
// A simple log of the day. Everything is read-only except how many of each drink (counting down to 0 removes it).
function loggedCard(d) {
  const L = S.logs[d], ent = Object.entries((L && L.drinks) || {});
  if (!ent.length) return `<div class="card"><h2>Logged this day</h2>${emptyState('Nothing logged for this day yet. Tap + on a drink above, or add a new one.', 'Add a new drink', 'newdrink')}</div>`;
  return `<div class="card"><h2>Logged this day</h2>
    <p class="muted" style="margin-top:-4px">Change how many you had. Counting down to 0 removes it.</p>
    ${ent.map(([id, e]) => `<div class="lrow"><div class="lname"><b>${esc(e.name)}</b><small>${e.n} × ${e.mg} mg = ${e.n * e.mg} mg</small></div>
      ${stepper('dr', e.n, '', `data-id="${esc(id)}"`, e.name)}</div>`).join('')}
    <div class="btns"><button class="btn danger" data-act="delday">Clear this day’s drinks</button></div></div>`;
}
// The water tally row (separate from drinks; name/unit/visibility come from settings).
const waterRow = d => S.settings.waterOn === false ? '' : `<div class="counter"><div class="name">${esc(S.settings.waterName || 'Water')}<small>${esc(S.settings.waterUnit || 'glasses')} — just a tally</small></div>${stepper('wat', S.water[d] || 0, 'sage', '', S.settings.waterName || 'water')}</div>`;
/**
 * "Last caffeine at" time editor with a note on whether it's before the user's cutoff. Hidden when the day has no caffeine.
 */
function lastCafRow(d) {
  if (totalMg(d) === 0) return '';
  const lc = S.logs[d]?.lastCaf || '', cut = S.settings.cutoff;
  const note = lc ? (lc <= cut ? `Before your ${fmtTime(cut)} cutoff 🌿` : `After your ${fmtTime(cut)} cutoff — an earlier last cup can help sleep.`) : 'Add a time to track your cutoff streak.';
  return `<div class="lastcaf"><div class="row"><label for="lastCaf" style="font-weight:600">Last caffeine at</label><input id="lastCaf" type="time" value="${esc(lc)}" style="width:auto"></div><p class="muted" style="margin:4px 0 0">${note}</p></div>`;
}

// Drinks are favorites unless explicitly set to false (older saved drinks have no `fav` field).
const isFav = p => p.fav !== false;
// One-line description of a drink: type · container · size · mg.
const drinkLine = p => [p.type, p.container, p.oz ? p.oz + ' oz' : '', p.mg + ' mg'].filter(Boolean).join(' · ');
// <datalist> suggestions for the free-text Type and Container boxes: built-in names plus any the user has already used.
const datalists = () => {
  const ty = [...new Set([...TYPES, ...S.settings.presets.map(p => p.type)].filter(Boolean))], co = [...new Set([...CONTAINERS, ...S.settings.presets.map(p => p.container)].filter(Boolean))];
  return `<datalist id="dl-types">${ty.map(x => `<option value="${esc(x)}">`).join('')}</datalist><datalist id="dl-conts">${co.map(x => `<option value="${esc(x)}">`).join('')}</datalist>`;
};
/**
 * Editing form for one drink (name, type, container, size, mg, favorite, reorder, delete). Used both inline on Today and in Settings.
 * Edits are saved by the delegated 'change' listener via the data-pid / data-f attributes.
 * @param {object} p the drink  @param {number} idx its position  @param {number} n total drinks
 */
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
/**
 * One row in the Drinks list: favorite star, name, edit button, and a single + that logs one. Counts are shown only in the day's log.
 */
function drinkRow(p, dr) {
  const all = S.settings.presets, editing = ui.editId === p.id;
  return `<div class="counter"><div class="name"><span class="nm1"><button class="star ${isFav(p) ? 'on' : ''}" data-act="fav" data-id="${esc(p.id)}" aria-pressed="${isFav(p)}" aria-label="Favorite: ${esc(p.name)}">★</button>${esc(p.name)}<button class="edit" data-act="editdrink" data-id="${esc(p.id)}" aria-pressed="${editing}" aria-label="Edit ${esc(p.name)}">✎</button></span><small>${esc(drinkLine(p))}</small></div><div class="stepper"><button class="round plus" data-act="dr+" data-id="${esc(p.id)}" data-quick="1" aria-label="Log one ${esc(p.name)}">+</button></div></div>${editing ? `<div class="editwrap">${drinkEditor(p, all.indexOf(p), all.length)}<div class="btns"><button class="btn" data-act="editdone">Done</button></div></div>` : ''}`;
}
/**
 * The Drinks card: favorites, "More drinks", the new-drink form, the water tally, last-caffeine time and the day's total versus target.
 */
function drinksCard(d, t) {
  const L = S.logs[d], dr = L?.drinks || {}, P = S.settings.presets, mg = totalMg(d);
  const favs = P.filter(isFav), others = P.filter(p => !isFav(p));
  const open = ui.moreOpen || others.some(p => p.id === ui.editId);
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
      <p class="muted" style="margin-top:-4px">Tap + to log a drink, ★ to pin a favorite, or ✎ to edit it. Your counts show below in “Logged this day”.</p>
      ${P.length === 0 ? emptyState('You don’t have any drinks yet.', 'Add one now', 'newdrink') : favs.length ? favs.map(p => drinkRow(p, dr)).join('') : '<p class="muted">No favorites yet — star a drink below or add a new one.</p>'}
      ${others.length ? `<details class="more" ${open ? 'open' : ''}><summary>More drinks (${others.length})</summary>${others.map(p => drinkRow(p, dr)).join('')}</details>` : ''}
      ${ui.newOpen ? form : '<div class="btns"><button class="btn ghost" data-act="newdrink">+ New drink</button></div>'}
      ${waterRow(d)}${lastCafRow(d)}${datalists()}
      <div class="totals"><b>${totalMg(d)} mg</b> caffeine today<br><span class="muted">${t != null ? `target ${t} mg` : 'no target yet'}${t != null && mg <= t ? ` · ${t - mg} mg to spare` : t != null ? ` · ${mg - t} mg over` : ''}</span></div>
    </div>`;
}

/**
 * The Plan tab. Three states: learning-your-habit (baseline), no plan yet (setup form), or an active plan (status, adjust, restart, per-day targets).
 */
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
/**
 * Shared form for starting or restarting a taper: daily mg and length, or "track 3 days first" to learn the habit.
 */
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
/**
 * Hand-drawn SVG line chart (no library). Each series is { color, vals[], dash?, dots?, w? }; null values leave gaps.
 * Gridline spacing is chosen so there are about five lines. `label` becomes the accessible description.
 * @returns {string} SVG markup
 */
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
/**
 * The list of dates for the Progress range chips (7 / 14 / 30 days, or from the first record to today).
 */
function rangeDates() {
  const t = today();
  const first = [S.plan?.start, ...Object.keys(S.logs), ...Object.keys(S.sym)].filter(Boolean).sort()[0] || t;
  const start = ui.range === 0 ? first : addDays(t, -(ui.range - 1));
  const out = [];
  for (let d = ui.range === 0 ? first : start; d <= t; d = addDays(d, 1)) out.push(d);
  return out.length ? out : [t];
}
// Arithmetic mean, or null for an empty list.
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
/**
 * A day's symptom rating: one symptom (k) or the average of all six ('avg'). null when no check-in was saved that day.
 */
function symVal(d, k) {
  const e = S.sym[d]; if (!e || !e.done) return null;
  if (k === 'avg') return avg(SYMS.map(([s]) => e[s] ?? 0));
  return e[k] ?? 0;
}

/**
 * The Progress tab: this week's summary, caffeine-vs-target chart, highlight stats, milestones and the symptom chart with a plain-language trend.
 */
function vProgress() {
  if (!S.plan && !Object.keys(S.logs).length) return `<div class="card"><h2>Progress</h2>${emptyState('Charts will bloom here once you’ve set up a taper and logged a few days.', 'Set up a taper', 'gotab', 'data-v="plan"')}</div>`;
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

// Is the collapsible Settings card `id` open? (Remembered across redraws by the 'toggle' listener below.)
const od = id => ui.openSet[id] ? 'open' : '';
// A date like "October 26, 2026".
const longDate = s => parse(s).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
// "Version & updates": the version number, when it was released, an Update now button when one is waiting, and the full What's new list.
function updatesCard() {
  const c = CHANGES[0];
  return `<div class="card" id="set-updates"><div class="row"><h2 style="margin:0">Version ${VERSION}</h2>${updateReady ? '<span class="pill">Update ready</span>' : ''}</div>
    <p class="muted">Last updated ${longDate(c.date)}.</p>
    <div class="btns">${updateReady ? '<button class="btn rose" data-act="updatenow">Update now</button>' : ''}<button class="btn ghost" data-act="checkupdate">Check for updates</button></div>
    <details class="fold" id="set-whatsnew" ${od('set-whatsnew')}><summary>What’s new</summary>
      ${CHANGES.map(x => `<h3>Version ${x.v} · ${longDate(x.date)}</h3><ul class="wk">${x.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`).join('')}</details></div>`;
}
// "Settings check": a short list of what is on or off (reminders, backups, lock, offline, storage...).
function checkCard() {
  const mark = { ok: '✓', warn: '!', off: '–' }, word = { ok: 'OK', warn: 'Needs attention', off: 'Off' };
  return `<div class="card" id="set-check"><h2>Settings check</h2>
    <ul class="check">${statusRows().map(([n, s, t]) => `<li class="${s}"><span class="dot" aria-hidden="true">${mark[s]}</span><span><b>${esc(n)}</b><span class="sr"> — ${word[s]}.</span><small>${esc(t)}</small></span></li>`).join('')}</ul></div>`;
}
// "App lock": set up, change or turn off the PIN/password, and choose when it locks again.
function lockCard() {
  const l = getLock(), pin = (l ? l.kind : ui.lockKind) === 'pin';
  const note = '<p class="muted" style="margin-top:-4px">Asks for a PIN or password when you open the app. It keeps the app private from anyone holding your unlocked phone; it doesn’t encrypt the data stored on it. If you forget it, the only way back in is to erase the app’s data on this phone and restore from an export or your recovery code.</p>';
  const afters = [[0, 'Every time'], [1, '1 minute'], [5, '5 minutes'], [15, '15 minutes']];
  const chips = (act, cur) => `<div class="chips">${afters.map(([v, t]) => `<button class="chip ${cur === v ? 'on' : ''}" data-act="${act}" data-v="${v}" aria-pressed="${cur === v}">${t}</button>`).join('')}</div>`;
  const inp = (id, label) => `<label class="f" for="${id}">${label}</label><input id="${id}" type="password" autocomplete="off" ${pin ? 'inputmode="numeric"' : ''}>`;
  if (!l) return `<div class="card" id="set-lock"><h2>App lock</h2>${note}
    <div class="chips">${[['pin', 'PIN'], ['password', 'Password']].map(([v, t]) => `<button class="chip ${ui.lockKind === v ? 'on' : ''}" data-act="lockkind" data-v="${v}" aria-pressed="${ui.lockKind === v}">${t}</button>`).join('')}</div>
    ${inp('lkNew', pin ? 'New PIN (4 to 8 digits)' : 'New password (at least 6 characters)')}${inp('lkNew2', 'Type it again')}
    <label class="f">Ask for it after being away</label>${chips('lockafterpick', ui.lockAfter)}
    <div class="btns"><button class="btn rose" data-act="lockon">Turn on app lock</button></div></div>`;
  return `<div class="card" id="set-lock"><div class="row"><h2 style="margin:0">App lock</h2><span class="pill sage">On</span></div>${note.replace('margin-top:-4px', 'margin-top:8px')}
    <label class="f">Ask for it after being away</label>${chips('lockafter', l.after)}
    <div class="btns"><button class="btn" data-act="locknow">Lock now</button></div>
    <h3>Change or turn off</h3>${inp('lkCur', 'Current ' + (pin ? 'PIN' : 'password'))}${inp('lkNew', 'New ' + (pin ? 'PIN' : 'password') + ' (to change it)')}${inp('lkNew2', 'Type the new one again')}
    <div class="btns"><button class="btn ghost" data-act="lockchange">Change it</button><button class="btn danger" data-act="lockoff">Turn off lock</button></div></div>`;
}
// "History": the journal of recent changes with Undo/Redo and "Undo back to here" for changes made since the app was opened.
function historyCard() {
  const j = journal().slice().reverse().slice(0, 30), live = new Set(undoStack.map(e => e.id));
  return `<details class="card" id="set-history" ${od('set-history')}><summary>History</summary>
    <p class="muted">Your recent changes, newest first. “Undo back to here” returns to just before that change (changes made since you opened the app).</p>
    <div class="btns"><button class="btn ghost" data-act="undo" ${undoStack.length ? '' : 'disabled'}>↶ Undo</button><button class="btn ghost" data-act="redo" ${redoStack.length ? '' : 'disabled'}>↷ Redo</button></div>
    ${j.length ? j.map(x => `<div class="lrow"><div class="lname"><b>${esc(x.label)}</b><small>${ago(x.t)}</small></div>${live.has(x.id) ? `<button class="btn ghost sm" data-act="undoto" data-id="${x.id}">Undo back to here</button>` : ''}</div>`).join('')
      : emptyState('No changes yet. What you change will be listed here.')}</details>`;
}
// "Recently deleted": deleted drinks, cleared days and removed drinks, each with a Restore button.
function trashCard() {
  const kind = { drink: 'Drink', day: 'Day’s drinks', entry: 'Logged drink' };
  return `<details class="card" id="set-trash" ${od('set-trash')}><summary>Recently deleted${S.trash.length ? ` (${S.trash.length})` : ''}</summary>
    <p class="muted">Deleted drinks, cleared days and removed drinks stay here for 30 days.</p>
    ${S.trash.length ? S.trash.map(x => `<div class="lrow"><div class="lname"><b>${esc(x.label)}</b><small>${esc(kind[x.kind] || 'Item')} · deleted ${ago(x.t)}</small></div><button class="btn ghost sm" data-act="restoretrash" data-id="${esc(x.id)}">Restore</button></div>`).join('')
      + '<div class="btns"><button class="btn danger" data-act="emptytrash">Empty recently deleted</button></div>' : emptyState('Nothing has been deleted lately.')}</details>`;
}

/**
 * The Settings tab: appearance, reminders, drinks, water/cutoff, backups, cloud backup, erase and an About note.
 */
function vSettings() {
  const st = S.settings;
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  return `
    ${updatesCard()}
    ${checkCard()}
    <div class="card" id="set-appearance"><h2>Appearance</h2>
      <div class="chips">${[['auto', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button class="chip ${(st.theme || 'auto') === v ? 'on' : ''}" data-act="theme" data-v="${v}" aria-pressed="${(st.theme || 'auto') === v}">${l}</button>`).join('')}</div>
      <h3>Text size</h3>
      <div class="chips" style="margin-bottom:0">${[['normal', 'Normal'], ['large', 'Large'], ['xl', 'Extra large']].map(([v, l]) => `<button class="chip ${(st.textSize || 'normal') === v ? 'on' : ''}" data-act="textsize" data-v="${v}" aria-pressed="${(st.textSize || 'normal') === v}">${l}</button>`).join('')}</div>
    </div>
    <div class="card" id="set-reminder"><h2>Daily reminder</h2>
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
    <div class="card" id="set-drinks"><h2>My drinks</h2>
      <p class="muted" style="margin-top:-4px">Rename, resize, reorder or delete any drink, or add your own. Type and container can be anything you like.</p>
      ${st.presets.length ? st.presets.map((p, i) => drinkEditor(p, i, st.presets.length)).join('') : emptyState('You don’t have any drinks yet.', 'Add one now', 'addpreset')}
      <div class="btns"><button class="btn ghost" data-act="addpreset">+ Add a drink</button></div>
      ${datalists()}
    </div>
    <div class="card" id="set-water"><h2>Water &amp; caffeine cutoff</h2>
      <div class="switch"><label for="waterOn">Show a water tally</label><input id="waterOn" type="checkbox" ${st.waterOn !== false ? 'checked' : ''}></div>
      <div class="two"><div><label class="f" for="waterName">Name</label><input id="waterName" type="text" maxlength="20" value="${esc(st.waterName || 'Water')}"></div>
        <div><label class="f" for="waterUnit">Unit</label><input id="waterUnit" type="text" maxlength="20" value="${esc(st.waterUnit || 'glasses')}"></div></div>
      <label class="f" for="cutoff">Caffeine cutoff time</label>
      <input id="cutoff" type="time" value="${st.cutoff}">
      <p class="muted" style="margin:4px 0 0">Used for the “last caffeine before…” streak. Many people sleep better with none after early afternoon.</p>
    </div>
    ${importCard()}
    <div class="card" id="set-data"><h2>Your data</h2>
      <p class="muted" style="margin-top:-4px">Export saves everything in one file you can keep in Files or Drive, or use on another phone. Import reads such a file, shows you what it would add before saving anything, and merges it in without overwriting what you have.</p>
      ${(() => { const lb = lastBackupDay(), n = lb ? diff(lb, today()) : 0; return `<p class="muted">Last backup: <b>${lb ? `${nice(lb)}${n ? ` (${plural(n, 'day')} ago)` : ' (today)'}` : 'never'}</b>${hasData() && (!lb || n > 14) ? ' — it’s been a while; exporting a copy now is a good idea.' : ''}</p>`; })()}
      <div class="btns"><button class="btn" data-act="export">Export data</button><button class="btn ghost" data-act="import">Import from a file…</button></div>
      <input id="importFile" type="file" accept="application/json,.json" hidden>
      <p class="muted">A safety copy is also saved on this phone automatically each day (last 7), plus one before anything risky like erasing or importing. They guard against mistakes in the app — but they live in the browser, so clearing site data removes them.</p>
      ${(() => { const b = readBackups().slice().reverse(); return b.length ? `<h3>Safety copies on this phone</h3>${b.map(x => `<div class="lrow"><div class="lname"><b>${x.label ? esc(x.label) : 'Automatic'}</b><small>${nice(x.date)}</small></div><button class="btn ghost" style="min-height:40px;padding:8px 14px" data-act="restore" data-ts="${x.ts}">Restore</button></div>`).join('')}<div class="btns"><button class="btn ghost" data-act="delbackups">Delete safety copies</button></div>` : ''; })()}
    </div>
    ${cloudCard()}
    ${lockCard()}
    ${historyCard()}
    ${trashCard()}
    <div class="card"><h2>Help</h2>
      <p class="muted" style="margin-top:-4px">Short answers about logging, tapering, backups and more. You can also search everything with the magnifier at the top.</p>
      <div class="btns"><button class="btn ghost" data-act="gohelp">Open Help</button><button class="btn ghost" data-act="gosearch">Search</button></div></div>
    <div class="card" id="set-erase"><h2>Erase</h2>
      <p class="muted" style="margin-top:-4px">Removes all plans, logs and symptoms. A safety copy is kept, and Undo works right after.</p>
      <div class="btns"><button class="btn danger" data-act="wipe">Erase everything</button></div>
    </div>
    <div class="card"><h2>About</h2>
      <p class="muted" style="margin-top:-4px">Gentle Taper version ${VERSION}. It is a personal tracking tool, not medical advice. Suggestions like “hold steady” are general nudges based on what you log. Stopping caffeine can cause headaches, fatigue and low mood; if symptoms are severe, don’t ease, or you have a heart condition or take medication, please talk with a doctor or pharmacist.</p>
    </div>`;
}

/* ---------- help & search ---------- */
// The Help page. Each topic is { id, title, body } (body is trusted HTML written here). Search looks through these too.
const HELP = [
  { id: 'start', title: 'Getting started', body: '<p>Open the <b>Plan</b> tab and enter how much caffeine you have in a day now (a cup of coffee is about 95 mg, a can of soda about 40 mg) and how many days you want the taper to last. Not sure? Tap “I’m not sure” and just log what you normally drink for 3 days; the app builds the plan from your average.</p><p>Then use the <b>Today</b> tab: tap <b>+</b> on a drink each time you have one, and fill in “How am I feeling?” at the end of the day.</p>' },
  { id: 'logging', title: 'Logging drinks', body: '<p>The + buttons in <b>Drinks</b> only add. Your counts live in <b>Logged this day</b>, where you can change how many you had; counting down to 0 removes it. Tap ★ to pin a favorite and ✎ to change a drink’s name, size or caffeine. Changing a drink never changes days you already logged.</p><p>Use the arrows at the top of Today to look at or fix an earlier day.</p>' },
  { id: 'plan', title: 'Pausing, holding and adjusting', body: '<p>A taper doesn’t have to be perfect. You can <b>pause</b> it, <b>hold</b> a level for a few days, change any upcoming day with − and +, or re-spread the remaining days under “Adjust from today”. Past days keep the target they had.</p><p>If you have a bumpy day, the app offers to hold the same level for one extra day. That’s normal and doesn’t undo your progress.</p>' },
  { id: 'checkin', title: 'Symptoms and check-ins', body: '<p>Rate six common symptoms from 0 (none) to 3 (strong) and add a note if you like. The <b>Progress</b> tab charts them next to your caffeine so you can see how things are trending. If symptoms stay rough, the app suggests easing off.</p>' },
  { id: 'reminders', title: 'Reminders', body: '<p>Turn on “Remind me to log” in Settings. On a phone, add the app to your home screen first so reminders can arrive even when it’s closed. A reminder is skipped on days you’ve already logged something. A small reminder service only learns your reminder time, your time zone and whether you’ve logged today — never your drinks or symptoms.</p>' },
  { id: 'data', title: 'Backups, export and import', body: '<p><b>Export</b> saves one file with all your data (use it to move to another phone, or keep a copy in Files or Drive). <b>Import</b> reads such a file, shows you what it would add <i>before</i> anything is saved, and then merges it in. It never overwrites: days, check-ins and drinks you already have are kept and skipped, and the app tells you what it skipped.</p><p>The app also keeps daily <b>safety copies</b> on this phone, and can keep an encrypted <b>cloud backup</b> that only your recovery code can open. Keep that code somewhere safe: without it, nobody (including me) can restore the cloud copy.</p>' },
  { id: 'undo', title: 'Undo, History and Recently deleted', body: '<p>The ↶ and ↷ buttons at the top undo and redo your changes. After you delete something, a pop-up with an <b>Undo</b> button appears for a few seconds. <b>History</b> (in Settings) lists recent changes, and <b>Recently deleted</b> keeps deleted drinks, cleared days and removed drinks for 30 days so you can restore them.</p><p>Undo steps last until you close the app. Older mistakes can be fixed from the daily safety copies.</p>' },
  { id: 'lock', title: 'App lock', body: '<p>You can protect the app with a PIN or password (Settings → App lock). It hides the app from anyone who picks up your phone while it’s unlocked. It doesn’t encrypt the data stored in the browser — your phone’s own passcode does that — so keep that on too.</p><p>If you forget it, the only way back in is to erase the app on this phone and restore from an export or your cloud recovery code.</p>' },
  { id: 'updates', title: 'Updates and working offline', body: '<p>The app works without internet and says so when you’re offline. When a new version is ready, a banner appears with an <b>Update now</b> button; Settings shows the version, the date and what’s new. You can also tap “Check for updates” there.</p>' },
  { id: 'privacy', title: 'Privacy', body: '<p>Everything stays on your phone unless you turn on the cloud backup, which is encrypted before it leaves your phone. There are no accounts and no tracking.</p>' },
  { id: 'medical', title: 'Not medical advice', body: '<p>Gentle Taper is a tracking tool. Stopping caffeine can cause headaches, fatigue and low mood. If symptoms are severe, don’t ease, or you have a heart condition or take medication, please talk with a doctor or pharmacist.</p>' },
];
// Settings cards that search can jump to: [element id, title, extra words people might type].
const SETTINGS_INDEX = [
  ['set-updates', 'Version & updates', 'version update new version what’s new changes release'],
  ['set-check', 'Settings check', 'status check on off sync offline storage'],
  ['set-appearance', 'Appearance & text size', 'dark mode light theme text size larger font bigger'],
  ['set-reminder', 'Daily reminder', 'reminder notification push alarm'],
  ['set-drinks', 'My drinks', 'drinks list favorites edit add delete'],
  ['set-water', 'Water & caffeine cutoff', 'water tally cutoff last caffeine'],
  ['set-data', 'Your data: export & import', 'export import backup file restore safety copies merge'],
  ['set-cloud', 'Cloud backup', 'cloud recovery code sync encrypted'],
  ['set-lock', 'App lock', 'lock pin password passcode privacy'],
  ['set-history', 'History', 'history undo redo changes'],
  ['set-trash', 'Recently deleted', 'deleted trash restore bin'],
  ['set-erase', 'Erase everything', 'erase wipe reset delete all'],
];
// A short piece of `text` around the first match of `q`, for search results.
function snippet(text, q) {
  const t = String(text || ''), i = t.toLowerCase().indexOf(q);
  if (i < 0) return t.slice(0, 80);
  const a = Math.max(0, i - 25);
  return (a ? '…' : '') + t.slice(a, i + q.length + 45) + (i + q.length + 45 < t.length ? '…' : '');
}
/**
 * Searches everything in the app: logged drinks, notes, symptoms, days, the drink list, milestones, recently deleted items,
 * history, Help topics and Settings sections. @param {string} q what the user typed (2+ letters)
 * @returns {{k:string,title:string,sub:string,go:string}[]} up to 60 results; `go` says where tapping leads (see go())
 */
function searchAll(q) {
  q = String(q || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const out = [], has = s => String(s ?? '').toLowerCase().includes(q), strip = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const days = Object.keys(S.logs).sort().reverse(), symDays = Object.keys(S.sym).sort().reverse();
  days.forEach(d => Object.values(S.logs[d].drinks || {}).forEach(e => {
    if (has(e.name) || has(e.type) || has(e.container)) out.push({ k: 'Logged', title: `${e.n} × ${e.name}`, sub: `${nice(d)} · ${e.n * e.mg} mg`, go: 'day:' + d });
  }));
  symDays.forEach(d => { if (has(S.sym[d].notes)) out.push({ k: 'Note', title: snippet(S.sym[d].notes, q), sub: nice(d), go: 'day:' + d }); });
  SYMS.filter(([k, n]) => has(n) || has(k)).forEach(([k, n]) => symDays.filter(d => (S.sym[d][k] ?? 0) > 0).slice(0, 5)
    .forEach(d => out.push({ k: 'Symptom', title: `${n}: ${SEV[S.sym[d][k]]}`, sub: nice(d), go: 'day:' + d })));
  [...new Set([...days, ...symDays])].filter(d => d.includes(q) || has(nice(d))).slice(0, 8)
    .forEach(d => out.push({ k: 'Day', title: nice(d), sub: S.logs[d] ? `${totalMg(d)} mg logged` : 'check-in only', go: 'day:' + d }));
  S.settings.presets.filter(p => has(p.name) || has(p.type) || has(p.container)).forEach(p => out.push({ k: 'Drink', title: p.name, sub: drinkLine(p), go: 'set:set-drinks' }));
  MILESTONES.filter(m => S.ms[m[0]] && (has(m[1]) || has(m[2]))).forEach(m => out.push({ k: 'Milestone', title: m[1], sub: nice(S.ms[m[0]]), go: 'tab:progress' }));
  if (S.plan && (has('taper') || has('plan'))) out.push({ k: 'Plan', title: 'Your taper plan', sub: `${S.plan.targets[0]} mg → 0 over ${S.plan.targets.length} days`, go: 'tab:plan' });
  S.trash.filter(x => has(x.label)).forEach(x => out.push({ k: 'Deleted', title: x.label, sub: `deleted ${ago(x.t)}`, go: 'set:set-trash' }));
  journal().slice().reverse().filter(x => has(x.label)).slice(0, 5).forEach(x => out.push({ k: 'History', title: x.label, sub: ago(x.t), go: 'set:set-history' }));
  HELP.filter(h => has(h.title) || has(strip(h.body))).forEach(h => out.push({ k: 'Help', title: h.title, sub: snippet(strip(h.body), q), go: 'help:' + h.id }));
  SETTINGS_INDEX.filter(([, t, w]) => has(t) || has(w)).forEach(([id, t]) => out.push({ k: 'Settings', title: t, sub: 'Open in Settings', go: 'set:' + id }));
  return out.slice(0, 60);
}
// The result rows for the search box (also used to refresh them while typing).
function resultsHtml(q) {
  if (String(q || '').trim().length < 2) return '<p class="muted">Type at least two letters. Search covers your drinks, notes, symptoms, days, Help and Settings.</p>';
  const r = searchAll(q);
  if (!r.length) return `<p class="muted">Nothing found for “${esc(q.trim())}”. Try a drink name, a symptom, a date like “oct 12”, or a word from Help.</p>`;
  return r.map(x => `<button class="sres" data-act="go" data-go="${esc(x.go)}"><span class="sk">${esc(x.k)}</span><span class="st"><b>${esc(x.title)}</b><small>${esc(x.sub)}</small></span></button>`).join('');
}
/**
 * Takes the user where a search result (or other link) points: 'day:YYYY-MM-DD', 'tab:<name>', 'set:<card id>' or 'help:<topic id>'.
 */
function go(spec) {
  const [kind, arg] = String(spec).split(/:(.*)/s);
  if (kind === 'day') { ui.view = 'today'; ui.date = arg; ui.followToday = arg === today(); }
  else if (kind === 'tab') ui.view = arg;
  else if (kind === 'help') { ui.view = 'help'; ui.helpOpen = arg; }
  else if (kind === 'set') { ui.view = 'settings'; ui.scrollTo = arg; }
  render();
  if (ui.scrollTo) {
    const el = document.getElementById(ui.scrollTo); ui.scrollTo = null;
    if (el) { if (el.tagName === 'DETAILS') el.open = true; el.scrollIntoView({ block: 'start' }); }
  } else window.scrollTo(0, 0);
}
// The Search screen: a box, and the results which are refreshed as you type (without redrawing the box, so typing isn't interrupted).
function vSearch() {
  return `<div class="card"><h2>Search</h2>
    <label class="f" for="q">Search everything</label>
    <input id="q" type="search" autocomplete="off" placeholder="A drink, a symptom, a date, a setting…" value="${esc(ui.q || '')}">
    <div id="results" class="results" aria-live="polite">${resultsHtml(ui.q)}</div>
    <div class="btns"><button class="btn ghost" data-act="closeview">Close</button></div></div>`;
}
// The Help screen: one expandable card per topic. A topic opened from search starts open.
function vHelp() {
  return `<div class="card"><h2>Help</h2><p class="muted" style="margin-top:-4px">Short answers about how the app works. You can also use Search at the top.</p>
    <div class="btns"><button class="btn ghost" data-act="closeview">Close</button></div></div>
    ${HELP.map(h => `<details class="card help" id="help-${h.id}" ${ui.helpOpen === h.id ? 'open' : ''}><summary>${esc(h.title)}</summary>${h.body}</details>`).join('')}`;
}
// A friendly "nothing here yet" block with a button that does the obvious next thing.
const emptyState = (text, label, act, extra = '') => `<div class="empty"><p class="muted">${text}</p>${label ? `<button class="btn rose" data-act="${act}" ${extra}>${label}</button>` : ''}</div>`;
// The first-time welcome card, shown on Today and Plan until dismissed (and never to someone who already has data).
function welcomeCard() {
  if (S.settings.welcomed || hasData()) return '';
  return `<div class="card note"><h2>Welcome 🌿</h2>
    <p>Gentle Taper helps you ease off caffeine at your own pace. Everything stays on your phone.</p>
    <ol class="steps"><li>In <b>Plan</b>, say how much caffeine you have now and how long you’d like the taper to take.</li>
      <li>In <b>Today</b>, tap <b>+</b> whenever you have a drink.</li><li>End the day with a quick check-in on how you feel.</li></ol>
    <div class="btns"><button class="btn rose" data-act="welcomeok">Got it</button><button class="btn ghost" data-act="gohelp">Read the help</button></div></div>`;
}
// After an update: what changed in the newest version, shown once on Today.
function whatsNewCard() {
  if (!hasData() || (S.settings.seenVer || 0) >= VERSION) return '';
  const c = CHANGES[0];
  return `<div class="card note"><h2>What’s new in version ${c.v}</h2><ul class="wk">${c.notes.slice(0, 3).map(n => `<li>${esc(n)}</li>`).join('')}</ul>
    ${c.notes.length > 3 ? '<p class="muted" style="margin:6px 0 0">The full list is under Settings → What’s new.</p>' : ''}
    <div class="btns"><button class="btn rose" data-act="whatsnewok">Got it</button></div></div>`;
}

/* ---------- events ---------- */
// Every click in the app comes through this one delegated listener. Buttons declare what they do with data-act="..."
// (plus data-id / data-v / data-k when they need an argument). Most branches change S, then fall through to render() at the end;
// branches that start async work or just show a dialog `return` early instead.
document.addEventListener('click', e => {
  // Bottom tab bar.
  const tab = e.target.closest('#tabs button');
  if (tab) { ui.openRestart = false; ui.view = tab.dataset.view; render(); window.scrollTo(0, 0); return; }
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, d = ui.date, p = S.plan;
  setChg(ACT_LABELS[act]); // marks this tap as a change worth recording for Undo/History (see "history & undo")
  // Keep a half-typed new-drink form alive across re-renders by copying its fields into ui.draft before anything redraws.
  const nm = document.getElementById('nd-name');
  if (nm) ui.draft = { name: nm.value, type: document.getElementById('nd-type').value, cont: document.getElementById('nd-cont').value,
    oz: document.getElementById('nd-oz').value, mg: document.getElementById('nd-mg').value, fav: document.getElementById('nd-fav').checked };
  const L = () => S.logs[d] || { caf: 0, decaf: 0 };
  switch (act) {
    // --- navigation between days ---
    case 'prev': ui.date = addDays(d, -1); ui.followToday = false; break;
    case 'next': if (d < today()) { ui.date = addDays(d, 1); ui.followToday = ui.date === today(); } break;
    // --- logging drinks. From the Drinks list (data-quick) "+" logs at the drink's CURRENT amount; the +/- in "Logged this day"
    // adjust that exact entry at ITS amount. Only caffeinated adds (mg > 0) are timestamped for the "last caffeine" time. ---
    case 'dr+': case 'dr-': {
      const id = el.dataset.id, ent = S.logs[d]?.drinks?.[id], quick = !!el.dataset.quick, ent0 = ent && { ...ent };
      // From the log, adjust that exact entry (its own caffeine amount); from the drinks list, log at the drink's current amount.
      const pr = (!quick && ent) ? { ...ent, id } : (S.settings.presets.find(x => x.id === id) || (ent ? { ...ent, id } : null));
      if (pr && act === 'dr+') setChg(`Logged ${pr.name}`);
      if (pr) { const key = setDrink(d, pr, act === 'dr+' ? 1 : -1); if (act === 'dr+' && key && pr.mg > 0) stamp(d, key); if (quick) toast(`Logged ${pr.name}`); }
      // Counting a drink down to 0 deletes its entry: keep it in Recently deleted and offer Undo.
      if (act === 'dr-' && ent0 && ent0.n === 1) { setChg(`Removed ${ent0.name}`); trashAdd('entry', `${ent0.name} on ${short(d)}`, { key: id, entry: ent0 }, d); save(); undoToast(`Removed ${ent0.name}`); }
      break;
    }
    // --- water tally ---
    case 'wat+': S.water[d] = Math.min((S.water[d] || 0) + 1, 30); save(); break;
    case 'wat-': if (S.water[d] > 0) { S.water[d]--; save(); } break;
    // --- gentle prompts: hold the taper level, ease off, dismiss ---
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
    // --- clearing a day, safety copies, symptoms ---
    case 'delday':
      if (confirm('Remove all drinks logged for this day? Your symptoms and water tally for the day stay.')) {
        if (S.logs[d]) trashAdd('day', `Drinks on ${nice(d)}`, S.logs[d], d);
        delete S.logs[d]; save(); undoToast('Cleared this day’s drinks');
      } else return;
      break;
    case 'restore': {
      const e = readBackups().find(x => x.ts === +el.dataset.ts);
      if (e && confirm('Replace everything in the app with this safety copy? Your current data is saved as a safety copy first.')) {
        let restored; try { restored = normalize(JSON.parse(e.json)); } catch (err) { toast('That safety copy is damaged'); return; }
        pushBackup('Before restore'); setChg('Restored a safety copy'); S = restored; migrate(); save(); applyTheme(); ui.date = today(); ui.followToday = true; syncPushDaily(); undoToast('Restored the safety copy');
      } else return;
      break;
    }
    case 'delbackups': if (confirm('Delete all safety copies from this phone?')) { try { localStorage.removeItem(BK); } catch (err) { /* ignore */ } } else return; break;
    // A symptom severity tap (marks the check-in as done).
    case 'sev': setSym(d, { [el.dataset.k]: +el.dataset.v, done: true }); break;
    // Save the day's check-in: also creates the day's log (so a caffeine-free day can be recorded) and tells the reminder service.
    case 'savecheck': {
      setLog(d, {});
      const ta = document.getElementById('notes');
      setSym(d, { done: true, notes: ta ? ta.value : (S.sym[d]?.notes || '') });
      toast('Saved. Be gentle with yourself 🌿'); if (d === today()) pushDone();
      break;
    }
    // --- Progress controls ---
    case 'range': ui.range = +el.dataset.v; break;
    case 'symsel': {
      const k = el.dataset.k;
      if (ui.symSel.has(k)) { if (ui.symSel.size > 1) ui.symSel.delete(k); } else ui.symSel.add(k);
      break;
    }
    // --- starting, pausing, resuming and reshaping the taper ---
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
    // "Not sure": begin the 3-day baseline instead of entering an amount.
    case 'startunknown': {
      const days = clamp(parseInt(document.getElementById('stDays').value, 10) || 28, 2, 365);
      if (S.plan) { snapshot(); S.pastPlans.push(S.plan); S.plan = null; }
      S.baseline = { start: today(), taperDays: days }; save(); ui.view = 'today'; ui.date = today(); ui.followToday = true;
      toast('Great — log what you normally drink for 3 days 🌿'); break;
    }
    case 'cancelbaseline': S.baseline = null; save(); break;
    // Pause freezes the schedule; resume shifts the start date forward by the paused days so nothing is skipped.
    case 'pause': snapshot(); p.pausedAt = today(); save(); toast('Taper paused'); break;
    case 'resume': {
      snapshot();
      p.start = addDays(p.start, diff(p.pausedAt, today())); p.pausedAt = null;
      snapshot(); save(); toast('Welcome back'); break;
    }
    // Re-spread the remaining days from today. Past days are untouched (frozen in `hist`).
    case 'adjust': {
      snapshot();
      const from = clamp(parseInt(document.getElementById('adjFrom').value, 10) || 0, 0, 2000);
      const n = clamp(parseInt(document.getElementById('adjDays').value, 10) || 1, 1, 365);
      const i = planIdx(today()) ?? 0;
      const head = p.targets.slice(0, i); while (head.length < i) head.push(p.targets[p.targets.length - 1] ?? 0);
      p.targets = head.concat(gen(from, n + 1));
      snapshot(); save(); toast('Schedule adjusted'); break;
    }
    // Nudge one upcoming day's target by 10 mg.
    case 'ed+': case 'ed-': {
      const i = +el.dataset.i;
      p.targets[i] = clamp(p.targets[i] + (act === 'ed+' ? 10 : -10), 0, 2000);
      save(); break;
    }
    // --- managing the drink list ---
    case 'addpreset': S.settings.presets.push({ id: 'p' + Date.now().toString(36), name: 'New drink', type: 'Other', container: 'Can', oz: null, mg: 50, fav: false }); save(); break;
    case 'fav': { const pr = S.settings.presets.find(x => x.id === el.dataset.id); if (pr) { pr.fav = !isFav(pr); save(); } break; }
    case 'newdrink': ui.newOpen = !ui.newOpen; ui.draft = null; break;
    case 'savedrink': {
      const name = document.getElementById('nd-name').value.trim();
      if (!name) { toast('Give it a name first'); return; }
      const oz = parseFloat(document.getElementById('nd-oz').value);
      const pr = { id: 'p' + Date.now().toString(36), name, type: document.getElementById('nd-type').value, container: document.getElementById('nd-cont').value,
        oz: oz > 0 ? oz : null, mg: clamp(parseInt(document.getElementById('nd-mg').value, 10) || 0, 0, 1000), fav: document.getElementById('nd-fav').checked };
      S.settings.presets.push(pr); const key = setDrink(d, pr, 1); if (pr.mg > 0) stamp(d, key); ui.newOpen = false; ui.draft = null; toast(`Logged ${name}`); break;
    }
    case 'theme': S.settings.theme = el.dataset.v; save(); applyTheme(); break;
    case 'delpreset': {
      const pr = S.settings.presets.find(x => x.id === el.dataset.id);
      if (pr && confirm(`Delete “${pr.name}” from your drinks? Days where you logged it keep it.`)) {
        trashAdd('drink', pr.name, { preset: pr, index: S.settings.presets.indexOf(pr) });
        S.settings.presets = S.settings.presets.filter(x => x.id !== pr.id); if (ui.editId === pr.id) ui.editId = null; save(); undoToast(`Deleted ${pr.name}`);
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
    // --- encrypted cloud backup, reminders and data export (async: they return early and re-render themselves) ---
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
    // Erase everything: a labelled safety copy is taken first so it can be undone.
    case 'wipe':
      if (confirm('Erase all plans, logs and symptoms from this device? A safety copy is kept under Your data, and Undo works right after.')) {
        pushBackup('Before erase'); setChg('Erased everything'); S = defaults(); S.settings.welcomed = true; S.settings.seenVer = VERSION; save(); applyTheme(); ui.view = 'plan'; ui.date = today(); ui.followToday = true; syncPushDaily(); undoToast('Everything erased');
      } else return;
      break;
    // --- undo / redo, history, recently deleted ---
    case 'undo': { const l = undo(); toast(l ? `Undid: ${l}` : 'Nothing to undo'); break; }
    case 'redo': { const l = redo(); toast(l ? `Redid: ${l}` : 'Nothing to redo'); break; }
    case 'undoto': toast(undoTo(+el.dataset.id) ? 'Went back to before that change' : 'That change is from an earlier visit — use a safety copy'); break;
    case 'toastact': { const a = toastAct; toastAct = null; document.getElementById('toast').classList.remove('show'); if (a) a.fn(); return; }
    case 'restoretrash': { setChg('Restored a deleted item'); const l = trashRestore(el.dataset.id); toast(l ? `Restored ${l}` : 'Already restored'); break; }
    case 'emptytrash': if (confirm('Permanently delete everything in Recently deleted? This can’t be undone.')) { S.trash = []; save(); } else return; break;
    // --- search, help and moving around ---
    case 'gosearch': case 'gohelp': if (ui.view !== 'search' && ui.view !== 'help') ui.prev = ui.view; ui.view = act === 'gosearch' ? 'search' : 'help'; ui.helpOpen = null; break;
    case 'closeview': ui.view = ui.prev || 'today'; break;
    case 'go': go(el.dataset.go); return;
    case 'gotab': ui.view = el.dataset.v; break;
    case 'welcomeok': S.settings.welcomed = true; save(); break;
    case 'whatsnewok': S.settings.seenVer = VERSION; save(); break;
    case 'textsize': S.settings.textSize = el.dataset.v; save(); applyTheme(); break;
    // --- updates ---
    case 'updatenow': applyUpdate(); return;
    case 'updatelater': updateLater = true; paintBanners(); return;
    case 'checkupdate': toast('Checking for updates…'); checkForUpdate().then(r => { toast(r ? 'A new version is ready' : (swReg ? 'You’re up to date' : 'Updates aren’t available in this browser')); if (ui.view === 'settings') render(); }); return;
    // --- import (the file is chosen in the 'change' listener, which fills ui.importPrev; this applies it) ---
    case 'doimport': {
      const ip = ui.importPrev; if (!ip || ip.done) return;
      const r = mergeImport(S, ip.env.data);
      pushBackup('Before import'); setChg('Imported a file'); S = r.state; save();
      ui.importPrev = { name: ip.name, env: ip.env, report: r, done: true }; undoToast('Imported — you can undo this');
      break;
    }
    case 'cancelimport': ui.importPrev = null; break;
    // --- app lock ---
    case 'lockkind': ui.lockKind = el.dataset.v; break;
    case 'lockafterpick': ui.lockAfter = +el.dataset.v; break;
    case 'lockafter': { const l = getLock(); if (l) { l.after = +el.dataset.v; setLock(l); } break; }
    case 'lockon': case 'lockchange': case 'lockoff': lockSettings(act); return;
    case 'locknow': lockNow(); return;
    case 'lockreset': lockReset(); return;
  }
  render();
});

// Live-saves the notes box as the user types (no re-render, so typing isn't interrupted).
document.addEventListener('input', e => {
  if (e.target.id === 'notes') setSym(ui.date, { notes: e.target.value });
  // Search: refresh only the results, so the box keeps focus while typing.
  if (e.target.id === 'q') { ui.q = e.target.value; const r = document.getElementById('results'); if (r) r.innerHTML = resultsHtml(ui.q); }
});
// Handles edits made in form fields (fires when a field is committed). Branches by element id or data attributes:
// reminder settings, water labels, the new-drink form, drink-editor fields (data-pid/data-f), last-caffeine time,
// cutoff, and importing a backup file.
document.addEventListener('change', async e => {
  const t = e.target;
  setChg(t.dataset.pid ? FIELD_LABELS.pid : FIELD_LABELS[t.id]); // field edits that change data are recorded for Undo/History
  if (t.id === 'remOn') {
    // Turning reminders on asks for permission, then tries real push (works with the app closed); falls back to on-device reminders.
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
    // Pre-fill the mg box when the typed type is a known one (e.g. Coffee); otherwise leave it alone.
    const known = Object.keys(TYPE_MG).find(x => x.toLowerCase() === t.value.trim().toLowerCase());
    if (known !== undefined) document.getElementById('nd-mg').value = TYPE_MG[known];
  } else if (t.dataset.pid) {
    // A field in a drink editor: data-pid names the drink, data-f the property. Takes effect for NEW logs only.
    const p = S.settings.presets.find(x => x.id === t.dataset.pid), f = t.dataset.f;
    if (p) {
      if (f === 'mg') p.mg = clamp(parseInt(t.value, 10) || 0, 0, 1000);
      else if (f === 'oz') p.oz = parseFloat(t.value) > 0 ? parseFloat(t.value) : null;
      else if (f === 'name') p.name = t.value.trim() || 'Drink';
      else p[f] = t.value.trim();
      save(); toast('Saved');
    }
  } else if (t.id === 'lastCaf') {
    // Editing the time changes the newest timestamp, so removing that drink later still rolls back to the one before.
    const L = S.logs[ui.date], v = t.value || null;
    if (L && v && (L.adds || []).length) { const adds = L.adds.slice(); adds[adds.length - 1] = { ...adds[adds.length - 1], t: v }; setLog(ui.date, { lastCaf: v, adds }); }
    else setLog(ui.date, { lastCaf: v });
    render();
  } else if (t.id === 'cutoff') {
    S.settings.cutoff = t.value || '14:00'; save(); toast('Saved');
  } else if (t.id === 'remTime') {
    S.settings.time = t.value || '09:00'; S.settings.lastNotified = ''; save(); scheduleTrigger(); syncPushDaily(true); toast('Reminder time saved');
  } else if (t.id === 'importFile' && t.files[0]) {
    // Import step 1 ("check first"): read the file and show what it WOULD add and skip. Nothing is saved until "Import these".
    try {
      const env = readEnvelope(JSON.parse(await t.files[0].text()));
      ui.importPrev = { name: t.files[0].name, env, report: mergeImport(S, env.data) };
      ui.view = 'settings'; render();
      const card = document.getElementById('importcard'); if (card) card.scrollIntoView({ block: 'start' });
    } catch (err) { toast(err && err.friendly ? err.message : 'That file doesn’t look like a Gentle Taper backup'); }
    t.value = ''; // so choosing the same file again still works
  }
});

/* ---------- push reminders ---------- */
// Real push reminders: the browser registers with its push service, the Cloudflare Worker (worker/) stores that
// subscription plus the reminder time, and sends a silent push when it's due. sw.js shows the notification.
// No health data is sent: only the subscription, reminder times, time zone and "logged today" dates.
// Waits for the service worker, but gives up after 5 seconds (it never becomes ready if registration failed).
const swReady = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('no service worker')), 5000))]);
// True when this browser can do push AND the reminder service address is configured.
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !PUSH_URL.includes('REPLACE');
// Converts the base64url VAPID public key into the byte array subscribe() needs.
const keyBytes = b64 => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
/**
 * POSTs JSON to the reminder/backup service. Throws on a non-2xx status (message ends with the status code); resolves to the parsed JSON.
 */
async function pushPost(path, body) {
  const r = await fetch(PUSH_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(path + ' ' + r.status);
  return r.json();
}
/**
 * Tells the service this device's subscription, reminder time(s) and time zone.
 */
async function syncPush(sub) {
  await pushPost('/subscribe', { subscription: sub.toJSON(), time: S.settings.time, evening: S.settings.evening ? S.settings.eveningTime : '', tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  S.settings.pushSynced = today(); save();
}
// True while enabling/disabling push, so the daily sync can't interfere mid-way.
let pushBusy = false;
/**
 * Subscribes to push and registers with the service. @returns {boolean} whether it worked
 */
async function enablePush() {
  if (!pushSupported()) return false;
  pushBusy = true;
  try {
    const reg = await swReady();
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(PUSH_KEY) });
    await syncPush(sub); return true;
  } catch (e) { return false; } finally { pushBusy = false; }
}
/**
 * Unsubscribes from push and removes the registration from the service.
 */
async function disablePush() {
  pushBusy = true;
  try {
    const sub = await (await swReady()).pushManager.getSubscription();
    if (sub) { const ep = sub.endpoint; await sub.unsubscribe(); await pushPost('/unsubscribe', { endpoint: ep }).catch(() => {}); }
  } catch (e) { /* ignore */ } finally { pushBusy = false; }
}
// Prevents overlapping "I logged something today" pings.
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
function getCloud() { try { return JSON.parse(localStorage.getItem(CLOUD_KEY)); } catch (e) { return null; } }
function setCloud(c) { try { localStorage.setItem(CLOUD_KEY, JSON.stringify(c)); } catch (e) { /* ignore */ } }
// Crockford base32 alphabet (no I, L, O, U) used for the recovery code, so it's easy to read and type.
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// True when there is anything worth backing up (never upload an empty state over a good copy).
const hasData = () => Object.keys(S.logs).length > 0 || !!S.plan || !!S.baseline;
// Bytes -> base64, in chunks (spreading a large array into fromCharCode would overflow the call stack).
const b64 = buf => { const u = new Uint8Array(buf); let out = ''; for (let i = 0; i < u.length; i += 0x8000) out += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(out); };
// Bytes -> URL-safe base64 without padding (used for the backup ID).
const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// base64 -> bytes.
const unb64 = t => Uint8Array.from(atob(t), c => c.charCodeAt(0));
/**
 * Generates a recovery code: 25 random base32 characters (125 bits) as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX.
 */
function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(25)); let c = '';
  for (let i = 0; i < 25; i++) { c += CROCK[r[i] & 31]; if (i % 5 === 4 && i < 24) c += '-'; }
  return c;
}
function normCode(t) { // forgiving about case, dashes, spaces and look-alike letters
  const c = String(t || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
  return c.length === 25 && [...c].every(ch => CROCK.includes(ch)) ? c : null;
}
/**
 * Derives two independent values from the recovery code with HKDF: the backup ID (sent to the service) and the AES-GCM key
 * (never leaves the device). The service therefore can't read what it stores.
 * @returns {Promise<{id:string, key:CryptoKey}>}
 */
async function cloudKeys(code) {
  const norm = normCode(code); if (!norm) throw new Error('bad code');
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(norm), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const p = info => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: new TextEncoder().encode(info) });
  const id = b64url(await crypto.subtle.deriveBits(p('gentle-taper id'), base, 256));
  const key = await crypto.subtle.deriveKey(p('gentle-taper key'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { id, key };
}
/**
 * Encrypts the whole state S with AES-GCM and a fresh random IV. @returns {string} JSON { v, iv, ct } (base64)
 */
async function encryptState(key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(S)));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}
/**
 * Reverses encryptState. Throws if the key is wrong or the data was tampered with (GCM authenticates it).
 */
async function decryptState(key, blob) {
  const { iv, ct } = JSON.parse(blob);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
  return JSON.parse(new TextDecoder().decode(plain));
}
/**
 * Encrypts and uploads the current state. `manual` is true when the user tapped the button (then failures are reported). Skips an empty state.
 */
async function cloudBackupNow(manual) {
  const c = getCloud();
  if (!c || cloudBusy) return false;
  if (!hasData()) { if (manual) toast('Nothing to back up yet'); return false; } // never overwrite a good copy with an empty one
  cloudBusy = true;
  try {
    const { id, key } = await cloudKeys(c.code);
    await pushPost('/backup/put', { id, blob: await encryptState(key) });
    const c2 = getCloud() || c; c2.last = Date.now(); c2.lastDay = today(); delete c2.err; setCloud(c2); cloudPending = false;
    if (manual) toast('Backed up to the cloud 🌿');
    if (manual && ui.view === 'settings') render();
    return true;
  } catch (e) {
    const why = String(e.message).includes('429') ? 'just backed up — try again in a moment' : String(e.message).includes('413') ? 'your data is too large to back up' : 'couldn’t reach the backup service';
    const c3 = getCloud(); if (c3 && !String(e.message).includes('429')) { c3.err = { t: Date.now(), msg: why }; setCloud(c3); } // shown in Settings check
    if (manual) toast(why.charAt(0).toUpperCase() + why.slice(1) + (why.startsWith('couldn') ? ' — it will retry' : ''));
    return false;
  } finally { cloudBusy = false; }
}
// Called by save(): schedules a background upload ~90 seconds after the last change, at most every 30 minutes.
function cloudDirty() { // after any change, back up shortly (at most every 30 minutes)
  if (!getCloud()) return;
  cloudPending = true; clearTimeout(cloudT);
  cloudT = setTimeout(() => { const c = getCloud(); if (c && Date.now() - (c.last || 0) > 30 * 60 * 1000) cloudBackupNow(false); }, 90000);
}
// Makes sure there's at least one upload per day, even if nothing changed.
function cloudDaily() { const c = getCloud(); if (c && c.lastDay !== today() && hasData()) cloudBackupNow(false); }
/**
 * Turns cloud backup on: makes a recovery code, shows it, and does the first upload.
 */
async function cloudOn() {
  setCloud({ code: newCode(), last: 0, lastDay: '' }); ui.showCode = true; render();
  await cloudBackupNow(true);
}
/**
 * Deletes the cloud copy and forgets the recovery code on this device (local data stays).
 */
async function cloudOff() {
  const c = getCloud();
  try { if (c) await pushPost('/backup/delete', { id: (await cloudKeys(c.code)).id }); } catch (e) { toast('Couldn’t reach the service, but backups are now off here'); }
  try { localStorage.removeItem(CLOUD_KEY); } catch (e) { /* ignore */ }
  ui.showCode = false; render(); toast('Cloud backup turned off');
}
/**
 * Restores from the cloud: fetches version `gen` (0 latest, 1 previous, 2 older), decrypts it, confirms with the user,
 * takes a safety copy first, then replaces S. Reminders are switched off because each device needs its own push registration.
 * A wrong code gives "not found" or fails to decrypt, and leaves the current data untouched.
 */
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
/**
 * The Settings card for cloud backup: either "turn on / restore on a new phone" or the on-state controls.
 */
function cloudCard() {
  const c = getCloud();
  const note = '<p class="muted" style="margin-top:-4px">Your data is encrypted on your phone with a recovery code only you hold, then stored in the cloud. Nobody else — including me — can read it. If you lose both your phone and the code, the backup can’t be opened.</p>';
  if (!c) return `<div class="card" id="set-cloud"><h2>Cloud backup</h2>${note}
      <div class="btns"><button class="btn rose" data-act="cloudon">Turn on cloud backup</button></div>
      <h3>On a new phone?</h3>
      <label class="f" for="cloudCodeIn">Enter your recovery code</label>
      <input id="cloudCodeIn" type="text" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX">
      <div class="btns"><button class="btn ghost" data-act="cloudrestore" data-gen="0">Restore from cloud</button></div></div>`;
  const when = c.last ? new Date(c.last).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'not yet';
  return `<div class="card" id="set-cloud"><div class="row"><h2 style="margin:0">Cloud backup</h2><span class="pill sage">On</span></div>${note.replace('margin-top:-4px', 'margin-top:8px')}
      <p class="muted">Last backed up: ${when}. It also backs up by itself as you log.</p>
      ${c.err ? `<p class="muted" style="color:var(--warn-ink)">The last attempt failed (${esc(c.err.msg)}) ${ago(c.err.t)}. It will try again by itself.</p>` : ''}
      ${ui.showCode ? `<div class="codebox"><div class="code">${esc(c.code)}</div>
        <p class="muted" style="margin:6px 0 0">Save this in your password manager or notes. It’s the only way to restore on a new phone.</p>
        <div class="btns"><button class="btn ghost" data-act="copycode">Copy</button><button class="btn ghost" data-act="cloudcode">Hide</button></div></div>` : ''}
      <div class="btns"><button class="btn" data-act="cloudnow">Back up now</button>${ui.showCode ? '' : '<button class="btn ghost" data-act="cloudcode">Show recovery code</button>'}</div>
      <h3>Restore from the cloud</h3>
      <div class="btns"><button class="btn ghost" data-act="cloudrestore" data-gen="0">Latest</button><button class="btn ghost" data-act="cloudrestore" data-gen="1">Previous</button><button class="btn ghost" data-act="cloudrestore" data-gen="2">Older</button></div>
      <div class="btns"><button class="btn danger" data-act="cloudoff">Turn off &amp; delete cloud copy</button></div></div>`;
}

/* ---------- reminders ---------- */
// On-device fallback reminders, used when push isn't available. They only fire while the app is open or recently opened.
/**
 * Shows a notification via the service worker (required on mobile); falls back to the page API.
 */
function notify(title, body) {
  const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'taper-daily' };
  const fallback = () => { try { new Notification(title, opts); } catch (e) { /* ignore */ } };
  if ('serviceWorker' in navigator) swReady().then(r => r.showNotification(title, opts)).catch(fallback); else fallback();
}
/**
 * The "Send a test" button: a real push if push is on, otherwise a local notification.
 */
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
/**
 * Local reminder check (runs every 30 s and on open): once per day after the chosen time, unless the user has already logged something.
 */
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
/**
 * Downloads a repeating daily calendar event, a reminder that works even if notifications don't.
 */
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
/* ---------- import & export ---------- */
// Exports are one JSON file: { app, format, appVersion, exportedAt, data }. `app` names the app, `format` is the file-layout number
// (so a future version can read old files), and `data` is the whole state. Imports MERGE: nothing already in the app is overwritten.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^\d{2}:\d{2}$/;
// Any value as a number kept inside lo..hi (d if it isn't a number). Used to make imported data safe.
const num = (v, lo, hi, d = 0) => { v = Number(v); return Number.isFinite(v) ? clamp(v, lo, hi) : d; };
/**
 * A clean copy of one imported day's log: counts and mg forced into sensible ranges and text trimmed, so a hand-edited or damaged
 * file can't put NaN or huge numbers into the totals.
 */
function cleanLog(L) {
  const out = { caf: 0, decaf: 0, drinks: {} };
  if (!L || typeof L !== 'object') return out;
  for (const [k, e] of Object.entries(L.drinks || {})) {
    if (!e || typeof e !== 'object') continue;
    const n = Math.round(num(e.n, 0, 99));
    if (n > 0) out.drinks[String(k).slice(0, 40)] = { n, mg: num(e.mg, 0, 5000), name: String(e.name ?? 'Drink').slice(0, 60), type: String(e.type ?? '').slice(0, 30), container: String(e.container ?? '').slice(0, 30) };
  }
  if (TIME_RE.test(L.lastCaf || '')) out.lastCaf = L.lastCaf;
  if (Array.isArray(L.adds)) out.adds = L.adds.filter(a => a && typeof a.id === 'string' && TIME_RE.test(a.t)).slice(0, 99).map(a => ({ id: a.id.slice(0, 40), t: a.t }));
  return out;
}
// A clean copy of one imported check-in (ratings 0-3, notes trimmed).
function cleanSym(Y) {
  const out = { done: !!(Y && Y.done), notes: String((Y && Y.notes) || '').slice(0, 2000) };
  SYMS.forEach(([k]) => { if (Y && Y[k] != null) out[k] = Math.round(num(Y[k], 0, 3)); });
  return out;
}
/**
 * The file that Export writes. @returns {object} { app:'gentle-taper', format, appVersion, exportedAt, data }
 */
function exportEnvelope() {
  return { app: 'gentle-taper', format: FORMAT, appVersion: VERSION, exportedAt: new Date().toISOString(), data: S };
}
/**
 * Checks that parsed JSON is something we can import and returns its data. Accepts the current file layout and the older plain
 * backups (which were just the state itself). Throws an Error with a friendly message otherwise.
 * @returns {{data:object, appVersion:number|null, exportedAt:string|null, format:number}}
 */
function readEnvelope(o) {
  // Errors flagged `friendly` have messages that are safe to show; anything else becomes a generic message.
  const friendly = e => { e.friendly = true; return e; };
  const bad = () => friendly(new Error('That file doesn’t look like a Gentle Taper backup'));
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad();
  if (o.app === 'gentle-taper') {
    if (!o.data || typeof o.data !== 'object' || !o.data.logs || typeof o.data.logs !== 'object') throw bad();
    if (Number(o.format) > FORMAT) throw friendly(new Error('That file was made by a newer version of the app — update the app first'));
    return { data: o.data, appVersion: o.appVersion ?? null, exportedAt: o.exportedAt ?? null, format: Number(o.format) || FORMAT };
  }
  if (o.logs && typeof o.logs === 'object') return { data: o, appVersion: null, exportedAt: null, format: 0 };
  throw bad();
}
/**
 * Merges imported data into a copy of `cur` WITHOUT overwriting anything, and reports what happened. Used both for the "check first"
 * preview and for the real import, so what you're shown is exactly what is done.
 *  - a day/check-in/water tally you already have is kept and the imported one is skipped (a day with only a check-in and no drinks
 *    does take the imported drinks);
 *  - drinks are matched by id or by the same name, type and mg;
 *  - an imported plan is used only if you have none; otherwise it is skipped (older plans are added to your plan history).
 * Settings, reminders and recently-deleted items are never imported.
 * @returns {{state:object, add:object, skip:object}} the merged state, plus counts of what was added / skipped
 */
function mergeImport(cur, incRaw) {
  const inc = migrateState(normalize(JSON.parse(JSON.stringify(incRaw))));
  const out = JSON.parse(JSON.stringify(cur)), add = {}, skip = {};
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const noDrinks = L => !L || !Object.keys(L.drinks || {}).length;
  Object.keys(inc.logs).forEach(d => {
    if (!DATE_RE.test(d)) return bump(skip, 'invalid');
    const L = cleanLog(inc.logs[d]);
    if (!out.logs[d] || (noDrinks(out.logs[d]) && !noDrinks(L))) { out.logs[d] = L; bump(add, 'days'); } else bump(skip, 'days');
  });
  Object.keys(inc.sym).forEach(d => {
    if (!DATE_RE.test(d)) return bump(skip, 'invalid');
    if (!out.sym[d]) { out.sym[d] = cleanSym(inc.sym[d]); bump(add, 'checkins'); } else bump(skip, 'checkins');
  });
  Object.keys(inc.water).forEach(d => {
    const w = Math.round(num(inc.water[d], 0, 30));
    if (!DATE_RE.test(d)) return bump(skip, 'invalid');
    if (!w) return;
    if (!(out.water[d] > 0)) { out.water[d] = w; bump(add, 'water'); } else bump(skip, 'water');
  });
  (inc.settings.presets || []).forEach(p => {
    if (!p || typeof p !== 'object' || !p.name) return;
    const same = out.settings.presets.some(x => x.id === p.id || (x.name.toLowerCase() === String(p.name).toLowerCase() && x.mg === p.mg && (x.type || '') === (p.type || '')));
    if (same) return bump(skip, 'drinks');
    const id = out.settings.presets.some(x => x.id === p.id) ? 'p' + Date.now().toString(36) + out.settings.presets.length : String(p.id || 'p' + Date.now().toString(36)).slice(0, 40);
    out.settings.presets.push({ id, name: String(p.name).slice(0, 40), type: String(p.type || '').slice(0, 30), container: String(p.container || '').slice(0, 30), oz: num(p.oz, 0, 128) || null, mg: num(p.mg, 0, 1000), fav: p.fav !== false });
    bump(add, 'drinks');
  });
  const sig = p => `${p.start}|${(p.targets || []).join(',')}`;
  if (inc.plan && Array.isArray(inc.plan.targets) && DATE_RE.test(inc.plan.start || '')) {
    if (!out.plan && !out.baseline) {
      out.plan = inc.plan; bump(add, 'plan');
      Object.keys(inc.hist).forEach(d => { if (DATE_RE.test(d) && out.hist[d] == null) out.hist[d] = num(inc.hist[d], 0, 2000); });
    } else bump(skip, 'plan');
  }
  (inc.pastPlans || []).forEach(p => {
    if (!p || !Array.isArray(p.targets) || !DATE_RE.test(p.start || '')) return;
    if ([...out.pastPlans, out.plan].filter(Boolean).some(x => sig(x) === sig(p))) return bump(skip, 'pastPlans');
    out.pastPlans.push(p); bump(add, 'pastPlans');
  });
  Object.keys(inc.ms).forEach(k => { if (!out.ms[k] && DATE_RE.test(inc.ms[k])) { out.ms[k] = inc.ms[k]; bump(add, 'milestones'); } });
  return { state: out, add, skip };
}
// Words for a count: plural(3, 'day') -> '3 days'.
const plural = (n, w, pl) => `${n} ${n === 1 ? w : (pl || w + 's')}`;
// Plain-language list of what a merge report added ('adds') or skipped ('skips'), as an array of phrases.
function describeMerge(r, which) {
  const o = r[which], P = plural, L = [];
  if (which === 'add') {
    if (o.days) L.push(P(o.days, 'day') + ' of drinks'); if (o.checkins) L.push(P(o.checkins, 'check-in')); if (o.water) L.push(P(o.water, 'day', 'days') + ' of water');
    if (o.drinks) L.push(P(o.drinks, 'drink') + ' in your list'); if (o.plan) L.push('a taper plan'); if (o.pastPlans) L.push(P(o.pastPlans, 'earlier plan'));
    if (o.milestones) L.push(P(o.milestones, 'milestone'));
  } else {
    if (o.days) L.push(P(o.days, 'day') + ' you already have'); if (o.checkins) L.push(P(o.checkins, 'check-in') + ' you already have'); if (o.water) L.push(P(o.water, 'water tally', 'water tallies') + ' you already have');
    if (o.drinks) L.push(P(o.drinks, 'drink') + ' already in your list'); if (o.plan) L.push('the file’s taper plan (you already have one)'); if (o.pastPlans) L.push(P(o.pastPlans, 'earlier plan') + ' you already have');
    if (o.invalid) L.push(P(o.invalid, 'entry', 'entries') + ' with an unreadable date');
  }
  return L;
}
// The "check first" card in Settings: shows what an import would add and skip, before anything is saved. Also shows the result afterwards.
function importCard() {
  const ip = ui.importPrev; if (!ip) return '';
  const add = describeMerge(ip.report, 'add'), skip = describeMerge(ip.report, 'skip');
  const meta = [ip.env.appVersion ? `made by version ${ip.env.appVersion}` : 'an older backup file', ip.env.exportedAt ? `exported ${esc(ip.env.exportedAt.slice(0, 10))}` : ''].filter(Boolean).join(' · ');
  const lists = `${add.length ? `<h3>${ip.done ? 'Added' : 'Will add'}</h3><ul class="wk">${add.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
    ${skip.length ? `<h3>${ip.done ? 'Skipped' : 'Will skip'} (nothing is overwritten)</h3><ul class="wk">${skip.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}`;
  if (ip.done) return `<div class="card note" id="importcard"><h2>Import finished</h2><p class="muted">${esc(ip.name)}</p>${lists || '<p>Nothing needed adding.</p>'}
    <div class="btns"><button class="btn" data-act="cancelimport">Close</button></div></div>`;
  return `<div class="card alert" id="importcard"><h2>Check before importing</h2><p class="muted">${esc(ip.name)} · ${meta}</p>
    ${add.length ? '' : '<p><b>Nothing new to add</b> — everything in this file is already in the app.</p>'}${lists}
    <p class="muted">A safety copy of your current data is saved first, and you can undo the import afterwards.</p>
    <div class="btns">${add.length ? '<button class="btn rose" data-act="doimport">Import these</button>' : ''}<button class="btn ghost" data-act="cancelimport">Cancel</button></div></div>`;
}
/**
 * Exports the app's data as a JSON file: through the phone's share sheet when available (save to Files/Drive), otherwise a normal download.
 */
async function exportData() {
  const json = JSON.stringify(exportEnvelope(), null, 2), name = `gentle-taper-backup-${today()}.json`;
  const done = () => { S.settings.lastExport = today(); save(); render(); toast('Backup exported'); };
  try {
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Gentle Taper backup' }); return done(); }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  saveBlob(new Blob([json], { type: 'application/json' }), name); done();
}
/**
 * Triggers a browser download of `blob` as `name`.
 */
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// The newest day on which the user saved a copy anywhere: an export file or the cloud backup. '' if never.
function lastBackupDay() { const c = getCloud(); return [S.settings.lastExport, c && c.lastDay].filter(Boolean).sort().pop() || ''; }

/* ---------- app lock ---------- */
// An optional PIN or password screen. Only a salted PBKDF2 hash is stored (in its own key, never exported). This keeps the app
// private from someone holding an unlocked phone; it does not encrypt the stored data. 5 wrong tries in a row slow guessing down.
let locked = false, hiddenAt = 0;
function getLock() { try { return JSON.parse(localStorage.getItem(LOCK_KEY)); } catch (e) { return null; } }
function setLock(l) { try { if (l) localStorage.setItem(LOCK_KEY, JSON.stringify(l)); else localStorage.removeItem(LOCK_KEY); return true; } catch (e) { return false; } }
// Stretches a PIN/password with PBKDF2 (150,000 rounds, SHA-256) and the stored random salt. @returns {Promise<string>} base64 hash
async function lockHash(secret, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: 150000 }, base, 256));
}
// Is this a usable PIN (4-8 digits) or password (6+ characters)?
const lockValid = (kind, s) => kind === 'pin' ? /^\d{4,8}$/.test(s) : String(s).length >= 6;
/**
 * Checks a PIN/password. Wrong answers are counted; after 5 in a row there is a growing wait (30 s, 1 min, 2 min... up to 15 min).
 * @returns {Promise<{ok:boolean, wait?:number}>} `wait` is the milliseconds until the next try is allowed
 */
async function lockTry(secret) {
  const l = getLock(); if (!l) return { ok: true };
  const wait = (l.until || 0) - Date.now();
  if (wait > 0) return { ok: false, wait };
  if (await lockHash(secret, l.salt) === l.hash) { l.fails = 0; l.until = 0; setLock(l); return { ok: true }; }
  l.fails = (l.fails || 0) + 1;
  if (l.fails >= 5) l.until = Date.now() + Math.min(30000 * 2 ** (l.fails - 5), 900000);
  setLock(l);
  return { ok: false, wait: Math.max(0, (l.until || 0) - Date.now()) };
}
// Creates (or replaces) the lock. @param {'pin'|'password'} kind @param {number} after minutes away before it locks again (0 = every time)
async function lockCreate(kind, secret, after) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  return setLock({ kind, salt, hash: await lockHash(secret, salt), after, fails: 0, until: 0 });
}
// Covers the app with the lock screen and empties the page behind it.
function lockNow() {
  if (!getLock()) return;
  locked = true; document.body.classList.add('locked');
  document.getElementById('app').innerHTML = '';
  paintLock();
}
// Draws the lock screen. `msg` is an optional line under the box (e.g. "That's not it").
function paintLock(msg) {
  const l = getLock(), el = document.getElementById('lock'); if (!l) return;
  el.hidden = false;
  el.innerHTML = `<form id="lockForm" class="lockbox"><h2>Gentle Taper is locked 🌿</h2>
    <label class="f" for="lockIn">Enter your ${l.kind === 'pin' ? 'PIN' : 'password'}</label>
    <input id="lockIn" type="password" ${l.kind === 'pin' ? 'inputmode="numeric" pattern="[0-9]*"' : ''} autocomplete="off" autocapitalize="off" spellcheck="false">
    <p id="lockMsg" class="muted" role="alert">${esc(msg || '')}</p>
    <button class="btn rose block" type="submit">Unlock</button>
    <details style="margin-top:14px"><summary>Forgot it?</summary>
      <p class="muted">There’s no way to reset the lock without erasing this phone’s copy of your data. You can then restore from an export file or your cloud recovery code.</p>
      <button class="btn danger block" type="button" data-act="lockreset">Erase this phone and start over</button></details></form>`;
  const i = document.getElementById('lockIn'); if (i) i.focus();
}
// Hides the lock screen and shows the app (starting it first if this is the first unlock since opening).
function unlock() {
  locked = false; document.body.classList.remove('locked');
  const el = document.getElementById('lock'); el.hidden = true; el.innerHTML = '';
  if (!started) startApp(); else render();
}
// Handles the lock form: checks the PIN/password and unlocks, or explains the wait.
document.addEventListener('submit', async e => {
  if (e.target.id !== 'lockForm') return;
  e.preventDefault();
  const v = document.getElementById('lockIn').value;
  if (!v) return;
  const r = await lockTry(v);
  if (r.ok) return unlock();
  const s = Math.ceil((r.wait || 0) / 1000);
  paintLock(s > 0 ? `Too many tries. Please wait ${s >= 60 ? Math.ceil(s / 60) + ' minute' + (s > 60 ? 's' : '') : s + ' seconds'}.` : 'That’s not it — try again.');
});
// Turning the lock on / off / changing it (Settings). Each reads its boxes, checks them, then redraws Settings.
async function lockSettings(act) {
  const val = id => (document.getElementById(id) || {}).value || '', l = getLock();
  try {
    if (act === 'lockon' || act === 'lockchange') {
      const kind = act === 'lockchange' ? l.kind : ui.lockKind, nw = val('lkNew');
      if (act === 'lockchange' && !(await lockTry(val('lkCur'))).ok) return toast('Your current PIN or password isn’t right');
      if (!lockValid(kind, nw)) return toast(kind === 'pin' ? 'A PIN needs 4 to 8 digits' : 'A password needs at least 6 characters');
      if (nw !== val('lkNew2')) return toast('The two entries don’t match');
      await lockCreate(kind, nw, act === 'lockchange' ? l.after : ui.lockAfter);
      toast(act === 'lockon' ? 'App lock is on' : 'Lock changed');
    } else if (act === 'lockoff') {
      if (!(await lockTry(val('lkCur'))).ok) return toast('Your current PIN or password isn’t right');
      setLock(null); toast('App lock is off');
    }
  } catch (err) { toast('Couldn’t set the lock on this browser'); }
  render();
}
// "Forgot it": erases every copy of the data kept on this phone (keeping nothing that could bypass the lock), then reloads.
function lockReset() {
  if (!confirm('Erase everything this app stores on this phone and start over? You can restore from an export file or your cloud recovery code. This can’t be undone.')) return;
  eraseLocalData();
  location.reload();
}
// Removes every key the app keeps on this phone: data, safety copies, cloud recovery code, history and the lock itself.
function eraseLocalData() {
  [KEY, BK, CLOUD_KEY, HIST_KEY, LOCK_KEY].forEach(k => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
}
// Locks again when the app has been away long enough (the Settings choice), or every time it leaves the screen.
function lockOnReturn(hidden) {
  const l = getLock(); if (!l || locked) return;
  if (hidden) { hiddenAt = Date.now(); if (l.after === 0) lockNow(); }
  else if (l.after > 0 && hiddenAt && Date.now() - hiddenAt >= l.after * 60000) lockNow();
}

/* ---------- updates & status ---------- */
// Update flow: sw.js installs a new version in the background but keeps it waiting. When one is waiting we show a banner;
// "Update now" tells it to take over, and the page reloads once it has.
let swReg = null, updateReady = false, updateLater = false, wantReload = false, online = navigator.onLine !== false, storageNote = '';
/**
 * Starts watching a service-worker registration for a waiting (= downloaded, not yet active) new version.
 */
function watchUpdates(reg) {
  swReg = reg;
  const check = () => { if (reg.waiting && navigator.serviceWorker.controller) { updateReady = true; paintBanners(); if (!locked && ui.view === 'settings') render(); } };
  check();
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') check(); });
  });
}
// Asks the browser to look for a new version now. @returns {Promise<boolean>} whether one is ready
async function checkForUpdate() {
  if (!swReg) return false;
  try { await swReg.update(); } catch (e) { return updateReady; }
  // update() returns as soon as a new worker is found, before its files have finished downloading: wait for that to finish.
  const w = swReg.installing;
  if (w && w.state !== 'installed') await new Promise(res => w.addEventListener('statechange', () => { if (['installed', 'activated', 'redundant'].includes(w.state)) res(); }));
  if (swReg.waiting && navigator.serviceWorker.controller) { updateReady = true; paintBanners(); }
  return updateReady;
}
// "Update now": activates the waiting version and reloads into it. If none is waiting, just reloads (which fetches fresh files).
function applyUpdate() {
  wantReload = true;
  if (swReg && swReg.waiting) swReg.waiting.postMessage({ type: 'SKIP_WAITING' }); else location.reload();
  setTimeout(() => location.reload(), 4000); // safety net if the worker never answers
}
// Draws the notices above the page: couldn't save, storage nearly full, new version ready, offline. They update on their own.
function paintBanners() {
  const el = document.getElementById('banner'); if (!el) return;
  el.innerHTML = (saveFailed ? '<div class="banner bad" role="alert"><b>Your latest changes couldn’t be saved on this phone.</b> Storage may be full or blocked. <button class="btn sm" data-act="export">Export a copy now</button></div>' : '')
    + (storageNote ? `<div class="banner warn" role="status">${esc(storageNote)} <button class="btn sm" data-act="go" data-go="set:set-data">Back up</button></div>` : '')
    + (updateReady && !updateLater ? '<div class="banner" role="status"><b>A new version is ready.</b> <button class="btn sm rose" data-act="updatenow">Update now</button><button class="btn sm ghost" data-act="updatelater">Later</button></div>' : '')
    + (!online ? '<div class="banner" role="status">You’re offline. Everything still works and is saved on this phone.</div>' : '');
}
/**
 * Asks the browser how full this app's storage is and sets a warning when it passes 80%.
 */
async function checkStorage() {
  try {
    const e = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    storageNote = e && e.quota && e.usage / e.quota > 0.8 ? `This phone’s storage for the app is ${Math.round(e.usage / e.quota * 100)}% full.` : '';
  } catch (err) { storageNote = ''; }
  paintBanners();
}
// Rows for the "Settings check" card: [name, state ('ok' on, 'off' off, 'warn' needs attention), words].
function statusRows() {
  const st = S.settings, c = getCloud(), lk = getLock(), bk = readBackups(), lb = lastBackupDay(), t = today();
  const kb = Math.max(1, Math.round(new Blob([JSON.stringify(S)]).size / 1024));
  return [
    ['Reminders', st.remind ? 'ok' : 'off', st.remind ? (st.push ? 'On — push, works when the app is closed' : 'On — on this device only') : 'Off'],
    ['Cloud backup', c ? (c.err ? 'warn' : 'ok') : 'off', c ? (c.err ? `On — last try failed (${c.err.msg})` : `On — last backed up ${c.last ? ago(c.last) : 'not yet'}`) : 'Off'],
    ['Last backup', lb ? (diff(lb, t) > 14 && hasData() ? 'warn' : 'ok') : (hasData() ? 'warn' : 'off'), lb ? `${nice(lb)} (${diff(lb, t) === 0 ? 'today' : plural(diff(lb, t), 'day') + ' ago'})` : 'Never — export a copy from Your data'],
    ['Safety copies on this phone', bk.length ? 'ok' : 'off', bk.length ? `${plural(bk.length, 'copy')}, newest ${nice(bk[bk.length - 1].date)}` : 'None yet'],
    ['App lock', lk ? 'ok' : 'off', lk ? `On (${lk.kind === 'pin' ? 'PIN' : 'password'})` : 'Off'],
    ['Works offline', 'serviceWorker' in navigator && navigator.serviceWorker.controller ? 'ok' : 'warn', 'serviceWorker' in navigator && navigator.serviceWorker.controller ? 'Ready — the app is saved on this phone' : 'Not ready yet — open the app once while online'],
    ['Connection', online ? 'ok' : 'warn', online ? 'Online' : 'Offline — changes are kept on this phone'],
    ['Storage', saveFailed ? 'warn' : (storageNote ? 'warn' : 'ok'), saveFailed ? 'Couldn’t save the last change' : (storageNote || `OK — your data takes about ${kb} KB`)],
  ];
}

/* ---------- theme ---------- */
/**
 * Applies light/dark (or follows the phone) by setting data-theme on <html> and updating the browser's theme-color.
 */
function applyTheme() {
  const pref = S.settings.theme || 'auto';
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.text = S.settings.textSize || 'normal'; // styles.css scales the page's base font size
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = dark ? '#1c2a21' : '#cfe5d3';
}
// Follow the phone's light/dark setting live when the user chose "Match phone".
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); render(); });
// Remember whether the "More drinks" section is open so re-renders don't collapse it.
document.addEventListener('toggle', e => {
  if (!e.target.classList) return;
  if (e.target.classList.contains('more')) ui.moreOpen = e.target.open;
  else if (e.target.id && e.target.id.startsWith('set-')) ui.openSet[e.target.id] = e.target.open; // keep Settings cards open across redraws
}, true);

/* ---------- boot ---------- */
// Start-up order: theme + decoration + notices; then either the lock screen or straight into the app (startApp). Function
// declarations below are hoisted, so they're callable from here.
let started = false;
/**
 * Everything that happens once the app is allowed to show (immediately, or after the lock is opened): tidy first-run flags,
 * daily safety copy, pick the first tab, handle a home-screen shortcut, draw, then check reminders / push / cloud / storage.
 */
function startApp() {
  started = true;
  let dirty = false;
  // Someone brand new has nothing to be "new" about; someone who already has data doesn't need the welcome card.
  if (!hasData() && S.settings.seenVer !== VERSION) { S.settings.seenVer = VERSION; dirty = true; }
  if (hasData() && !S.settings.welcomed) { S.settings.welcomed = true; dirty = true; }
  if (dirty) save();
  purgeTrash(); pushBackup();
  if (!S.plan && !S.baseline) ui.view = 'plan';
  handleLaunchParams();
  render();
  checkReminder(); scheduleTrigger(); syncPushDaily(); setTimeout(cloudDaily, 4000); checkStorage();
}
applyTheme();
applyDecor();
paintBanners();
if (getLock()) lockNow(); else startApp();
// Home-screen shortcuts open the app with ?quick=<drink>; log one and tidy the URL.
/**
 * Home-screen shortcut support: opening the app as ?quick=<drink id> logs one of that drink (and tidies the URL).
 */
function handleLaunchParams() {
  const quick = new URLSearchParams(location.search).get('quick');
  if (!quick) return;
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  const d = today();
  const pr = S.settings.presets.find(x => x.id === (quick === 'cans' ? 'can' : quick)); // 'cans' = old shortcut name
  if (!pr) return;
  const key = setDrink(d, pr, 1); if (pr.mg > 0) stamp(d, key); toast(`Logged ${pr.name}`);
  ui.date = d; ui.followToday = true; if (S.plan || S.baseline) ui.view = 'today';
}
// If the app was left open past midnight, move "today" forward (unless the user is looking at an older day on purpose).
/**
 * Runs periodically: takes the daily safety copy and, if the app stayed open past midnight, moves "today" forward.
 */
function rollover() { pushBackup(); if (ui.followToday && ui.date !== today()) { ui.date = today(); render(); } }
// Housekeeping tick every 30 seconds.
setInterval(() => { checkReminder(); rollover(); }, 30000);
// Online / offline notices, and catching up when the connection comes back.
window.addEventListener('online', () => { online = true; paintBanners(); cloudDaily(); syncPushDaily(); });
window.addEventListener('offline', () => { online = false; paintBanners(); });
// When the app comes back to the foreground: roll the day over and re-sync. When it goes to the background: flush any pending cloud backup.
document.addEventListener('visibilitychange', () => {
  lockOnReturn(document.visibilityState !== 'visible');
  if (document.visibilityState === 'visible') { rollover(); checkReminder(); syncPushDaily(); cloudDaily(); checkStorage(); if (swReg) swReg.update().catch(() => { /* offline */ }); }
  else if (cloudPending) { const c = getCloud(); if (c && Date.now() - (c.last || 0) > 5 * 60 * 1000) cloudBackupNow(false); }
});
// Register the service worker (offline cache + push). Optional: the app works without it.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(reg => { watchUpdates(reg); setInterval(() => reg.update().catch(() => { /* offline */ }), 3600000); })
    .catch(() => { /* offline support is optional */ });
  // A new version took over: reload into it, but only when the user asked (the very first install also fires this event).
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (wantReload) location.reload(); });
}
