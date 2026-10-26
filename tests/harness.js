'use strict';
/*
 * Test harness: loads the real index.html and app.js into a simulated browser (jsdom), so tests exercise the same code that ships.
 * Each boot() gives a fresh page with its own empty localStorage.
 *
 *   const app = boot();                    // a brand-new user
 *   const app = boot({ storage: { 'gentle-taper-v1': JSON.stringify(state) } });   // someone with saved data
 *   app.run('S.logs')                      // evaluate an expression in the page (top-level let/const are reachable)
 *   await app.click('[data-act="dr+"]')    // click a real button, then let timers settle
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const wait = (ms = 5) => new Promise(r => setTimeout(r, ms));

/**
 * @param {object} [opts] storage: keys to put in localStorage before the app starts; confirm: answer for confirm() dialogs
 */
function boot(opts = {}) {
  const html = read('index.html').replace('<script src="app.js"></script>', '');
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'https://example.test/gentle-taper/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    beforeParse(w) {
      Object.entries(opts.storage || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.scrollTo = () => {};
      w.Element.prototype.scrollIntoView = function () {};
      w.confirm = () => opts.confirm !== false;
      w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
      Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true });
      w.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
      w.addEventListener('error', e => errors.push(e.error || e.message));
    },
  });
  const ctx = dom.getInternalVMContext();
  const run = code => new vm.Script(code).runInContext(ctx);
  new vm.Script(read('app.js'), { filename: 'app.js' }).runInContext(ctx);
  const win = dom.window, doc = win.document;
  const q = sel => (typeof sel === 'string' ? doc.querySelector(sel) : sel);
  return {
    dom, win, doc, run, errors,
    q, qa: sel => [...doc.querySelectorAll(sel)],
    // Click a real element, then wait one tick so the app's own timers (undo grouping, toasts) settle.
    async click(sel) {
      const el = q(sel); if (!el) throw new Error('No element for ' + sel);
      el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
      await wait();
    },
    // Type into a field and fire the events a browser would.
    async type(sel, value, events = ['input', 'change']) {
      const el = q(sel); if (!el) throw new Error('No element for ' + sel);
      el.value = value; for (const ev of events) el.dispatchEvent(new win.Event(ev, { bubbles: true })); await wait();
    },
    text: () => doc.getElementById('app').textContent.replace(/\s+/g, ' ').trim(),
    wait,
    close: () => dom.window.close(),
  };
}

// 'YYYY-MM-DD' for today plus `n` days (local time, like the app).
const day = (n = 0) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// One drink entry the way the app stores it inside a day's log.
const entry = (name, n, mg, extra = {}) => ({ n, mg, name, type: 'Coffee', container: 'Cup', ...extra });
// A saved-state object (version 3) with the given parts; the app fills in everything else (settings, drink list...) itself.
const state = (parts = {}) => ({ v: 3, ...parts });
// localStorage contents for boot(): the app's state saved under its key.
const saved = (parts = {}) => ({ 'gentle-taper-v1': JSON.stringify(state(parts)) });
// A believable user: a 14-day taper that started 6 days ago, with six logged days and check-ins.
function sampleUser() {
  const logs = {}, sym = {}, hist = {};
  for (let i = 6; i >= 1; i--) {
    logs[day(-i)] = { caf: 0, decaf: 0, drinks: { coffee: entry('Coffee', 2, 95), can: entry('Caffeinated can', 1, 40, { type: 'Soda', container: 'Can' }) }, adds: [{ id: 'coffee', t: '09:10' }], lastCaf: '09:10' };
    sym[day(-i)] = { headache: 1, fatigue: 2, irritability: 0, nausea: 0, focus: 1, mood: 1, done: true, notes: i === 3 ? 'Rough afternoon, felt a headache coming' : '' };
    hist[day(-i)] = 230 - (6 - i) * 15;
  }
  return state({ plan: { start: day(-6), targets: Array.from({ length: 14 }, (_, i) => Math.max(0, 230 - i * 18)), pausedAt: null }, hist, logs, sym, water: { [day(-2)]: 4 } });
}

module.exports = { boot, read, wait, ROOT, day, entry, state, saved, sampleUser };
