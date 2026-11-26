/*
 * Ambiguous sequences: one that is complete AND the prefix of a longer one,
 * e.g. ":-" (÷) and ":-)" (🙂). The rules:
 *  - a key that continues the longer sequence keeps composing;
 *  - releasing a held Compose key, or pressing Compose again, commits the
 *    pending result;
 *  - any other printable key commits pending + that character in ONE
 *    commitText (separate commit + pass-through could arrive out of order);
 *  - a non-printable key commits pending, then passes through;
 *  - Escape cancels;
 *  - non-ambiguous sequences still commit immediately;
 *  - a pending sequence survives a worker restart.
 * Uses its own compose file so the tests do not depend on the built-in table.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Session} = require('./harness');

const FILE = [
  '<Multi_key> <colon> <minus> : "÷"',
  '<Multi_key> <colon> <minus> <parenright> : "\u{1F642}"',
  '<Multi_key> <o> <o> : "°"',
  '<Multi_key> <exclam> <exclam> : "¡"',
  // Extension more than one key past the ambiguous point ("|B" is ฿).
  '<Multi_key> <bar> <B> : "฿"',
  '<Multi_key> <bar> <B> <D> <M> : "⛂"',
  '',
].join('\n');

let current = null;
process.on('unhandledRejection', (err) => {
  if (current) current.rec.errors.push('unhandled rejection: ' + (err && err.stack || err));
});

async function session() {
  current = new Session();
  current.setComposeFile(FILE);
  current.start();
  await current.settle();
  current.worker.focus();
  await current.settle();
  return current;
}

const texts = (s) => s.rec.commits.map((c) => c.text);
function clean(s) {
  assert.deepEqual(s.rec.errors, [], 'no errors');
  assert.deepEqual(s.rec.unanswered(), [], 'every key event answered');
}
/** Was the most recent keydown of `key` passed through to the app? */
function passedThrough(s, key) {
  return s.rec.handled.get(s.rec.lastKeydown[key]) === false;
}

test('tap: continuing key completes the longer sequence', async () => {
  const s = await session();
  await s.type(':-)');
  clean(s);
  assert.deepEqual(texts(s), ['\u{1F642}']);
});

test('tap: pending result waits, nothing committed yet', async () => {
  const s = await session();
  await s.type(':-');
  clean(s);
  assert.deepEqual(texts(s), []);
});

test('tap: other printable key commits pending + key together', async () => {
  const s = await session();
  await s.type(':-');
  await s.tap('x');
  clean(s);
  assert.deepEqual(texts(s), ['÷x']);
  assert.equal(passedThrough(s, 'x'), false, 'x consumed, not typed twice');
});

test('tap: Compose again commits pending', async () => {
  const s = await session();
  await s.type(':-');
  await s.compose();
  clean(s);
  assert.deepEqual(texts(s), ['÷']);
});

test('tap: Escape cancels pending', async () => {
  const s = await session();
  await s.type(':-');
  await s.tapNamed('Escape');
  clean(s);
  assert.deepEqual(texts(s), []);
});

test('tap: "Esc" (ChromeOS\'s name for it) cancels pending too', async () => {
  const s = await session();
  await s.type(':-');
  await s.tap('Esc', {code: 'Escape'});
  clean(s);
  assert.deepEqual(texts(s), []);
});

test('tap: Enter commits pending, then passes through', async () => {
  // ÷ is on screen while it waits, so Enter after it means Enter.
  const s = await session();
  await s.type(':-');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['÷']);
  assert.equal(passedThrough(s, 'Enter'), true);
});

test('hold: releasing Compose commits pending', async () => {
  const s = await session();
  await s.holdType(':-');
  clean(s);
  assert.deepEqual(texts(s), ['÷']);
});

test('hold: longer sequence completes while held, release adds nothing', async () => {
  const s = await session();
  await s.holdType(':-)');
  clean(s);
  assert.deepEqual(texts(s), ['\u{1F642}']);
});

test('hold: non-ambiguous sequence commits before release', async () => {
  const s = await session();
  await s.holdType('!!', {release: false});
  assert.deepEqual(texts(s), ['¡']);
  await s.releaseCompose();
  clean(s);
  assert.deepEqual(texts(s), ['¡']);
});

test('tap: non-ambiguous sequence still commits immediately', async () => {
  const s = await session();
  await s.type('!!');
  clean(s);
  assert.deepEqual(texts(s), ['¡']);
});

test('two keys past the ambiguous point: longer sequence completes', async () => {
  const s = await session();
  await s.type('|BDM');
  clean(s);
  assert.deepEqual(texts(s), ['⛂']);
});

test('two keys past the ambiguous point, then a mismatch: ฿ + typed keys', async () => {
  // Used to lose both ฿ and D: the held result was forgotten once the
  // sequence moved past the ambiguous point.
  const s = await session();
  await s.type('|BD');
  await s.tap('x');
  clean(s);
  assert.deepEqual(texts(s), ['฿Dx']);
});

test('two keys past the ambiguous point, then Compose: ฿ + typed key', async () => {
  const s = await session();
  await s.type('|BD');
  await s.compose();
  clean(s);
  assert.deepEqual(texts(s), ['฿D']);
});

test('two keys past the ambiguous point, then release in hold mode', async () => {
  const s = await session();
  await s.holdType('|BD');
  clean(s);
  assert.deepEqual(texts(s), ['฿D']);
});

test('two keys past the ambiguous point, then Enter: ฿D, Enter passes', async () => {
  const s = await session();
  await s.type('|BD');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['฿D']);
  assert.equal(passedThrough(s, 'Enter'), true);
});

test('two keys past the ambiguous point survives a restart', async () => {
  const s = await session();
  await s.type('|BD');
  s.start();
  await s.settle();
  await s.tap('x');
  clean(s);
  assert.deepEqual(texts(s), ['฿Dx']);
});

test('pending sequence survives a worker restart', async () => {
  const s = await session();
  await s.type(':-');
  s.start();
  await s.settle();
  await s.tap(')', {shift: true});
  clean(s);
  assert.deepEqual(texts(s), ['\u{1F642}']);
});

test('both sequences load without suppression warnings', async () => {
  const s = await session();
  const vm = require('vm');
  const status = vm.runInContext('fileStatus', s.worker.context);
  // (Arrays from the VM context have a foreign prototype: compare contents.)
  assert.equal(status.errors.length, 0, JSON.stringify(status.errors));
  assert.ok(status.warnings.length > 0, 'the extension is reported');
  for (const w of status.warnings) {
    assert.doesNotMatch(w.message, /Suppressed/, 'shorter sequence must be kept');
  }
});
