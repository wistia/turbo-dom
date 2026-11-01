import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../src/runtime/index.mjs';

const fresh = (html = '') => createEnvironment(`<!doctype html><html><body>${html}</body></html>`);
const entries = (env, form = env.document.querySelector('form'), submitter) => [...new env.window.FormData(form, submitter)];

test('FormData accepts an omitted form and rejects invalid constructor arguments', () => {
  const env = fresh('<form></form><div></div>');
  assert.deepEqual([...new env.window.FormData()], []);
  assert.deepEqual([...new env.window.FormData(undefined, null)], []);
  assert.deepEqual(entries(env), []);
  assert.throws(() => new env.window.FormData(null), TypeError);
  assert.throws(() => new env.window.FormData({}), TypeError);
  assert.throws(() => new env.window.FormData(env.document.querySelector('div')), TypeError);
  assert.throws(() => new env.window.FormData(env.document.createElementNS('http://www.w3.org/2000/svg', 'form')), TypeError);
  assert.throws(() => new env.window.FormData(undefined, {}), TypeError);
  assert.throws(() => new env.window.FormData(undefined, env.document.createElementNS('http://www.w3.org/2000/svg', 'button')), TypeError);
});

test('FormData serializes named input and textarea values in tree order with duplicate names', () => {
  const env = fresh(`<form>
    <input name="category1" type="hidden" value="business--marketing">
    <input name="duplicate" value="first"><textarea name="notes">Paragraph one.\nParagraph two.</textarea>
    <input name="duplicate" value="second" readonly><input value="unnamed"><input name="" value="empty-name">
    <button name="ignored" value="button">Save</button><input type="reset" name="reset" value="reset">
    <input type="button" name="plain" value="plain"><output name="output">ignored</output>
  </form>`);
  const foreign = env.document.createElementNS('http://www.w3.org/2000/svg', 'input');
  foreign.setAttribute('name', 'foreign');
  env.document.querySelector('form').appendChild(foreign);
  assert.deepEqual(entries(env), [['category1', 'business--marketing'], ['duplicate', 'first'], ['notes', 'Paragraph one.\nParagraph two.'], ['duplicate', 'second']]);
});

test('FormData captures current control values without making prior entries live', () => {
  const env = fresh('<form><input name="title" value="original"><textarea name="notes">initial</textarea></form>');
  const form = env.document.querySelector('form');
  const first = new env.window.FormData(form);
  env.document.querySelector('input').value = 'edited';
  env.document.querySelector('textarea').value = 'changed';
  assert.deepEqual(entries(env), [['title', 'edited'], ['notes', 'changed']]);
  assert.deepEqual([...first], [['title', 'original'], ['notes', 'initial']]);
});

test('FormData includes checked checkboxes and radios, with the default on value', () => {
  const env = fresh(`<form>
    <input type="checkbox" name="check" checked><input type="checkbox" name="check" value="explicit" checked>
    <input type="checkbox" name="empty" value="" checked><input type="checkbox" name="unchecked" value="ignored">
    <input type="radio" name="radio" value="a"><input type="radio" name="radio" value="b" checked>
    <input id="custom" type="checkbox" name="custom" checked>
  </form>`);
  env.document.getElementById('custom').value = 'property';
  assert.deepEqual(entries(env), [['check', 'on'], ['check', 'explicit'], ['empty', ''], ['radio', 'b'], ['custom', 'property']]);
});

test('FormData serializes selected multiple options and excludes disabled options or optgroups', () => {
  const env = fresh(`<form>
    <select name="categories" multiple><option value="a" selected>A</option><option value="b">B</option>
      <option value="disabled" selected disabled>Disabled</option><optgroup disabled><option value="group" selected>Group</option></optgroup>
      <option selected>Text value</option></select>
    <select name="disabled-select" disabled><option value="ignored" selected>Ignored</option></select>
    <select name="disabled-selection"><option selected disabled>Ignored</option><option>Other</option></select>
  </form>`);
  assert.deepEqual(entries(env), [['categories', 'a'], ['categories', 'Text value']]);
});

test('FormData uses the ordinary single-select default while preserving explicit empty selection', () => {
  const env = fresh(`<form>
    <select name="default"><option disabled>A</option><option value="b">B</option></select>
    <select name="list" size="2"><option>A</option><option>B</option></select>
    <select id="cleared" name="cleared"><option>A</option><option>B</option></select>
  </form>`);
  env.document.getElementById('cleared').selectedIndex = -1;
  assert.deepEqual(entries(env), [['default', 'b']]);
});

test('FormData omits disabled controls and applies the first-legend exception to disabled fieldsets', () => {
  const env = fresh(`<form>
    <input disabled name="disabled" value="ignored">
    <fieldset disabled><div>Before legend</div><legend>First <input name="legend" value="allowed"><input disabled name="own-disabled" value="ignored"></legend>
      <legend>Second <input name="second" value="ignored"></legend><input name="blocked" value="ignored">
      <fieldset><legend>Nested <input name="nested" value="ignored"></legend></fieldset>
    </fieldset>
    <fieldset disabled><legend>Outer <fieldset disabled><legend><input name="both-legends" value="allowed"></legend><input name="inner-blocked" value="ignored"></fieldset></legend></fieldset>
    <fieldset disabled><input name="no-legend" value="ignored"></fieldset>
    <input name="outside" value="allowed">
  </form>`);
  assert.deepEqual(entries(env), [['legend', 'allowed'], ['both-legends', 'allowed'], ['outside', 'allowed']]);
});

test('FormData omits controls inside datalists', () => {
  const env = fresh('<form><datalist></datalist><input name="visible" value="yes"></form>');
  const input = env.document.createElement('input');
  input.name = 'suggestion';
  input.value = 'not successful';
  env.document.querySelector('datalist').appendChild(input);
  assert.deepEqual(entries(env), [['visible', 'yes']]);
});

test('FormData uses form ownership including external form attributes in document order', () => {
  const env = fresh(`<input form="main" name="before" value="a"><form id="main">
    <input name="inside" value="b"><input form="other" name="reassigned" value="ignored"><input form="" name="unowned" value="ignored">
  </form><input form="main" name="after" value="c"><form id="other"><input name="other" value="ignored"></form>`);
  assert.deepEqual(entries(env, env.document.getElementById('main')), [['before', 'a'], ['inside', 'b'], ['after', 'c']]);
});

test('FormData works with detached forms and excludes nested forms owned by another form', () => {
  const env = fresh();
  const form = env.document.createElement('form');
  form.id = 'detached';
  form.innerHTML = '<input name="own" value="yes"><input form="detached" name="explicit" value="yes">';
  const nested = env.document.createElement('form');
  nested.innerHTML = '<input name="nested" value="ignored">';
  form.appendChild(nested);
  assert.deepEqual(entries(env, form), [['own', 'yes'], ['explicit', 'yes']]);
});

test('FormData resolves form attributes within a detached fragment and ignores missing or non-form IDs', () => {
  const env = fresh();
  const fragment = env.document.createDocumentFragment();
  const container = env.document.createElement('div');
  container.innerHTML = '<div id="not-form"></div><form id="main"><input name="own" value="a"></form><input form="main" name="external" value="b"><input form="not-form" name="non-form" value="ignored"><input form="missing" name="missing" value="ignored">';
  fragment.appendChild(container);
  assert.deepEqual(entries(env, container.querySelector('form')), [['own', 'a'], ['external', 'b']]);
});

test('FormData keeps populated file-input File identities and creates an empty File for an empty input', () => {
  const env = fresh('<form><input id="files" name="uploads" type="file" multiple><input name="empty" type="file"></form>');
  const first = new env.window.File(['one'], 'one.txt', { type: 'text/plain' });
  const second = new env.window.File(['two'], 'two.txt', { type: 'text/plain' });
  Object.defineProperty(env.document.getElementById('files'), 'files', { value: [first, second] });
  Object.defineProperty(env.document.querySelector('input[name=empty]'), 'files', { value: [] });
  const data = new env.window.FormData(env.document.querySelector('form'));
  assert.equal(data.getAll('uploads')[0], first);
  assert.equal(data.getAll('uploads')[1], second);
  const empty = data.get('empty');
  assert.ok(empty instanceof env.window.File);
  assert.equal(empty.name, '');
  assert.equal(empty.size, 0);
  assert.equal(empty.type, 'application/octet-stream');
});

test('FormData adds only the provided successful submitter at its tree position', () => {
  const env = fresh('<form id="main"><input name="first" value="a"><button id="save" name="action" value="save">Save</button><input id="publish" type="submit" name="action" value="publish"><button id="disabled" name="action" value="disabled" disabled>Disabled</button><input name="last" value="z"></form>');
  const form = env.document.getElementById('main');
  assert.deepEqual(entries(env, form, env.document.getElementById('save')), [['first', 'a'], ['action', 'save'], ['last', 'z']]);
  assert.deepEqual(entries(env, form, env.document.getElementById('publish')), [['first', 'a'], ['action', 'publish'], ['last', 'z']]);
  assert.deepEqual(entries(env, form, env.document.getElementById('disabled')), [['first', 'a'], ['last', 'z']]);
  env.document.getElementById('save').value = 'changed';
  env.document.getElementById('publish').value = '';
  assert.deepEqual(entries(env, form, env.document.getElementById('save')), [['first', 'a'], ['action', 'changed'], ['last', 'z']]);
  assert.deepEqual(entries(env, form, env.document.getElementById('publish')), [['first', 'a'], ['action', ''], ['last', 'z']]);
});

test('FormData supports externally associated submitters and validates submitter type and ownership', () => {
  const env = fresh('<form id="main"><input id="text" name="text" value="value"><button id="plain" type="button">Plain</button></form><button id="external" form="main" name="submit" value="yes">Submit</button><button id="unowned">Other</button>');
  const form = env.document.getElementById('main');
  assert.deepEqual(entries(env, form, env.document.getElementById('external')), [['text', 'value'], ['submit', 'yes']]);
  assert.throws(() => new env.window.FormData(form, env.document.getElementById('text')), TypeError);
  assert.throws(() => new env.window.FormData(form, env.document.getElementById('plain')), TypeError);
  assert.throws(() => new env.window.FormData(form, env.document.getElementById('unowned')), { name: 'NotFoundError' });
  assert.deepEqual([...new env.window.FormData(undefined, env.document.getElementById('plain'))], []);
  env.document.getElementById('plain').type = 'reset';
  assert.throws(() => new env.window.FormData(form, env.document.getElementById('plain')), TypeError);
});

test('FormData reports an invalid submitter owner even without a host DOMException constructor', () => {
  const env = fresh('<form></form><button></button>');
  const original = globalThis.DOMException;
  try {
    globalThis.DOMException = undefined;
    assert.throws(() => new env.window.FormData(env.document.querySelector('form'), env.document.querySelector('button')), { name: 'NotFoundError' });
  } finally {
    globalThis.DOMException = original;
  }
});

test('FormData uses zero coordinates for named and unnamed image submitters', () => {
  const env = fresh('<form><input id="named" type="image" name="where"><input id="unnamed" type="image"></form>');
  assert.deepEqual(entries(env, undefined, env.document.getElementById('named')), [['where.x', '0'], ['where.y', '0']]);
  assert.deepEqual(entries(env, undefined, env.document.getElementById('unnamed')), [['x', '0'], ['y', '0']]);
});

test('FormData append and set continue preserving existing File and Blob identities', () => {
  const env = fresh('<form><input name="title" value="existing"></form>');
  const file = new env.window.File(['hello'], 'hello.txt');
  const blob = new env.window.Blob(['world']);
  const data = new env.window.FormData(env.document.querySelector('form'));
  data.append('file', file);
  data.set('blob', blob);
  assert.equal(data.get('file'), file);
  assert.equal(data.get('blob'), blob);
  assert.equal(data.get('title'), 'existing');
});
