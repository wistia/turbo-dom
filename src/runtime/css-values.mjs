import { canonicalizeColor } from './color.mjs';

const LENGTH_PROPS = new Set([
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'top', 'right', 'bottom', 'left', 'inset', 'inset-block', 'inset-inline',
  'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end',
  'flex-basis', 'gap', 'row-gap', 'column-gap',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-width', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'outline-width', 'outline-offset', 'border-spacing',
  'font-size', 'letter-spacing', 'word-spacing', 'text-indent', 'vertical-align',
]);
const SIZING_PROPS = new Set(['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'inline-size', 'block-size', 'min-inline-size', 'max-inline-size', 'min-block-size', 'max-block-size', 'flex-basis']);
const CSS_DIMENSION = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(px|em|rem|ex|rex|cap|rcap|ch|rch|ic|ric|lh|rlh|vw|vh|vi|vb|vmin|vmax|svw|svh|svi|svb|svmin|svmax|lvw|lvh|lvi|lvb|lvmin|lvmax|dvw|dvh|dvi|dvb|dvmin|dvmax|cqw|cqh|cqi|cqb|cqmin|cqmax|cm|mm|q|in|pt|pc|%)$/i;
const COMPOUND_LENGTH_PROPS = new Set(['margin', 'padding', 'border-width', 'border-spacing']);
const ZERO_NUMBER = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?$/i;
const CSS_WIDE_KEYWORD = /^(inherit|initial|unset|revert|revert-layer)$/;
const ZERO_LENGTH = /(^|\s)[+-]?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?(?=$|\s)/gi;

export function stripCssComments(value) {
  if (!value.includes('/*')) return value;
  let out = '', quote = '';
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (character === '\\') { out += character; if (i + 1 < value.length) out += value[++i]; continue; }
    if (quote) { out += character; if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") { quote = character; out += character; continue; }
    if (character === '/' && value[i + 1] === '*') {
      const end = value.indexOf('*/', i + 2);
      out += ' ';
      if (end === -1) break;
      i = end + 1;
    } else out += character;
  }
  return out;
}

export function normalizeZeroLengths(property, value) {
  if (!LENGTH_PROPS.has(property)) return value;
  const trimmed = stripCssComments(value).trim();
  if (!COMPOUND_LENGTH_PROPS.has(property)) {
    if (ZERO_NUMBER.test(trimmed)) return '0px';
    const dimension = CSS_DIMENSION.exec(trimmed);
    return dimension ? `${Number(dimension[1])}${dimension[2]}` : trimmed;
  }
  if (/[()'\"]/.test(trimmed)) return trimmed;
  return trimmed.replace(ZERO_LENGTH, (_, separator) => `${separator}0px`);
}

export function isValidSizingValue(property, value) {
  if (!SIZING_PROPS.has(property)) return true;
  const text = stripCssComments(value).trim().toLowerCase();
  if (/^(inherit|initial|unset|revert|revert-layer|min-content|max-content|fit-content|stretch|contain)$/.test(text)) return true;
  if (text === 'auto') return !property.startsWith('max-');
  if (text === 'none') return property.startsWith('max-');
  if (ZERO_NUMBER.test(text)) return true;
  const dimension = CSS_DIMENSION.exec(text);
  if (dimension) return Number(dimension[1]) >= 0 && Number.isFinite(Number(dimension[1]));
  if (!/^(calc|min|max|clamp|var|env|fit-content|calc-size|anchor-size)\(/.test(text)) return false;
  let depth = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '\\') { i++; continue; }
    if (quote) { if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return false;
      i = end + 1;
      continue;
    }
    if (character === '(') depth++;
    else if (character === ')' && --depth === 0) return !text.slice(i + 1).replace(/\/\*[\s\S]*?\*\//g, '').trim();
  }
  return false;
}

function splitCssComponents(value) {
  const tokens = [];
  let start = 0, depth = 0, quote = '';
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (character === '\\') { i++; continue; }
    if (quote) { if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (!depth && /\s/.test(character)) {
      if (i > start) tokens.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (start < value.length) tokens.push(value.slice(start));
  return tokens;
}

export function expandBorderShorthand(property, value) {
  const match = /^border(?:-(top|right|bottom|left|width|style|color))?$/.exec(property);
  if (!match) return null;
  const text = stripCssComments(value).trim(), keyword = text.toLowerCase();
  const global = CSS_WIDE_KEYWORD.test(keyword), deferred = /var\(/i.test(text);
  const family = /^(width|style|color)$/.test(match[1]);
  const sides = family || !match[1] ? ['top', 'right', 'bottom', 'left'] : [match[1]];
  const tokens = splitCssComponents(text);
  const resolvedValue = value => {
    if (global) return keyword;
    return deferred ? '' : value;
  };
  const expanded = [];
  if (family) {
    if (!tokens.length || tokens.length > 4) return null;
    const values = [tokens[0], tokens[1] ?? tokens[0], tokens[2] ?? tokens[0], tokens[3] ?? tokens[1] ?? tokens[0]];
    for (let i = 0; i < sides.length; i++) {
      const property = `border-${sides[i]}-${match[1]}`;
      const value = resolvedValue(values[i]);
      expanded.push([property, match[1] === 'color' ? canonicalizeColor(value, false) || value : normalizeZeroLengths(property, value)]);
    }
    return expanded;
  }
  let width = 'medium', style = 'none', color = '';
  if (!deferred && !global) for (const token of tokens) {
    if (/^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/.test(token)) style = token;
    else if (/^(thin|medium|thick)$/.test(token) || ZERO_NUMBER.test(token) || CSS_DIMENSION.test(token)) width = normalizeZeroLengths('border-top-width', token);
    else color += (color ? ' ' : '') + token;
  }
  color = canonicalizeColor(color, false) || color || 'currentcolor';
  for (const side of sides) {
    expanded.push([`border-${side}-width`, resolvedValue(width)], [`border-${side}-style`, resolvedValue(style)], [`border-${side}-color`, resolvedValue(color)]);
  }
  return expanded;
}

export function normalizeComputedLength(property, value) {
  if (!LENGTH_PROPS.has(property) && property !== 'line-height') return value;
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(px)$/i.exec(value);
  return match ? `${Number(Number(match[1]).toPrecision(6))}${match[2]}` : value;
}

export function resolveViewportLength(property, value, width, height) {
  if (property !== 'line-height' && !LENGTH_PROPS.has(property)) return value;
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(vw|vh|vmin|vmax)$/i.exec(value);
  if (!match) return value;
  let dimension;
  switch (match[2].toLowerCase()) {
    case 'vw': dimension = width; break;
    case 'vh': dimension = height; break;
    case 'vmin': dimension = Math.min(width, height); break;
    case 'vmax': dimension = Math.max(width, height); break;
  }
  const pixels = Number(match[1]) * dimension / 100;
  return Number.isFinite(pixels) ? `${pixels}px` : value;
}

export function normalizeCssCommas(value) {
  let out = '', quote = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    out += ch;
    if (ch === '\\') { if (i + 1 < value.length) out += value[++i]; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ',') {
      out += ' ';
      while (/\s/.test(value[i + 1] || '') && i + 1 < value.length) i++;
    }
  }
  return out;
}

export function normalizeBackgroundImage(value) {
  const normalized = value.replace(/url\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)')\s*\)/gi, (_, double, single) => {
    const decoded = (double ?? single).replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (_, escape) => {
      if (/^[0-9a-fA-F]/.test(escape)) {
        const point = parseInt(escape, 16);
        return point === 0 || point > 0x10ffff ? '\ufffd' : String.fromCodePoint(point);
      }
      return /[\n\r\f]/.test(escape) ? '' : escape;
    });
    const escaped = decoded.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\00000a').replace(/\r/g, '\\00000d').replace(/\f/g, '\\00000c');
    return `url("${escaped}")`;
  });
  return normalizeCssCommas(normalized);
}

export function backgroundImage(value) {
  const text = value.trim();
  if (canonicalizeColor(text, true) || /^currentcolor$/i.test(text)) return 'none';
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const image = /^(?:url|image-set|(?:repeating-)?(?:linear|radial|conic)-gradient)\(/i.exec(rest);
    if (image) {
      index += image[0].length;
      let depth = 1, quote = '';
      while (index < text.length && depth) {
        const character = text[index++];
        if (character === '\\') { index++; continue; }
        if (quote) { if (character === quote) quote = ''; continue; }
        if (character === '"' || character === "'") quote = character;
        else if (character === '(') depth++;
        else if (character === ')') depth--;
      }
      if (depth || quote) return undefined;
    } else if (/^none\b/i.test(rest)) index += 4;
    else return undefined;
    while (/\s/.test(text[index] || '') && index < text.length) index++;
    if (index === text.length) return text;
    if (text[index++] !== ',') return undefined;
    while (/\s/.test(text[index] || '') && index < text.length) index++;
  }
  return undefined;
}

export function splitDeclarations(text) {
  const declarations = [];
  let start = 0, quote = '', depth = 0, prefix = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      prefix += text.slice(start, i);
      const colon = prefix.indexOf(':');
      const customValue = colon !== -1 && prefix.slice(0, colon).trim().startsWith('--');
      const end = text.indexOf('*/', i + 2);
      const commentEnd = end === -1 ? text.length : end + 2;
      prefix += customValue ? text.slice(i, commentEnd) : ' ';
      i = commentEnd - 1;
      start = commentEnd;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      declarations.push(prefix + text.slice(start, i));
      prefix = '';
      start = i + 1;
    }
  }
  declarations.push(prefix + text.slice(start));
  return declarations;
}
