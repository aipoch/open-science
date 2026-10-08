/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled worker helper. */
// CMSY's legacy slot 107 is a norm delimiter, although PDFium may report k.
// Require that specific font and narrow, tall ink; prose/italic k stays a letter.
export const nativeMathSymbolText = (object, fontName) => {
  const [left, bottom, right, top] = object.bounds
  // CMSY slots 104/105 are left/right angle delimiters. PDFium may expose
  // their legacy h/i codes. Admit only an isolated glyph in that exact font,
  // with the narrow, tall delimiter ink; ordinary Latin/italic letters stay literal.
  if (
    /^[hi]$/u.test(object.text.trim()) &&
    /^(?:[A-Z]{6}\+)?CMSY(?:5|6|7|8|9|10|12)$/u.test(fontName) &&
    right > left &&
    top - bottom > (right - left) * 3
  )
    return object.text.replace(/[hi]/u, (letter) => (letter === 'h' ? '〈' : '〉'))
  // CMSY's prime glyph uses slot 48; PDFium can expose that slot as digit 0.
  // The named math font and narrow prime ink distinguish it from a real zero.
  if (
    object.text.trim() === '0' &&
    /^(?:[A-Z]{6}\+)?CMSY(?:5|6|7|8|9|10|12)$/u.test(fontName) &&
    right > left &&
    top - bottom > (right - left) * 1.5
  )
    return object.text.replace('0', '′')
  if (
    /^[pQP]$/u.test(object.text.trim()) &&
    /^(?:[A-Z]{6}\+)?CMEX(?:7|8|9|10|12)$/u.test(fontName) &&
    right > left &&
    top - bottom > right - left
  )
    return object.text.replace(/[pQP]/u, (letter) => ({ p: '√', Q: '∏', P: '∑' })[letter])
  return /^[k·∇≥≤\s]+$/u.test(object.text) &&
    /^(?:[A-Z]{6}\+)?CMSY(?:7|8|9|10|12)$/u.test(fontName) &&
    right > left &&
    (object.text.trim() !== 'k' || top - bottom > (right - left) * 3)
    ? object.text.replaceAll('k', '‖')
    : object.text
}

// OMS/CMSY encodes A–Z as the calligraphic Latin alphabet. Keep the native
// object, never repaint that alphabet using the translation font. Lowercase
// and digit slots belong to unrelated symbols and are deliberately excluded.
export const nativeMathAlphabet = (object, fontName) =>
  /^(?:[A-Z]{6}\+)?CMSY(?:5|6|7|8|9|10|12)$/u.test(fontName) &&
  /^(?:[\p{Sm}]\s*)?[A-Z]$/u.test(object.text.trim()) &&
  object.bounds[2] > object.bounds[0] &&
  object.bounds[3] > object.bounds[1]

// MSAM's intercal/transpose slot can be exposed as a pipe by PDFium while
// PDF.js reads a raised T. This proves an unchanged source spelling only:
// require both native script levels around an exact source identifier.
export const nativeTransposeSourceIndices = (objects, source) => {
  const result = []
  for (let index = 1; index < objects.length - 1; index++) {
    const base = objects[index - 1],
      marker = objects[index],
      sub = objects[index + 1]
    if (
      !/^[A-Za-z]$/u.test(base.text.trim()) ||
      marker.text.trim() !== '|' ||
      !/^[a-z]$/u.test(sub.text.trim()) ||
      !/^(?:[A-Z]{6}\+)?MSAM(?:5|6|7|8|9|10|12)$/u.test(marker.fontName) ||
      ![base, sub].every((object) =>
        /^(?:[A-Z]{6}\+)?CMMIB?(?:5|6|7|8|9|10|12)$/u.test(object.fontName)
      ) ||
      !source.includes(`${base.text.trim()}ᵀ${sub.text.trim()}`) ||
      ![base, marker, sub].every(
        (object) =>
          [object.size, object.baseline, ...object.bounds].every(Number.isFinite) &&
          object.size > 0 &&
          object.bounds[2] > object.bounds[0] &&
          object.bounds[3] > object.bounds[1]
      ) ||
      !(marker.size >= base.size * 0.5 && marker.size < base.size * 0.9) ||
      Math.abs(sub.size - marker.size) > base.size * 0.02 ||
      marker.baseline - base.baseline < base.size * 0.2 ||
      marker.baseline - base.baseline > base.size * 0.6 ||
      base.baseline - sub.baseline < base.size * 0.1 ||
      base.baseline - sub.baseline > base.size * 0.4 ||
      marker.bounds[0] < base.bounds[2] - base.size * 0.1 ||
      marker.bounds[0] - base.bounds[2] > base.size * 0.4 ||
      Math.abs(marker.bounds[0] - sub.bounds[0]) > base.size * 0.15 ||
      marker.i !== base.i + 1 ||
      sub.i !== marker.i + 1
    )
      continue
    result.push(marker.i)
  }
  return result
}
