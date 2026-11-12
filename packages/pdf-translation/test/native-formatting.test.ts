import { expect, it } from 'vitest'
import { resolve } from './paths.js'
import {
  PDFDict,
  PDFDocument,
  PDFName,
  StandardFonts,
  clip,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfTranslationWriter } from '../src/writer.js'
import { TestCallerRegistry } from './support/callers.js'
import { verifyPdfUnits } from './support/pdf-translation-native-verification.js'
import { verifyPdfPreservation } from './support/pdf-translation-preservation.js'
import { createPdfTranslationSource } from '../src/reader/source.js'
import { pdfTranslationLayoutFragments } from '../src/reader/fragments.js'
import { pathToFileURL } from 'node:url'

it.each([
  'no-marker',
  'painted',
  'nonzero-character-box',
  'merged-letter',
  'unknown-control',
  'too-many'
])('requires complete native nonpainting proof for formatting objects: %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    marker = await pdf.embedFont(StandardFonts.TimesRoman),
    page = pdf.addPage([600, 800]),
    registry = new TestCallerRegistry(),
    caller = registry.acquire({ leaseId: 'native-formatting', surface: 'electron' })
  page.drawText('Measured value is available.', { font, size: 12, x: 40, y: 700 })
  page.drawText('Neighbor 17', { font, size: 12, x: 40, y: 650 })
  if (kind !== 'no-marker') {
    const text = kind === 'nonzero-character-box' ? '  ' : kind === 'too-many' ? 'AAAAAAAAA' : 'AA'
    page.drawText(text, { font: marker, size: 12, x: 220, y: 700 })
    await pdf.flush()
    const dict = pdf.context.lookup(marker.ref, PDFDict)
    dict.set(
      PDFName.of('ToUnicode'),
      pdf.context.register(
        pdf.context.stream(
          '/CIDInit /ProcSet findresource begin 12 dict begin begincmap ' +
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def ' +
            '/CMapName /FormattingMap def /CMapType 2 def ' +
            '1 begincodespacerange <00> <FF> endcodespacerange ' +
            '1 beginbfchar <' +
            (kind === 'nonzero-character-box' ? '20' : '41') +
            '> <' +
            (kind === 'unknown-control' ? '200D' : '200C') +
            '> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'
        )
      )
    )
    if (kind === 'merged-letter') page.drawText('B', { font: marker, size: 12, x: 235, y: 700 })
  }
  try {
    const request = new PdfTranslationWriter(() => resolve('resources/worker.mjs')).generate(
      {
        id: 'formatting-control',
        data: await pdf.save(),
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            source: 'Measured value is available.',
            translation: '测量值已提供。',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 38 / 600, y: 84 / 800, width: 320 / 600, height: 24 / 800 }
              }
            ]
          }
        ]
      },
      caller.lease
    )
    if (kind !== 'no-marker') {
      await expect(request).rejects.toMatchObject({ failure: { code: 'source-mismatch' } })
      return
    }
    const output = await request,
      task = getDocument({ data: output!.slice() })
    try {
      const document = await task.promise,
        items = (await (await document.getPage(1)).getTextContent()).items,
        text = items.flatMap((item) => ('str' in item ? [item.str] : [])).join('')
      expect(text).toContain('测量值已提供。')
      expect(text).toContain('Neighbor 17')
    } finally {
      await task.destroy()
    }
  } finally {
    caller.release()
  }
})

it.each([
  'paired',
  'one-rail',
  'different-endpoints',
  'not-enclosing',
  'nonaxis',
  'source-overhang',
  'dashed',
  'transparent',
  'clipped'
] as const)('bounds borrowed label space only by complete native row rails: %s', async (kind) => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([300, 200]),
    registry = new TestCallerRegistry(),
    caller = registry.acquire({ leaseId: 'native-row-rails' }),
    label = 'Classifier',
    translation = 'classifier攻击',
    right = kind === 'source-overhang' ? 90 : 104
  page.drawText(label, { font, size: 10, x: 50, y: 140 })
  page.drawText('Other label', { font, size: 10, x: 40, y: 90 })
  page.drawText('Neighbor 17', { font, size: 10, x: 40, y: 50 })
  if (kind === 'clipped')
    page.pushOperators(pushGraphicsState(), rectangle(45, 130, 57, 30), clip(), endPath())
  for (const y of kind === 'one-rail' ? [137] : [kind === 'not-enclosing' ? 138 : 150, 137])
    page.drawLine({
      start: { x: 40, y },
      end: {
        x: right + (kind === 'different-endpoints' && y === 150 ? 3 : 0),
        y: y + (kind === 'nonaxis' && y === 150 ? 0.5 : 0)
      },
      thickness: 0.5,
      ...(kind === 'dashed' ? { dashArray: [2, 2] } : {}),
      opacity: kind === 'transparent' ? 0 : 1
    })
  if (kind === 'clipped') page.pushOperators(popGraphicsState())
  const source = createPdfTranslationSource({
      resourceRequestKey: 'row-rails',
      fingerprint: 'row-rails',
      pages: [{ width: 300, height: 200 }],
      units: [
        {
          id: 'label',
          source: label,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 49 / 300, y: 49 / 200, width: 48 / 300, height: 13 / 200 },
              items: [{ index: 0, text: label }]
            }
          ]
        },
        {
          id: 'healthy',
          source: 'Other label',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 39 / 300, y: 99 / 200, width: 100 / 300, height: 14 / 200 },
              items: [{ index: 1, text: 'Other label' }]
            }
          ]
        }
      ]
    }),
    fragments = pdfTranslationLayoutFragments(source.units[0], source),
    data = await pdf.save()
  expect((fragments[0].rect.x + fragments[0].rect.width) * 300).toBeGreaterThan(right + 10)
  try {
    const result = await new PdfTranslationWriter(() =>
      resolve('resources/worker.mjs')
    ).generateDetailed(
      {
        id: 'native-row-rails',
        data,
        pages: source.pages,
        preserveUnsupported: true,
        units: [
          { ...source.units[0], translation, fragments },
          {
            ...source.units[1],
            translation: '其他标签',
            fragments: pdfTranslationLayoutFragments(source.units[1], source)
          }
        ]
      },
      caller.lease
    )
    expect(result!.layoutFailures).toEqual([])
    const { engine } = await import(
        /* @vite-ignore */ pathToFileURL(resolve('resources/pdfium.mjs')).href
      ),
      native = await engine(),
      at = native.alloc(4),
      snapshots = []
    try {
      for (const bytes of [data, result!.data]) {
        const document = native.open(bytes),
          nativePage = native.p.FPDF_LoadPage(document.doc, 0)
        try {
          snapshots.push(
            native
              .objects(nativePage)
              .map((object: { obj: number; type: number; text: string; bounds: number[] }) => {
                if (object.type === 1) native.p.FPDFTextObj_GetFontSize(object.obj, at)
                return {
                  type: object.type,
                  text: object.text,
                  bounds: object.bounds,
                  point: object.type === 1 ? native.m.HEAPF32[at / 4] : undefined
                }
              })
          )
        } finally {
          native.p.FPDF_ClosePage(nativePage)
          document.close()
        }
      }
    } finally {
      native.free(at)
    }
    const compact = (s: string): string => s.replace(/\s/gu, ''),
      target = snapshots[1].filter(
        (o: { text?: string }) => o.text && compact(o.text) === translation
      )
    expect(target).toHaveLength(1)
    expect(target[0].point).toBeGreaterThanOrEqual(8)
    if (kind === 'paired') expect(target[0].bounds[2]).toBeLessThanOrEqual(right + 0.001)
    else expect(target[0].bounds[2]).toBeGreaterThan(right + 0.1)
    expect(
      snapshots[1].filter((o: { text?: string }) => o.text && compact(o.text) === '其他标签')
    ).toHaveLength(1)
    expect(snapshots[1].find((o: { text?: string }) => o.text?.trim() === 'Neighbor 17')).toEqual(
      snapshots[0].find((o: { text?: string }) => o.text?.trim() === 'Neighbor 17')
    )
    expect(snapshots[1].filter((o: { type: number }) => o.type === 2)).toEqual(
      snapshots[0].filter((o: { type: number }) => o.type === 2)
    )
  } finally {
    caller.release()
  }
})

it.each([false, true])(
  'preserves only source-matching native mathematical angle delimiters: %s',
  async (changed) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      symbols = await pdf.embedFont(StandardFonts.Symbol),
      page = pdf.addPage([600, 800]),
      registry = new TestCallerRegistry(),
      caller = registry.acquire({ leaseId: 'native-delimiters' })
    page.drawText('Measured ', { font, size: 12, x: 40, y: 700 })
    page.drawText('〈', { font: symbols, size: 12, x: 100, y: 700 })
    page.drawText('R', { font, size: 12, x: 106, y: 700 })
    page.drawText('〉', { font: symbols, size: 12, x: 116, y: 700 })
    page.drawText(' is stable.', { font, size: 12, x: 123, y: 700 })
    page.drawText('Independent neighbor.', { font, size: 12, x: 40, y: 650 })
    await pdf.flush()
    // The native symbol font owns the outlines; its Unicode map supplies their
    // mathematical spelling without relying on the translated prose font.
    pdf.context
      .lookup(symbols.ref, PDFDict)
      .set(
        PDFName.of('ToUnicode'),
        pdf.context.register(
          pdf.context.stream(
            '/CIDInit /ProcSet findresource begin 12 dict begin begincmap ' +
              '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def ' +
              '/CMapName /DelimiterMap def /CMapType 2 def ' +
              '1 begincodespacerange <00> <FF> endcodespacerange ' +
              '2 beginbfchar <E1> <27E8> <F1> <27E9> endbfchar ' +
              'endcmap CMapName currentdict /CMap defineresource pop end end'
          )
        )
      )
    const data = await pdf.save(),
      translation = changed ? '测量值 ⟨R⟨ 保持稳定。' : '测量值 ⟨R⟩ 保持稳定。'
    try {
      const result = await new PdfTranslationWriter(() =>
        resolve('resources/worker.mjs')
      ).generateDetailed(
        {
          id: 'native-delimiters',
          data,
          pages: [{ width: 600, height: 800 }],
          preserveUnsupported: true,
          units: [
            {
              source: 'Measured ⟨R⟩ is stable.',
              translation,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { x: 38 / 600, y: 84 / 800, width: 260 / 600, height: 24 / 800 }
                }
              ]
            }
          ]
        },
        caller.lease
      )
      expect(result).toBeTruthy()
      expect(result!.layoutFailures).toHaveLength(changed ? 1 : 0)
      const task = getDocument({ data: result!.data.slice() })
      const original = getDocument({ data: data.slice() })
      try {
        const document = await task.promise,
          text = (await (await document.getPage(1)).getTextContent()).items
            .map((item) => ('str' in item ? item.str : ''))
            .join('')
            .replace(/\s/gu, '')
        expect(text).toContain('Independentneighbor.')
        if (changed) {
          expect(text).toContain('Measured⟨R⟩isstable.')
          expect(text).not.toContain('测量值')
        } else expect(text).toContain(translation.replace(/\s/gu, ''))
        const entries = [
          {
            sourceIndex: 0,
            source: 'Measured ⟨R⟩ is stable.',
            translation,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 38 / 600, y: 84 / 800, width: 260 / 600, height: 24 / 800 }
              }
            ]
          }
        ]
        expect(
          await verifyPdfUnits(document, entries, result!.layoutFailures, await original.promise)
        ).toEqual([
          { sourceIndex: 0, pageNumbers: [1], retained: changed, translationFound: !changed }
        ])
        const preservation = await verifyPdfPreservation(
          await original.promise,
          document,
          entries,
          result!.layoutFailures,
          [1]
        )
        expect(preservation.pages[0].failures).toEqual([])
        expect(preservation.pages[0].pixels?.changedPixels).toBe(0)
      } finally {
        await task.destroy()
        await original.destroy()
      }
    } finally {
      caller.release()
    }
  }
)
