'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./harness');

test('the app starts and draws the Plan tab for a new user', () => {
  const app = boot();
  assert.equal(app.errors.length, 0, String(app.errors[0]));
  assert.match(app.text(), /Start a taper/);
  app.close();
});
