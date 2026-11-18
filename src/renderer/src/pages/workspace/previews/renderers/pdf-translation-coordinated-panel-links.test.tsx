// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { createPdfTranslationSource } from '@aipoch/pdf-translation/reader'
import { usePdfTranslationDocument } from './use-pdf-translation-document'
const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock('../pdfjs', () => ({ pdfjsLib: { getDocument, OPS: {} } }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})
it.each([
  'complete',
  'missing-head',
  'changed-pair',
  'extra-panel',
  'changed-native-panel',
  'detached-native-panel',
  'changed-action',
  'foreign-page-fragment'
] as const)(
  'keeps a continued panel digit within its complete coordinated reference: %s',
  async (change) => {
    const foreignPage = change === 'foreign-page-fragment',
      pageCount = foreignPage ? 2 : 1,
      sourceParts = [
        change === 'missing-head' ? 'See 4(b) and' : 'See Fig. 4(b) and',
        '5(b) for comparison.'
      ],
      sourceText = sourceParts.join(' ') + (foreignPage ? ' Continued text.' : ''),
      prefix =
        change === 'missing-head'
          ? '见4(b)和'
          : change === 'changed-pair'
            ? '见图6(b)和'
            : '见图4(b)和',
      tail = '(b)比较。' + (change === 'extra-panel' ? '另见5(b)。' : ''),
      translation = prefix + '5' + tail + (foreignPage ? '续页。' : ''),
      item = (str: string, x: number, y: number, width: number): object => ({
        str,
        transform: [10, 0, 0, 10, x, y],
        width
      }),
      page = (target: boolean, pageNumber = 1): object => ({
        getViewport: () => ({
          width: 600,
          height: 800,
          rotation: 0,
          convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
        }),
        getTextContent: async () => ({
          items:
            pageNumber === 2
              ? [item(target ? '续页。' : 'Continued text.', 60, 500, 90)]
              : target
                ? [
                    item(prefix, 60, 700, 90),
                    item('5', 160, foreignPage ? 500 : 700, 4),
                    item(
                      change === 'changed-native-panel' ? tail.replace('(b)', '(c)') : tail,
                      change === 'detached-native-panel' ? 210 : 168,
                      foreignPage ? 500.8 : 700.8,
                      90
                    )
                  ]
                : [item(sourceParts[0], 60, 700, 180), item(sourceParts[1], 60, 680, 150)]
        }),
        getAnnotations: async () =>
          pageNumber === 2
            ? []
            : [
                {
                  annotationType: 2,
                  url:
                    'https://example.org/figure/' +
                    (target && change === 'changed-action' ? 'other' : 'same'),
                  rect: target
                    ? foreignPage
                      ? [159, 498, 166, 510]
                      : [159, 698, 166, 710]
                    : [59, 678, 66, 690]
                }
              ],
        cleanup: () => {}
      }),
      original = {
        fingerprints: ['coordinated-panels'],
        numPages: pageCount,
        getPage: async (number: number) => page(false, number),
        getPageIndex: async () => 0
      } as unknown as PDFDocumentProxy,
      target = {
        numPages: pageCount,
        getPage: async (number: number) => page(true, number),
        getPageIndex: async () => 0
      },
      source = createPdfTranslationSource({
        resourceRequestKey: 'coordinated-panels',
        fingerprint: 'coordinated-panels',
        pages: Array.from({ length: pageCount }, () => ({ width: 600, height: 800 })),
        units: [
          {
            id: 'paragraph',
            source: sourceText,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
                items: sourceParts.map((text, index) => ({ index, text }))
              },
              ...(foreignPage
                ? [
                    {
                      pageNumber: 2,
                      rect: { x: 0.1, y: 0.3, width: 0.8, height: 0.15 },
                      items: [{ index: 0, text: 'Continued text.' }]
                    }
                  ]
                : [])
            ]
          }
        ]
      }),
      results = {
        source,
        units: [{ id: 'paragraph', translationSource: sourceText, translation }]
      },
      artifact = { results, data: new Uint8Array([4, 5]) }
    const rejected: unknown[] = []
    if (foreignPage)
      vi.spyOn(console, 'warn').mockImplementation((prefix, detail) => {
        if (prefix === '[pdf-translation] Candidate verification rejected') rejected.push(detail)
      })
    getDocument.mockReturnValue({ promise: Promise.resolve(target), destroy: async () => {} })
    const hook = renderHook(() =>
      usePdfTranslationDocument(original, results, artifact, 'coordinated-panels')
    )
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(change === 'complete' ? 'ready' : 'error')
    )
    if (foreignPage)
      expect(rejected).toContainEqual(
        expect.objectContaining({ reason: 'PDF link label changed', pageNumber: 1 })
      )
  }
)
