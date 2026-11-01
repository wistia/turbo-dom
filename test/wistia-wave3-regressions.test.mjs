import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { createEnvironment } from '../src/runtime/index.mjs';

const userEvent = createRequire(import.meta.url)('@testing-library/user-event').default;
const pair = html => [createEnvironment(html).window, new JSDOM(html).window];

test('canceled native activation cannot be re-enabled by overriding defaultPrevented', () => {
  for (const window of pair('<label><input type="checkbox"><span>Choice</span></label>')) {
    const { document } = window;
    for (const target of [document.querySelector('span'), document.querySelector('input')]) {
      const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      event.preventDefault();
      Object.defineProperty(event, 'defaultPrevented', { get: () => false });
      assert.equal(target.dispatchEvent(event), false);
      assert.equal(event.defaultPrevented, false);
      assert.equal(event.returnValue, false);
      assert.equal(document.querySelector('input').checked, false);
    }
  }
});

test('user-event activates an externally labeled checkbox exactly once', async () => {
  const { document } = createEnvironment('<input id="choice" type="checkbox"><label for="choice"><span>Choice</span></label>');
  const input = document.querySelector('input');
  const changes = [];
  input.addEventListener('change', () => changes.push(input.checked));
  const user = userEvent.setup({ document });
  await user.click(document.querySelector('span'));
  assert.equal(input.checked, true);
  assert.deepEqual(changes, [true]);
  await user.click(document.querySelector('span'));
  assert.equal(input.checked, false);
  assert.deepEqual(changes, [true, false]);
});

test('external reset controls use the form owner and reset associated controls in tree order', () => {
  for (const window of pair('<input form="f" value="original"><form id="f"><input form="missing"></form><button form="f" type="reset">Cancel</button><select form="f"><option>A</option><option>B</option></select>')) {
    const { document } = window;
    const form = document.querySelector('form');
    const input = document.querySelector('input');
    const select = document.querySelector('select');
    const button = document.querySelector('button');
    assert.equal(button.form, form);
    assert.equal(document.querySelector('form input').form, null);
    assert.deepEqual(Array.from(form.elements, node => node.localName), ['input', 'button', 'select']);
    input.value = 'changed';
    select.selectedIndex = 1;
    let resets = 0;
    form.addEventListener('reset', () => resets++);
    button.click();
    assert.equal(resets, 1);
    assert.equal(input.value, 'original');
    assert.equal(select.selectedIndex, 0);
  }
});

test('reset activation respects canceled clicks, canceled resets and disabled controls', () => {
  for (const window of pair('<form id="f"><input value="original"><button type="reset">Reset</button></form>')) {
    const { document } = window;
    const input = document.querySelector('input');
    const button = document.querySelector('button');
    const form = document.querySelector('form');
    input.value = 'changed';
    const cancel = event => event.preventDefault();
    button.addEventListener('click', cancel);
    button.click();
    assert.equal(input.value, 'changed');
    button.removeEventListener('click', cancel);
    form.addEventListener('reset', cancel);
    button.click();
    assert.equal(input.value, 'changed');
    form.removeEventListener('reset', cancel);
    button.disabled = true;
    button.click();
    assert.equal(input.value, 'changed');
    button.disabled = false;
    button.click();
    assert.equal(input.value, 'original');
  }
});

test('external input reset and submit controls activate their explicit form', () => {
  for (const window of pair('<form id="f"><input value="original"></form><input form="f" type="reset"><button form="f">Submit</button>')) {
    const { document } = window;
    const input = document.querySelector('form input');
    input.value = 'changed';
    document.querySelector('input[type="reset"]').click();
    assert.equal(input.value, 'original');
    let submits = 0;
    document.querySelector('form').addEventListener('submit', event => { submits++; event.preventDefault(); });
    document.querySelector('button').click();
    assert.equal(submits, 1);
  }
});

test('media ready-state and network constants are available on constructors and scoped prototypes', () => {
  const [actual, expected] = pair('');
  for (const name of ['HTMLMediaElement', 'HTMLAudioElement', 'HTMLVideoElement']) {
    for (const constant of ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE', 'HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA']) {
      assert.equal(actual[name][constant], expected[name][constant]);
      assert.equal(actual[name].prototype[constant], expected[name].prototype[constant]);
    }
  }
  const video = actual.document.createElement('video');
  assert.equal(video.HAVE_CURRENT_DATA, 2);
  assert.equal(video.HAVE_ENOUGH_DATA, 4);
  assert.equal(actual.document.createElement('div').HAVE_CURRENT_DATA, undefined);
  assert.throws(() => { video.HAVE_CURRENT_DATA = 99; }, TypeError);
  assert.throws(() => { actual.HTMLMediaElement.HAVE_ENOUGH_DATA = 99; }, TypeError);
});

test('background image shorthands resolve inline and in the computed author cascade', () => {
  const image = 'linear-gradient(90deg, red 0%, green 50%, blue 100%)';
  for (const window of pair(`<style>#gradient { background: ${image} !important }</style><div id="gradient" style="background-image: none"></div>`)) {
    const element = window.document.querySelector('div');
    assert.equal(window.getComputedStyle(element).backgroundImage, image);
    element.style.cssText = `background: ${image}`;
    assert.equal(element.style.backgroundImage, image);
    element.style.background = 'none';
    assert.equal(element.style.backgroundImage, 'none');
  }
});

test('image shorthand recognition preserves URL contents and rejects unsupported mixed backgrounds', () => {
  const { document, window } = createEnvironment();
  const element = document.createElement('div');
  document.body.appendChild(element);
  for (const image of ['url("data:image/svg+xml,a,b")', 'url(a\\)b)', 'image-set(url(a) 1x, url(b) 2x)', 'url(a), none', "url('a,(b)')", 'none']) {
    element.style.cssText = `background: ${image}`;
    assert.equal(element.style.backgroundImage, image);
    assert.equal(window.getComputedStyle(element).backgroundImage, image);
  }
  for (const value of ['', 'url(a', 'url("a)', 'url(a),', 'url(a) no-repeat', 'var(--image)']) {
    element.style.cssText = `background: ${value}`;
    assert.equal(element.style.backgroundImage, '');
  }
});

test('recognized background shorthands reset prior image/color longhands', () => {
  for (const window of pair('<div></div>')) {
    const element = window.document.querySelector('div');
    for (const [style, image, color] of [
      ['background: url(a); background: red', 'none', 'rgb(255, 0, 0)'],
      ['background: red; background: url(a)', 'url("a")', 'rgba(0, 0, 0, 0)'],
    ]) {
      element.style.cssText = style;
      const computed = window.getComputedStyle(element);
      assert.equal(computed.backgroundImage.replaceAll('"', ''), image.replaceAll('"', ''));
      assert.equal(computed.backgroundColor, color);
    }
    element.style.cssText = 'background: red';
    assert.equal(element.style.backgroundImage, 'none');
  }
});

test('normal background shorthand cannot replace an important image longhand in the author cascade', () => {
  const { document, window } = createEnvironment('<div style="background-image: url(a) !important; background: red"></div>');
  const computed = window.getComputedStyle(document.querySelector('div'));
  assert.equal(computed.backgroundImage, 'url(a)');
  assert.equal(computed.backgroundColor, 'rgb(255, 0, 0)');
});
