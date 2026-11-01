// Layer 3 — lazy `window`. A Proxy whose globals are factories that materialize
// on first `get` and self-replace with the concrete value (one-time Proxy cost
// per property). A test using only `document.querySelector` never constructs
// localStorage, IntersectionObserver, matchMedia, etc. The Proxy doubles as a
// tracer: it records which globals each test actually touches.

import {
  Storage, makeMatchMedia,
  IntersectionObserver, ResizeObserver,
  FileReader, makeCanvasStub, makeCustomElements,
  makeLocation, makeHistory,
} from './stubs.mjs';
import { makeGetComputedStyle } from './cascade.mjs';
import { CSSStyleSheet } from './cssom.mjs';
import { NamedNodeMap } from './collections.mjs';
import {
  Node, Element, CanvasElement, MediaElement, SVGElement, Text, Comment, Document, DocumentFragment, DocumentType, Event, CustomEvent,
  MutationObserver, DOMParser, XMLSerializer, ShadowRoot,
} from './dom.mjs';
import {
  EventTarget, MessageEvent,
  UIEvent, MouseEvent, PointerEvent, KeyboardEvent, InputEvent, FocusEvent,
  CompositionEvent, WheelEvent, TouchEvent, DragEvent, ProgressEvent,
} from './events.mjs';

// Minimal DataTransfer / clipboard primitives some libraries (user-event) need.
class DataTransfer {
  constructor() { this.__data = new Map(); this.dropEffect = 'none'; this.effectAllowed = 'all'; this.items = []; this.files = []; this.types = []; }
  setData(fmt, data) { this.__data.set(fmt, String(data)); if (!this.types.includes(fmt)) this.types.push(fmt); }
  getData(fmt) { return this.__data.get(fmt) ?? ''; }
  clearData(fmt) { if (fmt) this.__data.delete(fmt); else this.__data.clear(); }
}
class ClipboardEvent extends Event {
  constructor(type, init = {}) { super(type, init); this.clipboardData = init.clipboardData ?? new DataTransfer(); }
}

// FormData that preserves File/Blob identity. Node's global FormData clones
// entries into anonymous Blobs (losing the File reference + filename); tests that
// assert `fd.get('file') === file` need the original kept.
class TurboFormData {
  constructor(form, submitter = null) {
    this.__entries = [];
    if (form !== undefined && (!(form instanceof Element) || form.localName !== 'form' || form.namespaceURI !== 'http://www.w3.org/1999/xhtml')) {
      throw new TypeError('FormData requires an HTML form element');
    }
    if (submitter !== null && (!(submitter instanceof Element) || submitter.namespaceURI !== 'http://www.w3.org/1999/xhtml')) throw new TypeError('FormData submitter must be an HTML element');
    if (form === undefined) return;
    if (submitter !== null) {
      if (!this.__isSubmitButton(submitter)) throw new TypeError('FormData submitter must be a submit button');
      if (this.__formOwner(submitter) !== form) {
        const message = 'FormData submitter does not belong to this form';
        throw globalThis.DOMException
          ? new globalThis.DOMException(message, 'NotFoundError')
          : Object.assign(new Error(message), { name: 'NotFoundError' });
      }
    }
    const root = form.getRootNode();
    for (const control of root.querySelectorAll('input,select,textarea,button')) {
      if (control.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      if (this.__formOwner(control) !== form || this.__excluded(control)) continue;
      const tag = control.localName;
      const type = String(control.type || '').toLowerCase();
      const name = control.getAttribute('name') || '';
      if (tag === 'input' && type === 'image') {
        if (control === submitter) {
          this.append(name ? name + '.x' : 'x', '0');
          this.append(name ? name + '.y' : 'y', '0');
        }
        continue;
      }
      if (!name) continue;
      if (tag === 'button' || (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset'))) {
        if (control === submitter) this.append(name, control.value ?? control.__value ?? control.getAttribute('value') ?? '');
        continue;
      }
      if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
        if (control.checked) this.append(name, !control.hasAttribute('value') && control.__value === undefined ? 'on' : control.value);
      } else if (tag === 'input' && type === 'file') {
        const files = control.files;
        if (files && files.length) {
          for (let i = 0; i < files.length; i++) this.append(name, files[i]);
        } else {
          this.append(name, new TURBO_FILE([], '', { type: 'application/octet-stream' }));
        }
      } else if (tag === 'select') {
        const options = Array.from(control.options);
        let selected = options.filter(option => option.selected);
        if (!control.multiple) {
          if (selected.length) selected = selected.slice(-1);
          else if (!(Number(control.getAttribute('size')) > 1) && !options.some(option => option.__selected !== undefined)) {
            const first = options.find(option => !this.__optionDisabled(option));
            if (first) selected = [first];
          }
        }
        for (const option of selected) if (!this.__optionDisabled(option)) this.append(name, option.value);
      } else {
        this.append(name, control.value ?? '');
      }
    }
  }
  __isSubmitButton(control) {
    const type = String(control.type || '').toLowerCase();
    return control.localName === 'input' ? type === 'submit' || type === 'image'
      : control.localName === 'button' && type !== 'button' && type !== 'reset';
  }
  __formOwner(control) {
    const id = control.getAttribute('form');
    if (id !== null) {
      if (!id) return null;
      const root = control.getRootNode();
      let candidate = root.nodeType === 1 && root.id === id ? root : null;
      if (!candidate && root.getElementById) candidate = root.getElementById(id);
      else if (!candidate) {
        for (const element of root.querySelectorAll('[id]')) {
          if (element.id === id) { candidate = element; break; }
        }
      }
      return candidate && candidate.localName === 'form' ? candidate : null;
    }
    return control.closest('form');
  }
  __excluded(control) {
    if (control.disabled) return true;
    for (let parent = control.parentElement; parent; parent = parent.parentElement) {
      if (parent.localName === 'datalist') return true;
      if (parent.localName !== 'fieldset' || !parent.disabled) continue;
      let legend = null;
      for (const child of parent.children) if (child.localName === 'legend') { legend = child; break; }
      if (!legend || !legend.contains(control)) return true;
    }
    return false;
  }
  __optionDisabled(option) {
    return option.disabled || (option.parentElement && option.parentElement.localName === 'optgroup' && option.parentElement.disabled);
  }
  append(name, value, filename) { this.__entries.push([String(name), this.__wrap(value, filename)]); }
  set(name, value, filename) { this.delete(name); this.append(name, value, filename); }
  __wrap(value, filename) {
    // string values coerce; File/Blob are kept by reference (optionally re-named)
    if (value == null || typeof value !== 'object') return String(value);
    if (filename !== undefined && globalThis.Blob && value instanceof globalThis.Blob && value.name !== filename) {
      const F = makeFile(); return new F([value], String(filename), { type: value.type });
    }
    return value;
  }
  get(name) { const e = this.__entries.find((x) => x[0] === String(name)); return e ? e[1] : null; }
  getAll(name) { return this.__entries.filter((x) => x[0] === String(name)).map((x) => x[1]); }
  has(name) { return this.__entries.some((x) => x[0] === String(name)); }
  delete(name) { this.__entries = this.__entries.filter((x) => x[0] !== String(name)); }
  forEach(cb, thisArg) { for (const [k, v] of this.__entries) cb.call(thisArg, v, k, this); }
  *entries() { for (const e of this.__entries) yield [e[0], e[1]]; }
  *keys() { for (const e of this.__entries) yield e[0]; }
  *values() { for (const e of this.__entries) yield e[1]; }
  [Symbol.iterator]() { return this.entries(); }
}

// A tag-specific HTML*Element interface. Not constructible — exists so
// `el instanceof HTMLXElement` is true only for elements with the matching
// localName (matcher = string or RegExp). Avoids aliasing every interface to
// Element (which made `instanceof HTMLAnchorElement` true for ALL elements).
function tagClass(matcher, prototype = Element.prototype) {
  const test = typeof matcher === 'string' ? (n) => n === matcher : (n) => matcher.test(n);
  const C = function () { throw new TypeError('Illegal constructor'); };
  // Share the runtime interface prototype so prototype-level spies/reads resolve (e.g.
  // vi.spyOn(HTMLAnchorElement.prototype, 'click')); instanceof is decided by
  // the tag matcher below, not the prototype chain.
  C.prototype = prototype;
  Object.defineProperty(C, Symbol.hasInstance, {
    value: (o) => o != null && o.nodeType === 1 && test(o.localName),
  });
  return C;
}

// Capture host functions at module load — BEFORE any installGlobals() can shadow
// the bare names on globalThis (which would make these delegates call themselves).
const hostSetTimeout = globalThis.setTimeout;
const hostClearTimeout = globalThis.clearTimeout;

// MessageChannel/MessagePort — React 19's scheduler posts its work loop through a
// MessagePort hop (falling back to setTimeout only if absent). We ship a real,
// self-contained polyfill whose delivery is scheduled via the LIVE globalThis.
// setTimeout (read at call time, like rAF), so a render tier that owns setTimeout
// (a virtual-clock pump) catches every scheduler hop → React runs in virtual time,
// bounded by the drain/deadline — and it exists in the bare V8 isolate, which has
// no host MessageChannel. See MESSAGECHANNEL-VIRTUALIZE.md + the clock note in
// CLAUDE.md. Delivery uses delay 0 (a yield, not elapsed time — animations get
// their time from rAF's 16ms frame).
class MessagePort extends EventTarget {
  constructor() { super(); this.onmessage = null; this.onmessageerror = null; this.__other = null; }
  start() {}
  close() { this.__other = null; }
  postMessage(data) {
    const target = this.__other;
    if (!target) return;
    (globalThis.setTimeout || hostSetTimeout)(() => {
      const ev = new Event('message'); ev.data = data;
      if (typeof target.onmessage === 'function') target.onmessage(ev);
      target.dispatchEvent(ev);
    }, 0);
  }
}
class MessageChannel {
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    this.port1.__other = this.port2;
    this.port2.__other = this.port1;
  }
}

// Env-independent lazy global factories — built ONCE at module load, shared by
// every window (none capture document/url/windowProxy). Materialization still
// self-replaces onto the per-env base, so each env gets its own instance; only
// the factory objects/closures are shared, saving ~28 allocations per test file.
const SHARED_LAZY = {
  customElements: () => makeCustomElements(), // fresh registry per env, built on first access
  localStorage: () => new Storage(),
  sessionStorage: () => new Storage(),
  getComputedStyle: () => makeGetComputedStyle(),
  IntersectionObserver: () => IntersectionObserver,
  ResizeObserver: () => ResizeObserver,
  // rAF: schedule via the LIVE setTimeout (so a render tier that swaps in a timer
  // queue catches the reschedule) with a non-zero frame delay, and stamp the
  // callback with the injectable clock now() — a virtual clock that ADVANCES per
  // frame lets time-gated transitions (MUI Fade/Grow, react-transition-group:
  // progress = (now-start)/duration) reach progress>=1 and stop rescheduling.
  requestAnimationFrame: () => (cb) => (globalThis.setTimeout || hostSetTimeout)(() => cb(now()), 16),
  cancelAnimationFrame: () => (id) => (globalThis.clearTimeout || hostClearTimeout)(id),
  navigator: () => ({
    userAgent: 'Mozilla/5.0 (turbo-dom) AppleWebKit/537.36',
    platform: 'turbo-dom', vendor: '', language: 'en-US', languages: ['en-US'],
    onLine: true, cookieEnabled: true, doNotTrack: null, maxTouchPoints: 0,
    hardwareConcurrency: 4, deviceMemory: 8, webdriver: false,
    clipboard: { readText: async () => '', writeText: async () => {}, read: async () => [], write: async () => {} },
    permissions: { query: async () => ({ state: 'prompt', addEventListener() {}, removeEventListener() {} }) },
    sendBeacon: () => true, vibrate: () => false,
  }),
  performance: () => ({ now, timeOrigin: 0, mark() {}, measure() {}, getEntriesByName: () => [], getEntriesByType: () => [], clearMarks() {}, clearMeasures() {} }),
  Storage: () => Storage,
  devicePixelRatio: () => 1,
  innerWidth: () => 1024,
  innerHeight: () => 768,
  outerWidth: () => 1024,
  outerHeight: () => 768,
  scrollX: () => 0, scrollY: () => 0, pageXOffset: () => 0, pageYOffset: () => 0,
  screenX: () => 0, screenY: () => 0, screenLeft: () => 0, screenTop: () => 0,
  screen: () => ({ width: 1024, height: 768, availWidth: 1024, availHeight: 768, colorDepth: 24, pixelDepth: 24, orientation: { type: 'landscape-primary', angle: 0, addEventListener() {}, removeEventListener() {} } }),
  visualViewport: () => ({ width: 1024, height: 768, scale: 1, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, addEventListener() {}, removeEventListener() {} }),
};
const hostSetInterval = globalThis.setInterval;
const hostClearInterval = globalThis.clearInterval;
const hostQueueMicrotask = globalThis.queueMicrotask;
const hostStructuredClone = globalThis.structuredClone;

export function createWindow(document, { url = 'http://localhost/', parentWindow = null, topWindow = null, frameElement = null, inheritedOrigin, isAncestorActive = null } = {}) {
  const touched = new Set();
  let windowProxy;
  let messageHandler = null;
  let messageErrorHandler = null;
  let generation = 0;
  let frames;
  const receiver = () => document.defaultView || windowProxy;
  let messageListener, messageErrorListener;
  const setHandler = (type, previous, next, listener) => {
    const handler = typeof next === 'function' ? next : null;
    if (previous && !handler) EventTarget.prototype.removeEventListener.call(receiver(), type, listener);
    else if (!previous && handler) EventTarget.prototype.addEventListener.call(receiver(), type, listener);
    return handler;
  };

  // Per-env globals: only the ~11 that capture document/url/windowProxy. Everything
  // stateless (constructors, timers, stateless window methods) lives in the shared
  // module-level STATIC_BASE, built ONCE — not rebuilt per createWindow (per test
  // file). The Proxy below reads base first, then STATIC_BASE, then lazy; a
  // `window.x = y` assignment writes to base, shadowing STATIC_BASE per-env.
  const base = {
    document,
    __listeners: null,
    frameElement,
    // Snapshot before installGlobals or an interceptor replaces globalThis.fetch.
    fetch: globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
    name: '',
    closed: false,
    // origin is lazy (per-env, captures url) — window.origin is rarely read, so the
    // eager `new URL(url)` parse per createWindow was usually wasted.
    // customElements is lazy (SHARED_LAZY) — env-independent + rarely used; building
    // its two Maps eagerly per createWindow was wasted for the typical test.
    Image: function Image(w, h) { const img = document.createElement('img'); if (w != null) img.setAttribute('width', w); if (h != null) img.setAttribute('height', h); return img; },
    getSelection: () => document.getSelection(),
    dispatchEvent: (e) => EventTarget.prototype.dispatchEvent.call(receiver(), e),
    addEventListener: (...a) => EventTarget.prototype.addEventListener.call(receiver(), ...a),
    removeEventListener: (...a) => EventTarget.prototype.removeEventListener.call(receiver(), ...a),
    get onmessage() { return messageHandler; },
    set onmessage(value) {
      if (!messageListener && typeof value === 'function') messageListener = function(event) { return messageHandler?.call(this, event); };
      messageHandler = setHandler('message', messageHandler, value, messageListener);
    },
    get onmessageerror() { return messageErrorHandler; },
    set onmessageerror(value) {
      if (!messageErrorListener && typeof value === 'function') messageErrorListener = function(event) { return messageErrorHandler?.call(this, event); };
      messageErrorHandler = setHandler('messageerror', messageErrorHandler, value, messageErrorListener);
    },
    postMessage(message, targetOrigin = '/', transfer = []) {
      if (typeof targetOrigin === 'object' && targetOrigin !== null) {
        transfer = targetOrigin.transfer ?? [];
        targetOrigin = targetOrigin.targetOrigin ?? '/';
      }
      const target = receiver();
      const source = globalThis.window || target;
      const origin = source.origin || source.location?.origin || 'null';
      let allowedOrigin = String(targetOrigin);
      if (allowedOrigin === '/') allowedOrigin = origin;
      else if (allowedOrigin !== '*') {
        try { allowedOrigin = new URL(allowedOrigin).origin; }
        catch { throw new SyntaxError('Invalid target origin'); }
      }
      if (typeof hostStructuredClone !== 'function') throw new Error('postMessage requires host structuredClone');
      const data = hostStructuredClone(message, { transfer });
      const sentGeneration = generation;
      (globalThis.setTimeout || hostSetTimeout)(() => {
        if (sentGeneration !== generation || target.document !== document || (isAncestorActive && !isAncestorActive())
          || (allowedOrigin !== '*' && allowedOrigin !== windowProxy.origin)) return;
        const event = new MessageEvent('message', { data, origin, source });
        event.data = data;
        base.dispatchEvent(event);
      }, 0);
    },
  };

  // Per-env lazy globals: ONLY those that capture document/url/windowProxy.
  // Everything env-independent lives in the module-level SHARED_LAZY (built once,
  // not re-allocated per test file) — see below. None constructed until touched.
  const lazy = {
    Audio: () => {
      function Audio(src) {
        const audio = document.createElement('audio');
        audio.preload = 'auto';
        if (src !== undefined) audio.setAttribute('src', src);
        return audio;
      }
      Audio.prototype = MediaElement.prototype;
      Object.defineProperty(Audio, Symbol.hasInstance, {
        value: (element) => element instanceof STATIC_BASE.HTMLAudioElement,
      });
      return Audio;
    },
    Option: () => {
      function Option(text = '', value, defaultSelected = false, selected = false) {
        const option = document.createElement('option');
        option.text = String(text);
        if (value !== undefined) option.value = String(value);
        if (defaultSelected) option.setAttribute('selected', '');
        option.selected = Boolean(selected);
        return option;
      }
      Option.prototype = STATIC_BASE.HTMLOptionElement.prototype;
      Object.defineProperty(Option, Symbol.hasInstance, {
        value: (element) => element instanceof STATIC_BASE.HTMLOptionElement,
      });
      return Option;
    },
    origin: () => inheritedOrigin ?? new URL(url).origin,
    // subsystem grouping: history co-materializes with (and shares) location
    location: () => makeLocation(url),
    history: () => makeHistory(windowProxy.location),
    // per-env so matchMedia can evaluate queries against THIS window's viewport
    matchMedia: () => makeMatchMedia(windowProxy),
  };

  windowProxy = new Proxy(base, {
    get(t, k) {
      if (k === 'parent') return parentWindow || windowProxy;
      if (k === 'top') return topWindow || parentWindow || windowProxy;
      if (k === 'window' || k === 'self' || k === 'globalThis' || k === 'frames') return windowProxy;
      if (k in t) return t[k];            // per-env (incl. overrides + materialized lazy)
      if (k in STATIC_BASE) return STATIC_BASE[k];  // shared stateless globals
      const factory = lazy[k] || SHARED_LAZY[k];
      if (factory) {
        touched.add(k);
        const v = factory();
        t[k] = v;                 // self-replace: subsequent reads skip the factory
        return v;
      }
      return undefined;
    },
    set(t, k, v) { t[k] = v; return true; },  // writes to base → shadows STATIC_BASE per-env
    has(t, k) {
      return k in t || k in STATIC_BASE || k in lazy || k in SHARED_LAZY ||
        k === 'window' || k === 'self' || k === 'globalThis' || k === 'frames' || k === 'parent' || k === 'top';
    },
    // so vi.spyOn(window, 'scrollTo'/'open'/…) finds STATIC_BASE methods as own
    // props; spyOn then defineProperty's the spy onto base (target), shadowing it.
    getOwnPropertyDescriptor(t, k) {
      const own = Object.getOwnPropertyDescriptor(t, k);
      if (own) return own;
      if (k in STATIC_BASE) return { configurable: true, enumerable: true, writable: true, value: STATIC_BASE[k] };
      return undefined;
    },
  });

  document.defaultView = windowProxy;
  document.__frameWindowFor = (frame) => {
    const html = frame.srcdoc;
    if (!frames) frames = new WeakMap();
    let child = frames.get(frame);
    if (!child || child.html !== html) {
      const parentGeneration = generation;
      const childDocument = new DOMParser().parseFromString(html, 'text/html');
      const entry = { html, window: null };
      const win = createWindow(childDocument, {
        url: frame.hasAttribute('srcdoc') ? 'about:srcdoc' : 'about:blank',
        parentWindow: receiver(), topWindow: receiver().top, frameElement: frame,
        inheritedOrigin: windowProxy.origin,
        isAncestorActive: () => parentGeneration === generation && receiver().document === document
          && frame.isConnected && frames.get(frame) === entry && frame.srcdoc === html
          && (!isAncestorActive || isAncestorActive()),
      });
      entry.window = win.window;
      child = entry;
      frames.set(frame, child);
    }
    return child.window;
  };

  return {
    window: windowProxy,
    // which lazy globals this test materialized (the "DOM surface used" report)
    touched: () => [...touched],
    // every global name this window can provide (for environment adapters)
    globalKeys: [...Object.keys(base), ...Object.keys(STATIC_BASE), ...Object.keys(lazy), ...Object.keys(SHARED_LAZY)],
    // Layer 5: drop materialized global slots, keep the class machinery warm.
    resetGlobals() {
      generation++;
      base.__listeners = null;
      messageHandler = null;
      messageErrorHandler = null;
      for (const k of touched) delete base[k];
      touched.clear();
    },
  };
}

// No static `node:` import — the runtime must load in a bare V8 isolate (no Node,
// no web-platform globals). Capture the HOST `performance` at module load, BEFORE
// turbo-dom installs its own `performance` global (else performanceNow → installed
// performance.now → performanceNow → ∞). Falls back to Date.now() in a bare V8.
const hostPerformance = globalThis.performance;
const performanceNow = typeof hostPerformance?.now === 'function'
  ? () => hostPerformance.now()
  : () => Date.now();

// Injectable clock. `window.performance.now()` and the rAF callback timestamp both
// read through now(), so a single setClock() drives both. Default (null) → real
// host clock, no behavior change for vitest/jest. The render tier installs a VIRTUAL
// clock that advances per drained frame so time-gated rAF loops terminate (see the
// synthetic-geometry/clock note in CLAUDE.md). Resolves performanceNow lazily, so it
// stays defined regardless of where setClock is called. (Date.now is the embedder's
// to override — turbo-dom never shadows it.)
let __clock = null;
function now() { return __clock ? __clock() : performanceNow(); }
export function setClock(fn) { __clock = typeof fn === 'function' ? fn : null; }

// base64 without depending on the Node `Buffer` global — prefer the platform
// btoa/atob, then Buffer (Node), then a pure-JS fallback so a bare-isolate page
// that calls btoa/atob doesn't throw.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const turboBtoa = typeof globalThis.btoa === 'function'
  ? globalThis.btoa.bind(globalThis)
  : typeof Buffer !== 'undefined'
    ? (s) => Buffer.from(String(s), 'binary').toString('base64')
    : (s) => {
        const str = String(s); let out = '';
        for (let i = 0; i < str.length;) {
          const c1 = str.charCodeAt(i++), c2 = str.charCodeAt(i++), c3 = str.charCodeAt(i++);
          const e1 = c1 >> 2, e2 = ((c1 & 3) << 4) | (c2 >> 4);
          let e3 = ((c2 & 15) << 2) | (c3 >> 6), e4 = c3 & 63;
          if (isNaN(c2)) { e3 = e4 = 64; } else if (isNaN(c3)) { e4 = 64; }
          out += B64[e1] + B64[e2] + (e3 === 64 ? '=' : B64[e3]) + (e4 === 64 ? '=' : B64[e4]);
        }
        return out;
      };
const turboAtob = typeof globalThis.atob === 'function'
  ? globalThis.atob.bind(globalThis)
  : typeof Buffer !== 'undefined'
    ? (s) => Buffer.from(String(s), 'base64').toString('binary')
    : (s) => {
        const str = String(s).replace(/[^A-Za-z0-9+/]/g, ''); let out = '';
        for (let i = 0; i < str.length;) {
          const e1 = B64.indexOf(str[i++]), e2 = B64.indexOf(str[i++]);
          const e3 = B64.indexOf(str[i++]), e4 = B64.indexOf(str[i++]);
          out += String.fromCharCode((e1 << 2) | (e2 >> 4));
          if (e3 !== -1 && e3 !== 64) out += String.fromCharCode(((e2 & 15) << 4) | (e3 >> 2));
          if (e4 !== -1 && e4 !== 64) out += String.fromCharCode(((e3 & 3) << 6) | e4);
        }
        return out;
      };

// Resolve the host base classes ONCE, with minimal fallbacks so turbo-dom loads &
// runs in a bare V8 lacking web-platform globals. Where the platform provides the
// real class (Node/browser) we extend it and keep full behavior; the fallbacks are
// only enough to not throw at load and to round-trip the few fields turbo-dom uses.
// Embedders wanting full URL parsing / Blob semantics should still polyfill the
// host globals — these are honest minimums, not a spec implementation.
const URLBase = typeof URL !== 'undefined' ? URL : class URL {
  constructor(url, base) { this.href = base ? `${base}${url}` : String(url); }
  toString() { return this.href; }
  get origin() { return ''; }
};
const BlobBase = typeof globalThis.Blob !== 'undefined' ? globalThis.Blob : class Blob {
  constructor(parts = [], opts = {}) { this.__parts = parts; this.type = opts.type || ''; this.size = 0; }
  async text() { return (this.__parts || []).join(''); }
  async arrayBuffer() { return new ArrayBuffer(0); }
  slice() { return new BlobBase(); }
};

let __objUrlSeq = 0;
function makeURL() {
  class TurboURL extends URLBase {}
  TurboURL.createObjectURL = () => `blob:turbo-dom/${++__objUrlSeq}`;
  TurboURL.revokeObjectURL = () => {};
  return TurboURL;
}
function makeFile() {
  return class File extends BlobBase {
    constructor(bits = [], name = 'file', opts = {}) { super(bits, opts); this.name = String(name); this.lastModified = opts.lastModified || 0; }
  };
}
// stateless — build the classes ONCE, not per createWindow() (per test file).
const TURBO_URL = makeURL();
const TURBO_FILE = makeFile();

// Minimal XMLHttpRequest backed by fetch — enough that libraries that construct
// one and issue a request don't crash. No-network setups still get a clean object.
function makeXHR() {
  return class XMLHttpRequest {
    constructor() {
      this.readyState = 0; this.status = 0; this.statusText = ''; this.response = ''; this.responseText = '';
      this.responseType = ''; this.timeout = 0; this.withCredentials = false;
      this.onreadystatechange = null; this.onload = null; this.onerror = null; this.onabort = null;
      this.__headers = {}; this.__method = 'GET'; this.__url = ''; this.__listeners = new Map(); this.__aborted = false;
    }
    open(method, url) { this.__method = method; this.__url = url; this.readyState = 1; this.__fire('readystatechange'); }
    setRequestHeader(k, v) { this.__headers[k] = v; }
    getResponseHeader() { return null; }
    getAllResponseHeaders() { return ''; }
    addEventListener(t, cb) { const l = this.__listeners.get(t) || []; l.push(cb); this.__listeners.set(t, l); }
    removeEventListener(t, cb) { const l = this.__listeners.get(t); if (l) this.__listeners.set(t, l.filter((x) => x !== cb)); }
    __fire(type) { const ev = { type, target: this }; if (typeof this['on' + type] === 'function') this['on' + type](ev); for (const cb of this.__listeners.get(type) || []) cb(ev); }
    abort() { this.__aborted = true; this.readyState = 0; this.__fire('abort'); }
    send(body) {
      if (!globalThis.fetch) { this.readyState = 4; this.status = 0; this.__fire('error'); this.__fire('loadend'); return; }
      globalThis.fetch(this.__url, { method: this.__method, headers: this.__headers, body }).then(async (res) => {
        if (this.__aborted) return;
        this.status = res.status; this.statusText = res.statusText; this.responseText = await res.text(); this.response = this.responseText;
        this.readyState = 4; this.__fire('readystatechange'); this.__fire('load'); this.__fire('loadend');
      }).catch(() => { if (this.__aborted) return; this.readyState = 4; this.status = 0; this.__fire('error'); this.__fire('loadend'); });
    }
  };
}

// Stateless globals — identical for every window, so built ONCE at module load
// instead of per createWindow() (per test file). createWindow's Proxy falls back
// to this after its tiny per-env `base`. Nothing here captures document/url/window.
const STATIC_BASE = {
  // DOM + event constructors (cheap class refs)
  Node, Element, Text, Comment, Document, DocumentFragment, DocumentType, EventTarget, NamedNodeMap,
  ShadowRoot,
  Event, CustomEvent, MessageEvent,
  UIEvent, MouseEvent, PointerEvent, KeyboardEvent, InputEvent, FocusEvent,
  CompositionEvent, WheelEvent, TouchEvent, DragEvent, ProgressEvent, ClipboardEvent,
  DataTransfer,
  // HTML interfaces inherit Element → `el instanceof HTMLElement` is true.
  // Tag-specific interfaces match by localName via Symbol.hasInstance.
  HTMLElement: Element, SVGElement,
  // SVG interface globals. Libs (and test setup mocks) do
  // `Object.defineProperty(SVGSVGElement.prototype, 'viewBox', …)` and
  // `el instanceof SVGSVGElement`; an undefined global is a hard ReferenceError.
  SVGSVGElement: tagClass('svg'), SVGPathElement: tagClass('path'),
  SVGGElement: tagClass('g'), SVGCircleElement: tagClass('circle'),
  SVGRectElement: tagClass('rect'), SVGLineElement: tagClass('line'),
  SVGEllipseElement: tagClass('ellipse'), SVGPolygonElement: tagClass('polygon'),
  SVGPolylineElement: tagClass('polyline'), SVGTextElement: tagClass('text'),
  SVGTSpanElement: tagClass('tspan'), SVGUseElement: tagClass('use'),
  SVGDefsElement: tagClass('defs'), SVGImageElement: tagClass('image'),
  SVGStopElement: tagClass('stop'), SVGSymbolElement: tagClass('symbol'),
  SVGMarkerElement: tagClass('marker'), SVGClipPathElement: tagClass('clipPath'),
  SVGMaskElement: tagClass('mask'), SVGPatternElement: tagClass('pattern'),
  SVGTitleElement: tagClass('title'), SVGDescElement: tagClass('desc'),
  SVGForeignObjectElement: tagClass('foreignObject'),
  SVGGraphicsElement: Element, SVGGeometryElement: Element, SVGTextContentElement: Element,
  HTMLAnchorElement: tagClass('a'), HTMLInputElement: tagClass('input'),
  HTMLTextAreaElement: tagClass('textarea'), HTMLSelectElement: tagClass('select'),
  HTMLOptionElement: tagClass('option'), HTMLButtonElement: tagClass('button'),
  HTMLFormElement: tagClass('form'), HTMLImageElement: tagClass('img'),
  HTMLCanvasElement: tagClass('canvas', CanvasElement.prototype), HTMLTemplateElement: tagClass('template'),
  HTMLLabelElement: tagClass('label'), HTMLDivElement: tagClass('div'),
  HTMLSpanElement: tagClass('span'), HTMLParagraphElement: tagClass('p'),
  HTMLUListElement: tagClass('ul'), HTMLLIElement: tagClass('li'),
  HTMLBodyElement: tagClass('body'), HTMLIFrameElement: tagClass('iframe'),
  HTMLHeadingElement: tagClass(/^h[1-6]$/),
  // Previously-missing interfaces: undefined globals make `el instanceof HTMLXElement`
  // throw "Right-hand side of 'instanceof' is not an object" — worse than returning
  // false. RTL/React probe these constantly.
  HTMLTableElement: tagClass('table'), HTMLTableRowElement: tagClass('tr'),
  HTMLTableCellElement: tagClass(/^(td|th)$/), HTMLTableSectionElement: tagClass(/^(thead|tbody|tfoot)$/),
  HTMLTableColElement: tagClass(/^(col|colgroup)$/), HTMLTableCaptionElement: tagClass('caption'),
  HTMLOListElement: tagClass('ol'), HTMLDListElement: tagClass('dl'),
  HTMLFieldSetElement: tagClass('fieldset'), HTMLLegendElement: tagClass('legend'),
  HTMLOptGroupElement: tagClass('optgroup'), HTMLDataListElement: tagClass('datalist'),
  HTMLOutputElement: tagClass('output'), HTMLProgressElement: tagClass('progress'),
  HTMLMeterElement: tagClass('meter'), HTMLDetailsElement: tagClass('details'),
  HTMLDialogElement: tagClass('dialog'), HTMLPreElement: tagClass('pre'),
  HTMLBRElement: tagClass('br'), HTMLHRElement: tagClass('hr'),
  HTMLQuoteElement: tagClass(/^(q|blockquote)$/), HTMLModElement: tagClass(/^(ins|del)$/),
  HTMLPictureElement: tagClass('picture'), HTMLSourceElement: tagClass('source'),
  HTMLTrackElement: tagClass('track'), HTMLVideoElement: tagClass('video', MediaElement.prototype),
  HTMLAudioElement: tagClass('audio', MediaElement.prototype), HTMLMediaElement: tagClass(/^(video|audio)$/, MediaElement.prototype),
  HTMLEmbedElement: tagClass('embed'), HTMLObjectElement: tagClass('object'),
  HTMLMapElement: tagClass('map'), HTMLAreaElement: tagClass('area'),
  HTMLScriptElement: tagClass('script'), HTMLStyleElement: tagClass('style'),
  HTMLLinkElement: tagClass('link'), HTMLMetaElement: tagClass('meta'),
  HTMLTitleElement: tagClass('title'), HTMLBaseElement: tagClass('base'),
  HTMLHeadElement: tagClass('head'), HTMLHtmlElement: tagClass('html'),
  HTMLDataElement: tagClass('data'), HTMLTimeElement: tagClass('time'),
  HTMLSlotElement: tagClass('slot'), HTMLMenuElement: tagClass('menu'),
  HTMLDocument: Document,
  MutationObserver, DOMParser, XMLSerializer, CSSStyleSheet,
  URL: TURBO_URL, URLSearchParams: typeof URLSearchParams !== 'undefined' ? URLSearchParams : undefined,
  Blob: BlobBase, File: TURBO_FILE, FileReader,
  AbortController: globalThis.AbortController, AbortSignal: globalThis.AbortSignal,
  TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
  Headers: globalThis.Headers, Request: globalThis.Request, Response: globalThis.Response,
  FormData: TurboFormData, ReadableStream: globalThis.ReadableStream,
  crypto: globalThis.crypto, Crypto: globalThis.Crypto, SubtleCrypto: globalThis.SubtleCrypto,
  btoa: (s) => turboBtoa(String(s)),
  atob: (s) => turboAtob(String(s)),
  MessageChannel, MessagePort,
  BroadcastChannel: globalThis.BroadcastChannel, EventSource: globalThis.EventSource,
  reportError: (e) => { void e; },
  requestIdleCallback: (cb) => hostSetTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0),
  cancelIdleCallback: (id) => hostClearTimeout(id),
  CSS: { supports: () => true, escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c) },
  XMLHttpRequest: makeXHR(),
  Worker: class Worker { constructor() {} postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} },
  // timers delegate to captured host fns (NOT bare names — installed bare names
  // would resolve back here → recursion)
  setTimeout: (...a) => hostSetTimeout(...a),
  clearTimeout: (...a) => hostClearTimeout(...a),
  setInterval: (...a) => hostSetInterval(...a),
  clearInterval: (...a) => hostClearInterval(...a),
  queueMicrotask: (...a) => hostQueueMicrotask(...a),
  structuredClone: (...a) => hostStructuredClone(...a),
  scrollTo() {}, scroll() {}, scrollBy() {},
  open: () => null, close() {}, stop() {}, print() {}, focus() {}, blur() {},
  moveTo() {}, moveBy() {}, resizeTo() {}, resizeBy() {},
  alert() {}, confirm: () => false, prompt: () => null,
};
