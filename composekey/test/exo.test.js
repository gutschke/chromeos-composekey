/*
 * Keys as the window of a Linux (Crostini) or Android app gets them. ChromeOS
 * tracks pressed keys for these windows itself; see Exo below.
 *
 * Used to fail: the extension suppressed the release of every key whose press
 * it had suppressed, so the next press of each key of a sequence was lost. After
 * Compose Compose f i r e, "the quick brown fox" arrived as "th quck bown ox".
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Session} = require('./harness');

/** Model of exo::Keyboard::OnKeyEvent and the input method in front of it. */
class Exo {
  constructor() {
    this.pressed = new Map();  // code -> consumed by the input method
    this.events = [];          // what the app gets
  }
  key(type, key, code, handled) {
    if (type === 'keydown') {
      if (this.pressed.has(code)) return;  // "already pressed"
      this.pressed.set(code, handled);
      if (!handled) this.events.push(['keydown', key]);
      return;
    }
    if (handled) return;  // the input method consumes a release silently
    if (!this.pressed.has(code)) return;
    if (!this.pressed.get(code)) this.events.push(['keyup', key]);
    this.pressed.delete(code);
  }
  text() {
    return this.events.filter(([t, k]) => t === 'keydown' && k.length === 1)
        .map(([, k]) => k).join('');
  }
}

let current = null;
process.on('unhandledRejection', (err) => {
  if (current) current.rec.errors.push('unhandled rejection: ' + (err && err.stack || err));
});

async function session() {
  const s = current = new Session();
  s.exo = new Exo();
  s.start();
  await s.settle();
  s.worker.focus();
  await s.settle();
  const requests = new Map();
  const keyEvent = s.worker.keyEvent;
  const ime = s.worker.chrome.input.ime;
  const answer = ime.keyEventHandled;
  s.worker.keyEvent = function(type, key, code, mods) {
    queued = [type, key, code];
    return keyEvent.call(this, type, key, code, mods);
  };
  let queued = null;
  // The request ID is only known inside the call; the answer comes later.
  const fire = s.worker.fire;
  s.worker.fire = function(name, ...args) {
    if (name === 'onKeyEvent') requests.set(args[2], queued);
    return fire.call(this, name, ...args);
  };
  ime.keyEventHandled = (id, handled) => {
    const r = requests.get(id);
    if (r) {
      requests.delete(id);  // Chrome ignores a second answer
      s.exo.key(...r, handled);
    }
    answer(id, handled);
  };
  return s;
}

async function plain(s, text) {
  for (const c of text) await s.tap(c);
}

for (const [name, compose, expected, after = 'the quick brown fox', committedAfter] of [
  ['tap', (s) => s.type('"a'), 'ä'],
  ['tap, shifted key', (s) => s.type('"a'), 'ä'],
  ['Compose Compose name', async (s) => {
    await s.compose(); await s.type('fire');
  }, '🔥'],
  ['hold', (s) => s.holdType('"a'), 'ä'],
  ['hold with auto-repeat', (s) => s.holdType('"a', {repeats: 5}), 'ä'],
  ['cancelled', async (s) => { await s.type('o'); await s.tapNamed('Escape'); }, undefined],
  // A sequence that matches nothing is kept, underlined; the next key
  // commits it plus that key as text ("oqt"), so the app sees "he quick...".
  ['mismatch', (s) => s.type('oq'), undefined, 'he quick brown fox', 'oqt'],
]) {
  test('no key is lost after a composition: ' + name, async () => {
    const s = await session();
    await plain(s, 'the quick brown fox');
    assert.equal(s.exo.text(), 'the quick brown fox', 'before');
    s.exo.events = [];
    await compose(s);
    assert.equal(s.rec.commits[0]?.text, expected);
    assert.deepEqual([...s.exo.pressed.keys()], [], 'no key left pressed');
    assert.deepEqual(
        s.exo.events.filter(([, k]) => k !== 'Shift'), [],
        'the app sees nothing of the sequence');
    s.exo.events = [];
    await plain(s, 'the quick brown fox');
    assert.equal(s.exo.text(), after, 'after');
    if (committedAfter) assert.equal(s.rec.commits.at(-1).text, committedAfter);
    assert.deepEqual(s.rec.errors, []);
  });
}
