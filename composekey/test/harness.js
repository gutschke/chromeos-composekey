/*
 * Test harness for service_worker.js: runs the worker under Node with fake
 * chrome.* APIs, and can simulate the thing that makes Manifest V3 extensions
 * hard to get right: Chrome stopping the service worker when idle and starting
 * a fresh copy (all globals gone) when the next event arrives.
 *
 * The extension used to stop working now and then, without any error, until
 * the input method was switched away and back. That is the symptom of state
 * kept only in a worker global and lost on restart. Without a Chromebook, the
 * way to see such bugs is to restart the worker on purpose between events,
 * while chrome.storage survives, as it does in Chrome (storage.session lives
 * as long as the browser session, not the worker).
 *
 * Fidelity notes (what is simulated, not exercised):
 *  - Storage values round-trip through JSON, like Chrome's serialisation
 *    (undefined is dropped, [undefined] becomes [null], class instances lose
 *    their prototype). Each storage call completes asynchronously after
 *    `storageLatencyMs`, standing in for Chrome's IPC round trip.
 *  - A restart is modelled as: evaluate the script in a new VM context, then
 *    dispatch the triggering event right away, before any storage callback has
 *    run. Chrome does dispatch the waking event as soon as the script's
 *    top-level code has run; it does not wait for pending promises.
 *  - Key events carry key, code, type and the modifier flags. Chrome also
 *    sends fields this harness does not (extensionId, requestId in keyData).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// COMPOSEKEY_WORKER points the tests at another copy of the worker (e.g. an
// older revision from `git show`), so a new test can be seen failing against
// the code it is meant to catch.
const WORKER_PATH = process.env.COMPOSEKEY_WORKER ||
    path.join(__dirname, '..', 'service_worker.js');
const WORKER_SOURCE = fs.readFileSync(WORKER_PATH, 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Storage that outlives any single worker instance. */
class FakeStorage {
  constructor() {
    this.areas = {sync: new Map(), local: new Map(), session: new Map()};
  }
}

function makeArea(map, latencyMs, log) {
  const later = (fn) => new Promise((resolve) => {
    setTimeout(() => resolve(fn()), latencyMs);
  });
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const withCallback = (promise, cb) => {
    if (typeof cb === 'function') promise.then((v) => cb(v));
    return promise;
  };
  return {
    get(keys, cb) {
      return withCallback(later(() => {
        const out = {};
        if (keys == null) {
          for (const [k, v] of map) out[k] = clone(v);
        } else if (typeof keys === 'string') {
          if (map.has(keys)) out[keys] = clone(map.get(keys));
        } else if (Array.isArray(keys)) {
          for (const k of keys) if (map.has(k)) out[k] = clone(map.get(k));
        } else {
          for (const [k, dflt] of Object.entries(keys)) {
            // Chrome returns stored value if present, else the default as given.
            out[k] = map.has(k) ? clone(map.get(k)) : dflt;
          }
        }
        return out;
      }), cb);
    },
    set(items, cb) {
      // Serialise synchronously, at call time, as Chrome does.
      const snapshot = {};
      for (const [k, v] of Object.entries(items)) snapshot[k] = clone(v);
      return withCallback(later(() => {
        for (const [k, v] of Object.entries(snapshot)) {
          if (v === undefined) map.delete(k); else map.set(k, v);
        }
        log.push({op: 'set', keys: Object.keys(snapshot)});
      }), cb);
    },
    remove(keys, cb) {
      return withCallback(later(() => {
        for (const k of [].concat(keys)) map.delete(k);
      }), cb);
    },
    clear(cb) {
      return withCallback(later(() => map.clear()), cb);
    },
  };
}

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
  };
}

/** Records everything the worker tells Chrome. Shared across restarts. */
class Recorder {
  constructor() {
    this.commits = [];        // {contextID, text}
    this.sentKeys = [];       // sendKeyEvents payloads
    this.handled = new Map(); // requestId -> handled(bool)
    this.dispatched = [];     // requestIds we sent in
    this.lastKeydown = {};    // key -> requestId of its most recent keydown
    this.errors = [];         // console.error + unhandled rejections
    this.storageLog = [];
  }
  unanswered() {
    return this.dispatched.filter((id) => !this.handled.has(id));
  }
}

let nextRequestId = 1;

class Worker {
  constructor(storage, rec, opts) {
    this.rec = rec;
    // A number, or {sync, local, session} to vary completion order across
    // areas; Chrome gives no ordering guarantee between storage areas.
    const lat = opts.storageLatencyMs ?? 2;
    const latency = (area) => (typeof lat === 'number' ? lat : lat[area] ?? 2);
    const ime = new Proxy({
      onFocus: makeEvent(),
      onBlur: makeEvent(),
      onKeyEvent: makeEvent(),
      onActivate: makeEvent(),
      onDeactivated: makeEvent(),
      onReset: makeEvent(),
      onInputContextUpdate: makeEvent(),
      onSurroundingTextChanged: makeEvent(),
      commitText: (params, cb) => {
        rec.commits.push({contextID: params.contextID, text: params.text});
        if (cb) setTimeout(cb, 0);
      },
      sendKeyEvents: (params, cb) => {
        rec.sentKeys.push(params);
        if (cb) setTimeout(cb, 0);
      },
      keyEventHandled: (requestId, handled) => {
        rec.handled.set(requestId, handled);
      },
    }, {
      get(target, prop) {
        if (!(prop in target) && typeof prop === 'string' && prop.startsWith('on')) {
          target[prop] = makeEvent();
        }
        return target[prop];
      },
    });
    this.chrome = {
      input: {ime},
      storage: {
        sync: makeArea(storage.areas.sync, latency('sync'), rec.storageLog),
        local: makeArea(storage.areas.local, latency('local'), rec.storageLog),
        session: makeArea(storage.areas.session, latency('session'), rec.storageLog),
      },
      runtime: {onMessage: makeEvent(), onInstalled: makeEvent(), lastError: undefined},
    };
    const quietConsole = {
      log: () => {},
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: (...a) => rec.errors.push('console.error: ' + a.map(String).join(' ')),
    };
    this.context = vm.createContext({
      chrome: this.chrome,
      console: opts.verbose ? console : quietConsole,
      setTimeout, clearTimeout, Promise, Object, JSON,
    });
    vm.runInContext(WORKER_SOURCE, this.context, {filename: 'service_worker.js'});
  }

  fire(eventName, ...args) {
    for (const fn of this.chrome.input.ime[eventName].listeners) fn(...args);
  }

  focus(contextID = 42) {
    this.fire('onFocus', {contextID, type: 'text'});
  }

  blur(contextID = 42) {
    this.fire('onBlur', contextID);
  }

  /** Dispatch one keydown or keyup; returns its requestId. */
  keyEvent(type, key, code, mods = {}) {
    const requestId = String(nextRequestId++);
    this.rec.dispatched.push(requestId);
    if (type === 'keydown') this.rec.lastKeydown[key] = requestId;
    const keyData = {
      type, key, code,
      altKey: !!mods.alt, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift,
      metaKey: !!mods.meta, capsLock: !!mods.capsLock,
    };
    this.fire('onKeyEvent', 'compose_key', keyData, requestId);
    return requestId;
  }
}

/** A browser session: storage + recorder that survive worker restarts. */
class Session {
  constructor(opts = {}) {
    this.opts = opts;
    this.storage = new FakeStorage();
    this.rec = new Recorder();
    this.worker = null;
    this.restarts = 0;
  }

  /** Start (or restart) the worker. Old instance's globals are discarded. */
  start() {
    if (this.worker) this.restarts++;
    this.worker = new Worker(this.storage, this.rec, this.opts);
    return this.worker;
  }

  /** Let all pending storage callbacks and promises settle. */
  async settle(ms = 30) {
    await sleep(ms);
  }

  /**
   * Press and release one key; settles after each half. A shifted key is
   * wrapped in real ShiftLeft keydown/keyup events, as on hardware, because
   * the Shift events themselves must not disturb a pending sequence.
   */
  async tap(key, {code, shift, alt} = {}) {
    code = code ?? keyToCode(key);
    if (shift) {
      this.worker.keyEvent('keydown', 'Shift', 'ShiftLeft', {shift: true, alt});
      await this.settle(5);
    }
    this.worker.keyEvent('keydown', key, code, {shift, alt});
    await this.settle(5);
    this.worker.keyEvent('keyup', key, code, {shift, alt});
    await this.settle(5);
    if (shift) {
      this.worker.keyEvent('keyup', 'Shift', 'ShiftLeft', {alt});
      await this.settle(5);
    }
  }

  /** Install a custom compose file before the worker first starts. */
  setComposeFile(text) {
    this.storage.areas.sync.set('composeFile', text);
  }

  /** Tap the Compose key (right Alt by default). */
  async compose() {
    this.worker.keyEvent('keydown', 'Alt', 'AltRight', {alt: true});
    await this.settle(5);
    this.worker.keyEvent('keyup', 'Alt', 'AltRight', {});
    await this.settle(5);
  }

  /**
   * Hold the Compose key (right Alt) down while typing `seq`, then release it.
   * While it is held, every other key event carries altKey, as on real
   * hardware (assumed: Chrome reports the physical modifier state even when the
   * extension suppressed the AltRight keydown).
   */
  /**
   * `repeats`: extra AltRight keydowns before the sequence, as ChromeOS sends
   * while the key is held (auto-repeat, with no `repeat` flag on the
   * event).
   */
  async holdType(seq, {release = true, repeats = 0} = {}) {
    this.worker.keyEvent('keydown', 'Alt', 'AltRight', {alt: true});
    await this.settle(5);
    for (let i = 0; i < repeats; i++) {
      this.worker.keyEvent('keydown', 'Alt', 'AltRight', {alt: true});
      await this.settle(5);
    }
    for (const ch of seq) {
      await this.tap(ch, {alt: true, shift: isShifted(ch)});
    }
    if (release) await this.releaseCompose();
  }

  async releaseCompose() {
    this.worker.keyEvent('keyup', 'Alt', 'AltRight', {});
    await this.settle(5);
  }

  /** Send a named non-printable key, e.g. 'Enter' or 'Escape'. */
  async tapNamed(key) {
    await this.tap(key, {code: key});
  }

  /** Compose followed by each character of `seq`. */
  async type(seq) {
    await this.compose();
    for (const ch of seq) {
      await this.tap(ch, {shift: isShifted(ch)});
    }
  }
}

function isShifted(ch) {
  return /[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(ch);
}

function keyToCode(key) {
  if (/^[a-z]$/i.test(key)) return 'Key' + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return 'Digit' + key;
  const map = {
    ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft',
    ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote',
    ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote',
    '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5',
    '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0',
    '_': 'Minus', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight',
    '|': 'Backslash', ':': 'Semicolon', '"': 'Quote', '<': 'Comma',
    '>': 'Period', '?': 'Slash', '~': 'Backquote',
  };
  return map[key] ?? 'Unidentified';
}

module.exports = {Session, sleep};
