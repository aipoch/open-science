import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'

it.each([
  'native',
  'repeated',
  'fallback-font',
  'changed-brand',
  'missing-mark',
  'extra-mark',
  'unowned-brand',
  'wide-mark',
  'off-row',
  'painted-alias'
])('keeps only a proven native registration glyph beside its complete brand: %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    bodyFont = await pdf.embedFont(StandardFonts.TimesRoman),
    markFont = await pdf.embedFont(
      kind === 'fallback-font' ? StandardFonts.Helvetica : StandardFonts.TimesRoman
    ),
    page = pdf.addPage([600, 800]),
    prefix = kind === 'unowned-brand' ? 'Supplement Else' : 'Supplement Brand',
    markText = kind === 'wide-mark' ? 'A' : '°',
    markX = 40 + bodyFont.widthOfTextAtSize(prefix, 12) + 1,
    markY = kind === 'off-row' ? 716 : kind === 'fallback-font' ? 695 : 697,
    registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'native-registration', surface: 'electron' })
  page.drawText(prefix, { font: bodyFont, size: 12, x: 40, y: 700 })
  page.drawText(markText, { font: markFont, size: 20, x: markX, y: markY })
  page.drawText(' was studied in adults.', {
    font: bodyFont,
    size: 12,
    x: markX + markFont.widthOfTextAtSize(markText, 20),
    y: 700
  })
  if (kind === 'repeated') {
    const left = 'Assessments from Brand',
      x = 40 + bodyFont.widthOfTextAtSize(left, 12) + 1
    page.drawText(left, { font: bodyFont, size: 12, x: 40, y: 682 })
    page.drawText(markText, { font: markFont, size: 20, x, y: 679 })
    page.drawText(' were consistent and follow-up was completed.', {
      font: bodyFont,
      size: 12,
      x: x + markFont.widthOfTextAtSize(markText, 20),
      y: 682
    })
  } else
    page.drawText('Assessments were consistent and all participants completed follow-up.', {
      font: bodyFont,
      size: 12,
      x: 40,
      y: 682
    })
  page.drawText('Neighbor 17', { font: bodyFont, size: 12, x: 40, y: 650 })
  await pdf.flush()
  const dict = pdf.context.lookup(markFont.ref, PDFDict)
  dict.set(
    PDFName.of('ToUnicode'),
    pdf.context.register(
      pdf.context.stream(
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /NativeMark def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <' +
          (markText === 'A' ? '41' : 'B0') +
          '> <00AE> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'
      )
    )
  )
  const source =
      (kind === 'painted-alias' ? prefix + '°' : prefix + '®') +
      (kind === 'repeated'
        ? ' was studied in adults. Assessments from Brand® were consistent and follow-up was completed.'
        : ' was studied in adults. Assessments were consistent and all participants completed follow-up.'),
    translation =
      kind === 'changed-brand'
        ? '成人研究了 Other®。评估结果一致，全部参与者完成随访。'
        : kind === 'missing-mark'
          ? '成人研究了 Brand。评估结果一致，全部参与者完成随访。'
          : kind === 'extra-mark'
            ? '成人研究了 Brand® 和 Brand®。评估结果一致，全部参与者完成随访。'
            : kind === 'repeated'
              ? '成人研究了 Brand®。Brand® 的评估结果一致，全部参与者完成随访。'
              : '成人研究了 Brand®。评估结果一致，全部参与者完成随访。'
  let originalTask: ReturnType<typeof getDocument> | undefined,
    targetTask: ReturnType<typeof getDocument> | undefined
  try {
    const original = await pdf.save(),
      request = new PdfTranslationWriter(() =>
        resolve('resources/pdf-translation/worker.mjs')
      ).generate(
        {
          id: 'native-registration',
          data: original,
          pages: [{ width: 600, height: 800 }],
          units: [
            {
              source,
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 38 / 600, y: 70 / 800, width: 520 / 600, height: 56 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
    if (!['native', 'repeated', 'fallback-font', 'off-row'].includes(kind)) {
      await expect(request).rejects.toMatchObject({
        failure: { code: 'annotations' }
      })
      return
    }
    const output = await request
    originalTask = getDocument({ data: original.slice() })
    targetTask = getDocument({ data: output!.slice() })
    const before = (
        await (await (await originalTask.promise).getPage(1)).getTextContent()
      ).items.filter((item) => 'str' in item),
      after = (await (await (await targetTask.promise).getPage(1)).getTextContent()).items.filter(
        (item) => 'str' in item
      ),
      originalMark = before.find((item) => item.str === '®')!,
      movedMark = after.find((item) => item.str === '®')!
    expect(originalMark).toBeDefined()
    if (kind === 'off-row') {
      // A distant separate row does not gain native registration ownership.
      // The existing ordinary-prose path may render a supported target glyph.
      expect(after.filter((item) => item.str === '®')).toHaveLength(0)
      expect(after.map((item) => item.str).join('')).toContain('Brand®')
      return
    }
    expect(movedMark).toBeDefined()
    expect(movedMark.transform.slice(0, 4)).toEqual(originalMark.transform.slice(0, 4))
    expect(movedMark.height).toEqual(originalMark.height)
    expect(movedMark.width).toBeCloseTo(originalMark.width, 3)
    expect(after.filter((item) => item.str === '®')).toHaveLength(kind === 'repeated' ? 2 : 1)
    expect(
      after
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toContain(translation.replace(/\s/gu, ''))
    expect(after.find((item) => item.str === 'Neighbor 17')?.transform.slice(4)).toEqual([40, 650])
  } finally {
    await originalTask?.destroy()
    await targetTask?.destroy()
    caller.release()
    registry.dispose()
  }
})
