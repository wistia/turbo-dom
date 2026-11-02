import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEnvironment } from '../src/runtime/index.mjs';

function ruleTree(window, css) {
  const style = window.document.createElement('style');
  window.document.head.appendChild(style);
  style.textContent = css;
  const visit = rule => ({
    type: rule.type,
    selector: rule.selectorText,
    condition: rule.conditionText,
    color: rule.style?.getPropertyValue('color'),
    width: rule.style?.getPropertyValue('width'),
    children: rule.type !== 1 && rule.cssRules ? [...rule.cssRules].map(visit) : undefined,
  });
  return [...style.sheet.cssRules].map(visit);
}

function compare(css) {
  const oracle = new JSDOM('<!doctype html><body></body>');
  try {
    assert.deepEqual(ruleTree(createEnvironment().window, css), ruleTree(oracle.window, css));
  } finally { oracle.window.close(); }
}

test('nested media and supports expose grouping interfaces, conditions and exact selectors', () => {
  const css = '@media (min-width: 1px) { @supports (display: grid) { .guard::after { width: 28px; } } .plain { color: red; } }';
  compare(css);
  const { window } = createEnvironment();
  const sheet = new window.CSSStyleSheet();
  sheet.insertRule(css);
  const media = sheet.cssRules[0], supports = media.cssRules[0], style = supports.cssRules[0];
  assert.ok(media instanceof window.CSSMediaRule);
  assert.ok(media instanceof window.CSSConditionRule);
  assert.ok(media instanceof window.CSSGroupingRule);
  assert.ok(media instanceof window.CSSRule);
  assert.equal(media instanceof window.CSSStyleRule, false);
  assert.ok(supports instanceof window.CSSSupportsRule);
  assert.ok(style instanceof window.CSSStyleRule);
  assert.ok(style instanceof window.CSSRule);
  assert.equal(style.selectorText, '.guard::after');
  assert.equal(style.parentRule, supports);
  assert.equal(supports.parentRule, media);
  assert.equal(media.parentRule, null);
  assert.equal(style.parentStyleSheet, sheet);
  assert.equal(media.parentStyleSheet, sheet);
  assert.throws(() => new window.CSSGroupingRule(), TypeError);
});

test('group rule insertion and deletion update serialization, parent links and document version', () => {
  const { document } = createEnvironment('<style>@media screen { .a { color: red; } }</style>');
  const sheet = document.querySelector('style').sheet;
  const group = sheet.cssRules[0], version = document.__version;
  assert.equal(group.insertRule('.first {color:blue}'), 0);
  assert.equal(group.insertRule('@supports (display:grid) { .last {color:green} }', 2), 2);
  assert.equal(group.cssRules[0].parentRule, group);
  assert.equal(group.cssRules[2].cssRules[0].parentStyleSheet, sheet);
  assert.ok(document.__version > version);
  assert.match(group.cssText, /^@media screen \{/);
  assert.match(group.cssText, /\.first \{ color: blue; \}/);
  group.deleteRule(0);
  assert.equal(group.cssRules[0].selectorText, '.a');
  assert.doesNotMatch(group.cssText, /\.first/);
  assert.throws(() => group.insertRule('.a{}', -1), RangeError);
  assert.throws(() => group.insertRule('.a{}', 4), RangeError);
  assert.throws(() => group.deleteRule(-1), RangeError);
  assert.throws(() => group.deleteRule(4), RangeError);
  const constructed = new (createEnvironment().window.CSSStyleSheet)();
  constructed.insertRule('@media screen {}');
  constructed.cssRules[0].insertRule('.x{}');
  constructed.cssRules[0].deleteRule(0);
});

test('group parsing respects quoted braces, escapes, comments and statement at-rules', () => {
  compare('/* ignored { } */ @media screen { .a { content: "}"; color: red; } /* } */ .b { content: \'{\'; width: 10px; } }');
  const { window } = createEnvironment();
  const sheet = new window.CSSStyleSheet();
  sheet.replaceSync('@import url("a.css"); @media screen { .a {content:"a\\\"}b"; color:red} }');
  assert.equal(sheet.cssRules.length, 2);
  assert.ok(sheet.cssRules[0] instanceof window.CSSRule);
  assert.equal(sheet.cssRules[0] instanceof window.CSSStyleRule, false);
  assert.equal(sheet.cssRules[1].cssRules.length, 1);
  assert.equal(sheet.cssRules[1].cssRules[0].style.getPropertyValue('color'), 'red');
  sheet.replaceSync('} /* missing terminator');
  assert.equal(sheet.cssRules.length, 0);
});

test('additional grouping blocks remain traversable without pretending to evaluate conditions', () => {
  const { window, document } = createEnvironment('<style>@media screen { div {color:red} }</style><div></div>');
  const sheet = new window.CSSStyleSheet();
  for (const name of ['container example (width > 1px)', 'layer utilities', 'scope (.card)', 'starting-style']) {
    sheet.insertRule(`@${name} { .a {color:red} }`, sheet.cssRules.length);
  }
  for (const rule of sheet.cssRules) {
    assert.ok(rule instanceof window.CSSGroupingRule);
    assert.equal(rule.cssRules[0].selectorText, '.a');
  }
  document.querySelector('style').sheet;
  assert.equal(window.getComputedStyle(document.querySelector('div')).color, '');
});


test('condition text does not require whitespace between the at-rule name and condition', () => {
  compare('@media(min-width:1px){.a{color:red}} @supports(display:grid){.b{width:1px}}');
  compare('@media   screen {.a{color:red}}');
});


test('group conditions can contain quoted and escaped braces without starting a block', () => {
  compare('@supports (font-family: "{") { .a {color:red} }');
  compare("@supports (font-family: '}') { .a {color:red} }");
  const { window } = createEnvironment();
  const sheet = new window.CSSStyleSheet();
  sheet.insertRule('@supports /* { ignored } */ (font-family: "a\\\"{b") { .a { color: red; } }');
  assert.equal(sheet.cssRules[0].cssRules[0].selectorText, '.a');
  sheet.insertRule('@unknown /* unterminated');
  assert.ok(sheet.cssRules[0] instanceof window.CSSRule);
});


test('leading comments do not hide grouping rules or their conditions during direct insertion', () => {
  const { window } = createEnvironment();
  const sheet = new window.CSSStyleSheet();
  sheet.insertRule(' /* first */ /* second */ @media/* header */ screen { .a { color:red } }');
  const media = sheet.cssRules[0];
  assert.ok(media instanceof window.CSSMediaRule);
  assert.equal(media.conditionText, 'screen');
  assert.equal(media.cssRules[0].selectorText, '.a');
  sheet.insertRule('/* unterminated');
  assert.ok(sheet.cssRules[0] instanceof window.CSSStyleRule);
  compare('@media/* header */ screen { .a {color:red} }');
});
