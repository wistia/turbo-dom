import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act, lazy, Suspense, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { installGlobals } from '../src/environment/install.mjs';

test('custom element connection mounts a lazy React root and disconnection unmounts it', async () => {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { teardown } = installGlobals(globalThis);
  let imports = 0, unmounts = 0;
  const ready = Promise.withResolvers();
  function Content({ host }) {
    useEffect(() => { host.setAttribute('data-react-mounted', ''); return () => unmounts++; }, [host]);
    return React.createElement('button', null, 'Loaded');
  }
  const Component = lazy(() => { imports++; return ready.promise; });
  class ReactElement extends HTMLElement {
    #root;
    connectedCallback() {
      this.#root = createRoot(this);
      this.#root.render(React.createElement(Suspense, { fallback: null }, React.createElement(Component, { host: this })));
    }
    disconnectedCallback() { this.#root.unmount(); }
  }
  try {
    customElements.define('x-react-root', ReactElement);
    const element = document.createElement('x-react-root');
    await act(async () => { document.body.appendChild(element); });
    assert.equal(imports, 1);
    assert.equal(element.hasAttribute('data-react-mounted'), false);
    await act(async () => { ready.resolve({ default: Content }); });
    assert.equal(element.hasAttribute('data-react-mounted'), true);
    assert.equal(element.querySelector('button').textContent, 'Loaded');
    await act(async () => { element.remove(); });
    assert.equal(unmounts, 1);
  } finally { teardown(); globalThis.IS_REACT_ACT_ENVIRONMENT = previous; }
});
