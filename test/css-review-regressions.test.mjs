import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEnvironment } from '../src/runtime/index.mjs';
import { CSSStyleRule } from '../src/runtime/cssom.mjs';
import { normalizeBackgroundImage } from '../src/runtime/css-values.mjs';

function compareStyles(scenario) {
  const html = '<!doctype html><style>div { color: red; }</style><div></div>';
  const oracle = new JSDOM(html);
  try {
    assert.deepEqual(scenario(createEnvironment(html).window), scenario(oracle.window));
  } finally { oracle.window.close(); }
}

test('authored stylesheet text mutations replace cached CSSOM rules in the cascade', () => {
  compareStyles(window => {
    const style = window.document.querySelector('style');
    const element = window.document.querySelector('div');
    const results = [];
    style.sheet;
    results.push(window.getComputedStyle(element).color);
    style.textContent = 'div { color: blue; }';
    results.push(window.getComputedStyle(element).color);
    style.firstChild.data = 'div { color: green; }';
    results.push(window.getComputedStyle(element).color);
    style.replaceChildren(window.document.createTextNode('div { color: purple; }'));
    results.push(window.getComputedStyle(element).color);
    return results;
  });
});

test('CSSOM deletion and insertion control authored rules without replaying DOM text', () => {
  compareStyles(window => {
    const style = window.document.querySelector('style');
    const element = window.document.querySelector('div');
    const sheet = style.sheet;
    const results = [];
    sheet.deleteRule(0);
    results.push(window.getComputedStyle(element).color === 'rgb(255, 0, 0)');
    sheet.insertRule('div { color: blue; }', 0);
    results.push(window.getComputedStyle(element).color);
    sheet.insertRule('div { color: green; }', 0);
    results.push(window.getComputedStyle(element).color);
    sheet.deleteRule(1);
    results.push(window.getComputedStyle(element).color);
    return results;
  });
});

test('replacing stylesheet text discards injected rules before text serialization', () => {
  const { window, document } = createEnvironment('<style></style><div></div>');
  const style = document.querySelector('style');
  style.sheet.insertRule('div { color: red; }');
  style.textContent = 'div { color: blue; }';
  assert.equal(style.textContent, 'div { color: blue; }');
  assert.equal(window.getComputedStyle(document.querySelector('div')).color, 'rgb(0, 0, 255)');
  assert.equal(style.sheet.cssRules.length, 1);
});

test('background URL control escapes preserve following hex characters on repeated serialization', () => {
  for (const control of ['a', 'd', 'c']) {
    for (const following of ['b', 'f', '0', '9', 'g']) {
      const input = `url("/image\\${control} ${following}.png")`;
      const normalized = normalizeBackgroundImage(input);
      assert.equal(normalized, normalizeBackgroundImage(normalized));
      assert.equal(normalized, normalizeBackgroundImage(`url('/image\\00000${control}${following}.png')`));
    }
  }
});

test('duplicate CSS declarations expose the latest value and its own priority', () => {
  const oracle = new JSDOM('<style></style>');
  try {
    for (const declarations of [
      'color:red!important; color:blue',
      'color:red; color:blue!important',
      'color:red!important; color:blue!important; color:green',
      '--color:red!important; --color:blue',
    ]) {
      const text = `div { ${declarations} }`;
      const sheet = oracle.window.document.querySelector('style').sheet;
      sheet.insertRule(text, 0);
      const actual = new CSSStyleRule(text).style;
      const expected = sheet.cssRules[0].style;
      const property = declarations.startsWith('--') ? '--color' : 'color';
      assert.equal(actual.getPropertyValue(property), expected.getPropertyValue(property));
      assert.equal(actual.getPropertyPriority(property), expected.getPropertyPriority(property));
      sheet.deleteRule(0);
    }
  } finally { oracle.window.close(); }
});
