import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../src/runtime/index.mjs';
import { installGlobals } from '../src/environment/install.mjs';
import vitestEnvironment from '../src/environment/vitest.mjs';

function withClock(run) {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const queue = new Map(), cancelled = [];
  let next = 0;
  globalThis.setTimeout = (callback, delay) => {
    assert.equal(delay, 16);
    queue.set(++next, callback);
    return next;
  };
  globalThis.clearTimeout = id => { cancelled.push(id); };
  try { run({ queue, cancelled }); }
  finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
}

test('teardown cancels pending frames before restoring globals and blocks stale scheduling', () => {
  withClock(({ queue, cancelled }) => {
    const target = {};
    const installed = installGlobals(target);
    let calls = 0;
    const schedule = target.requestAnimationFrame;
    const id = schedule(() => { calls++; assert.ok(target.window); });
    installed.teardown();
    assert.deepEqual(cancelled, [id]);
    assert.equal(target.window, undefined);
    queue.get(id)();
    assert.equal(calls, 0);
    assert.equal(schedule(() => calls++), 0);
    assert.equal(installed.window.requestAnimationFrame(() => calls++), 0);
  });
});

test('reset invalidates old frames and saved handles while allowing the next generation', () => {
  withClock(({ queue, cancelled }) => {
    const env = createEnvironment();
    const oldSchedule = env.window.requestAnimationFrame, oldCancel = env.window.cancelAnimationFrame;
    let oldCalls = 0, newCalls = 0;
    const oldId = oldSchedule(() => oldCalls++);
    env.reset();
    const newId = env.window.requestAnimationFrame(() => newCalls++);
    oldCancel(newId);
    assert.equal(oldSchedule(() => oldCalls++), 0);
    queue.get(oldId)(); queue.get(newId)();
    assert.equal(oldCalls, 0);
    assert.equal(newCalls, 1);
    assert.deepEqual(cancelled, [oldId]);
    env.dispose();
  });
});

test('cancellation is window-local and callbacks cannot be delivered twice', () => {
  withClock(({ queue, cancelled }) => {
    const a = createEnvironment(), b = createEnvironment();
    let calls = 0;
    const first = a.window.requestAnimationFrame(timestamp => { calls++; assert.equal(typeof timestamp, 'number'); });
    const second = b.window.requestAnimationFrame(() => calls++);
    a.window.cancelAnimationFrame(second);
    a.window.cancelAnimationFrame(first);
    queue.get(first)(); queue.get(second)(); queue.get(second)();
    assert.equal(calls, 1);
    assert.deepEqual(cancelled, [first]);
    assert.throws(() => a.window.requestAnimationFrame(null), TypeError);
    a.dispose(); b.dispose();
  });
});

test('frame cancellation retains the scheduler that owns a pending handle', () => {
  withClock(({ cancelled }) => {
    const env = createEnvironment();
    const id = env.window.requestAnimationFrame(() => {});
    const previous = globalThis.clearTimeout;
    globalThis.clearTimeout = () => assert.fail('wrong scheduler');
    try { env.dispose(); } finally { globalThis.clearTimeout = previous; }
    assert.deepEqual(cancelled, [id]);
  });
});

test('child frames cannot run after removal or parent teardown', () => {
  withClock(({ queue }) => {
    const env = createEnvironment('<iframe></iframe>');
    const frame = env.document.querySelector('iframe');
    const child = frame.contentWindow;
    let calls = 0;
    const id = child.requestAnimationFrame(() => calls++);
    frame.remove();
    queue.get(id)();
    assert.equal(child.requestAnimationFrame(() => calls++), 0);
    env.document.body.appendChild(frame);
    const next = frame.contentWindow.requestAnimationFrame(() => calls++);
    env.dispose();
    queue.get(next)();
    assert.equal(calls, 0);
  });
});


test('Vitest adapter leaves internal windows disposed after clearing its document', () => {
  withClock(({ queue, cancelled }) => {
    const target = {};
    const state = vitestEnvironment.setup(target, {});
    const window = target.__turboDom.window;
    const id = window.requestAnimationFrame(() => assert.fail('frame after teardown'));
    state.teardown(target);
    assert.equal(target.document, undefined);
    assert.deepEqual(cancelled, [id]);
    queue.get(id)();
    assert.equal(window.requestAnimationFrame(() => assert.fail('resurrected frame')), 0);
  });
});
