import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts, PDFName, PDFString } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  normalizedNativeText,
  normalizedText,
  verifyPdfUnits,
  verifiedNumericFractionItems
} from './pdf-translation-native-verification'
import { readPdfTranslationCases } from './fixtures/pdf-translation/read-cases'

it.each(
  readPdfTranslationCases<{
    name: string
    items: Parameters<typeof normalizedNativeText>[0]
    expected: string
  }>('native-macron-position-verification.jsonl')
)(
  'verifies complete text only with a uniquely positioned native macron: $name',
  ({ items, expected }) => {
    expect(normalizedNativeText(items)).toBe(normalizedText(expected))
  }
)

it.each(
  readPdfTranslationCases<{ name: string; pngBase64: string; expected: boolean }>(
    'native-fraction-verification-roundtrip.jsonl'
  )
)(
  'inspects actual native fraction glyphs and bitmap ink: $name',
  async ({ pngBase64, expected }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.TimesRoman),
      image = await pdf.embedPng(Buffer.from(pngBase64, 'base64')),
      page = pdf.addPage([600, 800]),
      prefix = 'The controlled ratio is ',
      x = 40 + font.widthOfTextAtSize(prefix, 10),
      width = font.widthOfTextAtSize('4', 7)
    page.drawText(prefix, { x: 40, y: 500, size: 10, font })
    page.drawText('4', { x, y: 503.5, size: 7, font })
    page.drawImage(image, { x, y: 501.5, width: width + 0.4, height: 0.5 })
    page.drawText('7', { x, y: 496.5, size: 7, font })
    page.drawText('.', { x: x + width + 2, y: 500, size: 10, font })
    const loading = getDocument({ data: await pdf.save(), useSystemFonts: true })
    try {
      const document = await loading.promise,
        [result] = await verifyPdfUnits(
          document,
          [
            {
              sourceIndex: 0,
              source: 'The controlled ratio is 4/7.',
              translation: 'The controlled ratio is 4/7.',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 40 / 600, y: 280 / 800, width: 400 / 600, height: 40 / 800 }
                }
              ]
            }
          ],
          []
        )
      expect(result.translationFound).toBe(expected)
    } finally {
      await loading.destroy()
    }
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    items: Parameters<typeof verifiedNumericFractionItems>[0]
    ink: Parameters<typeof verifiedNumericFractionItems>[1]
    rules: number[][]
    source: string
    translation: string
    expected: string
  }>('native-fraction-placement-proof.jsonl')
)(
  'verifies native numeric fraction placement: $name',
  ({ items, ink, rules, source, translation, expected }) => {
    expect(
      normalizedNativeText(verifiedNumericFractionItems(items, ink, rules, source, translation))
    ).toBe(expected)
  }
)

it('requires translated text in the owned fragments, not merely elsewhere on the page', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([600, 800])
  page.drawText('Repeated label', { x: 350, y: 700, size: 10, font })
  const loading = getDocument({ data: await pdf.save(), useSystemFonts: true })
  try {
    const document = await loading.promise
    const result = await verifyPdfUnits(
      document,
      [40, 340].map((x, sourceIndex) => ({
        sourceIndex,
        translation: 'Repeated label',
        fragments: [
          { pageNumber: 1, rect: { x: x / 600, y: 85 / 800, width: 150 / 600, height: 30 / 800 } }
        ]
      })),
      []
    )
    expect(result.map((entry) => entry.translationFound)).toEqual([false, true])
  } finally {
    await loading.destroy()
  }
})

it.each(['empty', 'text', 'link'] as const)(
  'verifies aligned rows without accepting an intervening %s object',
  async (gap) => {
    const original = await PDFDocument.create(),
      font = await original.embedFont(StandardFonts.Helvetica),
      page = original.addPage([600, 800])
    page.drawText('First source row', { x: 40, y: 627, size: 10, font })
    page.drawText('Second source row', { x: 40, y: 609.4, size: 10, font })
    if (gap === 'text') page.drawText('Gap', { x: 50, y: 622.7, size: 1, font })
    if (gap === 'link') {
      const annotation = original.context.register(
        original.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [50, 622.7, 60, 623.7],
          A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.org') }
        })
      )
      page.node.set(PDFName.of('Annots'), original.context.obj([annotation]))
    }
    const target = await PDFDocument.create(),
      targetFont = await target.embedFont(StandardFonts.Helvetica)
    target
      .addPage([600, 800])
      .drawText('Repeated label', { x: 40, y: 618.2, size: 10, font: targetFont })
    const sourceLoading = getDocument({ data: await original.save(), useSystemFonts: true }),
      targetLoading = getDocument({ data: await target.save(), useSystemFonts: true })
    try {
      const results = await verifyPdfUnits(
        await targetLoading.promise,
        [
          {
            sourceIndex: 0,
            translation: 'Repeated label',
            fragments: [0.2, 0.222].map((y) => ({
              pageNumber: 1,
              rect: { x: 40 / 600, y, width: 150 / 600, height: 0.02 }
            }))
          }
        ],
        [],
        await sourceLoading.promise
      )
      expect(results[0].translationFound).toBe(gap === 'empty')
    } finally {
      await sourceLoading.destroy()
      await targetLoading.destroy()
    }
  }
)

const hat = { str: 'ˆ', width: 5, transform: [10, 0, 0, 10, 102, 203] }
const base = { str: 'Q', width: 9, transform: [10, 0, 0, 10, 100, 200] }

describe('native accent placement verification', () => {
  it('keeps all target characters while reordering a uniquely placed spacing hat', () => {
    expect(normalizedNativeText([{ str: '其中' }, hat, { str: ' ' }, base])).toBe('其中Qˆ')
  })

  it('retains the existing isolated combining-accent text order', () => {
    expect(normalizedNativeText([{ str: '\u0302' }, { str: 'Q' }])).toBe('Q\u0302')
  })

  it.each([
    ['missing hat matrix', { ...hat, transform: undefined }, base],
    ['missing base matrix', hat, { ...base, transform: undefined }],
    ['nonfinite hat', { ...hat, transform: [10, 0, 0, 10, NaN, 203] }, base],
    ['short base matrix', hat, { ...base, transform: [10, 0, 0, 10] }],
    ['rotated hat', { ...hat, transform: [10, 1, 0, 10, 102, 203] }, base],
    ['rotated base', hat, { ...base, transform: [10, 0, 1, 10, 100, 200] }],
    ['different sizes', hat, { ...base, transform: [9, 0, 0, 9, 100, 200] }],
    ['ordinary inline hat', { ...hat, transform: [10, 0, 0, 10, 102, 200] }, base],
    ['hat on a different row', { ...hat, transform: [10, 0, 0, 10, 102, 220] }, base],
    ['hat outside the base', { ...hat, transform: [10, 0, 0, 10, 120, 203] }, base],
    ['missing hat width', { ...hat, width: undefined }, base],
    ['negative base width', hat, { ...base, width: -9 }],
    ['multiple-letter base', hat, { ...base, str: 'QR' }]
  ])('does not reorder %s', (_name, mark, letter) => {
    expect(normalizedNativeText([mark, letter])).toBe('ˆ' + letter.str)
  })

  it('rejects coincident candidate bases', () => {
    expect(normalizedNativeText([hat, base, { ...base, str: 'K' }])).toBe('ˆQK')
  })

  it('keeps native candidates immutable after verifying an earlier hat', () => {
    const earlierBase = { ...base, width: 8 },
      laterBase = { ...base, str: 'K', transform: [10, 0, 0, 10, 107, 200] },
      laterHat = { ...hat, transform: [10, 0, 0, 10, 105, 203] }
    expect(normalizedNativeText([hat, earlierBase, laterHat, laterBase])).toBe('QˆˆK')
  })

  it('does not move a hat past intervening prose or a different native base', () => {
    expect(
      normalizedNativeText([hat, { ...base, str: 'R', transform: [10, 0, 0, 10, 120, 200] }, base])
    ).toBe('ˆRQ')
    expect(normalizedNativeText([hat, { str: '和' }, base])).toBe('ˆ和Q')
  })
})
