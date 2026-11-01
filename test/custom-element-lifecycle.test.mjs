import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEnvironment } from '../src/runtime/index.mjs';
import { installGlobals } from '../src/environment/install.mjs';

const fresh = (html = '') => createEnvironment(`<!doctype html><html><body>${html}</body></html>`);
function oracle(html, scenario) {
  const actual = fresh(html).window;
  const expected = new JSDOM(html).window;
  assert.deepEqual(scenario(actual), scenario(expected));
  expected.close();
}

function widget(window, events, name = 'x-widget') {
  class Widget extends window.HTMLElement {
    #ready = true;
    constructor() { super(); events.push(['constructor', this.localName, this.getAttribute('watched')]); }
    static observedAttributes = ['watched'];
    connectedCallback() { events.push(['connected', this.#ready, this.isConnected]); }
    disconnectedCallback() { events.push(['disconnected', this.isConnected]); }
    adoptedCallback(oldDocument, newDocument) { events.push(['adopted', oldDocument !== newDocument, this.ownerDocument === newDocument]); }
    attributeChangedCallback(...args) { events.push(['attribute', ...args]); }
    ready() { return this.#ready; }
  }
  window.customElements.define(name, Widget);
  return Widget;
}

test('registered element construction, direct new and basic lifecycle match jsdom', () => {
  oracle('', window => {
    const events = [];
    const Widget = widget(window, events);
    const first = window.document.createElement('x-widget');
    const second = new Widget();
    assert.equal(first.ownerDocument, window.document);
    assert.ok(first instanceof Widget);
    assert.ok(second instanceof window.HTMLElement);
    assert.ok(window.customElements instanceof window.CustomElementRegistry);
    window.document.body.append(first, second);
    first.setAttribute('watched', '1');
    first.setAttribute('watched', '1');
    first.toggleAttribute('watched', false);
    first.removeAttribute('watched');
    first.remove();
    window.document.body.append(first);
    window.document.body.replaceChildren();
    return events;
  });
});

test('late upgrades preserve node identity, children, listeners, fields and initial attribute order', () => {
  oracle('<x-widget watched="initial"><span>Child</span></x-widget>', window => {
    const element = window.document.querySelector('x-widget');
    const child = element.firstChild;
    element.extra = 3;
    let clicks = 0;
    element.addEventListener('click', () => clicks++);
    assert.equal(element.matches(':defined'), false);
    const events = [];
    const Widget = widget(window, events);
    assert.equal(element, window.document.querySelector('x-widget'));
    assert.equal(child, element.firstChild);
    assert.ok(element instanceof Widget);
    assert.equal(element.ready(), true);
    assert.equal(element.extra, 3);
    assert.equal(element.matches(':defined'), true);
    element.click();
    assert.equal(clicks, 1);
    window.customElements.upgrade(element);
    return events;
  });
});

test('late detached candidates upgrade only on connection or explicit subtree upgrade', () => {
  oracle('', window => {
    const { document } = window;
    const detached = document.createElement('x-widget');
    const explicit = document.createElement('x-widget');
    const root = document.createElement('div');
    root.appendChild(detached);
    const events = [];
    const Widget = widget(window, events);
    assert.equal(events.length, 0);
    root.appendChild(explicit);
    assert.equal(events.length, 0);
    window.customElements.upgrade(root);
    assert.ok(detached instanceof Widget);
    assert.ok(explicit instanceof Widget);
    document.body.appendChild(root);
    root.remove();
    return events;
  });
});

test('parsed fragments, adjacent HTML, clone and shadow-root markup upgrade registered elements', () => {
  oracle('', window => {
    const { document } = window;
    const events = [];
    const Widget = widget(window, events);
    const root = document.createElement('div');
    root.innerHTML = '<x-widget watched="a"><span>A</span></x-widget>';
    const element = root.firstChild;
    assert.ok(element instanceof Widget);
    const clone = element.cloneNode(true);
    assert.ok(clone instanceof Widget);
    assert.equal(clone.innerHTML, '<span>A</span>');
    root.appendChild(clone);
    root.insertAdjacentHTML('beforeend', '<x-widget watched="b"></x-widget>');
    element.insertAdjacentHTML('beforeend', '<b>B</b>');
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<x-widget watched="shadow"></x-widget>';
    document.body.append(root, host);
    root.textContent = '';
    shadow.innerHTML = '';
    return events;
  });
});

test('definition upgrades lazy parsed candidates inside shadow trees but not template contents', () => {
  oracle('<template><x-widget watched="template"></x-widget></template><div id="host"></div>', window => {
    const { document } = window;
    const template = document.querySelector('template');
    const fragment = template.content;
    const host = document.querySelector('#host');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<x-widget watched="shadow"></x-widget>';
    const events = [];
    const Widget = widget(window, events);
    assert.equal(fragment.firstChild instanceof Widget, false);
    window.customElements.upgrade(fragment);
    assert.equal(fragment.firstChild instanceof Widget, false);
    document.body.appendChild(fragment);
    host.remove();
    return events;
  });
});

test('moves and bulk replacements deliver disconnection before reconnection', () => {
  oracle('<div id="a"></div><div id="b"></div>', window => {
    const events = [];
    widget(window, events);
    const { document } = window;
    const a = document.querySelector('#a'), b = document.querySelector('#b');
    a.innerHTML = '<x-widget></x-widget>';
    const first = a.firstChild;
    const second = document.createElement('x-widget');
    events.length = 0;
    b.appendChild(first);
    b.replaceChildren(second);
    second.before(first);
    first.after(second);
    second.replaceWith(first);
    b.textContent = '';
    return events;
  });
});

test('reentrant attribute callbacks and registry definitions preserve observable reaction ordering', () => {
  oracle('', window => {
    const events = [];
    class Reentrant extends window.HTMLElement {
      static observedAttributes = ['a', 'b'];
      connectedCallback() { events.push('connected'); this.setAttribute('a', '1'); }
      attributeChangedCallback(name) {
        events.push('start-' + name);
        if (name === 'a') this.setAttribute('b', '2');
        events.push('end-' + name);
      }
    }
    window.customElements.define('x-reentrant', Reentrant);
    const element = window.document.createElement('x-reentrant');
    window.document.body.append(element);
    return events;
  });
});

test('cross-document adoption preserves the original class; imports construct with destination definitions', () => {
  const a = fresh(), b = fresh();
  const events = [];
  const A = widget(a.window, events);
  const B = widget(b.window, events);
  const element = a.document.createElement('x-widget');
  element.setAttribute('watched', 'original');
  a.document.body.appendChild(element);
  const clone = b.document.importNode(element, true);
  assert.ok(clone instanceof B);
  assert.equal(clone.ready(), true);
  const blank = fresh();
  assert.equal(blank.document.importNode(element, true) instanceof A, false);
  events.length = 0;
  b.document.body.appendChild(element);
  assert.ok(element instanceof A);
  assert.deepEqual(events, [['disconnected', true], ['adopted', true, true], ['connected', true, true]]);
  events.length = 0;
  a.document.adoptNode(element);
  assert.deepEqual(events, [['disconnected', false], ['adopted', true, true]]);
});

test('observed callbacks are snapshotted at definition time and ignore unrelated mutations', () => {
  const { window, document } = fresh();
  const events = [];
  const C = widget(window, events);
  C.prototype.connectedCallback = () => assert.fail('definition callback must be captured');
  C.observedAttributes = ['other'];
  const node = document.createElement('x-widget');
  node.dataset.other = '2';
  node.setAttribute('unobserved', '3');
  node.setAttribute('watched', '4');
  document.body.prepend(node);
  assert.deepEqual(events, [['constructor', 'x-widget', null], ['attribute', 'watched', null, '4', null], ['connected', true, true]]);
});

test('registry state is independent across windows and is discarded by reset', async () => {
  const a = fresh(), b = fresh();
  const oldRegistry = a.window.customElements;
  const OldBase = a.window.HTMLElement;
  const events = [];
  const C = widget(a.window, events);
  assert.equal(b.window.customElements.get('x-widget'), undefined);
  const detached = a.document.createElement('x-widget');
  a.reset('<body><x-widget></x-widget></body>');
  assert.notEqual(a.window.customElements, oldRegistry);
  assert.notEqual(a.window.HTMLElement, OldBase);
  assert.equal(a.window.customElements.get('x-widget'), undefined);
  assert.equal(a.document.querySelector('x-widget') instanceof C, false);
  events.length = 0;
  a.document.body.appendChild(detached);
  await Promise.resolve();
  assert.deepEqual(events, []);
  assert.throws(() => oldRegistry.define('x-dead', class {}), { name: 'InvalidStateError' });
  assert.throws(() => oldRegistry.upgrade(detached), { name: 'InvalidStateError' });
  await assert.rejects(oldRegistry.whenDefined('x-dead'), { name: 'InvalidStateError' });
  assert.throws(() => new C(), TypeError);
});

test('installed globals expose the bound HTMLElement constructor and teardown suppresses pending reactions', async () => {
  const target = {};
  const { env, teardown } = installGlobals(target);
  const events = [];
  widget(target, events);
  const element = target.document.createElement('x-widget');
  target.document.body.appendChild(element);
  assert.equal(element.ownerDocument.defaultView, target);
  teardown();
  events.length = 0;
  env.document.body.appendChild(element);
  await Promise.resolve();
  assert.deepEqual(events, []);
});

test(':defined query caches invalidate after an explicit detached-subtree upgrade', () => {
  const { window, document } = fresh();
  const fragment = document.createDocumentFragment();
  fragment.appendChild(document.createElement('x-widget'));
  assert.equal(fragment.querySelectorAll(':defined').length, 0);
  widget(window, []);
  window.customElements.upgrade(fragment);
  assert.equal(fragment.querySelectorAll(':defined').length, 1);
  assert.equal(document.createElement('div').matches(':defined'), true);
  assert.equal(document.createElementNS('http://www.w3.org/2000/svg', 'x-svg').matches(':defined'), true);
  assert.equal(document.createElement('annotation-xml').matches(':defined'), true);
});

test('backup reactions run at a microtask checkpoint and are canceled when their environment is disposed', async () => {
  const { customElementAttribute } = await import('../src/runtime/custom-elements.mjs');
  const env = fresh();
  const events = [];
  widget(env.window, events);
  const element = env.document.createElement('x-widget');
  events.length = 0;
  customElementAttribute(element, 'watched', null, 'first');
  customElementAttribute(element, 'watched', 'first', 'second');
  assert.deepEqual(events, []);
  await Promise.resolve();
  assert.deepEqual(events, [['attribute', 'watched', null, 'first', null], ['attribute', 'watched', 'first', 'second', null]]);
  events.length = 0;
  customElementAttribute(element, 'watched', 'second', 'stale');
  env.reset();
  await Promise.resolve();
  assert.deepEqual(events, []);
});

test('iframe custom-element registries are independent and discarded frame reactions cannot run', async () => {
  const { customElementAttribute } = await import('../src/runtime/custom-elements.mjs');
  const { document, window } = fresh();
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const child = frame.contentWindow;
  const events = [];
  widget(child, events);
  assert.equal(window.customElements.get('x-widget'), undefined);
  const element = child.document.createElement('x-widget');
  child.document.body.appendChild(element);
  events.length = 0;
  customElementAttribute(element, 'watched', null, 'stale');
  frame.remove();
  await Promise.resolve();
  assert.deepEqual(events, []);
  class Orphan extends child.HTMLElement {}
  assert.throws(() => new Orphan(), TypeError);
});

test('adopting a shadow host updates closed shadow descendants and delivers their lifecycle', () => {
  function scenario(a, b) {
    const events = [];
    widget(a, events);
    const host = a.document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    const element = a.document.createElement('x-widget');
    shadow.appendChild(element);
    a.document.body.appendChild(host);
    events.length = 0;
    b.document.body.appendChild(host);
    assert.equal(shadow.ownerDocument, b.document);
    assert.equal(element.ownerDocument, b.document);
    return events;
  }
  assert.deepEqual(scenario(fresh().window, fresh().window), scenario(new JSDOM('').window, new JSDOM('').window));
});

test('nested clone and import constructors execute in parent-before-child order', () => {
  oracle('<x-widget id="parent"><x-widget id="child"></x-widget></x-widget>', window => {
    const events = [];
    class C extends window.HTMLElement { constructor() { super(); events.push(this.id); } }
    window.customElements.define('x-widget', C);
    const original = window.document.querySelector('x-widget');
    events.length = 0;
    const clone = original.cloneNode(true);
    assert.ok(clone instanceof C);
    assert.ok(clone.firstChild instanceof C);
    const cloneEvents = events.slice();
    events.length = 0;
    window.document.importNode(original, true);
    return [cloneEvents, events];
  });
});

test('observed attribute values are converted once and callbacks receive the stored value', () => {
  oracle('', window => {
    const events = [];
    widget(window, events);
    const node = window.document.createElement('x-widget');
    events.length = 0;
    let conversions = 0;
    node.setAttribute('watched', { toString() { conversions++; return 'value-' + conversions; } });
    assert.equal(conversions, 1);
    assert.equal(node.getAttribute('watched'), 'value-1');
    return events;
  });
});
