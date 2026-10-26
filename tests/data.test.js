'use strict';
// Export / import: the file format, the merge rules (never overwrite, skip duplicates, say what was skipped) and the "check first" screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, day, entry, state, saved, sampleUser } = require('./harness');

const J = x => JSON.parse(JSON.stringify(x)); // plain copy of a value that came out of the page

test('an export file names the app, its format and version, and carries the data', () => {
  const app = boot({ storage: saved(sampleUser()) });
  const env = J(app.run('exportEnvelope()'));
  assert.equal(env.app, 'gentle-taper');
  assert.equal(env.format, 1);
  assert.equal(env.appVersion, app.run('VERSION'));
  assert.match(env.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(Object.keys(env.data.logs).length, 6);
  app.close();
});

test('readEnvelope accepts new files and older plain backups, and rejects everything else', () => {
  const app = boot();
  const read = o => app.run(`(o => { try { return readEnvelope(o); } catch (e) { return { error: e.message, friendly: !!e.friendly }; } })`)(o);
  assert.equal(read({ app: 'gentle-taper', format: 1, appVersion: 19, data: { logs: {} } }).format, 1);
  assert.equal(read({ v: 3, logs: {} }).format, 0, 'an old backup was just the state itself');
  for (const bad of [null, [], 'text', 5, {}, { logs: 5 }, { app: 'gentle-taper', data: {} }, { app: 'other-app', data: { logs: {} } }]) {
    assert.ok(read(bad).error, 'should reject ' + JSON.stringify(bad));
  }
  const newer = read({ app: 'gentle-taper', format: 99, data: { logs: {} } });
  assert.match(newer.error, /newer version/); assert.ok(newer.friendly);
  app.close();
});

test('merging adds new days and skips days you already have, without changing them', () => {
  const mine = state({ logs: { [day(-1)]: { drinks: { coffee: entry('Coffee', 1, 95) } } }, sym: { [day(-1)]: { headache: 2, done: true, notes: 'mine' } } });
  const theirs = state({
    logs: { [day(-1)]: { drinks: { coffee: entry('Coffee', 5, 95) } }, [day(-2)]: { drinks: { tea: entry('Tea', 2, 47) } } },
    sym: { [day(-1)]: { headache: 0, done: true, notes: 'theirs' }, [day(-2)]: { headache: 1, done: true } },
    water: { [day(-2)]: 3 },
  });
  const app = boot({ storage: saved(mine) });
  const r = J(app.run(`mergeImport(S, ${JSON.stringify(theirs)})`));
  assert.deepEqual(r.add, { days: 1, checkins: 1, water: 1 });
  assert.deepEqual(r.skip, { days: 1, checkins: 1, drinks: 6 }, 'the 6 starter drinks are in both, so they are reported as already there');
  assert.equal(r.state.logs[day(-1)].drinks.coffee.n, 1, 'your day is untouched');
  assert.equal(r.state.sym[day(-1)].notes, 'mine');
  assert.equal(r.state.logs[day(-2)].drinks.tea.n, 2);
  assert.equal(app.run('S.logs["' + day(-2) + '"]'), undefined, 'merging must not change the live state until you confirm');
  app.close();
});

test('importing the same file twice adds nothing the second time', () => {
  const file = sampleUser();
  const app = boot();
  const first = J(app.run(`mergeImport(S, ${JSON.stringify(file)})`));
  assert.equal(first.add.days, 6); assert.equal(first.add.plan, 1);
  const again = J(app.run(`mergeImport(${JSON.stringify(first.state)}, ${JSON.stringify(file)})`));
  assert.deepEqual(again.add, {}, 'nothing new the second time');
  assert.equal(again.skip.days, 6); assert.equal(again.skip.plan, 1);
  app.close();
});

test('drinks are matched by id or by name, type and mg; plans only fill an empty slot', () => {
  const mine = state({ plan: { start: day(-3), targets: [100, 50, 0], pausedAt: null } });
  const theirs = state({
    plan: { start: day(-9), targets: [300, 150, 0], pausedAt: null },
    pastPlans: [{ start: day(-30), targets: [200, 100, 0] }],
    settings: { presets: [
      { id: 'coffee', name: 'Coffee', type: 'Coffee', container: 'Cup', oz: 8, mg: 95, fav: true },
      { id: 'zz', name: 'coffee', type: 'Coffee', container: 'Mug', oz: 12, mg: 95, fav: true },
      { id: 'new1', name: 'Matcha', type: 'Tea', container: 'Cup', oz: 8, mg: 70, fav: false },
    ] },
  });
  const app = boot({ storage: saved(mine) });
  const r = J(app.run(`mergeImport(S, ${JSON.stringify(theirs)})`));
  assert.equal(r.add.drinks, 1); assert.equal(r.skip.drinks, 2);
  assert.ok(r.state.settings.presets.some(p => p.name === 'Matcha'));
  assert.equal(r.skip.plan, 1, 'you already have a plan, so the file’s plan is skipped');
  assert.equal(r.state.plan.targets[0], 100);
  assert.equal(r.add.pastPlans, 1);
  app.close();
});

test('damaged or hand-edited files cannot put bad numbers or dates into the app', () => {
  const theirs = state({
    logs: { 'not-a-date': { drinks: {} }, [day(-1)]: { drinks: { x: { n: 'lots', mg: 40, name: 'X' }, y: { n: 500, mg: -5, name: 'Y' }, z: { n: 2, mg: 'NaN', name: 'Z' } }, lastCaf: '25:99x' } },
    sym: { [day(-1)]: { headache: 99, done: 1, notes: 'x'.repeat(5000) } },
  });
  const app = boot();
  const r = J(app.run(`mergeImport(S, ${JSON.stringify(theirs)})`));
  assert.equal(r.skip.invalid, 1);
  const L = r.state.logs[day(-1)];
  assert.equal(L.drinks.x, undefined, 'a non-numeric count is dropped');
  assert.equal(L.drinks.y.n, 99); assert.equal(L.drinks.y.mg, 0);
  assert.equal(L.drinks.z.mg, 0);
  assert.equal(L.lastCaf, undefined);
  assert.equal(r.state.sym[day(-1)].headache, 3);
  assert.equal(r.state.sym[day(-1)].notes.length, 2000);
  app.close();
});

test('an old file with the legacy can counters is upgraded before it is merged', () => {
  const old = { v: 2, plan: null, logs: { [day(-1)]: { caf: 2, decaf: 1 } }, settings: { canMg: 40 } };
  const app = boot();
  const r = J(app.run(`mergeImport(S, ${JSON.stringify(old)})`));
  const L = r.state.logs[day(-1)];
  assert.equal(L.drinks.can.n, 2); assert.equal(L.drinks.can.mg, 40);
  assert.equal(L.drinks.decaf.n, 1);
  app.close();
});

// A file picked in the page: the app only needs .name and .text() from it.
const pick = (app, obj, name = 'backup.json') => {
  const input = app.q('#importFile');
  Object.defineProperty(input, 'files', { value: [{ name, text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) }], configurable: true });
  input.dispatchEvent(new app.win.Event('change', { bubbles: true }));
  return app.wait(20);
};

test('Import shows a check-first screen and saves nothing until you confirm', async () => {
  const app = boot({ storage: saved(state({ logs: { [day(-1)]: { drinks: { coffee: entry('Coffee', 1, 95) } } } })) });
  await app.click('#tabs [data-view="settings"]');
  const file = { app: 'gentle-taper', format: 1, appVersion: 18, exportedAt: '2026-10-01T10:00:00Z', data: state({ logs: { [day(-1)]: { drinks: { coffee: entry('Coffee', 9, 95) } }, [day(-2)]: { drinks: { tea: entry('Tea', 1, 47) } } } }) };
  const before = app.run('JSON.stringify(S.logs)');
  await pick(app, file);
  const card = app.q('#importcard');
  assert.ok(card, 'the check-first card appears');
  assert.match(card.textContent, /Will add/); assert.match(card.textContent, /1 day of drinks/);
  assert.match(card.textContent, /Will skip/); assert.match(card.textContent, /1 day you already have/);
  assert.match(card.textContent, /nothing is overwritten/i);
  assert.equal(app.run('JSON.stringify(S.logs)'), before, 'nothing saved yet');
  assert.ok(app.q('[data-act="doimport"]'));
  app.close();
});

test('Cancel closes the check-first screen and changes nothing', async () => {
  const app = boot();
  await app.click('#tabs [data-view="settings"]');
  await pick(app, { app: 'gentle-taper', format: 1, data: sampleUser() });
  assert.ok(app.q('#importcard'));
  await app.click('[data-act="cancelimport"]');
  assert.equal(app.q('#importcard'), null);
  assert.equal(app.run('Object.keys(S.logs).length'), 0);
  app.close();
});

test('Import these merges, takes a safety copy first, reports what was added and skipped, and can be undone', async () => {
  const app = boot({ storage: saved(state({ logs: { [day(-1)]: { drinks: { coffee: entry('Coffee', 1, 95) } } } })) });
  await app.click('#tabs [data-view="settings"]');
  await pick(app, { app: 'gentle-taper', format: 1, data: state({ logs: { [day(-1)]: { drinks: {} }, [day(-2)]: { drinks: { tea: entry('Tea', 1, 47) } } } }) });
  await app.click('[data-act="doimport"]');
  assert.equal(app.run('Object.keys(S.logs).length'), 2);
  assert.equal(app.run('S.logs["' + day(-1) + '"].drinks.coffee.n'), 1, 'your own day is kept');
  assert.ok(app.run('readBackups()').some(b => b.label === 'Before import'), 'a safety copy was taken');
  const card = app.q('#importcard').textContent;
  assert.match(card, /Import finished/); assert.match(card, /Added/); assert.match(card, /Skipped/);
  assert.match(app.q('#toast').textContent, /Imported/); assert.ok(!app.q('#toastBtn').hidden, 'the pop-up has an Undo button');
  await app.click('#toastBtn');
  assert.equal(app.run('Object.keys(S.logs).length'), 1, 'Undo removed what the import added');
  app.close();
});

test('a file that is not a backup is refused with a clear message', async () => {
  const app = boot();
  await app.click('#tabs [data-view="settings"]');
  await pick(app, 'this is not json');
  assert.match(app.q('#toastMsg').textContent, /doesn’t look like a Gentle Taper backup/);
  await pick(app, { hello: 'world' });
  assert.match(app.q('#toastMsg').textContent, /doesn’t look like a Gentle Taper backup/);
  await pick(app, { app: 'gentle-taper', format: 7, data: { logs: {} } });
  assert.match(app.q('#toastMsg').textContent, /newer version/);
  assert.equal(app.q('#importcard'), null);
  app.close();
});

test('a file with nothing new says so and offers no import button', async () => {
  const user = sampleUser();
  const app = boot({ storage: saved(user) });
  await app.click('#tabs [data-view="settings"]');
  await pick(app, { app: 'gentle-taper', format: 1, data: user });
  assert.match(app.q('#importcard').textContent, /Nothing new to add/);
  assert.equal(app.q('[data-act="doimport"]'), null);
  app.close();
});

test('the last-backup line and the nudge use the newest of export and cloud backup', () => {
  const app = boot({ storage: { ...saved(sampleUser()), 'gentle-taper-cloud': JSON.stringify({ code: 'X', last: Date.now(), lastDay: day(0) }) } });
  assert.equal(app.run('lastBackupDay()'), day(0));
  app.run(`S.settings.lastExport = "${day(-30)}"`);
  assert.equal(app.run('lastBackupDay()'), day(0), 'the cloud backup is newer than the export');
  app.close();
  const app2 = boot({ storage: saved({ ...sampleUser(), settings: { lastExport: day(-30) } }) });
  assert.equal(app2.run('lastBackupDay()'), day(-30));
  assert.match(app2.text(), /Save a backup\?/, 'a month without a backup triggers the nudge on Today');
  app2.close();
});
