import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createEnvironment } from '../src/runtime/index.mjs';
import { installGlobals } from '../src/environment/install.mjs';

const require = createRequire(import.meta.url);
const userEvent = require('@testing-library/user-event').default;
const fresh = (html = '') => createEnvironment(`<!doctype html><html><body>${html}</body></html>`, {
  url: 'https://account.wistia.io/library?old=1#before',
});

test('Option constructs an option in its own window document', () => {
  const { window, document } = fresh();
  const option = new window.Option('Business', 'business', true, false);
  assert.equal(option.ownerDocument, document);
  assert.equal(option.text, 'Business');
  assert.equal(option.value, 'business');
  assert.equal(option.defaultSelected, true);
  assert.equal(option.selected, false);
  assert.ok(option instanceof window.Option);
  assert.ok(option instanceof window.HTMLOptionElement);
  assert.ok(!(document.createElement('div') instanceof window.Option));
  const empty = new window.Option();
  assert.equal(empty.text, '');
  assert.equal(empty.value, '');
  assert.equal(empty.hasAttribute('value'), false);
  assert.equal(empty.defaultSelected, false);
  assert.equal(empty.selected, false);
  const label = new window.Option('Label');
  assert.equal(label.value, 'Label');
  assert.equal(label.hasAttribute('value'), false);
  const selected = new window.Option(123, null, false, true);
  assert.equal(selected.text, '123');
  assert.equal(selected.value, 'null');
  assert.equal(selected.defaultSelected, false);
  assert.equal(selected.selected, true);
  const another = fresh();
  assert.equal(new another.window.Option('Other').ownerDocument, another.document);
});

test('history keeps location and document URLs live across push, replace and traversal', () => {
  const { window, document } = fresh();
  const location = window.location;
  window.history.pushState({ page: 1 }, '', '/account/plans?q=plus#price');
  assert.equal(window.location, location);
  assert.equal(location.pathname, '/account/plans');
  assert.equal(location.search, '?q=plus');
  assert.equal(location.hash, '#price');
  assert.equal(document.URL, 'https://account.wistia.io/account/plans?q=plus#price');
  assert.equal(document.baseURI, document.URL);
  window.history.pushState({ page: 2 }, '', 'integrations');
  assert.equal(location.href, 'https://account.wistia.io/account/integrations');
  window.history.replaceState({ page: 3 }, '', '?vendor=hubspot');
  assert.equal(location.search, '?vendor=hubspot');
  assert.equal(window.history.length, 3);
  window.history.back();
  assert.equal(location.pathname, '/account/plans');
  assert.deepEqual(window.history.state, { page: 1 });
  window.history.forward();
  assert.equal(location.href, 'https://account.wistia.io/account/integrations?vendor=hubspot');
  window.history.go(99);
  window.history.go(-99);
  assert.deepEqual(window.history.state, { page: 3 });
  assert.equal(location.href, 'https://account.wistia.io/account/integrations?vendor=hubspot');
  window.history.go(-2);
  assert.equal(location.href, 'https://account.wistia.io/library?old=1#before');
  window.history.pushState(null, '', '#new');
  assert.equal(window.history.length, 2);
  assert.equal(location.hash, '#new');
  window.history.pushState(null, '');
  window.history.replaceState({ kept: true }, '', null);
  assert.equal(location.href, 'https://account.wistia.io/library?old=1#new');
});

test('history rejects invalid or cross-origin URLs without modifying the entry', () => {
  const { window } = fresh();
  for (const url of ['https://other.test/plans', 'http://[', 'https://user@account.wistia.io/']) {
    assert.throws(() => window.history.pushState({ wrong: true }, '', url), { name: 'SecurityError' });
    assert.throws(() => window.history.replaceState({ wrong: true }, '', url), { name: 'SecurityError' });
    assert.equal(window.location.href, 'https://account.wistia.io/library?old=1#before');
    assert.equal(window.history.length, 1);
    assert.equal(window.history.state, null);
  }
});

test('fetch wrappers can delegate to the installed fetch and survive reinstall', async () => {
  const original = globalThis.fetch;
  for (let i = 0; i < 2; i++) {
    const { teardown } = installGlobals(globalThis);
    try {
      const delegate = globalThis.fetch;
      const calls = [];
      globalThis.fetch = (...args) => { calls.push(args[0]); return delegate(...args); };
      const response = await globalThis.fetch('data:text/plain,guarded');
      assert.equal(await response.text(), 'guarded');
      assert.deepEqual(calls, ['data:text/plain,guarded']);
    } finally {
      teardown();
    }
    assert.equal(globalThis.fetch, original);
  }
});

test('installed base64 globals delegate without recursively resolving themselves', () => {
  for (let i = 0; i < 2; i++) {
    const { teardown } = installGlobals(globalThis);
    try {
      assert.equal(btoa('hello'), 'aGVsbG8=');
      assert.equal(atob('aGVsbG8='), 'hello');
      assert.throws(() => btoa('\u2603'), { name: 'InvalidCharacterError' });
    } finally {
      teardown();
    }
  }
});

for (const [name, remove] of [
  ['remove', (container) => container.remove()],
  ['removeChild', (container) => container.parentNode.removeChild(container)],
  ['replaceChild', (container) => container.parentNode.replaceChild(container.ownerDocument.createElement('div'), container)],
  ['innerHTML', (container) => { container.innerHTML = ''; }],
  ['textContent', (container) => { container.textContent = ''; }],
  ['replaceChildren', (container) => container.replaceChildren()],
]) {
  test(`removing a focused subtree with ${name} resets the Tab starting point`, async () => {
    const { document } = fresh('<section><input></section><input id="next">');
    const container = document.querySelector('section');
    const input = container.querySelector('input');
    input.focus();
    remove(container);
    assert.equal(document.activeElement, document.body);
    container.appendChild(input);
    document.body.appendChild(container);
    assert.equal(document.activeElement, document.body, 'reinserting a removed input must not restore focus');
    const user = userEvent.setup({ document });
    await user.tab();
    assert.equal(document.activeElement, document.getElementById('next'));
  });
}

test('removing a shadow host clears focus from its shadow tree', () => {
  const { document } = fresh('<div id="host"></div><input id="outside">');
  const host = document.getElementById('host');
  const shadow = host.attachShadow({ mode: 'open' });
  const input = document.createElement('input');
  shadow.appendChild(input);
  input.focus();
  host.remove();
  assert.equal(document.activeElement, document.body);
});

test('removing an unrelated subtree preserves focus and detached nodes cannot claim focus', () => {
  const { document } = fresh('<div></div><input id="active">');
  const input = document.getElementById('active');
  input.focus();
  document.querySelector('div').remove();
  assert.equal(document.activeElement, input);
  document.createElement('input').focus();
  assert.equal(document.activeElement, input);
});

test('replacing children of the focused container preserves its focus', () => {
  const { document } = fresh('<div tabindex="0"><input></div>');
  const container = document.querySelector('div');
  container.focus();
  container.replaceChildren();
  assert.equal(document.activeElement, container);
});
