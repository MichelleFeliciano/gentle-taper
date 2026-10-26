'use strict';
// Mistakes and safety: Undo / Redo, History, the Undo pop-up after deletes, Recently deleted, and confirmations.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, day, entry, saved, sampleUser, state } = require('./harness');

const PLUS = id => `[data-act="dr+"][data-quick="1"][data-id="${id}"]`;
const total = app => app.run('totalMg(today())');
// A user with a plan, who has not logged anything today.
const plain = () => saved({ plan: { start: day(0), targets: [200, 100, 0], pausedAt: null } });

test('Undo and Redo reverse and repeat a logged drink; one tap is one step', async () => {
  const app = boot({ storage: plain() });
  assert.equal(app.q('#hUndo').disabled, true, 'nothing to undo at first');
  await app.click(PLUS('coffee'));
  assert.equal(total(app), 95);
  assert.equal(app.run('undoStack.length'), 1, 'logging touches several fields but is ONE undo step');
  assert.equal(app.q('#hUndo').disabled, false);
  assert.match(app.q('#hUndo').title, /Logged Coffee/);
  await app.click('#hUndo');
  assert.equal(total(app), 0);
  assert.equal(app.run('S.logs[today()]'), undefined, 'the day is back to not logged');
  assert.equal(app.q('#hRedo').disabled, false);
  await app.click('#hRedo');
  assert.equal(total(app), 95);
  assert.equal(app.q('#hRedo').disabled, true);
  app.close();
});

test('a new change clears the Redo list', async () => {
  const app = boot({ storage: plain() });
  await app.click(PLUS('coffee')); await app.click('#hUndo');
  assert.equal(app.run('redoStack.length'), 1);
  await app.click(PLUS('tea'));
  assert.equal(app.run('redoStack.length'), 0);
  app.close();
});

test('moving between days and background saves are not recorded as changes', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  await app.click('[data-act="prev"]'); await app.click('[data-act="next"]');
  await app.click('#tabs [data-view="progress"]');
  assert.equal(app.run('undoStack.length'), 0);
  assert.equal(app.run('journal().length'), 0);
  app.close();
});

test('History lists changes with labels, and "Undo back to here" rewinds several steps', async () => {
  const app = boot({ storage: plain() });
  await app.click(PLUS('coffee')); await app.click(PLUS('tea')); await app.click('[data-act="wat+"]');
  assert.deepEqual([...app.run('journal().map(j => j.label)')], ['Logged Coffee', 'Logged Tea', 'Added water']);
  await app.click('#tabs [data-view="settings"]');
  const rows = app.qa('#set-history .lrow');
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /Added water/, 'newest first');
  assert.equal(total(app), 142);
  await app.click('#set-history [data-act="undoto"][data-id="' + app.run('undoStack[1].id') + '"]');
  assert.equal(total(app), 95, 'went back to just before Tea');
  assert.equal(app.run('S.water[today()]'), undefined);
  assert.equal(app.run('redoStack.length'), 2);
  app.close();
});

test('the history journal survives a restart but holds only labels, never data', async () => {
  const app = boot({ storage: plain() });
  await app.click(PLUS('coffee'));
  const keep = { 'gentle-taper-v1': app.win.localStorage.getItem('gentle-taper-v1'), 'gentle-taper-history': app.win.localStorage.getItem('gentle-taper-history') };
  assert.ok(!/"mg"|"drinks"/.test(keep['gentle-taper-history']));
  app.close();
  const again = boot({ storage: keep });
  assert.equal(again.run('journal().length'), 1);
  await again.click('#tabs [data-view="settings"]');
  assert.match(again.q('#set-history').textContent, /Logged Coffee/);
  assert.equal(again.qa('#set-history [data-act="undoto"]').length, 0, 'old-visit changes cannot be rewound, only listed');
  again.close();
});

test('counting a drink down to zero offers Undo and keeps it in Recently deleted', async () => {
  const app = boot({ storage: plain() });
  await app.click(PLUS('coffee'));
  await app.click('.lrow [data-act="dr-"]');
  assert.equal(total(app), 0);
  assert.equal(app.run('S.trash.length'), 1);
  assert.equal(app.run('S.trash[0].kind'), 'entry');
  assert.match(app.q('#toastMsg').textContent, /Removed Coffee/);
  assert.equal(app.q('#toastBtn').hidden, false); assert.equal(app.q('#toastBtn').textContent, 'Undo');
  await app.click('#toastBtn');
  assert.equal(total(app), 95, 'Undo brought it back');
  assert.equal(app.run('S.trash.length'), 0, 'and it left the bin with it');
  app.close();
});

test('the Undo pop-up refuses to undo something other than the delete it belongs to', async () => {
  const app = boot({ storage: plain() });
  await app.click(PLUS('coffee')); await app.click('.lrow [data-act="dr-"]');
  const stale = app.run('toastAct');          // the Undo button of the delete...
  await app.click(PLUS('tea'));               // ...but the user has since logged something else
  stale.fn();
  assert.equal(total(app), 47, 'the tea is still there and the coffee stays removed');
  assert.match(app.q('#toastMsg').textContent, /see History/);
  app.close();
});

test('clearing a day asks first, is undoable, and the drinks wait in Recently deleted', async () => {
  const app = boot({ storage: plain() });
  await app.click(PLUS('coffee')); await app.click(PLUS('tea'));
  app.win.confirm = () => false;
  await app.click('[data-act="delday"]');
  assert.equal(total(app), 142, 'declining the question deletes nothing');
  assert.equal(app.run('S.trash.length'), 0);
  app.win.confirm = () => true;
  await app.click('[data-act="delday"]');
  assert.equal(total(app), 0);
  assert.equal(app.run('S.trash[0].kind'), 'day');
  await app.click('#toastBtn');
  assert.equal(total(app), 142);
  app.close();
});

test('Recently deleted restores a cleared day, a removed drink entry and a deleted drink', async () => {
  const app = boot({ storage: plain() });
  await app.click(PLUS('coffee')); await app.click(PLUS('coffee'));
  await app.click('[data-act="delday"]');
  assert.equal(total(app), 0);
  await app.click('#tabs [data-view="settings"]');
  assert.match(app.q('#set-trash').textContent, /Drinks on/);
  await app.click('#set-trash [data-act="restoretrash"]');
  assert.equal(total(app), 190);
  assert.equal(app.run('S.trash.length'), 0);
  // delete the "tea" drink and restore it to its old place in the list
  const before = [...app.run('S.settings.presets.map(p => p.id)')];
  await app.click('#tabs [data-view="settings"]');
  await app.click('#set-drinks [data-act="delpreset"][data-id="tea"]');
  assert.ok(!app.run('S.settings.presets.some(p => p.id === "tea")'));
  await app.click('#set-trash [data-act="restoretrash"]');
  assert.deepEqual([...app.run('S.settings.presets.map(p => p.id)')], before, 'back in the same position');
  app.close();
});

test('restoring a day merges into whatever is there now instead of replacing it', () => {
  const app = boot({ storage: plain() });
  app.run(`S.logs[today()] = { caf: 0, decaf: 0, drinks: { coffee: { n: 1, mg: 95, name: 'Coffee', type: 'Coffee', container: 'Cup' } } }`);
  app.run(`mergeLogInto(today(), { drinks: { coffee: { n: 2, mg: 95, name: 'Coffee' }, tea: { n: 1, mg: 47, name: 'Tea' } } })`);
  assert.equal(app.run('S.logs[today()].drinks.coffee.n'), 3);
  assert.equal(app.run('S.logs[today()].drinks.tea.n'), 1);
  app.run(`mergeLogInto(today(), { drinks: { coffee: { n: 1, mg: 120, name: 'Coffee' } } })`);
  assert.equal(app.run('S.logs[today()].drinks.coffee.n'), 3, 'a different amount never re-prices the existing entry');
  assert.equal(app.run('S.logs[today()].drinks["coffee~120"].n'), 1);
  app.close();
});

test('items older than 30 days leave Recently deleted on their own', () => {
  const app = boot({ storage: saved({ trash: [{ id: 'a', kind: 'day', label: 'old', t: Date.now() - 31 * 864e5, date: day(-40), data: { drinks: {} } }, { id: 'b', kind: 'day', label: 'new', t: Date.now() - 2 * 864e5, date: day(-3), data: { drinks: {} } }] }) });
  assert.deepEqual([...app.run('S.trash.map(x => x.label)')], ['new']);
  app.close();
});

test('Erase everything asks first, takes a safety copy, and can be undone', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  await app.click('#tabs [data-view="settings"]');
  app.win.confirm = () => false;
  await app.click('[data-act="wipe"]');
  assert.equal(app.run('Object.keys(S.logs).length'), 6);
  app.win.confirm = () => true;
  await app.click('[data-act="wipe"]');
  assert.equal(app.run('Object.keys(S.logs).length'), 0);
  assert.ok(app.run('readBackups()').some(b => b.label === 'Before erase'));
  await app.click('#toastBtn');
  assert.equal(app.run('Object.keys(S.logs).length'), 6);
  app.close();
});

test('Undo of an erase restores the drink list too (the whole state, not just logs)', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  app.run(`S.settings.presets.push({ id: 'mine', name: 'My brew', type: 'Coffee', container: 'Mug', oz: 12, mg: 150, fav: true }); save();`);
  await app.click('#tabs [data-view="settings"]');
  await app.click('[data-act="wipe"]');
  assert.ok(!app.run('S.settings.presets.some(p => p.id === "mine")'));
  await app.click('#hUndo');
  assert.ok(app.run('S.settings.presets.some(p => p.id === "mine")'));
  app.close();
});

test('editing a drink in the editor is recorded and undoable', async () => {
  const app = boot({ storage: saved(state({})) });
  await app.click('#tabs [data-view="settings"]');
  await app.type('#set-drinks [data-pid="coffee"][data-f="mg"]', '120', ['change']);
  assert.equal(app.run('S.settings.presets.find(p => p.id === "coffee").mg'), 120);
  assert.equal(app.run('journal().pop().label'), 'Edited a drink');
  await app.click('#hUndo');
  assert.equal(app.run('S.settings.presets.find(p => p.id === "coffee").mg'), 95);
  app.close();
});
