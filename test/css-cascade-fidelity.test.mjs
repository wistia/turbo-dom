import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEnvironment } from '../src/runtime/index.mjs';

function pair(html) {
  const actual = createEnvironment(html).window;
  const expected = new JSDOM(html).window;
  return { actual, expected };
}

for (const [name, css, inline, expectedColor] of [
  ['stylesheet important beats inline normal', '#target { color: red !important }', 'color: blue', 'rgb(255, 0, 0)'],
  ['inline important beats stylesheet important', '#target { color: red !important }', 'color: blue !important', 'rgb(0, 0, 255)'],
  ['later normal rules do not override important rules', '#target { color: red !important } #target { color: blue }', '', 'rgb(255, 0, 0)'],
  ['important specificity still orders equal-priority declarations', '#target { color: red !important } div { color: blue !important }', '', 'rgb(255, 0, 0)'],
  ['later equal-specificity important rules win', '#target { color: red !important } #target { color: blue !important }', '', 'rgb(0, 0, 255)'],
  ['later normal declaration preserves earlier important duplicate', '#target { color: red !important; color: blue }', '', 'rgb(255, 0, 0)'],
]) {
  test(name, () => {
    const { actual } = pair(`<style>${css}</style><div id="target" style="${inline}"></div>`);
    assert.equal(actual.getComputedStyle(actual.document.querySelector('#target')).color, expectedColor);
  });
}

test('important shorthand expansion protects longhands from later normal inline values', () => {
  const { actual, expected } = pair('<style>#target { margin: 0 2px !important }</style><div id="target" style="margin-left: 9px"></div>');
  const a = actual.getComputedStyle(actual.document.querySelector('#target'));
  const e = expected.getComputedStyle(expected.document.querySelector('#target'));
  assert.equal(a.marginLeft, e.marginLeft);
  assert.equal(a.marginLeft, '2px');
  assert.equal(a.marginTop, '0px');
});

test('custom-property names remain case-sensitive and inherit through the flattened tree', () => {
  const { actual } = pair('<style>body { --Theme: red; --theme: blue !important } div { --theme: green }</style><div id="target"><span></span></div>');
  const div = actual.document.querySelector('#target');
  let computed = actual.getComputedStyle(div.firstElementChild);
  assert.equal(computed.getPropertyValue('--Theme'), 'red');
  assert.equal(computed.getPropertyValue('--theme'), 'green');
  assert.equal(computed.getPropertyValue('--THEME'), '');
  actual.document.body.style.setProperty('--Theme', 'purple');
  computed = actual.getComputedStyle(div.firstElementChild);
  assert.equal(computed.getPropertyValue('--Theme'), 'purple');
  div.style.setProperty('--theme', 'yellow');
  assert.equal(actual.getComputedStyle(div).getPropertyValue('--theme'), 'yellow');
});

test('custom-property inheritance crosses the shadow host boundary', () => {
  const { actual } = pair('<div id="host" style="--Theme: red"></div>');
  const host = actual.document.querySelector('#host');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>:host { --theme: blue }</style><span></span>';
  const computed = actual.getComputedStyle(shadow.querySelector('span'));
  assert.equal(computed.getPropertyValue('--Theme'), 'red');
  assert.equal(computed.getPropertyValue('--theme'), 'blue');
});

test('explicit inherit and inherited unset use actual parent declarations', () => {
  const { actual } = pair('<section style="color: red; width: 12px; --Theme: blue"><div style="color: unset; width: inherit; --Theme: unset"></div></section>');
  const div = actual.document.querySelector('div');
  const computed = actual.getComputedStyle(div);
  assert.equal(computed.color, 'rgb(255, 0, 0)');
  assert.equal(computed.width, '12px');
  assert.equal(computed.getPropertyValue('--Theme'), 'blue');
  div.style.cssText = 'color: initial; width: unset; --Theme: initial; height: inherit';
  const reset = actual.getComputedStyle(div);
  assert.equal(reset.color, '');
  assert.equal(reset.width, '');
  assert.equal(reset.height, '');
  assert.equal(reset.getPropertyValue('--Theme'), '');
});

test('root-wide keywords stay absent when no real initial value can be resolved', () => {
  const { actual } = pair('<html style="color: inherit; width: initial; --Theme: unset"></html>');
  const computed = actual.getComputedStyle(actual.document.documentElement);
  assert.equal(computed.color, '');
  assert.equal(computed.width, '');
  assert.equal(computed.getPropertyValue('--Theme'), '');
});

test('CSSOM writes and authored custom values normalize whitespace consistently', () => {
  const { actual, expected } = pair('<div></div>');
  const a = actual.document.querySelector('div');
  const e = expected.document.querySelector('div');
  for (const name of ['--Theme', '--theme']) {
    a.style.setProperty(name, '  red  ');
    e.style.setProperty(name, '  red  ');
    assert.equal(a.style.getPropertyValue(name), e.style.getPropertyValue(name));
    const clone = a.cloneNode();
    assert.equal(clone.style.getPropertyValue(name), a.style.getPropertyValue(name));
  }
  a.setAttribute('style', 'COLOR: red; --Theme: blue; --theme: green');
  assert.equal(a.style.color, 'red');
  assert.equal(actual.getComputedStyle(a).getPropertyValue('--Theme'), 'blue');
});
