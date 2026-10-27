/* eslint-disable @typescript-eslint/explicit-function-return-type -- Shared worker JavaScript. */

// A complete unchanged paragraph identifies an occurrence without interpreting
// its label. In particular, this does not assign semantic identity to numbers.
export function literalSourceIdentity(source, translation, label, offset) {
  if (
    typeof source !== 'string' ||
    typeof translation !== 'string' ||
    typeof label !== 'string' ||
    !source.trim() ||
    !label ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    source.length > 32768 ||
    translation.length > 65536 ||
    source === translation
  )
    return
  const end = offset + label.length,
    splitsPair = (position) =>
      position > 0 &&
      position < source.length &&
      /[\uD800-\uDBFF]/u.test(source[position - 1]) &&
      /[\uDC00-\uDFFF]/u.test(source[position])
  if (
    splitsPair(offset) ||
    splitsPair(end) ||
    source.slice(offset, end) !== label ||
    source.indexOf(label) !== offset ||
    source.indexOf(label, offset + 1) !== -1
  )
    return
  const start = translation.indexOf(source)
  if (start < 0 || translation.indexOf(source, start + 1) !== -1) return
  return { start: start + offset, text: label }
}
