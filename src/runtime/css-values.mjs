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
const COMPOUND_LENGTH_PROPS = new Set(['margin', 'padding', 'border-width', 'border-spacing']);
const ZERO_NUMBER = /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?$/i;
const ZERO_LENGTH = /(^|\s)[+-]?(?:0+(?:\.0*)?|\.0+)(?:e[+-]?\d+)?(?=$|\s)/gi;

export function normalizeZeroLengths(property, value) {
  if (!LENGTH_PROPS.has(property)) return value;
  const trimmed = value.trim();
  if (!COMPOUND_LENGTH_PROPS.has(property)) return ZERO_NUMBER.test(trimmed) ? '0px' : trimmed;
  if (/[()'\"]/.test(trimmed)) return trimmed;
  return trimmed.replace(ZERO_LENGTH, (_, separator) => `${separator}0px`);
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
