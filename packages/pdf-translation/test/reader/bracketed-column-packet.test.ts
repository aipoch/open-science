import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'

it.each([
  'closed citations',
  'number gap',
  'ordinary note',
  'inserted note',
  'independent columns',
  'missing pages',
  'volume and page numbers',
  'ordinary timestamp'
] as const)(
  'preserves a terminal bibliography ending across the column turn (%s)',
  async (shape) => {
    const require = createRequire(import.meta.url)
    const assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
    const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
    const first = pdf.addPage([600, 800])
    const page = pdf.addPage([600, 800])
    const prose = 'The observed values matched the independent measurements.'
    first.drawText(prose, { font, size: 11, x: 54, y: 705 })
    first.drawText('[3] R. Writer, Earlier field observations,', { font, size: 9, x: 320, y: 181 })
    first.drawText(
      shape === 'volume and page numbers' || shape === 'ordinary timestamp'
        ? 'Field Reports, 17:77, 2014.'
        : 'Field Reports 17, 77 (2014).',
      { font, size: 9, x: 336, y: 170 }
    )
    const row = (value: string, x: number, y: number): void => {
      page.drawText(value, { font, size: 9, x, y })
    }
    const periodical = shape === 'volume and page numbers' || shape === 'ordinary timestamp'
    const separateColumns =
      shape === 'independent columns' || shape === 'missing pages' || periodical
    const protectedPacket =
      shape === 'closed citations' ||
      shape === 'independent columns' ||
      shape === 'volume and page numbers'
    const conference =
      shape === 'missing pages'
        ? 'Conference Papers (2018) pp.'
        : shape === 'ordinary timestamp'
          ? 'The sample was logged at 12:31, 2018.'
          : periodical
            ? 'Field Reports, 12(3):31–35, 2018.'
            : 'Conference Papers (2018) pp. 31–35.'
    const tail = 'field records 25, 108 (2017).'
    row('2', 548, 765)
    for (let number = 4; number <= 7; number++) {
      const y = 727 - (number - 4) * 22
      row(`[${number}] A. Reader, Survey methods and their limitations,`, 54, y)
      if (number < 7 || separateColumns)
        row(
          periodical ? 'Field Reports, 12(3):31–35, 2015.' : 'Field Reports 12, 31 (2015).',
          70,
          y - 11
        )
    }
    if (shape === 'inserted note') row('read more.', 336, 727)
    if (!separateColumns)
      row(
        shape === 'ordinary note' ? 'A separate note gives directions.' : tail,
        336,
        shape === 'inserted note' ? 716 : 727
      )
    for (let number = 8; number <= 11; number++) {
      const y = (separateColumns ? 727 : shape === 'inserted note' ? 705 : 716) - (number - 8) * 22
      const marker = shape === 'number gap' && number === 9 ? 12 : number
      row(`[${marker}] B. Editor, Comparison of complete survey results,`, 320, y)
      row(
        separateColumns && number === 8
          ? conference
          : periodical
            ? 'Study Review, 22:65, 2019.'
            : 'Study Review 22, 65 (2019).',
        336,
        y - 11
      )
    }

    const open = (data: Uint8Array): ReturnType<typeof getDocument> =>
      getDocument({
        data,
        fontExtraProperties: true,
        disableFontFace: true,
        standardFontDataUrl: assets
      })
    const loading = open(await pdf.save())
    try {
      const { source, coverage } = await extractPdfTranslationSource({
        document: await loading.promise,
        resourceRequestKey: 'synthetic',
        nativeDocumentFactory: ({ data }) => open(data),
        signal: new AbortController().signal
      })
      const gutter = source.units.find(({ source }) =>
        source.includes(
          separateColumns ? conference : shape === 'ordinary note' ? 'A separate note' : tail
        )
      )
      expect(gutter).toBeDefined()
      expect(gutter?.sourceOnly === true).toBe(protectedPacket)
      if (protectedPacket) {
        expect(
          source.units
            .filter((unit) => unit.fragments.some((fragment) => fragment.pageNumber === 2))
            .every((unit) => unit.sourceOnly)
        ).toBe(true)
      }
      expect(source.units.find(({ source }) => source.includes(prose))?.sourceOnly).toBeUndefined()
      expect(coverage.excludedItemCount).toBe(0)
    } finally {
      await loading.destroy()
    }
  }
)
