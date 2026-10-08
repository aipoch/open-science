import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { PDFDocument, PDFName, PDFRef, PDFString, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'

it.each([
  'repeated',
  'different-authors',
  'localized-parentheses',
  'wrong-year',
  'wrong-suffix',
  'missing',
  'extra',
  'reordered-authors',
  'unclosed',
  'bare-year'
])('binds native year-suffix links to complete author citations: %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    links: PDFRef[] = [],
    secondAuthor = ['different-authors', 'reordered-authors'].includes(kind) ? 'Quinn' : 'Mern',
    source = `Based on Mern et al. (2006a), the first result is stable. We also follow ${secondAuthor} et al. (2006a), and the second result is consistent.`,
    registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'native-year-suffix', surface: 'electron' })
  for (const [row, author] of ['Mern', secondAuthor].entries()) {
    let x = 40
    const y = 700 - row * 18
    for (const [text, linked] of [
      [row ? 'We also follow ' : 'Based on ', false],
      [author + ' et al.', true],
      [' (', false],
      ['2006a', true],
      [row ? '), and the second result is consistent.' : '), the first result is stable.', false]
    ] as const) {
      page.drawText(text, { font, size: 12, x, y })
      const width = font.widthOfTextAtSize(text, 12)
      if (linked)
        links.push(
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [x, y - 2, x + width, y + 12],
              Border: [0, 0, 0],
              A: { S: 'URI', URI: PDFString.of(`https://example.invalid/${author}/2006a`) }
            })
          )
        )
      x += width
    }
  }
  page.drawText('Neighbor 17', { font, size: 12, x: 40, y: 650 })
  page.node.set(PDFName.of('Annots'), pdf.context.obj(links))
  let translation = `首先依据 Mern et al. (2006a)，结果稳定。我们也遵循 ${secondAuthor} et al. (2006a)，第二项结果一致。`
  if (kind === 'localized-parentheses')
    translation = translation.replaceAll('(', '（').replaceAll(')', '）')
  if (kind === 'wrong-year') translation = translation.replace('2006a', '2007a')
  if (kind === 'wrong-suffix') translation = translation.replace('2006a', '2006b')
  if (kind === 'missing') translation = '首先依据 Mern et al. (2006a)，两项结果均一致。'
  if (kind === 'extra') translation += '其他结果也依据 Mern et al. (2006a)。'
  if (kind === 'reordered-authors')
    translation =
      '首先依据 Quinn et al. (2006a)，结果稳定。我们也遵循 Mern et al. (2006a)，第二项结果一致。'
  if (kind === 'unclosed') translation = translation.replace('(2006a)', '(2006a')
  if (kind === 'bare-year')
    translation = '依据 Mern et al. 2006a 和 Mern et al. 2006a，结果均一致。'
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const request = new PdfTranslationWriter(() =>
      resolve('resources/pdf-translation/worker.mjs')
    ).generate(
      {
        id: 'native-year-suffix',
        data: await pdf.save(),
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 38 / 600, y: 84 / 800, width: 520 / 600, height: 38 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (!['repeated', 'different-authors', 'localized-parentheses'].includes(kind)) {
      await expect(request).rejects.toMatchObject({ failure: { code: 'annotations' } })
      return
    }
    task = getDocument({ data: (await request)!.slice() })
    const outputPage = await (await task.promise).getPage(1),
      items = (await outputPage.getTextContent()).items.filter((item) => 'str' in item),
      annotations = await outputPage.getAnnotations()
    expect(annotations.map((annotation) => annotation.url)).toEqual([
      'https://example.invalid/Mern/2006a',
      'https://example.invalid/Mern/2006a',
      `https://example.invalid/${secondAuthor}/2006a`,
      `https://example.invalid/${secondAuthor}/2006a`
    ])
    expect(items.filter((item) => item.str === '2006a')).toHaveLength(2)
    expect(items.find((item) => item.str === 'Neighbor 17')?.transform.slice(4)).toEqual([40, 650])
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toContain(translation.replace(/\s/gu, ''))
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})
