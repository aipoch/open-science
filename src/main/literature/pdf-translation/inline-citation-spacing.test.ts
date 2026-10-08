import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'

it.each([
  'next-row',
  'same-row',
  'dated-citation',
  'numeric-bracket',
  'separate-paragraph',
  'changed-year'
])('keeps inline citations compact only inside a dense owned paragraph: %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    linkFont = await pdf.embedFont(StandardFonts.HelveticaOblique),
    page = pdf.addPage([380, 800]),
    gap = kind === 'separate-paragraph' ? 24 : 12,
    same = kind === 'same-row' || kind === 'numeric-bracket',
    dated = kind === 'dated-citation' || kind === 'changed-year',
    label = dated ? 'Ma et al., 2019' : kind === 'numeric-bracket' ? '[1]' : 'Figure 1',
    sourceLines = same
      ? [
          'Evidence was gathered from the primary clinical study.',
          'These findings support the main interpretation;'
        ]
      : [
          'Evidence was gathered from the primary clinical study.',
          'The outcomes were compared across treatment groups.',
          'These findings support the main interpretation ('
        ],
    linkY = 700 - gap * (sourceLines.length - 1),
    linkWidth = linkFont.widthOfTextAtSize(label, 10),
    source = sourceLines.join(' ') + ' ' + label + (same ? '.' : ').'),
    translation =
      '这些研究证据比较了不同治疗策略的临床结局，并支持进一步验证相应的疗效和风险' +
      (same ? '；' : '（') +
      (kind === 'changed-year' ? 'Ma et al., 2020' : label) +
      (same ? '。' : '）。'),
    registry = new ApplicationCallerLeaseRegistry(),
    caller = registry.acquire({ leaseId: 'inline-citation', surface: 'electron' })
  for (const [index, text] of sourceLines.entries())
    page.drawText(text, { font, x: 40, y: 700 - gap * index, size: 10 })
  page.drawText(label, { font: linkFont, x: 260, y: linkY, size: 10 })
  page.drawText(same ? '.' : ').', { font, x: 263 + linkWidth, y: linkY, size: 10 })
  page.drawText('Neighbor', { font, x: 40, y: 590, size: 10 })
  page.node.set(
    PDFName.of('Annots'),
    pdf.context.obj([
      pdf.context.register(
        pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [259, linkY - 3, 261 + linkWidth, linkY + 10],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: PDFString.of('https://example.org/reference/1') }
        })
      )
    ])
  )
  const writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = writer.generate(
      {
        id: 'inline-citation',
        data: await pdf.save(),
        pages: [{ width: 380, height: 800 }],
        units: [
          {
            source,
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: {
                  x: 39 / 380,
                  y: 87 / 800,
                  width: 302 / 380,
                  height: (gap * (sourceLines.length - 1) + 20) / 800
                }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (kind === 'changed-year') {
      await expect(output).rejects.toMatchObject({ failure: { code: 'annotations' } })
      return
    }
    task = getDocument({ data: (await output)!, useSystemFonts: true })
    const translated = await (await task.promise).getPage(1),
      items = (await translated.getTextContent()).items.filter((item) => 'str' in item),
      citation = items.find((item) => item.str === label)!,
      links = await translated.getAnnotations()
    expect(
      items
        .map((item) => item.str)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation.replace(/\s/gu, '') + 'Neighbor')
    expect(citation.height).toBe(10)
    if (kind === 'separate-paragraph' || kind === 'numeric-bracket')
      expect(citation.transform.slice(4)).toEqual([260, linkY])
    else if (same) expect(citation.transform[4]).toBeLessThan(245)
    else expect(citation.transform[5]).toBeGreaterThan(linkY + 2)
    expect(links).toHaveLength(1)
    expect(links[0].url).toBe('https://example.org/reference/1')
    expect(links[0].rect[2] - links[0].rect[0]).toBeCloseTo(linkWidth + 2, 3)
    expect(links[0].rect[3] - links[0].rect[1]).toBeCloseTo(13, 3)
    expect(items.find((item) => item.str === 'Neighbor')?.transform.slice(4)).toEqual([40, 590])
  } finally {
    await task?.destroy()
    caller.release()
    registry.dispose()
  }
})
