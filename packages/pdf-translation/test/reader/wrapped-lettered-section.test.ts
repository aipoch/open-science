import { expect, test } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'

function wrappedLetteredSection(): PdfLayoutPage[] {
  const item = (
    str: string,
    x: number,
    baseline: number,
    width: number,
    heading = false,
    hasEOL = true
  ): PdfLayoutTextItem => {
    const size = heading ? 17.2 : 12
    return {
      str,
      width,
      height: size,
      dir: 'ltr',
      transform: [size, 0, 0, size, x, baseline],
      fontName: heading ? 'Section' : 'Body',
      fontAscent: 0.7,
      fontDescent: -0.2,
      fontVertical: false,
      hasEOL
    }
  }
  const page = (page: number, items: PdfLayoutTextItem[]): PdfLayoutPage => ({
    page,
    width: 595,
    height: 842,
    rotation: 0,
    items
  })
  return [
    page(1, [
      item(
        'The independent experimental discussion establishes the ordinary body font and design before the bibliography.',
        67,
        740,
        460
      ),
      item('References', 67, 600, 100, true, false),
      item(
        'Writer, A. (2020). Complete publication metadata. Independent Journal 12, 1–8.',
        67,
        560,
        460
      ),
      item(
        'Writer, B. (2021). A second complete publication. Independent Journal 14, 2–9.',
        67,
        540,
        460
      )
    ]),
    page(2, [
      item(
        'Writer, C. (2022). The complete final bibliographic record. Independent Journal 16, 3–10.',
        67,
        700,
        460
      ),
      item('A.', 67, 607, 20, true, false),
      item('Differences of the measured response for independent groups', 106, 607, 421, true),
      item('disjoint categories of the complete experimental de-', 106, 581, 421, true),
      item('sign', 106, 555, 70, true, false),
      item(
        'Fig. 7 – Independent comparison of the complete measured response across all groups,',
        67,
        115,
        460
      ),
      item(
        'including the controlled intervention and the reference observations. The reported',
        67,
        98,
        460
      ),
      item(
        'values use the same measurement units for every displayed experimental group.',
        67,
        81,
        430
      ),
      item('2', 294, 43, 7, false, false)
    ]),
    page(3, [
      item(
        'The response of the independent experimental groups differs. This is illustrated by',
        84,
        773,
        443
      ),
      item(
        'figure 7, which compares the complete observations and the independently measured',
        67,
        756,
        460
      ),
      item(
        'reference response. The same analysis applies to every complete experimental group.',
        67,
        739,
        460
      ),
      item('B.', 67, 695, 19, true, false),
      item('Proof of Result 1', 104, 695, 190, true),
      {
        ...item('B.1. Definitions and assumptions', 67, 650, 230, true),
        height: 14.3,
        transform: [14.3, 0, 0, 14.3, 67, 650]
      },
      item(
        'The following independent proof uses the complete ordinary measurements and retains every observation.',
        67,
        610,
        460
      )
    ])
  ]
}

test.each([
  'complete',
  'body-sized author',
  'citation title',
  'incomplete metrics',
  'different section font',
  'unindented tail',
  'foreign text',
  'missing next section',
  'unlinked figure',
  'incomplete body'
])('ends references only at a closed native wrapped lettered section: %s', (kind) => {
  const pages = wrappedLetteredSection(),
    title = pages[1].items.slice(1, 5)
  if (kind === 'body-sized author')
    for (const i of title) {
      i.height = 12
      i.transform[0] = i.transform[3] = 12
      i.fontName = 'Body'
    }
  if (kind === 'citation title') {
    pages[1].items[5].str =
      'Independent Journal 20, 10–18 (2024). The complete publication metadata.'
  }
  if (kind === 'incomplete metrics') delete title[2].fontAscent
  if (kind === 'different section font') for (const i of title) i.fontName = 'BookTitle'
  if (kind === 'unindented tail') title[2].transform[4] = 67
  if (kind === 'foreign text')
    pages[1].items.push({
      ...pages[1].items[0],
      str: 'Foreign prose',
      width: 70,
      transform: [12, 0, 0, 12, 300, 570]
    })
  if (kind === 'missing next section') pages[2].items[3].str = 'C.'
  if (kind === 'unlinked figure')
    pages[2].items[1].str = pages[2].items[1].str.replace('figure 7', 'figure 8')
  if (kind === 'incomplete body')
    pages[2].items[2].str = 'incomplete ordinary experimental continuation'
  const saved = structuredClone(pages),
    result = groupPdfTranslationPages({ pages, pageCount: 3 }),
    head = result.units.find((u) => u.items.includes('2:1'))!
  expect(head.referenceBoundary).toBe(kind === 'complete' ? true : undefined)
  expect(head.preserve).toBe(kind === 'complete' ? undefined : 'reference')
  expect(result.units.find((u) => u.items.includes('3:0'))?.preserve).toBe(
    kind === 'complete' ? undefined : 'reference'
  )
  expect(result.units.find((u) => u.source.startsWith('Writer, C.'))?.preserve).toBe('reference')
  expect(result.units.flatMap((u) => u.items).sort()).toEqual(
    pages.flatMap((p) => p.items.map((_, i) => `${p.page}:${i}`)).sort()
  )
  expect(pages).toEqual(saved)
})
