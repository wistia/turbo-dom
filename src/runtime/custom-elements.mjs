import { Event } from './events.mjs';

const RESERVED = new Set(['annotation-xml', 'color-profile', 'font-face', 'font-face-src', 'font-face-uri', 'font-face-format', 'font-face-name', 'missing-glyph']);
const NAME = /^[a-z][-.0-9_a-z\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C-\u200D\u203F-\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}]*$/u;
const CALLBACKS = ['connectedCallback', 'disconnectedCallback', 'adoptedCallback', 'attributeChangedCallback'];
const records = new WeakMap();
const registries = new WeakMap();
const TOKEN = Symbol('CustomElementRegistry');
const HostDOMException = globalThis.DOMException;
const hostConsole = globalThis.console;
const stack = [];
let invoking = null, backup = null;
let operationDepth = 0, cloningSuppressed = 0;

function exception(message, name) {
  return HostDOMException ? new HostDOMException(message, name) : Object.assign(new Error(message), { name });
}
function validName(name) { return name.includes('-') && NAME.test(name) && !RESERVED.has(name); }
function checkName(name) { if (!validName(name)) throw exception(`'${name}' is not a valid custom element name`, 'SyntaxError'); }
function queue() { return { elements: [], seen: new Set() }; }
function current(context) { return context.active && (!context.isActive || context.isActive()); }
function report(context, error) {
  if (!current(context)) return;
  const window = context.document?.defaultView;
  const event = new Event('error', { cancelable: true });
  event.error = error;
  event.message = String(error?.message || error);
  if (!window || window.dispatchEvent(event)) hostConsole?.error(error);
}
function enqueue(record, reaction) {
  record.reactions.push(reaction);
  let target = stack.length ? (stack[stack.length - 1] ||= queue()) : invoking;
  if (!target) {
    if (!backup) {
      backup = queue();
      Promise.resolve().then(() => { const pending = backup; backup = null; flush(pending); });
    }
    target = backup;
  }
  if (!target.seen.has(record)) { target.seen.add(record); target.elements.push(record); }
}
function flush(pending) {
  const previous = invoking;
  invoking = pending;
  try {
    for (const record of pending.elements) {
      while (record.head < record.reactions.length) {
        const reaction = record.reactions[record.head++];
        if (!current(record.context) || record.state === 'failed') continue;
        if (reaction.upgrade) upgradeElement(record, reaction.upgrade);
        else {
          try { reaction.callback.apply(record.element, reaction.args); }
          catch (error) { report(record.context, error); }
        }
      }
      record.reactions.length = 0;
      record.head = 0;
      pending.seen.delete(record);
    }
  } finally { invoking = previous; }
}
export function beginCustomElementReactions() { stack.push(null); }
export function endCustomElementReactions() { const pending = stack.pop(); if (pending) flush(pending); }
function react(callback) {
  beginCustomElementReactions();
  try { return callback(); } finally { endCustomElementReactions(); }
}
function walk(node, visit) {
  if (node.nodeType === 1) visit(node);
  if (node.__shadow) walk(node.__shadow, visit);
  for (const child of node.__children()) walk(child, visit);
}
function stateFor(element, context) {
  let record = records.get(element);
  if (!record) {
    record = { element, context, state: 'undefined', definition: null, reactions: [], head: 0 };
    records.set(element, record);
  }
  return record;
}
function callback(record, name, args = []) {
  const fn = record.definition?.callbacks[name];
  if (fn) enqueue(record, { callback: fn, args });
}
function upgradeElement(record, definition) {
  if (record.state !== 'undefined') return;
  const element = record.element;
  record.context = definition.context;
  record.definition = definition;
  record.state = 'constructing';
  for (const name of definition.context.attributeNames.call(element)) {
    if (definition.observed.has(name)) callback(record, 'attributeChangedCallback', [name, null, definition.context.attribute.call(element, name), null]);
  }
  if (element.isConnected) callback(record, 'connectedCallback');
  const entry = { element, used: false };
  definition.stack.push(entry);
  try {
    if (Reflect.construct(definition.constructor, []) !== element || !entry.used) throw new TypeError('Custom element constructor did not return the element');
    record.state = 'custom';
    element.ownerDocument.__ceActive = true;
    element.ownerDocument.__version = (element.ownerDocument.__version || 0) + 1;
  } catch (error) {
    record.state = 'failed';
    record.reactions.length = record.head;
    report(record.context, error);
  } finally { definition.stack.pop(); }
}
function tryUpgrade(element, context) {
  const record = records.get(element);
  if (element.ownerDocument?.__ceContext !== context || element.__ns !== '' || !element.localName.includes('-') || (record && record.state !== 'undefined')) return;
  const definition = context.definitions.get(element.localName);
  if (definition) enqueue(stateFor(element, context), { upgrade: definition });
}

export class CustomElementRegistry {
  constructor(token, context) {
    if (token !== TOKEN) throw exception('Scoped custom element registries are not supported', 'NotSupportedError');
    registries.set(this, context);
  }
  define(name, constructor, options) {
    const context = registries.get(this);
    return react(() => {
      if (!context.active) throw exception('Custom element environment is disposed', 'InvalidStateError');
      name = '' + name;
      if (typeof constructor !== 'function') throw new TypeError('Custom element constructor must be constructible');
      Reflect.construct(new Proxy(constructor, { construct: () => ({}) }), []);
      checkName(name);
      if (context.definitions.has(name) || context.constructors.has(constructor) || context.defining) throw exception(`'${name}' is already defined or definition is in progress`, 'NotSupportedError');
      context.defining = true;
      let definition;
      try {
        if (options?.extends !== undefined || constructor.formAssociated) throw exception('Customized built-ins and form-associated custom elements are not supported', 'NotSupportedError');
        const prototype = constructor.prototype;
        if (!prototype || (typeof prototype !== 'object' && typeof prototype !== 'function')) throw new TypeError('Custom element prototype must be an object');
        const callbacks = {};
        for (const name of CALLBACKS) {
          const value = prototype[name];
          if (value !== undefined && typeof value !== 'function') throw new TypeError(`${name} must be a function`);
          callbacks[name] = value;
        }
        const attributes = callbacks.attributeChangedCallback ? constructor.observedAttributes : undefined;
        if (attributes !== undefined && (attributes === null || (typeof attributes !== 'object' && typeof attributes !== 'function'))) throw new TypeError('observedAttributes must be an iterable object');
        definition = { name, constructor, callbacks, observed: new Set(attributes === undefined ? [] : [...attributes].map(value => '' + value)), stack: [], context };
      } finally { context.defining = false; }
      context.definitions.set(name, definition);
      context.constructors.set(constructor, definition);
      if (context.document) {
        context.document.__ceActive = true;
        walk(context.document, element => tryUpgrade(element, context));
      }
      const waiter = context.waiters.get(name);
      if (waiter) { context.waiters.delete(name); waiter.resolve(constructor); }
    });
  }
  get(name) { return registries.get(this).definitions.get('' + name)?.constructor; }
  getName(constructor) { return registries.get(this).constructors.get(constructor)?.name ?? null; }
  whenDefined(name) {
    const context = registries.get(this);
    if (!context) throw new TypeError('Illegal CustomElementRegistry receiver');
    name = '' + name;
    try { checkName(name); }
    catch (error) { return Promise.reject(error); }
    if (!context.active) return Promise.reject(exception('Custom element environment is disposed', 'InvalidStateError'));
    const definition = context.definitions.get(name);
    if (definition) return Promise.resolve(definition.constructor);
    let waiter = context.waiters.get(name);
    if (!waiter) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      waiter = { promise, resolve };
      context.waiters.set(name, waiter);
    }
    return waiter.promise;
  }
  upgrade(root) {
    const context = registries.get(this);
    if (!context.active) throw exception('Custom element environment is disposed', 'InvalidStateError');
    if (!root || typeof root.__children !== 'function') throw new TypeError('upgrade requires a Node');
    react(() => walk(root, element => tryUpgrade(element, context)));
  }
}

export function createCustomElementContext(document, Element, isActive) {
  const context = { document, Element, isActive, active: true, defining: false, definitions: new Map(), constructors: new Map(), waiters: new Map() };
  context.attributeNames = Element?.prototype.getAttributeNames;
  context.attribute = Element?.prototype.getAttribute;
  context.hasAttributes = Element?.prototype.hasAttributes;
  context.children = Element?.prototype.__children;
  function HTMLElement() {
    if (!new.target) throw new TypeError('Illegal constructor');
    const definition = context.constructors.get(new.target);
    if (!current(context) || !definition) throw new TypeError('Illegal custom element constructor');
    const entry = definition.stack[definition.stack.length - 1];
    let element;
    if (entry) {
      if (entry.used) throw new TypeError('Custom element constructor already called super');
      entry.used = true;
      element = entry.element;
    } else {
      element = new Element(document, definition.name, '');
      const record = stateFor(element, context);
      record.state = 'custom';
      record.definition = definition;
    }
    Object.setPrototypeOf(element, new.target.prototype);
    return element;
  }
  HTMLElement.prototype = Element?.prototype || Object.prototype;
  context.HTMLElement = HTMLElement;
  context.registry = new CustomElementRegistry(TOKEN, context);
  context.create = element => {
    const definition = context.definitions.get(element.localName);
    if (!definition || element.__ns !== '') return element;
    const record = stateFor(element, context);
    react(() => upgradeElement(record, definition));
    if (record.state === 'failed' || element.parentNode || context.hasAttributes.call(element) || context.children.call(element).length || element.ownerDocument !== document) {
      if (record.state !== 'failed') report(context, exception('Custom element constructor changed its attributes, children, parent or document', 'NotSupportedError'));
      record.state = 'failed';
      const fallback = new Element(document, definition.name, '');
      stateFor(fallback, context).state = 'failed';
      return fallback;
    }
    return element;
  };
  context.dispose = () => {
    context.active = false;
    context.definitions.clear(); context.constructors.clear(); context.waiters.clear();
    if (document?.__ceContext === context) { document.__ceContext = null; document.__ceActive = false; }
  };
  if (document) document.__ceContext = context;
  return context;
}
export function makeCustomElements() { return createCustomElementContext(null, null).registry; }
export function isCustomElementDefined(element) {
  return element.__ns !== '' || !element.localName.includes('-') || RESERVED.has(element.localName) || records.get(element)?.state === 'custom';
}
export function customElementsInserted(node, parsed = false) {
  const context = node.ownerDocument?.__ceContext;
  walk(node, element => {
    const record = records.get(element);
    if (record?.state === 'custom') { if (element.isConnected) callback(record, 'connectedCallback'); }
    else if (context && current(context) && (parsed || element.isConnected) && !element.ownerDocument.__isTemplateDocument) tryUpgrade(element, context);
  });
}
export function customElementsRemoved(node) {
  walk(node, element => { const record = records.get(element); if (record?.state === 'custom') callback(record, 'disconnectedCallback'); });
}
export function customElementAttribute(element, name, oldValue, newValue) {
  const record = records.get(element);
  if (record?.definition?.observed.has(name) && record.state !== 'failed') callback(record, 'attributeChangedCallback', [name, oldValue, newValue, null]);
}
export function customElementAdopted(node, previous, next) {
  const record = records.get(node);
  if (record?.state === 'custom') { next.__ceActive = true; callback(record, 'adoptedCallback', [previous, next]); }
}
export function beginCustomElementCloning() { cloningSuppressed++; }
export function endCustomElementCloning() { cloningSuppressed--; }
export function customElementClone(node) {
  if (cloningSuppressed) return;
  const context = node.ownerDocument?.__ceContext;
  if (context && current(context)) tryUpgrade(node, context);
}

export function installCustomElementReactions(prototype, names, setters = [], variadic = []) {
  for (const name of names) {
    const original = prototype[name];
    prototype[name] = function(a, b) {
      if (operationDepth || (!this.ownerDocument?.__ceActive && !a?.ownerDocument?.__ceActive)) return original.call(this, a, b);
      operationDepth++; beginCustomElementReactions();
      try { return original.call(this, a, b); } finally { operationDepth--; endCustomElementReactions(); }
    };
  }
  for (const name of variadic) {
    const original = prototype[name];
    prototype[name] = function() {
      if (operationDepth || !this.ownerDocument?.__ceActive) return original.apply(this, arguments);
      operationDepth++; beginCustomElementReactions();
      try { return original.apply(this, arguments); } finally { operationDepth--; endCustomElementReactions(); }
    };
  }
  for (const name of setters) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const original = descriptor.set;
    descriptor.set = function(value) {
      if (operationDepth || !this.ownerDocument?.__ceActive) return original.call(this, value);
      operationDepth++; beginCustomElementReactions();
      try { return original.call(this, value); } finally { operationDepth--; endCustomElementReactions(); }
    };
    Object.defineProperty(prototype, name, descriptor);
  }
}
