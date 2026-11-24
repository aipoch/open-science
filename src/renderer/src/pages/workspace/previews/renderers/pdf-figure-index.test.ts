import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { buildPdfFigureIndex, pdfReferenceKey } from './pdf-figure-index'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

const run = (str: string, x = 40, y = 600, width = str.length * 5): object => ({
  str,
  dir: 'ltr',
  transform: [10, 0, 0, 10, x, y],
  width,
  height: 10,
  fontName: 'fixture',
  hasEOL: false
})

function documentWithPages(pages: object[][]): PDFDocumentProxy {
  return {
    numPages: pages.length,
    getPage: vi.fn(async (number: number) => ({
      getTextContent: vi.fn(async () => ({ items: pages[number - 1], styles: {} })),
      getViewport: () => ({
        width: 600,
        height: 800,
        convertToViewportRectangle: ([x1, y1, x2, y2]: number[]) => [x1, 800 - y1, x2, 800 - y2]
      })
    }))
  } as unknown as PDFDocumentProxy
}

describe('figure reference identity', () => {
  it.each(['Figure 3', 'Fig. 3b', 'Figure 3(b)', '图 3', '圖3'])('%s names figure 3', (label) => {
    expect(pdfReferenceKey(label)).toBe('figure:3')
  })

  it.each([
    ['Table 5', 'table:5'],
    ['Tab. V', 'table:5'],
    ['表五', 'table:5'],
    ['表二十一', 'table:21'],
    ['Table IV', 'table:4'],
    ['表 2-1', 'table:2-1'],
    ['Supplementary Table 5', 'table:supplement:5'],
    ['Table S5', 'table:s5'],
    ['Table IIII', undefined],
    ['Tables 2–4', undefined]
  ])('normalizes the table identifier %s', (label, expected) =>
    expect(pdfReferenceKey(label!)).toBe(expected)
  )

  it('requires caption evidence and keeps duplicates, continuations and prose out of the index', async () => {
    const doc = documentWithPages([
      [
        run('Table 2', 40, 710, 35),
        { ...run(' Baseline characteristics', 75, 710), fontName: 'body' },
        run('Table V. Outcomes', 40, 550),
        run('Table 3 shows the changes', 40, 450)
      ],
      [run('Tab. 5: Other outcomes', 40, 600), run('Table 6. Continued', 40, 500)]
    ])
    expect([...(await buildPdfFigureIndex(doc, new AbortController().signal)).keys()]).toEqual([
      'table:2'
    ])
  })
  it('keeps numbered supplementary figures separate', () => {
    expect(pdfReferenceKey('Fig. S3b')).toBe('figure:s3')
    expect(pdfReferenceKey('Figure s3 (b)')).toBe('figure:s3')
  })

  it.each([
    'Figures 1 and 2',
    'Fig. 1, 2',
    'Fig. 1a–c',
    'Figure 1(a,b)',
    'Figure 1.2',
    'Supplementary Figure 1',
    'Extended Data Figure 1',
    'Figure 3 shows the results'
  ])('rejects ambiguous or separately named reference %s', (label) => {
    expect(pdfReferenceKey(label)).toBeUndefined()
  })
})

describe('PDF figure text index', () => {
  it('finds captions across pages, joining split labels without rendering', async () => {
    const document = documentWithPages([
      [run('Figure', 40, 600, 30), run(' 1', 70, 600, 10), run('. Main result', 80)],
      [run('Fig. S1 | Supplementary result', 40, 500)]
    ])
    const index = await buildPdfFigureIndex(document, new AbortController().signal)
    expect(index.get('figure:1')).toEqual({ pageNumber: 1, x: 40 / 600, y: 190 / 800 })
    expect(index.get('figure:s1')).toEqual({ pageNumber: 2, x: 40 / 600, y: 290 / 800 })
    expect(index.size).toBe(2)
  })

  it('does not treat prose mentions, compounds, panel captions or other figure series as captions', async () => {
    const labels = [
      'As shown in Figure 1. Results follow.',
      'Figure 2 shows the results.',
      'Figure 3',
      'Figures 4 and 5. Results.',
      'Figure 6, 7. Results.',
      'Figure 8a. Panel results.',
      'Figure 9(b). Panel results.',
      'Figure 10.2. Results.',
      'Supplementary Figure 11. Additional results.',
      'Extended Data Figure 12. Additional results.'
    ]
    const document = documentWithPages([labels.map((label, i) => run(label, 40, 700 - i * 30))])
    expect((await buildPdfFigureIndex(document, new AbortController().signal)).size).toBe(0)
  })

  it('keeps a wrapped supplementary caption out of the main series without borrowing another column', async () => {
    const document = documentWithPages([
      [
        run('Supplementary', 40, 714),
        run('Other column', 330, 714),
        run('Figure 3. Additional result', 40, 700)
      ],
      [run('Figure 3. Main result', 40, 700), run('Supplementary', 330, 714)]
    ])
    const index = await buildPdfFigureIndex(document, new AbortController().signal)
    expect(index.get('figure:3')?.pageNumber).toBe(2)
  })

  it('removes all destinations for duplicate caption identities', async () => {
    const document = documentWithPages([
      [run('Figure 1. First caption'), run('Figure 2. Unique caption', 40, 500)],
      [run('Fig. 1. Different caption')],
      [run('Figure 1. Third caption')]
    ])
    const index = await buildPdfFigureIndex(document, new AbortController().signal)
    expect([...index.keys()]).toEqual(['figure:2'])
  })

  it('keeps columns separate and rejects invalid or rotated text runs', async () => {
    const document = documentWithPages([
      [
        run('Fig.', 40, 700, 20),
        run('1. Other column text', 300, 700),
        { ...run('Figure 2. Rotated'), transform: [0, 10, -10, 0, 40, 600] },
        { ...run('Figure 3. Invalid'), width: Number.NaN },
        run('Section 4. Results', 40, 500)
      ]
    ])
    expect((await buildPdfFigureIndex(document, new AbortController().signal)).size).toBe(0)
  })

  it.each([0, 90, 180, 270])(
    'uses cropped, rotated viewport coordinates at %s degrees',
    async (rotation) => {
      const pdf = await PDFDocument.create()
      const page = pdf.addPage([600, 800])
      page.setCropBox(20, 30, 560, 740)
      page.setRotation(degrees(rotation))
      const font = await pdf.embedFont(StandardFonts.Helvetica)
      page.drawText('Figure 4. Caption text', { x: 60, y: 500, size: 10, font })
      const task = pdfjs.getDocument({ data: new Uint8Array(await pdf.save()) })
      cleanups.push(() => task.destroy())
      const document = await task.promise
      const loaded = await document.getPage(1)
      const render = vi.spyOn(loaded, 'render')
      const viewport = loaded.getViewport({ scale: 1 })
      const item = (await loaded.getTextContent()).items.find((item) => 'str' in item && item.str)!
      if (!('str' in item)) throw new Error('Expected fixture caption')
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
        item.transform[4],
        item.transform[5],
        item.transform[4] + item.width,
        item.transform[5] + item.height
      ])
      const index = await buildPdfFigureIndex(document, new AbortController().signal)
      expect(index.get('figure:4')).toEqual({
        pageNumber: 1,
        x: Math.min(x1, x2) / viewport.width,
        y: Math.min(y1, y2) / viewport.height
      })
      expect(render).not.toHaveBeenCalled()
    }
  )

  it('yields before page reads and stops before scheduling another page after cancellation', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const document = documentWithPages([[run('Figure 1. Caption')], [run('Figure 2. Caption')]])
    const firstPage = await document.getPage(1)
    vi.mocked(document.getPage).mockClear()
    vi.mocked(document.getPage).mockImplementation(async () => {
      controller.abort()
      return firstPage
    })
    const pending = buildPdfFigureIndex(document, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(document.getPage).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    await rejected
    expect(document.getPage).toHaveBeenCalledTimes(1)
    expect(firstPage.getTextContent).not.toHaveBeenCalled()
  })

  it('discards a pending text read after cancellation', async () => {
    const controller = new AbortController()
    const page = {
      getTextContent: vi.fn(async () => {
        controller.abort()
        return { items: [run('Figure 1. Caption')], styles: {} }
      }),
      getViewport: vi.fn()
    } as unknown as PDFPageProxy
    const document = {
      numPages: 2,
      getPage: vi.fn(async () => page)
    } as unknown as PDFDocumentProxy
    await expect(buildPdfFigureIndex(document, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(document.getPage).toHaveBeenCalledTimes(1)
    expect(page.getViewport).not.toHaveBeenCalled()
  })

  it('yields between completed pages and can cancel before reading the next', async () => {
    const controller = new AbortController()
    const document = documentWithPages([[run('Figure 1. Caption')], [run('Figure 2. Caption')]])
    const firstPage = await document.getPage(1)
    vi.mocked(document.getPage).mockClear()
    vi.mocked(document.getPage).mockImplementation(async () => {
      setTimeout(() => controller.abort(), 0)
      return firstPage
    })
    await expect(buildPdfFigureIndex(document, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(document.getPage).toHaveBeenCalledTimes(1)
    expect(firstPage.getTextContent).toHaveBeenCalledTimes(1)
  })
})
