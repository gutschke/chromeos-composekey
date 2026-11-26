/*
 * The Compose key setting may name more than one key ("AltRight
 * ControlRight", "Right Alt or Right Control" on the options page): either
 * one then works as Compose. Right Control is there for apps where Alt
 * opens a menu.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Session} = require('./harness');

async function withKey(key) {
  const s = new Session();
  s.storage.areas.sync.set('key', key);
  s.start();
  await s.settle();
  s.worker.focus();
  await s.settle();
  return s;
}

async function tapThen(s, code, seq) {
  await s.compose(code);
  for (const ch of seq) await s.tap(ch, {shift: ch == '"'});
}

const texts = (s) => s.rec.commits.map((c) => c.text);

for (const code of ['AltRight', 'ControlRight']) {
  test(`with both keys set, ${code} composes`, async () => {
    const s = await withKey('AltRight ControlRight');
    await tapThen(s, code, '"a');
    assert.deepEqual(texts(s), ['ä']);
  });
}

test('with only Right Alt set, Right Control does not compose', async () => {
  const s = await withKey('AltRight');
  await tapThen(s, 'ControlRight', '"a');
  assert.deepEqual(texts(s), []);
});

test('with both keys set, Right Control can be held, with auto-repeat',
    async () => {
  const s = await withKey('AltRight ControlRight');
  const down = () => s.worker.keyEvent(
      'keydown', 'Control', 'ControlRight', {ctrl: true});
  down(); await s.settle(5);
  down(); await s.settle(5);
  await s.tap('"', {shift: true, ctrl: true});
  down(); await s.settle(5);
  await s.tap('a', {ctrl: true});
  s.worker.keyEvent('keyup', 'Control', 'ControlRight', {});
  await s.settle(5);
  assert.deepEqual(texts(s), ['ä']);
});
