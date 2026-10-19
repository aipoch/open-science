import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { PdfTranslationWriter } from '../src/writer.js'
import type { PdfTranslationPdfRequest, PdfTranslationPdfResult } from '../src/contracts.js'
import { TestCallerRegistry } from './support/callers.js'
import { resolve } from './paths.js'

const fragment = (
  pageNumber: number,
  y: number
): PdfTranslationPdfRequest['units'][number]['fragments'][number] => ({
  pageNumber,
  rect: { x: 0.1, y, width: 0.8, height: 0.05 }
})

async function generate(
  pdf: PDFDocument,
  units: PdfTranslationPdfRequest['units'],
  options: Pick<PdfTranslationPdfRequest, 'originalRegions' | 'sourceLinksLabel'> = {}
): Promise<PdfTranslationPdfResult> {
  const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
  const caller = new TestCallerRegistry().acquire({ leaseId: 'reflow-safety', surface: 'electron' })
  try {
    const output = await writer.generateDetailed(
      {
        id: 'reflow-safety',
        layout: 'reflow',
        data: await pdf.save(),
        pages: pdf.getPages().map((page) => page.getSize()),
        units,
        ...options
      },
      caller.lease
    )
    expect(output).not.toBeNull()
    return output!
  } finally {
    caller.release()
  }
}

function link(
  pdf: PDFDocument,
  number: number,
  rect: number[],
  action: Record<string, unknown>
): void {
  pdf.getPage(number - 1).node.addAnnot(
    pdf.context.register(
      pdf.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: rect,
        Border: [0, 0, 0],
        ...action
      })
    )
  )
}

it.each([false, true])(
  'retains a complete original page for unsafe text direction (page rotation=%s)',
  async (rotatePage) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([400, 500])
    page.drawText('Original body.', { font, x: 40, y: 440, size: 12 })
    if (rotatePage) page.setRotation(degrees(90))
    else page.drawText('Vertical text.', { font, x: 300, y: 200, size: 12, rotate: degrees(90) })
    const output = await generate(pdf, [
      {
        source: 'Original body.',
        translation: '不应叠加这段译文。',
        fragments: [fragment(1, 0.08)]
      }
    ])
    expect(output.reflow!.originalPageNumbers).toEqual([1])
    expect(output.layoutFailures).toEqual([
      expect.objectContaining({ unitIndex: 0, code: 'unsupported-layout', pageNumbers: [1] })
    ])
    const task = getDocument({ data: output.data.slice() })
    try {
      const document = await task.promise
      expect(document.numPages).toBe(1)
      const text = (await (await document.getPage(1)).getTextContent()).items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
      expect(text).toContain('Original body.')
      expect(text).not.toContain('不应叠加')
      if (!rotatePage) expect(text).toContain('Vertical text.')
    } finally {
      await task.destroy()
    }
  }
)

it('retains every page of a joined translated paragraph without blocking an independent page', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const label of ['First part.', 'Second part.', 'Independent.'])
    pdf.addPage([400, 500]).drawText(label, { font, x: 40, y: 440, size: 12 })
  pdf.getPage(1).setRotation(degrees(90))
  const output = await generate(pdf, [
    {
      source: 'First part. Second part.',
      translation: '跨页段落不能重复或遗漏。',
      fragments: [fragment(1, 0.08), fragment(2, 0.08)]
    },
    { source: 'Independent.', translation: '独立页面照常翻译。', fragments: [fragment(3, 0.08)] }
  ])
  expect(output.reflow!.originalPageNumbers).toEqual([1, 2])
  expect(output.reflow!.sourcePageNumbers).toEqual([1, 2, 3])
  expect(output.layoutFailures).toEqual([
    expect.objectContaining({ unitIndex: 0, pageNumbers: [1, 2] })
  ])
  const task = getDocument({ data: output.data.slice() })
  try {
    const document = await task.promise
    const text = (await (await document.getPage(3)).getTextContent()).items
      .map((item) => ('str' in item ? item.str : ''))
      .join('')
    expect(text).toContain('独立页面照常翻译。')
    expect(text).not.toContain('跨页段落')
  } finally {
    await task.destroy()
  }
})

it('recreates an external link over its literal label inside the translated paragraph', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf
    .addPage([400, 500])
    .drawText('Visit https://example.org today.', { font, x: 40, y: 440, size: 12 })
  const x = 40 + font.widthOfTextAtSize('Visit ', 12)
  link(pdf, 1, [x, 438, x + font.widthOfTextAtSize('https://example.org', 12), 453], {
    A: { S: 'URI', URI: PDFString.of('https://example.org') }
  })
  const output = await generate(pdf, [
    {
      source: 'Visit https://example.org today.',
      translation: '访问 https://example.org 了解更多。',
      fragments: [fragment(1, 0.08)]
    }
  ])
  expect(output.layoutFailures).toEqual([])
  expect(output.reflow!.originalPageNumbers).toEqual([])
  const task = getDocument({ data: output.data.slice() })
  try {
    const page = await (await task.promise).getPage(1),
      annotations = await page.getAnnotations()
    expect(annotations).toHaveLength(1)
    expect(annotations[0].url).toBe('https://example.org/')
    expect(annotations[0].rect[0]).toBeGreaterThan(44)
    expect(annotations[0].rect[2] - annotations[0].rect[0]).toBeLessThan(150)
  } finally {
    await task.destroy()
  }
})

it('remaps named and direct destinations between reflowed and original pages', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([400, 500]).drawText('Read Section 2.', { font, x: 40, y: 440, size: 12 })
  pdf.addPage([400, 500]).drawText('Reference.', { font, x: 40, y: 440, size: 12 })
  const x = 40 + font.widthOfTextAtSize('Read ', 12)
  pdf.catalog.set(
    PDFName.of('Names'),
    pdf.context.obj({
      Dests: { Names: [PDFString.of('references'), [pdf.getPage(1).ref, 'XYZ', 40, 450, null]] }
    })
  )
  link(pdf, 1, [x, 438, x + font.widthOfTextAtSize('Section 2', 12), 453], {
    Dest: PDFString.of('references')
  })
  link(pdf, 2, [40, 438, 100, 453], {
    A: { S: 'GoTo', D: [pdf.getPage(0).ref, 'XYZ', 40, 450, null] }
  })
  const output = await generate(pdf, [
    {
      source: 'Read Section 2.',
      translation: '请阅读第2节。' + '正文继续分页。'.repeat(650),
      fragments: [fragment(1, 0.08)]
    },
    {
      source: 'Reference.',
      translation: 'Reference.',
      kind: 'reference',
      fragments: [fragment(2, 0.08)]
    }
  ])
  expect(output.layoutFailures).toEqual([])
  const referencePage = output.reflow!.originalPageNumbers![0]
  expect(referencePage).toBeGreaterThan(2)
  const task = getDocument({ data: output.data.slice() })
  try {
    const document = await task.promise
    const outgoing = await (await document.getPage(1)).getAnnotations()
    expect(await document.getPageIndex(outgoing[0].dest[0])).toBe(referencePage - 1)
    const incoming = await (await document.getPage(referencePage)).getAnnotations()
    expect(incoming).toHaveLength(1)
    expect(await document.getPageIndex(incoming[0].dest[0])).toBe(0)
  } finally {
    await task.destroy()
  }
})

it('keeps translated body text and appends the original label when its translated link position is unproved', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const text of ['Original linked words.', 'Independent.'])
    pdf.addPage([400, 500]).drawText(text, { font, x: 40, y: 440, size: 12 })
  link(pdf, 1, [40, 438, 84, 453], { A: { S: 'URI', URI: PDFString.of('https://example.org') } })
  const output = await generate(
    pdf,
    [
      {
        source: 'Original linked words.',
        translation: '完全不同的中文描述。',
        fragments: [fragment(1, 0.08)]
      },
      { source: 'Independent.', translation: '另页继续翻译。', fragments: [fragment(2, 0.08)] }
    ],
    { sourceLinksLabel: '原文链接' }
  )
  expect(output.reflow!.originalPageNumbers).toEqual([])
  expect(output.layoutFailures).toEqual([])
  const task = getDocument({ data: output.data.slice() })
  try {
    const document = await task.promise
    expect((await (await document.getPage(1)).getAnnotations())[0].url).toBe('https://example.org/')
    expect(
      (await (await document.getPage(1)).getTextContent()).items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
    ).toContain('另页继续翻译。')
    const text = (await (await document.getPage(1)).getTextContent()).items
      .map((item) => ('str' in item ? item.str : ''))
      .join('')
    expect(text).toContain('完全不同的中文描述。')
    expect(text).toContain('原文链接')
  } finally {
    await task.destroy()
  }
})

it('keeps the complete original destination graph when an internal destination cannot be resolved', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([400, 500]).drawText('Original.', { font, x: 40, y: 440, size: 12 })
  link(pdf, 1, [40, 438, 100, 453], { Dest: PDFString.of('unknown-destination') })
  const output = await generate(pdf, [
    { source: 'Original.', translation: '尚未写入的译文。', fragments: [fragment(1, 0.08)] }
  ])
  expect(output.reflow!.originalPageNumbers).toEqual([1])
  expect(output.layoutFailures[0].code).toBe('annotations')
  const task = getDocument({ data: output.data.slice() })
  try {
    const page = await (await task.promise).getPage(1)
    expect((await page.getAnnotations())[0].dest).toBe('unknown-destination')
    expect(
      (await page.getTextContent()).items.map((item) => ('str' in item ? item.str : '')).join('')
    ).toContain('Original.')
  } finally {
    await task.destroy()
  }
})

it('keeps two distinct citation links over their own translated labels', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  const source = 'See [1] and [2].'
  pdf.addPage([400, 500]).drawText(source, { font, x: 40, y: 440, size: 12 })
  for (const value of ['[1]', '[2]']) {
    const start = source.indexOf(value),
      x = 40 + font.widthOfTextAtSize(source.slice(0, start), 12)
    link(pdf, 1, [x, 438, x + font.widthOfTextAtSize(value, 12), 453], {
      A: { S: 'URI', URI: PDFString.of(`https://example.org/${value[1]}`) }
    })
  }
  const output = await generate(pdf, [
    { source, translation: '参见[1]与[2]。', fragments: [fragment(1, 0.08)] }
  ])
  expect(output.layoutFailures).toEqual([])
  const task = getDocument({ data: output.data.slice() })
  try {
    const annotations = await (await (await task.promise).getPage(1)).getAnnotations()
    expect(annotations.map((annotation) => annotation.url)).toEqual([
      'https://example.org/1',
      'https://example.org/2'
    ])
    expect(annotations[0].rect[2]).toBeLessThan(annotations[1].rect[0])
  } finally {
    await task.destroy()
  }
})

it('moves a figure link with its retained crop while keeping body text translated', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([400, 500])
  page.drawText('Body.', { font, x: 40, y: 440, size: 12 })
  page.drawRectangle({ x: 40, y: 250, width: 200, height: 100, color: rgb(0.2, 0.6, 0.7) })
  page.drawText('Diagram link', { font, x: 50, y: 300, size: 12 })
  page.drawText('Axis', { font, x: 210, y: 270, size: 12, rotate: degrees(90) })
  link(pdf, 1, [50, 298, 115, 313], {
    A: { S: 'URI', URI: PDFString.of('https://example.org/figure') }
  })
  const output = await generate(
    pdf,
    [
      { source: 'Body.', translation: '正文译文。', fragments: [fragment(1, 0.08)] },
      {
        source: 'Diagram link',
        translation: 'Diagram link',
        kind: 'visual',
        fragments: [{ pageNumber: 1, rect: { x: 0.125, y: 0.37, width: 0.18, height: 0.04 } }]
      }
    ],
    { originalRegions: [{ pageNumber: 1, rect: { x: 0.1, y: 0.3, width: 0.5, height: 0.2 } }] }
  )
  expect(output.layoutFailures).toEqual([])
  expect(output.reflow!.originalPageNumbers).toEqual([])
  const task = getDocument({ data: output.data.slice() })
  try {
    const page = await (await task.promise).getPage(1),
      annotations = await page.getAnnotations()
    expect(annotations).toHaveLength(1)
    expect(annotations[0].url).toBe('https://example.org/figure')
    expect(
      (await page.getTextContent()).items.map((item) => ('str' in item ? item.str : '')).join('')
    ).toContain('正文译文。')
    expect(
      (await page.getOperatorList()).fnArray.filter((op) => op === OPS.paintImageXObject)
    ).toHaveLength(1)
  } finally {
    await task.destroy()
  }
})

it('paginates all translated text while retaining a figure inside a page Form', async () => {
  const original = await PDFDocument.create()
  const font = await original.embedFont(StandardFonts.Helvetica)
  const page = original.addPage([400, 500])
  page.drawText('Original body.', { font, size: 12, x: 40, y: 440 })
  page.drawRectangle({ x: 40, y: 260, width: 120, height: 90, color: rgb(0.1, 0.5, 0.8) })
  page.drawRectangle({ x: 180, y: 260, width: 160, height: 90, color: rgb(0.2, 0.7, 0.4) })
  page.drawText('Figure label', { font, size: 12, x: 50, y: 290 })
  page.drawText('Failed original paragraph.', { font, size: 12, x: 40, y: 160 })
  const wrapped = await PDFDocument.create()
  const embedded = await wrapped.embedPage(page)
  wrapped.addPage([400, 500]).drawPage(embedded)
  const translation =
    '完整的学术译文应当换行并在空间不足时继续分页，不能被原来的文本框截断。'.repeat(130) +
    '• · End.'
  const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
  const caller = new TestCallerRegistry().acquire({ leaseId: 'reflow', surface: 'electron' })
  let task: ReturnType<typeof getDocument> | undefined
  try {
    const output = await writer.generateDetailed(
      {
        id: 'reflow',
        layout: 'reflow',
        data: await wrapped.save(),
        pages: [{ width: 400, height: 500 }],
        units: [
          { source: 'Original body.', translation, fragments: [fragment(1, 0.08)] },
          { source: 'Figure label', translation: '图中标签', fragments: [fragment(1, 0.38)] },
          {
            source: 'Failed original paragraph.',
            translation: 'Failed original paragraph.',
            fragments: [fragment(1, 0.65)]
          }
        ]
      },
      caller.lease
    )
    expect(output?.layoutFailures).toEqual([])
    expect(output!.reflow!.sourcePageNumbers.length).toBeGreaterThan(1)
    expect(new Set(output!.reflow!.sourcePageNumbers)).toEqual(new Set([1]))
    const placements = output!.reflow!.units.find((u) => u.unitIndex === 0)!
    expect(placements.fragments.length).toBeGreaterThan(1)
    expect(
      placements.fragments
        .map((f) => f.text)
        .join('')
        .replace(/\s/gu, '')
    ).toBe(translation.replace(/\s/gu, ''))
    expect(output!.reflow!.units.some((u) => u.unitIndex === 2)).toBe(true)
    task = getDocument({ data: output!.data.slice() })
    const pdf = await task.promise
    let text = '',
      figures = 0
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      text += content.items.map((i) => ('str' in i ? i.str : '')).join('')
      const operators = await page.getOperatorList()
      figures += operators.fnArray.filter((fn) => fn === OPS.paintImageXObject).length
      page.cleanup()
    }
    expect(text.replace(/\s/gu, '')).toContain(translation.replace(/\s/gu, ''))
    expect(text).not.toContain('Original body.')
    expect(figures).toBe(2) // one complete two-part figure, one failed paragraph crop
  } finally {
    await task?.destroy()
    caller.release()
  }
})

it('retains every source fragment when an unsupported glyph spans two source pages', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const label of ['First original.', 'Second original.'])
    pdf.addPage([400, 500]).drawText(label, { font, size: 12, x: 40, y: 440 })
  const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
  const caller = new TestCallerRegistry().acquire({ leaseId: 'glyphs', surface: 'electron' })
  try {
    const output = await writer.generateDetailed(
      {
        id: 'glyphs',
        layout: 'reflow',
        data: await pdf.save(),
        pages: [
          { width: 400, height: 500 },
          { width: 400, height: 500 }
        ],
        units: [
          {
            source: 'First original. Second original.',
            translation: '译文\u{1FAE0}',
            fragments: [fragment(1, 0.08), fragment(2, 0.08)]
          }
        ]
      },
      caller.lease
    )
    expect(output!.layoutFailures).toEqual([
      expect.objectContaining({ unitIndex: 0, code: 'font' })
    ])
    expect(output!.reflow!.units[0].fragments).toHaveLength(2)
    expect(output!.reflow!.sourcePageNumbers).toEqual([1])
    expect(output!.reflow!.sourcePages).toEqual([[1, 2]])
    expect(output!.reflow!.units[0].fragments.map((fragment) => fragment.pageNumber)).toEqual([
      1, 1
    ])
  } finally {
    caller.release()
  }
})
