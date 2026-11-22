# Compose Key for ChromeOS

A Compose key for ChromeOS: press right Alt, then a short sequence such as
`o o` for °, `' e` for é or `:-)` for 🙂.

This is a fork of Google's
[extra-keyboards-for-chrome-os](https://github.com/google/extra-keyboards-for-chrome-os),
reduced to its Compose key extension. Compared with upstream:

- Compose keeps working after ChromeOS has stopped and restarted the
  extension's service worker. Upstream it could stop working without any
  error until the input method was switched away and back.
- Compose can be held down while typing a sequence, or tapped first. Holding
  works again with the default settings, and is not upset by auto-repeat.
- About 2000 built-in sequences instead of 600: every X11 sequence that can be
  typed on a US keyboard, emoticons, arrows, a selection from other XCompose
  collections, and popular emoji by name (Compose Compose `fire` for 🔥).
- A sequence may be the start of a longer one (`:-` ÷ and `:-)` 🙂); the
  shorter one then waits for the next key.
- Custom compose files too large for Chrome sync are no longer replaced by the
  default file.

See [composekey/README.md](composekey/README.md) for how to use it and for the
full list of sequences.

## Installing

The extension is not in the Chrome Web Store; load it unpacked.

1. Download this repository (Code, Download ZIP) and unpack it somewhere under
   My Files, where it can stay: ChromeOS loads the extension from there.
2. Open `chrome://extensions` and switch on Developer mode.
3. Click "Load unpacked" and choose the `composekey` folder.
4. If you have the Web Store version of ComposeKey installed, turn it off.
5. In Settings, under Keyboard and inputs, Input (the wording varies between
   ChromeOS versions), add "Compose Key (US)" or the variant for your layout,
   and switch to it.

After updating the files, click the reload icon on the extension's card in
`chrome://extensions`.

## Development

- Tests: `cd composekey && node --test test/*.test.js` (tested with Node 22).
- The built-in table is generated: edit `composekey/sequences/*.compose`, then
  run `composekey/tools/gen-sequences.py build`.
- `composekey/tools/export-extension DEST` copies just the extension's files to
  DEST, for loading unpacked.

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
