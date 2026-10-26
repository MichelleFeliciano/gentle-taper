'use strict';
// The original behaviour of the app, so new features can't quietly break it: schedules, migration, logging, last-caffeine time, rendering.
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, day, entry, state, saved, sampleUser } = require('./harness');

const PLUS = id => `[data-act="dr+"][data-quick="1"][data-id="${id}"]`;

test('a taper schedule steps down evenly and ends on exactly zero', () => {
  const app = boot();
  const t = [...app.run('gen(200, 5)')];
  assert.deepEqual(t, [200, 150, 100, 50, 0]);
  assert.deepEqual([...app.run('gen(100, 1)')], [0]);
  assert.equal(app.run('gen(240, 28)').at(-1), 0);
  app.close();
});

test('starting a taper from mg builds the plan and shows today’s target', async () => {
  const app = boot();
  await app.type('#stCans', '200', ['input']); await app.type('#stDays', '10', ['input']);
  await app.click('[data-act="start"]');
  assert.equal(app.run('S.plan.targets.length'), 10);
  assert.equal(app.run('S.plan.targets[0]'), 200);
  assert.equal(app.run('ui.view'), 'today');
  assert.match(app.text(), /200/);
  app.close();
});

test('"I’m not sure" starts a 3-day baseline instead of a plan', async () => {
  const app = boot();
  await app.click('[data-act="startunknown"]');
  assert.equal(app.run('S.plan'), null);
  assert.equal(app.run('S.baseline.taperDays'), 28);
  app.close();
});

test('the baseline finishes only after three FINISHED days and builds the plan from their average', () => {
  const logs = {}; [-4, -3, -2].forEach(n => { logs[day(n)] = { drinks: { coffee: entry('Coffee', 2, 100) } }; });
  const app = boot({ storage: saved({ baseline: { start: day(-4), taperDays: 10 }, logs }) });
  assert.equal(app.run('S.baseline'), null);
  assert.equal(app.run('S.plan.targets[0]'), 200);
  assert.equal(app.run('S.plan.fromBaseline'), true);
  app.close();
  const early = boot({ storage: saved({ baseline: { start: day(-1), taperDays: 10 }, logs: { [day(-1)]: { drinks: {} }, [day(0)]: { drinks: {} } } }) });
  assert.ok(early.run('S.baseline'), 'two logged days (one is today) is not enough');
  early.close();
});

test('logging adds drinks to the log at the drink’s amount; editing the drink later never re-prices old entries', async () => {
  const app = boot({ storage: saved({ plan: { start: day(0), targets: [300, 0], pausedAt: null } }) });
  await app.click(PLUS('coffee'));
  assert.equal(app.run('totalMg(today())'), 95);
  app.run('S.settings.presets.find(p => p.id === "coffee").mg = 150');
  await app.click(PLUS('coffee'));
  assert.equal(app.run('totalMg(today())'), 95 + 150);
  assert.equal(Object.keys(app.run('S.logs[today()].drinks')).length, 2, 'one entry per amount');
  app.close();
});

test('last caffeine time is stamped, and rolls back when the drink is removed', async () => {
  const app = boot({ storage: saved({ plan: { start: day(0), targets: [300, 0], pausedAt: null } }) });
  app.run('hhmm = () => "08:00"'); await app.click(PLUS('coffee'));
  app.run('hhmm = () => "13:30"'); await app.click(PLUS('coffee'));
  assert.equal(app.run('S.logs[today()].lastCaf'), '13:30');
  await app.click('.lrow [data-act="dr-"]');
  assert.equal(app.run('S.logs[today()].lastCaf'), '08:00');
  app.close();
});

test('caffeine-free drinks are not stamped as caffeine', async () => {
  const app = boot({ storage: saved({ plan: { start: day(0), targets: [300, 0], pausedAt: null } }) });
  await app.click(PLUS('decaf'));
  assert.equal(app.run('S.logs[today()].lastCaf || null'), null);
  app.close();
});

test('"Logged this day" is read-only apart from the count', async () => {
  const app = boot({ storage: saved(sampleUser()) });
  await app.click('[data-act="prev"]');
  const card = app.qa('#app .card').find(c => c.querySelector('h2') && c.querySelector('h2').textContent === 'Logged this day');
  assert.ok(card);
  assert.equal(card.querySelectorAll('input').length, 0, 'no editable name or mg boxes');
  assert.ok(card.querySelector('.lrow [data-act="dr+"]'));
  app.close();
});

test('data from version 2 (can counters, targets in cans) is upgraded without losing a single mg', () => {
  const old = { v: 2, plan: { start: day(-2), targets: [200, 100, 0], pausedAt: null }, logs: { [day(-1)]: { caf: 3, decaf: 1 } }, settings: { canMg: 40 } };
  const app = boot({ storage: { 'gentle-taper-v1': JSON.stringify(old) } });
  assert.equal(app.run('S.v'), 3);
  assert.equal(app.run('totalMg("' + day(-1) + '")'), 120);
  assert.equal(app.run('S.logs["' + day(-1) + '"].caf'), 0);
  assert.equal(app.errors.length, 0);
  app.close();
});

test('data from version 1 (targets in cans) is converted to mg and starts without a crash', () => {
  const old = { plan: { start: day(-1), targets: [4, 2, 0], pausedAt: null }, logs: {}, settings: { canMg: 40 } };
  const app = boot({ storage: { 'gentle-taper-v1': JSON.stringify(old) } });
  assert.equal(app.errors.length, 0, String(app.errors[0]));
  assert.deepEqual([...app.run('S.plan.targets')], [160, 80, 0]);
  app.close();
});

test('damaged saved data does not stop the app from starting', () => {
  const app = boot({ storage: { 'gentle-taper-v1': '{not json' } });
  assert.equal(app.errors.length, 0);
  assert.match(app.text(), /Start a taper/);
  app.close();
  const odd = boot({ storage: { 'gentle-taper-v1': JSON.stringify({ v: 3, logs: 'x', sym: null, settings: { presets: 'nope' }, trash: 5 }) } });
  assert.equal(odd.errors.length, 0);
  assert.ok(Array.isArray(odd.run('S.trash')) && Array.isArray(odd.run('S.settings.presets')));
  odd.close();
});

test('symptom check-in saves and the day counts as logged', async () => {
  const app = boot({ storage: saved({ plan: { start: day(0), targets: [100, 0], pausedAt: null } }) });
  await app.click('[data-act="sev"][data-k="headache"][data-v="2"]');
  await app.type('#notes', 'tired', ['input']);
  await app.click('[data-act="savecheck"]');
  assert.equal(app.run('S.sym[today()].headache'), 2);
  assert.equal(app.run('S.sym[today()].notes'), 'tired');
  assert.ok(app.run('S.logs[today()]'));
  app.close();
});

test('water tally counts up and down but never below zero', async () => {
  const app = boot({ storage: saved({ plan: { start: day(0), targets: [100, 0], pausedAt: null } }) });
  await app.click('[data-act="wat-"]'); assert.equal(app.run('S.water[today()] || 0'), 0);
  await app.click('[data-act="wat+"]'); await app.click('[data-act="wat+"]');
  assert.equal(app.run('S.water[today()]'), 2);
  assert.equal(app.run('S.logs[today()]'), undefined, 'water never makes a day count as logged');
  app.close();
});

test('pausing then resuming moves the schedule start so no day is skipped', async () => {
  const app = boot({ storage: saved({ plan: { start: day(-3), targets: [300, 200, 100, 50, 0], pausedAt: null } }) });
  await app.click('#tabs [data-view="plan"]');
  await app.click('[data-act="pause"]');
  assert.equal(app.run('S.plan.pausedAt'), day(0));
  await app.click('[data-act="resume"]');
  assert.equal(app.run('S.plan.pausedAt'), null);
  app.close();
});

test('a sweep of every screen in many situations draws without errors or broken values', async () => {
  const situations = {
    new: {}, established: saved(sampleUser()),
    baseline: saved({ baseline: { start: day(-1), taperDays: 14 }, logs: { [day(-1)]: { drinks: { coffee: entry('Coffee', 1, 95) } } } }),
    paused: saved({ ...sampleUser(), plan: { ...sampleUser().plan, pausedAt: day(-1) } }),
    finished: saved({ ...sampleUser(), plan: { start: day(-20), targets: [100, 50, 0], pausedAt: null, completedOn: day(-17) } }),
    over: saved({ plan: { start: day(0), targets: [50, 0], pausedAt: null }, logs: { [day(0)]: { drinks: { coffee: entry('Coffee', 3, 95) } } } }),
    rough: saved({ ...sampleUser(), sym: Object.fromEntries([-1, -2, -3].map(n => [day(n), { headache: 3, fatigue: 3, irritability: 2, nausea: 2, focus: 3, mood: 3, done: true }])) }),
    htmlNames: saved({ ...sampleUser(), settings: { presets: [{ id: 'x', name: '<b>Bold</b> & "quote"', type: '<i>t</i>', container: '<u>c</u>', oz: 8, mg: 10, fav: true }], waterName: '<s>W</s>' } }),
  };
  for (const [name, storage] of Object.entries(situations)) {
    const app = boot({ storage });
    for (const v of ['today', 'plan', 'progress', 'settings']) {
      await app.click(`#tabs [data-view="${v}"]`);
      assert.doesNotMatch(app.text(), /undefined|NaN|\[object|Infinity/, `${name}/${v}`);
    }
    await app.click('[data-act="gosearch"]'); await app.click('[data-act="closeview"]');
    await app.click('[data-act="gohelp"]');
    assert.equal(app.errors.length, 0, `${name}: ${app.errors[0]}`);
    assert.equal(app.qa('#app b').filter(b => b.textContent === 'Bold').length, 0, `${name}: drink names must be escaped, not treated as HTML`);
    app.close();
  }
});
