/*
 * Service-worker lifecycle tests. Run with:  node --test test/
 *
 * Each scenario is a way the extension has been seen (or suspected) to stop
 * composing silently. The baseline test exists to prove the harness can see a
 * success at all: without it, a failing restart test could just mean the
 * harness is broken.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Session} = require('./harness');

let current = null;
process.on('unhandledRejection', (err) => {
  if (current) current.rec.errors.push('unhandled rejection: ' + (err && err.stack || err));
});

async function freshSession(opts) {
  current = new Session(opts);
  current.start();
  await current.settle();
  return current;
}

/** Simulates a worker that has run before in this browser session. */
async function warmSession(opts) {
  const s = await freshSession(opts);
  s.worker.focus();
  await s.settle();
  return s;
}

function assertComposed(s, expected, contextID = 42) {
  assert.deepEqual(s.rec.errors, [], 'no errors');
  assert.deepEqual(s.rec.unanswered(), [], 'every key event answered');
  assert.deepEqual(s.rec.commits.map((c) => c.text), [expected], 'committed text');
  assert.equal(s.rec.commits[0].contextID, contextID, 'committed to focused field');
}

test('baseline: compose o o gives a degree sign', async () => {
  const s = await warmSession();
  await s.type('"a');
  assertComposed(s, 'ä');
});

test('worker restarted while a field stays focused', async () => {
  // Chrome kills the idle worker; the user keeps typing in the same field, so
  // no new onFocus arrives. The next key event wakes a fresh worker.
  const s = await warmSession();
  s.start();
  await s.type('"a');
  assertComposed(s, 'ä');
});

// Used to fail: every worker start re-ran setComposeFile(), whose resetState()
// abandoned a composition in progress.
test('worker restarted between compose key and sequence', async () => {
  const s = await warmSession();
  await s.compose();
  s.start();
  for (const ch of '"a') await s.tap(ch, {shift: ch === '"'});
  assertComposed(s, 'ä');
});

test('worker cold-started by focusing a field', async () => {
  // Worker is dead; focusing a text field wakes it. onFocus runs right after
  // the script's top-level code, before any storage read has completed.
  const s = await warmSession();
  s.worker.blur();
  await s.settle();
  s.start();
  s.worker.focus(43);
  await s.settle();
  await s.type('"a');
  assertComposed(s, 'ä', 43);
});

test('first ever start, focused immediately', async () => {
  current = new Session();
  current.start();
  current.worker.focus();
  await current.settle();
  await current.type('"a');
  assertComposed(current, 'ä');
});

// Chrome does not order completions across storage areas, so the cold-start
// race has to hold up whichever area answers first.
for (const [name, lat] of [
  ['session fast, sync slow', {sync: 8, local: 8, session: 1}],
  ['session slow, sync fast', {sync: 1, local: 1, session: 8}],
]) {
  test(`cold start via focus, ${name}`, async () => {
    const s = await warmSession({storageLatencyMs: lat});
    s.worker.blur();
    await s.settle();
    s.start();
    s.worker.focus(43);
    await s.settle();
    await s.type('"a');
    assertComposed(s, 'ä', 43);
  });
}

test('large custom compose file kept in local storage survives a restart', async () => {
  // Files too big for sync storage live in local storage only. The old
  // start-up path re-read sync, found nothing, and replaced the custom file
  // with the default.
  current = new Session();
  current.storage.areas.local.set(
      'composeFile', 'include "%L"\n<Multi_key> <x> <x> : "✗"\n');
  current.start();
  await current.settle();
  current.worker.focus();
  await current.settle();
  current.start();  // a later worker start must still use the local file
  await current.settle();
  await current.type('xx');
  assertComposed(current, '✗');
  assert.equal(current.storage.areas.sync.has('composeFile'), false,
               'start-up must not write the compose file to sync');
});

test('session storage holds tree paths, not the tree', async () => {
  // Serialising the whole tree on every keystroke cost time proportional to
  // the table size (~100 KiB per key for the 600-entry table).
  const s = await warmSession();
  await s.compose();
  await s.tap('o');
  const session = s.storage.areas.session;
  assert.equal(session.has('rootState'), false);
  assert.equal(session.has('states'), false);
  const size = JSON.stringify(session.get('statePaths')).length;
  assert.ok(size < 200, `statePaths is ${size} bytes`);
});

test('blur while worker was asleep leaves nothing committed', async () => {
  // After blur, composing must not commit into the old field.
  const s = await warmSession();
  s.start();
  s.worker.blur();
  await s.settle();
  await s.type('"a');
  assert.deepEqual(s.rec.commits, []);
});
