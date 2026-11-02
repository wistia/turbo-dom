import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEnvironment } from '../src/runtime/index.mjs';

function compare(scenario) {
  const oracle = new JSDOM('<!doctype html><body></body>');
  try {
    assert.deepEqual(scenario(createEnvironment('<!doctype html><body></body>').window), scenario(oracle.window));
  } finally { oracle.window.close(); }
}

function setup(window, html = '<a></a><b></b><i></i>') {
  const root = window.document.createElement('div');
  root.innerHTML = html;
  const iterator = window.document.createNodeIterator(root, window.NodeFilter.SHOW_ELEMENT);
  iterator.nextNode(); iterator.nextNode(); iterator.nextNode();
  return { root, iterator };
}

test('iterator removal recovery observes newly inserted successors', () => {
  compare(window => {
    const { root, iterator } = setup(window);
    root.querySelector('b').remove();
    root.insertBefore(window.document.createElement('em'), root.querySelector('i'));
    return [iterator.referenceNode.nodeName, iterator.pointerBeforeReferenceNode, iterator.nextNode().nodeName];
  });
});

test('iterator removal recovery follows surviving predecessors after adjacent removals', () => {
  compare(window => {
    const { root, iterator } = setup(window, '<a></a><b></b><i></i><u></u>');
    iterator.nextNode();
    root.querySelector('i').remove(); root.querySelector('b').remove();
    return [iterator.referenceNode.nodeName, iterator.previousNode().nodeName];
  });
});

test('iterator adjusts reference before removal in both cursor directions', () => {
  compare(window => {
    const result = [];
    for (const html of ['<a></a><b></b><i></i>', '<a></a><b></b>']) {
      const { root, iterator } = setup(window, html);
      iterator.previousNode();
      root.querySelector('b').remove();
      result.push(iterator.referenceNode.nodeName, iterator.pointerBeforeReferenceNode, iterator.nextNode()?.nodeName ?? null);
    }
    return result;
  });
});

test('iterator skips removed ancestor subtrees and keeps its root when detached', () => {
  compare(window => {
    const { root, iterator } = setup(window, '<a></a><section><b></b></section><i></i>');
    iterator.nextNode();
    root.querySelector('section').remove();
    const result = [iterator.nextNode().nodeName];
    window.document.body.append(root);
    root.remove();
    result.push(iterator.previousNode().nodeName);
    return result;
  });
});

test('bulk child replacements adjust iterators without following detached siblings', () => {
  compare(window => {
    const result = [];
    for (const replace of [root => { root.innerHTML = '<em></em>'; }, root => { root.textContent = 'text'; }, root => root.replaceChildren('text')]) {
      const { root, iterator } = setup(window);
      iterator.previousNode();
      replace(root);
      result.push(iterator.referenceNode.nodeName, iterator.pointerBeforeReferenceNode, iterator.nextNode()?.nodeName ?? null);
    }
    return result;
  });
});

test('normalization adjusts iterator references before removing merged and empty text', () => {
  compare(window => {
    const root = window.document.createElement('div');
    root.append('a', 'b', '');
    const iterator = window.document.createNodeIterator(root, window.NodeFilter.SHOW_ALL);
    iterator.nextNode(); iterator.nextNode(); iterator.nextNode();
    root.normalize();
    return [iterator.referenceNode.nodeName, iterator.referenceNode.textContent, iterator.pointerBeforeReferenceNode, iterator.nextNode()];
  });
});

test('iterator registrations follow their root across document adoption', () => {
  const { window } = createEnvironment('<!doctype html><body></body>');
  const { root, iterator } = setup(window);
  const other = window.document.implementation.createHTMLDocument('other');
  other.adoptNode(root);
  root.querySelector('b').remove();
  assert.deepEqual([iterator.referenceNode.nodeName, iterator.nextNode().nodeName], ['A', 'I']);
});

test('node type masks filter document, doctype, fragment and text independently', () => {
  compare(window => {
    const result = [];
    for (const mask of [window.NodeFilter.SHOW_ELEMENT, window.NodeFilter.SHOW_DOCUMENT, window.NodeFilter.SHOW_DOCUMENT_TYPE, window.NodeFilter.SHOW_ALL]) {
      const iterator = window.document.createNodeIterator(window.document, mask);
      const nodes = [];
      for (let node; (node = iterator.nextNode());) nodes.push(node.nodeName);
      result.push(nodes);
    }
    const fragment = window.document.createDocumentFragment(); fragment.append('text');
    for (const mask of [window.NodeFilter.SHOW_ELEMENT, window.NodeFilter.SHOW_TEXT, window.NodeFilter.SHOW_DOCUMENT_FRAGMENT]) {
      const iterator = window.document.createNodeIterator(fragment, mask);
      const nodes = [];
      for (let node; (node = iterator.nextNode());) nodes.push(node.nodeName);
      result.push(nodes);
    }
    return result;
  });
});

test('setRangeText rejects reversed converted offsets before clamping', () => {
  compare(window => {
    const result = [];
    for (const [start, end] of [[100, 50], [3, 2], [-1, 50], [50, 100], [3, 3]]) {
      const input = window.document.createElement('textarea'); input.value = 'abc';
      let error = null;
      try { input.setRangeText('x', start, end); } catch (caught) { error = caught.name; }
      result.push([input.value, error]);
    }
    return result;
  });
});
