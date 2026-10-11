import type { PDFPageProxy } from 'pdfjs-dist'

type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Item = Extract<Content['items'][number], { str: string }>

// Read a detached Latin dieresis only after both PDFs prove that its native
// font, matrix and position relative to its vowel and link moved together.
export function verifiedPdfLatinAccentText(
  original: Content,
  target: Content,
  before: Item[],
  after: Item[],
  sourceRect: readonly number[],
  targetRect: readonly number[]
): Map<Item, string> {
  const pairs = (items: Item[]): Array<{ mark: Item; base: Item }> =>
    items.flatMap((mark, index) => {
      const base = items[index + 1],
        size = mark.transform[3]
      if (
        mark.str.trim() !== '¨' ||
        !base ||
        !(size > 0) ||
        !mark.fontName ||
        mark.fontName !== base.fontName ||
        !/^[AEIOUYaeiouy]/u.test(base.str) ||
        [mark, base].some(
          (item) =>
            item.transform.some((value) => !Number.isFinite(value)) ||
            Math.abs(item.transform[1]) > 0.001 ||
            Math.abs(item.transform[2]) > 0.001
        ) ||
        Math.abs(size - base.transform[3]) > 0.001 ||
        !(mark.width > 0) ||
        mark.width >= size * 0.45 ||
        mark.transform[4] < base.transform[4] ||
        mark.transform[4] - base.transform[4] >= size * 0.1 ||
        Math.abs(mark.transform[5] - base.transform[5]) >= size * 0.1
      )
        return []
      return [{ mark, base }]
    })
  const from = pairs(before),
    to = pairs(after),
    result = new Map<Item, string>()
  if (
    !from.length ||
    from.length !== to.length ||
    from.length !== before.filter((item) => item.str.trim() === '¨').length ||
    to.length !== after.filter((item) => item.str.trim() === '¨').length
  )
    return result
  for (const [index, pair] of from.entries()) {
    const moved = to[index]
    if (
      pair.base.str[0] !== moved.base.str[0] ||
      [pair.mark, pair.base].some((item, part) => {
        const other = part ? moved.base : moved.mark
        const sameText = item.str === other.str
        return (
          // PDF.js may split the following citation year into another run.
          // Keep the complete vowel word; equal runs also keep their width.
          (!sameText &&
            (!part ||
              item.str.match(/^[A-Za-z]+/u)?.[0] !== other.str.match(/^[A-Za-z]+/u)?.[0])) ||
          [item.width, other.width, item.height, other.height].some(
            (value) => !Number.isFinite(value)
          ) ||
          (sameText && Math.abs(item.width - other.width) > 0.001) ||
          Math.abs(item.height - other.height) > 0.001 ||
          !original.styles[item.fontName] ||
          JSON.stringify(original.styles[item.fontName]) !==
            JSON.stringify(target.styles[other.fontName]) ||
          item.transform
            .slice(0, 4)
            .some((value, axis) => Math.abs(value - other.transform[axis]) > 0.001) ||
          [0, 1].some(
            (axis) =>
              Math.abs(
                other.transform[4 + axis] -
                  item.transform[4 + axis] -
                  targetRect[axis] +
                  sourceRect[axis]
              ) > 0.01
          )
        )
      })
    )
      return new Map()
  }
  for (const { mark, base } of [...from, ...to]) {
    result.set(mark, '')
    result.set(base, (base.str[0] + '\u0308').normalize('NFC') + base.str.slice(1))
  }
  return result
}
