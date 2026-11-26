/*
 * The options page explains how a compose file is read. Each test here checks
 * one of its sentences, so the text cannot quietly go stale: it once said a
 * shorter sequence that is a prefix of a longer one "is suppressed", long
 * after both had been made to work.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Session} = require('./harness');

async function withFile(composeFile) {
  const s = new Session();
  s.storage.areas.sync.set('composeFile', composeFile);
  s.start();
  await s.settle();
  s.worker.focus();
  await s.settle();
  return s;
}

const texts = (s) => s.rec.commits.map((c) => c.text);

test('without include "%L" the built-in sequences are left out', async () => {
  const s = await withFile('<Multi_key> <x> <x> : "X"\n');
  await s.type('"a');
  assert.ok(!texts(s).includes('ä'), JSON.stringify(texts(s)));
});

test('with include "%L" the built-in sequences are there', async () => {
  const s = await withFile('include "%L"\n');
  await s.type('"a');
  assert.deepEqual(texts(s), ['ä']);
});

test('when a sequence is defined twice, the last one wins', async () => {
  const s = await withFile(
      'include "%L"\n<Multi_key> <quotedbl> <a> : "first"\n' +
      '<Multi_key> <quotedbl> <a> : "second"\n');
  await s.type('"a');
  assert.deepEqual(texts(s), ['second']);
});

test('a sequence and a longer one starting with it both work', async () => {
  const file = '<Multi_key> <x> <y> : "short"\n<Multi_key> <x> <y> <z> : "long"\n';
  let s = await withFile(file);
  await s.type('xyz');
  assert.deepEqual(texts(s), ['long']);

  s = await withFile(file);
  await s.type('xyq');
  assert.equal(texts(s).join(''), 'shortq');
});
