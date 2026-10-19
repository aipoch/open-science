import {
  PDFDocument,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
  degrees,
  rgb
} from 'pdf-lib'
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
  options: Pick<PdfTranslationPdfRequest, 'originalRegions'> = {}
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
  'retains the original PDF for a chained action (array=%s)',
  async (array) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([400, 500]).drawText('Original.', { font, x: 40, y: 440, size: 12 })
    const next = { S: 'GoTo', D: [pdf.getPage(0).ref, 'Fit'] }
    link(pdf, 1, [40, 438, 100, 454], {
      A: { S: 'URI', URI: PDFString.of('https://example.org'), Next: array ? [next] : next }
    })
    const bytes = await pdf.save()
    const output = await generate(pdf, [
      { source: 'Original.', translation: 'Translated.', fragments: [fragment(1, 0.08)] }
    ])
    expect(output.data).toEqual(bytes)
    expect(output.layoutFailures).toEqual([
      expect.objectContaining({ code: 'annotations', unitIndex: 0 })
    ])
  }
)

it('preserves Unicode URIs and resolves relative links against the original base', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([400, 500]).drawText('Read the paper.', { font, x: 40, y: 440, size: 12 })
  pdf.catalog.set(
    PDFName.of('URI'),
    pdf.context.obj({ Base: PDFString.of('https://example.org/papers/') })
  )
  link(pdf, 1, [40, 438, 125, 454], {
    A: { S: 'URI', URI: PDFString.of(Buffer.from('研究.pdf', 'utf8').toString('latin1')) }
  })
  const output = await generate(pdf, [
    { source: 'Read the paper.', translation: '阅读这篇论文。', fragments: [fragment(1, 0.08)] }
  ])
  expect(output.layoutFailures).toEqual([])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise,
      links = await (await parsed.getPage(1)).getAnnotations()
    expect(links[0].url).toBe('https://example.org/papers/%E7%A0%94%E7%A9%B6.pdf')
  } finally {
    await task.destroy()
  }
})

it('maps separate quad regions without linking the unrelated text between them', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([400, 500])
  page.drawText('[1]', { font, size: 12, x: 40, y: 440 })
  page.drawText('unlinked', { font, size: 12, x: 80, y: 440 })
  page.drawText('[2]', { font, size: 12, x: 160, y: 440 })
  link(pdf, 1, [40, 438, 180, 454], {
    A: { S: 'URI', URI: PDFString.of('https://example.org/citations') },
    QuadPoints: [40, 454, 54, 454, 40, 438, 54, 438, 160, 454, 174, 454, 160, 438, 174, 438]
  })
  const output = await generate(pdf, [
    {
      source: '[1] unlinked [2]',
      translation: '[1] 未链接的文本 [2]',
      fragments: [fragment(1, 0.08)]
    }
  ])
  expect(output.layoutFailures).toEqual([])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise,
      links = await (await parsed.getPage(1)).getAnnotations()
    expect(links).toHaveLength(2)
    expect(links[0].rect[2]).toBeLessThan(links[1].rect[0])
    for (const item of links) expect(item.rect[2] - item.rect[0]).toBeLessThan(20)
  } finally {
    await task.destroy()
  }
})

it('retains ambiguous internal targets instead of choosing the nearest paragraph', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const label of ['Reference.', 'Destination.'])
    pdf.addPage([400, 500]).drawText(label, { font, size: 12, x: 40, y: 440 })
  link(pdf, 1, [40, 438, 100, 454], { Dest: [pdf.getPage(1).ref, 'XYZ', 40, 200, null] })
  const output = await generate(pdf, [
    { source: 'Reference.', translation: 'Translated reference.', fragments: [fragment(1, 0.08)] },
    {
      source: 'Destination.',
      translation: 'Translated destination.',
      fragments: [fragment(2, 0.08)]
    }
  ])
  expect(output.reflow!.originalPageNumbers).toEqual([1, 2])
  expect(output.layoutFailures.map((f) => f.code)).toEqual(['annotations', 'annotations'])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise,
      links = await (await parsed.getPage(1)).getAnnotations()
    expect(await parsed.getPageIndex(links[0].dest[0])).toBe(1)
    expect(links[0].dest[3]).toBe(200)
  } finally {
    await task.destroy()
  }
})

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

it('retains the original page when a translated link position is unproved', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const text of ['Original linked words.', 'Independent.'])
    pdf.addPage([400, 500]).drawText(text, { font, x: 40, y: 440, size: 12 })
  link(pdf, 1, [40, 438, 84, 453], { A: { S: 'URI', URI: PDFString.of('https://example.org') } })
  const output = await generate(pdf, [
    {
      source: 'Original linked words.',
      translation: '完全不同的中文描述。',
      fragments: [fragment(1, 0.08)]
    },
    { source: 'Independent.', translation: '另页继续翻译。', fragments: [fragment(2, 0.08)] }
  ])
  expect(output.reflow!.originalPageNumbers).toEqual([1])
  expect(output.layoutFailures).toEqual([
    expect.objectContaining({ unitIndex: 0, code: 'annotations' })
  ])
  const task = getDocument({ data: output.data.slice() })
  try {
    const document = await task.promise
    expect((await (await document.getPage(1)).getAnnotations())[0].url).toBe('https://example.org/')
    expect(
      (await (await document.getPage(2)).getTextContent()).items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
    ).toContain('另页继续翻译。')
    const text = (await (await document.getPage(1)).getTextContent()).items
      .map((item) => ('str' in item ? item.str : ''))
      .join('')
    expect(text).toBe('Original linked words.')
    expect(text).not.toContain('Original links')
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

it.each([90, 180, 270])(
  'retains rotated pages and whole cross-page paragraphs (%s degrees)',
  async (rotation) => {
    const original = await PDFDocument.create()
    const font = await original.embedFont(StandardFonts.Helvetica)
    for (let number = 1; number <= 4; number++) {
      const page = original.addPage([400, 500])
      page.drawText(`Original ${number}.`, { font, size: 12, x: 40, y: 440 })
      if (number === 1) page.setRotation(degrees(rotation))
    }
    const units = [
      {
        source: 'Original 2. Original 3.',
        translation: 'Translated second joint paragraph.',
        fragments: [fragment(2, 0.08), fragment(3, 0.08)]
      },
      {
        source: 'Original 1. Original 2.',
        translation: 'Translated first joint paragraph.',
        fragments: [fragment(1, 0.08), fragment(2, 0.08)]
      },
      {
        source: 'Original 4.',
        translation: 'Translated unaffected page.',
        fragments: [fragment(4, 0.08)]
      }
    ]
    const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
    const caller = new TestCallerRegistry().acquire({
      leaseId: 'rotated-reflow',
      surface: 'electron'
    })
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const output = await writer.generateDetailed(
        {
          id: 'rotated-reflow',
          layout: 'reflow',
          data: await original.save(),
          pages: Array.from({ length: 4 }, (_, index) =>
            index === 0 && rotation !== 180
              ? { width: 500, height: 400 }
              : { width: 400, height: 500 }
          ),
          units
        },
        caller.lease
      )
      expect(output!.reflow!.originalPageNumbers).toEqual([1, 2, 3])
      expect(output!.layoutFailures).toEqual(
        [0, 1].map((unitIndex) => ({
          unitIndex,
          code: 'unsupported-layout',
          phase: 'planning',
          pageNumbers: units[unitIndex].fragments.map((f) => f.pageNumber),
          fragmentCount: 2
        }))
      )
      task = getDocument({ data: output!.data.slice() })
      const pdf = await task.promise
      expect(pdf.numPages).toBe(4)
      for (let number = 1; number <= 4; number++) {
        const page = await pdf.getPage(number)
        const text = (await page.getTextContent()).items
          .map((i) => ('str' in i ? i.str : ''))
          .join('')
        expect(text).toBe(number <= 3 ? `Original ${number}.` : 'Translated unaffected page.')
        if (number === 1) expect(page.rotate).toBe(rotation)
        page.cleanup()
      }
    } finally {
      await task?.destroy()
      caller.release()
    }
  }
)

it('keeps one external link clickable across translated lines and output pages', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([400, 500]).drawText('Read the paper.', { font, size: 12, x: 40, y: 440 })
  link(pdf, 1, [40, 438, 125, 454], {
    A: { S: 'URI', URI: PDFString.of('https://example.org/paper') }
  })
  const translation = 'This translated paragraph describes the linked paper in detail. '.repeat(100)
  const output = await generate(pdf, [
    { source: 'Read the paper.', translation, fragments: [fragment(1, 0.08)] }
  ])
  expect(output.layoutFailures).toEqual([])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise
    expect(parsed.numPages).toBeGreaterThan(1)
    for (let n = 1; n <= parsed.numPages; n++) {
      const page = await parsed.getPage(n),
        annotations = await page.getAnnotations()
      const text = (await page.getTextContent()).items.filter((i) => 'str' in i && i.str.trim())
      expect(annotations.length).toBe(text.length)
      for (const annotation of annotations) {
        expect(annotation.url).toBe('https://example.org/paper')
        const [left, low, right, high] = annotation.rect
        expect(high - low).toBeCloseTo(18, 3)
        expect(
          text.some(
            (item) =>
              'str' in item &&
              Math.abs(item.transform[4] - left) < 1 &&
              item.transform[5] > low &&
              item.transform[5] < high &&
              right > left
          )
        ).toBe(true)
      }
    }
  } finally {
    await task.destroy()
  }
})

it.each(['direct', 'action', 'name-tree', 'named-dictionary'])(
  'rewrites %s destinations to actual output page references',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    for (const label of ['Introduction.', 'Target paragraph.'])
      pdf.addPage([400, 500]).drawText(label, { font, size: 12, x: 40, y: 440 })
    const dest = pdf.context.obj([pdf.getPage(1).ref, PDFName.of('XYZ'), 40, 450, null])
    if (kind === 'name-tree')
      pdf.catalog.set(
        PDFName.of('Names'),
        pdf.context.obj({ Dests: { Names: [PDFString.of('target'), dest] } })
      )
    if (kind === 'named-dictionary')
      pdf.catalog.set(PDFName.of('Dests'), pdf.context.obj({ target: dest }))
    link(
      pdf,
      1,
      [40, 438, 110, 454],
      kind === 'action'
        ? { A: { S: 'GoTo', D: dest } }
        : {
            Dest:
              kind === 'name-tree'
                ? PDFString.of('target')
                : kind === 'named-dictionary'
                  ? PDFName.of('target')
                  : dest
          }
    )
    // Force the target onto a later output page, rather than source page two.
    const output = await generate(pdf, [
      {
        source: 'Introduction.',
        translation: 'Long translated introduction. '.repeat(350),
        fragments: [fragment(1, 0.08)]
      },
      {
        source: 'Target paragraph.',
        translation: 'Translated target paragraph.',
        fragments: [fragment(2, 0.08)]
      }
    ])
    expect(output.layoutFailures).toEqual([])
    const task = getDocument({ data: output.data.slice() })
    try {
      const parsed = await task.promise,
        target = output.reflow!.units.find((u) => u.unitIndex === 1)!.fragments[0]
      expect(target.pageNumber).toBeGreaterThan(2)
      const links = await (await parsed.getPage(1)).getAnnotations()
      expect(links.length).toBeGreaterThan(0)
      for (const link of links) {
        expect(await parsed.getPageIndex(link.dest[0])).toBe(target.pageNumber - 1)
        expect(link.dest[3]).toBeCloseTo((1 - target.rect.y) * 841.89, 2)
      }
    } finally {
      await task.destroy()
    }
  }
)

it('remaps mail links in retained figures with the crop scale', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([400, 500])
  page.drawText('Body.', { font, size: 12, x: 40, y: 440 })
  page.drawRectangle({ x: 40, y: 200, width: 200, height: 100, color: rgb(0.2, 0.5, 0.7) })
  link(pdf, 1, [60, 220, 100, 240], {
    A: { S: 'URI', URI: PDFString.of('mailto:science@example.org') }
  })
  const output = await generate(pdf, [
    { source: 'Body.', translation: 'Translated body.', fragments: [fragment(1, 0.08)] }
  ])
  expect(output.layoutFailures).toEqual([])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise,
      annotations = await (await parsed.getPage(1)).getAnnotations()
    expect(annotations).toHaveLength(1)
    expect(annotations[0].url).toBe('mailto:science@example.org')
    expect(annotations[0].rect[0]).toBeCloseTo(64, 1)
    expect(annotations[0].rect[2] - annotations[0].rect[0]).toBeCloseTo(40, 1)
    expect(annotations[0].rect[3] - annotations[0].rect[1]).toBeCloseTo(20, 1)
  } finally {
    await task.destroy()
  }
})

it('retains ambiguous labels and rewrites links on copied pages after preceding pagination', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const label of ['Introduction.', 'Read paper and paper.', 'Destination.'])
    pdf.addPage([400, 500]).drawText(label, { font, size: 12, x: 40, y: 440 })
  const x = 40 + font.widthOfTextAtSize('Read ', 12)
  link(pdf, 2, [x, 438, x + font.widthOfTextAtSize('paper', 12), 454], {
    Dest: [pdf.getPage(2).ref, PDFName.of('XYZ'), 40, 450, null]
  })
  const output = await generate(pdf, [
    {
      source: 'Introduction.',
      translation: 'Expanded introduction. '.repeat(400),
      fragments: [fragment(1, 0.08)]
    },
    {
      source: 'Read paper and paper.',
      translation: 'Read translated paper and paper.',
      fragments: [fragment(2, 0.08)]
    },
    {
      source: 'Destination.',
      translation: 'Translated destination.',
      fragments: [fragment(3, 0.08)]
    }
  ])
  expect(output.layoutFailures.map((f) => [f.unitIndex, f.code])).toEqual([
    [1, 'annotations'],
    [2, 'annotations']
  ])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise,
      originals = output.reflow!.originalPageNumbers!
    expect(originals[0]).toBeGreaterThan(2)
    const links = await (await parsed.getPage(originals[0])).getAnnotations()
    expect(links).toHaveLength(1)
    expect(await parsed.getPageIndex(links[0].dest[0])).toBe(originals[1] - 1)
    expect(links[0].dest.slice(2)).toEqual([40, 450, null])
  } finally {
    await task.destroy()
  }
})

it('keeps two distinct URI identities when translated references change order', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  const source = 'See Figure 1 and Figure 2.'
  pdf.addPage([400, 500]).drawText(source, { font, size: 12, x: 40, y: 440 })
  for (const number of [1, 2]) {
    const label = `Figure ${number}`,
      start = source.indexOf(label)
    const x = 40 + font.widthOfTextAtSize(source.slice(0, start), 12)
    link(pdf, 1, [x, 438, x + font.widthOfTextAtSize(label, 12), 454], {
      A: { S: 'URI', URI: PDFString.of(`https://example.org/figure-${number}`) }
    })
  }
  const output = await generate(pdf, [
    { source, translation: '请先看图2，再看图1。', fragments: [fragment(1, 0.08)] }
  ])
  expect(output.layoutFailures).toEqual([])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise,
      links = await (await parsed.getPage(1)).getAnnotations()
    expect(links.map((l) => l.url).sort()).toEqual([
      'https://example.org/figure-1',
      'https://example.org/figure-2'
    ])
    expect(links.find((l) => l.url.endsWith('figure-2')).rect[0]).toBeLessThan(
      links.find((l) => l.url.endsWith('figure-1')).rect[0]
    )
  } finally {
    await task.destroy()
  }
})

it('retains CropBox coordinates and repairs the copied link target', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const label of ['Original reference.', 'Target.'])
    pdf.addPage([400, 500]).drawText(label, { font, size: 12, x: 40, y: 440 })
  pdf.getPage(0).setCropBox(20, 30, 360, 440)
  link(pdf, 1, [40, 438, 150, 454], { Dest: [pdf.getPage(1).ref, PDFName.of('Fit')] })
  const output = await generate(pdf, [
    {
      source: 'Original reference.',
      translation: 'Translated reference.',
      fragments: [fragment(1, 0.08)]
    },
    { source: 'Target.', translation: 'Translated target.', fragments: [fragment(2, 0.08)] }
  ])
  // A nonzero crop origin conservatively retains the linked component.
  expect(output.layoutFailures.map((f) => f.code)).toEqual(['annotations', 'annotations'])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise,
      first = await parsed.getPage(1),
      links = await first.getAnnotations()
    expect(first.view).toEqual([20, 30, 380, 470])
    expect(links[0].rect).toEqual([40, 438, 150, 454])
    expect(await parsed.getPageIndex(links[0].dest[0])).toBe(1)
  } finally {
    await task.destroy()
  }
})

it('rewrites the primary destination even when additional actions require an original-page fallback', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const label of ['Reference.', 'Destination.'])
    pdf.addPage([400, 500]).drawText(label, { font, size: 12, x: 40, y: 440 })
  link(pdf, 1, [40, 438, 110, 454], {
    A: { S: 'GoTo', D: [pdf.getPage(1).ref, PDFName.of('FitH'), null] },
    AA: { E: { S: 'URI', URI: PDFString.of('https://example.org/hover') } }
  })
  const output = await generate(pdf, [
    { source: 'Reference.', translation: 'Translated reference.', fragments: [fragment(1, 0.08)] },
    {
      source: 'Destination.',
      translation: 'Translated destination.',
      fragments: [fragment(2, 0.08)]
    }
  ])
  expect(output.reflow!.originalPageNumbers).toEqual([1, 2])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise,
      links = await (await parsed.getPage(1)).getAnnotations()
    expect(await parsed.getPageIndex(links[0].dest[0])).toBe(1)
    expect(links[0].dest[2]).toBeNull()
    const raw = await PDFDocument.load(output.data)
    expect(raw.getPage(0).node.Annots()!.lookup(0).toString()).toContain('/AA')
  } finally {
    await task.destroy()
  }
})

it('maps a link on an unchanged page to a translated cross-page paragraph', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const label of ['Reference.', 'First part.', 'Second part.'])
    pdf.addPage([400, 500]).drawText(label, { font, size: 12, x: 40, y: 440 })
  link(pdf, 1, [40, 438, 110, 454], {
    Dest: [pdf.getPage(2).ref, PDFName.of('XYZ'), 40, 450, null]
  })
  const output = await generate(pdf, [
    { source: 'Reference.', translation: 'Reference.', fragments: [fragment(1, 0.08)] },
    {
      source: 'First part. Second part.',
      translation: 'Translated joined paragraph.',
      fragments: [fragment(2, 0.08), fragment(3, 0.08)]
    }
  ])
  expect(output.layoutFailures).toEqual([])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise,
      links = await (await parsed.getPage(1)).getAnnotations()
    const target = output.reflow!.units.find((u) => u.unitIndex === 1)!.fragments[0]
    expect(await parsed.getPageIndex(links[0].dest[0])).toBe(target.pageNumber - 1)
    expect(target.pageNumber).toBe(2)
  } finally {
    await task.destroy()
  }
})

it.each(['direct', 'action', 'named'])(
  'preserves Unicode outline hierarchy and maps %s targets after pagination',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    for (const label of ['Introduction.', 'Target paragraph.'])
      pdf.addPage([400, 500]).drawText(label, { font, size: 12, x: 40, y: 440 })
    const dest = pdf.context.obj([pdf.getPage(1).ref, 'XYZ', 40, 450, null])
    pdf.catalog.set(
      PDFName.of('Names'),
      pdf.context.obj({ Dests: { Names: [PDFString.of('target'), dest] } })
    )
    const root = pdf.context.obj({ Type: 'Outlines', Count: 3 }),
      rootRef = pdf.context.register(root)
    const group = pdf.context.obj({
      Title: PDFHexString.fromText('章节'),
      Count: 1,
      Parent: rootRef
    })
    const groupRef = pdf.context.register(group)
    const child = pdf.context.obj({
      Title: PDFHexString.fromText('重复标题'),
      Parent: groupRef,
      Count: -1,
      C: [1, 0, 0],
      F: 3,
      ...(kind === 'action'
        ? { A: { S: 'GoTo', D: dest } }
        : { Dest: kind === 'named' ? PDFString.of('target') : dest })
    })
    const childRef = pdf.context.register(child)
    const grandchild = pdf.context.obj({
      Title: PDFHexString.fromText('重复标题'),
      Parent: childRef,
      Dest: dest
    })
    const grandchildRef = pdf.context.register(grandchild)
    child.set(PDFName.of('First'), grandchildRef)
    child.set(PDFName.of('Last'), grandchildRef)
    group.set(PDFName.of('First'), childRef)
    group.set(PDFName.of('Last'), childRef)
    const sibling = pdf.context.obj({
      Title: PDFString.of('Appendix'),
      Parent: rootRef,
      Prev: groupRef,
      Dest: [pdf.getPage(0).ref, 'Fit']
    })
    const siblingRef = pdf.context.register(sibling)
    group.set(PDFName.of('Next'), siblingRef)
    root.set(PDFName.of('First'), groupRef)
    root.set(PDFName.of('Last'), siblingRef)
    pdf.catalog.set(PDFName.of('Outlines'), rootRef)
    pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
    const output = await generate(pdf, [
      {
        source: 'Introduction.',
        translation: 'Expanded introduction. '.repeat(400),
        fragments: [fragment(1, 0.08)]
      },
      {
        source: 'Target paragraph.',
        translation: 'Translated target.',
        fragments: [fragment(2, 0.08)]
      }
    ])
    expect(output.layoutFailures).toEqual([])
    const task = getDocument({ data: output.data.slice() })
    try {
      const parsed = await task.promise,
        outline = (await parsed.getOutline())!
      expect(outline.map((node) => node.title)).toEqual(['章节', 'Appendix'])
      expect(outline[0].dest).toBeNull()
      expect(outline[0].count).toBe(1)
      const child = outline[0].items[0]
      expect(child).toMatchObject({ title: '重复标题', count: -1, bold: true, italic: true })
      expect([...child.color]).toEqual([255, 0, 0])
      expect(child.items[0].title).toBe('重复标题')
      const target = output.reflow!.units.find((unit) => unit.unitIndex === 1)!.fragments[0]
      expect(target.pageNumber).toBeGreaterThan(2)
      for (const item of [child, child.items[0]]) {
        expect(Array.isArray(item.dest)).toBe(true)
        const destination = item.dest as unknown[]
        expect(await parsed.getPageIndex(destination[0] as { num: number; gen: number })).toBe(
          target.pageNumber - 1
        )
        expect(destination[3]).toBeCloseTo((1 - target.rect.y) * 841.89, 2)
      }
      expect(await parsed.getPageMode()).toBe('UseOutlines')
      const saved = await PDFDocument.load(output.data)
      const tree = saved.catalog.lookup(PDFName.of('Outlines'), PDFDict)
      expect(tree.lookup(PDFName.of('Count'))!.toString()).toBe('3')
      const first = tree.lookup(PDFName.of('First'), PDFDict)
      const last = tree.lookup(PDFName.of('Last'), PDFDict)
      expect(first.lookup(PDFName.of('Next'))).toBe(last)
      expect(last.lookup(PDFName.of('Prev'))).toBe(first)
      expect(first.lookup(PDFName.of('Parent'))).toBe(tree)
    } finally {
      await task.destroy()
    }
  }
)

it('retains an ambiguous bookmark target page without guessing the nearest paragraph', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const label of ['Introduction.', 'Target paragraph.'])
    pdf.addPage([400, 500]).drawText(label, { font, size: 12, x: 40, y: 440 })
  const root = pdf.context.obj({ Type: 'Outlines', Count: 1 }),
    rootRef = pdf.context.register(root)
  const item = pdf.context.register(
    pdf.context.obj({
      Title: PDFString.of('Target'),
      Parent: rootRef,
      Dest: [pdf.getPage(1).ref, 'XYZ', 40, 200, null]
    })
  )
  root.set(PDFName.of('First'), item)
  root.set(PDFName.of('Last'), item)
  pdf.catalog.set(PDFName.of('Outlines'), rootRef)
  const output = await generate(pdf, [
    {
      source: 'Introduction.',
      translation: 'Expanded introduction. '.repeat(400),
      fragments: [fragment(1, 0.08)]
    },
    {
      source: 'Target paragraph.',
      translation: 'Translated target.',
      fragments: [fragment(2, 0.08)]
    }
  ])
  expect(output.layoutFailures).toEqual([
    expect.objectContaining({ code: 'annotations', unitIndex: 1 })
  ])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise,
      outline = (await parsed.getOutline())!
    expect(parsed.numPages).toBeGreaterThan(2)
    const dest = outline[0].dest as unknown[]
    expect(await parsed.getPageIndex(dest[0] as { num: number; gen: number })).toBe(
      parsed.numPages - 1
    )
    expect(dest.slice(2)).toEqual([40, 200, null])
    const text = await (await parsed.getPage(parsed.numPages)).getTextContent()
    expect(text.items.map((item) => ('str' in item ? item.str : '')).join(' ')).toContain(
      'Target paragraph.'
    )
  } finally {
    await task.destroy()
  }
})

it.each(['external-action', 'chained-action', 'unresolved', 'cycle', 'null-fit'])(
  'preserves the complete original PDF for an unsupported outline (%s)',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([400, 500]).drawText('Original.', { font, size: 12, x: 40, y: 440 })
    const root = pdf.context.obj({ Type: 'Outlines', Count: 1 }),
      rootRef = pdf.context.register(root)
    const node = pdf.context.obj({
      Title: PDFString.of('Bookmark'),
      Parent: rootRef,
      ...(kind === 'external-action'
        ? { A: { S: 'URI', URI: PDFString.of('https://example.org') } }
        : kind === 'chained-action'
          ? {
              A: {
                S: 'GoTo',
                D: [pdf.getPage(0).ref, 'Fit'],
                Next: { S: 'GoTo', D: [pdf.getPage(0).ref, 'Fit'] }
              }
            }
          : {
              Dest:
                kind === 'unresolved'
                  ? PDFString.of('missing')
                  : kind === 'null-fit'
                    ? [pdf.getPage(0).ref, 'FitH', null]
                    : [pdf.getPage(0).ref, 'Fit']
            })
    })
    const ref = pdf.context.register(node)
    if (kind === 'cycle') node.set(PDFName.of('Next'), ref)
    root.set(PDFName.of('First'), ref)
    root.set(PDFName.of('Last'), ref)
    pdf.catalog.set(PDFName.of('Outlines'), rootRef)
    const bytes = await pdf.save()
    const output = await generate(pdf, [
      { source: 'Original.', translation: 'Translated.', fragments: [fragment(1, 0.08)] }
    ])
    expect(output.data).toEqual(bytes)
    expect(output.layoutFailures).toEqual([
      expect.objectContaining({ code: 'annotations', unitIndex: 0 })
    ])
  }
)

it.each([false, true])(
  'rejects populated signature fields before rewriting (reflow=%s)',
  async (reflow) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([400, 500])
    page.drawText('Original.', { font, size: 12, x: 40, y: 440 })
    // This is a populated signature dictionary, not a cryptographically validated signature.
    // Both paths must enforce the existing native signature-count policy before rewriting.
    const signature = pdf.context.register(
      pdf.context.obj({
        Type: 'Sig',
        Filter: 'Adobe.PPKLite',
        SubFilter: 'adbe.pkcs7.detached',
        ByteRange: [0, 1, 2, 3],
        Contents: PDFHexString.of('00')
      })
    )
    const field = pdf.context.register(
      pdf.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: PDFString.of('Signature1'),
        V: signature,
        Rect: [0, 0, 0, 0],
        P: page.ref
      })
    )
    page.node.addAnnot(field)
    pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [field], SigFlags: 3 }))
    const caller = new TestCallerRegistry().acquire({ leaseId: 'signed-pdf', surface: 'electron' })
    try {
      await expect(
        new PdfTranslationWriter(() => resolve('resources/worker.mjs')).generateDetailed(
          {
            id: 'signed-pdf',
            ...(reflow ? { layout: 'reflow' as const } : {}),
            data: await pdf.save(),
            pages: [{ width: 400, height: 500 }],
            units: [
              { source: 'Original.', translation: 'Translated.', fragments: [fragment(1, 0.08)] }
            ]
          },
          caller.lease
        )
      ).rejects.toMatchObject({ failure: { code: 'unsupported-layout' } })
    } finally {
      caller.release()
    }
  }
)
