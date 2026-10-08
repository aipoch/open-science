// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { usePdfTranslationDocument } from './use-pdf-translation-document'
import { createPdfTranslationSource } from './pdf-translation'
import { translatedPdfLinkFragment } from '../../../../../../../resources/pdf-translation/link-labels.mjs'

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock('../pdfjs', () => ({ pdfjsLib: { getDocument, OPS: {} } }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it.each([
  ['preserved', true],
  ['changed-number', false],
  ['changed-action', false],
  ['changed-width', false],
  ['missing-label', false]
] as const)(
  'verifies a localized supporting file link and its unchanged native action: %s',
  async (change, accepted) => {
    const sourceText = 'S1 File. Checklist.',
      translation = 'S1 文件。清单。',
      glyph = (str: string, x: number, width: number): object => ({
        str,
        transform: [10, 0, 0, 10, x, 700],
        width
      }),
      link = (rect: number[], target = false): object => ({
        annotationType: 2,
        url:
          target && change === 'changed-action'
            ? 'https://example.org/s2'
            : 'https://example.org/s1',
        rect
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
            ? [
                glyph(
                  change === 'missing-label'
                    ? 'S1'
                    : change === 'changed-number'
                      ? 'S2 文件'
                      : 'S1 文件',
                  100,
                  28
                ),
                glyph('。清单。', 135, 40)
              ]
            : [glyph(sourceText, 60, 130)]
        }),
        getAnnotations: async () => [
          link(
            target ? [100, 698, change === 'changed-width' ? 132 : 130, 710] : [60, 698, 90, 710],
            target
          )
        ],
        cleanup: () => {}
      }),
      original = {
        fingerprints: ['supporting'],
        numPages: 1,
        getPage: async () => page(false),
        getPageIndex: async () => 0
      } as unknown as PDFDocumentProxy,
      target = { numPages: 1, getPage: async () => page(true), getPageIndex: async () => 0 },
      source = createPdfTranslationSource({
        resourceRequestKey: 'supporting',
        fingerprint: 'supporting',
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            id: 'file',
            source: sourceText,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
                items: [{ index: 0, text: sourceText }]
              }
            ]
          }
        ]
      }),
      results = { source, units: [{ id: 'file', translationSource: sourceText, translation }] },
      artifact = { results, data: new Uint8Array([4, 5]) }
    getDocument.mockReturnValue({ promise: Promise.resolve(target), destroy: async () => {} })
    const hook = renderHook(() =>
      usePdfTranslationDocument(original, results, artifact, 'supporting')
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
  }
)

it.each([
  ['preserved-year-list', true],
  ['changed-other-year', false],
  ['changed-author', false],
  ['changed-suffix', false],
  ['changed-year-action', false]
] as const)(
  'verifies every repeated suffix year against its full citation: %s',
  async (change, accepted) => {
    const first = 'See (Quinn et al., 2029, 2031a).',
      second = 'See (Quinn et al., 2031a).',
      author = change === 'changed-author' ? 'Baker' : 'Quinn',
      year = change === 'changed-other-year' ? '2028' : '2029',
      suffix = change === 'changed-suffix' ? '2031b' : '2031a',
      translation = `见（${author}等人，${year}，${suffix}）。见（Quinn等人，2031a）。`,
      glyph = (str: string, x: number, y: number, width: number): object => ({
        str,
        transform: [10, 0, 0, 10, x, y],
        width
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
            ? [
                glyph(`见（${author}等人，${year}，`, 60, 700, 120),
                glyph(suffix, 200, 700, 28),
                glyph('）。', 235, 700, 20),
                glyph('见（Quinn等人，', 60, 680, 120),
                glyph('2031a', 200, 680, 28),
                glyph('）。', 235, 680, 20)
              ]
            : [glyph(first, 60, 700, 210), glyph(second, 60, 680, 210)]
        }),
        getAnnotations: async () =>
          [700, 680].map((y, index) => ({
            annotationType: 2,
            url:
              target && change === 'changed-year-action' && !index
                ? 'https://example.org/wrong'
                : `https://example.org/ref${index}`,
            rect: target ? [200, y - 2, 230, y + 10] : [150, y - 2, 180, y + 10]
          })),
        cleanup: () => {}
      }),
      sourceText = first + ' ' + second,
      original = {
        fingerprints: ['years'],
        numPages: 1,
        getPage: async () => page(false),
        getPageIndex: async () => 0
      } as unknown as PDFDocumentProxy,
      target = { numPages: 1, getPage: async () => page(true), getPageIndex: async () => 0 },
      source = createPdfTranslationSource({
        resourceRequestKey: 'years',
        fingerprint: 'years',
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            id: 'years',
            source: sourceText,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.12 },
                items: [
                  { index: 0, text: first },
                  { index: 1, text: second }
                ]
              }
            ]
          }
        ]
      }),
      results = { source, units: [{ id: 'years', translationSource: sourceText, translation }] },
      artifact = { results, data: new Uint8Array([4, 5]) }
    getDocument.mockReturnValue({ promise: Promise.resolve(target), destroy: async () => {} })
    const hook = renderHook(() => usePdfTranslationDocument(original, results, artifact, 'years'))
    await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
  }
)

it.each([
  [
    'mixed parenthetical citations',
    '😀见（Quinn等人，2029，2031a）。见（Quinn等人，2031a）。',
    true
  ],
  ['mixed narrative citations', '😀见Quinn等人（2029，2031a）。见Quinn等人（2031a）。', true],
  [
    'reordered citation identities',
    '😀见（Quinn等人，2031a）。见（Quinn等人，2029，2031a）。',
    false
  ],
  ['reordered years', '😀见（Quinn等人，2031a，2029）。见（Quinn等人，2031a）。', false],
  ['changed companion year', '😀见（Quinn等人，2028，2031a）。见（Quinn等人，2031a）。', false],
  ['changed author', '😀见（Baker等人，2029，2031a）。见（Quinn等人，2031a）。', false],
  ['changed suffix', '😀见（Quinn等人，2029，2031b）。见（Quinn等人，2031a）。', false],
  ['extra bare year', '😀见（Quinn等人，2029，2031a）。见（Quinn等人，2031a）。2031a。', false],
  [
    'duplicated list',
    '😀见（Quinn等人，2029，2031a）。见（Quinn等人，2031a）。（Quinn等人，2029，2031a）。',
    false
  ],
  ['missing closing bracket', '😀见（Quinn等人，2029，2031a。见（Quinn等人，2031a）。', false]
] as const)(
  'keeps repeated suffix-year ownership across year lists: %s',
  (_name, target, accepted) => {
    const source = '😀See (Quinn et al., 2029, 2031a). See Quinn et al. (2031a).'
    for (const [index, match] of [...source.matchAll(/2031a/gu)].entries()) {
      expect(translatedPdfLinkFragment(source, target, match[0], match.index)).toEqual(
        accepted
          ? { start: index ? target.lastIndexOf('2031a') : target.indexOf('2031a'), text: '2031a' }
          : null
      )
    }
  }
)
