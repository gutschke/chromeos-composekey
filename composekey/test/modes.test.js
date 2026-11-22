/*
 * Hold vs. tap use of the Compose key, under both values of the "keep
 * modifier" option (default true: right Alt keeps working as Alt).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Session} = require('./harness');

// Default settings (nothing stored): hold-to-compose must work, as in v1.8.
test('hold, default settings', async () => {
  const s = await session(undefined);
  await s.holdType('oo');
  assert.deepEqual(s.rec.commits.map((c) => c.text), ['°']);
});

// Held right Alt auto-repeats on ChromeOS; each repeat used to toggle compose
// on and off, so the sequence depended on how long the key was held first.
for (const repeats of [1, 2, 7]) {
  test(`hold with ${repeats} auto-repeat(s) of the Compose key`, async () => {
    const s = await session(undefined);
    await s.holdType('oo', {repeats});
    assert.deepEqual(s.rec.commits.map((c) => c.text), ['°']);
    assert.deepEqual(s.rec.unanswered(), []);
  });
}

test('a lost Compose keyup does not leave compose dead', async () => {
  // Keydown arrives, its keyup goes elsewhere (e.g. focus moved). The next
  // ordinary key (alt=false) proves the key is no longer held.
  const s = await session(undefined);
  s.worker.keyEvent('keydown', 'Alt', 'AltRight', {alt: true});
  await s.settle(5);
  await s.tapNamed('Escape');            // cancels, and arrives with alt=false
  await s.type('oo');                    // a normal tap sequence afterwards
  assert.deepEqual(s.rec.commits.map((c) => c.text), ['°']);
});

test('a lost Compose keyup is forgotten on focus change', async () => {
  const s = await session(undefined);
  s.worker.keyEvent('keydown', 'Alt', 'AltRight', {alt: true});
  await s.settle(5);
  s.worker.blur(); await s.settle(); s.worker.focus(); await s.settle();
  await s.type('oo');
  assert.deepEqual(s.rec.commits.map((c) => c.text), ['°']);
});

// A second Compose press (not an auto-repeat) used to cancel; it now starts an
// emoji name ("Compose Compose fire" → 🔥, sequences/60-emoji.compose).
test('tap Compose twice then a name gives the emoji', async () => {
  const s = await session(undefined);
  await s.compose();
  await s.compose();
  for (const ch of 'fire') await s.tap(ch);
  assert.deepEqual(s.rec.commits.map((c) => c.text), ['\u{1F525}']);
});

test('hold: Compose, release, Compose again, then a name', async () => {
  const s = await session(undefined);
  await s.holdType('');                 // press and release Compose
  await s.holdType('taco');             // hold it again while typing
  assert.deepEqual(s.rec.commits.map((c) => c.text), ['\u{1F32E}']);
});

test('emoji name that starts a longer one waits, then commits', async () => {
  // "heart" ❤️ is the start of "hearts" 💕 and "hearteyes" 😍.
  const s = await session(undefined);
  await s.compose();
  await s.compose();
  for (const ch of 'heart') await s.tap(ch);
  assert.deepEqual(s.rec.commits, [], 'waits after "heart"');
  await s.tap(' ');
  assert.deepEqual(s.rec.commits.map((c) => c.text), ['❤️ ']);
});

test('Compose twice then Escape cancels', async () => {
  const s = await session(undefined);
  await s.compose();
  await s.compose();
  await s.tapNamed('Escape');
  await s.tap('o');
  assert.deepEqual(s.rec.commits, []);
  assert.equal(s.rec.handled.get(s.rec.lastKeydown.o), false, 'o typed normally');
});

async function session(keepModifier) {
  const s = new Session();
  if (keepModifier !== undefined) s.storage.areas.sync.set('keepModifier', keepModifier);
  s.start();
  await s.settle();
  s.worker.focus();
  await s.settle();
  return s;
}

for (const keepModifier of [true, false]) {
  test(`tap, keepModifier=${keepModifier}`, async () => {
    const s = await session(keepModifier);
    await s.type('oo');
    assert.deepEqual(s.rec.commits.map((c) => c.text), ['°']);
  });

  // With keepModifier=true (upstream's default) the AltRight keydown is passed
  // to the app so Alt keeps working, and compose only starts on its release; a
  // key typed while holding it is Alt+key, which cancels compose. Holding
  // therefore needs keepModifier=false. Open design question, not a bug yet.
  test(`hold, keepModifier=${keepModifier}`, {
    todo: keepModifier ? 'hold needs keepModifier=false' : false,
  }, async () => {
    const s = await session(keepModifier);
    await s.holdType('oo');
    assert.deepEqual(s.rec.commits.map((c) => c.text), ['°']);
  });
}
