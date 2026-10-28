import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
  degrees,
  rgb
} from 'pdf-lib'
import { createCanvas } from '@napi-rs/canvas'
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
  options: Partial<Pick<PdfTranslationPdfRequest, 'originalRegions' | 'pages'>> = {}
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

it.each([false, true])(
  'paginates translated text and preserves Form graphics (explicit figure=%s)',
  async (explicit) => {
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
          ...(explicit
            ? {
                originalRegions: [
                  { pageNumber: 1, rect: { x: 0.1, y: 0.3, width: 0.75, height: 0.18 } }
                ]
              }
            : {}),
          units: [
            { source: 'Original body.', translation, fragments: [fragment(1, 0.08)] },
            // Labels remain in the figure crop; translating them separately would duplicate them.
            {
              source: 'Figure label',
              translation: 'Figure label',
              fragments: [{ pageNumber: 1, rect: { x: 0.125, y: 0.39, width: 0.2, height: 0.04 } }]
            },
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
      // Only an explicit region establishes that the disconnected panels form one figure.
      // Both paths retain the failed paragraph as an additional original crop.
      expect(figures).toBe(explicit ? 2 : 3)
    } finally {
      await task?.destroy()
      caller.release()
    }
  }
)

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

it('retains source coordinates when supplied viewport dimensions mismatch the CropBox', async () => {
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
  // Only the mismatched source page is retained; its target can still reflow.
  expect(output.layoutFailures).toEqual([
    expect.objectContaining({ code: 'unsupported-layout', unitIndex: 0 })
  ])
  expect(output.reflow!.originalPageNumbers).toEqual([1])
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

it.each(['Text', 'Highlight', 'Widget', 'visible-form', 'hidden-form', 'xfa'])(
  'retains the complete original document for unsupported annotations/forms (%s)',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    for (const label of ['Introduction.', 'Original.'])
      pdf.addPage([400, 500]).drawText(label, { font, size: 12, x: 40, y: 440 })
    const page = pdf.getPage(1)
    if (kind.endsWith('-form')) {
      const field = pdf.getForm().createTextField('review-field')
      field.setText('User-entered value')
      if (kind === 'visible-form')
        field.addToPage(page, { x: 40, y: 350, width: 200, height: 30, font })
    } else if (kind === 'xfa') {
      const packet = pdf.context.register(
        pdf.context.stream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>')
      )
      pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields: [], XFA: packet }))
    } else {
      page.node.addAnnot(
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: kind,
            Rect: [40, 438, 100, 454],
            Contents: PDFString.of('Keep this review comment'),
            ...(kind === 'Highlight' ? { QuadPoints: [40, 454, 100, 454, 40, 438, 100, 438] } : {}),
            ...(kind === 'Widget'
              ? { FT: 'Tx', T: PDFString.of('orphan-field'), V: PDFString.of('Keep this value') }
              : {})
          })
        )
      )
    }
    const bytes = await pdf.save()
    const output = await generate(pdf, [
      {
        source: 'Introduction.',
        translation: 'Translated introduction.',
        fragments: [fragment(1, 0.08)]
      },
      { source: 'Original.', translation: 'Translated.', fragments: [fragment(2, 0.08)] }
    ])
    expect(output.data).toEqual(bytes)
    expect(output.reflow!.originalPageNumbers).toEqual([1, 2])
    expect(output.layoutFailures).toEqual([
      expect.objectContaining({ code: 'annotations', unitIndex: 0 }),
      expect.objectContaining({ code: 'annotations', unitIndex: 1 })
    ])
  }
)

it.each([
  { kind: 'crop', offset: 36.8504 },
  { kind: 'media', offset: 36.8504 },
  { kind: 'crop', offset: -36.8504 },
  { kind: 'media', offset: -36.8504 }
])(
  'reflows translated text, a complete figure and links with $kind origin $offset',
  async ({ kind, offset }) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([500, 600])
    if (kind === 'crop') {
      page.setMediaBox(offset - 20, offset - 20, 440, 540)
      page.setCropBox(offset, offset, 400, 500)
    } else page.setMediaBox(offset, offset, 400, 500)
    page.drawText('Original.', { font, size: 12, x: offset + 40, y: offset + 440 })
    page.drawRectangle({
      x: offset + 60,
      y: offset + 100,
      width: 120,
      height: 80,
      color: rgb(1, 0, 0)
    })
    link(pdf, 1, [offset + 40, offset + 438, offset + 85, offset + 454], {
      A: { S: 'URI', URI: PDFString.of('https://example.org/body') }
    })
    link(pdf, 1, [offset + 80, offset + 120, offset + 100, offset + 140], {
      A: { S: 'URI', URI: PDFString.of('https://example.org/figure') }
    })
    const output = await generate(
      pdf,
      [{ source: 'Original.', translation: 'Translated.', fragments: [fragment(1, 0.08)] }],
      { pages: [{ width: 400, height: 500 }] }
    )
    expect(output.reflow!.originalPageNumbers).toEqual([])
    expect(output.layoutFailures).toEqual([])
    const task = getDocument({ data: output.data.slice() })
    try {
      const parsed = await task.promise,
        first = await parsed.getPage(1),
        content = await first.getTextContent()
      expect(parsed.numPages).toBe(1)
      expect(content.items.map((item) => ('str' in item ? item.str : '')).join(' ')).toContain(
        'Translated.'
      )
      expect((await first.getAnnotations()).map((annotation) => annotation.url).sort()).toEqual([
        'https://example.org/body',
        'https://example.org/figure'
      ])
      const viewport = first.getViewport({ scale: 1 }),
        canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)),
        context = canvas.getContext('2d')
      await first.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport
      }).promise
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let redPixels = 0
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] > 240 && pixels[i + 1] < 15 && pixels[i + 2] < 15) redPixels++
      // A wrong crop origin clips the figure or copies the wrong source region.
      // Allow a two-pixel antialiasing edge on the 120 x 80 point rectangle.
      expect(redPixels).toBeGreaterThan(9200)
      expect(redPixels).toBeLessThan(9900)
    } finally {
      await task.destroy()
    }
  }
)

it.each(['link', 'bookmark'])(
  'preserves the complete FitR rectangle for a %s destination',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    for (const text of ['See target.', 'Target paragraph.'])
      pdf.addPage([400, 500]).drawText(text, { font, size: 12, x: 40, y: 440 })
    const dest = [pdf.getPage(1).ref, 'FitR', 40, 430, 100, 450]
    if (kind === 'link') link(pdf, 1, [40, 438, 120, 454], { Dest: dest })
    else {
      const root = pdf.context.obj({ Type: 'Outlines', Count: 1 }),
        rootRef = pdf.context.register(root)
      const item = pdf.context.register(
        pdf.context.obj({ Title: PDFString.of('Rectangle'), Parent: rootRef, Dest: dest })
      )
      root.set(PDFName.of('First'), item)
      root.set(PDFName.of('Last'), item)
      pdf.catalog.set(PDFName.of('Outlines'), rootRef)
    }
    const output = await generate(pdf, [
      {
        source: 'See target.',
        translation: 'Expanded introduction. '.repeat(400),
        fragments: [fragment(1, 0.08)]
      },
      {
        source: 'Target paragraph.',
        translation: 'Translated target.',
        fragments: [fragment(2, 0.08)]
      }
    ])
    expect(output.layoutFailures).toContainEqual(
      expect.objectContaining({ code: 'annotations', unitIndex: 1 })
    )
    const task = getDocument({ data: output.data.slice() })
    try {
      const parsed = await task.promise
      const destination =
        kind === 'link'
          ? (await (await parsed.getPage(1)).getAnnotations())[0].dest
          : (await parsed.getOutline())![0].dest
      expect(destination.slice(1)).toEqual([{ name: 'FitR' }, 40, 430, 100, 450])
      const targetIndex = await parsed.getPageIndex(destination[0])
      expect(output.reflow!.originalPageNumbers).toContain(targetIndex + 1)
      if (kind === 'bookmark') expect(targetIndex).toBeGreaterThan(1)
    } finally {
      await task.destroy()
    }
  }
)

it.each([false, true])(
  'reflows ordinary fractional A4 bounds despite native float rounding (linked=%s)',
  async (linked) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([595.28, 841.89]).drawText('Original.', { font, size: 12, x: 60, y: 760 })
    if (linked)
      link(pdf, 1, [60, 758, 110, 774], {
        A: { S: 'URI', URI: PDFString.of('https://example.org') }
      })
    const output = await generate(pdf, [
      { source: 'Original.', translation: 'Translated.', fragments: [fragment(1, 0.08)] }
    ])
    expect(output.layoutFailures).toEqual([])
    expect(output.reflow!.originalPageNumbers).toEqual([])
    const task = getDocument({ data: output.data.slice() })
    try {
      const parsed = await task.promise,
        page = await parsed.getPage(1),
        text = await page.getTextContent()
      expect(text.items.map((item) => ('str' in item ? item.str : '')).join(' ')).toContain(
        'Translated.'
      )
      if (linked) expect((await page.getAnnotations())[0].url).toBe('https://example.org/')
    } finally {
      await task.destroy()
    }
  }
)

it('preserves ordinary document metadata and attachments while translating the paper', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.setTitle('Ordinary academic paper')
  pdf.setAuthor('Paper author')
  pdf.setSubject('Reflow preservation')
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info, PDFDict)
  info.set(PDFName.of('CustomResearchId'), PDFHexString.fromText('研究-123'))
  const xmp =
    '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><description>Research metadata</description></x:xmpmeta><?xpacket end="w"?>'
  pdf.catalog.set(
    PDFName.of('Metadata'),
    pdf.context.register(pdf.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' }))
  )
  pdf.catalog.set(PDFName.of('Lang'), PDFString.of('en-US'))
  pdf.catalog.set(PDFName.of('MarkInfo'), pdf.context.obj({ Marked: false }))
  pdf.catalog.getOrCreateViewerPreferences().setDisplayDocTitle(true)
  const attachment = new TextEncoder().encode('Supplementary results: 123')
  await pdf.attach(attachment, '补充材料.txt', { mimeType: 'text/plain' })
  pdf.addPage([400, 500]).drawText('Original paper body.', { font, x: 40, y: 440, size: 12 })
  // Exercise nested name trees and the shared Names/EmbeddedFiles + AF file specification.
  await pdf.save()
  const names = pdf.catalog.lookup(PDFName.of('Names'), PDFDict)
  const files = names.lookup(PDFName.of('EmbeddedFiles'), PDFDict)
  names.set(PDFName.of('EmbeddedFiles'), pdf.context.obj({ Kids: [pdf.context.register(files)] }))
  const output = await generate(pdf, [
    {
      source: 'Original paper body.',
      translation: 'Translated paper body.',
      fragments: [fragment(1, 0.08)]
    }
  ])
  expect(output.layoutFailures).toEqual([])
  expect(output.reflow?.originalPageNumbers).toEqual([])
  const saved = await PDFDocument.load(output.data, { updateMetadata: false })
  expect(saved.getTitle()).toBe('Ordinary academic paper')
  expect(saved.getAuthor()).toBe('Paper author')
  expect(saved.getSubject()).toBe('Reflow preservation')
  expect(
    saved.context
      .lookup(saved.context.trailerInfo.Info, PDFDict)
      .lookup(PDFName.of('CustomResearchId'), PDFHexString)
      .decodeText()
  ).toBe('研究-123')
  const savedNames = saved.catalog.lookup(PDFName.of('Names'), PDFDict)
  const savedFiles = savedNames
    .lookup(PDFName.of('EmbeddedFiles'), PDFDict)
    .lookup(PDFName.of('Kids'), PDFArray)
    .lookup(0, PDFDict)
  const fileRef = savedFiles.lookup(PDFName.of('Names'), PDFArray).get(1)
  expect(saved.catalog.lookup(PDFName.of('AF'), PDFArray).get(0)).toEqual(fileRef)
  const task = getDocument({ data: output.data.slice() })
  try {
    const doc = await task.promise
    expect((await doc.getMetadata()).metadata?.getRaw()).toContain('Research metadata')
    const attachments = Object.values((await doc.getAttachments())!)
    expect(attachments).toHaveLength(1)
    expect(attachments[0].filename).toBe('补充材料.txt')
    expect(attachments[0].content).toEqual(attachment)
    expect((await doc.getViewerPreferences())?.DisplayDocTitle).toBe(true)
    expect(
      (await (await doc.getPage(1)).getTextContent()).items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join(' ')
    ).toContain('Translated paper body.')
  } finally {
    await task.destroy()
  }
})

it('remaps page labels, print ranges, unreferenced named destinations and opening targets after expansion', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const source of ['First paragraph.', 'Second paragraph.'])
    pdf.addPage([400, 500]).drawText(source, { font, x: 40, y: 440, size: 12 })
  pdf.catalog.set(
    PDFName.of('PageLabels'),
    pdf.context.obj({
      Kids: [
        pdf.context.obj({ Nums: [0, { S: 'r' }, 1, { S: 'D', P: PDFString.of('Paper-'), St: 7 }] })
      ]
    })
  )
  pdf.catalog.set(PDFName.of('ViewerPreferences'), pdf.context.obj({ PrintPageRange: [1, 1] }))
  const target = [pdf.getPage(1).ref, 'XYZ', 40, 450, null]
  pdf.catalog.set(
    PDFName.of('Names'),
    pdf.context.obj({ Dests: { Names: [PDFHexString.fromText('目标'), { D: target }] } })
  )
  pdf.catalog.set(PDFName.of('Dests'), pdf.context.obj({ legacy: [pdf.getPage(0).ref, 'Fit'] }))
  pdf.catalog.set(
    PDFName.of('OpenAction'),
    pdf.context.obj({ S: 'GoTo', D: PDFHexString.fromText('目标') })
  )
  const output = await generate(pdf, [
    {
      source: 'First paragraph.',
      translation: 'Expanded translated paragraph. '.repeat(500),
      fragments: [fragment(1, 0.08)]
    },
    {
      source: 'Second paragraph.',
      translation: 'Translated second paragraph.',
      fragments: [fragment(2, 0.08)]
    }
  ])
  expect(output.layoutFailures).toEqual([])
  expect(output.reflow?.originalPageNumbers).toEqual([])
  const primary = output.reflow!.sourcePageNumbers
  expect(primary.filter((number) => number === 1).length).toBeGreaterThan(1)
  const task = getDocument({ data: output.data.slice() })
  try {
    const doc = await task.promise
    expect(await doc.getPageLabels()).toEqual(
      primary.map((number) => (number === 1 ? 'i' : 'Paper-7'))
    )
    expect((await doc.getViewerPreferences())?.PrintPageRange).toEqual([
      1,
      primary.lastIndexOf(1) + 1
    ])
    const named = await doc.getDestination('目标')
    expect(await doc.getPageIndex(named![0])).toBe(
      output.reflow!.sourcePages!.findIndex((pages) => pages.includes(2))
    )
    const legacy = await doc.getDestination('legacy')
    expect(await doc.getPageIndex(legacy![0])).toBe(0)
    const open = await doc.getOpenAction()
    expect(await doc.getPageIndex(open!.dest![0])).toBe(
      output.reflow!.sourcePages!.findIndex((pages) => pages.includes(2))
    )
  } finally {
    await task.destroy()
  }
})

async function blankPageAnchorFixture(): Promise<{
  pdf: PDFDocument
  units: PdfTranslationPdfRequest['units']
}> {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const source of ['First original paragraph.', 'Second original paragraph.'])
    pdf.addPage([400, 500]).drawText(source, { font, x: 40, y: 440, size: 12 })
  pdf.catalog.set(
    PDFName.of('Names'),
    pdf.context.obj({
      Dests: {
        Names: pdf
          .getPages()
          .flatMap((page, index) => [
            PDFString.of(`page.${index + 1}`),
            [page.ref, 'XYZ', 40, 490, null]
          ])
      }
    })
  )
  return {
    pdf,
    units: [
      {
        source: 'First original paragraph.',
        translation: 'A translated first paragraph.',
        fragments: [fragment(1, 0.08)]
      },
      {
        source: 'Second original paragraph.',
        translation: 'Second original paragraph.',
        fragments: [fragment(2, 0.08)]
      }
    ]
  }
}

it('maps a complete native page anchor from a blank top strip to its emitted first paragraph', async () => {
  const { pdf, units } = await blankPageAnchorFixture(),
    output = await generate(pdf, units)
  expect(output.layoutFailures).toEqual([])
  expect(output.reflow?.originalPageNumbers).toEqual([2])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise,
      first = await parsed.getDestination('page.1'),
      second = await parsed.getDestination('page.2')
    expect(first?.slice(1)).toEqual([{ name: 'XYZ' }, 44, 797.89, null])
    expect(await parsed.getPageIndex(first![0])).toBe(0)
    expect(second?.slice(1)).toEqual([{ name: 'XYZ' }, 40, 490, null])
    expect(await parsed.getPageIndex(second![0])).toBe(1)
    const text = await (await parsed.getPage(1)).getTextContent()
    expect(text.items.map((item) => ('str' in item ? item.str : '')).join('')).toContain(
      'A translated first paragraph.'
    )
  } finally {
    await task.destroy()
  }
})

it.each([
  'missing family member',
  'wrong source page',
  'duplicate name',
  'relative coordinate',
  'non-null zoom',
  'named alias',
  'generic XYZ',
  'top path',
  'top image',
  'top annotation',
  'unsupported form',
  'incomplete first owner',
  'foreign first-owner paint',
  'first owner not emitted as text',
  'multiple output pages',
  'joined first owner'
])('retains the source page when the blank page anchor lacks %s evidence', async (variant) => {
  const { pdf, units: originalUnits } = await blankPageAnchorFixture(),
    names = pdf.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('Dests'), PDFDict),
    entries = names.lookup(PDFName.of('Names'), PDFArray),
    first = entries.lookup(1, PDFArray)
  let units = originalUnits
  switch (variant) {
    case 'missing family member':
      entries.remove(3)
      entries.remove(2)
      break
    case 'wrong source page':
      entries.lookup(3, PDFArray).set(0, pdf.getPage(0).ref)
      break
    case 'duplicate name':
      entries.set(2, PDFString.of('page.1'))
      break
    case 'relative coordinate':
      first.set(2, pdf.context.obj(null))
      break
    case 'non-null zoom':
      first.set(4, pdf.context.obj(1))
      break
    case 'named alias':
      entries.set(3, PDFString.of('page.1'))
      break
    case 'generic XYZ':
      entries.push(PDFString.of('section.1'))
      entries.push(first)
      break
    case 'top path':
      pdf.getPage(0).drawRectangle({ x: 200, y: 480, width: 10, height: 10 })
      break
    case 'top image': {
      const canvas = createCanvas(2, 2)
      canvas.getContext('2d').fillRect(0, 0, 2, 2)
      const image = await pdf.embedPng(canvas.toBuffer('image/png'))
      pdf.getPage(0).drawImage(image, { x: 200, y: 480, width: 10, height: 10 })
      break
    }
    case 'top annotation':
      link(pdf, 1, [40, 485, 100, 495], {
        A: { S: 'URI', URI: PDFString.of('https://example.org') }
      })
      break
    case 'unsupported form': {
      const form = await pdf.embedPage(pdf.getPage(1))
      pdf.getPage(0).drawPage(form, { x: 200, y: 100, width: 100, height: 125 })
      break
    }
    case 'incomplete first owner':
      units = [
        {
          ...units[0],
          fragments: [{ pageNumber: 1, rect: { x: 0.1, y: 0.08, width: 0.02, height: 0.05 } }]
        },
        units[1]
      ]
      break
    case 'foreign first-owner paint':
      pdf.getPage(0).drawRectangle({ x: 45, y: 441, width: 2, height: 2 })
      break
    case 'first owner not emitted as text':
      pdf.getPage(0).drawText('Another original paragraph.', {
        font: await pdf.embedFont(StandardFonts.Helvetica),
        x: 40,
        y: 380,
        size: 12
      })
      units = [
        { ...units[0], translation: units[0].source },
        units[1],
        {
          source: 'Another original paragraph.',
          translation: 'Another translated paragraph.',
          fragments: [fragment(1, 0.2)]
        }
      ]
      break
    case 'multiple output pages':
      units = [
        { ...units[0], translation: 'An expanded translated paragraph. '.repeat(1000) },
        units[1]
      ]
      break
    case 'joined first owner':
      units = [{ ...units[0], fragments: [...units[0].fragments, fragment(2, 0.08)] }, units[1]]
      break
  }
  const output = await generate(pdf, units)
  if (variant === 'duplicate name') {
    expect(output.data).toEqual(await pdf.save())
    expect(output.layoutFailures).toEqual([expect.objectContaining({ code: 'document-structure' })])
    return
  }
  expect(output.layoutFailures).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'annotations' })])
  )
  expect(output.reflow?.originalPageNumbers).toContain(1)
})

it('preserves a named FitR target on its original page with a valid output page reference', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const source of ['First paragraph.', 'Second paragraph.'])
    pdf.addPage([400, 500]).drawText(source, { font, x: 40, y: 440, size: 12 })
  pdf.catalog.set(
    PDFName.of('Names'),
    pdf.context.obj({
      Dests: { Names: [PDFString.of('target'), [pdf.getPage(1).ref, 'FitR', 10, 20, 300, 450]] }
    })
  )
  const output = await generate(pdf, [
    {
      source: 'First paragraph.',
      translation: 'Expanded translated paragraph. '.repeat(500),
      fragments: [fragment(1, 0.08)]
    },
    {
      source: 'Second paragraph.',
      translation: 'Translated second paragraph.',
      fragments: [fragment(2, 0.08)]
    }
  ])
  const task = getDocument({ data: output.data.slice() })
  try {
    const doc = await task.promise,
      dest = (await doc.getDestination('target'))!
    expect(dest.slice(1)).toEqual([{ name: 'FitR' }, 10, 20, 300, 450])
    const number = (await doc.getPageIndex(dest[0])) + 1
    expect(number).toBeGreaterThan(2)
    expect(output.reflow!.originalPageNumbers).toContain(number)
  } finally {
    await task.destroy()
  }
})

it.each([
  'StructTreeRoot',
  'OCProperties',
  'UnknownCatalogFeature',
  'OpenAction',
  'Names',
  'MarkInfo',
  'PageLabels'
])(
  'keeps the exact original document with a structural diagnostic for unsupported %s',
  async (key) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    pdf.addPage([400, 500]).drawText('Original.', { font, x: 40, y: 440, size: 12 })
    const value =
      key === 'OpenAction'
        ? { S: 'JavaScript', JS: PDFString.of('void 0') }
        : key === 'Names'
          ? { JavaScript: { Names: [] } }
          : key === 'MarkInfo'
            ? { Marked: true }
            : key === 'PageLabels'
              ? { Nums: [0, { S: 'InvalidStyle' }] }
              : { Source: pdf.getPage(0).ref }
    pdf.catalog.set(PDFName.of(key), pdf.context.obj(value))
    const original = await pdf.save()
    const output = await generate(pdf, [
      { source: 'Original.', translation: 'Translated.', fragments: [fragment(1, 0.08)] }
    ])
    expect(output.data).toEqual(original)
    expect(output.layoutFailures).toEqual([
      expect.objectContaining({ code: 'document-structure', unitIndex: 0 })
    ])
  }
)

it('rejects page references hidden inside nominally independent metadata without copying the source page tree', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([400, 500]).drawText('Original.', { font, x: 40, y: 440, size: 12 })
  pdf.context
    .lookup(pdf.context.trailerInfo.Info, PDFDict)
    .set(PDFName.of('CustomPage'), pdf.getPage(0).ref)
  const output = await generate(pdf, [
    { source: 'Original.', translation: 'Translated.', fragments: [fragment(1, 0.08)] }
  ])
  expect(output.data).toEqual(await pdf.save())
  expect(output.layoutFailures[0].code).toBe('document-structure')
})

it('bounds cyclic catalog name trees and preserves their original bytes', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([400, 500]).drawText('Original.', { font, x: 40, y: 440, size: 12 })
  const tree = pdf.context.obj({}),
    ref = pdf.context.register(tree)
  tree.set(PDFName.of('Kids'), pdf.context.obj([ref]))
  pdf.catalog.set(PDFName.of('Names'), pdf.context.obj({ EmbeddedFiles: ref }))
  const output = await generate(pdf, [
    { source: 'Original.', translation: 'Translated.', fragments: [fragment(1, 0.08)] }
  ])
  expect(output.data).toEqual(await pdf.save())
  expect(output.layoutFailures[0].code).toBe('document-structure')
})

it('uses the primary source label and includes a shared output page when a print range selects its other source', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const source of ['First paragraph.', 'Second paragraph.'])
    pdf.addPage([400, 500]).drawText(source, { font, x: 40, y: 440, size: 12 })
  pdf.catalog.set(
    PDFName.of('PageLabels'),
    pdf.context.obj({ Nums: [0, { S: 'r' }, 1, { S: 'D', St: 7 }] })
  )
  pdf.catalog.set(PDFName.of('ViewerPreferences'), pdf.context.obj({ PrintPageRange: [2, 2] }))
  const output = await generate(pdf, [
    {
      source: 'First paragraph.',
      translation: 'Translated first paragraph.',
      fragments: [fragment(1, 0.08)]
    },
    {
      source: 'Second paragraph.',
      translation: 'Translated second paragraph.',
      fragments: [fragment(2, 0.08)]
    }
  ])
  expect(output.layoutFailures).toEqual([])
  expect(output.reflow!.sourcePages).toEqual([[1, 2]])
  const task = getDocument({ data: output.data.slice() })
  try {
    const doc = await task.promise
    expect(await doc.getPageLabels()).toEqual(['i'])
    expect((await doc.getViewerPreferences())?.PrintPageRange).toEqual([1, 1])
  } finally {
    await task.destroy()
  }
})

it('retains nonstandard zero-based print ranges instead of guessing their intended pages', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([400, 500]).drawText('Original.', { font, x: 40, y: 440, size: 12 })
  pdf.catalog.set(PDFName.of('ViewerPreferences'), pdf.context.obj({ PrintPageRange: [0, 0] }))
  const output = await generate(pdf, [
    { source: 'Original.', translation: 'Translated.', fragments: [fragment(1, 0.08)] }
  ])
  expect(output.data).toEqual(await pdf.save())
  expect(output.layoutFailures[0].code).toBe('document-structure')
})

it.each(['plain', 'explicit-region', 'nested-form', 'joined'] as const)(
  'retains scanned content without duplicating its OCR translation (%s)',
  async (mode) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      canvas = createCanvas(400, 500),
      context = canvas.getContext('2d')
    context.fillStyle = 'white'
    context.fillRect(0, 0, 400, 500)
    context.fillStyle = 'black'
    context.font = '12px sans-serif'
    context.fillText('Scanned original body.', 40, 60)
    // A visual figure absent from the OCR proves that silently dropping the scan is unsafe.
    context.fillStyle = '#3380cc'
    context.fillRect(40, 200, 150, 100)
    const image = await pdf.embedPng(canvas.toBuffer('image/png')),
      page = pdf.addPage([400, 500])
    if (mode === 'nested-form') {
      const inner = await PDFDocument.create(),
        innerPage = inner.addPage([200, 250]),
        innerImage = await inner.embedPng(canvas.toBuffer('image/png'))
      innerPage.drawImage(innerImage, { x: 0, y: 0, width: 200, height: 250 })
      await inner.flush()
      const form = await pdf.embedPage(innerPage)
      page.drawPage(form, { x: 0, y: 0, xScale: 2, yScale: 2 })
    } else page.drawImage(image, { x: 0, y: 0, width: 400, height: 500 })
    page.drawText('Scanned original body.', { font, x: 40, y: 440, size: 12, opacity: 0 })
    if (mode === 'joined')
      pdf.addPage([400, 500]).drawText('Continued source.', { font, x: 40, y: 440, size: 12 })
    pdf.addPage([400, 500]).drawText('Independent source.', { font, x: 40, y: 440, size: 12 })
    const joined = mode === 'joined',
      independentPage = joined ? 3 : 2,
      output = await generate(
        pdf,
        [
          {
            source: joined ? 'Scanned original body. Continued source.' : 'Scanned original body.',
            translation: 'Translated scanned body.',
            fragments: [fragment(1, 0.08), ...(joined ? [fragment(2, 0.08)] : [])]
          },
          {
            source: 'Independent source.',
            translation: 'Independent translation.',
            fragments: [fragment(independentPage, 0.08)]
          }
        ],
        mode === 'explicit-region'
          ? { originalRegions: [{ pageNumber: 1, rect: { x: 0, y: 0, width: 1, height: 1 } }] }
          : {}
      )
    expect(output.layoutFailures).toEqual([
      expect.objectContaining({
        unitIndex: 0,
        code: 'unsupported-layout',
        pageNumbers: joined ? [1, 2] : [1]
      })
    ])
    expect(output.reflow!.originalPageNumbers).toEqual(joined ? [1, 2] : [1])
    const task = getDocument({ data: output.data.slice() })
    try {
      const parsed = await task.promise,
        first = await parsed.getPage(1),
        operators = await first.getOperatorList(),
        texts = []
      expect(parsed.numPages).toBe(independentPage)
      expect(operators.fnArray.filter((op) => op === OPS.paintImageXObject)).toHaveLength(1)
      for (let number = 1; number <= parsed.numPages; number++) {
        const content = await (await parsed.getPage(number)).getTextContent()
        texts.push(
          content.items
            .filter((item) => 'str' in item)
            .map((item) => item.str)
            .join(' ')
        )
      }
      expect(texts[0]).toContain('Scanned original body.')
      expect(texts.join(' ')).not.toContain('Translated scanned body.')
      expect(texts.at(-1)).toContain('Independent translation.')
      if (joined) expect(texts[1]).toContain('Continued source.')
    } finally {
      await task.destroy()
    }
  }
)

it('keeps an explicitly identified large figure separate from its translated caption', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    canvas = createCanvas(400, 440),
    context = canvas.getContext('2d')
  context.fillStyle = '#3380cc'
  context.fillRect(0, 0, 400, 440)
  const image = await pdf.embedPng(canvas.toBuffer('image/png')),
    page = pdf.addPage([400, 500])
  page.drawImage(image, { x: 0, y: 60, width: 400, height: 440 })
  page.drawText('Figure 1. Original caption.', { font, x: 40, y: 25, size: 12 })
  const output = await generate(
    pdf,
    [
      {
        source: 'Figure 1. Original caption.',
        translation: 'Figure 1. Translated caption.',
        fragments: [fragment(1, 0.92)]
      }
    ],
    { originalRegions: [{ pageNumber: 1, rect: { x: 0, y: 0, width: 1, height: 0.88 } }] }
  )
  expect(output.layoutFailures).toEqual([])
  expect(output.reflow!.originalPageNumbers).toEqual([])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise,
      first = await parsed.getPage(1),
      operators = await first.getOperatorList(),
      content = await first.getTextContent()
    expect(parsed.numPages).toBe(1)
    expect(operators.fnArray.filter((op) => op === OPS.paintImageXObject)).toHaveLength(1)
    expect(
      content.items
        .filter((item) => 'str' in item)
        .map((item) => item.str)
        .join(' ')
    ).toContain('Figure 1. Translated caption.')
  } finally {
    await task.destroy()
  }
})

it('keeps the visible part of an off-page raster alongside translated text', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    canvas = createCanvas(400, 500),
    context = canvas.getContext('2d')
  context.fillStyle = '#3380cc'
  context.fillRect(0, 0, 400, 500)
  const image = await pdf.embedPng(canvas.toBuffer('image/png')),
    page = pdf.addPage([400, 500])
  page.drawImage(image, { x: -200, y: 0, width: 400, height: 500 })
  page.drawText('Source.', { font, x: 240, y: 440, size: 12 })
  const output = await generate(pdf, [
    {
      source: 'Source.',
      translation: 'Translated.',
      fragments: [{ pageNumber: 1, rect: { x: 0.6, y: 0.08, width: 0.2, height: 0.05 } }]
    }
  ])
  expect(output.layoutFailures).toEqual([])
  expect(output.reflow!.originalPageNumbers).toEqual([])
  const task = getDocument({ data: output.data.slice() })
  try {
    const parsed = await task.promise,
      first = await parsed.getPage(1),
      operators = await first.getOperatorList(),
      content = await first.getTextContent()
    expect(parsed.numPages).toBe(1)
    expect(operators.fnArray.filter((op) => op === OPS.paintImageXObject)).toHaveLength(1)
    expect(
      content.items
        .filter((item) => 'str' in item)
        .map((item) => item.str)
        .join(' ')
    ).toContain('Translated.')
  } finally {
    await task.destroy()
  }
})

it.each([false, true])(
  'keeps unequal-height table columns separate from translated prose (explicit regions=%s)',
  async (explicit) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([400, 500])
    // The right table overlaps the left table vertically, but their bounding
    // rectangle would also capture the unrelated red body text above the left table.
    page.drawRectangle({ x: 30, y: 60, width: 150, height: 100, color: rgb(0, 0, 1) })
    page.drawRectangle({ x: 220, y: 60, width: 150, height: 300, color: rgb(0, 1, 0) })
    page.drawText('Original body.', { font, x: 30, y: 300, size: 12, color: rgb(1, 0, 0) })
    const translation = '正文应全部排入译本，不因相邻图表而丢失。'.repeat(100)
    const output = await generate(
      pdf,
      [
        {
          source: 'Original body.',
          translation,
          fragments: [{ pageNumber: 1, rect: { x: 0.075, y: 0.37, width: 0.35, height: 0.04 } }]
        }
      ],
      explicit
        ? {
            originalRegions: [
              { pageNumber: 1, rect: { x: 0.075, y: 0.68, width: 0.375, height: 0.2 } },
              { pageNumber: 1, rect: { x: 0.55, y: 0.28, width: 0.375, height: 0.6 } }
            ]
          }
        : {}
    )
    expect(output.layoutFailures).toEqual([])
    expect(output.reflow!.originalPageNumbers).toEqual([])
    const task = getDocument({ data: output.data.slice() })
    try {
      const parsed = await task.promise,
        texts: string[] = []
      let images = 0,
        red = 0,
        blue = 0,
        green = 0
      for (let number = 1; number <= parsed.numPages; number++) {
        const current = await parsed.getPage(number),
          content = await current.getTextContent()
        texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''))
        images += (await current.getOperatorList()).fnArray.filter(
          (op) => op === OPS.paintImageXObject
        ).length
        const viewport = current.getViewport({ scale: 1 }),
          canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)),
          context = canvas.getContext('2d')
        await current.render({ canvasContext: context, viewport }).promise
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        for (let at = 0; at < pixels.length; at += 4) {
          if (pixels[at] > 180 && pixels[at + 1] < 100 && pixels[at + 2] < 100) red++
          if (pixels[at] < 100 && pixels[at + 1] < 100 && pixels[at + 2] > 180) blue++
          if (pixels[at] < 100 && pixels[at + 1] > 180 && pixels[at + 2] < 100) green++
        }
      }
      expect(texts.join('').replace(/\s/gu, '')).toContain(translation)
      expect(blue).toBeGreaterThan(1000)
      expect(green).toBeGreaterThan(1000)
      expect(images).toBe(2)
      expect(red).toBe(0)
    } finally {
      await task.destroy()
    }
  }
)

it.each([
  'shading',
  'border',
  'decorative-path',
  'connected',
  'explicit-region',
  'nested-form',
  'merged',
  'label',
  'pixel-edge',
  'joined'
] as const)(
  'does not screenshot source prose with a vector background while retaining its translation (%s)',
  async (mode) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([400, 500])
    if (mode === 'merged') {
      // Disconnected same-row paths must stay separate from the body between them.
      for (const x of [10, 350])
        page.drawRectangle({ x, y: 400, width: 30, height: 70, color: rgb(0.8, 0.8, 0.8) })
    } else if (mode === 'connected') {
      // Each arm is safe; their bounding union would capture the body between them.
      page.drawRectangle({ x: 10, y: 350, width: 30, height: 120, color: rgb(0.8, 0.8, 0.8) })
      page.drawRectangle({ x: 10, y: 350, width: 350, height: 30, color: rgb(0.8, 0.8, 0.8) })
    } else if (mode === 'decorative-path') {
      page.drawSvgPath('M 30 0 C 120 15 260 15 370 0 L 340 70 L 60 70 Z', {
        y: 470,
        color: rgb(0.8, 0.8, 0.8)
      })
    } else if (mode === 'pixel-edge') {
      // The mathematical bounds stop short of the prose; raster rounding reaches it.
      page.drawRectangle({ x: 49.8, y: 400, width: 30, height: 70, color: rgb(0.8, 0.8, 0.8) })
    } else if (mode === 'label') {
      page.drawRectangle({ x: 10, y: 400, width: 65, height: 70, color: rgb(0.8, 0.8, 0.8) })
      page.drawText('Label', { font, x: 35, y: 405, size: 12 })
    } else if (mode === 'nested-form') {
      const inner = await PDFDocument.create(),
        innerPage = inner.addPage([200, 250])
      innerPage.drawRectangle({
        x: 15,
        y: 200,
        width: 170,
        height: 35,
        color: rgb(0.8, 0.8, 0.8)
      })
      await inner.flush()
      page.drawPage(await pdf.embedPage(innerPage), { x: 0, y: 0, xScale: 2, yScale: 2 })
    } else if (mode !== 'explicit-region') {
      page.drawRectangle({
        x: 30,
        y: 400,
        width: 340,
        height: 70,
        ...(mode === 'border'
          ? { borderColor: rgb(0, 0, 0), borderWidth: 1 }
          : { color: rgb(0.8, 0.8, 0.8) })
      })
    }
    const sourceBody = mode === 'pixel-edge' ? 'jOriginal callout body.' : 'Original callout body.'
    page.drawText(sourceBody, { font, x: 80, y: 440, size: 12, color: rgb(1, 0, 0) })
    const joined = mode === 'joined',
      independentPage = joined ? 3 : 2
    if (joined)
      pdf.addPage([400, 500]).drawText('Continued source.', { font, x: 40, y: 440, size: 12 })
    pdf.addPage([400, 500]).drawText('Independent source.', { font, x: 40, y: 440, size: 12 })
    const output = await generate(
      pdf,
      [
        {
          source: joined ? `${sourceBody} Continued source.` : sourceBody,
          translation: 'Translated callout body.',
          fragments: [
            { pageNumber: 1, rect: { x: 0.2, y: 0.08, width: 0.6, height: 0.05 } },
            ...(joined ? [fragment(2, 0.08)] : [])
          ]
        },
        ...(mode === 'label'
          ? [
              {
                source: 'Label',
                translation: 'Label',
                // Protruding label expands the crop into the body column.
                fragments: [
                  { pageNumber: 1, rect: { x: 0.0875, y: 0.17, width: 0.175, height: 0.03 } }
                ]
              }
            ]
          : []),
        {
          source: 'Independent source.',
          translation: 'Independent translation.',
          fragments: [fragment(independentPage, 0.08)]
        }
      ],
      mode === 'explicit-region'
        ? {
            originalRegions: [
              { pageNumber: 1, rect: { x: 0.075, y: 0.06, width: 0.85, height: 0.14 } }
            ]
          }
        : {}
    )
    expect(output.layoutFailures).toEqual([])
    expect(output.reflow!.originalPageNumbers).toEqual([])
    expect(
      output
        .reflow!.units.find((unit) => unit.unitIndex === 0)
        ?.fragments.map((f) => f.text)
        .join('')
    ).toBe('Translated callout body.')
    const task = getDocument({ data: output.data.slice() })
    try {
      const parsed = await task.promise,
        texts: string[] = []
      let red = 0
      for (let number = 1; number <= parsed.numPages; number++) {
        const current = await parsed.getPage(number),
          content = await current.getTextContent()
        const viewport = current.getViewport({ scale: 2 }),
          canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)),
          context = canvas.getContext('2d')
        await current.render({ canvasContext: context, viewport }).promise
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        for (let at = 0; at < pixels.length; at += 4)
          if (pixels[at] > 180 && pixels[at + 1] < 100 && pixels[at + 2] < 100) red++
        texts.push(
          content.items
            .filter((item) => 'str' in item)
            .map((item) => item.str)
            .join(' ')
        )
      }
      const text = texts.join(' ')
      expect(text.match(/Translated callout body\./gu)).toHaveLength(1)
      expect(text).toContain('Independent translation.')
      // Text extraction cannot see old prose embedded in a screenshot; inspect actual pixels.
      expect(red).toBe(0)
      expect(
        (await (await parsed.getPage(1)).getOperatorList()).fnArray.filter(
          (op) => op === OPS.paintImageXObject
        )
      ).toHaveLength(['merged', 'connected', 'label'].includes(mode) ? 2 : 0)
    } finally {
      await task.destroy()
    }
  }
)

it.each([false, true])(
  'reflows a separate vector figure and caption with full-page decoration=%s',
  async (background) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([400, 500])
    if (background)
      page.drawRectangle({ x: 0, y: 0, width: 400, height: 500, color: rgb(0.95, 0.95, 0.95) })
    page.drawRectangle({ x: 40, y: 200, width: 200, height: 150, color: rgb(0.2, 0.4, 0.6) })
    page.drawText('Figure 1. Original caption.', { font, x: 40, y: 150, size: 12 })
    const output = await generate(pdf, [
      {
        source: 'Figure 1. Original caption.',
        translation: 'Figure 1. Translated caption.',
        fragments: [fragment(1, 0.68)]
      }
    ])
    expect(output.layoutFailures).toEqual([])
    expect(output.reflow!.originalPageNumbers).toEqual([])
    const task = getDocument({ data: output.data.slice() })
    try {
      const parsed = await task.promise,
        first = await parsed.getPage(1),
        content = await first.getTextContent()
      expect(parsed.numPages).toBe(1)
      expect(
        (await first.getOperatorList()).fnArray.filter((op) => op === OPS.paintImageXObject)
      ).toHaveLength(1)
      expect(
        content.items
          .filter((item) => 'str' in item)
          .map((item) => item.str)
          .join(' ')
      ).toContain('Figure 1. Translated caption.')
    } finally {
      await task.destroy()
    }
  }
)

it.each(['table', 'figure'] as const)(
  'preserves a verified %s and its original labels when a decorative background also covers prose',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([400, 500])
    page.drawRectangle({ x: 20, y: 60, width: 360, height: 410, color: rgb(0.8, 0.8, 0.8) })
    page.drawRectangle({ x: 40, y: 100, width: 140, height: 100, color: rgb(0, 0, 1) })
    page.drawText('Internal label', { font, x: 50, y: 140, size: 12, color: rgb(0, 1, 0) })
    page.drawText('Original body.', { font, x: 40, y: 440, size: 12, color: rgb(1, 0, 0) })
    const caption = `${kind === 'table' ? 'Table' : 'Figure'} 1. Original caption.`
    page.drawText(caption, { font, x: 40, y: 70, size: 12, color: rgb(1, 0, 0) })
    const output = await generate(
      pdf,
      [
        {
          source: 'Original body.',
          translation: 'Translated body.',
          kind: 'text',
          fragments: [fragment(1, 0.08)]
        },
        {
          source: 'Internal label',
          translation: 'Internal label',
          kind: 'visual',
          fragments: [{ pageNumber: 1, rect: { x: 0.125, y: 0.69, width: 0.2, height: 0.04 } }]
        },
        {
          source: caption,
          translation: 'Translated caption.',
          kind: 'text',
          fragments: [fragment(1, 0.83)]
        }
      ],
      { originalRegions: [{ pageNumber: 1, rect: { x: 0.1, y: 0.6, width: 0.35, height: 0.2 } }] }
    )
    expect(output.layoutFailures).toEqual([])
    expect(output.reflow!.originalPageNumbers).toEqual([])
    const task = getDocument({ data: output.data.slice() })
    try {
      const parsed = await task.promise
      let red = 0,
        blue = 0,
        green = 0,
        images = 0,
        text = ''
      for (let number = 1; number <= parsed.numPages; number++) {
        const current = await parsed.getPage(number),
          content = await current.getTextContent(),
          viewport = current.getViewport({ scale: 2 }),
          canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)),
          context = canvas.getContext('2d')
        text += content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
        images += (await current.getOperatorList()).fnArray.filter(
          (op) => op === OPS.paintImageXObject
        ).length
        await current.render({ canvasContext: context, viewport }).promise
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        for (let at = 0; at < pixels.length; at += 4) {
          if (pixels[at] > 180 && pixels[at + 1] < 100 && pixels[at + 2] < 100) red++
          if (pixels[at] < 100 && pixels[at + 1] < 100 && pixels[at + 2] > 180) blue++
          if (pixels[at] < 100 && pixels[at + 1] > 180 && pixels[at + 2] < 100) green++
        }
      }
      expect(text.match(/Translated body\./gu)).toHaveLength(1)
      expect(text.match(/Translated caption\./gu)).toHaveLength(1)
      expect(images).toBe(1)
      expect(red).toBe(0)
      expect(blue).toBeGreaterThan(1000)
      expect(green).toBeGreaterThan(20)
    } finally {
      await task.destroy()
    }
  }
)
