import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../src/runtime/index.mjs';

function fixture(html = '') {
  const environment = createEnvironment(`<!doctype html><body>${html}</body>`);
  const { window, document } = environment;
  class ViewportElement extends window.HTMLElement {}
  window.customElements.define('x-viewport', ViewportElement);
  const element = document.createElement('x-viewport');
  document.body.appendChild(element);
  return { ...environment, element, ViewportElement };
}

test('custom-element computed lengths resolve scalar viewport units while retaining authored inline values', () => {
  const { window, element } = fixture();
  window.innerWidth = 1200;
  window.innerHeight = 800;
  element.style.cssText = 'width: 100vw; height: 25vh; min-width: 10vmin; max-width: 1.5vmax; left: -2.5vw; top: .5vh; right: 1e1vw; padding-left: 0vw; opacity: 0.5; --width: 100vw';
  const style = window.getComputedStyle(element);
  for (const [property, expected] of Object.entries({ width: '1200px', height: '200px', minWidth: '80px', maxWidth: '18px', left: '-30px', top: '4px', right: '120px', paddingLeft: '0px', opacity: '0.5' })) {
    assert.equal(style[property], expected, property);
  }
  assert.equal(style.getPropertyValue('width'), '1200px');
  assert.equal(style.getPropertyValue('--width'), '100vw');
  assert.equal(element.style.width, '100vw');
  element.style.width = '50%';
  element.style.height = 'calc(100vh - 10px)';
  assert.equal(window.getComputedStyle(element).width, '50%');
  assert.equal(window.getComputedStyle(element).height, 'calc(100vh - 10px)');
});

test('viewport changes invalidate cached custom-element and inherited computed styles', () => {
  const { window, document, element } = fixture();
  element.style.cssText = 'width: 100vw; height: 50vh';
  const child = document.createElement('span');
  child.style.width = 'inherit';
  element.appendChild(child);
  const original = window.getComputedStyle(element);
  assert.equal(original.width, '1024px');
  assert.equal(window.getComputedStyle(child).width, '1024px');
  assert.equal(window.getComputedStyle(element), original);
  window.innerWidth = 500;
  window.innerHeight = 300;
  assert.notEqual(window.getComputedStyle(element), original);
  assert.equal(window.getComputedStyle(element).width, '500px');
  assert.equal(window.getComputedStyle(element).height, '150px');
  assert.equal(window.getComputedStyle(child).width, '500px');
  window.innerWidth = 0;
  assert.equal(window.getComputedStyle(element).width, '0px');
});

test('custom elements use their owner document viewport across iframe adoption', () => {
  const { window, document } = fixture();
  window.innerWidth = 1600;
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const childWindow = iframe.contentWindow;
  childWindow.innerWidth = 400;
  class ChildElement extends childWindow.HTMLElement {}
  childWindow.customElements.define('x-child', ChildElement);
  const child = childWindow.document.createElement('x-child');
  child.style.width = '100vw';
  childWindow.document.body.appendChild(child);
  assert.equal(window.getComputedStyle(child).width, '400px');
  document.body.appendChild(child);
  assert.ok(child instanceof ChildElement);
  assert.equal(window.getComputedStyle(child).width, '1600px');
});

test('a custom-element scroll lock restores empty inline overflow to its computed initial value', () => {
  const { window, document } = fixture();
  class DrawerElement extends window.HTMLElement {
    connectedCallback() { this.previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    disconnectedCallback() { document.body.style.overflow = this.previous; }
  }
  window.customElements.define('x-drawer', DrawerElement);
  const drawer = document.createElement('x-drawer');
  assert.equal(document.body.style.overflow, '');
  assert.equal(window.getComputedStyle(document.body).overflow, 'visible');
  document.body.appendChild(drawer);
  assert.equal(window.getComputedStyle(document.body).overflow, 'hidden');
  drawer.remove();
  assert.equal(document.body.style.overflow, '');
  assert.equal(window.getComputedStyle(document.body).overflow, 'visible');
  for (const value of ['initial', 'unset']) {
    drawer.style.overflow = value;
    assert.equal(window.getComputedStyle(drawer).overflow, 'visible');
  }
});

test('empty overflow declarations restore stylesheet values instead of forcing an initial value', () => {
  const { window, document, element } = fixture('<style>body { overflow: auto }</style>');
  document.body.style.overflow = 'hidden';
  document.body.style.overflow = '';
  assert.equal(window.getComputedStyle(document.body).overflow, 'auto');
  element.style.overflow = 'inherit';
  assert.equal(window.getComputedStyle(element).overflow, 'auto');
  element.style.overflow = '!important';
  assert.equal(window.getComputedStyle(element).overflow, 'visible');
  element.style.overflow = 'clip';
  assert.equal(window.getComputedStyle(element).overflow, 'clip');
});

test('custom elements adopted into an inert document retain unresolved units without a viewport', () => {
  const { window, element, ViewportElement } = fixture();
  element.style.width = '10vw';
  const inert = new window.DOMParser().parseFromString('<html><body></body></html>', 'text/html');
  inert.adoptNode(element);
  inert.body.appendChild(element);
  assert.ok(element instanceof ViewportElement);
  assert.equal(inert.defaultView, null);
  assert.equal(window.getComputedStyle(element).width, '10vw');
});
