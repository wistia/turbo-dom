import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEnvironment } from '../src/runtime/index.mjs';
import { isValidSizingValue } from '../src/runtime/css-values.mjs';

function compare(scenario) {
  const oracle = new JSDOM('<!doctype html><body><div></div></body>');
  try {
    assert.deepEqual(scenario(createEnvironment('<!doctype html><body><div></div></body>').window), scenario(oracle.window));
  } finally { oracle.window.close(); }
}

test('CSSOM discards invalid sizing declarations without losing the previous valid value', () => {
  compare(window => {
    const results = [];
    for (const property of ['width', 'height', 'min-width', 'max-height', 'flex-basis']) {
      for (const value of ['not-a-width', '-1px', '10unknown', '1', 'red', '20px', '0', '25%', '2rem', 'min-content', 'max-content', 'inherit', 'var(--size)']) {
        if (property === 'flex-basis' && value === '-1px') continue;
        const sheet = new window.CSSStyleSheet();
        sheet.insertRule(`.target { ${property}: 10px; ${property}: ${value}; }`);
        results.push([property, value, sheet.cssRules[0].style.getPropertyValue(property)]);
      }
    }
    return results;
  });
});

test('inline assignments and authored CSS reject invalid sizing values', () => {
  compare(window => {
    const { document } = window;
    const element = document.querySelector('div');
    element.style.width = '12px';
    element.style.width = 'not-a-width';
    element.style.setProperty('height', '13px');
    element.style.setProperty('height', '-1px');
    const results = [element.style.width, element.style.height];
    element.style.cssText = 'width: bogus; height: 14px;';
    results.push(element.style.width, element.style.height);
    const style = document.createElement('style');
    style.textContent = 'div { width: 10px; width: bogus; }';
    document.head.append(style);
    results.push(window.getComputedStyle(element).width);
    return results;
  });
});

test('inline numeric lengths canonicalize insignificant zeros while preserving authored precision', () => {
  compare(window => {
    const { document } = window;
    const element = document.querySelector('div');
    const results = [];
    for (const property of ['width', 'height', 'font-size', 'margin-left']) {
      for (const value of ['6.000px', '-0.000px', '60.00000000000001px', '01.2300em', '1e-8px', '2.00%', '0.123456789px']) {
        element.style.setProperty(property, value);
        results.push(element.style.getPropertyValue(property));
      }
    }
    return results;
  });
  const { window, document } = createEnvironment('<body><div></div></body>');
  const element = document.querySelector('div');
  element.style.fontSize = '6.000px';
  assert.equal(element.style.fontSize, window.getComputedStyle(element).fontSize);
  element.style.width = '0.123456789px';
  assert.equal(element.style.width, '0.123456789px');
  assert.equal(window.getComputedStyle(element).width, '0.123457px');
});

test('sizing validation preserves supported CSS functions and rejects malformed outer expressions', () => {
  for (const value of ['calc(100% - 2px)', 'min(100%, 28px)', 'max(1px, 2rem)', 'clamp(0px, 50%, 100px)', 'fit-content(100px)', 'env(safe-area-inset-left)', 'calc-size(auto, size + 10px)', 'anchor-size(width)']) {
    assert.equal(isValidSizingValue('width', value), true, value);
  }
  for (const value of ['unknown(100px)', 'calc(100px', 'calc(100px))', 'var(--size) garbage', '', '-2%', '1e999px']) {
    assert.equal(isValidSizingValue('width', value), false, value);
  }
  assert.equal(isValidSizingValue('width', 'auto'), true);
  assert.equal(isValidSizingValue('max-width', 'auto'), false);
  assert.equal(isValidSizingValue('max-width', 'none'), true);
  assert.equal(isValidSizingValue('width', 'none'), false);
  assert.equal(isValidSizingValue('--width', 'not-a-width'), true);
});

test('sizing function validation retains quoted, escaped and commented variable fallbacks', () => {
  compare(window => {
    const values = ['var(--x, "foo)")', 'var(--x, "foo(")', 'var(--x, url("a)"))', 'var(--x, \\))', "var(--x, 'a\\'b)')", 'var(--x, /* ) ( */ 10px)'];
    return values.map(value => {
      const sheet = new window.CSSStyleSheet();
      sheet.insertRule(`.target { width: ${value}; }`);
      return sheet.cssRules[0].style.getPropertyValue('width').length > 0;
    });
  });
  assert.equal(isValidSizingValue('width', 'var(--x) /* comment */'), true);
  assert.equal(isValidSizingValue('width', 'var(--x, /* unfinished)'), false);
  assert.equal(isValidSizingValue('width', 'var(--x, "unfinished)'), false);
});

test('CSSStyleRule style cssText serializes accepted declarations and current priorities', () => {
  compare(window => {
    const sheet = new window.CSSStyleSheet();
    sheet.insertRule('.target { width: 6.000px; height: not-a-size; color: red !important; width: 12px; }');
    const style = sheet.cssRules[0].style;
    assert.equal(style.getPropertyValue('height'), '');
    return style.cssText;
  });
});

test('discarded sizing declarations cannot change inline priorities', () => {
  compare(window => {
    const style = window.document.createElement('div').style;
    return ['width:10px; width:bogus!important', 'width:bogus!important', 'width:10px!important; width:bogus', 'width:10px!important; width:12px'].map(text => {
      style.cssText = text;
      return [style.getPropertyValue('width'), style.getPropertyPriority('width')];
    });
  });
});

test('CSSOM border shorthands expose longhands in declaration order', () => {
  compare(window => {
    return ['border-top:8px solid red', 'border:2px dashed #fff', 'border-top-width:2px; border-top:8px solid red', 'border-top:8px solid red; border-top-width:2px', 'border-top:solid', 'border-top:1px', 'border-top:0 dashed rgb(1, 2, 3)', 'border-top:8px solid red; border-top:var(--border)', 'border-top:8px solid red!important; border-top-width:2px'].map(declaration => {
      const sheet = new window.CSSStyleSheet();
      sheet.insertRule(`.target { ${declaration}; }`);
      const style = sheet.cssRules[0].style;
      return ['top', 'right', 'bottom', 'left'].flatMap(side => ['width', 'style', 'color'].flatMap(part => {
        const property = `border-${side}-${part}`;
        return [style.getPropertyValue(property), style.getPropertyPriority(property)];
      }));
    });
  });
});

test('border width, style and color families expand one through four components in declaration order', () => {
  compare(window => {
    const values = [];
    const declarations = [
      'border-top:8px solid red; border-width:2px',
      'border-width:2px; border-top:8px solid red',
      'border-top-width:8px; border-width:1px 2px',
      'border-top:8px solid red; border-style:dashed dotted double',
      'border-top:8px solid red; border-color:blue green red black',
      'border-width:0 2px 3px 4px; border-left-width:5px',
      'border-style:solid dashed; border-color:rgb(1, 2, 3) blue',
      'border-color:var(--border)',
      'border-color:var(--border, "red blue")',
      'border-top:8px solid red; border-width:1px 2px 3px 4px 5px',
      'border-width:1px!important; border-top-width:2px',
      'border-width:1px; border-top-width:2px!important',
    ];
    for (const declaration of declarations) {
      const sheet = new window.CSSStyleSheet();
      sheet.insertRule(`.target { ${declaration}; }`);
      const style = sheet.cssRules[0].style;
      values.push(['top', 'right', 'bottom', 'left'].flatMap(side => ['width', 'style', 'color'].flatMap(part => {
        const property = `border-${side}-${part}`;
        return [style.getPropertyValue(property), style.getPropertyPriority(property)];
      })));
    }
    return values;
  });
});

test('CSS-wide border keywords propagate to every affected longhand', () => {
  compare(window => {
    const values = [];
    for (const property of ['border', 'border-top', 'border-width', 'border-style', 'border-color']) {
      for (const keyword of ['inherit', 'initial', 'unset', 'revert', 'revert-layer']) {
        const sheet = new window.CSSStyleSheet();
        sheet.insertRule(`.target { border:1px solid red; ${property}:${keyword}!important; }`);
        const style = sheet.cssRules[0].style;
        values.push(['top', 'right', 'bottom', 'left'].flatMap(side => ['width', 'style', 'color'].flatMap(part => {
          const name = `border-${side}-${part}`;
          return [style.getPropertyValue(name), style.getPropertyPriority(name)];
        })));
      }
    }
    return values;
  });
});

test('inline sizing comments normalize without joining separate CSS tokens', () => {
  compare(window => {
    const style = window.document.createElement('div').style;
    const values = [];
    for (const value of ['10px /*hi*/', '10/**/px', '1/**/0px', 'auto/*c*/', '10px/*', 'var(--x,"/* not comment */")', 'var(--x, "a\\"/* literal */")']) {
      style.width = '20px';
      style.width = value;
      values.push(style.width);
      style.setProperty('width', '20px');
      style.setProperty('width', value);
      values.push(style.getPropertyValue('width'));
    }
    style.setProperty('--custom', '1 /*preserve*/ 2');
    values.push(style.getPropertyValue('--custom'));
    return values;
  });
});
