import { EventTarget, MessageEvent } from './events.mjs';

const hostSetTimeout = globalThis.setTimeout;
const hostStructuredClone = globalThis.structuredClone;
const states = new WeakMap();
const HostDOMException = globalThis.DOMException;

function cloneError(message) {
  return HostDOMException ? new HostDOMException(message, 'DataCloneError') : Object.assign(new Error(message), { name: 'DataCloneError' });
}

function schedule(endpoint) {
  if (!endpoint.started || endpoint.closed || endpoint.scheduled || !endpoint.queue.length) return;
  endpoint.scheduled = true;
  (globalThis.setTimeout || hostSetTimeout)(() => {
    endpoint.scheduled = false;
    if (endpoint.closed || !endpoint.started) return;
    const message = endpoint.queue.shift();
    const event = new MessageEvent('message', message);
    event.data = message.data;
    endpoint.owner.dispatchEvent(event);
    schedule(endpoint);
  }, 0);
}

export class MessagePort extends EventTarget {
  constructor(endpoint) {
    super();
    endpoint ||= { owner: this, peer: null, queue: [], started: false, scheduled: false, closed: false };
    states.set(this, endpoint);
    this.__messageHandler = null;
    this.__messageListener = null;
    this.onmessageerror = null;
  }
  get onmessage() { return this.__messageHandler; }
  set onmessage(value) {
    const next = typeof value === 'function' ? value : null;
    if (!this.__messageListener && next) this.__messageListener = event => this.__messageHandler?.call(this, event);
    if (!this.__messageHandler && next) this.addEventListener('message', this.__messageListener);
    else if (this.__messageHandler && !next) this.removeEventListener('message', this.__messageListener);
    this.__messageHandler = next;
    if (next) this.start();
  }
  start() {
    const endpoint = states.get(this);
    if (!endpoint || endpoint.closed) return;
    endpoint.started = true;
    schedule(endpoint);
  }
  close() {
    const endpoint = states.get(this);
    if (!endpoint) return;
    endpoint.closed = true;
    endpoint.queue.length = 0;
    if (endpoint.peer) endpoint.peer.peer = null;
    endpoint.peer = null;
  }
  postMessage(message, options = []) {
    const endpoint = states.get(this);
    if (!endpoint || endpoint.closed) return;
    const transfer = Array.isArray(options) ? options : options.transfer ?? [];
    const cloned = cloneMessage(message, transfer, this);
    const target = endpoint.peer;
    if (!target || target.closed) return;
    target.queue.push(cloned);
    schedule(target);
  }
}

export class MessageChannel {
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    const first = states.get(this.port1), second = states.get(this.port2);
    first.peer = second;
    second.peer = first;
  }
}

export function cloneMessage(message, transfer = [], sourcePort = null) {
  const type = typeof message;
  if (Array.isArray(transfer) && transfer.length === 0 && (message === null || (type !== 'object' && type !== 'function' && type !== 'symbol'))) {
    return { data: message, ports: [] };
  }
  const transfers = Array.from(transfer);
  const ports = [], markers = [], replacements = new Map(), ordinaryTransfers = [];
  for (const item of transfers) {
    if (item instanceof MessagePort) {
      if (!states.has(item) || item === sourcePort || replacements.has(item)) throw cloneError('Invalid MessagePort transfer');
      const marker = {};
      replacements.set(item, marker);
      ports.push(item);
      markers.push(marker);
    } else ordinaryTransfers.push(item);
  }
  const seen = new Map();
  function replace(value) {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof MessagePort) {
      const marker = replacements.get(value);
      if (!marker) throw cloneError('MessagePort must be included in the transfer list');
      return marker;
    }
    if (seen.has(value)) return seen.get(value);
    const tag = Object.prototype.toString.call(value);
    if (tag === '[object Map]') {
      const result = new Map(); seen.set(value, result);
      for (const [key, entry] of value) result.set(replace(key), replace(entry));
      return result;
    }
    if (tag === '[object Set]') {
      const result = new Set(); seen.set(value, result);
      for (const entry of value) result.add(replace(entry));
      return result;
    }
    if (!Array.isArray(value) && tag !== '[object Object]') return value;
    const result = Array.isArray(value) ? new Array(value.length) : {};
    seen.set(value, result);
    for (const key of Object.keys(value)) Object.defineProperty(result, key, {
      value: replace(value[key]), enumerable: true, configurable: true, writable: true,
    });
    return result;
  }
  const prepared = replace(message);
  if (typeof hostStructuredClone !== 'function') throw new Error('Messaging requires host structuredClone');
  const cloned = hostStructuredClone({ data: prepared, markers }, { transfer: ordinaryTransfers });
  const received = ports.map(port => new MessagePort(states.get(port)));
  const markerPorts = new Map(cloned.markers.map((marker, i) => [marker, received[i]]));
  const restored = new Set();
  function restore(value) {
    if (markerPorts.has(value)) return markerPorts.get(value);
    if (value === null || typeof value !== 'object' || restored.has(value)) return value;
    restored.add(value);
    if (value instanceof Map) {
      const entries = [...value]; value.clear();
      for (const [key, entry] of entries) value.set(restore(key), restore(entry));
    } else if (value instanceof Set) {
      const entries = [...value]; value.clear();
      for (const entry of entries) value.add(restore(entry));
    } else if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) {
      for (const key of Object.keys(value)) value[key] = restore(value[key]);
    }
    return value;
  }
  const data = restore(cloned.data);
  for (let i = 0; i < ports.length; i++) {
    const endpoint = states.get(ports[i]);
    states.delete(ports[i]);
    endpoint.owner = received[i];
    endpoint.started = false;
  }
  return { data, ports: received };
}
