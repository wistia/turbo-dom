import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../src/runtime/index.mjs';

const fresh = (html) => createEnvironment(`<!doctype html><html><body>${html}</body></html>`);

test('textarea defaultValue reflects child text and ignores a value attribute', () => {
  const { document } = fresh('<textarea value="attribute">Paragraph one.\n\nParagraph two.</textarea>');
  const textarea = document.querySelector('textarea');
  assert.equal(textarea.defaultValue, 'Paragraph one.\n\nParagraph two.');
  assert.equal(textarea.value, textarea.defaultValue);
});

test('setting textarea defaultValue initializes the value without creating a value attribute', () => {
  const { document } = fresh('<textarea></textarea>');
  const textarea = document.querySelector('textarea');
  textarea.defaultValue = 'Paragraph one.\n\nParagraph two.';
  assert.equal(textarea.textContent, 'Paragraph one.\n\nParagraph two.');
  assert.equal(textarea.value, textarea.defaultValue);
  assert.equal(textarea.hasAttribute('value'), false);
});

test('changing textarea defaultValue preserves an edited value until form reset', () => {
  const { document } = fresh('<form><textarea>Original</textarea></form>');
  const textarea = document.querySelector('textarea');
  textarea.value = 'Edited';
  textarea.defaultValue = 'New default';
  assert.equal(textarea.value, 'Edited');
  assert.equal(textarea.defaultValue, 'New default');
  document.querySelector('form').reset();
  assert.equal(textarea.value, 'New default');
});

test('textarea defaultValue converts assigned values to strings', () => {
  const { document } = fresh('<textarea></textarea>');
  const textarea = document.querySelector('textarea');
  for (const value of [null, undefined, 123]) {
    textarea.defaultValue = value;
    assert.equal(textarea.value, String(value));
    assert.equal(textarea.defaultValue, String(value));
  }
});

for (const tag of ['span', 'svg']) {
  test(`clicking a ${tag} inside a submit button submits its form once`, () => {
    const { document } = fresh(`<form><button type="submit"><${tag}>Apply</${tag}></button></form>`);
    let submits = 0;
    document.querySelector('form').addEventListener('submit', (event) => { submits++; event.preventDefault(); });
    document.querySelector(tag).click();
    assert.equal(submits, 1);
  });
}

test('preventing a nested click cancels form submission', () => {
  const { document } = fresh('<form><button><span>Apply</span></button></form>');
  let submits = 0;
  const span = document.querySelector('span');
  document.querySelector('form').addEventListener('submit', () => { submits++; });
  span.addEventListener('click', (event) => event.preventDefault());
  span.click();
  assert.equal(submits, 0);
});

test('non-bubbling clicks activate only their direct target', () => {
  const { document, window } = fresh('<form><button><span>Apply</span></button></form>');
  let submits = 0;
  document.querySelector('form').addEventListener('submit', (event) => { submits++; event.preventDefault(); });
  document.querySelector('span').dispatchEvent(new window.MouseEvent('click', { cancelable: true }));
  assert.equal(submits, 0);
  document.querySelector('button').dispatchEvent(new window.MouseEvent('click', { cancelable: true }));
  assert.equal(submits, 1);
});

for (const name of ['Event', 'CustomEvent']) {
  test(`a generic ${name} click does not activate an ancestor submit button`, () => {
    const { document, window } = fresh('<form><button><span>Apply</span></button></form>');
    let submits = 0;
    document.querySelector('form').addEventListener('submit', (event) => { submits++; event.preventDefault(); });
    document.querySelector('span').dispatchEvent(new window[name]('click', { bubbles: true, cancelable: true }));
    assert.equal(submits, 0);
  });
}

test('a pointer click activates an ancestor submit button', () => {
  const { document, window } = fresh('<form><button><span>Apply</span></button></form>');
  let submits = 0;
  document.querySelector('form').addEventListener('submit', (event) => { submits++; event.preventDefault(); });
  document.querySelector('span').dispatchEvent(new window.PointerEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(submits, 1);
});

test('nested clicks do not submit disabled or non-submit buttons', () => {
  const { document } = fresh('<form><button disabled><span id="disabled">Apply</span></button><button type="button"><span id="plain">Other</span></button></form>');
  let submits = 0;
  document.querySelector('form').addEventListener('submit', () => { submits++; });
  document.getElementById('disabled').click();
  document.getElementById('plain').click();
  assert.equal(submits, 0);
});

test('disabled inputs do not activate a submit or checkbox default action', () => {
  const { document } = fresh('<form><input type="submit" disabled><input type="checkbox" disabled></form>');
  let submits = 0;
  document.querySelector('form').addEventListener('submit', () => { submits++; });
  document.querySelector('input[type=submit]').click();
  const checkbox = document.querySelector('input[type=checkbox]');
  checkbox.click();
  assert.equal(submits, 0);
  assert.equal(checkbox.checked, false);
});

test('nested label text activates its control without forwarding clicks from an interactive descendant', () => {
  const { document } = fresh('<label><span id="text">Agree</span><input type="checkbox"><a href="#next">Details</a></label>');
  const input = document.querySelector('input');
  document.getElementById('text').click();
  assert.equal(input.checked, true);
  document.querySelector('a').click();
  assert.equal(input.checked, true);
});
