/*
 * The sequence finder (finder.js). What matters most is what it must NOT do:
 * appear while someone types a known sequence at speed, or change what any
 * key of a sequence does. Those tests come first.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Session} = require('./harness');

const DELAY = 40;  // finderDelayMs for these tests

// A small table, so the list tests do not depend on the built-in one.
const SMALL = [
  '<Multi_key> <apostrophe> <e> : "é"',
  '<Multi_key> <apostrophe> <a> : "á"',
  '<Multi_key> <apostrophe> <o> : "ó"',
  '<Multi_key> <o> <o> : "°"',
  '',
].join('\n');

let current = null;
process.on('unhandledRejection', (err) => {
  if (current) current.rec.errors.push('unhandled rejection: ' + (err && err.stack || err));
});

async function session({file, delay = DELAY, tab = true} = {}) {
  current = new Session();
  current.storage.areas.sync.set('finderDelayMs', delay);
  current.storage.areas.sync.set('finderTab', tab);
  if (file) current.setComposeFile(file);
  current.start();
  await current.settle();
  current.worker.focus();
  await current.settle();
  return current;
}

const texts = (s) => s.rec.commits.map((c) => c.text);
const shown = (s) => s.rec.ui.visible;
const everShown = (s) => s.rec.ui.calls.some(
    ([k, p]) => k === 'props' && p.visible === true);
const rows = (s) => s.rec.ui.candidates;
function clean(s) {
  assert.deepEqual(s.rec.errors, [], 'no errors');
  assert.deepEqual(s.rec.unanswered(), [], 'every key event answered');
}
function passedThrough(s, key) {
  return s.rec.handled.get(s.rec.lastKeydown[key]) === false;
}

// --- Staying out of the way -------------------------------------------------

test('fast typing never shows the window', async () => {
  const s = await session();
  await s.type('"a');
  await s.type("e'");
  await s.settle(DELAY * 3);
  clean(s);
  assert.deepEqual(texts(s), ['ä', 'é']);
  assert.equal(everShown(s), false);
});

test('a pause shows what can follow; the next key still just types', async () => {
  const s = await session({file: SMALL});
  await s.type("'");
  await s.settle(DELAY * 3);
  assert.equal(shown(s), true, 'window shown after the pause');
  const e = rows(s).find((r) => r.candidate === 'é');
  assert.ok(e, 'é is listed');
  assert.equal(e.label, 'e', 'labelled with the key still to type');
  await s.tap('e');
  clean(s);
  assert.deepEqual(texts(s), ['é']);
  assert.equal(shown(s), false, 'closed once the sequence is done');
});

test('Compose auto-repeat while held does not restart the pause', async () => {
  // The timer counts from the last real key. Repeats of a held Compose arrive
  // as plain keydowns; if they reset it, hold mode would never see the list.
  const s = await session();
  await s.holdType("'", {release: false});
  for (let t = 0; t < DELAY * 3; t += 10) {
    s.worker.keyEvent('keydown', 'Alt', 'AltRight', {alt: true});
    await s.settle(10);
  }
  assert.equal(shown(s), true);
  await s.releaseCompose();
  clean(s);
});

test('delay -1: no window without Tab', async () => {
  const s = await session({delay: -1});
  await s.type("'");
  await s.settle(DELAY * 3);
  clean(s);
  assert.equal(everShown(s), false);
});

test('Enter with nothing highlighted types the waiting result, then acts', async () => {
  const file = '<Multi_key> <colon> <minus> : "÷"\n' +
      '<Multi_key> <colon> <minus> <parenright> : "X"\n';
  const s = await session({file});
  await s.type(':-');
  await s.settle(DELAY * 3);
  assert.equal(shown(s), true);
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['÷']);
  assert.equal(passedThrough(s, 'Enter'), true, '÷ was on screen; Enter is Enter');
});

test('a key bound in the compose file wins over the finder', async () => {
  const s = await session({file: '<Multi_key> <a> <Tab> : "X"\n'});
  await s.type('a');
  await s.tapNamed('Tab');
  clean(s);
  assert.deepEqual(texts(s), ['X']);
  assert.equal(s.rec.ui.composition, '', 'no search opened');
});

// --- Choosing ----------------------------------------------------------------

test('arrow, then Enter, commits the highlighted row', async () => {
  const s = await session({file: SMALL});
  await s.type("'");
  await s.settle(DELAY * 3);
  const first = rows(s)[0].candidate;
  await s.tapNamed('ArrowDown');
  assert.equal(s.rec.ui.cursor, 0);
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), [first]);
  assert.equal(passedThrough(s, 'Enter'), false);
  assert.equal(shown(s), false);
});

test('Page Down highlights, so Enter can pick (Alt+Down may arrive as it)', async () => {
  const s = await session({file: SMALL});
  await s.type("'");
  await s.settle(DELAY * 3);
  const first = rows(s)[0].candidate;
  await s.tapNamed('PageDown');
  assert.equal(s.rec.ui.cursor, 0);
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), [first]);
});

// ChromeOS names some keys the old way: seen on a Chromebook, the down
// arrow arrives as key "Down" (code "ArrowDown"), and it ended the search.
test('search: the arrow as ChromeOS names it ("Down") picks a row', async () => {
  const s = await session();
  await search(s, 'euro');
  assert.equal(s.rec.ui.cursor, 0, 'the first result is highlighted');
  await s.tap('Down', {code: 'ArrowDown'});
  assert.equal(s.rec.ui.cursor, 1);
  assert.equal(shown(s), true, 'search still open');
  await s.tap('Up', {code: 'ArrowUp'});
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['€']);
});

test('list: "Down" and "Up" move the highlight', async () => {
  const s = await session({file: SMALL});
  await s.type("'");
  await s.settle(DELAY * 3);
  await s.tap('Down', {code: 'ArrowDown'});
  await s.tap('Down', {code: 'ArrowDown'});
  await s.tap('Up', {code: 'ArrowUp'});
  assert.equal(s.rec.ui.cursor, 0);
  const first = rows(s)[0].candidate;
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), [first]);
});

test('search: "Esc" cancels like Escape', async () => {
  const s = await session();
  await search(s, 'euro');
  await s.tap('Esc', {code: 'Escape'});
  clean(s);
  assert.deepEqual(texts(s), []);
  assert.equal(passedThrough(s, 'Esc'), false, 'consumed, not passed to the app');
  assert.equal(shown(s), false);
});

test('an arrow sent with an empty key is still an arrow', async () => {
  const s = await session({file: SMALL});
  await s.type("'");
  await s.settle(DELAY * 3);
  await s.tap('', {code: 'ArrowDown'});
  assert.equal(s.rec.ui.cursor, 0);
  assert.equal(shown(s), true);
  clean(s);
});

test('hold mode: arrow and Enter while Compose is held', async () => {
  const s = await session({file: SMALL});
  await s.holdType("'", {release: false});
  await s.settle(DELAY * 3);
  const first = rows(s)[0].candidate;
  await s.tap('ArrowDown', {code: 'ArrowDown', alt: true});
  await s.tap('Enter', {code: 'Enter', alt: true});
  await s.releaseCompose();
  clean(s);
  assert.deepEqual(texts(s), [first]);
});

test('clicking a row commits it', async () => {
  const s = await session({file: SMALL});
  await s.type("'");
  await s.settle(DELAY * 3);
  const r = rows(s)[1];
  s.worker.click(r.id);
  await s.settle();
  clean(s);
  assert.deepEqual(texts(s), [r.candidate]);
  assert.equal(shown(s), false);
});

test('ambiguous prefix: the waiting result is listed first, keyed Compose', async () => {
  const file = '<Multi_key> <colon> <minus> : "÷"\n' +
      '<Multi_key> <colon> <minus> <parenright> : "X"\n';
  const s = await session({file});
  await s.type(':-');
  await s.settle(DELAY * 3);
  assert.equal(rows(s)[0].candidate, '÷');
  assert.equal(rows(s)[0].label, 'Enter');
  assert.equal(rows(s)[1].label, ')');
  clean(s);
});

test('a wide prefix lists next keys, not hundreds of results', async () => {
  // "[" leads to 110 results through 49 next keys.
  const s = await session();
  await s.type('[');
  await s.settle(DELAY * 3);
  assert.equal(shown(s), true);
  const r = rows(s);
  assert.ok(r.length <= 9, 'one page');
  assert.ok(r.every((x) => /^\d+$/.test(x.annotation)), 'counts, not names');
  clean(s);
});

test('right after Compose, a pause offers the search, and Tab opens it', async () => {
  const s = await session();
  await s.compose();
  await s.settle(DELAY * 3);
  assert.equal(shown(s), true);
  assert.equal(rows(s).length, 1);
  assert.equal(rows(s)[0].label, 'Tab');
  await s.tapNamed('Tab');
  clean(s);
  assert.equal(passedThrough(s, 'Tab'), false);
  assert.equal(shown(s), true);
});

// --- Search ------------------------------------------------------------------

async function search(s, query) {
  await s.compose();
  await s.tapNamed('Tab');
  for (const ch of query) await s.tap(ch, {shift: /[A-Z]/.test(ch)});
}

test('search: euro finds € and shows its keys', async () => {
  const s = await session();
  await search(s, 'euro');
  assert.equal(s.rec.ui.composition, 'euro', 'query shown in the field');
  assert.equal(rows(s)[0].candidate, '€');
  assert.match(rows(s)[0].label, /=/);
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['€']);
  assert.equal(s.rec.ui.composition, '');
  assert.equal(shown(s), false);
});

test('search: a category word finds its members', async () => {
  const s = await session();
  await search(s, 'currency');
  const found = rows(s).map((r) => r.candidate);
  for (const c of ['€', '£', '¥']) assert.ok(found.includes(c), c + ' found');
  clean(s);
});

test('search: Escape types nothing and clears the query', async () => {
  const s = await session();
  await search(s, 'euro');
  await s.tapNamed('Escape');
  clean(s);
  assert.deepEqual(texts(s), []);
  assert.equal(s.rec.ui.composition, '');
  assert.equal(shown(s), false);
});

test('search: Backspace edits the query', async () => {
  const s = await session();
  await search(s, 'eurx');
  await s.tapNamed('Backspace');
  await s.tap('o');
  assert.equal(s.rec.ui.composition, 'euro');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['€']);
});

test('search survives a worker restart', async () => {
  const s = await session();
  await search(s, 'eu');
  s.start();
  await s.settle();
  await s.tap('r');
  await s.tap('o');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['€']);
});

test('search label is the sequence the live table types', async () => {
  // A user file that rebinds € must be what the finder teaches.
  const s = await session({file: 'include "%L"\n<Multi_key> <e> <u> : "€"\n'});
  await search(s, 'euro');
  assert.equal(rows(s)[0].candidate, '€');
  assert.equal(rows(s)[0].label, 'Compose e u');
  clean(s);
});

// --- Compose Compose name, when no emoji has it ------------------------------

async function composeName(s, name) {
  await s.compose();
  await s.compose();
  for (const ch of name) await s.tap(ch, {shift: /[A-Z]/.test(ch)});
}

test('Compose Compose euro searches, since no emoji is called that', async () => {
  const s = await session();
  await composeName(s, 'euro');
  assert.equal(s.rec.ui.composition, 'euro', 'the name became the query');
  assert.equal(rows(s)[0].candidate, '€');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['€']);
});

test('Compose Compose fire: 🔥 at once, nothing longer is called fire…', async () => {
  const s = await session();
  await composeName(s, 'fire');
  clean(s);
  assert.deepEqual(texts(s), ['🔥']);
});

test('a mistyped emoji name lands in the search, not the document', async () => {
  const s = await session();
  await composeName(s, 'fier');
  assert.equal(s.rec.ui.composition, 'fier');
  await s.tapNamed('Escape');
  clean(s);
  assert.deepEqual(texts(s), []);
  assert.equal(shown(s), false);
});

test('a failed ordinary sequence keeps its keys, underlined', async () => {
  // It used to vanish ("Compose c v estina" gave "estina").
  const s = await session();
  await s.type('zq');
  assert.equal(s.rec.ui.composition, 'zq', 'shown, not lost');
  assert.equal(shown(s), true, 'with suggestions');
  assert.equal(s.rec.ui.cursor === null || !s.rec.ui.properties.cursorVisible, true,
               'nothing highlighted: Enter would type it as is');
  for (const ch of '!stina') await s.tap(ch, {shift: ch === '!'});
  clean(s);
  assert.deepEqual(texts(s), ['zq!'], 'the next key commits them with it');
  assert.equal(passedThrough(s, 's'), true, 'and the rest is typed as usual');
});

test('an old habit (c v for č, retired) is offered and highlighted', async () => {
  const s = await session();
  await s.type('cv');
  assert.equal(rows(s)[0].candidate, 'č');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['č']);
  assert.equal(shown(s), false);
});

test('with Tab search off, a failed name fails as before', async () => {
  const s = await session({tab: false});
  await composeName(s, 'euro');
  clean(s);
  assert.equal(s.rec.ui.composition, '');
  assert.equal(everShown(s), false);
});

// --- Mistakes: nothing is lost, and the likely fix is offered --------------

test('mismatch: Enter types the keys as they were', async () => {
  const s = await session();
  await s.type('zq');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['zq']);
  assert.equal(passedThrough(s, 'Enter'), false, 'and Enter is not passed on');
  assert.equal(s.rec.ui.composition, '');
});

test('mismatch: Escape discards', async () => {
  const s = await session();
  await s.type('zq');
  await s.tapNamed('Escape');
  clean(s);
  assert.deepEqual(texts(s), []);
  assert.equal(shown(s), false);
});

test('mismatch: Down picks the suggestion', async () => {
  const s = await session();
  await s.type('zq');
  const first = rows(s)[0].candidate;
  await s.tap('Down', {code: 'ArrowDown'});
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), [first]);
});

test('mismatch that goes on as a name: Compose y e n is ¥', async () => {
  const s = await session();
  await s.type('yen');
  clean(s);
  assert.deepEqual(texts(s), ['¥']);
});

test('mismatch: Space types the keys and the space', async () => {
  const s = await session();
  await s.type('zq');
  await s.tap(' ', {code: 'Space'});
  clean(s);
  assert.deepEqual(texts(s), ['zq ']);
});

test('mismatch in hold mode: release types the keys', async () => {
  const s = await session();
  await s.holdType('zq');
  clean(s);
  assert.deepEqual(texts(s), ['zq']);
  assert.equal(shown(s), false);
});

test('mismatch, then the field loses focus: the keys are typed', async () => {
  const s = await session();
  await s.type('zq');
  s.worker.blur();
  await s.settle();
  assert.deepEqual(texts(s), ['zq']);
});

test('mismatch: Backspace goes back to the sequence, with its list', async () => {
  // From "e4", Backspace gives back "e" and the é è ë list (it used to
  // show "no match" for "e").
  const s = await session();
  await s.type('cv');
  await s.tapNamed('Backspace');
  assert.equal(s.rec.ui.composition, '', 'c is a live sequence again');
  assert.equal(shown(s), true);
  assert.ok(rows(s).some((r) => r.candidate === 'ç'), 'with what c leads to');
  await s.tap(',');
  assert.deepEqual(texts(s), ['ç']);
});

test('mismatch: Backspace to nothing cancels', async () => {
  const s = await session();
  await s.type('zq');
  await s.tapNamed('Backspace');
  await s.tapNamed('Backspace');
  clean(s);
  assert.deepEqual(texts(s), []);
  assert.equal(s.rec.ui.composition, '');
});

test('a partial name after a failed sequence does not take Enter', async () => {
  // "hea" is the start of names, but not a whole one: Enter types it.
  const s = await session();
  await s.type('hea');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['hea']);
});

test('Compose in the middle of a sequence keeps the keys and starts again', async () => {
  const s = await session();
  await s.type('z');
  await s.tap('q');
  await s.compose();
  await s.tap('"', {shift: true});
  await s.tap('a');
  clean(s);
  assert.deepEqual(texts(s), ['zq', 'ä']);
});

test('Backspace mid-sequence takes back one key', async () => {
  const s = await session();
  await s.type('s');
  await s.tapNamed('Backspace');
  await s.tap('e');
  await s.tap(';');
  clean(s);
  assert.deepEqual(texts(s), ['ę']);
});

test('Backspace right after Compose cancels Compose', async () => {
  const s = await session();
  await s.compose();
  await s.tapNamed('Backspace');
  await s.tap('o');
  clean(s);
  assert.deepEqual(texts(s), []);
  assert.equal(passedThrough(s, 'o'), true, 'o is typed as usual');
});

// --- Names: Compose Compose and Compose Tab are the same --------------------

test('Compose Tab fire Enter is 🔥', async () => {
  const s = await session();
  await s.compose();
  await s.tapNamed('Tab');
  for (const ch of 'fire') await s.tap(ch);
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['🔥']);
});

test('a name being typed is shown in the field', async () => {
  const s = await session();
  await composeName(s, 'heart');
  assert.equal(s.rec.ui.composition, 'heart', 'not invisible any more');
  await s.tap(' ', {code: 'Space'});
  clean(s);
  assert.deepEqual(texts(s), ['❤️ ']);
  assert.equal(s.rec.ui.composition, '');
});

test('typing a name lists every character with it, not only emoji', async () => {
  const s = await session();
  await s.compose();
  await s.tapNamed('Tab');
  await s.tap('p');
  await s.tap('i');
  assert.equal(rows(s)[0].candidate, 'π');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['π']);
});

test('search ranking: plain before styled, emoji heart first, a typo forgiven', async () => {
  const s = await session();
  await search(s, 'pi');
  assert.equal(rows(s)[0].candidate, 'π', 'π before ℼ');
  await s.tapNamed('Escape');
  await search(s, 'heart');
  assert.equal(rows(s)[0].candidate, '❤️');
  await s.tapNamed('Escape');
  await search(s, 'fier');
  assert.equal(rows(s)[0].candidate, '🔥');
  clean(s);
});

test('after a pause, lower case comes first', async () => {
  const s = await session({file: 'include "%L"\n'});
  await s.type('"');
  await s.settle(DELAY * 3);
  const page = rows(s).map((r) => r.candidate);
  assert.ok(page.includes('ü'), 'ü on the first page: ' + page.join(' '));
  assert.ok(page.indexOf('ä') < page.indexOf('Ä') || !page.includes('Ä'));
  clean(s);
});

// --- The fast path is unchanged ----------------------------------------------

test('every 9th built-in sequence, typed fast in tap and hold mode: no window', async () => {
  const vm = require('vm');
  const s = await session();
  const table = vm.runInContext('builtinSequences.map((r) => [r[0], r[1]])', s.worker.context);
  const sample = JSON.parse(JSON.stringify(table)).filter((_, i) => i % 9 === 0);
  // The result each would give, from the tree itself (a shorter sequence
  // may be held until the next key: those are left out here, see
  // ambiguous.test.js).
  const holdable = vm.runInContext(`(keys) => {
    let nodes = rootState.nextKeys['Multi_key'] || [];
    for (const k of keys) {
      const syms = k == 'Multi_key' ? ['Multi_key'] :
          eventToSyms({key: k, location: KBE_DOM_KEY_LOCATION_STANDARD});
      nodes = nodes.flatMap((n) => n.nextKeys[syms[0]] || []);
    }
    return canContinue(nodes) || finderNameMayFollow(nodes);
  }`, s.worker.context);
  let checked = 0;
  for (const [keys, out] of sample) {
    if (holdable(keys)) continue;
    // A second Compose while Compose is held is auto-repeat, not a press:
    // Compose Compose names are typed in tap mode only.
    for (const mode of keys.includes('Multi_key') ? ['tap'] : ['tap', 'hold']) {
      const before = s.rec.commits.length;
      if (mode === 'tap') {
        await s.compose();
      } else {
        s.worker.keyEvent('keydown', 'Alt', 'AltRight', {alt: true});
        await s.settle(2);
      }
      for (const k of keys) {
        if (k === 'Multi_key') await s.compose();
        else await s.tap(k, {shift: /[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(k), alt: mode === 'hold'});
      }
      if (mode === 'hold') await s.releaseCompose();
      assert.deepEqual(s.rec.commits.slice(before).map((c) => c.text), [out],
                       `${mode}: ${JSON.stringify(keys)}`);
      checked++;
    }
  }
  assert.ok(checked > 300, `${checked} checked`);
  assert.equal(everShown(s), false, 'the window never appeared');
  clean(s);
});

// --- Enter after a name: the same, fast or slow ----------------------------

test('fast Enter after a name that waits for a longer one: ❤️, no newline', async () => {
  const s = await session();
  await composeName(s, 'heart');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['❤️']);
  assert.equal(passedThrough(s, 'Enter'), false, 'Enter does not reach the app');
});

test('fast Enter after an unfinished name takes the best match', async () => {
  const s = await session();
  await composeName(s, 'thumbs');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['👍']);
  assert.equal(passedThrough(s, 'Enter'), false);
});

test('Enter after a name that matches nothing types it as typed', async () => {
  const s = await session();
  await composeName(s, 'qqzz');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['qqzz']);
});

test('Tab while typing a name searches for it, keeping it', async () => {
  const s = await session();
  await composeName(s, 'heart');
  await s.tapNamed('Tab');
  assert.equal(s.rec.ui.composition, 'heart');
  assert.equal(shown(s), true);
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['❤️']);
});

test('alpha, forall, exists by name', async () => {
  const s = await session();
  for (const n of ['alpha', 'forall', 'exists']) {
    await composeName(s, n);
    await s.tapNamed('Enter');
  }
  clean(s);
  assert.deepEqual(texts(s), ['α', '∀', '∃']);
});

test('a sequence waiting after two keys shows them', async () => {
  const s = await session();
  await s.type('<=');  // ≤, or the start of <=>
  assert.equal(s.rec.ui.composition, '≤', 'shown as what it will be');
  await s.tap(' ', {code: 'Space'});
  clean(s);
  assert.deepEqual(texts(s), ['≤ ']);
  assert.equal(s.rec.ui.composition, '');
});

// --- Keys and names after one Compose ----------------------------------------

test('Compose m u is µ: shown at once, typed with the next key', async () => {
  const s = await session();
  await s.type('mu');
  assert.equal(s.rec.ui.composition, 'µ', 'shown as µ while it waits');
  assert.deepEqual(texts(s), []);
  await s.tap('m');
  clean(s);
  assert.deepEqual(texts(s), ['µm']);
  assert.equal(everShown(s), false);
});

test('Compose m u, Space: µ and the space', async () => {
  const s = await session();
  await s.type('mu');
  await s.tap(' ', {code: 'Space'});
  clean(s);
  assert.deepEqual(texts(s), ['µ ']);
});

test('Compose multiplication Space is ×, and m u l e Space is µle', async () => {
  const s = await session();
  await s.type('multiplication');       // no longer name: at once
  await s.type('mule');                  // "mule" is no name: µle at the e
  clean(s);
  assert.deepEqual(texts(s), ['×', 'µle']);
});

test('pin and pint: the next key decides', async () => {
  const s = await session();
  await s.type('pin');
  await s.tap(' ', {code: 'Space'});
  await s.type('pint');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['📌 ', '🍺']);
});

test('in hold mode, releasing Compose ends a name', async () => {
  const s = await session();
  await s.holdType('yen');
  clean(s);
  assert.deepEqual(texts(s), ['¥']);
});

test('a waiting result is typed when the field loses focus', async () => {
  const s = await session();
  await s.type('mu');
  s.worker.blur();
  await s.settle();
  assert.deepEqual(texts(s), ['µ']);
});

test('the commit timeout types a waiting result; off, it waits', async () => {
  for (const [ms, want] of [[60, ['µ']], [-1, []]]) {
    current = new Session();
    current.storage.areas.sync.set('finderDelayMs', -1);
    current.storage.areas.sync.set('finderCommitDelayMs', ms);
    current.start(); await current.settle();
    current.worker.focus(); await current.settle();
    await current.type('mu');
    await current.settle(200);
    clean(current);
    assert.deepEqual(texts(current), want, `timeout ${ms}`);
  }
});

test('the timeout never types half a name', async () => {
  current = new Session();
  current.storage.areas.sync.set('finderCommitDelayMs', 60);
  current.start(); await current.settle();
  current.worker.focus(); await current.settle();
  await current.type('mul');
  await current.settle(200);
  assert.deepEqual(texts(current), [], 'mul is not a name: nothing typed');
  assert.equal(current.rec.ui.composition, 'mul');
});

test('a rule of the user\'s own waits for names like a built-in one', async () => {
  // Letters as accents are not in the built-in table any more; a user who
  // adds one back gets the same behaviour: it waits only if a name follows.
  const s = await session({file: 'include "%L"\n<Multi_key> <c> <a> : "ǎ"\n<Multi_key> <c> <s> : "š"\n'});
  await s.type('cs');                   // no name starts with "cs": at once
  assert.deepEqual(texts(s), ['š']);
  await s.type('ca');                   // "cake", "cat"...: waits
  assert.equal(s.rec.ui.composition, 'ǎ');
  await s.tap('x');                     // no name "cax": ǎ and x
  await s.type('cat');
  await s.tap(' ', {code: 'Space'});    // the whole word is a name
  clean(s);
  assert.deepEqual(texts(s), ['š', 'ǎx', '🐱 ']);
});

test('retired sequences typed out of habit are offered first', async () => {
  const s = await session();
  await s.type('cs');
  assert.equal(rows(s)[0].candidate, 'š');
  assert.equal(rows(s)[0].label, 'Compose < s');
  clean(s);
});

test('after a pause, help shows whatever the letters start', async () => {
  // Compose p i used to wait silently for "p i n t"; now it lists π first.
  const s = await session();
  await s.type('pi');
  await s.settle(DELAY * 3);
  assert.equal(shown(s), true);
  assert.equal(rows(s)[0].candidate, 'π');
  clean(s);
});

// --- Panel A fixes -----------------------------------------------------------

test('Greek and LaTeX names', async () => {
  const s = await session();
  // Each ends with Enter: whether it is typed at its last letter (nothing
  // longer has that name) or by Enter, the result is the same.
  for (const n of ['delta', 'theta', 'epsilon', 'pi', 'omega', 'times', 'pm', 'infty', 'sum']) {
    await s.type(n);
    if (s.rec.ui.composition) await s.tapNamed('Enter');
  }
  clean(s);
  assert.deepEqual(texts(s), ['δ', 'θ', 'ε', 'π', 'ω', '×', '±', '∞', '∑']);
});

test('a misspelt name stays underlined; Enter takes the fix', async () => {
  const s = await session();
  for (const [typo, want] of [['fier', '🔥'], ['thumsup', '👍'], ['hart', '❤️']]) {
    await s.type(typo);
    assert.equal(s.rec.ui.composition, typo, typo + ' still underlined');
    await s.tapNamed('Enter');
    assert.equal(texts(s).at(-1), want, typo);
  }
  clean(s);
  assert.equal(passedThrough(s, 'Enter'), false);
});

test('Compose after a waiting result starts a new sequence', async () => {
  const s = await session();
  await s.type('ou');                   // ů, waits (ounce)
  await s.compose();
  await s.tap('<', {shift: true});
  await s.tap('n');
  clean(s);
  assert.deepEqual(texts(s), ['ů', 'ň']);
});

test('Enter after a mistake never sends', async () => {
  const s = await session();
  await s.type('zq');
  await s.tapNamed('Enter');
  clean(s);
  assert.equal(passedThrough(s, 'Enter'), false);
});

// --- Panel B fixes -----------------------------------------------------------

test('Greek letters win their names, capitals by capitalised name', async () => {
  const s = await session();
  for (const n of ['sigma', 'gamma', 'phi', 'Delta', 'Sigma', 'Omega', 'Rightarrow']) {
    await s.type(n);
    if (s.rec.ui.composition) await s.tapNamed('Enter');
  }
  clean(s);
  assert.deepEqual(texts(s), ['σ', 'γ', 'φ', 'Δ', 'Σ', 'Ω', '⇒']);
});

test('phrases are search words: Compose Tab thumbs up; typed: thumbsup', async () => {
  // Space ends a typed name, so a phrase cannot be one; it is found by search.
  const s = await session();
  await s.compose();
  await s.tapNamed('Tab');
  for (const ch of 'thumbs up') await s.tap(ch, {code: ch === ' ' ? 'Space' : undefined});
  await s.tapNamed('Enter');
  await s.type('thumbsup');
  await s.type('blueheart');
  clean(s);
  assert.deepEqual(texts(s), ['👍', '👍', '💙']);
});

test('LaTeX abbreviations are search words; Enter takes them: pm ±, ne ≠', async () => {
  const s = await session();
  for (const n of ['pm', 'ne']) {
    await s.type(n);
    await s.tapNamed('Enter');
  }
  clean(s);
  assert.deepEqual(texts(s), ['±', '≠']);
});

test('a name and a letter more: pushpins is 📌s', async () => {
  // "pushpin" is typed at its last letter (nothing longer); the s follows.
  const s = await session();
  await s.type('pushpins');
  clean(s);
  assert.deepEqual(texts(s), ['📌']);
  assert.equal(passedThrough(s, 's'), true);
});

test('Space keeps what was typed; only Enter takes a highlighted fix', async () => {
  const s = await session();
  await s.type('thumsup');
  await s.tap(' ', {code: 'Space'});
  clean(s);
  assert.deepEqual(texts(s), ['thumsup ']);
});

test('the row Space and Enter will take is highlighted', async () => {
  const s = await session();
  await s.type('laugh');
  await s.settle(DELAY * 3);
  assert.equal(rows(s)[s.rec.ui.cursor].candidate, '😄');
  assert.match(s.rec.ui.properties.auxiliaryText, /take ▸/);
  clean(s);
});

test('Enter after a waiting ° types it and then Enter', async () => {
  const s = await session();
  await s.type('oo');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['°']);
  assert.equal(passedThrough(s, 'Enter'), true);
});

test('a name nothing longer starts with is typed at once: yen', async () => {
  const s = await session();
  await s.type('yen');
  clean(s);
  assert.deepEqual(texts(s), ['¥']);
});

test('a name that could still grow waits: euro (euro-currency ₠), pin', async () => {
  const s = await session();
  await s.type('euro');
  assert.deepEqual(texts(s), []);
  await s.tapNamed('Enter');
  await s.type('pin');
  assert.equal(s.rec.ui.composition, 'pin');
  await s.tap('t');                         // pint: nothing longer, at once
  clean(s);
  assert.deepEqual(texts(s), ['€', '🍺']);
});

test('an unambiguous start completes: multip, then Enter, is ×', async () => {
  const s = await session();
  await s.type('multip');
  await s.settle(DELAY * 3);
  assert.equal(rows(s)[s.rec.ui.cursor].candidate, '×', 'highlighted');
  await s.tapNamed('Enter');
  clean(s);
  assert.deepEqual(texts(s), ['×']);
});

test('subscript letters: _ _ and the letter; _ a stays ā', async () => {
  const s = await session();
  await s.type('__i');
  await s.type('__a');
  await s.type('_a');
  await s.type('_2');
  await s.type('__*b');
  await s.type('^^a');
  await s.type('^^T');
  await s.type('^a');
  clean(s);
  assert.deepEqual(texts(s), ['ᵢ', 'ₐ', 'ā', '₂', 'ᵦ', 'ᵃ', 'ᵀ', 'â']);
});

test('sub/superscript panel: names that wait, digits in names, Compose after a name', async () => {
  const s = await session();
  await s.type('cube');                 // cubed is longer: waits
  assert.deepEqual(texts(s), []);
  await s.tap('d');                     // cubed: nothing longer, at once
  await s.type('footnote');
  await s.type('sub2');
  await s.type('euro');
  await s.compose();                    // ends euro, starts a new character
  await s.tap('"', {shift: true});
  await s.tap('u');
  await s.type('__4');
  clean(s);
  assert.deepEqual(texts(s), ['³', '†', '₂', '€', 'ü', '₄']);
});

test('blur closes the window', async () => {
  const s = await session();
  await s.type("'");
  await s.settle(DELAY * 3);
  assert.equal(shown(s), true);
  s.worker.blur();
  await s.settle();
  assert.equal(shown(s), false);
  clean(s);
});
