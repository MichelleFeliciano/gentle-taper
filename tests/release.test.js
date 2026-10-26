'use strict';
// Release checks: the things that are easy to forget when shipping a new version.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { boot, read } = require('./harness');

test('VERSION in app.js matches the cache name in sw.js', () => {
  const app = boot();
  const version = app.run('VERSION');
  const cache = /const CACHE = 'gentle-taper-v(\d+)'/.exec(read('sw.js'));
  assert.ok(cache, 'sw.js has no CACHE = gentle-taper-v<N> line');
  assert.equal(Number(cache[1]), version, 'bump CACHE in sw.js together with VERSION in app.js');
  app.close();
});

test('the newest entry in CHANGES is the current version and has a valid date', () => {
  const app = boot();
  const [v, newest, dates] = [app.run('VERSION'), app.run('CHANGES[0]'), app.run('CHANGES.map(c => c.date)')];
  assert.equal(newest.v, v);
  dates.forEach(d => assert.match(d, /^\d{4}-\d{2}-\d{2}$/));
  assert.deepEqual([...dates], [...dates].sort().reverse(), 'CHANGES must be newest first');
  assert.ok(newest.notes.length > 0);
  app.close();
});

test('CHANGELOG.md says the same as CHANGES in app.js', () => {
  const app = boot();
  const changes = JSON.parse(JSON.stringify(app.run('CHANGES')));
  const md = read('CHANGELOG.md');
  for (const c of changes) {
    const at = md.indexOf(`## ${c.v} — ${c.date}`);
    assert.ok(at >= 0, `CHANGELOG.md is missing the heading "## ${c.v} — ${c.date}"`);
    for (const n of c.notes) assert.ok(md.includes('- ' + n), `CHANGELOG.md is missing the note: ${n}`);
  }
  const headings = [...md.matchAll(/^## (\d+) — /gm)].map(m => Number(m[1]));
  assert.deepEqual(headings, changes.map(c => c.v), 'CHANGELOG.md and CHANGES list different versions');
  app.close();
});

test('every button action in the page has a handler', () => {
  const src = read('app.js') + read('index.html');
  const used = new Set([...src.matchAll(/data-act="([a-z][a-z0-9+-]*)"/g)].map(m => m[1]));
  const handled = new Set([...read('app.js').matchAll(/case '([^']+)'/g)].map(m => m[1]));
  const missing = [...used].filter(a => !handled.has(a));
  assert.deepEqual(missing, [], 'data-act values with no case in the click handler: ' + missing.join(', '));
});

test('every id the script looks up exists in index.html or is drawn by the app', () => {
  const html = read('index.html');
  for (const id of ['app', 'subtitle', 'tabs', 'toast', 'toastMsg', 'toastBtn', 'banner', 'lock', 'hUndo', 'hRedo']) {
    assert.ok(html.includes(`id="${id}"`), `index.html has no element with id="${id}"`);
  }
});

test('the service worker, worker and manifest are valid', () => {
  assert.doesNotThrow(() => new vm.Script(read('sw.js')), 'sw.js has a syntax error');
  assert.doesNotThrow(() => new vm.Script(read('worker/src/index.js').replace(/^export default/m, 'module = ').replace(/^export /gm, '')), 'worker has a syntax error');
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.ok(m.name && m.start_url && m.icons.length);
});

test('every file the service worker caches exists', () => {
  const fs = require('node:fs'), path = require('node:path');
  const assets = vm.runInNewContext(/const ASSETS = (\[[^\]]*\])/.exec(read('sw.js'))[1]);
  for (const a of assets) {
    const p = a === './' ? 'index.html' : a;
    assert.ok(fs.existsSync(path.join(__dirname, '..', p)), `sw.js caches ${a} but it doesn't exist`);
  }
});
