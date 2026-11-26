import { expect, it } from 'vitest'
import {
  PDFDocument,
  StandardFonts,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
  rgb
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from '../src/writer.js'
import { resolve } from './paths.js'
import { TestCallerRegistry } from './support/callers.js'
it.each([
  'crossing',
  'left',
  'ink-intersection',
  'contained',
  'none',
  'nonaxis',
  'dashed',
  'transparent',
  'clipped',
  'short',
  'thick',
  'fill'
] as const)(
  'native separator edge: %s',
  async (kind) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([300, 200])
    page.drawText('Metric', { font, size: 8, x: kind === 'ink-intersection' ? 49 : 50, y: 140 })
    page.drawText('Neighbor 17', { font, size: 10, x: 150, y: 90 })
    if (kind === 'clipped')
      page.pushOperators(pushGraphicsState(), rectangle(93, 130, 8, 25), clip(), endPath())
    if (kind === 'fill')
      page.drawRectangle({ x: 92.6, y: 136, width: 0.8, height: 14, color: rgb(0, 0, 0) })
    else if (kind !== 'none')
      page.drawLine({
        start: {
          x:
            kind === 'ink-intersection'
              ? 49.3
              : kind === 'left'
                ? 49
                : kind === 'contained'
                  ? 92
                  : 93,
          y: kind === 'short' ? 142 : 136
        },
        end: {
          x:
            kind === 'nonaxis'
              ? 93.5
              : kind === 'ink-intersection'
                ? 49.3
                : kind === 'left'
                  ? 49
                  : kind === 'contained'
                    ? 92
                    : 93,
          y: 150
        },
        thickness: kind === 'thick' ? 2 : 0.4,
        opacity: kind === 'transparent' ? 0 : 1,
        ...(kind === 'dashed' ? { dashArray: [2, 2] } : {})
      })
    if (kind === 'clipped') page.pushOperators(popGraphicsState())
    const registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'native-separator' })
    try {
      const out = await new PdfTranslationWriter(() =>
        resolve('resources/worker.mjs')
      ).generateDetailed(
        {
          id: 'native-separator',
          data: await pdf.save(),
          pages: [{ width: 300, height: 200 }],
          preserveUnsupported: true,
          units: [
            {
              source: 'Metric',
              translation: 'top-1 错误率',
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 49 / 300, y: 50 / 200, width: 44 / 300, height: 13 / 200 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      if (kind === 'ink-intersection') {
        expect(out?.layoutFailures).toMatchObject([
          { unitIndex: 0, pageNumbers: [1], code: 'unsupported-layout' }
        ])
      } else expect(out?.layoutFailures).toEqual([])
      const task = getDocument({
        data: out!.data.slice(),
        fontExtraProperties: true,
        disableFontFace: true,
        isEvalSupported: false
      })
      try {
        const d = await task.promise,
          a = (await (await d.getPage(1)).getTextContent()).items.flatMap((item) =>
            'str' in item && item.str.trim() ? [item] : []
          )
        if (kind === 'ink-intersection') {
          expect(a.map((x) => x.str).join('')).toContain('Metric')
          expect(a.map((x) => x.str).join('')).not.toContain('错误率')
          return
        }
        expect(a.map((x) => x.str).join('')).toContain('top-1 错误率')
        const neighbor = a.find((x) => x.str === 'Neighbor 17')
        expect(neighbor?.transform).toEqual([10, 0, 0, 10, 150, 90])
        const changed = a.filter((x) => x !== neighbor),
          right = Math.max(...changed.map((x) => x.transform[4] + x.width))
        if (kind === 'left') {
          expect(Math.min(...changed.map((x) => x.transform[4]))).toBeGreaterThanOrEqual(49.89)
        } else if (kind === 'crossing') expect(right).toBeLessThanOrEqual(92.11)
        else if (kind === 'contained') expect(right).toBeLessThanOrEqual(91.11)
        else expect(right).toBeGreaterThan(92.7)
      } finally {
        await task.destroy()
      }
    } finally {
      caller.release()
    }
  },
  30000
)
