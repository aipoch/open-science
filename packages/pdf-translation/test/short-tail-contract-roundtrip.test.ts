import { expect, it, onTestFinished } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths.js'
import { TestCallerRegistry } from './support/callers.js'
import { PdfTranslationWriter } from '../src/writer.js'
import { extractPdfTranslationSource } from '../src/reader/extraction.js'
import { pdfTranslationLayoutFragments } from '../src/reader/fragments.js'
import { verifyPdfPreservation } from './support/pdf-translation-preservation.js'

it('keeps a short final row within the declared footprint or retains the complete unit', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    registry = new TestCallerRegistry(),
    caller = registry.acquire({ leaseId: 'short-tail-contract', surface: 'electron' })
  onTestFinished(() => registry.dispose())
  const prefix = 'Prior note.',
    neighbor = 'An independent paragraph remains unchanged.'
  page.drawText(prefix, { x: 40, y: 515, font, size: 10 })
  page.drawText('A caption describes', { x: 120, y: 515, font, size: 10 })
  page.drawText('The observed response provides enough context for the measured changes', {
    x: 40,
    y: 500,
    font,
    size: 10
  })
  page.drawText('over time.', { x: 40, y: 485, font, size: 10 })
  page.drawText(neighbor, { x: 40, y: 450, font, size: 10 })
  const data = new Uint8Array(await pdf.save()),
    loading = getDocument({ data: data.slice(), useSystemFonts: true })
  onTestFinished(() => loading.destroy())
  const original = await loading.promise,
    originalPage = await original.getPage(1),
    { source } = await extractPdfTranslationSource({
      document: original,
      resourceRequestKey: 'short-tail-contract',
      signal: caller.lease.signal
    }),
    native = (await originalPage.getTextContent()).items.flatMap((item, index) =>
      'str' in item && item.str.trim() && item.str !== prefix && item.str !== neighbor
        ? [{ item, index }]
        : []
    ),
    paragraph = {
      ...source.units[0],
      source: native.map(({ item }) => item.str).join(' '),
      fragments: native.map(({ item, index }) => ({
        pageNumber: 1,
        rect: {
          x: item.transform[4] / 600,
          y: (800 - item.transform[5] - 8.5) / 800,
          width: item.width / 600,
          height: 11 / 800
        },
        items: [{ index, text: item.str }]
      }))
    },
    fragments = pdfTranslationLayoutFragments(paragraph, { ...source, units: [paragraph] }),
    translation =
      '这些观测结果提供了足够的上下文以描述测量变化，并显示所有条件下的响应均保持稳定。',
    writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
  expect(fragments).toHaveLength(3)
  const input = {
      id: 'short-tail-contract',
      data,
      pages: source.pages,
      preserveUnsupported: true,
      preserveUnmatched: true,
      units: [{ ...paragraph, fragments, translation }]
    },
    output = await writer.generateDetailed(input, caller.lease)
  expect(output!.layoutFailures).toEqual([])
  const translated = getDocument({ data: output!.data.slice(), useSystemFonts: true })
  onTestFinished(() => translated.destroy())
  const target = await translated.promise,
    targetPage = await target.getPage(1),
    viewport = targetPage.getViewport({ scale: 1 }),
    items = (await targetPage.getTextContent()).items.filter(
      (item) => 'str' in item && item.str.trim()
    ),
    owned = new Set<number>(),
    reads = fragments.map(({ rect }) =>
      items
        .flatMap((item, index) => {
          if (owned.has(index)) return []
          const [a, b, , , x, y] = item.transform,
            size = Math.hypot(a, b),
            points = [
              viewport.convertToViewportPoint(x, y),
              viewport.convertToViewportPoint(
                x + (a / size) * item.width,
                y + (b / size) * item.width
              )
            ]
          if (
            !points.every(
              ([px, py]) =>
                px >= rect.x * 600 - 1 &&
                px <= (rect.x + rect.width) * 600 + 1 &&
                py >= rect.y * 800 - 1 &&
                py <= (rect.y + rect.height) * 800 + 1
            )
          )
            return []
          owned.add(index)
          return [item.str]
        })
        .join('')
    )
  expect(reads.join('').normalize('NFC').replace(/\s/gu, '')).toBe(translation.replace(/\s/gu, ''))
  const preservation = await verifyPdfPreservation(original, target, input.units, [], [1])
  expect(preservation.pages.flatMap((page) => page.failures)).toEqual([])
  const tooLong = {
      ...input,
      units: [
        {
          ...input.units[0],
          translation: translation + '我们进一步比较不同条件并考察变化是否保持一致。'
        }
      ]
    },
    retained = await writer.generateDetailed(tooLong, caller.lease)
  expect(retained!.layoutFailures).toMatchObject([
    { unitIndex: 0, code: 'overflow', phase: 'planning' }
  ])
  expect(retained!.data).toEqual(data)
})
