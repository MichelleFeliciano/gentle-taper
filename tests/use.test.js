'use strict';
// Using the app: search, help, welcome and what's-new cards, Settings check, empty screens, text size, offline and storage notices, updates.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, day, saved, sampleUser, state } = require('./harness');

test('a brand-new user sees the welcome card, and dismissing it sticks', async () => {
  const app = boot();
  assert.match(app.text(), /Welcome/);
  await app.click('[data-act="welcomeok"]');
  assert.doesNotMatch(app.text(), /Welcome 🌿/);
  const keep = { 'gentle-taper-v1': app.win.localStorage.getItem('gentle-taper-v1') };
  app.close();
  const again = boot({ storage: keep });
  assert.doesNotMatch(again.text(), /Welcome 🌿/);
  again.close();
});

test('someone who already has data never sees the welcome card, and sees What’s new once', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  assert.doesNotMatch(app.text(), /Welcome 🌿/);
  assert.match(app.text(), /What’s new in version 19/);
  await app.click('[data-act="whatsnewok"]');
  assert.doesNotMatch(app.text(), /What’s new in version/);
  assert.equal(app.run('S.settings.seenVer'), 19);
  app.close();
});

test('a new user is not told about "what’s new" later', async () => {
  const app = boot();
  assert.equal(app.run('S.settings.seenVer'), app.run('VERSION'));
  app.close();
});

test('Search finds drinks, notes, symptoms, Help topics and settings, and a result opens the right place', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  await app.click('[data-act="gosearch"]');
  assert.equal(app.doc.activeElement.id, 'q', 'the box is ready to type in');
  await app.type('#q', 'coffee', ['input']);
  assert.ok(app.qa('#results .sres').some(r => /Logged/.test(r.textContent) && /2 × Coffee/.test(r.textContent)), 'logged coffee');
  assert.ok(app.qa('#results .sres').some(r => /My drink|Drink/.test(r.textContent)), 'the drink in my list');
  await app.type('#q', 'headache', ['input']);
  assert.ok(app.qa('#results .sres').some(r => /Note/.test(r.textContent) && /headache coming/.test(r.textContent)), 'the note');
  assert.ok(app.qa('#results .sres').some(r => /Symptom/.test(r.textContent)), 'the symptom');
  await app.type('#q', 'dark mode', ['input']);
  assert.ok(app.qa('#results .sres').some(r => /Appearance/.test(r.textContent)), 'a setting');
  await app.type('#q', 'recovery', ['input']);
  assert.ok(app.qa('#results .sres').some(r => /Help/.test(r.textContent)), 'help text');
  // open a note result: it goes to that day on Today
  await app.type('#q', 'felt a headache', ['input']);
  await app.click('#results .sres');
  assert.equal(app.run('ui.view'), 'today');
  assert.equal(app.run('ui.date'), day(-3));
  app.close();
});

test('Search copes with short, empty and unmatched text and with HTML-looking input', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  await app.click('[data-act="gosearch"]');
  assert.match(app.q('#results').textContent, /at least two letters/);
  await app.type('#q', 'zzzzqq', ['input']);
  assert.match(app.q('#results').textContent, /Nothing found/);
  await app.type('#q', '<img src=x onerror=alert(1)>', ['input']);
  assert.equal(app.q('#results img'), null, 'what you type is never treated as HTML');
  await app.click('[data-act="closeview"]');
  assert.equal(app.run('ui.view'), 'today', 'Close returns to where you were');
  app.close();
});

test('Help opens, lists topics, and a topic found through search opens expanded', async () => {
  const app = boot();
  await app.click('[data-act="gohelp"]');
  assert.ok(app.qa('#app details.help').length >= 8);
  await app.click('[data-act="closeview"]');
  await app.click('[data-act="gosearch"]');
  await app.type('#q', 'safety copies', ['input']);
  await app.click('#results .sres');
  assert.equal(app.run('ui.view'), 'help');
  assert.ok(app.qa('#app details.help[open]').length >= 1);
  app.close();
});

test('the Settings check lists what is on or off and reflects changes', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  await app.click('#tabs [data-view="settings"]');
  const rows = () => app.qa('#set-check li').map(li => li.textContent.replace(/\s+/g, ' ').trim());
  const names = ['Reminders', 'Cloud backup', 'Last backup', 'Safety copies', 'App lock', 'Works offline', 'Connection', 'Storage'];
  names.forEach(n => assert.ok(rows().some(r => r.includes(n)), 'missing row ' + n));
  assert.match(rows().find(r => r.includes('Cloud backup')), /Off/);
  assert.match(rows().find(r => r.includes('Last backup')), /Never/);
  assert.match(rows().find(r => r.includes('Works offline')), /Not ready yet/, 'no service worker in the test browser');
  app.win.localStorage.setItem('gentle-taper-cloud', JSON.stringify({ code: 'X', last: Date.now(), lastDay: day(0), err: { t: Date.now(), msg: 'couldn’t reach the backup service' } }));
  app.run('render()');
  assert.match(rows().find(r => r.includes('Cloud backup')), /last try failed/);
  app.close();
});

test('empty screens offer an "Add one now" style button that works', async () => {
  const app = boot({ storage: saved({ settings: { presets: [] } }) });
  await app.click('#tabs [data-view="today"]');
  assert.match(app.text(), /You don’t have any drinks yet/);
  await app.click('#app .empty [data-act="newdrink"]');
  assert.ok(app.q('#nd-name'), 'the new-drink form opened');
  await app.click('#tabs [data-view="settings"]');
  await app.click('#set-drinks [data-act="addpreset"]');
  assert.equal(app.run('S.settings.presets.length'), 1);
  await app.click('#tabs [data-view="progress"]');
  assert.match(app.text(), /Charts will bloom/);
  await app.click('#app .empty [data-act="gotab"]');
  assert.equal(app.run('ui.view'), 'plan');
  app.close();
});

test('"Logged this day" shows an empty state when nothing is logged', () => {
  const app = boot({ storage: saved({ plan: { start: day(0), targets: [100, 0], pausedAt: null } }) });
  assert.match(app.text(), /Nothing logged for this day yet/);
  app.close();
});

test('text size changes the page, is remembered, and the controls stay usable', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  await app.click('#tabs [data-view="settings"]');
  assert.equal(app.doc.documentElement.dataset.text, 'normal');
  await app.click('[data-act="textsize"][data-v="xl"]');
  assert.equal(app.doc.documentElement.dataset.text, 'xl');
  assert.equal(app.q('[data-act="textsize"][data-v="xl"]').getAttribute('aria-pressed'), 'true');
  const keep = { 'gentle-taper-v1': app.win.localStorage.getItem('gentle-taper-v1') };
  app.close();
  const again = boot({ storage: keep });
  assert.equal(again.doc.documentElement.dataset.text, 'xl');
  again.close();
});

test('going offline shows a notice, and coming back removes it', async () => {
  const app = boot();
  assert.equal(app.q('#banner').textContent.trim(), '');
  app.win.dispatchEvent(new app.win.Event('offline'));
  assert.match(app.q('#banner').textContent, /You’re offline/);
  app.win.dispatchEvent(new app.win.Event('online'));
  assert.equal(app.q('#banner').textContent.trim(), '');
  app.close();
});

test('when the phone refuses to save, a warning appears and the app keeps working', async () => {
  const app = boot({ storage: saved({ plan: { start: day(0), targets: [100, 0], pausedAt: null } }) });
  app.win.Storage.prototype.setItem = function () { throw new Error('QuotaExceededError'); };
  await app.click('[data-act="dr+"][data-quick="1"][data-id="coffee"]');
  assert.match(app.q('#banner').textContent, /couldn’t be saved/);
  assert.equal(app.run('totalMg(today())'), 95, 'what you did is still on screen');
  assert.ok(app.q('#banner [data-act="export"]'), 'with a way to export a copy right now');
  app.close();
});

test('storage that is nearly full shows a warning with a Back up button', async () => {
  const app = boot();
  Object.defineProperty(app.win.navigator, 'storage', { value: { estimate: async () => ({ usage: 90, quota: 100 }) }, configurable: true });
  await app.run('checkStorage()');
  assert.match(app.q('#banner').textContent, /90% full/);
  assert.ok(app.q('#banner [data-act="go"]'));
  app.close();
});

test('a waiting new version shows a banner by itself; Update now tells it to take over', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  const sent = [];
  Object.defineProperty(app.win.navigator, 'serviceWorker', { value: { controller: {}, addEventListener() {} }, configurable: true });
  const reg = { waiting: { postMessage: m => sent.push(m) }, installing: null, addEventListener() {}, update: async () => {} };
  app.win.__reg = reg;
  app.run('watchUpdates(__reg)');
  assert.match(app.q('#banner').textContent, /new version is ready/);
  await app.click('#banner [data-act="updatelater"]');
  assert.equal(app.q('#banner').textContent.trim(), '');
  await app.click('#tabs [data-view="settings"]');
  assert.match(app.q('#set-updates').textContent, /Update ready/);
  assert.match(app.q('#set-updates').textContent, /Version 19/);
  assert.match(app.q('#set-updates').textContent, /Last updated October 26, 2026/);
  await app.click('#set-updates [data-act="updatenow"]');
  assert.equal(JSON.stringify(sent), '[{"type":"SKIP_WAITING"}]');
  assert.equal(app.run('wantReload'), true);
  app.close();
});

test('What’s new in Settings lists every version with its date', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  await app.click('#tabs [data-view="settings"]');
  const t = app.q('#set-whatsnew').textContent;
  assert.match(t, /Version 19 · October 26, 2026/); assert.match(t, /Version 18/);
  app.close();
});

test('the header has Search, Help, Undo and Redo buttons with names for screen readers', () => {
  const app = boot();
  ['hUndo', 'hRedo'].forEach(id => assert.ok(app.q('#' + id).getAttribute('aria-label')));
  assert.ok(app.q('[data-act="gosearch"][aria-label="Search"]')); assert.ok(app.q('[data-act="gohelp"][aria-label="Help"]'));
  assert.equal(app.qa('#tabs button').length, 4, 'the bottom bar is unchanged');
  app.close();
});

test('every tab still draws without errors for a new user and an established one', async () => {
  for (const storage of [{}, saved(sampleUser()), saved(state({ baseline: { start: day(-1), taperDays: 14 } }))]) {
    const app = boot({ storage });
    for (const v of ['today', 'plan', 'progress', 'settings']) {
      await app.click(`#tabs [data-view="${v}"]`);
      assert.ok(app.text().length > 40, v + ' is empty');
      assert.doesNotMatch(app.text(), /undefined|NaN|\[object/, v + ' shows a broken value');
    }
    assert.equal(app.errors.length, 0, String(app.errors[0]));
    app.close();
  }
});
