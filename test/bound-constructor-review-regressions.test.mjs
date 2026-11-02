import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEnvironment } from '../src/runtime/index.mjs';
import { DocumentFragment, Range, ShadowRoot } from '../src/runtime/dom.mjs';

function compare(scenario) {
  const oracle = new JSDOM('<!doctype html><body><div></div></body>');
  try {
    const actual = createEnvironment('<!doctype html><body><div></div></body>');
    assert.deepEqual(scenario(actual.window), scenario(oracle.window));
  } finally {
    oracle.window.close();
  }
}

test('fragments and ranges retain window-bound constructors through reconstruction and cloning', () => {
  compare(window => {
    const { document } = window;
    for (const fragment of [new window.DocumentFragment(), document.createDocumentFragment(), document.createDocumentFragment().cloneNode()]) {
      assert.equal(fragment.constructor, window.DocumentFragment);
      assert.equal(Object.getPrototypeOf(fragment), window.DocumentFragment.prototype);
      const reconstructed = new fragment.constructor();
      const element = document.createElement('span');
      reconstructed.appendChild(element);
      assert.equal(reconstructed.ownerDocument, document);
      assert.equal(element.ownerDocument, document);
      assert.ok(reconstructed instanceof window.DocumentFragment);
    }
    for (const range of [new window.Range(), document.createRange(), document.createRange().cloneRange()]) {
      assert.equal(range.constructor, window.Range);
      assert.equal(Object.getPrototypeOf(range), window.Range.prototype);
      const reconstructed = new range.constructor();
      assert.equal(reconstructed.startContainer, document);
      assert.equal(reconstructed.endContainer, document);
      assert.ok(reconstructed instanceof window.Range);
    }
    return true;
  });
});

test('window-bound prototypes preserve subclasses and internal implementation inheritance', () => {
  const { window, document } = createEnvironment('<body><div></div></body>');
  class DerivedFragment extends window.DocumentFragment {}
  class DerivedRange extends window.Range {}
  const fragment = new DerivedFragment();
  const range = new DerivedRange();
  assert.equal(fragment.constructor, DerivedFragment);
  assert.equal(range.constructor, DerivedRange);
  assert.equal(fragment.ownerDocument, document);
  assert.equal(range.startContainer, document);
  assert.ok(fragment instanceof DerivedFragment);
  assert.ok(fragment instanceof window.DocumentFragment);
  assert.ok(fragment instanceof DocumentFragment);
  assert.ok(range instanceof DerivedRange);
  assert.ok(range instanceof window.Range);
  assert.ok(range instanceof Range);
  const shadow = document.querySelector('div').attachShadow({ mode: 'open' });
  assert.ok(shadow instanceof ShadowRoot);
  assert.ok(shadow instanceof window.DocumentFragment);
  assert.equal(shadow instanceof DerivedFragment, false);
  assert.equal(document.createDocumentFragment() instanceof DerivedFragment, false);
  assert.equal(shadow.constructor, ShadowRoot);
  assert.equal(shadow.ownerDocument, document);
});

test('separate environments have isolated fragment and range constructors', () => {
  const first = createEnvironment();
  const second = createEnvironment();
  for (const name of ['DocumentFragment', 'Range']) {
    const First = first.window[name], Second = second.window[name];
    assert.notEqual(First, Second);
    assert.notEqual(First.prototype, Second.prototype);
    const a = new First(), b = new Second();
    assert.equal(a.constructor, First);
    assert.equal(b.constructor, Second);
    assert.ok(a instanceof First);
    assert.ok(b instanceof Second);
    assert.equal(a instanceof Second, false);
    assert.equal(b instanceof First, false);
    assert.equal(name === 'Range' ? a.startContainer : a.ownerDocument, first.document);
    assert.equal(name === 'Range' ? b.startContainer : b.ownerDocument, second.document);
  }
});

test('reset refreshes bound constructors without mutating old prototype identity', () => {
  const env = createEnvironment();
  const OldFragment = env.window.DocumentFragment, OldRange = env.window.Range;
  const oldFragment = new OldFragment(), oldRange = new OldRange();
  env.reset('<body>after reset</body>');
  assert.notEqual(env.window.DocumentFragment, OldFragment);
  assert.notEqual(env.window.Range, OldRange);
  assert.equal(oldFragment.constructor, OldFragment);
  assert.equal(oldRange.constructor, OldRange);
  assert.equal(env.document.createDocumentFragment().constructor, env.window.DocumentFragment);
  assert.equal(env.document.createRange().constructor, env.window.Range);
  assert.equal(new OldFragment().ownerDocument, env.document);
  assert.equal(new OldRange().startContainer, env.document);
});


test('template contents retain the creating window realm with an inert owner document', () => {
  compare(window => {
    const { document } = window;
    const template = document.createElement('template');
    template.innerHTML = '<span></span>';
    for (const fragment of [template.content, template.cloneNode(true).content, template.content.cloneNode(true)]) {
      assert.ok(fragment instanceof window.DocumentFragment);
      assert.equal(fragment.constructor, window.DocumentFragment);
      assert.notEqual(fragment.ownerDocument, document);
      assert.equal(fragment.ownerDocument.defaultView, null);
      const reconstructed = new fragment.constructor();
      assert.equal(reconstructed.ownerDocument, document);
    }
    return true;
  });
});

test('shadow fragment membership follows its original realm through adoption and reset', () => {
  const first = createEnvironment('<body><div></div></body>');
  const second = createEnvironment();
  const OriginalFragment = first.window.DocumentFragment;
  const host = first.document.querySelector('div');
  const shadow = host.attachShadow({ mode: 'open' });
  assert.ok(shadow instanceof OriginalFragment);
  assert.equal(shadow instanceof second.window.DocumentFragment, false);
  second.document.adoptNode(host);
  assert.ok(shadow instanceof OriginalFragment);
  assert.equal(shadow instanceof second.window.DocumentFragment, false);
  first.reset();
  assert.ok(shadow instanceof OriginalFragment);
  assert.equal(shadow instanceof first.window.DocumentFragment, false);
});


test('declarative shadow roots acquire their creating window fragment realm lazily', () => {
  const env = createEnvironment('<body><div><template shadowrootmode="open">hello</template></div>');
  const shadow = env.document.querySelector('div').shadowRoot;
  const Fragment = env.window.DocumentFragment;
  assert.ok(shadow instanceof Fragment);
  assert.equal(shadow instanceof createEnvironment().window.DocumentFragment, false);
  env.reset();
  assert.ok(shadow instanceof Fragment);
  assert.equal(shadow instanceof env.window.DocumentFragment, false);
  assert.ok(env.document.querySelector('div').shadowRoot instanceof env.window.DocumentFragment);
});


test('declarative shadow roots preserve their realm when first checked after reset', () => {
  const env = createEnvironment('<body><div><template shadowrootmode="open">hello</template></div>');
  const shadow = env.document.querySelector('div').shadowRoot;
  const OriginalFragment = env.window.DocumentFragment;
  env.reset();
  assert.ok(shadow instanceof OriginalFragment);
  assert.equal(shadow instanceof env.window.DocumentFragment, false);
  assert.ok(env.document.querySelector('div').shadowRoot instanceof env.window.DocumentFragment);
});

test('saved fragment constructors keep their realm when invoked after reset', () => {
  const env = createEnvironment();
  const OriginalFragment = env.window.DocumentFragment;
  class OriginalSubclass extends OriginalFragment {}
  env.reset();
  for (const fragment of [new OriginalFragment(), new OriginalSubclass()]) {
    assert.ok(fragment instanceof OriginalFragment);
    assert.equal(fragment instanceof env.window.DocumentFragment, false);
    assert.equal(fragment.ownerDocument, env.document);
  }
  const current = new env.window.DocumentFragment();
  assert.equal(current instanceof OriginalFragment, false);
});
