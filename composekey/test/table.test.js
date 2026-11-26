/*
 * The built-in table, as generated from sequences/*.compose.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {execFileSync} = require('child_process');
const {Session} = require('./harness');

const ROOT = path.join(__dirname, '..');

async function loaded() {
  const s = new Session();
  s.start();
  await s.settle(50);
  return s;
}

/** Look entries up inside the worker, with its own eventToSyms(). */
function lookUp(s, entries) {
  vm.runInContext(`globalThis.__lookUp = (entries) => entries.map(([keys]) => {
    let nodes = [rootState];
    for (const key of ['Multi_key', ...keys]) {
      const syms = key == 'Multi_key' ? ['Multi_key'] :
          eventToSyms({key, location: KBE_DOM_KEY_LOCATION_STANDARD});
      if (syms.length != 1) return {error: 'key ' + JSON.stringify(key) +
                                    ' maps to ' + JSON.stringify(syms)};
      nodes = nodes.flatMap((n) => n.nextKeys[syms[0]] || []);
    }
    const r = nodes.map((n) => n.result).filter(Boolean);
    return r.length ? {string: r[r.length - 1].string} : {error: 'no result'};
  });`, s.worker.context);
  return JSON.parse(JSON.stringify(s.worker.context.__lookUp(entries)));
}

test('generated blocks are up to date with sequences/*.compose', () => {
  execFileSync('python3', ['-I', path.join(ROOT, 'tools', 'gen-sequences.py'), 'check'],
               {stdio: 'pipe'});
});

test('every v2.0 built-in sequence still gives the same output', async () => {
  // test/fixtures/builtin-2.0.js is the table as shipped up to v2.0.
  const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'builtin-2.0.js'), 'utf8');
  const old = vm.runInNewContext(
      src.replace('const builtinSequences =', '(').replace(/;\s*$/, '') + ')');
  const entries = Object.entries(old).map(([seq, out]) => [[...seq], out]);
  assert.equal(entries.length, 601);
  // Except the ones changed or retired on purpose, which 00-fixes.compose
  // and 00-retired.compose list: nothing may change by accident.
  const deliberate = new Set(['00-fixes.compose', '00-retired.compose'].flatMap((f) =>
      fs.readFileSync(path.join(ROOT, 'sequences', f), 'utf8').split('\n')
          .filter((l) => l.startsWith('<Multi_key>'))
          .map((l) => l.split(':')[0].split('#')[0].trim().replace(/\s+/g, ' '))));
  const lhs = (seq) => '<Multi_key> ' + seq.map((c) => '<' + c + '>').join(' ');
  const s = await loaded();
  const symsOf = (keys) => keys.map((k) => vm.runInContext(
      `eventToSyms({key: ${JSON.stringify(k)}, location: 0})[0]`, s.worker.context));
  const got = lookUp(s, entries);
  const bad = entries.filter((e, i) => got[i].string !== e[1] &&
                                       !deliberate.has(lhs(symsOf(e[0]))))
      .map((e) => `${JSON.stringify(e[0].join(''))}: want ${e[1]}`);
  assert.deepEqual(bad, []);
});

test('every generated entry reaches its own output', async () => {
  const s = await loaded();
  // (Rows with no keys are typed by name: see finder.test.js.)
  const table = JSON.parse(JSON.stringify(
      vm.runInContext('builtinSequences', s.worker.context))).filter((r) => r[0].length);
  assert.ok(table.length >= 601);
  const got = lookUp(s, table);
  const bad = [];
  table.forEach(([keys, out], i) => {
    if (got[i].error || got[i].string !== out) {
      bad.push(`${JSON.stringify(keys.join(''))}: want ${JSON.stringify(out)}, ` +
               `got ${JSON.stringify(got[i])}`);
    }
  });
  assert.deepEqual(bad.slice(0, 20), [], `${bad.length} bad entries`);
});

test('generated keys match the keysyms written in sequences/*.compose', async () => {
  // Independent of the generator's own keysym->character table: the worker's
  // XCompose parser reads the source lines, and the worker's eventToSyms()
  // maps the generated characters; both must give the same keysyms. (The
  // tests above use eventToSyms on both sides, so they cannot see a wrong
  // character chosen by the generator.)
  const s = await loaded();
  const dir = path.join(ROOT, 'sequences');
  // (00-retired.compose has left-hand sides only: sequences that are gone.)
  const lines = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.compose') && f !== '00-retired.compose').sort()
      .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n'))
      .filter((l) => l.startsWith('<Multi_key>'));
  vm.runInContext(`globalThis.__syms = (lines, table) => {
    const fromSource = new Set(lines.map(
        (l) => parseSequence(l).events.map((e) => e.sym).join(' ')));
    return table.map(([keys]) => ['Multi_key', ...keys].map((k) =>
        k == 'Multi_key' ? k : eventToSyms(
            {key: k, location: KBE_DOM_KEY_LOCATION_STANDARD}).join('+'))
        .join(' ')).filter((syms) => !fromSource.has(syms));
  };`, s.worker.context);
  const table = vm.runInContext('builtinSequences.filter((r) => r[0].length)', s.worker.context);
  const missing = JSON.parse(JSON.stringify(s.worker.context.__syms(lines, table)));
  assert.deepEqual(missing.slice(0, 20), [], `${missing.length} entries`);
});

test('typing a sample of new sequences end to end', async () => {
  // One per source file, plus the ambiguous ones, through real key events.
  const cases = [
    [':-)', '\u{1F642}'], [':-', '÷'], ['-->', '⟶'],  // additions
    ['=>', '⇒'],                                           // X11
    ['-M', '—'], ['@/', '✓'], ['*l', 'λ'],       // kragen
    ['==', '≡'],                                           // pointless
  ];
  for (const [seq, want] of cases) {
    const s = new Session();
    s.start(); await s.settle();
    s.worker.focus(); await s.settle();
    await s.type(seq);
    if (seq == ':-' || seq == '==') await s.compose();  // ambiguous: settle it
    assert.deepEqual(s.rec.commits.map((c) => c.text), [want], seq);
  }
});

test('no parse errors or warnings for the built-in table', async () => {
  const s = await loaded();
  const st = vm.runInContext('fileStatus', s.worker.context);
  assert.equal(st.errors.length, 0, JSON.stringify(st.errors));
});

test('the X11-style parser handles \\" and \\\\ in results', async () => {
  const s = new Session();
  s.setComposeFile([
    '<Multi_key> <q> <q> : "\\"" quotedbl',
    '<Multi_key> <b> <b> : "\\\\" backslash',
    '',
  ].join('\n'));
  s.start(); await s.settle();
  s.worker.focus(); await s.settle();
  await s.type('qq');
  await s.type('bb');
  await s.tapNamed('Enter');  // b b waits: a name ("bbq") could follow
  assert.deepEqual(s.rec.commits.map((c) => c.text), ['"', '\\']);
});
