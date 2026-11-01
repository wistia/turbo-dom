import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../src/runtime/index.mjs';

test('typed event dictionaries ignore unknown and readonly Event members', () => {
  const { window } = createEnvironment();
  for (const name of [
    'UIEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'InputEvent', 'FocusEvent',
    'CompositionEvent', 'WheelEvent', 'TouchEvent', 'DragEvent', 'ProgressEvent',
  ]) {
    const init = {
      cancelable: true,
      get defaultPrevented() { assert.fail(`${name} read an unknown dictionary member`); },
      get preventDefault() { assert.fail(`${name} read a method from its dictionary`); },
      get target() { assert.fail(`${name} read an output-only member`); },
      get type() { assert.fail(`${name} read an output-only member`); },
    };
    const event = new window[name]('custom', init);
    assert.equal(event.type, 'custom');
    assert.equal(event.target, null);
    assert.equal(event.defaultPrevented, false);
    event.preventDefault();
    assert.equal(event.defaultPrevented, true);
    assert.equal(new window[name]('custom', { defaultPrevented: false }).defaultPrevented, false);
  }
});

test('typed event dictionaries retain inherited UI, mouse and modifier members', () => {
  const { window } = createEnvironment();
  for (const name of ['MouseEvent', 'PointerEvent', 'WheelEvent', 'DragEvent']) {
    const event = new window[name]('custom', { view: window, detail: 2, clientX: 12, shiftKey: true, button: 1 });
    assert.equal(event.view, window);
    assert.equal(event.detail, 2);
    assert.equal(event.clientX, 12);
    assert.equal(event.shiftKey, true);
    assert.equal(event.button, 1);
  }
  const pointer = new window.PointerEvent('pointerdown', { pressure: 0.5, isPrimary: true, pointerType: 'pen' });
  assert.equal(pointer.pressure, 0.5);
  assert.equal(pointer.isPrimary, true);
  assert.equal(pointer.pointerType, 'pen');
  const keyboard = new window.KeyboardEvent('keydown', Object.create({ key: 'Enter', location: 3, isComposing: true }));
  assert.equal(keyboard.key, 'Enter');
  assert.equal(keyboard.location, 3);
  assert.equal(keyboard.isComposing, true);
});

test('pointer event dictionaries retain pen orientation angles', () => {
  const { window } = createEnvironment();
  const pointer = new window.PointerEvent('pointerdown', { altitudeAngle: 0.2, azimuthAngle: 0.3 });
  assert.equal(pointer.altitudeAngle, 0.2);
  assert.equal(pointer.azimuthAngle, 0.3);
  const defaults = new window.PointerEvent('pointerdown');
  assert.equal(defaults.altitudeAngle, Math.PI / 2);
  assert.equal(defaults.azimuthAngle, 0);
});

test('input event dictionaries retain paste and drop transfer data', () => {
  const { window } = createEnvironment();
  const transfer = new window.DataTransfer();
  transfer.setData('text/plain', 'pasted text');
  for (const inputType of ['insertFromPaste', 'insertFromDrop']) {
    const event = new window.InputEvent('beforeinput', { inputType, dataTransfer: transfer });
    assert.equal(event.dataTransfer, transfer);
    assert.equal(event.dataTransfer.getData('text/plain'), 'pasted text');
  }
  assert.equal(new window.InputEvent('beforeinput').dataTransfer, null);
});
