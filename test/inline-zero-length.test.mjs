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

test('CSS declarations preserve semicolons inside quoted strings, URLs and escaped tokens', () => {
  const { actual, expected } = pair();
  const declarations = [
    ['background-image', 'url("data:image/png;base64,iVBORw0KGgo=")'],
    ['content', '"left;right"'],
    ['--quoted', "'left;right'"],
    ['--escaped', String.raw`"left\";right"`],
    ['--token', String.raw`left\;right`],
    ['--function', 'fn(left; fn(inner; value))'],
    ['--nested', '[left; {right; value}]'],
    ['width', '0'],
  ];
  const text = declarations.map(([property, value]) => `${property}: ${value}`).join('; ');
  for (const assign of [
    element => { element.style.cssText = text; },
    element => element.setAttribute('style', text),
  ]) {
    assign(actual);
    assign(expected);
    for (const [property] of declarations) {
      assert.equal(actual.style.getPropertyValue(property), expected.style.getPropertyValue(property), property);
    }
    assert.ok(actual.style.cssText.includes('data:image/png;base64,iVBORw0KGgo='));
    actual.style.height = '0';
    assert.equal(actual.style.backgroundImage, expected.style.backgroundImage);
    assert.equal(actual.style.content, expected.style.content);
    assert.equal(actual.style.height, '0px');
  }
});

test('style caches invalidate across attribute, CSSOM and priority mutations', () => {
  const { actual } = pair();
  const style = actual.style;
  actual.setAttribute('style', 'left: 0 !important; content: "a;b"');
  assert.equal(style.left, '0px');
  assert.equal(style.cssText, style.cssText);
  assert.equal(style.getPropertyPriority('left'), 'important');
  actual.setAttribute('style', 'right: 2px; content: "c;d"');
  assert.equal(style.left, '');
  assert.equal(style.right, '2px');
  assert.equal(style.content, '"c;d"');
  assert.equal(style.getPropertyPriority('left'), '');
  style.setProperty('right', '0', 'important');
  assert.equal(style.right, '0px');
  assert.match(style.cssText, /right: 0px !important/);
  assert.equal(style.removeProperty('right'), '0px');
  assert.doesNotMatch(style.cssText, /right/);
  style.cssText = 'top: 0';
  assert.equal(style.top, '0px');
  assert.equal(style.content, '');
  actual.removeAttribute('style');
  assert.equal(style.cssText, '');
  assert.equal(style.length, 0);
});

test('computed inline and stylesheet declarations preserve quoted semicolons', () => {
  const { turbo, actual } = pair();
  turbo.document.body.appendChild(actual);
  actual.style.cssText = 'background-image: url("data:image/png;base64,a="); content: "a;b"; left: 0';
  let computed = turbo.window.getComputedStyle(actual);
  assert.equal(computed.backgroundImage, 'url("data:image/png;base64,a=")');
  assert.equal(computed.content, '"a;b"');
  assert.equal(computed.left, '0px');
  actual.removeAttribute('style');
  const sheet = turbo.document.createElement('style');
  sheet.textContent = 'div { background-image: url("data:image/png;base64,b="); content: "c;d"; left: 0; }';
  turbo.document.head.appendChild(sheet);
  computed = turbo.window.getComputedStyle(actual);
  assert.equal(computed.backgroundImage, 'url("data:image/png;base64,b=")');
  assert.equal(computed.content, '"c;d"');
  assert.equal(computed.left, '0px');
});

test('cached standard CSSOM writes normalize whitespace consistently with parsed attributes', () => {
  const { actual, expected, turbo } = pair();
  for (const [property, value] of [['display', ' block '], ['opacity', ' 0.5 '], ['left', ' 0 ']]) {
    actual.style.setProperty(property, value, 'important');
    expected.style.setProperty(property, value, 'important');
    assert.equal(actual.style.getPropertyValue(property), expected.style.getPropertyValue(property));
    assert.equal(actual.style.getPropertyPriority(property), 'important');
    const copy = turbo.document.createElement('div');
    copy.setAttribute('style', actual.getAttribute('style'));
    assert.equal(copy.style.getPropertyValue(property), actual.style.getPropertyValue(property));
    assert.equal(copy.style.getPropertyPriority(property), actual.style.getPropertyPriority(property));
  }
  actual.style.opacity = ' 0.75 ';
  assert.equal(actual.style.opacity, '0.75');
  assert.equal(actual.style.getPropertyPriority('opacity'), 'important');
  actual.style.setProperty('--spaced', '  token  ');
  assert.equal(actual.style.getPropertyValue('--spaced'), 'token');
});

test('CSS comments cannot change declaration string or delimiter state', () => {
  const { actual, expected, turbo } = pair();
  const text = `width: 1px; /* don't tokenize \"; ([{ */ height: 2px; opacity: 0.5; left: /* ]; ' */ 0; content: "/* literal; */"`;
  for (const assign of [
    element => { element.style.cssText = text; },
    element => element.setAttribute('style', text),
  ]) {
    assign(actual);
    assign(expected);
    for (const property of ['width', 'height', 'opacity', 'left', 'content']) {
      assert.equal(actual.style.getPropertyValue(property), expected.style.getPropertyValue(property), property);
    }
    turbo.document.body.appendChild(actual);
    const computed = turbo.window.getComputedStyle(actual);
    assert.equal(computed.height, '2px');
    assert.equal(computed.opacity, '0.5');
    assert.equal(computed.content, '"/* literal; */"');
  }
});

test('unterminated CSS comments discard their contents without losing earlier declarations', () => {
  const { actual, expected } = pair();
  actual.style.cssText = expected.style.cssText = "width: 1px; opacity: 0.5; /* don't parse height: 2px";
  assert.equal(actual.style.width, expected.style.width);
  assert.equal(actual.style.opacity, expected.style.opacity);
  assert.equal(actual.style.height, expected.style.height);
});


test('custom property comments and quoted comment text remain literal', () => {
  const { actual, expected } = pair();
  const text = `/* before name */ --tokens: a/* don't split ; ([ */b; --quoted: "/* literal; */"; opacity: 0.5`;
  actual.style.cssText = expected.style.cssText = text;
  for (const property of ['--tokens', '--quoted', 'opacity']) {
    assert.equal(actual.style.getPropertyValue(property), expected.style.getPropertyValue(property), property);
  }
});
