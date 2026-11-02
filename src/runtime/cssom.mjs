import { splitDeclarations, isValidSizingValue, normalizeZeroLengths, expandBorderShorthand } from './css-values.mjs';

// CSSOM rules are parsed only when a stylesheet is accessed or mutated. Grouping
// rules expose their nested rules for CSS assertions; media/supports conditions
// remain unevaluated by the partial cascade.

export class CSSRule {
  constructor(cssText = '') {
    this.cssText = String(cssText);
    this.type = 0;
    this.parentRule = null;
    this.parentStyleSheet = null;
  }
}

export class CSSStyleRule extends CSSRule {
  constructor(cssText) {
    super(cssText);
    const open = this.cssText.indexOf('{'), close = this.cssText.lastIndexOf('}');
    if (open !== -1 && close !== -1 && !this.cssText.trimStart().startsWith('@')) {
      const declarations = splitDeclarations(this.cssText.slice(open + 1, close));
      const formatted = [];
      for (const declaration of declarations) {
        const colon = declaration.indexOf(':');
        if (colon === -1) continue;
        const property = declaration.slice(0, colon).trim(), value = declaration.slice(colon + 1).trim();
        const accepted = value.replace(/\s*!\s*important\s*$/i, '');
        if (isValidSizingValue(property.toLowerCase(), accepted)) formatted.push(`${property}: ${value};`);
      }
      this.cssText = `${this.cssText.slice(0, open).trim()} {${formatted.length ? ' ' + formatted.join(' ') + ' ' : ''}}`;
    }
    this.type = 1; // CSSRule.STYLE_RULE
  }
  get style() {
    const text = this.cssText;
    const declarations = splitDeclarations(text.slice(text.indexOf('{') + 1, text.lastIndexOf('}')));
    const values = new Map(), priorities = new Map();
    let expandedValues, expandedPriorities;
    for (const declaration of declarations) {
      const colon = declaration.indexOf(':');
      if (colon !== -1) {
        const name = declaration.slice(0, colon).trim(), value = declaration.slice(colon + 1).trim();
        const important = /\s*!\s*important\s*$/i.exec(value);
        const accepted = important ? value.slice(0, important.index).trim() : value;
        if (!isValidSizingValue(name, accepted)) continue;
        values.set(name, normalizeZeroLengths(name, accepted));
        if (important) priorities.set(name, 'important');
        else priorities.delete(name);
        if (expandedValues) {
          expandedValues.set(name, values.get(name));
          if (important) expandedPriorities.set(name, 'important');
          else expandedPriorities.delete(name);
        }
        const expansion = expandBorderShorthand(name, accepted);
        if (expansion) {
          expandedValues ||= new Map(values);
          expandedPriorities ||= new Map(priorities);
          for (const [property, value] of expansion) {
            expandedValues.set(property, value);
            if (important) expandedPriorities.set(property, 'important');
            else expandedPriorities.delete(property);
          }
        }
      }
    }
    const cssText = [...values].map(([property, value]) => `${property}: ${value}${priorities.has(property) ? ' !important' : ''};`).join(' ');
    return { cssText, getPropertyValue: property => (expandedValues || values).get(property) || '', getPropertyPriority: property => (expandedPriorities || priorities).get(property) || '' };
  }
  get selectorText() {
    const i = this.cssText.indexOf('{');
    return i < 0 ? '' : this.cssText.slice(0, i).trim();
  }
}

const readDeclarationStyle = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, 'style').get;

export class CSSFontFaceRule extends CSSRule {
  constructor(cssText) { super(cssText); this.type = 5; }
  get style() { return readDeclarationStyle.call(this); }
}

function splitTopLevelRules(css) {
  const out = [];
  let start = 0, depth = 0, quote = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) break;
      if (!depth && !css.slice(start, i).trim()) start = end + 2;
      i = end + 1;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && depth) {
      if (--depth) continue;
      const piece = css.slice(start, i + 1).trim();
      if (piece) out.push(piece);
      start = i + 1;
    } else if (ch === ';' && !depth) {
      const piece = css.slice(start, i + 1).trim();
      if (piece) out.push(piece);
      start = i + 1;
    } else if (ch === '}' && !depth) start = i + 1;
  }
  return out;
}

function invalidateSheet(sheet) {
  sheet?.ownerNode?.__touch?.();
}

function clearSheetLinks(rule) {
  rule.parentStyleSheet = null;
  if (rule.cssRules) for (const child of rule.cssRules) clearSheetLinks(child);
}

function detachRule(rule, clearChildren = false) {
  rule.parentRule = null;
  if (clearChildren) {
    rule.parentStyleSheet = null;
    if (rule.cssRules) {
      for (const child of rule.cssRules) detachRule(child, true);
      rule.cssRules.length = 0;
    }
  } else clearSheetLinks(rule);
}

export class CSSGroupingRule extends CSSRule {
  constructor(prelude, body, sheet = null, parent = null) {
    super();
    if (prelude === undefined) throw new TypeError('Illegal constructor');
    this.__prelude = prelude;
    this.parentStyleSheet = sheet;
    this.parentRule = parent;
    this.cssRules = splitTopLevelRules(body).map(text => createRule(text, sheet, this));
  }
  get cssText() { return `${this.__prelude} {${this.cssRules.map(rule => rule.cssText).join(' ')}}`; }
  set cssText(_value) {}
  insertRule(text, index = 0) {
    if (index < 0 || index > this.cssRules.length) throw new RangeError('insertRule: index out of bounds');
    this.cssRules.splice(index, 0, createRule(String(text), this.parentStyleSheet, this));
    invalidateSheet(this.parentStyleSheet);
    return index;
  }
  deleteRule(index) {
    if (index < 0 || index >= this.cssRules.length) throw new RangeError('deleteRule: index out of bounds');
    for (const removed of this.cssRules.splice(index, 1)) detachRule(removed);
    invalidateSheet(this.parentStyleSheet);
  }
}

function trimRuleStart(text) {
  text = text.trimStart();
  while (text.startsWith('/*')) {
    const end = text.indexOf('*/', 2);
    if (end === -1) break;
    text = text.slice(end + 2).trimStart();
  }
  return text;
}

export class CSSConditionRule extends CSSGroupingRule {
  get conditionText() { return trimRuleStart(this.__prelude.replace(/^@[-a-z]+/i, '')); }
}
export class CSSMediaRule extends CSSConditionRule {
  constructor(...args) { super(...args); this.type = 4; }
}
export class CSSSupportsRule extends CSSConditionRule {
  constructor(...args) { super(...args); this.type = 12; }
}

function findBlockStart(text) {
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
    } else if (ch === '{') return i;
  }
  return -1;
}

function createRule(text, sheet, parent = null) {
  text = trimRuleStart(text);
  const open = findBlockStart(text);
  const prelude = text.slice(0, open).trim();
  const name = /^@(media|supports|container|layer|scope|starting-style)\b/i.exec(prelude)?.[1].toLowerCase();
  let rule;
  if (name && open !== -1) {
    let Type = CSSGroupingRule;
    if (name === 'media') Type = CSSMediaRule;
    else if (name === 'supports') Type = CSSSupportsRule;
    rule = new Type(prelude, text.slice(open + 1, text.lastIndexOf('}')), sheet, parent);
  } else if (/^@font-face\b/i.test(prelude) && open !== -1) rule = new CSSFontFaceRule(text);
  else rule = text.trimStart().startsWith('@') ? new CSSRule(text) : new CSSStyleRule(text);
  rule.parentStyleSheet = sheet;
  rule.parentRule = parent;
  return rule;
}

export class CSSStyleSheet {
  // ownerNode is the <style> element (null for constructed/adopted sheets).
  constructor(ownerNode = null, init = {}) {
    this.ownerNode = ownerNode;
    this.cssRules = [];
    this.type = 'text/css';
    this.disabled = false;
    this.media = init.media != null ? init.media : [];
    this.title = init.title != null ? init.title : null;
    this.href = null;
    this.parentStyleSheet = null;
    this.ownerRule = null;
  }

  // legacy alias some libraries read
  get rules() { return this.cssRules; }

  insertRule(rule, index = 0) {
    const i = index === undefined ? 0 : index;
    if (i < 0 || i > this.cssRules.length) throw new RangeError('insertRule: index out of bounds');
    this.cssRules.splice(i, 0, createRule(String(rule), this));
    this.#invalidate();
    return i;
  }

  deleteRule(index) {
    if (index < 0 || index >= this.cssRules.length) throw new RangeError('deleteRule: index out of bounds');
    for (const removed of this.cssRules.splice(index, 1)) detachRule(removed);
    this.#invalidate();
  }

  // legacy IE-era APIs (some older libs still call these)
  addRule(selector = '', style = '', index) {
    const i = index === undefined ? this.cssRules.length : index;
    this.insertRule(`${selector} { ${style} }`, i);
    return -1; // spec'd legacy return
  }
  removeRule(index = 0) { this.deleteRule(index); }

  // constructable-stylesheet API (adoptedStyleSheets); replaceSync is synchronous.
  replaceSync(text) {
    const rules = splitTopLevelRules(String(text)).map((r) => createRule(r, this));
    for (const rule of this.cssRules) detachRule(rule, true);
    this.cssRules = rules;
    this.#invalidate();
  }
  replace(text) { this.replaceSync(text); return Promise.resolve(this); }

  // Bump the owning Document's version so cascade.mjs's version-keyed style index
  // (and any getComputedStyle cache) rebuilds. Constructed sheets (no ownerNode)
  // have nothing to invalidate until adopted — a no-op, which is correct.
  #invalidate() {
    const n = this.ownerNode;
    if (n && n.__touch) n.__touch();
  }
}

// Live StyleSheetList for document.styleSheets: a plain array (indexable +
// iterable, what emotion needs) with the spec's `item()` accessor bolted on.
export function styleSheetList(sheets) {
  const list = sheets.slice();
  list.item = (i) => list[i] ?? null;
  return list;
}
