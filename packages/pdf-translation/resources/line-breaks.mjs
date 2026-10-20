/* eslint-disable @typescript-eslint/explicit-function-return-type -- Shared worker JavaScript. */
// Chinese prose can wrap inside a dictionary word, but a word segmenter also
// exposes breaks inside signed values, ranges and short scientific expressions.
// Keep those tokens together while fitting still measures actual glyph ink.
export function pdfTranslationLineEnds(text) {
  const ends = new Set(
    [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].map(
      (segment) => segment.index + segment.segment.length
    )
  )
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
  for (let index = 1; index < graphemes.length; index++)
    if (
      /^\p{Script=Han}$/u.test(graphemes[index - 1].segment) &&
      /^\p{Script=Han}$/u.test(graphemes[index].segment)
    )
      ends.add(graphemes[index].index)
  const number = '[+−-]?(?:\\d+(?:[.,]\\d+)*|[.,]\\d+)(?:[eE][+−-]?\\d+)?',
    identifier = '[A-Za-z\\p{Script=Greek}][A-Za-z\\p{Script=Greek}\\d_-]*',
    finiteSet = `\\{\\s*${number}(?:\\s*,\\s*${number}){0,7}\\s*\\}`,
    numericCitation =
      '(?:\\[(?:\\s*\\d{1,4}(?:\\s*[–—-]\\s*\\d{1,4})?(?:\\s*,\\s*\\d{1,4}(?:\\s*[–—-]\\s*\\d{1,4})?)*\\s*)\\]|[（(](?:\\s*\\d{1,4}(?:\\s*[–—-]\\s*\\d{1,4})?(?:\\s*,\\s*\\d{1,4}(?:\\s*[–—-]\\s*\\d{1,4})?)*\\s*)[）)])',
    numericCitationAtStart = new RegExp(`^${numericCitation}`, 'u'),
    protectedSpans = [
      /第\s*(?:\d+|[A-Za-z][.．]\d+)(?:[.．]\d+)*\s*[节節]/gu,
      new RegExp(number, 'gu'),
      new RegExp(`${number}\\s*[±∓–−-]\\s*${number}`, 'gu'),
      new RegExp(`(?:${number}|${identifier})\\s*[+−±∓×÷-]\\s*(?:${number}|${identifier})`, 'gu'),
      new RegExp(`${number}\\s*[×⋅·]\\s*10\\s*(?:[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+|\\^?\\s*[+−-]?\\d+)`, 'gu'),
      /[A-Za-z\p{Script=Greek}\d]+(?:[-‐‑][A-Za-z\p{Script=Greek}\d]+)+/gu,
      new RegExp(`${identifier}[-‐‑]\\p{Script=Han}`, 'gu'),
      new RegExp(
        `${identifier}\\s*[∈∉]\\s*${finiteSet}(?:[A-Za-z\\p{Script=Greek}](?:×[A-Za-z\\p{Script=Greek}])?)?`,
        'gu'
      ),
      new RegExp(`${identifier}\\s*[=<>≤≥≈≠]\\s*(?:${number}|${identifier}|\\p{Script=Han})`, 'gu'),
      // Keep numeric citations together. A line break inside or immediately
      // before a citation leaves markers such as `[8–10]` stranded on their
      // own line in narrow translated columns.
      new RegExp(numericCitation, 'gu')
    ].flatMap((pattern) =>
      [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length])
    )
  const admitted = [...ends]
    .sort((a, b) => a - b)
    .filter(
      (end) =>
        !protectedSpans.some(([start, stop]) => end > start && end < stop) &&
        !/[+−\-±∓×÷=<>≤≥≈≠]$/u.test(text.slice(0, end).trimEnd()) &&
        !/[（(［[｛{《「『【“‘]$/u.test(text.slice(0, end).trimEnd()) &&
        !(/[.,]$/u.test(text.slice(0, end)) && /^\d/u.test(text.slice(end))) &&
        !/^[，。！？；：、,.;:!?）)］\]｝}》」』】”’％%]/u.test(text.slice(end).trimStart()) &&
        !(
          /[\p{L}\p{N}）)]$/u.test(text.slice(0, end).trimEnd()) &&
          numericCitationAtStart.test(text.slice(end).trimStart())
        )
    )
  if (!admitted.includes(text.length)) admitted.push(text.length)
  return admitted
}
