import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  PDFArray,
  PDFRawStream,
  PDFDict,
  decodePDFRawStream,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  setGraphicsState
} from 'pdf-lib'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from './writer'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import type { PdfTranslationPdfRequest } from '../../../shared/pdf-translation'

const fragment = (
  pageNumber: number
): PdfTranslationPdfRequest['units'][number]['fragments'][number] => ({
  pageNumber,
  rect: { x: 35 / 600, y: 85 / 800, width: 350 / 600, height: 30 / 800 }
})

const pageStreams = async (data: Uint8Array, number: number): Promise<string[]> => {
  const pdf = await PDFDocument.load(data),
    contents = pdf.getPages()[number - 1].node.Contents()
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => pdf.context.lookup(ref))
      : [contents]
  return streams.map((stream) => Buffer.from((stream as PDFRawStream).contents).toString('base64'))
}

describe('incremental translated PDF pages', () => {
  it('isolates shared graphics states only for selected incremental pages', async () => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      state = pdf.context.register(pdf.context.obj({ ca: 0.3, CA: 1, BM: 'Multiply' })),
      shared = pdf.context.register(pdf.context.obj({ Paint: state }))
    for (let index = 0; index < 3; index++) {
      const page = pdf.addPage([600, 800])
      page.drawText('The source paragraph.', { font, size: 12, x: 40, y: 700 })
      page.drawRectangle({ x: 40, y: 150, width: 80, height: 80, color: rgb(0, 0, 1) })
      page.pushOperators(pushGraphicsState(), setGraphicsState('Paint'))
      page.drawRectangle({ x: 70, y: 170, width: 90, height: 80, color: rgb(1, 0, 0) })
      page.pushOperators(popGraphicsState())
      page.node.Resources()!.set(PDFName.of('ExtGState'), shared)
    }
    const data = await pdf.save(),
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
      caller = new ApplicationCallerLeaseRegistry().acquire({
        leaseId: 'shared-incremental',
        surface: 'electron'
      }),
      input = {
        id: 'shared',
        data,
        pages: Array.from({ length: 3 }, () => ({ width: 600, height: 800 })),
        preserveUnsupported: true
      },
      unit = (
        pageNumber: number,
        translation: string
      ): PdfTranslationPdfRequest['units'][number] => ({
        source: 'The source paragraph.',
        translation,
        fragments: [fragment(pageNumber)]
      }),
      tasks: ReturnType<typeof getDocument>[] = []
    try {
      const baseline = (await writer.generate(
          { ...input, units: [unit(1, '第一段。')] },
          caller.lease
        ))!,
        output = (await writer.generate(
          {
            ...input,
            units: [unit(1, '第一段。'), unit(2, '第二段。')],
            incremental: { data: baseline, pageNumbers: [2] }
          },
          caller.lease
        ))!
      expect(await pageStreams(output, 1)).toEqual(await pageStreams(baseline, 1))
      expect(await pageStreams(output, 3)).toEqual(await pageStreams(baseline, 3))
      expect(await pageStreams(output, 2)).not.toEqual(await pageStreams(baseline, 2))
      const parsed = await PDFDocument.load(output)
      for (const page of parsed.getPages()) {
        const contents = page.node.Contents()!,
          streams = contents instanceof PDFArray ? contents.asArray() : [contents],
          text = streams
            .map((ref) => {
              const stream = parsed.context.lookup(ref)
              if (!(stream instanceof PDFRawStream)) throw new Error('Expected a content stream')
              return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')
            })
            .join(''),
          states = page.node.Resources()!.lookup(PDFName.of('ExtGState'), PDFDict)
        for (const match of text.matchAll(/\/([\w]+)\s+gs/gu))
          expect(states.lookup(PDFName.of(match[1]))).toBeInstanceOf(PDFDict)
      }
      const beforeTask = getDocument({ data: baseline.slice(), useSystemFonts: true }),
        afterTask = getDocument({ data: output.slice(), useSystemFonts: true })
      tasks.push(beforeTask, afterTask)
      const before = await beforeTask.promise,
        after = await afterTask.promise
      for (let number = 1; number <= 3; number++) {
        const images = []
        for (const document of [before, after]) {
          const page = await document.getPage(number),
            canvas = createCanvas(600, 800),
            context = canvas.getContext('2d')
          await page.render({
            canvas: null,
            canvasContext: context as never,
            viewport: page.getViewport({ scale: 1 })
          }).promise
          images.push(
            context.getImageData(0, number === 2 ? 200 : 0, 600, number === 2 ? 600 : 800).data
          )
        }
        // Compare every pixel byte natively; recursive assertion traversal of
        // several million array entries can exhaust the test's time budget.
        expect(Buffer.from(images[0]).equals(Buffer.from(images[1]))).toBe(true)
      }
      const text = (await (await after.getPage(2)).getTextContent()).items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
      expect(text).toContain('第二段。')
    } finally {
      for (const task of tasks) await task.destroy()
      caller.release()
    }
  })
  it('reuses complete pages, destinations and bookmarks across repeated page replacement', async () => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    const sources = ['The first paragraph.', 'The second paragraph.', 'The third paragraph.']
    const pages = sources.map((source) => {
      const page = pdf.addPage([600, 800])
      page.drawText(source, { font, size: 12, x: 40, y: 700 })
      page.drawText('[1]', { font, size: 10, x: 40, y: 650 })
      return page
    })
    pages[0].node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [40, 648, 55, 660],
            Border: [0, 0, 0],
            Dest: [pages[1].ref, 'Fit'],
            P: pages[0].ref
          })
        )
      ])
    )
    pages[1].node.set(
      PDFName.of('Annots'),
      pdf.context.obj([
        pdf.context.register(
          pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [40, 648, 55, 660],
            Border: [0, 0, 0],
            Dest: PDFString.of('first-page'),
            P: pages[1].ref
          })
        )
      ])
    )
    pdf.catalog.set(
      PDFName.of('Names'),
      pdf.context.obj({
        Dests: { Names: [PDFString.of('first-page'), [pages[0].ref, 'Fit']] }
      })
    )
    const outlines = pdf.context.register(pdf.context.obj({ Type: 'Outlines' }))
    const outline = pdf.context.register(
      pdf.context.obj({
        Title: PDFString.of('Second page'),
        Parent: outlines,
        Dest: [pages[1].ref, 'Fit']
      })
    )
    const outlineRoot = pdf.context.lookup(outlines, PDFDict)
    {
      outlineRoot.set(PDFName.of('First'), outline)
      outlineRoot.set(PDFName.of('Last'), outline)
      outlineRoot.set(PDFName.of('Count'), pdf.context.obj(1))
    }
    pdf.catalog.set(PDFName.of('Outlines'), outlines)
    const data = await pdf.save(),
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
      caller = new ApplicationCallerLeaseRegistry().acquire({
        leaseId: 'reader',
        surface: 'electron'
      }),
      unit = (index: number, translation: string): PdfTranslationPdfRequest['units'][number] => ({
        source: sources[index],
        translation,
        fragments: [fragment(index + 1)]
      }),
      input = {
        id: 'first',
        preserveUnsupported: true,
        data,
        pages: pages.map(() => ({ width: 600, height: 800 }))
      }
    const tasks: ReturnType<typeof getDocument>[] = []
    try {
      const first = (await writer.generate(
        { ...input, units: [unit(0, '第一段。')] },
        caller.lease
      ))!
      const second = (await writer.generate(
        {
          ...input,
          id: 'second',
          units: [unit(0, '第一段。'), unit(1, '第二段。')],
          incremental: { data: first, pageNumbers: [2] }
        },
        caller.lease
      ))!
      const third = (await writer.generate(
        {
          ...input,
          id: 'third',
          units: [unit(0, '第一段。'), unit(1, '已修复段落。')],
          incremental: { data: second, pageNumbers: [2] }
        },
        caller.lease
      ))!
      expect(await pageStreams(second, 1)).toEqual(await pageStreams(first, 1))
      expect(await pageStreams(third, 1)).toEqual(await pageStreams(first, 1))
      expect(await pageStreams(third, 3)).toEqual(await pageStreams(first, 3))
      const task = getDocument({ data: third.slice(), useSystemFonts: true })
      tasks.push(task)
      const document = await task.promise
      expect(document.numPages).toBe(3)
      for (const [index, expected] of ['第一段。', '已修复段落。', sources[2]].entries()) {
        const text = (await (await document.getPage(index + 1)).getTextContent()).items
          .map((item) => ('str' in item ? item.str : ''))
          .join('')
        expect(text).toContain(expected)
      }
      const firstLink = (await (await document.getPage(1)).getAnnotations())[0]
      expect(await document.getPageIndex(firstLink.dest[0])).toBe(1)
      const secondLink = (await (await document.getPage(2)).getAnnotations())[0]
      const destination = await document.getDestination(secondLink.dest)
      expect(await document.getPageIndex(destination![0])).toBe(0)
      const bookmark = (await document.getOutline())![0]
      expect(bookmark.title).toBe('Second page')
      if (!Array.isArray(bookmark.dest)) throw Error('Missing bookmark destination')
      expect(await document.getPageIndex(bookmark.dest[0])).toBe(1)
      // Old page streams/font subsets become unreachable and are not serialized forever.
      expect(third.length).toBeLessThan(second.length * 1.2)
    } finally {
      await Promise.all(tasks.map((task) => task.destroy()))
      caller.release()
    }
  }, 30000)

  it('remaps dirty Form instances into their temporary local page numbers', async () => {
    const chart = await PDFDocument.create(),
      font = await chart.embedFont(StandardFonts.Helvetica),
      chartPage = chart.addPage([200, 200])
    chartPage.drawText('Measured response', { x: 25, y: 150, size: 12, font })
    chartPage.drawRectangle({ x: 25, y: 25, width: 35, height: 90 })
    const pdf = await PDFDocument.create(),
      embedded = await pdf.embedPage(chartPage)
    for (let number = 1; number <= 3; number++)
      pdf.addPage([600, 800]).drawPage(embedded, { x: 50, y: 450, xScale: 1.25, yScale: 1.25 })
    const data = await pdf.save(),
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
      caller = new ApplicationCallerLeaseRegistry().acquire({
        leaseId: 'reader',
        surface: 'electron'
      }),
      unit = (
        pageNumber: number,
        translation: string
      ): PdfTranslationPdfRequest['units'][number] => ({
        source: 'Measured response',
        translation,
        fragments: [
          { pageNumber, rect: { x: 75 / 600, y: 135 / 800, width: 180 / 600, height: 30 / 800 } }
        ]
      }),
      input = {
        id: 'forms',
        preserveUnsupported: true,
        data,
        pages: Array(3).fill({ width: 600, height: 800 })
      }
    let task: ReturnType<typeof getDocument> | undefined
    try {
      const first = (await writer.generate(
        { ...input, units: [unit(1, '测量响应')] },
        caller.lease
      ))!
      const second = (await writer.generate(
        {
          ...input,
          units: [unit(1, '测量响应'), unit(3, '测量结果')],
          incremental: { data: first, pageNumbers: [3] }
        },
        caller.lease
      ))!
      task = getDocument({ data: second.slice(), useSystemFonts: true })
      const document = await task.promise
      for (const [index, expected] of ['测量响应', 'Measured response', '测量结果'].entries()) {
        const text = (await (await document.getPage(index + 1)).getTextContent()).items
          .map((item) => ('str' in item ? item.str : ''))
          .join('')
        expect(text).toContain(expected)
      }
      expect(await pageStreams(second, 1)).toEqual(await pageStreams(first, 1))
      expect(await pageStreams(second, 2)).toEqual(await pageStreams(first, 2))
    } finally {
      await task?.destroy()
      caller.release()
    }
  }, 30000)

  it.each([{ pageNumbers: [0] }, { pageNumbers: [4] }, { pageNumbers: [1, 1] }])(
    'rejects invalid replacement pages $pageNumbers before starting a worker',
    async ({ pageNumbers }) => {
      const caller = new ApplicationCallerLeaseRegistry().acquire({
        leaseId: 'reader',
        surface: 'electron'
      })
      const writer = new PdfTranslationWriter(() => 'not-used.mjs')
      try {
        await expect(
          writer.generate(
            {
              id: 'invalid',
              data: new Uint8Array([1]),
              pages: [{ width: 600, height: 800 }],
              units: [{ source: 'cell', translation: '细胞', fragments: [fragment(1)] }],
              incremental: { data: new Uint8Array([2]), pageNumbers }
            },
            caller.lease
          )
        ).rejects.toThrow('invalid-input')
      } finally {
        caller.release()
      }
    }
  )

  it.each(['partial', 'malformed'] as const)(
    'rejects an unsafe joined paragraph (%s)',
    async (mode) => {
      const caller = new ApplicationCallerLeaseRegistry().acquire({
        leaseId: 'reader',
        surface: 'electron'
      })
      const writer = new PdfTranslationWriter(() => 'not-used.mjs')
      try {
        await expect(
          writer.generate(
            {
              id: 'joined',
              data: new Uint8Array([1]),
              pages: Array(3).fill({ width: 600, height: 800 }),
              units: [
                {
                  source: 'joined paragraph',
                  translation: '跨页段落',
                  fragments:
                    mode === 'partial'
                      ? [fragment(1), fragment(2)]
                      : ([
                          fragment(1),
                          null
                        ] as unknown as PdfTranslationPdfRequest['units'][number]['fragments'])
                }
              ],
              incremental: { data: new Uint8Array([2]), pageNumbers: [1] }
            },
            caller.lease
          )
        ).rejects.toThrow('invalid-input')
      } finally {
        caller.release()
      }
    }
  )
})
