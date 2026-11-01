import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../src/runtime/index.mjs';
import { installGlobals } from '../src/environment/install.mjs';

const fresh = () => createEnvironment('<!doctype html><html><body></body></html>', { url: 'https://app.wistia.io/library' });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('MessageEvent uses the runtime event hierarchy and preserves message metadata', () => {
  const { window } = fresh();
  const data = { value: 1 };
  const event = new window.MessageEvent('message', { data, origin: 'https://host.test', source: window, lastEventId: 'id', ports: [] });
  assert.ok(event instanceof window.Event);
  assert.equal(event.data, data);
  assert.equal(event.origin, 'https://host.test');
  assert.equal(event.source, window);
  assert.equal(event.lastEventId, 'id');
  const empty = new window.MessageEvent('message');
  assert.equal(empty.data, null);
  assert.equal(empty.source, null);
  assert.equal(empty.origin, '');
});

test('window messages arrive asynchronously as cloned data with window targets', async () => {
  const { window, document } = fresh();
  const original = { value: 1 };
  const seen = [];
  let documentMessages = 0;
  document.addEventListener('message', () => documentMessages++);
  window.addEventListener('message', function (event) {
    assert.equal(this, window);
    assert.equal(event.target, window);
    assert.equal(event.currentTarget, window);
    assert.deepEqual(event.composedPath(), [window]);
    seen.push(event);
  });
  window.postMessage(original, 'https://app.wistia.io');
  original.value = 2;
  assert.equal(seen.length, 0);
  await tick();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].data, { value: 1 });
  assert.equal(seen[0].origin, 'https://app.wistia.io');
  assert.equal(seen[0].source, window);
  assert.equal(documentMessages, 0);
});

test('target origin filtering accepts wildcard, default and options and rejects malformed origins', async () => {
  const { window } = fresh();
  const seen = [];
  window.onmessage = event => seen.push(event.data);
  window.postMessage('blocked', 'https://other.test');
  window.postMessage('wildcard', '*');
  window.postMessage('default');
  window.postMessage('options', { targetOrigin: 'https://app.wistia.io/path' });
  window.postMessage('default-options', {});
  assert.throws(() => window.postMessage('invalid', 'not an origin'), { name: 'SyntaxError' });
  assert.throws(() => window.postMessage(() => {}, '*'), { name: 'DataCloneError' });
  await tick();
  assert.deepEqual(seen, ['wildcard', 'default', 'options', 'default-options']);
});

test('postMessage preserves an undefined cloned payload', async () => {
  const { window } = fresh();
  const values = [];
  window.onmessage = event => values.push(event.data);
  window.postMessage(undefined, '*');
  await tick();
  assert.deepEqual(values, [undefined]);
});

test('transfer lists detach buffers and onmessage replacement/removal works', async () => {
  const { window } = fresh();
  const buffer = new ArrayBuffer(8);
  const seen = [];
  window.onmessage = () => assert.fail('replaced handler called');
  window.onmessage = event => seen.push(event.data);
  window.postMessage(buffer, { targetOrigin: '*', transfer: [buffer] });
  assert.equal(buffer.byteLength, 0);
  await tick();
  assert.equal(seen[0].byteLength, 8);
  window.onmessage = null;
  window.postMessage('ignored', '*');
  await tick();
  assert.equal(seen.length, 1);
  const other = new ArrayBuffer(3);
  window.postMessage(other, '*', [other]);
  assert.equal(other.byteLength, 0);
  await tick();
});

test('window listener removal and reset cancel old message delivery', async () => {
  const env = fresh();
  const seen = [];
  const listener = event => seen.push(event.data);
  env.window.addEventListener('message', listener);
  env.window.removeEventListener('message', listener);
  env.window.postMessage('removed', '*');
  await tick();
  assert.deepEqual(seen, []);
  env.window.onmessage = listener;
  env.window.postMessage('stale', '*');
  env.reset();
  env.window.addEventListener('message', listener);
  await tick();
  assert.deepEqual(seen, []);
  env.window.postMessage('new', '*');
  await tick();
  assert.deepEqual(seen, ['new']);
});

test('document events bubble to window listeners without routing window events through document', () => {
  const { window, document } = fresh();
  const calls = [];
  window.addEventListener('click', event => { calls.push('window'); assert.equal(event.target, document.body); });
  document.addEventListener('click', () => calls.push('document'));
  document.body.click();
  assert.deepEqual(calls, ['document', 'window']);
});

test('iframe windows have distinct identities, inherited origins and srcdoc documents', () => {
  const { window, document } = fresh();
  const first = document.createElement('iframe');
  const second = document.createElement('iframe');
  assert.equal(first.contentWindow, null);
  assert.equal(first.srcdoc, '');
  first.srcdoc = '<p>App</p>';
  document.body.append(first, second);
  const child = first.contentWindow;
  assert.equal(first.contentWindow, child);
  assert.notEqual(child, second.contentWindow);
  assert.equal(child.parent, window);
  assert.equal(child.top, window);
  assert.equal(child.frameElement, first);
  assert.equal(child.origin, window.origin);
  assert.equal(typeof child.postMessage, 'function');
  assert.equal(first.contentDocument.body.textContent, 'App');
  assert.equal(child.location.href, 'about:srcdoc');
  assert.equal(document.createElement('div').contentWindow, null);
  assert.equal(document.createElement('div').contentDocument, null);
});

test('installed window listeners and handlers share the global window identity', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'onmessage');
  const { teardown } = installGlobals(globalThis, { url: 'https://app.wistia.io/' });
  try {
    const seen = [];
    window.onmessage = function(event) {
      assert.equal(this, globalThis);
      assert.equal(event.target, globalThis);
      assert.equal(event.source, globalThis);
      seen.push(event.data);
    };
    window.postMessage('installed', '*');
    await tick();
    assert.deepEqual(seen, ['installed']);
    window.onmessage = null;
    window.onmessageerror = () => {};
    assert.equal(typeof window.onmessageerror, 'function');
    window.onmessageerror = null;
    window.postMessage('removed', '*');
    await tick();
    assert.deepEqual(seen, ['installed']);
  } finally { teardown(); }
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'onmessage'), original);
});

test('imperative template parsing keeps frame contents in the content fragment', () => {
  const { document } = fresh();
  const template = document.createElement('template');
  assert.ok(template.content instanceof document.defaultView.DocumentFragment);
  assert.equal(template.content.firstElementChild, null);
  assert.equal(template.content.lastElementChild, null);
  assert.equal(template.content.childElementCount, 0);
  template.innerHTML = '<iframe sandbox="allow-scripts"></iframe>';
  const frame = template.content.firstElementChild;
  assert.equal(frame.localName, 'iframe');
  assert.equal(template.content.lastElementChild, frame);
  assert.equal(template.content.childElementCount, 1);
  assert.equal(frame.parentNode, template.content);
  assert.equal(template.childNodes.length, 0);
  assert.equal(template.innerHTML, '<iframe sandbox="allow-scripts"></iframe>');
  const clone = template.cloneNode(true);
  assert.notEqual(clone.content.firstChild, frame);
  assert.equal(clone.innerHTML, template.innerHTML);
  assert.equal(template.cloneNode(false).content.childNodes.length, 0);
  template.innerHTML = '<p>Replaced</p>';
  assert.equal(frame.parentNode, null);
  assert.equal(template.content.textContent, 'Replaced');
});

test('parent reset cancels queued messages in nested iframe windows', async () => {
  const env = fresh();
  const frame = env.document.createElement('iframe');
  env.document.body.appendChild(frame);
  const child = frame.contentWindow;
  const nestedFrame = child.document.createElement('iframe');
  child.document.body.appendChild(nestedFrame);
  const nested = nestedFrame.contentWindow;
  const received = [];
  child.onmessage = event => received.push(event.data);
  nested.onmessage = event => received.push(event.data);
  child.postMessage('old child', '*');
  nested.postMessage('old nested', '*');
  env.reset();
  await tick();
  assert.deepEqual(received, []);
});

test('teardown prevents old messages from reaching the next installed environment', async () => {
  const first = installGlobals(globalThis);
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const child = frame.contentWindow;
  const received = [];
  child.onmessage = event => received.push(event.data);
  window.postMessage('old root', '*');
  child.postMessage('old child', '*');
  first.teardown();
  const second = installGlobals(globalThis);
  try {
    window.onmessage = event => received.push(event.data);
    await tick();
    assert.deepEqual(received, []);
    window.postMessage('current', '*');
    await tick();
    assert.deepEqual(received, ['current']);
  } finally { second.teardown(); }
});

test('MessageEvent subclasses can override readonly cancellation state', () => {
  const { window } = fresh();
  class DerivedMessage extends window.MessageEvent {
    get defaultPrevented() { return super.defaultPrevented; }
  }
  const event = new DerivedMessage('connection', { cancelable: true });
  assert.equal(event.defaultPrevented, false);
  event.preventDefault();
  assert.equal(event.defaultPrevented, true);
  const uncancelable = new DerivedMessage('connection');
  uncancelable.preventDefault();
  assert.equal(uncancelable.defaultPrevented, false);
  assert.throws(() => { uncancelable.defaultPrevented = true; }, TypeError);
});

for (const type of ['message', 'messageerror']) {
  test(`replacing on${type} preserves ordering and null assignment reactivates at the end`, () => {
    const env = fresh();
    const { window } = env;
    const seen = [];
    const property = 'on' + type;
    window[property] = () => seen.push('old');
    window.addEventListener(type, () => seen.push('listener'));
    const replacement = function(event) {
      assert.equal(this, window);
      assert.equal(event.currentTarget, window);
      seen.push('new');
    };
    window[property] = replacement;
    assert.equal(window[property], replacement);
    window.dispatchEvent(new window.MessageEvent(type));
    assert.deepEqual(seen, ['new', 'listener']);
    seen.length = 0;
    window[property] = null;
    window[property] = replacement;
    window.dispatchEvent(new window.MessageEvent(type));
    assert.deepEqual(seen, ['listener', 'new']);
    seen.length = 0;
    env.reset();
    assert.equal(window[property], null);
    window[property] = replacement;
    window.dispatchEvent(new window.MessageEvent(type));
    assert.deepEqual(seen, ['new']);
  });

  test(`clearing on${type} during dispatch does not invoke a removed handler`, () => {
    const { window } = fresh();
    const property = 'on' + type;
    window.addEventListener(type, () => { window[property] = null; });
    window[property] = () => assert.fail('removed handler called');
    window.dispatchEvent(new window.MessageEvent(type));
  });
}

test('srcdoc replacement invalidates queued messages in discarded children and descendants', async () => {
  const { window, document } = fresh();
  const frame = document.createElement('iframe');
  frame.srcdoc = '<p>old</p>';
  document.body.appendChild(frame);
  const oldChild = frame.contentWindow;
  const nestedFrame = oldChild.document.createElement('iframe');
  oldChild.document.body.appendChild(nestedFrame);
  const oldNested = nestedFrame.contentWindow;
  const seen = [];
  oldChild.onmessage = event => seen.push(event.data);
  oldNested.onmessage = event => seen.push(event.data);
  oldChild.postMessage('stale child', '*');
  oldNested.postMessage('stale descendant', '*');
  frame.srcdoc = '<p>new</p>';
  const nextChild = frame.contentWindow;
  assert.notEqual(nextChild, oldChild);
  assert.equal(nextChild.parent, window);
  assert.equal(nextChild.document.body.textContent, 'new');
  nextChild.onmessage = event => seen.push(event.data);
  nextChild.postMessage('current', '*');
  await tick();
  assert.deepEqual(seen, ['current']);
  oldChild.postMessage('discarded child', '*');
  oldNested.postMessage('discarded descendant', '*');
  await tick();
  assert.deepEqual(seen, ['current']);
});

test('srcdoc invalidates queued messages before the replacement window is read', async () => {
  const { document } = fresh();
  const frame = document.createElement('iframe');
  frame.srcdoc = '<p>old</p>';
  document.body.appendChild(frame);
  const child = frame.contentWindow;
  child.onmessage = () => assert.fail('discarded child received a message');
  child.postMessage('stale', '*');
  frame.srcdoc = '<p>new</p>';
  await tick();
});

test('parsed and cloned nested templates retain independent fragment contents', () => {
  const { document } = createEnvironment('<template><template><p>nested</p></template></template>');
  const template = document.querySelector('template');
  const fragment = template.content;
  assert.equal(template.content, fragment);
  const clone = template.cloneNode(true);
  assert.equal(clone.innerHTML, template.innerHTML);
  assert.notEqual(clone.content, fragment);
  const nested = clone.content.firstElementChild;
  assert.notEqual(nested.content, fragment.firstElementChild.content);
  nested.content.firstElementChild.textContent = 'changed';
  assert.equal(fragment.firstElementChild.content.textContent, 'nested');
  assert.equal(nested.content.textContent, 'changed');
  const container = document.createElement('div');
  container.innerHTML = template.outerHTML;
  assert.equal(container.firstElementChild.innerHTML, template.innerHTML);
});
