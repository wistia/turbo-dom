import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEnvironment } from '../src/runtime/index.mjs';

function pair() {
  const turbo = createEnvironment('<!doctype html><html><body></body></html>');
  const oracle = new JSDOM('<!doctype html><html><body></body></html>');
  return { turbo, oracle, actual: turbo.document.createElement('div'), expected: oracle.window.document.createElement('div') };
}

const paths = {
  assignment: (style, property, value) => { style[property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value; },
  setProperty: (style, property, value) => style.setProperty(property, value),
  cssText: (style, property, value) => { style.cssText = `${property}: ${value}`; },
};

for (const [name, assign] of Object.entries(paths)) {
  test(`inline zero lengths serialize like jsdom through ${name}`, () => {
    const { actual, expected } = pair();
    for (const property of [
      'left', 'right', 'top', 'bottom', 'width', 'height', 'min-width', 'max-height',
      'margin', 'margin-left', 'padding', 'padding-bottom', 'border-width', 'border-top-width',
      'border-radius', 'border-top-left-radius', 'outline-width', 'outline-offset',
      'gap', 'row-gap', 'column-gap', 'flex-basis', 'font-size', 'letter-spacing', 'word-spacing', 'text-indent',
    ]) {
      assign(actual.style, property, '0');
      assign(expected.style, property, '0');
      assert.equal(actual.style.getPropertyValue(property), expected.style.getPropertyValue(property), `${name}: ${property}`);
      assert.equal(actual.style.getPropertyValue(property), '0px');
    }
  });
}

test('numeric zero spellings normalize, while explicit units and function values remain intact', () => {
  const { actual, expected } = pair();
  for (const value of [0, '0', '-0', '+0', '0.0', '0e0', '00', '.0', ' 0 ', '0%', '0em', '0px', 'calc(100% - 0px)', 'var(--offset)']) {
    actual.style.left = value;
    expected.style.left = value;
    assert.equal(actual.style.left, expected.style.left, `left=${value}`);
  }
});

test('zero tokens normalize in length shorthands without rewriting unitless properties or custom values', () => {
  const { actual, expected } = pair();
  for (const [property, value] of [
    ['margin', '0 1px 2px 3px'], ['padding', '0 2px'], ['border-radius', '0 / 2px'], ['gap', '0 2px'],
    ['opacity', '0'], ['z-index', '0'], ['line-height', '0'], ['flex-grow', '0'],
    ['stroke-width', '0'], ['--offset', '0'], ['--CaseSensitive', '0 0'],
  ]) {
    actual.style.setProperty(property, value);
    expected.style.setProperty(property, value);
    assert.equal(actual.style.getPropertyValue(property), expected.style.getPropertyValue(property), property);
  }
});

test('raw attributes retain authored zeros while the CSSOM view and computed style normalize them', () => {
  const { turbo, actual, expected } = pair();
  const authored = 'left: 0; margin: 0 2px; opacity: 0; --offset: 0;';
  actual.setAttribute('style', authored);
  expected.setAttribute('style', authored);
  turbo.document.body.appendChild(actual);
  assert.equal(actual.style.left, expected.style.left);
  assert.equal(actual.style.margin, expected.style.margin);
  assert.equal(turbo.window.getComputedStyle(actual).left, '0px');
  assert.equal(actual.getAttribute('style'), authored);
  assert.match(actual.style.cssText, /left: 0px/);
  assert.match(actual.style.cssText, /margin: 0px 2px/);
  assert.equal(actual.style.getPropertyValue('--offset'), '0');
});

test('priorities and removal return normalized values without losing priority state', () => {
  const { actual, expected } = pair();
  actual.style.setProperty('left', '0', 'important');
  expected.style.setProperty('left', '0', 'important');
  assert.equal(actual.style.left, expected.style.left);
  assert.equal(actual.style.getPropertyPriority('left'), 'important');
  assert.match(actual.getAttribute('style'), /left: 0px !important/);
  assert.equal(actual.style.removeProperty('left'), expected.style.removeProperty('left'));
  actual.style.cssText = 'right: 0 !important; opacity: 0; --offset: 0';
  assert.equal(actual.style.right, '0px');
  assert.equal(actual.style.getPropertyPriority('right'), 'important');
  assert.equal(actual.style.opacity, '0');
  assert.equal(actual.style.getPropertyValue('--offset'), '0');
});
