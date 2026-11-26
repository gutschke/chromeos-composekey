#!/usr/bin/env node
/*
 * Try the extension from a terminal: plays a list of actions through the
 * real service worker (in the test harness) and prints, after each one,
 * what a user would see: the text field, and the suggestion list if it is
 * showing. Used for usability sessions; not a test.
 *
 *     node test/try.js ACTION...
 *
 * Actions (one argument each):
 *   Compose        press and release the Compose key (right Alt)
 *   Compose-down   press and hold Compose; keys typed until Compose-up
 *   Compose-up     carry Alt, as on hardware
 *   wait           do nothing for a while (about 1.5 s)
 *   Tab Enter Esc Backspace Up Down PageUp PageDown Space
 *                  that key
 *   click:N        click the Nth row of the list (counting from 1)
 *   anything else  typed one character at a time, e.g.  "a  o  euro
 *
 * Each run starts fresh. To continue a session, run it again with more
 * actions on the end.
 */
'use strict';

const {Session} = require('./harness');

const NAMED = {
  Tab: ['Tab', 'Tab'], Enter: ['Enter', 'Enter'], Esc: ['Esc', 'Escape'],
  Escape: ['Esc', 'Escape'], Backspace: ['Backspace', 'Backspace'],
  Up: ['Up', 'ArrowUp'], Down: ['Down', 'ArrowDown'],
  PageUp: ['PageUp', 'PageUp'], PageDown: ['PageDown', 'PageDown'],
  Space: [' ', 'Space'],
};

function isShifted(ch) {
  return /[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(ch);
}

async function main(actions) {
  const s = new Session();
  if (process.env.TRY_FILE) s.setComposeFile(process.env.TRY_FILE);
  s.start();
  await s.settle();
  s.worker.focus();
  await s.settle();

  let field = '';
  let held = false;

  // What the app ends up with, in the order the extension acted: committed
  // text, and keys it let through (which the app then handles itself).
  let seen = 0;
  function applyPassedKeys() {
    for (; seen < s.rec.timeline.length; seen++) {
      const t = s.rec.timeline[seen];
      if (t.commit !== undefined) {
        field += t.commit;
        continue;
      }
      const ev = s.rec.events.get(t.requestId);
      if (t.handled !== false || !ev || ev.type !== 'keydown') continue;
      if (ev.key === 'Backspace') field = [...field].slice(0, -1).join('');
      else if (ev.key === 'Enter') field += '⏎';
      else if ([...ev.key].length === 1 && !ev.ctrl) field += ev.key;
    }
  }

  const tap = async (key, code, shift) => {
    await s.tap(key, {code, shift, alt: held});
  };

  for (const a of actions) {
    if (a === 'Compose') {
      await s.compose();
    } else if (a === 'Compose-down') {
      s.worker.keyEvent('keydown', 'Alt', 'AltRight', {alt: true});
      held = true;
      await s.settle(5);
    } else if (a === 'Compose-up') {
      held = false;
      await s.releaseCompose();
    } else if (a === 'wait') {
      await s.settle(1500);
    } else if (NAMED[a]) {
      await tap(NAMED[a][0], NAMED[a][1], false);
    } else if (/^click:\d+$/.test(a)) {
      const n = Number(a.slice(6)) - 1;
      const c = s.rec.ui.visible && s.rec.ui.candidates[n];
      if (c) s.worker.click(c.id);
      await s.settle();
    } else {
      for (const ch of a) await tap(ch, undefined, isShifted(ch));
    }
    applyPassedKeys();
    print(a, field, s.rec.ui);
  }
}

function print(action, field, ui) {
  const comp = ui.composition ? '̲' + [...ui.composition].join('̲') : '';
  console.log(`> ${action}`);
  console.log(`  field: ${field}${comp ? '[' + ui.composition + ']' : ''}|`);
  if (!ui.visible) return;
  const rows = ui.candidates;
  const w = Math.max(4, ...rows.map((r) => (r.label || '').length));
  for (const r of rows) {
    const mark = ui.properties.cursorVisible && ui.cursor === r.id ? '▸' : ' ';
    // No row numbers: the real window shows the label (the keys) instead.
    console.log(`  ${mark} ${(r.label || '').padEnd(w)}  ${r.candidate}  ${r.annotation || ''}`);
  }
  if (ui.properties.auxiliaryText) console.log(`        (${ui.properties.auxiliaryText})`);
}

main(process.argv.slice(2)).then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
