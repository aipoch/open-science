// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { usePdfTranslationDocument } from './use-pdf-translation-document'
import { createPdfTranslationSource } from './pdf-translation'

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock('../pdfjs', () => ({ pdfjsLib: { getDocument, OPS: {} } }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it.each([
  ['preserved-pair', true],
  ['changed-width', false],
  ['detached-mark', false],
  ['wrong-base', false],
  ['duplicate-mark', false],
  ['missing-mark', false]
] as const)(
  'verifies native narrow hat identity before accepting translated prose: %s',
  async (change, accepted) => {
    const glyph = (str: string, x: number, y: number, width: number): object => ({
        str,
        transform: [10, 0, 0, 10, x, y],
        width
      }),
      originalItems = [
        glyph('Value ', 60, 700, 30),
        glyph('ˆ', 102, 702.5, 4),
        glyph('Q', 100, 700, 8)
      ],
      targetMark = glyph('ˆ', 162, change === 'detached-mark' ? 703.5 : 702.5, 4),
      targetItems = [
        glyph('数值 ', 60, 700, 25),
        ...(change === 'missing-mark' ? [] : [targetMark]),
        ...(change === 'duplicate-mark' ? [targetMark] : []),
        glyph(change === 'wrong-base' ? 'V' : 'Q', 160, 700, change === 'changed-width' ? 9 : 8)
      ],
      page = (items: object[]): object => ({
        getViewport: () => ({
          width: 600,
          height: 800,
          rotation: 0,
          convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
        }),
        getTextContent: async () => ({ items }),
        getAnnotations: async () => [],
        cleanup: () => {}
      }),
      original = {
        fingerprints: ['hat'],
        numPages: 1,
        getPage: async () => page(originalItems),
        getPageIndex: async () => 0
      } as unknown as PDFDocumentProxy,
      target = {
        numPages: 1,
        getPage: async () => page(targetItems),
        getPageIndex: async () => 0
      },
      source = createPdfTranslationSource({
        resourceRequestKey: 'narrow-hat',
        fingerprint: 'hat',
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            id: 'hat',
            source: 'Value Qˆ',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
                items: [
                  { index: 0, text: 'Value ' },
                  { index: 1, text: 'ˆ' },
                  { index: 2, text: 'Q' }
                ]
              }
            ]
          }
        ]
      }),
      results = {
        source,
        units: [{ id: 'hat', translationSource: 'Value Qˆ', translation: '数值 Qˆ' }]
      },
      artifact = { results, data: new Uint8Array([4, 5]) }
    getDocument.mockReturnValue({ promise: Promise.resolve(target), destroy: async () => {} })
    const hook = renderHook(() =>
      usePdfTranslationDocument(original, results, artifact, 'narrow-hat')
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
  }
)
