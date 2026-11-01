import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../src/runtime/index.mjs';

const fresh = () => createEnvironment('<!doctype html><html><body><div></div><div></div></body></html>');

test('scroll offsets retain assigned values for independent elements', () => {
  const { document } = fresh();
  const [first, second] = document.querySelectorAll('div');
  assert.equal(first.scrollLeft, 0);
  assert.equal(first.scrollTop, 0);
  first.scrollLeft = 60.5;
  first.scrollTop = 24;
  second.scrollLeft = -10;
  assert.equal(first.scrollLeft, 60.5);
  assert.equal(first.scrollTop, 24);
  assert.equal(second.scrollLeft, -10);
  assert.equal(second.scrollTop, 0);
  assert.equal(first.cloneNode().scrollLeft, 0);
});

test('scroll offsets normalize non-finite values and coerce numeric input', () => {
  const { document } = fresh();
  const element = document.querySelector('div');
  element.scrollTop = '12.5';
  element.scrollLeft = '40';
  assert.equal(element.scrollTop, 12.5);
  assert.equal(element.scrollLeft, 40);
  element.scrollTop = Infinity;
  element.scrollLeft = NaN;
  assert.equal(element.scrollTop, 0);
  assert.equal(element.scrollLeft, 0);
});

test('headless elements do not advertise unsupported Web Animations queries', () => {
  const { document } = fresh();
  const element = document.querySelector('div');
  assert.equal(typeof element.getAnimations, 'undefined');
});
