import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEnvironment } from '../src/runtime/index.mjs';
import { installGlobals } from '../src/environment/install.mjs';

function compare(scenario) {
  const oracle = new JSDOM('<!doctype html><body><div>abc<span>def</span>ghi</div></body>', { url: 'https://example.com/' });
  try {
    const actual = createEnvironment('<!doctype html><body><div>abc<span>def</span>ghi</div></body>', { url: 'https://example.com/' }).window;
    assert.deepEqual(scenario(actual), scenario(oracle.window));
  } finally { oracle.window.close(); }
}

test('DOMRect geometry, conversion, mutation and readonly views match jsdom', () => {
  compare(window => {
    const results = [];
    for (const Type of [window.DOMRectReadOnly, window.DOMRect]) {
      results.push(new Type().toJSON(), new Type(10, 20, -30, -40).toJSON(), Type.fromRect({ x: '2', height: 5 }).toJSON());
    }
    const rect = new window.DOMRect(1, 2, 3, 4);
    rect.x = '5'; rect.y = 6; rect.width = -7; rect.height = -8;
    results.push(rect.toJSON());
    assert.ok(rect instanceof window.DOMRectReadOnly);
    assert.throws(() => { new window.DOMRectReadOnly().x = 1; }, TypeError);
    return results;
  });
});

test('Node and NodeFilter expose the same constructor and instance constants as jsdom', () => {
  compare(window => {
    assert.throws(() => new window.NodeFilter(), TypeError);
    const document = window.document;
    const walker = document.createTreeWalker(document.body, window.NodeFilter.SHOW_TEXT);
    const values = [];
    let node;
    while ((node = walker.nextNode())) values.push(node.data);
    for (const name of ['ELEMENT_NODE', 'TEXT_NODE', 'DOCUMENT_POSITION_PRECEDING', 'DOCUMENT_POSITION_FOLLOWING', 'DOCUMENT_POSITION_CONTAINED_BY']) {
      assert.equal(window.Node[name], document[name]);
    }
    return [values, Object.keys(window.NodeFilter).map(name => [name, window.NodeFilter[name]])];
  });
});

test('Range point comparisons handle boundaries, ancestors, siblings and invalid points', () => {
  compare(window => {
    const { document } = window;
    const div = document.querySelector('div');
    const range = document.createRange();
    range.setStart(div.firstChild, 1); range.setEnd(div.lastChild, 2);
    const points = [[div.firstChild, 0], [div.firstChild, 1], [div, 0], [div, 1], [div, 3], [div.lastChild, 2], [div.lastChild, 3], [div.children[0].firstChild, 0], [document.body, 0]];
    const result = points.map(([node, offset]) => [range.comparePoint(node, offset), range.isPointInRange(node, offset)]);
    const detached = document.createElement('div');
    assert.equal(range.isPointInRange(detached, 0), false);
    for (const [node, offset, name] of [[detached, 0, 'WrongDocumentError'], [div, 9, 'IndexSizeError'], [document.doctype, 0, 'InvalidNodeTypeError']]) {
      try { range.comparePoint(node, offset); assert.fail('Expected range exception'); } catch (error) { assert.equal(error.name, name); }
    }
    range.selectNodeContents(div.firstChild);
    result.push([range.comparePoint(div.firstChild, 1), range.comparePoint(div.firstChild, 3)]);
    return result;
  });
});

test('error, storage and rejection event dictionaries preserve application payloads', () => {
  compare(window => {
    const error = new Error('failure');
    const event = new window.ErrorEvent('error', { message: 'message', filename: '/app.js', lineno: 2, colno: 3, error });
    assert.equal(event.error, error);
    const storage = new window.StorageEvent('storage', { key: 'key', oldValue: 'old', newValue: 'new', url: 'https://example.com/' });
    const defaults = new window.ErrorEvent('error');
    return [event.message, event.filename, event.lineno, event.colno, storage.key, storage.oldValue, storage.newValue, storage.url, storage.storageArea, defaults.message, defaults.error];
  });
  const window = createEnvironment().window;
  const promise = Promise.resolve();
  const reason = new Error('reason');
  const event = new window.PromiseRejectionEvent('unhandledrejection', { promise, reason, cancelable: true });
  assert.equal(event.promise, promise); assert.equal(event.reason, reason);
  event.preventDefault(); assert.equal(event.defaultPrevented, true);
});

test('new browser globals install lazily and teardown restores original descriptors', () => {
  const target = {};
  const { teardown } = installGlobals(target);
  for (const name of ['DOMRect', 'DOMRectReadOnly', 'NodeFilter', 'ErrorEvent', 'StorageEvent', 'PromiseRejectionEvent']) assert.ok(target[name], name);
  teardown();
  assert.equal(target.DOMRect, undefined);
});

test('location component assignments retain the headless navigation contract', () => {
  const { window } = createEnvironment('', { url: 'https://example.com/path?q=1' });
  for (const property of ['protocol', 'host', 'hostname', 'port', 'pathname', 'search']) window.location[property] = 'other';
  assert.equal(window.location.href, 'https://example.com/path?q=1');
  window.location.hash = 'section';
  assert.equal(window.location.hash, '#section');
  assert.equal(window.location.href, 'https://example.com/path?q=1#section');
});

test('window-created ranges and fragments belong to the window document', () => {
  compare(window => {
    const fragment = new window.DocumentFragment();
    assert.equal(fragment.ownerDocument, window.document);
    assert.ok(window.document.createDocumentFragment() instanceof window.DocumentFragment);
    const range = new window.Range();
    assert.equal(range.startContainer, window.document);
    assert.ok(window.document.createRange() instanceof window.Range);
    const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window.document), 'nodeType')?.get
      || Object.getOwnPropertyDescriptor(window.Node.prototype, 'nodeType').get;
    assert.throws(() => getter.call({}), TypeError);
    return [getter.call(window.document), getter.call(window.document.body), getter.call(fragment)];
  });
});

test('metadata content and classList value reflect attributes in both directions', () => {
  compare(window => {
    const meta = window.document.createElement('meta');
    assert.equal(meta.content, '');
    meta.content = 'token';
    assert.equal(meta.getAttribute('content'), 'token');
    meta.setAttribute('content', 'next');
    assert.equal(meta.content, 'next');
    const element = window.document.createElement('div');
    element.classList.value = 'first second';
    assert.ok(element.classList.contains('second'));
    element.classList.value = '';
    return [meta.outerHTML, element.className, element.getAttribute('class')];
  });
});

test('rectangle dictionaries and event dictionary conversions follow Web IDL', () => {
  compare(window => {
    assert.throws(() => window.DOMRect.fromRect(1), TypeError);
    const rect = window.DOMRect.fromRect(null);
    assert.deepEqual(Object.keys(rect), []);
    const event = new window.ErrorEvent('error', { message: 123, filename: null, lineno: -1, colno: 1.5 });
    const storage = new window.StorageEvent('storage', { key: 1, oldValue: 2, newValue: null, url: 3 });
    return [rect.toJSON(), event.message, event.filename, event.lineno, event.colno, storage.key, storage.oldValue, storage.newValue, storage.url];
  });
});

test('window DOM constructors preserve subclass prototypes and require new', () => {
  compare(window => {
    assert.throws(() => window.Range(), TypeError);
    assert.throws(() => window.DocumentFragment(), TypeError);
    class SubRange extends window.Range {}
    class SubFragment extends window.DocumentFragment {}
    const range = new SubRange();
    const fragment = new SubFragment();
    assert.equal(range.startContainer, window.document);
    assert.equal(fragment.ownerDocument, window.document);
    return [range instanceof SubRange, fragment instanceof SubFragment];
  });
});

test('AbortSignal removes event listeners before and during dispatch, including window listeners', () => {
  const { window, document } = createEnvironment('<body><button></button></body>');
  const target = document.querySelector('button');
  const calls = [];
  const controller = new AbortController();
  const callback = () => calls.push('listener');
  window.addEventListener('move', callback, { signal: controller.signal });
  window.dispatchEvent(new window.Event('move'));
  controller.abort();
  window.dispatchEvent(new window.Event('move'));
  target.addEventListener('move', callback, { signal: controller.signal });
  target.dispatchEvent(new window.Event('move'));
  assert.deepEqual(calls, ['listener']);
  const pending = new AbortController();
  target.addEventListener('click', () => pending.abort());
  target.addEventListener('click', () => calls.push('removed'), { signal: pending.signal });
  target.dispatchEvent(new window.Event('click'));
  assert.deepEqual(calls, ['listener']);
  const once = new AbortController();
  target.addEventListener('once', callback, { once: true, signal: once.signal });
  target.dispatchEvent(new window.Event('once'));
  once.abort();
  target.dispatchEvent(new window.Event('once'));
  const removed = new AbortController();
  target.addEventListener('manual', callback, { signal: removed.signal });
  target.removeEventListener('manual', callback);
  removed.abort();
  assert.deepEqual(calls, ['listener', 'listener']);
});

test('TreeWalker rejects subtrees, skips containers and remains exhausted', () => {
  compare(window => {
    const root = window.document.createElement('div');
    root.innerHTML = '<section>hidden</section><span>visible</span>';
    const walker = window.document.createTreeWalker(root, window.NodeFilter.SHOW_ALL, node =>
      node.nodeName === 'SECTION' ? window.NodeFilter.FILTER_REJECT : node.nodeType === 3 ? window.NodeFilter.FILTER_ACCEPT : window.NodeFilter.FILTER_SKIP);
    const first = walker.nextNode();
    assert.equal(first.data, 'visible');
    assert.equal(walker.nextNode(), null);
    assert.equal(walker.nextNode(), null);
    return walker.currentNode.data;
  });
});

test('style sheets expose authored rules and retain subsequent CSSOM insertions', () => {
  const { document } = createEnvironment('<style>.first { color: red; }</style>');
  const element = document.querySelector('style');
  const sheet = element.sheet;
  assert.equal(sheet.cssRules.length, 1);
  sheet.insertRule('.second { color: blue; }', 1);
  assert.equal(document.styleSheets[0], sheet);
  assert.equal(sheet.cssRules.length, 2);
  element.textContent = '.third { color: green; }';
  assert.equal(element.sheet.cssRules.length, 1);
  assert.match(element.sheet.cssRules[0].cssText, /third/);
});

test('escaped attribute selectors match literal quotes, brackets and CSS escapes', () => {
  compare(window => {
    const element = window.document.createElement('div');
    window.document.body.append(element);
    const results = [];
    for (const [value, selector] of [['lower"third', '[data-id="lower\\"third"]'], ['a]b', '[data-id="a\\]b"]'], ['a', '[data-id="\\61 "]']]) {
      element.setAttribute('data-id', value);
      results.push(window.document.querySelector(selector) === element);
    }
    return results;
  });
});

test('computed lengths round like CSSOM without changing authored inline precision', () => {
  const { window, document } = createEnvironment('<body><div></div></body>');
  const element = document.querySelector('div');
  element.style.width = '60.00000000000001px';
  assert.equal(window.getComputedStyle(element).width, '60px');
  assert.equal(element.style.width, '60.00000000000001px');
  element.style.width = '0.123456789px';
  assert.equal(window.getComputedStyle(element).width, '0.123457px');
  element.style.webkitTextStroke = '1px var(--stroke)';
  assert.equal(element.style.WebkitTextStroke, '1px var(--stroke)');
  element.style.pointerEvents = 'none';
  const child = document.createElement('span'); element.append(child);
  assert.equal(window.getComputedStyle(child).pointerEvents, 'none');
});

test('Storage supports enumeration and named properties as well as method access', () => {
  compare(window => {
    const storage = window.localStorage;
    storage.clear(); storage.setItem('first', '1'); storage.second = 2;
    assert.equal(storage.second, '2'); assert.equal('second' in storage, true);
    assert.equal(storage.missing, undefined);
    assert.equal(Object.getOwnPropertyDescriptor(storage, 'missing'), undefined);
    const keys = Object.keys(storage);
    delete storage.first;
    const result = [keys, storage.getItem('first'), storage.getItem('second'), storage.length];
    storage.clear(); assert.equal(storage.length, 0);
    return result;
  });
});

test('media time ranges are empty until data is loaded and crossorigin reflects its attribute', () => {
  compare(window => {
    const video = window.document.createElement('video');
    for (const name of ['buffered', 'played', 'seekable']) {
      assert.equal(video[name].length, 0);
    }
    assert.equal(video.crossOrigin, null);
    video.crossOrigin = 'anonymous';
    assert.equal(video.getAttribute('crossorigin'), 'anonymous');
    video.crossOrigin = null;
    return video.crossOrigin;
  });
});

test('setRangeText updates values and selection for every selection mode', () => {
  compare(window => {
    const textarea = window.document.createElement('textarea');
    const result = [];
    for (const mode of ['end', 'start', 'select', 'preserve']) {
      textarea.value = 'hello world'; textarea.setSelectionRange(5, 6);
      textarea.setRangeText('\n', 5, 6, mode);
      result.push([textarea.value, textarea.selectionStart, textarea.selectionEnd]);
    }
    textarea.value = 'hello world'; textarea.setSelectionRange(8, 10);
    textarea.setRangeText('xx', 2, 5);
    result.push([textarea.value, textarea.selectionStart, textarea.selectionEnd]);
    assert.throws(() => textarea.setRangeText('x', 4, 1), { name: 'IndexSizeError' });
    return result;
  });
});

test('shadow focus reports hosts at document boundaries and the focused leaf in its own root', () => {
  compare(window => {
    const host = window.document.createElement('div'); window.document.body.append(host);
    const first = host.attachShadow({ mode: 'open' });
    const nested = window.document.createElement('div'); first.append(nested);
    const second = nested.attachShadow({ mode: 'open' });
    assert.equal(first.activeElement, null);
    const input = window.document.createElement('input'); second.append(input); input.focus();
    return [window.document.activeElement === host, first.activeElement === nested, second.activeElement === input];
  });
});

test('NodeIterator includes its root and continues past a removed subtree', () => {
  compare(window => {
    const root = window.document.createElement('div'); root.innerHTML = '<script>unsafe</script><p>safe</p>';
    const iterator = window.document.createNodeIterator(root, window.NodeFilter.SHOW_ELEMENT | window.NodeFilter.SHOW_TEXT);
    const result = [];
    let node;
    while ((node = iterator.nextNode())) {
      result.push(node.nodeName);
      if (node.nodeName === 'SCRIPT') node.remove();
    }
    assert.equal(iterator.nextNode(), null);
    return result;
  });
});

test('captured Node accessors report actual nodes and structural equality ignores wrapper state', () => {
  const { window, document } = createEnvironment('<!doctype html><body><div>text</div><!--comment--></body>');
  const getType = Object.getOwnPropertyDescriptor(window.Node.prototype, 'nodeType').get;
  const getName = Object.getOwnPropertyDescriptor(window.Node.prototype, 'nodeName').get;
  for (const node of [document, document.body, document.body.firstChild.firstChild, document.body.lastChild, document.createDocumentFragment(), document.doctype]) {
    assert.equal(getType.call(node), node.nodeType); assert.equal(getName.call(node), node.nodeName);
  }
  assert.throws(() => getType.call({}), TypeError);
  assert.throws(() => getName.call({}), TypeError);
  const first = document.createElement('span'), second = document.createElement('span');
  first.compareDocumentPosition(second);
  assert.ok(first.isEqualNode(second));
  second.setAttribute('data-id', 'a'); assert.equal(first.isEqualNode(second), false);
  first.setAttribute('data-id', 'b'); assert.equal(first.isEqualNode(second), false);
  first.setAttribute('data-id', 'a'); assert.ok(first.isEqualNode(second));
  first.textContent = 'one'; second.textContent = 'two'; assert.equal(first.isEqualNode(second), false);
  assert.equal(first.isEqualNode(document.createElement('div')), false);
  assert.equal(first.isEqualNode(null), false);
  first.textContent = ''; assert.equal(first.isEqualNode(second), false);
});

test('empty media ranges reject unavailable indices', () => {
  const video = createEnvironment().document.createElement('video');
  assert.throws(() => video.seekable.start(0), { name: 'IndexSizeError' });
  assert.throws(() => video.buffered.end(0), { name: 'IndexSizeError' });
});

test('PointerEvent and other UI events inherit their browser interface and coordinates', () => {
  compare(window => {
    const event = new window.PointerEvent('pointerdown', { clientX: 12, clientY: 34 });
    const mouse = new window.MouseEvent('click', { clientX: 2, clientY: 3 });
    return [event instanceof window.MouseEvent, event instanceof window.UIEvent, event instanceof window.Event,
      new window.WheelEvent('wheel') instanceof window.MouseEvent, new window.KeyboardEvent('keydown') instanceof window.UIEvent,
      event.x, event.y, mouse.pageX, mouse.pageY, mouse.offsetX, mouse.offsetY];
  });
});

test('native editing bypasses own value setters used by React trackers', () => {
  compare(window => {
    const textarea = window.document.createElement('textarea');
    textarea.value = 'first'; textarea.setSelectionRange(5, 5);
    const prototype = Object.getPrototypeOf(textarea);
    let cursor = prototype, descriptor;
    while (!descriptor) { descriptor = Object.getOwnPropertyDescriptor(cursor, 'value'); cursor = Object.getPrototypeOf(cursor); }
    let calls = 0;
    Object.defineProperty(textarea, 'value', {
      get() { return descriptor.get.call(this); },
      set(value) { calls++; descriptor.set.call(this, value); },
    });
    textarea.setRangeText('\n', 5, 5, 'end');
    return [textarea.value, calls, textarea.selectionStart];
  });
});

test('summary default actions toggle the parent details and deliver toggle events', async () => {
  const { window, document } = createEnvironment('<details><summary>Open</summary><p>Details</p></details>');
  const details = document.querySelector('details');
  let toggles = 0;
  details.addEventListener('toggle', () => toggles++);
  document.querySelector('summary').click();
  assert.equal(details.open, true);
  await Promise.resolve(); assert.equal(toggles, 1);
  details.open = false; details.open = true;
  await Promise.resolve(); assert.equal(toggles, 2);
  details.open = true; await Promise.resolve(); assert.equal(toggles, 2);
});

test('style sheet reads preserve authored text and property priorities remain separate', () => {
  const { document } = createEnvironment('<style>div{color:red!important}</style>');
  const style = document.querySelector('style');
  const before = style.textContent;
  const sheet = style.sheet;
  assert.equal(style.textContent, before);
  assert.equal(sheet.cssRules[0].style.getPropertyValue('color'), 'red');
  assert.equal(sheet.cssRules[0].style.getPropertyPriority('color'), 'important');
  assert.equal(sheet.cssRules[0].style.getPropertyPriority('display'), '');
});

test('zero geometry is opt-in, survives reset and applies to child frames and global installation', () => {
  assert.throws(() => createEnvironment('', { geometry: 'unknown' }), TypeError);
  const env = createEnvironment('<div>content</div><iframe></iframe>', { geometry: 'zero' });
  const element = env.document.querySelector('div');
  assert.equal(element.getBoundingClientRect().width, 0);
  assert.deepEqual(element.getClientRects(), []);
  assert.equal(element.offsetHeight, 0);
  assert.equal(element.scrollWidth, 0);
  const frame = env.document.querySelector('iframe');
  assert.equal(frame.contentDocument.body.offsetHeight, 0);
  env.reset('<div>after reset</div>');
  assert.equal(env.document.querySelector('div').offsetWidth, 0);
  const target = {};
  const installed = installGlobals(target, { geometry: 'zero' });
  assert.equal(target.document.body.offsetHeight, 0);
  installed.teardown();
  assert.ok(createEnvironment('<div>text</div>').document.body.offsetHeight > 0);
});

test('quoted background URLs serialize equivalent CSS escapes consistently', () => {
  const { window, document } = createEnvironment('<body><div></div></body>');
  const element = document.querySelector('div');
  element.style.backgroundImage = 'url("https://example.com/a\\22 .png")';
  assert.equal(element.style.backgroundImage, 'url("https://example.com/a\\".png")');
  assert.equal(window.getComputedStyle(element).backgroundImage, element.style.backgroundImage);
});


test('NodeIterator resumes after removing its reference while positioned before it', () => {
  compare(window => {
    const root = window.document.createElement('div');
    root.innerHTML = '<a></a><b></b><i></i>';
    const iterator = window.document.createNodeIterator(root, window.NodeFilter.SHOW_ELEMENT);
    iterator.nextNode();
    iterator.nextNode();
    const reference = iterator.nextNode();
    assert.equal(iterator.previousNode(), reference);
    reference.remove();
    return iterator.nextNode()?.tagName;
  });
});

test('TreeWalker stops safely after removing its current node', () => {
  compare(window => {
    const root = window.document.createElement('div');
    root.innerHTML = '<a></a><b></b>';
    const walker = window.document.createTreeWalker(root, window.NodeFilter.SHOW_ELEMENT);
    walker.nextNode().remove();
    return walker.nextNode();
  });
});


test('NodeIterator refreshes removal recovery after backward traversal', () => {
  compare(window => {
    const root = window.document.createElement('div');
    root.innerHTML = '<a></a><b></b><i></i>';
    const iterator = window.document.createNodeIterator(root, window.NodeFilter.SHOW_ELEMENT);
    for (let i = 0; i < 4; i++) iterator.nextNode();
    iterator.previousNode();
    iterator.previousNode().remove();
    return iterator.previousNode()?.tagName;
  });
});
