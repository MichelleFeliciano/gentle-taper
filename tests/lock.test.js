'use strict';
// App lock: set-up rules, what is stored, unlocking, wrong-guess slowdown, auto-lock and the "forgot it" reset.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, day, saved, sampleUser } = require('./harness');

// Turns the lock on through the real Settings form.
async function turnOn(app, kind, secret, again = secret) {
  await app.click('#tabs [data-view="settings"]');
  if (kind === 'password') await app.click('[data-act="lockkind"][data-v="password"]');
  await app.type('#lkNew', secret, ['input']); await app.type('#lkNew2', again, ['input']);
  await app.click('[data-act="lockon"]');
  await app.wait(400); // hashing takes a moment
}
const tryUnlock = async (app, secret) => {
  await app.type('#lockIn', secret, ['input']);
  app.q('#lockForm').dispatchEvent(new app.win.Event('submit', { bubbles: true, cancelable: true }));
  await app.wait(500);
};

test('setting a PIN stores only a salted hash, never the PIN', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  await turnOn(app, 'pin', '482913');
  const raw = app.win.localStorage.getItem('gentle-taper-lock');
  assert.ok(raw, 'the lock is saved');
  assert.ok(!raw.includes('482913'));
  const l = JSON.parse(raw);
  assert.equal(l.kind, 'pin'); assert.ok(l.salt.length > 10 && l.hash.length > 20);
  assert.ok(!app.win.localStorage.getItem('gentle-taper-v1').includes('482913'), 'and it is not in the app data or any export');
  assert.match(app.q('#set-lock').textContent, /On/);
  app.close();
});

test('the set-up form rejects weak or mismatched entries', async () => {
  const app = boot();
  await turnOn(app, 'pin', '12');
  assert.match(app.q('#toastMsg').textContent, /4 to 8 digits/);
  await turnOn(app, 'pin', '1234a');
  assert.match(app.q('#toastMsg').textContent, /4 to 8 digits/);
  await turnOn(app, 'pin', '123456', '123457');
  assert.match(app.q('#toastMsg').textContent, /don’t match/);
  await turnOn(app, 'password', 'short');
  assert.match(app.q('#toastMsg').textContent, /at least 6/);
  assert.equal(app.win.localStorage.getItem('gentle-taper-lock'), null, 'nothing was set');
  app.close();
});

test('with a lock set, the app starts locked and shows nothing of the data', async () => {
  const first = boot({ storage: saved(sampleUser()) });
  await turnOn(first, 'pin', '482913');
  const keep = { 'gentle-taper-v1': first.win.localStorage.getItem('gentle-taper-v1'), 'gentle-taper-lock': first.win.localStorage.getItem('gentle-taper-lock') };
  first.close();
  const app = boot({ storage: keep });
  assert.equal(app.doc.getElementById('lock').hidden, false);
  assert.ok(app.doc.body.classList.contains('locked'));
  assert.equal(app.q('#app').innerHTML, '', 'nothing from the app is drawn behind the lock');
  assert.match(app.q('#lock').textContent, /locked/);
  await tryUnlock(app, '000000');
  assert.match(app.q('#lockMsg').textContent, /not it/);
  assert.equal(app.q('#app').innerHTML, '');
  await tryUnlock(app, '482913');
  assert.equal(app.doc.getElementById('lock').hidden, true);
  assert.ok(!app.doc.body.classList.contains('locked'));
  assert.match(app.text(), /Day \d|target|Drinks/);
  app.close();
});

test('five wrong tries in a row make you wait, even for the right PIN', async () => {
  const first = boot();
  await turnOn(first, 'pin', '482913');
  const keep = { 'gentle-taper-lock': first.win.localStorage.getItem('gentle-taper-lock') };
  first.close();
  const app = boot({ storage: keep });
  for (let i = 0; i < 5; i++) await tryUnlock(app, '111111');
  assert.match(app.q('#lockMsg').textContent, /Too many tries/);
  await tryUnlock(app, '482913');
  assert.match(app.q('#lockMsg').textContent, /Too many tries/);
  assert.equal(app.doc.getElementById('lock').hidden, false, 'still locked during the wait');
  app.close();
});

test('a password lock works with letters, and "Lock now" locks at once', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  await turnOn(app, 'password', 'sage-and-lavender');
  await app.click('[data-act="locknow"]');
  assert.ok(app.doc.body.classList.contains('locked'));
  await tryUnlock(app, 'Sage-and-lavender');
  assert.match(app.q('#lockMsg').textContent, /not it/, 'passwords are case-sensitive');
  await tryUnlock(app, 'sage-and-lavender');
  assert.ok(!app.doc.body.classList.contains('locked'));
  app.close();
});

test('changing and turning off the lock both need the current PIN', async () => {
  const app = boot();
  await turnOn(app, 'pin', '482913');
  await app.type('#lkCur', '000000', ['input']);
  await app.click('[data-act="lockoff"]');
  await app.wait(400);
  assert.match(app.q('#toastMsg').textContent, /isn’t right/);
  assert.ok(app.win.localStorage.getItem('gentle-taper-lock'));
  await app.type('#lkCur', '482913', ['input']); await app.type('#lkNew', '135790', ['input']); await app.type('#lkNew2', '135790', ['input']);
  await app.click('[data-act="lockchange"]'); await app.wait(400);
  assert.match(app.q('#toastMsg').textContent, /Lock changed/);
  await app.type('#lkCur', '135790', ['input']);
  await app.click('[data-act="lockoff"]'); await app.wait(400);
  assert.equal(app.win.localStorage.getItem('gentle-taper-lock'), null);
  app.close();
});

test('the lock comes back after the chosen time away, or every time', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  await turnOn(app, 'pin', '482913');
  await app.click('[data-act="lockafter"][data-v="5"]');
  app.run('lockOnReturn(true)');
  assert.ok(!app.doc.body.classList.contains('locked'), 'leaving does not lock when the time is 5 minutes');
  app.run('hiddenAt = Date.now() - 2 * 60000; lockOnReturn(false)');
  assert.ok(!app.doc.body.classList.contains('locked'), 'back after 2 minutes: still open');
  app.run('hiddenAt = Date.now() - 6 * 60000; lockOnReturn(false)');
  assert.ok(app.doc.body.classList.contains('locked'), 'back after 6 minutes: locked');
  await tryUnlock(app, '482913');
  await app.click('#tabs [data-view="settings"]');
  await app.click('[data-act="lockafter"][data-v="0"]');
  app.run('lockOnReturn(true)');
  assert.ok(app.doc.body.classList.contains('locked'), 'every time: locks as soon as it leaves the screen');
  app.close();
});

test('"Forgot it" erases everything this phone stores, including the lock, so there is no way around it', async () => {
  const app = boot({ storage: { ...saved(sampleUser()), 'gentle-taper-cloud': '{"code":"X"}', 'gentle-taper-backups': '[]', 'gentle-taper-history': '[]' } });
  await turnOn(app, 'pin', '482913');
  assert.ok(app.win.localStorage.length >= 4);
  app.run('eraseLocalData()');
  assert.equal(app.win.localStorage.length, 0, 'nothing is left: no data, no copies, no recovery code, no lock');
  app.close();
});

test('the lock screen offers the reset only behind "Forgot it?" and asks before erasing', async () => {
  const first = boot();
  await turnOn(first, 'pin', '482913');
  const keep = { 'gentle-taper-lock': first.win.localStorage.getItem('gentle-taper-lock'), 'gentle-taper-v1': '{"v":3}' };
  first.close();
  const app = boot({ storage: keep, confirm: false });
  assert.ok(app.q('#lock details [data-act="lockreset"]'));
  await app.click('[data-act="lockreset"]');
  assert.ok(app.win.localStorage.getItem('gentle-taper-lock'), 'declining the question erases nothing');
  app.close();
});

test('the lock screen has labelled controls', async () => {
  const first = boot();
  await turnOn(first, 'pin', '482913');
  const keep = { 'gentle-taper-lock': first.win.localStorage.getItem('gentle-taper-lock') };
  first.close();
  const app = boot({ storage: keep });
  assert.ok(app.q('label[for="lockIn"]'));
  assert.equal(app.q('#lockIn').getAttribute('inputmode'), 'numeric');
  assert.equal(app.q('#lockMsg').getAttribute('role'), 'alert');
  app.close();
});
