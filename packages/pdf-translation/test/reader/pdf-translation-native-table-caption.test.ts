import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { nativeTableCaptionOwners } from '../../src/reader/native-table-caption.js'
import { getPdfTranslationTextContent } from '../../src/reader/text-content.js'
import type { PdfTranslationSource } from '../../src/reader/source.js'

async function fixture(fault = ''): Promise<{
  document: Awaited<ReturnType<typeof getDocument>['promise']>
  units: PdfTranslationSource['units']
}> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const dir = join(
      dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
      'standard_fonts'
    ),
    regular = await pdf.embedFont(await readFile(join(dir, 'LiberationSans-Regular.ttf')), {
      subset: false
    }),
    italic = await pdf.embedFont(await readFile(join(dir, 'LiberationSans-Italic.ttf')), {
      subset: false
    })
  const caption = (number: number): void => {
    const page = pdf.addPage([400, 500]),
      label = `Table ${number}:`,
      lead = 'Comparative record results.',
      body = ' Values remain comparable.',
      x = 40 + regular.widthOfTextAtSize(label, 10) + 3
    page.drawText(label, { x: 40, y: 430, size: 10, font: regular })
    page.drawText(lead, {
      x,
      y: 430,
      size: 10,
      font: fault === 'bibliographic-style' && number === 2 ? regular : italic
    })
    page.drawText(body, {
      x: x + italic.widthOfTextAtSize(lead, 10),
      y: 430,
      size: 10,
      font: regular
    })
    page.drawText('Across all evaluated conditions.', { x: 40, y: 419, size: 10, font: regular })
  }
  caption(1)
  const references = pdf.addPage([400, 500])
  references.drawText('References', { x: 40, y: 430, size: 12, font: regular })
  references.drawText('Anonymous bibliographic entry.', { x: 40, y: 410, size: 10, font: regular })
  caption(2)
  const appendix = pdf.getPages()[2]
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < (fault === 'no-table' ? 1 : 2); column++)
      appendix.drawText(String(10 + row + column), {
        x: 100 + column * 80,
        y: 380 - row * 15,
        size: 9,
        font: regular
      })
  appendix.drawText('A ADDITIONAL RESULTS', { x: 40, y: 280, size: 12, font: regular })
  appendix.drawText('Ordinary appendix prose follows.', { x: 40, y: 260, size: 10, font: regular })
  const document = await getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      isEvalSupported: false
    }).promise,
    units: PdfTranslationSource['units'][number][] = []
  for (let number = 1; number <= 3; number++) {
    const page = await document.getPage(number),
      content = await getPdfTranslationTextContent(page),
      selected = content.items.flatMap((i, index) =>
        'str' in i && i.str.trim() ? [{ item: i, index }] : []
      ),
      groups =
        number === 2
          ? selected.map((i) => [i])
          : [selected.slice(0, 4), ...selected.slice(4).map((i) => [i])]
    for (const group of groups) {
      const source = group
          .map((i) => i.item.str)
          .join(' ')
          .replace(/\s+/gu, ' ')
          .trim(),
        first = group[0].item,
        heading = source === 'A ADDITIONAL RESULTS'
      units.push({
        id: source.startsWith('Table')
          ? number === 1
            ? 'precedent'
            : 'caption'
          : `p${number}-${group[0].index}`,
        source,
        ...(number === 3 && !heading
          ? { sourceOnly: true as const, preserve: 'reference' as const }
          : {}),
        ...(heading && fault !== 'no-appendix' ? { referenceBoundary: true as const } : {}),
        fragments: [
          {
            pageNumber: number,
            rect: {
              x: first.transform[4] / 400,
              y: (500 - first.transform[5] - first.height) / 500,
              width: 0.8,
              height: group.length > 1 ? 0.05 : 0.03
            },
            items: group.map((i) => ({ index: i.index, text: i.item.str }))
          }
        ]
      })
    }
  }
  if (fault === 'no-precedent') units[0] = { ...units[0], sourceOnly: true }
  if (fault === 'changed-source') units.find((u) => u.id === 'caption')!.source += ' Invented.'
  return { document, units }
}

it.each(['', 'no-precedent', 'no-appendix', 'no-table', 'bibliographic-style', 'changed-source'])(
  'restores only the exact native caption between references and an appendix: %s',
  async (fault) => {
    const f = await fixture(fault),
      before = JSON.stringify(f.units)
    try {
      const owners = await nativeTableCaptionOwners(
        f.units,
        f.document,
        new AbortController().signal
      )
      expect([...owners]).toEqual(fault ? [] : ['caption'])
      expect(JSON.stringify(f.units)).toBe(before)
    } finally {
      await f.document.destroy()
    }
  }
)
