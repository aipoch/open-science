import type { PDFPageProxy } from 'pdfjs-dist'

// Legacy Dingbats encodings can expose glyph slots 51/55 as digits even
// though both the font and the rendered page contain check/cross marks.
// Resolve only those isolated runs in that named font, never ordinary digits.
// txsys slot 2 is multiplication. Its named font and 636-unit advance
// distinguish it from unrelated control-code encodings in other math fonts.
export async function getPdfTranslationTextContent(
  page: PDFPageProxy
): ReturnType<PDFPageProxy['getTextContent']> {
  const content = await page.getTextContent()
  const fonts = new Set(
    content.items.flatMap((item) =>
      'str' in item && (/^[37]$/u.test(item.str) || item.str === '\u0002') ? [item.fontName] : []
    )
  )
  if (!fonts.size || !page.commonObjs) return content
  if ([...fonts].some((font) => !page.commonObjs.has(font))) await page.getOperatorList()
  const dingbats = new Set(
    [...fonts].filter(
      (font) =>
        page.commonObjs.has(font) &&
        /^(?:[A-Z]{6}\+)?(?:Zapf)?Dingbats$/u.test(page.commonObjs.get(font)?.name ?? '')
    )
  )
  return {
    ...content,
    items: content.items.map((item) => {
      if (!('str' in item)) return item
      if (dingbats.has(item.fontName) && /^[37]$/u.test(item.str))
        return { ...item, str: item.str === '3' ? '✓' : '✗' }
      if (
        item.str === '\u0002' &&
        page.commonObjs.has(item.fontName) &&
        item.transform[0] > 0 &&
        item.transform[1] === 0 &&
        item.transform[2] === 0 &&
        Math.abs(item.width / item.transform[0] - 0.636) < 0.0001 &&
        /^(?:[A-Z]{6}\+)?txsys$/u.test(page.commonObjs.get(item.fontName)?.name ?? '')
      )
        return { ...item, str: '×' }
      return item
    })
  }
}
