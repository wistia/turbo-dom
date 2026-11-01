import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEnvironment } from '../src/runtime/index.mjs';

const fresh = html => createEnvironment(`<!doctype html><body>${html || ''}`);
const snapshot = select => ({
  value: select.value,
  index: select.selectedIndex,
  selected: [...select.options].map(option => option.selected),
});

function compareSelection(html, mutations) {
  const actual = fresh(html);
  const expected = new JSDOM(html);
  const select = actual.document.querySelector('select');
  const oracle = expected.window.document.querySelector('select');
  assert.deepEqual(snapshot(select), snapshot(oracle));
  for (const mutate of mutations) {
    mutate(select, actual.document);
    mutate(oracle, expected.window.document);
    assert.deepEqual(snapshot(select), snapshot(oracle));
  }
}

test('option text strips and collapses ASCII whitespace while explicit values remain literal', () => {
  const { window, document } = fresh('<form><select name="choice"><option>  Hello\n\t world&nbsp; </option></select></form>');
  const option = document.querySelector('option');
  const oracle = new JSDOM('<option>  Hello\n\t world&nbsp; </option>').window.document.querySelector('option');
  assert.equal(option.text, oracle.text);
  assert.equal(option.value, oracle.value);
  assert.equal(new window.FormData(document.querySelector('form')).get('choice'), oracle.value);
  option.value = '  literal\n value ';
  assert.equal(option.value, '  literal\n value ');
});

test('single selects update selectedness after insertion, removal and explicit clearing', () => {
  compareSelection('<select><option>A</option><option>B</option></select>', [
    select => { select.options[0].selected = false; },
    select => { select.selectedIndex = -1; },
    select => { select.setAttribute('data-unrelated', 'yes'); },
    (select, document) => { const option = document.createElement('option'); option.text = 'C'; select.appendChild(option); },
    select => { select.options[0].remove(); },
    select => { select.value = 'missing'; },
    select => { select.options[0].selected = false; },
    select => { select.options[1].selected = true; },
    select => { select.options[1].remove(); },
    select => { select.innerHTML = '<option>replacement</option><option selected>selected</option>'; },
  ]);
});

test('select defaults, disabled fallbacks, multiple toggles and dirty selection match jsdom', () => {
  compareSelection('<select><optgroup disabled><option>A</option></optgroup><option disabled>B</option><option>C</option><option selected>D</option><option selected>E</option></select>', [
    select => { select.multiple = true; },
    select => { select.options[2].selected = true; },
    select => { select.multiple = false; },
    select => { select.options[2].defaultSelected = true; },
    select => { select.options[2].selected = false; },
    select => { select.options[2].defaultSelected = false; },
    select => { select.options[4].remove(); },
  ]);
  compareSelection('<select size="3"><option disabled>A</option><option>B</option></select>', [
    select => { select.removeAttribute('size'); },
    select => { select.setAttribute('size', '3'); },
  ]);
  compareSelection('<select multiple><option selected>A</option><option selected>B</option><option>C</option></select>', [
    select => { select.value = 'A'; },
    select => { select.selectedIndex = -1; },
  ]);
});

test('FormData uses current selectedness after option and optgroup mutations', () => {
  const { window, document } = fresh('<form><select name="choice"><optgroup><option>A</option></optgroup><option>B</option></select></form>');
  const form = document.querySelector('form');
  const select = document.querySelector('select');
  select.selectedIndex = -1;
  assert.deepEqual([...new window.FormData(form)], []);
  select.querySelector('option').remove();
  assert.deepEqual([...new window.FormData(form)], [['choice', 'B']]);
  select.multiple = true;
  const option = document.createElement('option');
  option.text = '  C \n value ';
  option.selected = true;
  select.querySelector('optgroup').appendChild(option);
  assert.deepEqual([...new window.FormData(form)], [['choice', 'C value'], ['choice', 'B']]);
});

test('FormData fires a synchronous bubbling formdata event with mutable entries', () => {
  const { window, document } = fresh('<form><input name="name" value="original"></form>');
  const form = document.querySelector('form');
  let events = 0;
  form.onformdata = event => {
    assert.ok(event instanceof window.FormDataEvent);
    assert.equal(event.bubbles, true);
    assert.equal(event.cancelable, false);
    event.formData.set('name', 'changed');
    event.formData.append('extra', 'value');
    events++;
  };
  document.addEventListener('formdata', event => assert.equal(event.target, form));
  assert.deepEqual([...new window.FormData(form)], [['name', 'changed'], ['extra', 'value']]);
  assert.equal(events, 1);
  assert.throws(() => new window.FormDataEvent('formdata'), TypeError);
  const data = new window.FormData();
  assert.equal(new window.FormDataEvent('formdata', { formData: data }).formData, data);
});

test('FormData prevents recursive construction and clears the guard for future construction', () => {
  const { window, document } = fresh('<form></form>');
  const form = document.querySelector('form');
  let recursiveError;
  form.onformdata = () => {
    try { new window.FormData(form); } catch (error) { recursiveError = error; }
  };
  assert.deepEqual([...new window.FormData(form)], []);
  assert.equal(recursiveError?.name, 'InvalidStateError');
  form.onformdata = null;
  assert.deepEqual([...new window.FormData(form)], []);
});

test('dirname entries follow successful values and explicit, inherited and auto direction', () => {
  const { window, document } = fresh(`<form dir="rtl">
    <input name="inherited" dirname="inherited.dir" value="abc">
    <input name="explicit" dirname="explicit.dir" dir="ltr" value="abc">
    <input name="auto-rtl" dirname="auto-rtl.dir" dir="auto" value="123 שלום">
    <textarea name="auto-ltr" dirname="auto-ltr.dir" dir="auto">123 hello</textarea>
    <input name="disabled" dirname="disabled.dir" disabled>
    <input name="number" dirname="ignored" type="number" value="1">
    <input name="empty-auto" dirname="empty-auto.dir" dir="auto" value="123">
  </form>`);
  assert.deepEqual([...new window.FormData(document.querySelector('form'))], [
    ['inherited', 'abc'], ['inherited.dir', 'rtl'], ['explicit', 'abc'], ['explicit.dir', 'ltr'],
    ['auto-rtl', '123 שלום'], ['auto-rtl.dir', 'rtl'], ['auto-ltr', '123 hello'], ['auto-ltr.dir', 'ltr'],
    ['number', '1'], ['empty-auto', '123'], ['empty-auto.dir', 'rtl'],
  ]);
});

test('template contents use one inert document per active document across parsing and cloning', () => {
  const { document } = fresh('<template><p id="parsed">text<template><b>nested</b></template></p></template>');
  const parsed = document.querySelector('template');
  const inert = parsed.content.ownerDocument;
  assert.notEqual(inert, document);
  assert.equal(inert.defaultView, null);
  assert.equal(parsed.content.firstElementChild.ownerDocument, inert);
  assert.equal(parsed.content.querySelector('template').content.ownerDocument, inert);
  const created = document.createElement('template');
  assert.equal(created.content.ownerDocument, inert);
  created.innerHTML = '<span>created<template><i>deep</i></template></span>';
  assert.equal(created.content.firstElementChild.ownerDocument, inert);
  assert.equal(created.content.querySelector('template').content.ownerDocument, inert);
  const clone = created.cloneNode(true);
  assert.equal(clone.ownerDocument, document);
  assert.equal(clone.content.ownerDocument, inert);
  assert.notEqual(clone.content, created.content);
  assert.equal(clone.innerHTML, created.innerHTML);
  assert.equal(inert.createElement('template').content.ownerDocument, inert);
});

test('template import and adoption rehome both ordinary nodes and inert nested contents', () => {
  const source = fresh('<template><p data-source="yes"><template><b>nested</b></template></p></template>');
  const target = fresh('<div></div>');
  const template = source.document.querySelector('template');
  const imported = target.document.importNode(template, true);
  const inert = target.document.createElement('template').content.ownerDocument;
  assert.equal(imported.ownerDocument, target.document);
  assert.equal(imported.content.ownerDocument, inert);
  assert.equal(imported.content.firstElementChild.ownerDocument, inert);
  assert.equal(imported.content.querySelector('template').content.ownerDocument, inert);
  assert.equal(imported.content.firstElementChild.getAttribute('data-source'), 'yes');
  assert.equal(template.ownerDocument, source.document);
  target.document.adoptNode(template);
  assert.equal(template.ownerDocument, target.document);
  assert.equal(template.content.ownerDocument, inert);
  assert.equal(template.content.querySelector('template').content.ownerDocument, inert);
  const child = template.content.firstElementChild;
  target.document.body.appendChild(child);
  assert.equal(child.ownerDocument, target.document);
  assert.equal(child.querySelector('template').content.ownerDocument, inert);
});

test('reset keeps detached old template contents backed by their original inert document', () => {
  const env = fresh('<template><p>old</p></template>');
  const template = env.document.querySelector('template');
  const inert = template.content.ownerDocument;
  env.reset('<template><b>new</b></template>');
  assert.equal(template.content.firstElementChild.textContent, 'old');
  const current = env.document.querySelector('template');
  assert.notEqual(current.content.ownerDocument, inert);
  assert.equal(current.content.firstElementChild.textContent, 'new');
});

test('dirname defaults to ltr when no direction is supplied', () => {
  const { window, document } = fresh('<form><input name="plain" dirname="plain.dir" value="text"></form>');
  assert.deepEqual([...new window.FormData(document.querySelector('form'))], [['plain', 'text'], ['plain.dir', 'ltr']]);
});

test('option cloning preserves explicitly changed selectedness independently of attributes', () => {
  const { document } = fresh('<select><option selected>A</option><option>B</option></select>');
  const select = document.querySelector('select');
  select.options[1].selected = true;
  const clone = select.cloneNode(true);
  assert.equal(clone.selectedIndex, 1);
  assert.equal(clone.options[0].defaultSelected, true);
  assert.equal(clone.options[0].selected, false);
  assert.equal(clone.options[1].selected, true);
});
