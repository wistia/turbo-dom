import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../src/runtime/index.mjs';

const fresh = () => createEnvironment('<!doctype html><body></body>', { url: 'https://app.test/' });
const tick = () => new Promise(resolve => setTimeout(resolve, 15));

function appendFrame(document, html) {
  const frame = document.createElement('iframe');
  if (html !== undefined) frame.srcdoc = html;
  document.body.appendChild(frame);
  return frame;
}

test('empty srcdoc presence and removal replace the child document', async () => {
  const { document } = fresh();
  const frame = appendFrame(document);
  const blank = frame.contentWindow;
  assert.equal(blank.location.href, 'about:blank');
  const seen = [];
  blank.onmessage = event => seen.push(event.data);
  blank.postMessage('old blank', '*');
  frame.srcdoc = '';
  const srcdoc = frame.contentWindow;
  assert.notEqual(srcdoc, blank);
  assert.equal(srcdoc.location.href, 'about:srcdoc');
  srcdoc.onmessage = event => seen.push(event.data);
  srcdoc.postMessage('old srcdoc', '*');
  frame.removeAttribute('srcdoc');
  assert.equal(frame.contentWindow.location.href, 'about:blank');
  await tick();
  assert.deepEqual(seen, []);
});

test('removing and reinserting an iframe discards the former child and its descendants', async () => {
  const { document } = fresh();
  const frame = appendFrame(document, '<p>first</p>');
  const child = frame.contentWindow;
  const nested = appendFrame(child.document).contentWindow;
  const seen = [];
  child.onmessage = nested.onmessage = event => seen.push(event.data);
  child.postMessage('old child', '*');
  nested.postMessage('old nested', '*');
  frame.remove();
  assert.equal(frame.contentWindow, null);
  document.body.appendChild(frame);
  assert.notEqual(frame.contentWindow, child);
  frame.contentWindow.onmessage = event => seen.push(event.data);
  frame.contentWindow.postMessage('new child', '*');
  await tick();
  assert.deepEqual(seen, ['new child']);
});

test('subtree replacement and adoption invalidate materialized frame windows', async () => {
  const first = fresh(), second = fresh();
  const container = first.document.createElement('section');
  first.document.body.appendChild(container);
  const frame = first.document.createElement('iframe');
  container.appendChild(frame);
  const old = frame.contentWindow;
  old.onmessage = () => assert.fail('removed child received message');
  old.postMessage('stale', '*');
  container.replaceChildren();
  first.document.body.appendChild(frame);
  const next = frame.contentWindow;
  assert.notEqual(next, old);
  next.onmessage = () => assert.fail('adopted child received message');
  next.postMessage('stale adopted', '*');
  second.document.adoptNode(frame);
  second.document.body.appendChild(frame);
  assert.notEqual(frame.contentWindow, next);
  assert.equal(frame.contentWindow.parent, second.window);
  await tick();
});

test('standalone cross-frame messages and synchronous handler replies have correct senders', async () => {
  const { window, document } = fresh();
  const child = appendFrame(document).contentWindow;
  const seen = [];
  window.onmessage = event => {
    assert.equal(event.source, child);
    assert.equal(event.origin, window.origin);
    seen.push(event.data);
  };
  child.onmessage = event => {
    assert.equal(event.source, window);
    assert.equal(event.origin, window.origin);
    child.parent.postMessage('reply', '*');
  };
  child.postMessage('request', '*');
  await tick();
  assert.deepEqual(seen, ['reply']);
});

test('window postMessage transfers runtime ports and preserves graph identities', async () => {
  const { window } = fresh();
  const channel = new window.MessageChannel();
  const buffer = new ArrayBuffer(8);
  const message = { port: channel.port2, again: channel.port2, buffer };
  message.self = message;
  message.map = new Map([[channel.port2, message]]);
  message.set = new Set([channel.port2]);
  let received;
  window.onmessage = event => { received = event; };
  window.postMessage(message, '*', [channel.port2, buffer]);
  assert.equal(buffer.byteLength, 0);
  await tick();
  const data = received.data;
  assert.equal(data.self, data);
  assert.equal(data.port, data.again);
  assert.equal(data.port, received.ports[0]);
  assert.equal(data.map.get(data.port), data);
  assert.ok(data.set.has(data.port));
  assert.notEqual(data.port, channel.port2);
  const messages = [];
  data.port.onmessage = event => messages.push(event.data);
  channel.port2.onmessage = () => assert.fail('detached wrapper received a message');
  channel.port1.postMessage('through transferred port');
  await tick();
  assert.deepEqual(messages, ['through transferred port']);
});

test('ports clone data synchronously and receive MessageEvents with proper targets', async () => {
  const { window } = fresh();
  const { port1, port2 } = new window.MessageChannel();
  const original = { nested: { value: 1 }, date: new Date(0), re: /test/g, boxed: new String('text') };
  let received;
  const handler = function(event) {
    assert.equal(this, port2);
    assert.equal(event.target, port2);
    assert.ok(event instanceof window.MessageEvent);
    received = event.data;
  };
  port2.onmessage = handler;
  assert.equal(port2.onmessage, handler);
  port1.postMessage(original);
  original.nested.value = 2;
  await tick();
  assert.equal(received.nested.value, 1);
  assert.equal(received.date.getTime(), 0);
  assert.equal(received.re.source, 'test');
  assert.equal(String(received.boxed), 'text');
});

test('ports queue messages until started and property handlers start them automatically', async () => {
  const { window } = fresh();
  const { port1, port2 } = new window.MessageChannel();
  const seen = [];
  port2.addEventListener('message', event => seen.push(event.data));
  port1.postMessage('queued');
  await tick();
  assert.deepEqual(seen, []);
  port2.start();
  await tick();
  assert.deepEqual(seen, ['queued']);
  port2.onmessage = event => seen.push(event.data + ' handler');
  port1.postMessage('started');
  await tick();
  assert.deepEqual(seen, ['queued', 'started', 'started handler']);
  port2.onmessage = () => seen.push('replacement');
  port1.postMessage('next');
  await tick();
  assert.deepEqual(seen.slice(-2), ['next', 'replacement']);
  port2.onmessage = null;
  port1.postMessage('last');
  await tick();
  assert.equal(seen.at(-1), 'last');
});

test('closing either endpoint prevents queued and future port delivery', async () => {
  const { window } = fresh();
  const { port1, port2 } = new window.MessageChannel();
  port2.onmessage = () => assert.fail('closed port delivered');
  port1.postMessage('pending');
  port2.close();
  port2.start();
  port1.postMessage('after close');
  port2.postMessage('closed source');
  await tick();
});

test('port transfers validate before detaching and support transfer options', async () => {
  const { window } = fresh();
  const outer = new window.MessageChannel(), inner = new window.MessageChannel();
  assert.throws(() => outer.port1.postMessage(outer.port1, [outer.port1]), { name: 'DataCloneError' });
  assert.throws(() => outer.port1.postMessage(inner.port1), { name: 'DataCloneError' });
  assert.throws(() => outer.port1.postMessage({}, [inner.port1, inner.port1]), { name: 'DataCloneError' });
  assert.throws(() => outer.port1.postMessage(() => {}, [inner.port1]), { name: 'DataCloneError' });
  let received;
  outer.port2.onmessage = event => { received = event; };
  outer.port1.postMessage({ nested: [inner.port1, null] }, { transfer: [inner.port1] });
  assert.throws(() => window.postMessage({}, '*', [inner.port1]), { name: 'DataCloneError' });
  await tick();
  const moved = received.ports[0];
  assert.equal(received.data.nested[0], moved);
  assert.equal(received.data.nested[1], null);
  inner.port1.postMessage('detached no-op');
  inner.port1.close();
  inner.port1.start();
  const seen = [];
  inner.port2.onmessage = event => seen.push(event.data);
  moved.postMessage('moved');
  await tick();
  assert.deepEqual(seen, ['moved']);
});

test('transferring a queued endpoint preserves its queue for the new wrapper', async () => {
  const { window } = fresh();
  const channel = new window.MessageChannel();
  channel.port1.postMessage('before transfer');
  let transferred;
  window.onmessage = event => { transferred = event.ports[0]; };
  window.postMessage('port only in transfer list', '*', [channel.port2]);
  await tick();
  const seen = [];
  transferred.onmessage = event => seen.push(event.data);
  await tick();
  assert.deepEqual(seen, ['before transfer']);
});


test('assigning the same srcdoc reloads rather than reviving the old document', async () => {
  const { document } = fresh();
  const frame = appendFrame(document, '<p>same</p>');
  const previous = frame.contentWindow;
  previous.onmessage = () => assert.fail('reloaded document received stale data');
  previous.postMessage('stale', '*');
  frame.setAttribute('srcdoc', '<p>same</p>');
  assert.notEqual(frame.contentWindow, previous);
  await tick();
});

test('primitive port messages preserve values and reject uncloneable primitives', async () => {
  const { window } = fresh();
  const { port1, port2 } = new window.MessageChannel();
  const seen = [];
  port2.onmessage = event => seen.push(event.data);
  for (const value of [null, undefined, 1, 'text', true, 3n]) port1.postMessage(value);
  assert.throws(() => port1.postMessage(Symbol('not cloneable')), { name: 'DataCloneError' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(seen, [null, undefined, 1, 'text', true, 3n]);
});

test('runtime ports clone through custom records and cross-realm containers', async () => {
  const { runInNewContext } = await import('node:vm');
  const { window } = fresh();
  const channel = new window.MessageChannel();
  class Record { constructor(port) { this.port = port; } }
  const data = runInNewContext('({ map: new Map(), set: new Set(), sparse: new Array(3) })');
  data.record = new Record(channel.port2);
  data.map.set(channel.port2, data.record);
  data.set.add(data.record);
  let received;
  window.onmessage = event => { received = event.data; };
  window.postMessage(data, '*', [channel.port2]);
  await tick();
  assert.equal(received.map.get(received.record.port), received.record);
  assert.ok(received.set.has(received.record));
  assert.equal(received.sparse.length, 3);
  assert.equal(0 in received.sparse, false);
});

test('port messaging remains usable for primitives in a host without clone or DOMException', async () => {
  const { execFileSync } = await import('node:child_process');
  const moduleUrl = new URL('../src/runtime/messaging.mjs', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    globalThis.structuredClone = undefined;
    globalThis.DOMException = undefined;
    const { MessageChannel, cloneMessage } = await import(${JSON.stringify(moduleUrl)});
    const { port1, port2 } = new MessageChannel();
    assert.throws(() => port1.postMessage(port2), { name: 'DataCloneError' });
    assert.throws(() => cloneMessage({ value: 1 }), /requires host structuredClone/);
    const result = new Promise(resolve => { port2.onmessage = event => resolve(event.data); });
    port1.postMessage(null);
    assert.equal(await result, null);
  `]);
});
