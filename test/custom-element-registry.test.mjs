import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createEnvironment } from '../src/runtime/index.mjs';
import { makeCustomElements } from '../src/runtime/stubs.mjs';

const fresh = (html = '') => createEnvironment(`<!doctype html><body>${html}</body>`);
function errors(window) {
  const received = [];
  window.addEventListener('error', event => { received.push(event.error); event.preventDefault(); });
  return received;
}

test('registry validates autonomous names and constructor/definition uniqueness', () => {
  const { window } = fresh();
  const registry = window.customElements;
  assert.throws(() => new window.CustomElementRegistry(), { name: 'NotSupportedError' });
  assert.throws(() => new window.HTMLElement(), TypeError);
  assert.throws(() => window.HTMLElement(), TypeError);
  for (const name of ['widget', 'X-widget', 'annotation-xml', 'font-face', 'x-!', '-widget']) {
    assert.throws(() => registry.define(name, class extends window.HTMLElement {}), { name: 'SyntaxError' });
  }
  for (const constructor of [null, {}, () => {}, function* Generator() {}]) {
    assert.throws(() => registry.define('x-invalid', constructor), TypeError);
  }
  class C extends window.HTMLElement {}
  registry.define('x-valid', C);
  assert.equal(registry.get('x-valid'), C);
  assert.equal(registry.get('x-unknown'), undefined);
  assert.equal(registry.getName(C), 'x-valid');
  assert.equal(registry.getName(class {}), null);
  assert.throws(() => registry.define('x-valid', class {}), { name: 'NotSupportedError' });
  assert.throws(() => registry.define('x-second', C), { name: 'NotSupportedError' });
  assert.throws(() => registry.upgrade(null), TypeError);
});

test('whenDefined uses one pending promise, resolves a definition and rejects invalid names', async () => {
  const { window } = fresh();
  const registry = window.customElements;
  const promise = registry.whenDefined('x-later');
  assert.equal(registry.whenDefined('x-later'), promise);
  class C extends window.HTMLElement {}
  registry.define('x-later', C);
  assert.equal(await promise, C);
  assert.equal(await registry.whenDefined('x-later'), C);
  await assert.rejects(registry.whenDefined('invalid'), { name: 'SyntaxError' });
  const coercionError = new Error('name coercion');
  assert.throws(() => registry.whenDefined({ toString() { throw coercionError; } }), coercionError);
});

test('callbacks and observed attributes are validated atomically, including getter reentrancy', async () => {
  const { window } = fresh();
  const registry = window.customElements;
  class BadCallback extends window.HTMLElement {}
  BadCallback.prototype.connectedCallback = 2;
  assert.throws(() => registry.define('x-retry', BadCallback), TypeError);
  const NoPrototype = function() {};
  NoPrototype.prototype = null;
  assert.throws(() => registry.define('x-retry', NoPrototype), TypeError);
  const badAttributes = class extends window.HTMLElement { static observedAttributes = null; attributeChangedCallback() {} };
  assert.throws(() => registry.define('x-retry', badAttributes), TypeError);
  class Reentrant extends window.HTMLElement {
    static get observedAttributes() {
      assert.throws(() => registry.define('x-nested', class {}), { name: 'NotSupportedError' });
      throw new Error('attribute getter');
    }
    attributeChangedCallback() {}
  }
  assert.throws(() => registry.define('x-retry', Reentrant), /attribute getter/);
  assert.equal(registry.get('x-retry'), undefined);
  assert.equal(registry.get('x-nested'), undefined);
  const pending = registry.whenDefined('x-retry');
  class Good extends window.HTMLElement { static get observedAttributes() { throw new Error('must not be read without callback'); } }
  registry.define('x-retry', Good);
  assert.equal(await pending, Good);
});

test('customized built-ins and form-associated definitions fail explicitly without registering', () => {
  const { window } = fresh();
  const registry = window.customElements;
  class C extends window.HTMLElement {}
  assert.throws(() => registry.define('x-button', C, { extends: 'button' }), { name: 'NotSupportedError' });
  class Form extends window.HTMLElement { static formAssociated = true; }
  assert.throws(() => registry.define('x-form', Form), { name: 'NotSupportedError' });
  assert.equal(registry.get('x-button'), undefined);
  assert.equal(registry.get('x-form'), undefined);
});

test('late constructor failure reports once, preserves identity and prevents subsequent upgrade attempts', () => {
  const { window, document } = fresh('<x-broken watched="a"></x-broken>');
  const received = errors(window);
  const element = document.querySelector('x-broken');
  let attempts = 0, callbacks = 0;
  class Broken extends window.HTMLElement {
    constructor() { super(); attempts++; throw new Error('construction failed'); }
    static observedAttributes = ['watched'];
    attributeChangedCallback() { callbacks++; }
    connectedCallback() { callbacks++; }
  }
  window.customElements.define('x-broken', Broken);
  assert.equal(element, document.querySelector('x-broken'));
  assert.equal(attempts, 1);
  assert.equal(callbacks, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].message, 'construction failed');
  assert.equal(element.matches(':defined'), false);
  window.customElements.upgrade(element);
  element.remove();
  document.body.appendChild(element);
  assert.equal(attempts, 1);
  assert.equal(callbacks, 0);
});

test('synchronous createElement failures return failed fallback elements while direct new throws', () => {
  const { window, document } = fresh();
  const received = errors(window);
  class Throws extends window.HTMLElement { constructor() { super(); throw new Error('broken'); } }
  class WrongReturn extends window.HTMLElement { constructor() { return {}; } }
  class Twice extends window.HTMLElement { constructor() { super(); super(); } }
  class Attributes extends window.HTMLElement { constructor() { super(); this.setAttribute('a', '1'); } }
  class Children extends window.HTMLElement { constructor() { super(); this.appendChild(document.createElement('span')); } }
  class Parent extends window.HTMLElement { constructor() { super(); document.body.appendChild(this); } }
  for (const [name, C] of [['throws', Throws], ['return', WrongReturn], ['twice', Twice], ['attributes', Attributes], ['children', Children], ['parent', Parent]]) {
    window.customElements.define('x-' + name, C);
    const element = document.createElement('x-' + name);
    assert.equal(element.localName, 'x-' + name);
    assert.equal(element instanceof C, false);
    assert.equal(element.matches(':defined'), false);
    assert.equal(element.hasAttributes(), false);
    assert.equal(element.childNodes.length, 0);
  }
  assert.equal(received.length, 6);
  assert.throws(() => new Throws(), /broken/);
});

test('callback errors are reported without aborting subsequent custom-element reactions', () => {
  const { window, document } = fresh('<x-errors></x-errors><x-errors></x-errors>');
  const received = errors(window);
  let connected = 0, attributes = 0;
  class ErrorElement extends window.HTMLElement {
    static observedAttributes = ['watched'];
    connectedCallback() { connected++; throw new Error('callback failed'); }
    attributeChangedCallback() { attributes++; throw new Error('attribute failed'); }
  }
  window.customElements.define('x-errors', ErrorElement);
  assert.equal(connected, 2);
  document.querySelector('x-errors').setAttribute('watched', '1');
  assert.equal(attributes, 1);
  assert.deepEqual(received.map(error => error.message), ['callback failed', 'callback failed', 'attribute failed']);
});

test('HTML namespace construction is supported and SVG is never upgraded', () => {
  const { window, document } = fresh();
  class C extends window.HTMLElement {}
  window.customElements.define('x-widget', C);
  const html = document.createElementNS('http://www.w3.org/1999/xhtml', 'x-widget');
  assert.ok(html instanceof C);
  for (const namespace of ['http://www.w3.org/2000/svg', 'urn:test', null, '']) {
    const foreign = document.createElementNS(namespace, 'x-widget');
    assert.equal(foreign.namespaceURI, namespace || null);
    assert.equal(foreign instanceof C, false);
    document.body.appendChild(foreign);
    window.customElements.upgrade(foreign);
    assert.equal(foreign instanceof C, false);
    assert.equal(foreign.matches(':defined'), true);
  }
});

test('explicit upgrade never uses another window registry or upgrades inert template content', () => {
  const a = fresh(), b = fresh('<template><x-widget></x-widget></template>');
  class C extends a.window.HTMLElement {}
  a.window.customElements.define('x-widget', C);
  const element = b.document.createElement('x-widget');
  a.window.customElements.upgrade(element);
  assert.equal(element instanceof C, false);
  a.window.customElements.upgrade(b.document.querySelector('template').content);
  assert.equal(b.document.querySelector('template').content.firstChild instanceof C, false);
});

test('standalone registry retains the existing define/get/getName/whenDefined API', async () => {
  const registry = makeCustomElements();
  class C {}
  registry.define('x-test', C);
  assert.equal(registry.get('x-test'), C);
  assert.equal(registry.getName(C), 'x-test');
  assert.equal(await registry.whenDefined('x-test'), C);
});

test('uncanceled custom-element error events are reported to the host console', () => {
  const { window, document } = fresh();
  const received = [];
  const original = console.error;
  console.error = error => received.push(error);
  try {
    class C extends window.HTMLElement { connectedCallback() { throw new Error('visible error'); } }
    window.customElements.define('x-error-report', C);
    document.body.appendChild(document.createElement('x-error-report'));
    assert.equal(received.length, 1);
    assert.equal(received[0].message, 'visible error');
  } finally { console.error = original; }
});

test('custom-element name validation remains usable without a host DOMException constructor', () => {
  const url = new URL('../src/runtime/custom-elements.mjs', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    delete globalThis.DOMException;
    const { makeCustomElements } = await import(${JSON.stringify(url)});
    assert.throws(() => makeCustomElements().define('invalid', class {}), { name: 'SyntaxError' });
  `]);
});

test('custom-element DOM method overrides cannot change construction invariants or initial attribute notifications', () => {
  const { window, document } = fresh('<x-overridden watched="real"></x-overridden>');
  const existing = document.querySelector('x-overridden');
  existing.getAttributeNames = () => [];
  existing.getAttribute = () => 'fake';
  const received = [];
  class C extends window.HTMLElement {
    static observedAttributes = ['watched'];
    hasAttributes() { return true; }
    attributeChangedCallback(...args) { received.push(args); }
  }
  window.customElements.define('x-overridden', C);
  assert.deepEqual(received, [['watched', null, 'real', null]]);
  assert.ok(document.createElement('x-overridden') instanceof C);
  const failed = errors(window);
  class HiddenAttributes extends window.HTMLElement {
    constructor() { super(); this.setAttribute('hidden', ''); }
    hasAttributes() { return false; }
  }
  window.customElements.define('x-hidden-attributes', HiddenAttributes);
  assert.equal(document.createElement('x-hidden-attributes') instanceof HiddenAttributes, false);
  assert.equal(failed[0].name, 'NotSupportedError');
});

test('registry string conversion and observedAttributes reject non-Web-IDL values', () => {
  const { window } = fresh();
  const registry = window.customElements;
  assert.throws(() => registry.define(Symbol('name'), class {}), TypeError);
  assert.throws(() => registry.get(Symbol('name')), TypeError);
  assert.throws(() => registry.whenDefined(Symbol('name')), TypeError);
  assert.throws(() => window.CustomElementRegistry.prototype.whenDefined.call({}, 'bad'), TypeError);
  for (const value of ['watched', 3, null, [Symbol('attribute')]]) {
    class C extends window.HTMLElement { static observedAttributes = value; attributeChangedCallback() {} }
    assert.throws(() => registry.define('x-invalid-attributes', C), TypeError);
  }
});
