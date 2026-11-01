import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../src/runtime/index.mjs';

const fresh = (html = '') => createEnvironment(`<!doctype html><html><body>${html}</body></html>`);

test('canvas dimensions have browser defaults and reflect parsed attributes', () => {
  const { document, window } = fresh('<canvas width="120" height="80"></canvas>');
  const blank = document.createElement('canvas');
  assert.equal(blank.width, 300);
  assert.equal(blank.height, 150);
  const parsed = document.querySelector('canvas');
  assert.equal(parsed.width, 120);
  assert.equal(parsed.height, 80);
  assert.ok(parsed instanceof window.HTMLCanvasElement);
  assert.ok(blank instanceof window.HTMLCanvasElement);
  assert.equal(parsed.cloneNode().width, 120);
  parsed.removeAttribute('width');
  assert.equal(parsed.width, 300);
});

test('canvas dimensions normalize invalid attributes and unsigned-long assignments', () => {
  const { document } = fresh();
  const canvas = document.createElement('canvas');
  for (const value of ['', '-1', 'bad', '2147483648', '4294967296']) {
    canvas.setAttribute('width', value);
    canvas.setAttribute('height', value);
    assert.equal(canvas.width, 300);
    assert.equal(canvas.height, 150);
  }
  canvas.setAttribute('width', ' +12tail');
  assert.equal(canvas.width, 12);
  canvas.width = 17.9;
  canvas.height = '25';
  assert.equal(canvas.width, 17);
  assert.equal(canvas.getAttribute('width'), '17');
  assert.equal(canvas.height, 25);
  canvas.width = -1;
  assert.equal(canvas.width, 300);
  assert.equal(canvas.getAttribute('width'), '300');
  canvas.height = -1;
  assert.equal(canvas.height, 150);
  canvas.width = Infinity;
  canvas.height = NaN;
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  assert.throws(() => { canvas.width = 1n; }, TypeError);
});

test('canvas and media interfaces do not change ordinary elements or SVG geometry', () => {
  const { document, window } = fresh('<div></div><svg><rect width="12"></rect></svg>');
  const div = document.querySelector('div');
  div.width = 'unchanged';
  assert.equal(div.width, 'unchanged');
  assert.equal(div.getAttribute('width'), null);
  assert.equal(typeof div.play, 'undefined');
  assert.equal(document.querySelector('rect').width.baseVal.value, 12);
  assert.ok(!(div instanceof window.HTMLMediaElement));
});

for (const tag of ['audio', 'video']) {
  test(`${tag} has observable virtual play/pause state without decoding or clock advancement`, async () => {
    const { document, window } = fresh(`<${tag}></${tag}>`);
    const media = document.querySelector(tag);
    assert.ok(media instanceof window.HTMLMediaElement);
    assert.ok(media instanceof (tag === 'audio' ? window.HTMLAudioElement : window.HTMLVideoElement));
    assert.equal(media.paused, true);
    assert.equal(media.currentTime, 0);
    assert.equal(media.readyState, 0);
    assert.equal(media.networkState, 0);
    assert.equal(media.ended, false);
    assert.ok(Number.isNaN(media.duration));
    assert.equal(media.currentSrc, '');
    assert.equal(media.canPlayType('video/mp4'), '');
    const events = [];
    media.addEventListener('play', () => events.push('play'));
    media.onpause = () => events.push('pause');
    media.currentTime = 12.5;
    const playing = media.play();
    assert.ok(playing instanceof Promise);
    assert.equal(media.paused, false);
    assert.deepEqual(events, []);
    await playing;
    await media.play();
    assert.deepEqual(events, ['play']);
    assert.equal(media.currentTime, 12.5);
    media.pause();
    media.pause();
    assert.equal(media.paused, true);
    await Promise.resolve();
    assert.deepEqual(events, ['play', 'pause']);
    assert.equal(media.cloneNode().paused, true);
    assert.equal(media.cloneNode().currentTime, 0);
  });
}

test('media load resets virtual position while volume, mute and preload reflect their controls', async () => {
  const { document } = fresh();
  const media = document.createElement('audio');
  assert.equal(media.volume, 1);
  assert.equal(media.muted, false);
  assert.equal(media.defaultMuted, false);
  assert.equal(media.preload, '');
  const events = [];
  media.onvolumechange = () => events.push('volumechange');
  media.volume = '0.25';
  media.volume = 0.25;
  media.muted = true;
  media.muted = true;
  media.defaultMuted = true;
  media.preload = 'metadata';
  assert.equal(media.volume, 0.25);
  assert.equal(media.muted, true);
  assert.equal(media.getAttribute('muted'), '');
  assert.equal(media.defaultMuted, true);
  assert.equal(media.getAttribute('preload'), 'metadata');
  media.defaultMuted = false;
  assert.equal(media.hasAttribute('muted'), false);
  media.currentTime = '15';
  await media.play();
  assert.deepEqual(events, ['volumechange', 'volumechange']);
  media.onemptied = () => events.push('emptied');
  media.load();
  assert.equal(media.currentTime, 0);
  assert.equal(media.paused, true);
  await Promise.resolve();
  assert.equal(events.at(-1), 'emptied');
  const eventCount = events.length;
  media.load();
  await Promise.resolve();
  assert.equal(events.length, eventCount);
  assert.throws(() => { media.volume = -1; }, { name: 'IndexSizeError' });
  assert.throws(() => { media.volume = NaN; }, TypeError);
  assert.throws(() => { media.currentTime = Infinity; }, TypeError);
});

test('Audio factory creates media in the right document with preload auto and an optional source', () => {
  const { document, window } = fresh();
  const blank = new window.Audio();
  assert.equal(blank.ownerDocument, document);
  assert.equal(blank.preload, 'auto');
  assert.equal(blank.hasAttribute('src'), false);
  assert.ok(blank instanceof window.Audio);
  assert.ok(blank instanceof window.HTMLAudioElement);
  assert.ok(blank instanceof window.HTMLMediaElement);
  assert.equal(new window.Audio('').getAttribute('src'), '');
  assert.equal(new window.Audio(null).getAttribute('src'), 'null');
  assert.equal(new window.Audio('chime.wav').getAttribute('src'), 'chime.wav');
  assert.ok(!(document.createElement('video') instanceof window.Audio));
  const other = fresh();
  assert.equal(new other.window.Audio().ownerDocument, other.document);
});
