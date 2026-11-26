# Sequence finder — design proposal

Status: proposal, not built. Comes from one review round with five
panellists: an IME interaction designer, an accessibility specialist, a visual
and product designer, a daily hold-mode power user, and an occasional tap-mode
user. Each worked from the same problem brief. The brief included the original
idea as one candidate, not as the plan.

## The problem

After the table grew to 1,978 sequences, the gap is **"I know the character,
not the keys."** Narrowing by keys helps when you remember the first key.
It is useless when you don't (≈: does it start with `~` or `=`?). Fast,
known use must cost nothing.

## What the platform allows

An IME extension has exactly one on-screen surface: the **system candidate
window** (the docs page for `chrome.input.ime` was read 2026-11-25).

- It is a vertical or horizontal list of rows, and the system owns placement
  and styling.
- Each row has `candidate`, `label`, `annotation` and an optional `usage`.
  Below the rows are auxiliary text and an "n of m" counter.
- There is a click event and no hover event. The extension can move the
  highlight.
- A separate browser window would take focus and end the input context.
- `setComposition` can show underlined text in the field.

## Verdict on the original idea

| Part of the idea | Verdict | Why |
|---|---|---|
| Trigger on holding Compose 150–200 ms | **Drop** | Hold mode keeps Compose down for the whole sequence, often 300–500 ms. Slow or one-finger typists hold every key long. Sticky Keys latches without holding. All five panellists rejected it independently. |
| Place itself away from important text | **Drop** | The system places the window. |
| Hover explains how to type it | **Drop** | There is no hover event. Put the keys in every row instead, so the list teaches without any action. |
| Click enters it | Keep, as a secondary path | Hands are on the keys; clicking teaches nothing. |
| Set shrinks as you type | Keep | |
| Switch to a compact layout when small | **Drop** | A layout that changes shape while being read is a moving target. Keep one orientation and let the row count shrink. |
| Default on, can be turned off | Keep | Only safe because the trigger below cannot fire during fluent typing. |
| Show glyphs from the start | **Drop** | 1,978 rows is noise. "I'd assume my keyboard had switched to Chinese." |

## Recommendation

### Two ways in

1. **Explicit: press Compose, then the Tab key.** (A key press, not a browser
   tab. In hold mode: Tab while Compose is held.) Tab also works at any point inside a sequence,
   and it opens the finder at once.
   - Checked: no shipped sequence uses Tab, the arrow keys, PageUp/Down or
     Return. The grep was tested against `<question>`, which occurs 46 times.
   - `?` is not free: 36 sequences start with it.
   - Today Tab mid-sequence commits any pending result and passes through, so
     no muscle memory is taken over.
   - A user's custom compose file *could* bind Tab. The loader should then
     warn and leave the finder off for that key.
2. **Dwell.** The timer runs while a sequence is open and no key has been
   pressed for *T*.
   - Default *T* is 1000 ms, adjustable, with "never" as an option.
   - The clock restarts on each real keystroke, never on Compose-down.
   - Compose auto-repeat, which ChromeOS sends as plain keydowns, must not
     restart it.
   - A false trigger costs a brief flash, never a wrong character, because of
     the rule below.

### The rule that keeps it out of the way

While the finder is showing results for a key prefix, **every printable key
means exactly what it would mean with the window hidden.** It continues the
sequence, and the list narrows or closes.

Only these keys are taken over:

- arrows and PageUp/Down;
- Enter, *after* an arrow has highlighted a row;
- clicks.

No row is highlighted until an arrow is pressed, except the pending result
of an ambiguous sequence. So Enter keeps its current meaning. There are no
digit shortcuts, because digits are sequence keys (`1 2` → ½). Escape always
closes and types nothing. Releasing Compose in hold mode behaves as today.

### What it shows

**Compose alone, after the dwell:** no glyphs. A one-line hint:
*"Type a first key, or Tab to find by name."* Whether the window can show
with no rows needs a hardware check. The fallback is a single row carrying
the hint.

**After one or more keys:** one row per reachable result, vertical, about
9 per page.

- **candidate:** the glyph. Invisible or combining output gets a visible
  stand-in (◌́, ⍽).
- **label:** the remaining keys.
- **annotation:** a short lowercase name.
- **order:** fewest remaining keys first, then table order. Ordering is
  stable, so the same prefix always lists the same way.
- **ambiguous prefixes:** the pending result is the first row, marked
  "release".
- **one result left:** show nothing; the user is about to finish.
- **many results:** when more than ~30 are reachable (`(` 114, `[` 110, `!` 73,
  `'` 68 …), group by next key instead. One row per next key, with sample
  glyphs and a count, e.g. `e` · é ê ë è · 6. This is the "compact as it
  shrinks" behaviour, done with content instead of layout.

Example rows after `Compose '`:

| label | candidate | annotation |
|---|---|---|
| `e` | é | e acute |
| `a` | á | a acute |
| `c` | ć | c acute |

Example rows after `Compose : -` (ambiguous):

| label | candidate | annotation |
|---|---|---|
| release | ÷ | division |
| `)` | 🙂 | slightly smiling |

**Search, after Tab:**

- The query is typed inline as underlined composition text, the only place
  inline text appears.
- Rows match by name or keyword, and each label shows the **full** sequence:
  `euro` → € with label `C =` (the first of six equivalent sequences).
- Emoji already have names. `Compose Compose name` stays as it is, and
  search covers the whole table.
- Escape leaves search.

**A name that is not an emoji:** Compose Compose starts an emoji name.
When the letters stop matching any emoji, they become a search query, so
Compose Compose `euro` lists €. (Added after a trial: having seen "euro"
in a search, the natural guess is to type it.) The cost: a mistyped emoji
name sends the following keys into the search, not the document. Escape
leaves it. A failed *ordinary* sequence still fails as before. Turning it
into a search would swallow the text of someone typing fast.

### Teaching

The label is the lesson: the keys are visible at the moment of choice.
Picking a row commits the glyph. The panel liked the idea of a brief "next
time: Compose C =" after picking a row, but there is no good place to show it
once the window has closed, so it is deferred.

### Outside the IME: a cheat-sheet page

Half of discoverability is a page we fully own and can make as pretty as we
like.

- It is a "Sequences" page in the extension, opened from the options page,
  and generated from the same tables as the README.
- **Search** by name or keyword, or **paste a character** to ask "how do I
  type ‰?".
- **Categories:** arrows, currency, maths, accented Latin, emoji.
- Each sequence is shown as keycaps.

This costs nothing on the typing path and has no hardware unknowns. It can
be built and tested now.

### Settings

- **"Show help when I pause during Compose"**: on, with a delay of 1 s and a
  "never" option.
- **"Compose, then Tab, opens the finder"**: on.

Nothing about position or appearance can be set, because the system owns it.

## Accessibility requirements

- Every row's annotation must make sense spoken. Spell out keys that
  synthesisers mangle ("apostrophe", not `'`).
- Use a fixed, small page size so the window stays inside a magnified
  viewport.
- No auto-dismiss timeout.
- The finder never takes focus.
- Waking the worker clears any stale window.
- Speak only while the finder is open, never on ordinary composing.

## Where the panel disagreed, and the resolution taken

- **Step 0 after a pause.** Positions ranged from nothing at all, unless
  asked (designer, power user), through the first-key index (interaction
  designer), to a small prompt (newcomer). Taken: a one-line hint pointing
  at Tab. It is the only thing at step 0 that helps someone who doesn't know
  the first key.
- **Inline composition text while composing.** It is good for screen-reader
  feedback, but it scared the newcomer ("will it be sent?"). Taken: inline
  text only in search mode. Revisit after the ChromeVox tests.

## Must be seen on a Chromebook before building the full finder

These are unknowns; nothing below has been observed.

1. Does the candidate window appear for an extension IME with no composition
   text? Where does it sit? Does it show with zero rows plus auxiliary text?
2. How do emoji and combining marks render in it? Is `usage` shown? Is a
   page size of 9 honoured? How wide can a label get?
3. With Right Alt held, what do Up, Down and Enter arrive as? ChromeOS may
   remap Alt+Up/Down to PageUp/Down (from recollection).
   **Seen (2026-11-25):** Right Alt + Tab reaches the extension, so search
   opens while Compose is held. Left Alt + Tab does not: ChromeOS keeps it
   for switching windows. This matters only with Left Alt as Compose.
4. Does a click commit without moving focus?
5. Does it work in Linux (Crostini) and Android app windows?
6. **ChromeVox:**
   - Are rows, labels, annotations and the "n of m" counter read?
   - Are they re-read after the highlight moves?
   - Is composition text announced?
7. Under Sticky Keys, which Right Alt events reach the IME?
8. Per-keystroke latency with the window updating during fast typing.
   Measure it with the existing debug log.

A throwaway spike can settle 1–5 and most of 6 in one sitting. Pressing Compose then Tab
would show a fixed set of rows, and arrows and a click would move and commit.

## Questions for the user

1. Is **Compose, then the Tab key** acceptable as the explicit way in?
2. What should search use for names?
   - **(a)** Only names already in the table: 2,552 of 2,619 lines carry a
     comment, mostly X11's capitalised Unicode names, cleaned to short
     lowercase. It is free, but the names are poor for "approx" or "thumbs".
   - **(b)** (a) plus a small hand-curated alias list.
   - **(c)** Bundle CLDR keyword annotations. This gives the best matches but
     adds size, and it means one more data source to keep current.
3. Should the order be cheat-sheet page first (no hardware unknowns), then the
   spike, then the finder? Or should the spike come first?

## Round two: usability sessions (2026-11-26)

Five simulated first-time users (`test/try.js`, given only a friend's
two-sentence explanation) all ranked the same problem first: **a wrong
guess silently ate their keys** (`Compose c v` + `estina` gave `estina`).
Next came the owner's own: Compose, Compose Compose, Compose Tab and the
pause did "subtly similar but different things". A designer, given the
findings rather than a solution, measured why a single entry point cannot
work: of 140 emoji names, 60 complete a different sequence on the way when
typed after one Compose (`fire` passes `fi` → ﬁ). So the model keeps two
ways in and one rule for mistakes:

- *Compose once, then keys; Compose twice or Compose Tab, then a name.*
  Compose Tab is now the same as Compose Compose.
- *Anything that doesn't match stays underlined, with suggestions.* No key
  is lost: with no row highlighted, the next key types what was typed plus
  itself; Enter, Space, release of a held Compose and blur type it as is.
  Letters that could still start a name keep going (`y e n` finds ¥), and
  then the first suggestion is highlighted.
- Backspace mid-sequence takes back one key; in a search the first result
  is highlighted (Enter takes it, Down goes to the second).
- Names show underlined while typed; typing a name lists every character
  called that, not only emoji (`pi` is π, not only 📌).
- Ranking: plain characters before styled variants (π before ℼ), one typo
  forgiven (`fier`), red heart before the card suit; after a pause, lower
  case and common characters first.

Left for later, by choice: holding Compose to type several characters (the
designer's advice: opt-in, after the owner's logs show how often keys roll
over), and a setting to switch off confusable sequences (≅ for ≈, `- -
Space` soft hyphen).

## Round three: one Compose, and cleaning up the table (2026-11-26)

The owner, after round two: Compose `p i` showed nothing while Compose
`y e n` showed a list ("makes sense if you memorised the tables, otherwise
arbitrary"); `v c` worked but `c v` did not, while `" a` and `a "` both
did; and Compose versus Compose Compose was easy to explain but hard to
form habits for. A typographer and an interaction designer were given the
problem and measurements; two panels of simulated users (four, then three,
none of whom had seen earlier rounds) tried the result.

**Model.** *After Compose, type keys or a name. A key sequence counts as
soon as it is typed; a name counts when it ends. Anything else stays
underlined with suggestions.* Compose Compose and Compose Tab ask for a name
or a search.

- A sequence of letters that a name could continue waits for the next key,
  showing its character (Compose `m u`: µ, for `multiplication`). No timeout
  by default: both experts advised against one, and the panels confirmed it
  (a pause inside `thumbs` typed þ, a pause after `pin` typed 📌 when `pint`
  was meant, and Enter after a pause sent half a message). It is an option.
- Enter after a name, a search or a mistake never passes through (it would
  send a message); after a waiting key sequence (° in `o o`, which waits for
  `oops`) it types it and then acts as Enter, since the character is on
  screen already.
- Sequences of three or more lowercase letters (`sum`, `del`, `inf`) became
  names: as sequences they committed inside words (`delta` gave ∇ta).
- The pause list never hides itself, whatever the letters start.

**Table** (`sequences/00-fixes.compose` wins over every source;
`00-retired.compose` removes from all): accents commute with letters
(114 mirrors), nine pairs that disagreed by order now agree, letters are
never accents (the c/v caron and b/u breve rows are retired; `<` is caron,
`U` or `(` breve, `:` a second diaeresis), `*` is Greek, ligatures and
invisibles that were easy to type by accident are retired, and retired
characters stay reachable by name. A retired sequence typed out of habit is
offered first with its new keys. The generator refuses a letter sequence
that is also the name of a different character.

**Names.** Greek letters by name (and capitals: `Delta` Δ), LaTeX names
(`pm`, `infty`, `Rightarrow`), phrases (`thumbs up`), coloured hearts. A
misspelt name is offered fixed; a name and a letter or two (`pushpins`) is
offered as the emoji and those letters.

Still open: holding Compose for several characters in one hold (testers
expected it; opt-in, if at all); `~ =` gives ≅ where people expect ≈;
subscript letters by name; and nothing shows after the first key of a
sequence, which two testers noticed.

**Rulings after the round** (owner question, then both experts): a name is
typed at its last letter when no longer name means something else (`yen`
¥; `pin` waits for `pint`), as key sequences are; Enter completes an
unambiguous start (`multip` ×), Space and punctuation keep what was typed;
typed names are single words, one character each, chosen by the generator
(`typed_names`), and everything else is a search word that Enter can take
from the suggestions. Cost accepted: a word that merely starts with a name
gives the character and the rest (`yenta` ¥ta, `infity` ∞ity). `~ =` became
≈ (≅ is `= ~`).
