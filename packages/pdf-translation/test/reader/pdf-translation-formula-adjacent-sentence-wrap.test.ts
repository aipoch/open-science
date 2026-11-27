import { expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'

it.each([false, true])(
  'joins a wrapped sentence opener after an independent formula only on the same body rail (%s)',
  async (offset) => {
    const e = 12
    const runs = [
      [
        'Choose a minimum counterexample for the degree assertion. Put',
        'prose',
        72,
        572,
        468,
        true
      ],
      ['∆ := ∆(', 'prose', 72, 558, 47, false],
      ['H', 'italic', 119, 558, 9, false],
      [').', 'prose', 128, 558, 8, false],
      [' ', 'prose', 136, 558, 9, false],
      [
        'Minimality gives a valid bound for every vertex of the remaining graph.',
        'prose',
        145,
        558,
        376,
        false
      ],
      [' ', 'prose', 521, 558, 8, false],
      ['In', 'prose', 529, 558, 11, true],
      ['particular,', 'prose', offset ? 78 : 72, 544, 53, false],
      [' ', 'prose', offset ? 131 : 125, 544, 4, false],
      ['H', 'italic', offset ? 135 : 129, 544, 9, false],
      [' ', 'italic', offset ? 144 : 138, 544, 4, false],
      ['is ∆-regular.', 'prose', offset ? 148 : 142, 544, 64, true],
      ['The argument finishes with an independent counting step.', 'prose', 84, 530, 320, true]
    ] as const
    const items = runs.map(([str, fontName, x, y, width, hasEOL]) => ({
      str,
      fontName,
      width,
      hasEOL,
      dir: 'ltr',
      height: str.trim() ? e : 0,
      transform: [e, 0, 0, e, x, y]
    }))
    const page = {
      rotate: 0,
      getViewport: vi.fn(() => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] })),
      getTextContent: vi.fn().mockResolvedValue({
        items,
        styles: {
          prose: { ascent: 0.69, descent: -0.194, vertical: false },
          italic: { ascent: 0.69, descent: -0.194, vertical: false }
        }
      }),
      cleanup: vi.fn()
    }
    const { source } = await extractPdfTranslationSource({
      document: {
        numPages: 1,
        fingerprints: ['synthetic'],
        getPage: vi.fn().mockResolvedValue(page)
      } as unknown as PDFDocumentProxy,
      resourceRequestKey: 'synthetic',
      signal: new AbortController().signal
    })
    const formula = source.units.find((unit) => unit.source.includes('∆ :='))!
    expect(formula).toMatchObject({ sourceOnly: true, preserve: 'formula' })
    const before = source.units.find((unit) => unit.source.startsWith('Minimality gives'))!
    expect(before.fragments).toHaveLength(offset ? 1 : 2)
    expect(before.source.endsWith(offset ? '. In' : 'In particular, H is ∆-regular.')).toBe(true)
    expect(
      source.units
        .flatMap(({ fragments }) =>
          fragments.flatMap(({ items }) => items.map(({ index }) => index))
        )
        .sort((a, b) => a - b)
    ).toEqual(items.flatMap(({ str }, index) => (str.trim() ? [index] : [])))
  }
)
