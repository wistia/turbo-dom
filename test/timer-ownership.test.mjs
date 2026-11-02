import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installGlobals } from '../src/environment/install.mjs';
import { createEnvironment } from '../src/runtime/index.mjs';

function clock() {
  let next = 0;
  const pending = new Map(), cancelled = [];
  const schedule = (callback, delay) => { pending.set(++next, { callback, delay }); return next; };
  const clear = id => { cancelled.push(id); pending.delete(id); };
  return { pending, cancelled, api: { setTimeout: schedule, setInterval: schedule, clearTimeout: clear, clearInterval: clear } };
}

test('timeouts, intervals, idle work and messages are cancelled before installed globals are restored', () => {
  const time = clock(), target = { ...time.api };
  const scope = installGlobals(target);
  const calls = [];
  target.setTimeout(() => calls.push('timeout'), 0);
  target.setInterval(() => calls.push('interval'), 10);
  target.requestIdleCallback(() => calls.push('idle'));
  target.postMessage('message', '*');
  const callbacks = [...time.pending.values()];
  assert.equal(time.pending.size, 4);
  scope.teardown();
  assert.equal(time.pending.size, 0);
  assert.equal(target.window, undefined);
  for (const task of callbacks) task.callback();
  assert.deepEqual(calls, []);
  assert.equal(scope.window.setTimeout(() => assert.fail('disposed timer'), 0), 0);
  assert.equal(scope.window.requestIdleCallback(() => assert.fail('disposed idle')), 0);
});

test('timeouts remove their ownership record and intervals repeat until either clear API cancels them', () => {
  const time = clock(), target = { ...time.api };
  const scope = installGlobals(target);
  let once = 0, repeated = 0;
  const id = target.setTimeout(function(a, b) { assert.equal(this, target); once += a + b; }, 5, 2, 3);
  const interval = target.setInterval(() => repeated++, 10);
  const callback = time.pending.get(id).callback;
  callback(); callback();
  assert.equal(once, 5);
  const repeat = time.pending.get(interval).callback;
  repeat(); repeat();
  target.clearTimeout(interval);
  repeat();
  assert.equal(repeated, 2);
  const another = target.setTimeout(() => assert.fail('cancelled timeout'), 0);
  target.clearInterval(another);
  target.clearInterval(-1);
  scope.teardown();
  assert.deepEqual(time.cancelled, [interval, another]);
});

test('reset retires old timer delegates and scheduler cancellation retains the owning clock', () => {
  const time = clock(), target = { ...time.api };
  const scope = installGlobals(target);
  const oldSchedule = target.setTimeout, oldClear = target.clearTimeout, oldIdle = target.requestIdleCallback;
  const id = oldSchedule(() => assert.fail('old generation'), 0);
  const callback = time.pending.get(id).callback;
  target.clearTimeout = () => assert.fail('wrong clock');
  scope.env.reset();
  assert.equal(time.pending.size, 0);
  callback();
  assert.equal(oldSchedule(() => {}, 0), 0);
  assert.equal(oldIdle(() => {}), 0);
  target.clearTimeout = time.api.clearTimeout;
  const current = scope.window.setTimeout(() => {}, 0);
  oldClear(current);
  assert.equal(time.pending.size, 1);
  scope.teardown();
  assert.equal(time.pending.size, 0);
});

test('child timer and frame queues are physically cancelled on removal, replacement and parent cleanup', () => {
  const time = clock(), target = { ...time.api };
  const scope = installGlobals(target, { html: '<iframe srcdoc="old"></iframe>' });
  const frame = target.document.querySelector('iframe');
  const first = frame.contentWindow;
  first.setTimeout(() => assert.fail('removed timeout'), 0);
  first.requestAnimationFrame(() => assert.fail('removed frame'));
  frame.remove();
  assert.equal(time.pending.size, 0);
  assert.equal(first.setTimeout(() => {}, 0), 0);
  target.document.body.appendChild(frame);
  const second = frame.contentWindow;
  second.setInterval(() => assert.fail('replaced interval'), 1);
  frame.srcdoc = 'replacement';
  const third = frame.contentWindow;
  assert.equal(time.pending.size, 0);
  assert.equal(second.requestAnimationFrame(() => {}), 0);
  third.setTimeout(() => assert.fail('reset child'), 0);
  scope.env.reset();
  assert.equal(time.pending.size, 0);
  const current = target.document.querySelector('iframe').contentWindow;
  current.requestAnimationFrame(() => assert.fail('disposed child'));
  current.setInterval(() => assert.fail('disposed interval'), 1);
  scope.teardown();
  assert.equal(time.pending.size, 0);
});

test('invalid callbacks are rejected and idle deadlines retain the existing stub contract', () => {
  const time = clock(), target = { ...time.api };
  const scope = installGlobals(target);
  assert.throws(() => target.setTimeout('code'), TypeError);
  assert.throws(() => target.setInterval(null), TypeError);
  assert.throws(() => target.requestIdleCallback(null), TypeError);
  let deadline;
  const id = target.requestIdleCallback(value => { deadline = value; });
  time.pending.get(id).callback();
  assert.equal(deadline.didTimeout, false);
  assert.equal(deadline.timeRemaining(), 50);
  const cancelled = target.requestIdleCallback(() => assert.fail('cancelled idle'));
  target.cancelIdleCallback(cancelled);
  scope.teardown();
});

const require = createRequire(import.meta.url);
const JestEnvironment = require('../src/environment/jest.cjs');
function jestEnv() {
  return new JestEnvironment({ projectConfig: { testEnvironmentOptions: {}, globals: {}, fakeTimers: {} }, globalConfig: {} }, { console, testPath: '/tmp/turbo-jest-lifecycle.test.js', docblockPragmas: {} });
}

test('Jest teardown restores installed globals and permanently disposes saved windows', async () => {
  const env = jestEnv();
  await env.setup();
  const target = env.global, window = target.__turboDom.window;
  await env.teardown();
  assert.equal(target.window, undefined);
  assert.equal(target.__turboDom, undefined);
  assert.equal(window.requestAnimationFrame(() => assert.fail('late Jest frame')), 0);
  assert.equal(window.setTimeout(() => assert.fail('late Jest timeout'), 0), 0);
});

test('Jest fake clocks own runtime timers and frames, including internal and child windows', async () => {
  const env = jestEnv();
  await env.setup();
  const target = env.global, window = target.__turboDom.window;
  try {
    env.fakeTimersModern.useFakeTimers();
    let calls = 0;
    target.setTimeout(() => calls++, 5);
    window.requestAnimationFrame(() => calls++);
    const frame = target.document.createElement('iframe');
    target.document.body.appendChild(frame);
    frame.contentWindow.requestAnimationFrame(() => calls++);
    assert.equal(env.fakeTimersModern.getTimerCount(), 3);
    env.fakeTimersModern.advanceTimersByTime(20);
    assert.equal(calls, 3);
    frame.contentWindow.setInterval(() => calls++, 1);
    frame.remove();
    assert.equal(env.fakeTimersModern.getTimerCount(), 0);
    window.setInterval(() => calls++, 1);
  } finally { await env.teardown(); }
});


test('call-through timer spies deliver callbacks once and physically cancel owned work', () => {
  const { ModuleMocker } = require('jest-mock');
  const mocker = new ModuleMocker(globalThis);
  const time = clock(), target = { ...time.api };
  const scope = installGlobals(target);
  const spies = Object.fromEntries(['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'].map(name => [name, mocker.spyOn(target, name)]));
  try {
    let calls = 0;
    const timeout = target.setTimeout(() => calls++, 0);
    assert.equal(spies.setTimeout.mock.calls.length, 1);
    time.pending.get(timeout).callback();
    assert.equal(calls, 1);
    const interval = target.setInterval(() => calls++, 1);
    assert.equal(spies.setInterval.mock.calls.length, 1);
    time.pending.get(interval).callback();
    assert.equal(calls, 2);
    target.clearInterval(interval);
    assert.equal(time.pending.has(interval), false);
    assert.equal(spies.clearInterval.mock.calls.length, 1);
    const cancelled = target.setTimeout(() => assert.fail('cancelled'), 0);
    target.clearTimeout(cancelled);
    assert.equal(time.pending.has(cancelled), false);
    assert.equal(spies.clearTimeout.mock.calls.length, 1);
    const frame = target.requestAnimationFrame(() => calls++);
    assert.equal(time.pending.get(frame).delay, 16);
    time.pending.get(frame).callback();
    assert.equal(calls, 3);
    const frameToCancel = target.requestAnimationFrame(() => assert.fail('cancelled frame'));
    target.cancelAnimationFrame(frameToCancel);
    assert.equal(time.pending.has(frameToCancel), false);
    const pending = target.requestAnimationFrame(() => assert.fail('disposed frame'));
    scope.teardown();
    assert.equal(time.pending.has(pending), false);
  } finally { mocker.restoreAllMocks(); scope.teardown(); }
});

test('a frame is physically cancelled when only clearTimeout has a call-through spy', () => {
  const { ModuleMocker } = require('jest-mock');
  const mocker = new ModuleMocker(globalThis);
  const time = clock(), target = { ...time.api };
  const scope = installGlobals(target);
  const spy = mocker.spyOn(target, 'clearTimeout');
  try {
    const id = target.requestAnimationFrame(() => assert.fail('cancelled frame'));
    target.cancelAnimationFrame(id);
    assert.equal(time.pending.size, 0);
    assert.equal(spy.mock.calls.length, 1);
  } finally { mocker.restoreAllMocks(); scope.teardown(); }
});


test('auto-advancing Jest fake clocks retain a real interval for their time pump', async () => {
  const env = jestEnv();
  await env.setup();
  try {
    env.fakeTimersModern.useFakeTimers({ advanceTimers: 5 });
    let calls = 0;
    env.global.setTimeout(() => calls++, 10);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls, 1);
  } finally { await env.teardown(); }
});


test('legacy Jest fake clocks deliver runtime frames and clean up before restoring globals', async () => {
  const env = jestEnv();
  await env.setup();
  const target = env.global, window = target.__turboDom.window;
  try {
    env.fakeTimers.useFakeTimers();
    let calls = 0;
    window.requestAnimationFrame(() => calls++);
    env.fakeTimers.advanceTimersByTime(20);
    assert.equal(calls, 1);
    window.requestAnimationFrame(() => assert.fail('legacy frame after teardown'));
  } finally { await env.teardown(); }
  assert.equal(target.window, undefined);
  assert.equal(window.setTimeout(() => assert.fail('disposed legacy timer'), 0), 0);
});
