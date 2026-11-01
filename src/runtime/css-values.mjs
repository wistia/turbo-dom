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
