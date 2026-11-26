/*
 * The extension's HTML pages. Without a declared encoding, Chrome read the
 * options page's UTF-8 as Latin-1, and "µ" showed as "Âµ".
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

test('every page with non-ASCII text declares UTF-8', () => {
  const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length > 0, 'found the pages');
  const bad = pages.filter((f) => {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return /[^\x00-\x7f]/.test(html) && !/<meta\s+charset="utf-8">/i.test(html);
  });
  assert.deepEqual(bad, []);
});
