import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createEnvironment, Element } from '../src/runtime/index.mjs';
import { installGlobals } from '../src/environment/install.mjs';

const require = createRequire(import.meta.url);
const fresh = (html = '') => createEnvironment(`<!doctype html><html><body>${html}</body></html>`);

test('unsupported native selectors throw before searching, allowing selector-library fallbacks', () => {
  const { document } = fresh('<div><span></span></div>');
  const root = document.querySelector('div');
  const empty = document.createElement('div');
  for (const selector of [':data(draggable)', 'span:custom-selector(value)']) {
    assert.throws(() => root.querySelectorAll(selector), { name: 'SyntaxError' });
    assert.throws(() => empty.querySelectorAll(selector), { name: 'SyntaxError' });
    assert.throws(() => empty.querySelector(selector), { name: 'SyntaxError' });
    assert.throws(() => root.matches(selector), { name: 'SyntaxError' });
  }
  assert.equal(root.matches(':HOVER'), false);
  assert.equal(root.matches(':FIRST-CHILD'), true);
});

test('is and where discard unknown branches while not and has reject them before searching', () => {
  const { document } = fresh('<div class="ok"></div>');
  const element = document.querySelector('div');
  for (const pseudo of ['is', 'where']) {
    assert.equal(element.matches(`:${pseudo}(.ok, :unknown)`), true);
    assert.equal(element.matches(`:${pseudo}(:unknown, .ok)`), true);
    assert.equal(element.matches(`:${pseudo}(:unknown)`), false);
    assert.equal(element.matches(`:${pseudo}(:not(:unknown), .ok)`), true);
    assert.equal(element.matches(`:${pseudo}(, .ok)`), true);
    assert.equal(element.matches(`:${pseudo}([broken)`), false);
  }
  const empty = document.createElement('div');
  assert.throws(() => empty.querySelector(':not(:unknown)'), { name: 'SyntaxError' });
  assert.throws(() => empty.querySelector(':has(> :unknown)'), { name: 'SyntaxError' });
});

test('unsupported stylesheet selectors are skipped without losing valid rules', () => {
  const { window, document } = fresh('<style>div:custom-selector { color: red; } div { color: blue; }</style><div>Text</div>');
  assert.equal(window.getComputedStyle(document.querySelector('div')).color, 'rgb(0, 0, 255)');
});

test('attributes have the NamedNodeMap brand while other live collections and forgeries do not', () => {
  const { window, document } = fresh('<div id="root"></div>');
  const element = document.querySelector('div');
  const attributes = element.attributes;
  assert.ok(attributes instanceof window.NamedNodeMap);
  assert.ok(!(element.childNodes instanceof window.NamedNodeMap));
  assert.ok(!(element.children instanceof window.NamedNodeMap));
  assert.ok(!(Object.create(window.NamedNodeMap.prototype) instanceof window.NamedNodeMap));
  assert.ok(!(null instanceof window.NamedNodeMap));
  assert.throws(() => new window.NamedNodeMap(), TypeError);
  element.setAttribute('title', 'Label');
  assert.equal(attributes.length, 2);
  assert.equal(attributes.getNamedItem('title').value, 'Label');
  element.removeAttribute('id');
  assert.equal(attributes.length, 1);
  assert.equal(element.attributes, attributes);
});

test('hasAttributes reads parsed attributes lazily and reflects added and deleted attributes', () => {
  const { document } = fresh('<div data-present=""></div><span></span>');
  const parsed = document.querySelector('div');
  assert.equal(parsed.__attrs, undefined);
  assert.equal(parsed.hasAttributes(), true);
  assert.equal(parsed.__attrs, undefined);
  const empty = document.querySelector('span');
  assert.equal(empty.hasAttributes(), false);
  assert.equal(empty.__attrs, undefined);
  parsed.removeAttribute('data-present');
  assert.equal(parsed.hasAttributes(), false);
  empty.setAttribute('data-present', '');
  assert.equal(empty.hasAttributes(), true);
  empty.removeAttribute('data-present');
  assert.equal(empty.hasAttributes(), false);
  assert.equal(document.createElement('div').hasAttributes(), false);
  assert.equal(new Element(null, 'div').hasAttributes(), false);
});

test('axe can inspect real attributes and report an accessible-name violation', async () => {
  const { teardown } = installGlobals(globalThis, {
    html: '<!doctype html><html lang="en"><body><main><button id="good">Save</button><button id="bad"></button></main></body></html>',
  });
  try {
    const axe = require('axe-core');
    const result = await axe.run(document.body, { runOnly: ['button-name'] });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].id, 'button-name');
    assert.deepEqual(result.violations[0].nodes[0].target, ['#bad']);
    document.getElementById('bad').textContent = 'Cancel';
    const fixed = await axe.run(document.body, { runOnly: ['button-name'] });
    assert.deepEqual(fixed.violations, []);
  } finally {
    teardown();
  }
});
