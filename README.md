# Compose Key for ChromeOS

A Compose key for ChromeOS: press right Alt, then a short sequence such as
`o o` for °, `' e` for é or `:-)` for 🙂.

This is a fork of Google's
[extra-keyboards-for-chrome-os](https://github.com/google/extra-keyboards-for-chrome-os),
reduced to its Compose key extension. Compared with upstream:

- Compose keeps working after ChromeOS restarts the extension's service
  worker. Upstream, it could stop without any error until you switched input
  method away and back.
- Linux and Android apps no longer lose the next press of each key that was part
  of a sequence.
- Compose can be held down while typing a sequence, or tapped first. Holding
  works again with the default settings, and auto-repeat no longer upsets it.
- About 2100 built-in sequences instead of 600: every X11 sequence that can be
  typed on a US keyboard, emoticons, arrows, a selection from other XCompose
  collections, and sub- and superscripts (`_ 2` ₂, `^ ^ n` ⁿ). The table was
  cleaned up: an accent works on either side of the letter, letters are never
  used as accents, and `*` is Greek (`* a` α).
- Characters can be typed by name: Compose `fire` 🔥, `yen` ¥, `delta` δ,
  `times` ×.
- Pause, and a list shows what can follow, with the keys for each. Compose,
  then Tab, searches by name ("euro", "umlaut", "arrow").
- A mistyped sequence no longer disappears. Its keys stay underlined, with
  suggestions; Enter takes the highlighted one or types the keys as they
  were.
- The Compose key can be "Right Alt or Right Control": either works, and
  Right Control helps in apps where Alt opens a menu.
- Custom compose files too large for Chrome sync are no longer replaced by the
  default file.

See [composekey/README.md](composekey/README.md) for how to use it and for the
full list of sequences.

## Installing

The extension is not in the Chrome Web Store; load it unpacked.

1. Download `composekey-<version>.zip` from the latest
   [release](https://github.com/gutschke/chromeos-composekey/releases) and
   unpack it somewhere under My Files, where it can stay: ChromeOS loads the
   extension from there.
2. Open `chrome://extensions` and switch on Developer mode.
3. Click "Load unpacked" and choose the unpacked folder.
4. If you have the Web Store version of ComposeKey installed, turn it off.
5. In Settings, under Keyboard and inputs, Input (the wording varies between
   ChromeOS versions), add "Compose Key (US)" or the variant for your layout,
   and switch to it.

To update, unpack the new release over the old folder and click the reload
icon on the extension's card in `chrome://extensions`.

## Development

- Tests: `cd composekey && node --test test/*.test.js` (tested with Node 22).
- The built-in table is generated: edit `composekey/sequences/*.compose`, then
  run `composekey/tools/gen-sequences.py build`.
- `composekey/tools/export-extension DEST` copies just the extension's files to
  DEST, for loading unpacked.
- `composekey/tools/check-readme-render` checks that the generated tables in
  `composekey/README.md` render on GitHub.
- `cd composekey && node test/try.js Compose o o` plays keys through the
  extension and prints what would appear on screen, so you can try things
  without a Chromebook.
- How the help, the names and the table came to be as they are:
  [composekey/docs/finder-design.md](composekey/docs/finder-design.md).

## Branches

- `main`: this branch, the Compose key extension on its own.
- `composekey`: the same changes on top of upstream's `master`, touching
  nothing but `composekey/`, so that they could be offered upstream. Changes
  for upstream need Google's Contributor License Agreement.
- `master`: upstream, unchanged.

## Licence

Apache License 2.0, like upstream; see [LICENSE](LICENSE). Where the built-in
sequences come from, and under what terms, is stated at the top of each file
in `composekey/sequences/`.
