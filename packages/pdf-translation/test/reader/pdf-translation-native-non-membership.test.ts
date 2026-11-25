import type { PDFPageProxy } from 'pdfjs-dist'
import { expect, it, vi } from 'vitest'
import { getPdfTranslationTextContent } from '../../src/reader/text-content.js'

it.each([
  ['explicit glyph name', 'nelement', {}, 5.36, '∉'],
  ['ordinary less-than', 'less', {}, 5.36, '<'],
  ['explicit Unicode value', 'nelement', { 60: '<' }, 5.36, '<'],
  ['different advance', 'nelement', {}, 5.64, '<']
] as const)(
  'decodes non-membership only with matching native evidence (%s)',
  async (_case, glyphName, map, width, expected) => {
    const item = {
      str: '<',
      dir: 'ltr',
      width,
      height: 10,
      transform: [10, 0, 0, 10, 110, 230],
      hasEOL: false,
      fontName: 'operator'
    }
    const companion = { ...item, str: 'holds', fontName: 'body' }
    const content = { items: [item, companion] }
    const font = {
      name: 'ABCDEF+txsyc',
      type: 'Type1',
      subtype: 'Type1C',
      composite: false,
      missingFile: false,
      isInvalidPDFjsFont: false,
      systemFontInfo: null,
      defaultEncoding: { 60: 'less' },
      differences: { 60: glyphName },
      widths: { 60: 536 },
      toFontChar: { 60: 0xe03c },
      toUnicode: { _map: map }
    }
    const objects = new Map()
    const page = {
      getTextContent: vi.fn().mockResolvedValue(content),
      commonObjs: objects,
      getOperatorList: vi.fn(async () => {
        objects.set('operator', font)
      })
    }
    const corrected = await getPdfTranslationTextContent(page as unknown as PDFPageProxy)
    expect(corrected.items).toEqual([{ ...item, str: expected }, companion])
    expect(corrected.items[1]).toBe(companion)
    expect(item.str).toBe('<')
  }
)
