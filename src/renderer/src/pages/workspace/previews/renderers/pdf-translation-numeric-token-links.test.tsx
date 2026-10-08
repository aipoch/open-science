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

it.each(['complete', 'missing-link', 'changed-action', 'missing-close'] as const)(
  'verifies separate citations that share only a native delimiter run: %s',
  async (change) => {
    const originalParts = ['Methods [', '52', ',', '48', '] with normalization [', '66', '].'],
      translatedParts = [
        '方法[',
        '52',
        ',',
        '48',
        ']，归一化[',
        '66',
        change === 'missing-close' ? '。' : ']。'
      ],
      originalPositions = [60, 122, 134, 139, 151, 273, 285],
      targetPositions = [60, 112, 124, 129, 141, 223, 235],
      widths = [60, 10, 3, 10, 120, 10, 12],
      sourceText = originalParts.join(''),
      translation = translatedParts.join(''),
      page = (target: boolean): object => {
        const positions = target ? targetPositions : originalPositions
        return {
          getViewport: () => ({
            width: 600,
            height: 800,
            rotation: 0,
            convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
          }),
          getTextContent: async () => ({
            items: (target ? translatedParts : originalParts).map((str, index) => ({
              str,
              transform: [10, 0, 0, 10, positions[index], target ? 708 : 700],
              width: target && index === 0 ? 50 : target && index === 4 ? 80 : widths[index]
            }))
          }),
          getAnnotations: async () =>
            [1, 3, 5].flatMap((index) =>
              target && change === 'missing-link' && index === 1
                ? []
                : [
                    {
                      annotationType: 2,
                      url:
                        'https://example.org/' +
                        (target && change === 'changed-action' && index === 5
                          ? '67'
                          : originalParts[index]),
                      rect: [
                        positions[index],
                        target ? 706 : 698,
                        positions[index] + 10,
                        target ? 718 : 710
                      ]
                    }
                  ]
            ),
          cleanup: () => {}
        }
      },
      original = {
        fingerprints: ['shared-delimiters'],
        numPages: 1,
        getPage: async () => page(false),
        getPageIndex: async () => 0
      } as unknown as PDFDocumentProxy,
      target = { numPages: 1, getPage: async () => page(true), getPageIndex: async () => 0 },
      source = createPdfTranslationSource({
        resourceRequestKey: 'shared-delimiters',
        fingerprint: 'shared-delimiters',
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            id: 'one',
            source: sourceText,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
                items: originalParts.map((text, index) => ({ index, text }))
              }
            ]
          }
        ]
      }),
      results = { source, units: [{ id: 'one', translationSource: sourceText, translation }] },
      artifact = { results, data: new Uint8Array([4, 5]) }
    getDocument.mockReturnValue({ promise: Promise.resolve(target), destroy: async () => {} })
    const hook = renderHook(() =>
      usePdfTranslationDocument(original, results, artifact, 'shared-delimiters')
    )
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(change === 'complete' ? 'ready' : 'error')
    )
  }
)

it.each([
  ['quantity', true],
  ['reverse', true],
  ['decimal', true],
  ['identifier', true],
  ['missing-source-reference', false],
  ['repeated-reference-missing-link', false],
  ['changed-reference', false],
  ['changed-action', false],
  ['changed-width', false]
] as const)('verifies complete numeric link tokens: %s', async (change, accepted) => {
  const sourceText =
      change === 'reverse'
        ? '80%的病例[8]。'
        : change === 'decimal'
          ? '8.5% of cases [8].'
          : change === 'identifier'
            ? 'B80 cases [8].'
            : change === 'missing-source-reference'
              ? '80% of cases.'
              : change === 'repeated-reference-missing-link'
                ? '80% of cases [8] then [8].'
                : '80% of cases [8].',
    label = change === 'changed-reference' ? '7' : '8',
    prefix =
      change === 'reverse'
        ? '80% of cases ['
        : change === 'decimal'
          ? '8.5%的病例['
          : change === 'identifier'
            ? 'B80病例['
            : '80%的病例[',
    suffix = '].',
    translation = prefix + label + suffix,
    glyph = (str: string, x: number, width: number): object => ({
      str,
      transform: [10, 0, 0, 10, x, 700],
      width
    }),
    link = (target: boolean): object => ({
      annotationType: 2,
      url:
        target && change === 'changed-action' ? 'https://example.org/7' : 'https://example.org/8',
      rect: target ? [200, 698, change === 'changed-width' ? 207 : 206, 710] : [200, 690, 206, 702]
    }),
    page = (target: boolean): object => ({
      getViewport: () => ({
        width: 600,
        height: 800,
        rotation: 0,
        convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
      }),
      getTextContent: async () => ({
        items: target
          ? [glyph(prefix, 60, 138), glyph(label, 201, 4), glyph(suffix, 208, 8)]
          : [glyph(sourceText, 60, 180)]
      }),
      getAnnotations: async () => [link(target)],
      cleanup: () => {}
    }),
    original = {
      fingerprints: ['numeric-tokens'],
      numPages: 1,
      getPage: async () => page(false),
      getPageIndex: async () => 0
    } as unknown as PDFDocumentProxy,
    target = { numPages: 1, getPage: async () => page(true), getPageIndex: async () => 0 },
    source = createPdfTranslationSource({
      resourceRequestKey: 'numeric-tokens',
      fingerprint: 'numeric-tokens',
      pages: [{ width: 600, height: 800 }],
      units: [
        {
          id: 'one',
          source: sourceText,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.12 },
              items: [{ index: 0, text: sourceText }]
            }
          ]
        }
      ]
    }),
    results = { source, units: [{ id: 'one', translationSource: sourceText, translation }] },
    artifact = { results, data: new Uint8Array([4, 5]) }
  getDocument.mockReturnValue({ promise: Promise.resolve(target), destroy: async () => {} })
  const hook = renderHook(() =>
    usePdfTranslationDocument(original, results, artifact, 'numeric-tokens')
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each([
  ['preserved-range', true],
  ['reverse-range', true],
  ['preserved-list', true],
  ['changed-endpoint', false],
  ['extra-range', false],
  ['detached-contained-glyph', false],
  ['repeated-source-range', false],
  ['changed-range-action', false]
] as const)(
  'verifies a complete range around a contained native dash: %s',
  async (change, accepted) => {
    const range = change === 'preserved-list' ? '9,12' : '9–12',
      sourceParts =
        change === 'detached-contained-glyph'
          ? ['Other ', '–', ' [5,7,9–12].']
          : [
              change === 'reverse-range' ? '结局[5,7,9' : 'Outcome [5,7,9',
              change === 'preserved-list' ? ',' : '–',
              change === 'repeated-source-range' ? '12] then [9–12].' : '12].'
            ],
      sourceText = sourceParts.join(''),
      label = change === 'changed-endpoint' ? '9–13' : range,
      prefix =
        change === 'reverse-range'
          ? 'Outcome [5,7,'
          : change === 'detached-contained-glyph'
            ? '其他–[5,7,'
            : '结局[5,7,',
      suffix = change === 'extra-range' ? '] then [9–12].' : '].',
      translation = prefix + label + suffix,
      glyph = (str: string, x: number, width: number): object => ({
        str,
        transform: [10, 0, 0, 10, x, 700],
        width
      }),
      link = (target: boolean): object => ({
        annotationType: 2,
        url:
          target && change === 'changed-range-action'
            ? 'https://example.org/13'
            : 'https://example.org/12',
        rect: target ? [198, 698, 224, 710] : [198, 690, 224, 702]
      }),
      page = (target: boolean): object => ({
        getViewport: () => ({
          width: 600,
          height: 800,
          rotation: 0,
          convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
        }),
        getTextContent: async () => ({
          items: target
            ? [glyph(prefix, 60, 135), glyph(label, 200, 22), glyph(suffix, 226, 60)]
            : [
                glyph(sourceParts[0], 60, 145),
                glyph(sourceParts[1], 207, 3),
                glyph(sourceParts[2], 212, 75)
              ]
        }),
        getAnnotations: async () => [link(target)],
        cleanup: () => {}
      }),
      original = {
        fingerprints: ['ranges'],
        numPages: 1,
        getPage: async () => page(false),
        getPageIndex: async () => 0
      } as unknown as PDFDocumentProxy,
      target = { numPages: 1, getPage: async () => page(true), getPageIndex: async () => 0 },
      source = createPdfTranslationSource({
        resourceRequestKey: 'ranges',
        fingerprint: 'ranges',
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            id: 'one',
            source: sourceText,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.12 },
                items: sourceParts.map((text, index) => ({ text, index }))
              }
            ]
          }
        ]
      }),
      results = { source, units: [{ id: 'one', translationSource: sourceText, translation }] },
      artifact = { results, data: new Uint8Array([4, 5]) }
    getDocument.mockReturnValue({ promise: Promise.resolve(target), destroy: async () => {} })
    const hook = renderHook(() => usePdfTranslationDocument(original, results, artifact, 'ranges'))
    await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
  }
)
