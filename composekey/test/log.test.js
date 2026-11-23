/*
 * The event log: always on, must not record keys, must not slow keys down, and
 * must survive a worker restart.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Session, sleep} = require('./harness');

const FLUSH = 2300;  // a little more than LOG_FLUSH_MS

let current = null;
process.on('unhandledRejection', (err) => {
  if (current) current.rec.errors.push('unhandled rejection: ' + (err && err.stack || err));
});

async function session(opts) {
  const s = current = new Session(opts);
  // Every answer, not just the last one per request.
  s.replies = new Map();
  const start = s.start.bind(s);
  s.start = () => {
    const worker = start();
    const ime = worker.chrome.input.ime;
    const answer = ime.keyEventHandled;
    ime.keyEventHandled = (id, handled) => {
      s.replies.set(id, (s.replies.get(id) || []).concat(handled));
      answer(id, handled);
    };
    return worker;
  };
  s.start();
  await s.settle();
  s.worker.focus();
  await s.settle();
  return s;
}

function send(s, command) {
  return new Promise((resolve) => {
    for (const fn of s.worker.chrome.runtime.onMessage.listeners) {
      fn({command}, {}, resolve);
    }
  });
}
const getLog = async (s) => (await send(s, 'getLog')).log;

test('the log shows keys, commits and focus changes', async () => {
  const s = await session();
  await s.type('oo');
  s.worker.blur();
  await s.settle();
  const log = await getLog(s);
  assert.match(log, /start/);
  assert.match(log, /ready/);
  assert.match(log, /FOCUS context 42, keys in flight: 0, type text/);
  assert.match(log, /keydown compose +suppressed after \d+ ms/);
  assert.match(log, /keydown char +suppressed after \d+ ms +composing/);
  assert.match(log, /commit text, context 42, confirmed after \d+ ms/);
  assert.match(log, /BLUR context 42/);
  assert.match(log, /not answered: 0/);
  assert.deepEqual(s.rec.errors, []);
});

test('the log does not say which keys were pressed or composed', async () => {
  const dump = async (seq, plain) => {
    const s = await session();
    await s.type(seq);
    for (const c of plain) await s.tap(c);
    await sleep(FLUSH);
    return (await getLog(s)) + s.storage.areas.session.get('eventLog');
  };
  // Remove times; what remains must not depend on the keys.
  const strip = (t) => t.replace(/\d+/g, '#').replace(/ +\+# */g, ' ');
  assert.equal(strip(await dump('oo', 'qjz')), strip(await dump("'e", 'xvk')));
});

test('a focus change with a key in flight, and an abandoned composition', async () => {
  const s = await session({storageLatencyMs: 20});
  await s.compose();
  s.worker.keyEvent('keydown', 'q', 'KeyQ');
  s.worker.blur();
  await s.settle(50);
  const log = await getLog(s);
  assert.match(log, /BLUR context 42, keys in flight: 1/);

  const t = await session();
  await t.compose();
  t.worker.blur();
  await t.settle();
  assert.match(await getLog(t), /BLUR context 42, keys in flight: 0, COMPOSITION ABANDONED/);
});

test('a commit without an input context is visible', async () => {
  const s = await session();
  s.worker.blur();
  await s.settle();
  await s.type('oo');
  assert.match(await getLog(s), /commit NOTHING, context 0, NOT CONFIRMED/);
});

test('the log survives a worker restart, once flushed', async () => {
  const s = await session();
  await s.type('oo');
  await sleep(FLUSH);
  s.start();
  await s.settle();
  await s.tap('x');
  const log = await getLog(s);
  assert.match(log, /worker starts: 2/);
  assert.match(log, /commits: 1, failed: 0/);
  await sleep(FLUSH);
  s.start();
  await s.settle();
  const again = await getLog(s);
  assert.match(again, /worker starts: 3/);
  assert.match(again, /commits: 1, failed: 0/, 'earlier entries are not duplicated');
});

test('typing does not write to storage; pausing writes once', async () => {
  const s = await session();
  s.rec.storageLog.length = 0;
  for (const c of 'thequickbrownfox') await s.tap(c);
  assert.deepEqual(s.rec.storageLog, []);
  await sleep(FLUSH);
  assert.deepEqual(s.rec.storageLog, [{op: 'set', keys: ['eventLog']}]);
  await sleep(FLUSH);
  assert.equal(s.rec.storageLog.length, 1, 'nothing new, nothing written');
});

test('only the newest entries are kept, and clear empties the log', async () => {
  const s = await session();
  for (let i = 0; i < 1500; i++) {
    s.worker.keyEvent('keydown', 'x', 'KeyX');
    s.worker.keyEvent('keyup', 'x', 'KeyX');
  }
  await s.settle();
  const log = await getLog(s);
  assert.match(log, /^2000 events, 2000 key events/);
  await send(s, 'clearLog');
  assert.match(await getLog(s), /^0 events/);
  await s.tap('x');
  assert.match(await getLog(s), /^2 events/);
});

test('every key event is answered exactly once', async () => {
  const s = await session();
  for (const seq of ['oo', "'e", ':-)', ':-', '']) {
    await s.type(seq);
    await s.tap('x');
    await s.tapNamed('Enter');
  }
  await s.holdType('oo');
  for (const [id, r] of s.replies) assert.equal(r.length, 1, `request ${id}: ${r}`);
  assert.deepEqual(s.rec.unanswered(), []);
});
