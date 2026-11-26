/*
 * Sequence finder: shows, in the system candidate window, which characters
 * can still be reached from the keys typed so far, and searches the table by
 * name. Loaded by service_worker.js (importScripts), so it shares its globals:
 * states, rootState, composing, held, contextID, builtinSequences, ...
 *
 * The rule that keeps it out of the way of fast typing: a key that continues
 * the sequence always continues it, whether or not the window is showing.
 * The finder only takes keys that would otherwise end the sequence (Tab,
 * arrows, Page Up/Down, and Enter once a row is highlighted), and the window
 * only appears after a pause (finderDelayMs) or on Tab. A window that shows
 * at the wrong moment costs a flash, never a wrong character.
 *
 * See docs/finder-design.md for why it works this way.
 */
'use strict';

const FINDER_PAGE = 9;
/** Above this many reachable results, list next keys instead of results. */
const FINDER_GROUP_OVER = 30;
const FINDER_NAME_MAX = 24;

/** Pause before the window appears; -1 = only on Tab. From sync storage. */
let finderDelayMs = 1000;
/** Whether Tab inside a sequence opens the search. From sync storage. */
let finderTab = true;
/**
 * A result waiting for the next key (µ after "m u", which could still become
 * "multiplication"; a whole name such as "pin") is typed by itself after this
 * long; -1: it waits for the next key, however long. From sync storage.
 * Longer than finderDelayMs, so the list shows first.
 */
let finderCommitDelayMs = -1;
let finderCommitTimer = null;

/** (Re)starts the wait after which a waiting result is typed by itself. */
function finderArmCommit() {
  clearTimeout(finderCommitTimer);
  finderCommitTimer = null;
  if (finderCommitDelayMs < 0 || !composing) return;
  // What is waiting, not how it is shown: the list opening is not a key.
  const waiting = () => finderSignature() + (finder && finder.mode === 'name' ? finder.query : '');
  const sig = waiting();
  const ready = finder && finder.mode === 'name' ? nameFor(finder.query) !== null :
      (!finder || finder.mode === 'list') && heldResult() !== null;
  if (!ready) return;
  finderCommitTimer = setTimeout(() => {
    finderCommitTimer = null;
    if (waiting() !== sig || !composing) return;
    logEvent('finder', 'waiting result typed after the pause');
    if (finder && finder.mode === 'name') {
      finderSettleName('', {});
    } else {
      const h = heldResult();
      if (!h) return;
      finderEndComposition();
      commitHeld(h, '', {});
    }
  }, finderCommitDelayMs);
}

/**
 * What the window shows, or null when it is hidden. Persisted in session
 * storage, so a worker restart mid-search resumes it.
 * @type {?{mode: string, query: string, page: number, highlight: ?number}}
 */
let finder = null;

/** Rows currently shown (derived from `finder` and `states`; not persisted). */
let finderRows = [];
let finderTimer = null;
/** The engine that last sent a key event; needed to show the window. */
let finderEngineID = null;
/** Composition state at the last update, to tell progress from repeats. */
let finderSig = '';
/** output -> {keys, result, name, keywords}: what the live tree can type. */
let finderIndex = null;

function setFinder(value) {
  chrome.storage.session.set({'finder': value});
  finder = value;
}

/** Ignores failures: the window is a hint, never on the path to typing. */
function imeCall(method, params) {
  const fn = chrome.input.ime[method];
  if (typeof fn !== 'function') return;
  try {
    const p = fn.call(chrome.input.ime, params);
    if (p && typeof p.catch === 'function') {
      p.catch((e) => dbg('   finder:', method, 'failed:', String(e)));
    }
  } catch (e) {
    dbg('   finder:', method, 'threw:', String(e));
  }
}

/** A keysym as the user would read it on a key label. */
function symLabel(sym) {
  if (sym === 'Multi_key') return 'Compose';
  if (sym === 'space') return '␣';
  const key = symToEvent(sym).key;
  return [...key].length === 1 ? key : sym;
}

/**
 * Keys as one label: "C =", "e '", "Compose fire". A run of three or more
 * letters (an emoji name) is written as a word; anything else is spaced, so
 * that "1 2" does not read as twelve.
 */
function keysLabel(syms) {
  const parts = syms.map(symLabel);
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) out.push(run.join(''));
    else out.push(...run);
    run = [];
  };
  for (const p of parts) {
    if (/^[a-z]$/i.test(p)) {
      run.push(p);
    } else {
      flush();
      out.push(p);
    }
  }
  flush();
  return out.join(' ');
}

function resultText(result) {
  return result.string !== null ? result.string : result.keysym;
}

/** What a row shows for a character that would otherwise look empty. */
function visibleGlyph(text) {
  if (/^\s+$/u.test(text)) return '⍽';
  if (/^\p{M}/u.test(text)) return '◌' + text;
  return text;
}

/**
 * Reachable results below `starts`, shortest first, one per output.
 * @param {!Array<!EventState>} starts
 * @param {number} limit stop after this many
 * @return {!Array<{result: !Result, syms: !Array<string>}>}
 */
function reachable(starts, limit = Infinity) {
  const seen = new Set();
  const found = [];
  let level = starts.map((s) => ({state: s, syms: []}));
  const visited = new Set(starts);
  while (level.length > 0 && found.length < limit) {
    const next = [];
    for (const {state, syms} of level) {
      for (const [sym, children] of Object.entries(state.nextKeys)) {
        for (const child of children) {
          if (visited.has(child)) continue;
          visited.add(child);
          const s = [...syms, sym];
          if (child.result) {
            const text = resultText(child.result);
            if (!seen.has(text)) {
              seen.add(text);
              found.push({result: child.result, syms: s});
              if (found.length >= limit) return found;
            }
          }
          next.push({state: child, syms: s});
        }
      }
    }
    level = next;
  }
  return found;
}

/**
 * Names and keywords of the built-in table, by output, with the table
 * position: the table lists common characters first, which makes a better
 * tie-break than anything computed here. The generator writes name and
 * keywords on the first row of each output only.
 */
function builtinMeta() {
  const meta = new Map();
  builtinSequences.forEach((row, i) => {
    if (!meta.has(row[1])) {
      // Characters named by hand rank in names.tsv order, before the rest.
      const rank = row[4] || 0;
      const typed = row[5] ? row[5].split(' ') : [];
      meta.set(row[1], {name: row[2] || '', aliases: row[3] || '', primary: typed[0] || '', typed,
                        curated: rank > 0, order: rank > 0 ? rank : 100000 + i});
    }
  });
  return meta;
}

/**
 * Everything the live tree (built-in plus the user's file) can type, each
 * with the sequence to teach: the user's own, if their file defines one
 * (they chose it), else the shortest.
 */
function buildFinderIndex() {
  const meta = builtinMeta();
  const best = new Map();
  let level = (rootState.nextKeys['Multi_key'] || []).map((s) => ({state: s, syms: []}));
  const visited = new Set();
  while (level.length > 0) {
    const next = [];
    for (const {state, syms} of level) {
      for (const [sym, children] of Object.entries(state.nextKeys)) {
        for (const child of children) {
          if (visited.has(child)) continue;
          visited.add(child);
          const s = [...syms, sym];
          if (child.result) {
            const text = resultText(child.result);
            const b = best.get(text);
            if (!b || (b.builtin && !child.builtin)) {
              best.set(text, {keys: s, result: child.result, builtin: child.builtin});
            }
          }
          next.push({state: child, syms: s});
        }
      }
    }
    level = next;
  }
  // For a built-in character, teach the table's own first sequence ("o o"
  // for °, not whichever the walk met first), if the live tree still types it.
  const first = new Map();
  for (const row of builtinSequences) {
    if (!first.has(row[1])) first.set(row[1], []);
    first.get(row[1]).push(row[0]);
  }
  finderVariants = new Map();  // text -> every live key sequence (syms)
  for (const [text, list] of first) {
    for (const keys of list) {
      const syms = keys.length ? keysToSyms(keys) : null;
      if (syms && typesWith(syms) === text) {
        if (!finderVariants.has(text)) finderVariants.set(text, []);
        finderVariants.get(text).push(syms);
      }
    }
  }
  for (const [text, b] of best) {
    if (!b.builtin) continue;
    for (const keys of first.get(text) || []) {
      const syms = keysToSyms(keys);
      if (syms && typesWith(syms) === text) {
        b.keys = syms;
        break;
      }
    }
  }
  // Characters typed by name only (no keys) are in the index too.
  for (const text of meta.keys()) {
    if (!best.has(text)) best.set(text, {keys: null, result: new Result(text, null), builtin: true});
  }
  finderIndex = new Map();
  for (const [text, b] of best) {
    const m = meta.get(text) ||
        {name: '', aliases: '', primary: '', typed: [], curated: false, order: Infinity};
    const aliases = m.aliases ? m.aliases.toLowerCase().split('|') : [];
    const rawAliases = m.aliases ? m.aliases.split('|').filter((a) => /^[A-Z]/.test(a)) : [];
    finderIndex.set(text, {
      keys: b.keys, result: b.result, name: m.name, order: m.order,
      curated: m.curated, aliases, rawAliases, primary: m.primary, typed: m.typed,
      search: [m.name.toLowerCase(), ...aliases, m.primary].join('|'),
    });
  }
  finderNames = null;
}

/**
 * Names typed after Compose: single lowercase words of three letters or more
 * (capitals and digits are always keys). Each maps to one character: the one
 * whose own name it is, else the highest ranked.
 */
let finderNames = null;
let finderVariants = null;
function namesIndex() {
  if (finderNames) return finderNames;
  if (!finderIndex) buildFinderIndex();
  // The generator decides which words are names, one character each
  // (tools/gen-sequences.py, typed_names); everything else is searched.
  const best = new Map();
  for (const [text, e] of finderIndex) {
    // A character's own (first) name ranks before its other names.
    (e.typed || []).forEach((w, i) => best.set(w, {text, score: e.order + (i ? 1e6 : 0)}));
  }
  finderNames = {map: best, sorted: [...best.keys()].sort()};
  return finderNames;
}

/** The character a whole name stands for, or null. */
function nameFor(word) {
  const e = namesIndex().map.get(word);
  return e ? e.text : null;
}

/** Is `prefix` the start of some name (`longer`: of a longer name)? */
function startsName(prefix, longer = false) {
  const {sorted} = namesIndex();
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < prefix) lo = mid + 1; else hi = mid;
  }
  for (let i = lo; i < sorted.length && sorted[i].startsWith(prefix); i++) {
    if (!longer || sorted[i] !== prefix) return true;
  }
  return false;
}

/** The label that teaches a character: its keys, or Compose and its name. */
function teachLabel(e) {
  return e.keys ? fullLabel(e.keys) : 'Compose ' + (e.primary || e.name);
}

/** Table keys (characters, "Multi_key") as keysyms; null if one is odd. */
function keysToSyms(keys) {
  const out = [];
  for (const key of keys) {
    const syms = key === 'Multi_key' ? ['Multi_key'] :
        eventToSyms({key, location: KBE_DOM_KEY_LOCATION_STANDARD});
    if (syms.length !== 1) return null;
    out.push(syms[0]);
  }
  return out;
}

/** What Compose followed by `syms` types in the live tree, or null. */
function typesWith(syms) {
  let nodes = rootState.nextKeys['Multi_key'] || [];
  for (const sym of syms) nodes = nodes.flatMap((n) => n.nextKeys[sym] || []);
  const r = nodes.map((n) => n.result).filter(Boolean).pop();
  return r ? resultText(r) : null;
}

function nameOf(text) {
  if (!finderIndex) buildFinderIndex();
  const e = finderIndex.get(text);
  if (e && e.name) return e.name.slice(0, FINDER_NAME_MAX);
  const cp = text.codePointAt(0);
  return cp > 0x7f ? 'U+' + cp.toString(16).toUpperCase().padStart(4, '0') : '';
}

function orderOf(text) {
  if (!finderIndex) buildFinderIndex();
  const e = finderIndex.get(text);
  return e ? e.order : Infinity;
}

/** A full sequence as a label: "Compose C =", "Compose Compose heart". */
function fullLabel(syms) {
  return keysLabel(['Multi_key', ...syms]);
}

/** True right after Compose, before any key of a sequence. */
function atComposeOnly() {
  return states.length === 1 && states[0].path.length === 1 &&
      states[0].path[0][0] === 'Multi_key';
}

const HINT_ROW = Object.freeze(
    {kind: 'hint', candidate: '⇥', label: 'Tab', annotation: 'find by name'});
const NAME_HINT_ROW = Object.freeze(
    {kind: 'hint', candidate: '…', label: '', annotation: 'type a name: euro, heart'});

/**
 * Rows for a name: what Compose and the same keys give, if anything, first
 * (Compose pressed twice by accident: Compose Compose o o offers °), then
 * everything called that.
 */
function nameRows(name) {
  // While a name is typed, names that start with it come first: the exact
  // one, then the shortest ("ca": cat, cafe, cake), then other matches.
  const {sorted, map} = namesIndex();
  const starts = [];
  if (/^[a-z]+$/.test(name)) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < name) lo = m + 1; else hi = m; }
    for (let i = lo; i < sorted.length && sorted[i].startsWith(name); i++) starts.push(sorted[i]);
    starts.sort((a, b) => a.length - b.length || map.get(a).score - map.get(b).score);
  }
  // Before those: characters called exactly that ("pi": π, greek pi).
  const exact = [];
  for (const [text, e] of finderIndex) {
    if (e.aliases.includes(name) || wordScore(e.name.toLowerCase(), name) === 0) exact.push(text);
  }
  const rank = new Map(searchRows(name).filter((r) => r.kind === 'result')
      .map((r, i) => [resultText(r.result), i]));
  exact.sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
  const seen = new Set();
  const rows = [];
  const own = nameFor(name) || nameCompletion(name);
  if (own) exact.unshift(own);
  for (const text of [...new Set(exact)].slice(0, 3)) {
    seen.add(text);
    const e = finderIndex.get(text);
    rows.push({kind: 'result', result: e.result, candidate: visibleGlyph(text),
               label: teachLabel(e), annotation: nameOf(text)});
  }
  for (const w of starts) {
    const text = map.get(w).text;
    if (seen.has(text)) continue;
    seen.add(text);
    const e = finderIndex.get(text);
    rows.push({kind: 'result', result: e.result, candidate: visibleGlyph(text),
               label: e.keys ? teachLabel(e) : 'Compose ' + w, annotation: nameOf(text)});
  }
  for (const r of searchRows(name)) {
    if (r.kind === 'result' && !seen.has(resultText(r.result))) {
      seen.add(resultText(r.result));
      rows.push(r);
    }
  }
  // Not when the keys are themselves a name ("oo" is ꝏ, "pi" is π).
  const syms = isWholeName(name) ? null : keysToSyms([...name]);
  const single = syms && typesWith(syms);
  if (single) {
    const i = rows.findIndex((r) => resultText(r.result) === single);
    const row = i >= 0 ? rows.splice(i, 1)[0] :
        {kind: 'result', result: finderIndex.get(single).result,
         candidate: visibleGlyph(single), annotation: nameOf(single)};
    row.label = fullLabel(syms);
    rows.unshift(row);
  }
  return rows.length ? rows :
      [{kind: 'hint', candidate: '∅', label: '', annotation: 'nothing found'}];
}

/** The name being typed (name mode), or null. */
function typedName() {
  return finder && finder.mode === 'name' ? finder.query : null;
}

/** The keys typed since Compose, if all lowercase letters, else null. */
function typedLetters() {
  const t = typedSoFar();
  return t && /^[A-Za-z][a-z]*$/.test(t) ? t : null;
}

/** The keys typed since Compose, as text; null if one is not a character. */
function typedSoFar() {
  if (states.length === 0) return '';
  const keys = states[0].path.slice(1).map(([sym]) =>
      sym === 'Multi_key' ? null : symToEvent(sym).key);
  return keys.every((k) => k !== null && [...k].length === 1) ? keys.join('') : null;
}

/** Rows for "what can I reach from here". */
function listRows() {
  if (atComposeOnly()) return finderTab ? [HINT_ROW] : [];
  const rows = [];
  const h = heldResult();
  if (h !== null) {
    const text = resultText(h.result) + h.tail;
    rows.push({kind: 'held', candidate: visibleGlyph(text), label: 'Enter',
               annotation: nameOf(resultText(h.result)), held: h});
  }
  const found = reachable(states);
  const nextKeys = new Set(states.flatMap((s) => Object.keys(s.nextKeys)));
  // Grouping by next key only helps if groups hold several results each
  // ("(" leads to 114 through a few keys; "'" to 68 through 60 keys).
  if (found.length > FINDER_GROUP_OVER && nextKeys.size * 2 <= found.length) {
    // Too many to read: one row per next key, with samples and a count.
    const groups = new Map();
    for (const s of states) {
      for (const [sym, children] of Object.entries(s.nextKeys)) {
        const g = groups.get(sym) || {sym, children: []};
        g.children.push(...children);
        groups.set(sym, g);
      }
    }
    const grouped = [...groups.values()].map((g) => {
      const all = reachable(g.children);
      for (const c of g.children) {
        if (c.result) all.unshift({result: c.result, syms: []});
      }
      return {g, all};
    });
    grouped.sort((a, b) => b.all.length - a.all.length);
    for (const {g, all} of grouped) {
      rows.push({
        kind: 'group', sym: g.sym, children: g.children,
        candidate: all.slice(0, 4).map((r) => visibleGlyph(resultText(r.result))).join(' '),
        label: symLabel(g.sym), annotation: String(all.length),
      });
    }
    return rows;
  }
  // Fewest keys left first; then lower case before capitals (ü before Ü);
  // then common characters (names.tsv order, then table order).
  const isUpper = (text) => text !== text.toLowerCase();
  const notLetter = (text) => /^\p{L}/u.test(text) ? 0 : 1;
  found.sort((a, b) => a.syms.length - b.syms.length ||
      notLetter(resultText(a.result)) - notLetter(resultText(b.result)) ||
      isUpper(resultText(a.result)) - isUpper(resultText(b.result)) ||
      orderOf(resultText(a.result)) - orderOf(resultText(b.result)));
  for (const {result, syms} of found) {
    const text = resultText(result);
    rows.push({kind: 'result', result, candidate: visibleGlyph(text),
               label: keysLabel(syms), annotation: nameOf(text)});
  }
  // The list never hides itself: whether help appears must not depend on
  // whether the letters happen to start some longer sequence (Compose p i
  // waited for "p i n t" and showed nothing, Compose y e listed ¥). Letters
  // may also be the start of a name.
  const letters = finderTab ? typedLetters() : null;
  if (letters) {
    const seen = new Set(rows.map((r) => r.result && resultText(r.result)));
    for (const r of searchRows(letters)) {
      if (r.kind === 'result' && !seen.has(resultText(r.result))) rows.push(r);
    }
  }
  return rows;
}

/**
 * Rows for a name search. Every word of the query must match a word of the
 * entry's name or aliases, in any order. Ranked by tier: the exact name or
 * an exact alias first, then by how well each word matches (whole word,
 * start of a word, anywhere), with the display name counting for more than
 * the aliases. Ties go to entries named by hand in names.tsv, then to
 * table order (common characters first), then to shorter sequences.
 */
function searchRows(query) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w);
  if (words.length === 0) {
    return [NAME_HINT_ROW];
  }
  if (!finderIndex) buildFinderIndex();
  const q = words.join(' ');
  // A capital in the query ("E") puts capitals first.
  const cased = /\p{Lu}/u.test(query) ? query.trim() : null;
  const scored = [];
  for (const [text, e] of finderIndex) {
    const name = e.name.toLowerCase();
    let score;
    if (name === q) {
      score = 0;
    } else if (e.aliases.includes(q)) {
      score = 1;
    } else {
      score = 2;
      for (const w of words) {
        let s = Math.min(wordScore(name, w), wordScore(e.search, w) + 1);
        // One typo in a longer word ("fier") beats matching it inside
        // another word ("modifier").
        if (s >= 4 && w.length >= 4 && hasOneEdit(e.search, w)) s = 3;
        if (s === Infinity) { score = Infinity; break; }
        score += s;
      }
    }
    if (score === Infinity) continue;
    if (cased !== null && !e.name.includes(cased) && !text.includes(cased)) score += 0.5;
    // Styled variants (ℼ double-struck pi, 🂱 ace of hearts) after the
    // plain character, unless the query asks for the style.
    const v = e.search.match(VARIANT);
    if (v && !q.includes(v[0])) score += 1.5;
    scored.push({text, e, score});
  }
  scored.sort((a, b) => a.score - b.score || b.e.curated - a.e.curated ||
      a.e.order - b.e.order || a.e.keys.length - b.e.keys.length);
  if (scored.length === 0) {
    return [{kind: 'hint', candidate: '∅', label: '', annotation: 'nothing found'}];
  }
  return scored.map(({text, e}) => ({
    kind: 'result', result: e.result, candidate: visibleGlyph(text),
    label: teachLabel(e), annotation: nameOf(text),
  }));
}

const VARIANT = /double-struck|mathematical|modifier|playing card|fullwidth|circled|parenthesized|superscript|subscript|small capital|combining|reversed|turned/;

/** Is some word of `search` one typo (a letter added, dropped or changed)
 * away from `w`? */
function hasOneEdit(search, w) {
  return search.split(/[\s|-]+/).some((x) => oneEdit(w, x));
}

/** One letter added, dropped, changed, or two neighbours swapped ("fier"). */
function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1) ||
        (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * How well `w` matches inside `text` (words separated by space, "-" or "|"):
 * 0 a whole word, 2 the start of a word, 4 anywhere. Short query words must
 * match more strictly, or "a" would match everything: one character only as
 * a whole word, two only at the start of a word. Infinity: no match.
 */
function wordScore(text, w) {
  let best = Infinity;
  for (let i = text.indexOf(w); i >= 0 && best > 0; i = text.indexOf(w, i + 1)) {
    const atStart = i === 0 || /[\s|-]/.test(text[i - 1]);
    const end = i + w.length;
    const atEnd = end === text.length || /[\s|-]/.test(text[end]);
    const s = atStart ? (atEnd ? 0 : 2) : 4;
    if (s === 0 || (s === 2 && w.length >= 2) || (s === 4 && w.length >= 3)) {
      best = Math.min(best, s);
    }
  }
  return best;
}

// Keys that are easy to hit for each other: the shifted and unshifted
// halves of a key, and next-door keys used for accents.
const SLIPS = Object.freeze({
  ';': ':\'', ':': ';"', "'": '";', '"': "':", ',': '<', '<': ',', '.': '>',
  '>': '.', '-': '_', '_': '-', '=': '+', '+': '=', '/': '?', '?': '/',
  '`': '~', '~': '`', '[': '{', '{': '[', ']': '}', '}': ']', '\\': '|',
  '|': '\\', '^': '6', '*': '8',
});

/**
 * Rows for a sequence that matched nothing ("undecided"): what the user
 * probably meant. Near misses first (the keys in another order, a slipped
 * key, one key different), then characters whose name starts with what was
 * typed; the other way round once the user is evidently typing a name.
 */
function undecidedRows(buffer, named) {
  if (!finderIndex) buildFinderIndex();
  const keys = [...buffer];
  const syms = keysToSyms(keys);
  const near = [];
  const seen = new Set();
  const add = (s) => {
    const text = s && typesWith(s);
    if (text && !seen.has(text)) {
      seen.add(text);
      near.push({text, syms: s});
    }
  };
  // A retired sequence typed out of habit (or in the other order): what it
  // used to type comes first, with its keys now ("c s": š, Compose < s).
  if (keys.length <= 3) {
    for (const p of permutations(keys)) {
      for (const [k, out] of retiredSequences) {
        if (k.join('\u0001') === p.join('\u0001')) {
          const e = finderIndex.get(out);
          if (e && !seen.has(out)) { seen.add(out); near.push({text: out, syms: e.keys}); }
        }
      }
    }
  }
  if (syms) {
    // Other orders.
    if (keys.length <= 3) {
      for (const p of permutations(syms)) add(p);
    }
    // A slipped key, or the wrong case.
    keys.forEach((k, i) => {
      const alts = (SLIPS[k] || '') + (k.toLowerCase() !== k ? k.toLowerCase() : k.toUpperCase());
      for (const a of alts) {
        if (a === k) continue;
        const s = keysToSyms([...keys.slice(0, i), a, ...keys.slice(i + 1)]);
        add(s);
        if (s && s.length === 2) add([s[1], s[0]]);
      }
    });
    // One key different.
    const subs = [];
    for (const [text, e] of finderIndex) {
      if (seen.has(text)) continue;
      // Any of the ways to type it, not only the one taught ("c <" for č).
      for (const v of finderVariants.get(text) || (e.keys ? [e.keys] : [])) {
        if (v.length !== syms.length) continue;
        let diff = 0;
        for (let i = 0; i < syms.length && diff < 2; i++) diff += v[i] !== syms[i];
        if (diff === 1) { subs.push(e); break; }
      }
    }
    // Accented forms of a letter that was typed first ("c v": č before ↵).
    const typedLetters = new Set(keys.filter((k) => /\p{L}/u.test(k)).map((k) => k.toLowerCase()));
    const base = (e) => {
      const text = resultText(e.result);
      const b = text.normalize('NFD')[0].toLowerCase();
      return typedLetters.has(b) && text.length === 1 && text !== b ? 0 : 1;
    };
    subs.sort((a, b) => base(a) - base(b) || a.order - b.order);
    for (const e of subs) add(e.keys);
  }
  const nearRows = near.map(({text, syms: s}) => ({
    kind: 'result', result: finderIndex.get(text).result, candidate: visibleGlyph(text),
    label: s ? fullLabel(s) : teachLabel(finderIndex.get(text)), annotation: nameOf(text),
  }));
  const nameRows = /^[\p{L}\p{N}]{2,}$/u.test(buffer) ?
      searchRows(buffer).filter((r) => r.kind === 'result' &&
                                      !seen.has(resultText(r.result))) : [];
  // A name and a letter or two more ("pushpins"): the name and those
  // letters, highlighted, first; then a name one typo away.
  const stem = named ? nameStem(buffer) : null;
  if (stem) {
    const text = nameFor(stem) + buffer.slice(stem.length);
    nameRows.unshift({kind: 'result', result: new Result(text, null), candidate: text,
                      label: 'Compose ' + stem + ' ' + buffer.slice(stem.length),
                      annotation: nameOf(nameFor(stem)) + ' +' + buffer.slice(stem.length)});
  }
  const typo = named && !stem ? typoName(buffer) : null;
  if (stem && typo === null) nameRows.push(nameRows.shift());  // a choice, not the default
  if (typo) {
    const text = nameFor(typo);
    const i = nameRows.findIndex((r) => resultText(r.result) === text);
    const e = finderIndex.get(text);
    const row = i >= 0 ? nameRows.splice(i, 1)[0] :
        {kind: 'result', result: e.result, candidate: visibleGlyph(text), annotation: nameOf(text)};
    row.label = 'Compose ' + typo;
    nameRows.unshift(row);
  }
  const rows = named ? [...nameRows, ...nearRows] : [...nearRows, ...nameRows];
  return rows.length ? rows :
      [{kind: 'hint', candidate: '∅', label: '', annotation: 'no match'}];
}

/** Are these keys a retired sequence, in either order? */
function isRetired(text) {
  const keys = [...text];
  if (keys.length > 3) return false;
  for (const p of permutations(keys)) {
    if (retiredSequences.some(([k]) => k.join('\u0001') === p.join('\u0001'))) return true;
  }
  return false;
}

function* permutations(list) {
  if (list.length <= 1) {
    yield list.slice();
    return;
  }
  for (let i = 0; i < list.length; i++) {
    const rest = [...list.slice(0, i), ...list.slice(i + 1)];
    for (const p of permutations(rest)) yield [list[i], ...p];
  }
}

/** Could `prefix` be the start of a name? (Words of names and aliases.) */
function startsAName(prefix) {
  if (!finderIndex) buildFinderIndex();
  if (!finderWords) {
    finderWords = new Set();
    for (const e of finderIndex.values()) {
      for (const w of e.search.split(/[\s|-]+/)) if (w) finderWords.add(w);
    }
  }
  const p = prefix.toLowerCase();
  for (const w of finderWords) if (w.startsWith(p)) return true;
  return false;
}
let finderWords = null;

/** A name one typo away from `word` ("fier": fire), for words of four
 * letters or more; null if none, or if `word` is itself a name. */
function typoName(word) {
  if (word.length < 4 || !/^[a-z]+$/.test(word) || nameFor(word)) return null;
  // The likeliest of those one typo away. The first letter is rarely the
  // mistake ("hart" is not "part"); a letter left out or two swapped is
  // likelier than a wrong one ("hart" is heart, not harr ↔); then rank.
  const {sorted, map} = namesIndex();
  const kind = (t) => t.length > word.length ? 0 : t.length === word.length &&
      [...t].sort().join('') === [...word].sort().join('') ? 0 : t.length < word.length ? 1 : 2;
  let best = null;
  for (const t of sorted) {
    if (t[0] !== word[0] || Math.abs(t.length - word.length) > 1 || !oneEdit(word, t)) continue;
    if (best === null || kind(t) < kind(best) ||
        (kind(t) === kind(best) && map.get(t).score < map.get(best).score)) best = t;
  }
  return best;
}

/** The longest name that `word` starts with, followed by one or two more
 * letters ("pushpins": pushpin), or null. */
function nameStem(word) {
  if (!/^[a-z]+$/.test(word)) return null;
  for (let n = word.length - 1; n >= Math.max(2, word.length - 2); n--) {
    if (nameFor(word.slice(0, n))) return word.slice(0, n);
  }
  return null;
}

/** Is `text` a whole word of some name or alias ("yen", "heart")? */
function isWholeName(text) {
  startsAName('');  // builds finderWords
  return finderWords.has(text.toLowerCase());
}

function finderComputeRows() {
  if (!finder) return [];
  if (finder.mode === 'search') {
    return finder.named ? nameRows(finder.query) : searchRows(finder.query);
  }
  if (finder.mode === 'undecided') return undecidedRows(finder.query, finder.named);
  if (finder.mode === 'name') return finder.query ? nameRows(finder.query) : [NAME_HINT_ROW];
  return listRows();
}

function auxText(rows) {
  const pages = Math.ceil(rows.length / FINDER_PAGE);
  const where = pages > 1 ? `  ${finder.page + 1}/${pages}` : '';
  if (finder.mode === 'search') return '↑↓ Enter · Esc' + where;
  if (finder.mode === 'undecided') {
    return (finder.highlight === null ?
        'no such sequence · Enter: as typed · ↓: pick' : '↑↓ Enter · Esc') + where;
  }
  if (finder.mode === 'name') {
    return (finder.highlight !== null ?
        (nameFor(finder.query) ? 'Space or Enter: take ▸' : 'Enter: take ▸ · Space: as typed') :
        'Space or Enter: as typed · ↓: pick') + where;
  }
  if (finder.mode === 'undecided' && finder.highlight !== null) {
    return 'Enter: take ▸ · Space: as typed · Esc: cancel' + where;
  }
  return (finderTab ? 'Tab: find by name' : 'Esc cancels') + where;
}

function finderRender() {
  if (!finder || contextID === 0 || finderEngineID === null) return;
  if (!finder.visible) {
    const q = finder.query;
    imeCall('setCandidateWindowProperties', {engineID: finderEngineID, properties: {visible: false}});
    if (q) {
      imeCall('setComposition', {contextID, text: q, cursor: q.length,
                                 segments: [{start: 0, end: q.length, style: 'underline'}]});
    } else {
      imeCall('clearComposition', {contextID});
    }
    return;
  }
  const rows = finderRows;
  const first = finder.page * FINDER_PAGE;
  const slice = rows.slice(first, first + FINDER_PAGE);
  imeCall('setCandidates', {
    contextID,
    candidates: slice.map((r, i) => ({
      candidate: r.candidate, id: first + i,
      label: r.label, annotation: r.annotation,
    })),
  });
  imeCall('setCandidateWindowProperties', {
    engineID: finderEngineID,
    properties: {
      visible: true, vertical: true, pageSize: FINDER_PAGE,
      cursorVisible: finder.highlight !== null,
      auxiliaryText: auxText(rows), auxiliaryTextVisible: true,
      windowPosition: 'cursor',
    },
  });
  if (finder.highlight !== null) {
    imeCall('setCursorPosition', {contextID, candidateID: finder.highlight});
  }
  if (finder.mode !== 'list') {
    const q = finder.query;
    if (q) {
      imeCall('setComposition', {
        contextID, text: q, cursor: q.length,
        segments: [{start: 0, end: q.length, style: 'underline'}],
      });
    } else {
      imeCall('clearComposition', {contextID});
    }
  }
  dbg('   finder:', finder.mode, JSON.stringify(finder.query || ''),
      rows.length, 'rows, page', finder.page, 'highlight', finder.highlight);
  // Counts and positions only: neither the query nor the rows are logged.
  logEvent('finder', `${finder.mode} ${rows.length} rows, page ${finder.page},` +
           ` highlight ${finder.highlight}`);
}

/** Shows (or refreshes) the window for the current mode. */
function finderShow(mode, query = '', named = false, visible = false) {
  clearTimeout(finderTimer);
  finderTimer = null;
  // A name being typed shows only in the field; the list comes after a
  // pause (or at once after Compose Compose, which asks for a name).
  const shown = mode !== 'name' || visible || named ||
      (finder !== null && finder.mode === 'name' && finder.visible);
  setFinder({mode, query, named, page: 0, highlight: null, visible: shown});
  finderRows = finderComputeRows();
  if (finderRows.length === 0) {
    finderClose();
    return;
  }
  // Narrowing changes the rows: start again from the top. In a search, the
  // first result is highlighted, so Enter takes it and Down goes to the
  // second; in a list, nothing is, so that Enter keeps its usual meaning.
  finder.page = 0;
  // After a sequence that matched nothing, only once a whole name has been
  // typed ("yen", "heart"): highlighting from the first matching letters
  // made Enter give ✔ at "hea", and switch meaning between keystrokes.
  // A name highlights nothing: Space and Enter take the name typed, at any
  // speed, whether or not the list is showing.
  const pick = mode === 'search' ||
      (mode === 'name' && finder.query && (nameFor(finder.query) || nameCompletion(finder.query) ||
                                           isWholeName(finder.query))) ||
      (mode === 'undecided' && (isRetired(query) ||
          (finder.named && (isWholeName(query) || typoName(query) !== null))));
  finder.highlight = pick && finderRows[0].kind === 'result' ? 0 : null;
  setFinder(finder);
  finderRender();
  if (mode === 'name' && !visible) finderArmCommit();  // a key, not the list opening
  if (mode === 'name' && !shown && finderDelayMs >= 0) {
    finderTimer = setTimeout(() => {
      finderTimer = null;
      if (finder && finder.mode === 'name') finderShow('name', finder.query, finder.named, true);
    }, finderDelayMs);
  }
}

function finderClose() {
  clearTimeout(finderTimer);
  finderTimer = null;
  if (finder === null) return;
  logEvent('finder', 'closed');
  const wasSearch = finder.mode !== 'list';
  setFinder(null);
  finderRows = [];
  if (finderEngineID !== null) {
    imeCall('setCandidateWindowProperties',
            {engineID: finderEngineID, properties: {visible: false}});
  }
  if (wasSearch && contextID !== 0) imeCall('clearComposition', {contextID});
}

/** Ends the composition (after a choice, or Escape). */
function finderEndComposition() {
  finderClose();
  setStates([rootState]);
  setComposing(false);
  setHeld(null);
}

function finderMove(delta, byPage) {
  const n = finderRows.length;
  if (n === 0) return;
  const pages = Math.ceil(n / FINDER_PAGE);
  if (byPage) {
    // Also highlights, so that Enter can pick: with Compose held, ChromeOS
    // may turn Alt+Up/Down into Page Up/Down.
    const was = finder.page;
    finder.page = Math.max(0, Math.min(pages - 1, finder.page + delta));
    if (finder.highlight === null || finder.page !== was) {
      finder.highlight = finder.page * FINDER_PAGE;
    }
    if (finderRows[finder.highlight].kind === 'hint' && finder.mode === 'search') {
      finder.highlight = null;
    }
  } else {
    let h = finder.highlight === null ?
        (delta > 0 ? finder.page * FINDER_PAGE : null) :
        Math.max(0, Math.min(n - 1, finder.highlight + delta));
    if (h !== null && finderRows[h].kind === 'hint' && finder.mode === 'search') h = null;
    finder.highlight = h;
    if (h !== null) finder.page = Math.floor(h / FINDER_PAGE);
  }
  setFinder(finder);
  finderRender();
}

/**
 * Acts on a chosen row (Enter, a click, or Compose in search mode).
 * @return {boolean} false if the row cannot be chosen (a placeholder)
 */
function finderChoose(index, keyData) {
  const row = finderRows[index];
  if (!row) return false;
  dbg('   finder: chose', row.kind, JSON.stringify(row.candidate));
  switch (row.kind) {
    case 'hint':
      if (finder.mode === 'list' && finderTab) {
        setHeld(null);
        finderShow('search');
        return true;
      }
      return false;
    case 'held':
      finderEndComposition();
      commitHeld(row.held, '', keyData);
      return true;
    case 'result':
      finderEndComposition();
      row.result.send(keyData);
      return true;
    case 'group': {
      // As if the key had been typed.
      const next = row.children;
      const done = next.filter((c) => c.result).pop();
      if (done && !canContinue(next)) {
        finderEndComposition();
        done.result.send(keyData);
      } else {
        setHeld(done ? {path: done.path, tail: ''} : held);
        setStates(next);
        finderShow('list');
        finderSig = finderSignature();
      }
      return true;
    }
  }
  return false;
}

function finderSignature() {
  return composing ? JSON.stringify([states.map((s) => s.path), held]) : '';
}

/**
 * Called after every key event has been handled. Starts the pause timer on
 * progress, refreshes a showing list, and closes the window once the
 * composition is over. Events that changed nothing (Compose auto-repeat, a
 * lone Shift) leave the timer running: they are not progress.
 */
function finderAfterKey() {
  const sig = finderSignature();
  if (sig === finderSig) return;
  finderSig = sig;
  finderArmCommit();
  // A search, a name or a mistake draws its own field and list, and keeps
  // its own timer.
  if (finder && finder.mode !== 'list' && composing) return;
  clearTimeout(finderTimer);
  finderTimer = null;
  finderShowName();
  if (!composing) {
    finderClose();
    return;
  }
  if (finder && finder.mode !== 'list') return;
  if (finder) {
    finderShow('list');
    return;
  }
  if (finderDelayMs >= 0) {
    finderTimer = setTimeout(() => {
      finderTimer = null;
      if (composing && !finder) finderShow('list');
    }, finderDelayMs);
  }
}

const FINDER_NAV = Object.freeze({
  ArrowDown: [1, false], ArrowUp: [-1, false],
  PageDown: [1, true], PageUp: [-1, true],
});

/**
 * ChromeOS's names for keys, as the web standard spells them. Seen on a
 * Chromebook: the down arrow arrives as "Down", not "ArrowDown". The others
 * are the same old-style names (cf. "Esc", https://crbug.com/826538).
 */
const KEY_ALIASES = Object.freeze({
  Down: 'ArrowDown', Up: 'ArrowUp', Left: 'ArrowLeft', Right: 'ArrowRight',
  Esc: 'Escape', Prior: 'PageUp', Next: 'PageDown', '\r': 'Enter',
});

/** A named key's standard name; its code if Chrome sent no name. */
function finderKeyName(keyData) {
  const k = keyData.key;
  if (!k) return keyData.code;
  return KEY_ALIASES[k] || k;
}

/** [delta, byPage] for a navigation key, or null. */
function finderNav(keyData) {
  return FINDER_NAV[finderKeyName(keyData)] || null;
}

/**
 * A keydown while composing, before it is matched against the tree.
 * @return {boolean} true if the finder took the key (and answered it)
 */
function finderListKey(keyData, requestId) {
  // A key that continues the sequence is never taken, even one the finder
  // would use: the user's compose file may bind Tab or an arrow.
  const syms = eventToSyms(keyData);
  if (states.some((s) => syms.some((sym) => s.nextKeys[sym]))) return false;
  const key = finderKeyName(keyData);
  const take = () => {
    keyDownSuppressed.add(keyData.key);
    keyEventHandled(requestId, true);
    return true;
  };
  if (key === 'Tab' && finderTab && !keyData.ctrlKey && !keyData.metaKey) {
    setHeld(null);
    finderShow('search');
    finderSig = finderSignature();
    return take();
  }
  if (key === 'Backspace') {
    finderStepBack();
    return take();
  }
  if (!finder) return false;
  if (finderRows.length === 0) finderRows = finderComputeRows();  // after a restart
  const nav = finderNav(keyData);
  if (nav) {
    finderMove(...nav);
    return take();
  }
  if (key === 'Enter' && finder.highlight !== null) {
    if (!finderChoose(finder.highlight, keyData)) finderEndComposition();
    return take();
  }
  return false;
}

/**
 * Backspace in the middle of a sequence takes back the last key, rather than
 * abandoning the sequence. Right after Compose, it cancels Compose.
 */
function finderStepBack() {
  const len = states.length ? states[0].path.length : 0;
  if (len <= 1) {
    finderEndComposition();
    return;
  }
  const parents = [...new Set(states.map((s) => stateAtPath(rootState, s.path.slice(0, -1))))]
      .filter((s) => s !== null);
  if (held !== null && held.tail) {
    setHeld({path: held.path, tail: [...held.tail].slice(0, -1).join('')});
  } else {
    setHeld(null);
    const p = parents.filter((s) => s.result).pop();
    if (p && canContinue(parents)) setHeld({path: p.path, tail: ''});
  }
  setStates(parents);
}

/** Commits what was typed as plain text, and ends the composition. */
function finderCommitLiteral(text, keyData) {
  finderEndComposition();
  if (text) new Result(text, null).send(keyData);
}

/**
 * A keydown in a search, or after a sequence that matched nothing. Every
 * key is answered here.
 */
function finderSearchKey(keyData, requestId, isComposeEvent) {
  const key = finderKeyName(keyData);
  const answer = (handled) => {
    if (handled) keyDownSuppressed.add(keyData.key);
    keyEventHandled(requestId, handled);
  };
  if (!isComposeEvent && modifierKeys.has(key)) {
    answer(false);
    return;
  }
  finderRows = finderComputeRows();
  if (finder.mode === 'undecided') {
    finderUndecidedKey(keyData, key, answer, isComposeEvent);
    return;
  }
  if (finder.mode === 'name') {
    finderNameKey(keyData, key, answer, isComposeEvent);
    return;
  }
  if (isComposeEvent || key === 'Enter') {
    answer(true);
    const h = finder.highlight;
    // Nothing found: what was typed, as typed.
    if (!finderChoose(h !== null ? h : 0, keyData)) finderCommitLiteral(finder.query, keyData);
    return;
  }
  if (key === 'Escape') {
    answer(true);
    finderEndComposition();
    return;
  }
  const nav = finderNav(keyData);
  if (nav || key === 'Tab') {
    answer(true);
    finderMove(...(nav || [keyData.shiftKey ? -1 : 1, false]));
    return;
  }
  if (key === 'Backspace') {
    answer(true);
    if (finder.query === '') finderEndComposition();
    else finderShow('search', [...finder.query].slice(0, -1).join(''), finder.named);
    return;
  }
  if (isPrintable(keyData)) {
    answer(true);
    finderShow('search', finder.query + keyData.key, finder.named);
    return;
  }
  // Anything else (Home, F-keys, ...) ends the search and does its job.
  finderEndComposition();
  answer(false);
}

/**
 * After a sequence that matched nothing, the keys stay on screen, underlined,
 * with suggestions; nothing is lost. With no row highlighted:
 *  - a letter that could still start a name extends what was typed (they
 *    may be typing one: Compose y e n finds ¥);
 *  - any other printable key commits what was typed plus that key, as text;
 *  - Enter, Tab-free keys and releasing a held Compose commit it as text.
 * Down (or Tab) picks a suggestion; Escape discards; Backspace edits.
 */
function finderUndecidedKey(keyData, key, answer, isComposeEvent) {
  const h = finder.highlight;
  if (key === 'Escape') {
    answer(true);
    finderEndComposition();
    return;
  }
  if (key === 'Enter' || isComposeEvent) {
    if (h !== null) {
      answer(true);
      if (!finderChoose(h, keyData)) finderEndComposition();
      return;
    }
    if (isComposeEvent) {
      // Commit what was typed and start again.
      answer(true);
      finderCommitLiteral(finder.query, keyData);
      setStates(rootState.nextKeys['Multi_key'] || [rootState]);
      setComposing(true);
      return;
    }
    // What was typed; Enter is not passed on (it would send a message).
    answer(true);
    finderCommitLiteral(finder.query, keyData);
    return;
  }
  const nav = finderNav(keyData);
  if (nav || key === 'Tab') {
    answer(true);
    finderMove(...(nav || [keyData.shiftKey ? -1 : 1, false]));
    return;
  }
  if (key === 'Backspace') {
    answer(true);
    const q = [...finder.query].slice(0, -1).join('');
    // Back to keys that are the start of a sequence: carry on with it, and
    // its list (from "e4", Backspace gives "e" and the é è ë list).
    const syms = q ? keysToSyms([...q]) : null;
    let nodes = syms ? (rootState.nextKeys['Multi_key'] || []) : [];
    for (const sym of syms || []) nodes = nodes.flatMap((n) => n.nextKeys[sym] || []);
    if (nodes.length > 0) {
      finderClose();
      setStates(nodes);
      finderShow('list');
      finderSig = finderSignature();
      finderShowName();
    } else if (!q) {
      finderEndComposition();
    } else {
      finderShow('undecided', q, finder.named);
    }
    return;
  }
  if (isPrintable(keyData)) {
    answer(true);
    const q = finder.query + keyData.key;
    // Letters go on: a word being typed, perhaps a misspelt name ("fier"),
    // until a key that is not a letter ends it.
    if (/^[\p{L}\p{N}]+$/u.test(q) &&
        (startsAName(q) || (finder.named === 'name' && /^\p{L}$/u.test(keyData.key)))) {
      finderShow('undecided', q, finder.named === 'name' ? 'name' : true);
    } else {
      finderCommitLiteral(q, keyData);
    }
    return;
  }
  finderCommitLiteral(finder.query, keyData);
  answer(false);
}

/**
 * Called when `keyData` does not continue the sequence (and nothing is held).
 *  - After Compose Compose (a name): what was typed becomes a search, so a
 *    name remembered from a search ("euro") still works.
 *  - Otherwise: the keys are kept, underlined, with suggestions of what may
 *    have been meant (see finderUndecidedKey), instead of vanishing.
 * @return {boolean} true if the key was answered here
 */
function finderFailed(keyData, requestId, isComposeEvent) {
  if (states.length === 0) return false;
  const take = () => {
    keyDownSuppressed.add(keyData.key);
    keyEventHandled(requestId, true);
    return true;
  };
  // Compose twice: a name follows, and only a name.
  if (isComposeEvent && atComposeOnly() && finderTab) {
    take();
    setHeld(null);
    finderShow('name', '', true);
    return true;
  }
  // Letters that are the start of a name: a name is being typed. (Before
  // the held check: "c a" is ǎ, held, but "cat" is 🐱.)
  const letters = typedLetters() ?? (atComposeOnly() ? '' : null);
  const k = keyData.key;
  if (finderTab && letters !== null && /^[A-Za-z]$/.test(k) && !keyData.ctrlKey &&
      !keyData.metaKey && startsName(letters + k)) {
    take();
    if (finderNameDone(letters + k, keyData)) return true;
    finderShow('name', letters + k);
    return true;
  }
  if (heldResult() !== null) return false;
  const printable = isPrintable(keyData) && !keyData.ctrlKey && !keyData.metaKey;
  const typed = typedSoFar();
  if (!typed) return false;  // nothing typed yet, or keys that are not text
  if (isComposeEvent) {
    // Compose in the middle of a sequence: keep what was typed, start again.
    keyEventHandled(requestId, true);
    finderCommitLiteral(typed, keyData);
    setStates(rootState.nextKeys['Multi_key'] || [rootState]);
    setComposing(true);
    return true;
  }
  if (finderKeyName(keyData) === 'Escape') return false;
  if (!printable) {
    // An arrow, Home...: what was typed, then the key does its job.
    finderCommitLiteral(typed, keyData);
    keyEventHandled(requestId, finderKeyName(keyData) === 'Enter');
    return true;
  }
  take();
  // Letters only: perhaps a word that names something ("pm": ±).
  const q = typed + keyData.key;
  finderShow('undecided', q, /^[A-Za-z]+$/.test(q));
  return true;
}

/**
 * A name typed after Compose (mode 'name'; `named` after Compose Compose,
 * which allows names only). Letters that can still make a name go on; the
 * name counts when it ends, and only then:
 *  - Space, punctuation, a digit or a capital: the name, then that key;
 *  - Enter, releasing a held Compose, Compose again: the name;
 *  - a letter that makes no name: a key sequence held on the way ("c a" ǎ)
 *    plus the letters as typed, or else the suggestions for a mistake.
 * What "the name" is: the whole word if it is a name ("cat" 🐱, "pint"
 * 🍺); else a sequence held on the way plus the letters after it ("m u"
 * µ, then "le": µle); else, after Compose Compose, the best match; else the
 * letters as typed. No timeout ever changes the result.
 */
function finderNameKey(keyData, key, answer, isComposeEvent) {
  const q = finder.query;
  const pure = finder.named;
  if (key === 'Escape') {
    answer(true);
    finderEndComposition();
    return;
  }
  if (key === 'Enter' || isComposeEvent) {
    answer(true);
    if (finder.highlight === null || !finderChoose(finder.highlight, keyData)) {
      finderSettleName('', keyData);
    }
    // Compose again: the name is typed, and a new character begins (it
    // used to end there: euro, Compose, " u gave €"u).
    if (isComposeEvent) {
      setStates(rootState.nextKeys['Multi_key'] || [rootState]);
      setComposing(true);
    }
    return;
  }
  if (key === 'Tab') {
    answer(true);
    setHeld(null);
    finderShow('search', q, true);
    return;
  }
  const nav = finderNav(keyData);
  if (nav) {
    answer(true);
    if (!finder.visible) finderShow('name', q, pure, true);
    finderMove(...nav);
    return;
  }
  if (key === 'Backspace') {
    answer(true);
    const q2 = [...q].slice(0, -1).join('');
    const trie = pure ? 0 : (typedLetters() || '').length;
    if (!pure && q2.length <= trie) {
      // Back to the keys of the sequence itself.
      finderClose();
      if (q2.length < trie) finderStepBack();
      finderSig = '';
      finderShowName();
    } else if (pure && !q2 && !q) {
      finderEndComposition();
    } else {
      finderShow('name', q2, pure);
    }
    return;
  }
  const k = keyData.key;
  // A space goes on only into a phrase ("thumbs up"), and only if what was
  // typed is not a whole name already ("heart" then Space is ❤️).
  if ((/^[a-z]$/.test(k) || (/^[0-9]$/.test(k) && startsName(q + k))) &&
      !keyData.ctrlKey && !keyData.metaKey) {
    answer(true);
    const q2 = q + k;
    if (startsName(q2)) {
      if (finderNameDone(q2, keyData)) return;
      finderShow('name', q2, pure);
    } else if (pure) {
      // Not the start of any name: search for it instead.
      finderShow('search', q2, true);
    } else {
      const h = heldResult();
      const tail = q2.slice(heldKeys());
      // A sequence held on the way plus a letter or two ("m u" µ, then
      // "le"); after more letters it was a word, not µ: keep them as typed,
      // with suggestions ("t h" þ, then "ums": thums, not þums).
      if (h && tail.length < 3) {
        finderEndComposition();
        commitHeld({result: h.result, tail: ''}, tail, keyData);
      } else {
        finderShow('undecided', q2, 'name');  // a word being typed
      }
    }
    return;
  }
  if (isPrintable(keyData) && !keyData.ctrlKey && !keyData.metaKey) {
    answer(true);
    finderSettleName(k, keyData);
    return;
  }
  finderSettleName('', keyData);
  answer(false);
}

/**
 * After a complete sequence of lowercase letters, could a name still
 * follow? Then the sequence waits for the next key instead of committing.
 */
function finderNameMayFollow(nextStates) {
  if (!finderTab || nextStates.length === 0) return false;
  const keys = nextStates[0].path.slice(1).map(([sym]) => symToEvent(sym).key);
  const word = keys.join('');
  return /^[a-z]+$/.test(word) && keys.length === word.length && startsName(word, true);
}

/**
 * A whole name that nothing longer starts with is typed at once, like a
 * key sequence: Compose y e n is ¥ at the n. Only a name that could still
 * grow ("pin", "pint"; "heart", "hearts") waits for the key that ends it.
 * @return {boolean} true if it was typed
 */
function finderNameDone(word, keyData) {
  const text = nameFor(word);
  // Any longer name, even one for the same character: "cube" is ³, but if
  // ³ were typed at the e, the d of "cubed" would be left over (³d).
  if (text === null || startsName(word, true)) return false;
  finderEndComposition();
  new Result(text, null).send(keyData);
  return true;
}

/** For Enter: the character a search word stands for ("ne": ≠), if the
 * word is a whole search word; null otherwise. */
function searchWord(word) {
  if (!isWholeName(word)) return null;
  const r = nameRows(word).find((x) => x.kind === 'result');
  return r ? resultText(r.result) : null;
}

/** What every name starting with `prefix` means, if they all mean the
 * same ("multip": ×); else null. Enter or Space then completes it. */
function nameCompletion(prefix) {
  const {sorted, map} = namesIndex();
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < prefix) lo = m + 1; else hi = m; }
  let text = null;
  for (let i = lo; i < sorted.length && sorted[i].startsWith(prefix); i++) {
    const t = map.get(sorted[i]).text;
    if (text !== null && t !== text) return null;
    text = t;
  }
  return text;
}

/** Does a longer name (or phrase) start with `word` and mean something
 * other than `text`? ("yen sign" is ¥ too: yen need not wait.) */
function longerNameDiffers(word, text) {
  const {sorted, map} = namesIndex();
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < word) lo = m + 1; else hi = m; }
  for (let i = lo; i < sorted.length && sorted[i].startsWith(word); i++) {
    if (sorted[i] !== word && map.get(sorted[i]).text !== text) return true;
  }
  return false;
}

/** How many keys after Compose the held result took. */
function heldKeys() {
  return held ? held.path.length - 1 : 0;
}

/** Ends a name (see finderNameKey) and types it, followed by `extra`. */
function finderSettleName(extra, keyData) {
  const q = finder.query;
  // Enter also completes an unambiguous start ("multip": ×); Space and
  // punctuation take only a whole name, else what was typed.
  const typo = q && extra === '' ? typoName(q) : null;
  const exact = q ? nameFor(q) || (extra === '' ?
      nameCompletion(q) || (typo && nameFor(typo)) || searchWord(q) : null) : null;
  const h = heldResult();
  let text = exact;
  if (text === null && !h && finder.named && q) {
    const best = nameRows(q).find((r) => r.kind === 'result');
    if (best) text = resultText(best.result);
  }
  const tail = q.slice(heldKeys());  // before the composition ends
  finderEndComposition();
  if (text !== null) {
    new Result(text + extra, null).send(keyData);
  } else if (h && tail.length < 3) {
    commitHeld({result: h.result, tail: ''}, tail + extra, keyData);
  } else if (q + extra) {
    new Result(q + extra, null).send(keyData);
  }
}

/** Releasing a held Compose settles an undecided sequence as typed. */
function finderComposeReleased(keyData) {
  if (finder && finder.mode === 'undecided' && finder.highlight === null) {
    // An old habit ("c s", retired): keep the suggestion up, highlighted,
    // so that holding Compose still teaches the new keys. Enter takes it.
    if (isRetired(finder.query)) {
      finder.highlight = 0;
      finder.visible = true;
      setFinder(finder);
      finderRender();
      return;
    }
    finderCommitLiteral(finder.query, keyData);
  } else if (finder && finder.mode === 'name' && finder.query) {
    // Releasing a held Compose ends a name, like Enter: the highlighted row.
    if (finder.highlight === null || !finderChoose(finder.highlight, keyData)) {
      finderSettleName('', keyData);
    }
  }
}

/** On blur: what was typed is not lost. */
function finderBlurred() {
  if (finder && finder.mode === 'undecided') finderCommitLiteral(finder.query, {});
  else if (finder && finder.mode === 'name' && finder.query) finderSettleName('', {});
  else if (composing && (!finder || finder.mode === 'list') && heldResult()) {
    // A result waiting for the next key (µ) is typed, not lost.
    const h = heldResult();
    finderEndComposition();
    commitHeld(h, '', {});
  }
}

/**
 * While a Compose Compose name is being typed, show it, underlined: without
 * that, a name that is the start of a longer one ("heart", "hearts") showed
 * nothing at all until Space.
 */
let finderNameShown = false;
function finderShowName() {
  const p = composing && states.length ? states[0].path : [];
  const free = !(finder && finder.mode !== 'list');
  // A result waiting for the next key shows as itself (µ while "m u" waits
  // for "multiplication"), so nothing seems late. A sequence still waiting
  // after two keys shows its keys (Compose < =, i i): it used to show
  // nothing. After one key, nothing, so the usual two-key sequence shows
  // nothing before its character.
  const h = free && composing ? heldResult() : null;
  const text = h ? resultText(h.result) + h.tail :
      free && composing && p.length >= 3 ? (typedSoFar() || '') : '';
  if (text) {
    imeCall('setComposition', {contextID, text, cursor: text.length,
                               segments: [{start: 0, end: text.length, style: 'underline'}]});
    finderNameShown = true;
  } else {
    finderClearName();
  }
}

/** Before any commit: remove the name shown by finderShowName. */
function finderClearName() {
  if (finderNameShown && contextID !== 0) imeCall('clearComposition', {contextID});
  finderNameShown = false;
}

chrome.input.ime.onCandidateClicked.addListener((engineID, candidateID, button) => {
  initPromise.then(() => {
    if (!finder || button !== 'left') return;
    finderEngineID = engineID;
    finderRows = finderComputeRows();
    if (!finderChoose(candidateID, {})) return;
    finderSig = finderSignature();
  });
});
