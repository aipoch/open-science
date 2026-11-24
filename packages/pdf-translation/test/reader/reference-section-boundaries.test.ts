import { expect, test } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'

function item(str: string, y: number, size = 10, fontName = 'Body', x = 60): PdfLayoutTextItem {
  return {
    str,
    width: Math.min(470, str.length * size * 0.45),
    height: size,
    dir: 'ltr',
    hasEOL: true,
    transform: [size, 0, 0, size, x, 800 - y],
    fontName,
    fontAscent: 0.78,
    fontDescent: -0.22
  }
}

function supplementaryBibliography(kind: string): PdfLayoutPage[] {
  const entry = (n: number, y: number): PdfLayoutTextItem[] => {
    const marker = item(`${n}.`, y)
    marker.hasEOL = false
    return [
      marker,
      item(
        'A. Writer. Complete independent publication metadata. Journal 12, 1–8 (2020).',
        y,
        10,
        'Body',
        78
      )
    ]
  }
  const pages: PdfLayoutPage[] = [
    {
      page: 1,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        item(
          'The ordinary experimental discussion remains eligible before the final bibliography.',
          100
        )
      ]
    },
    {
      page: 2,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        item(
          kind === 'ordinary-heading' ? 'Supplementary Results' : 'Supplementary References',
          100,
          kind === 'body-heading' ? 10 : 14,
          kind === 'body-heading' ? 'Body' : 'Section'
        ),
        ...entry(1, 130),
        ...entry(2, 165),
        item('2', 760, 10, 'Body', 297.75)
      ]
    },
    {
      page: 3,
      width: 600,
      height: 800,
      rotation: 0,
      items: [...entry(kind === 'missing-number' ? 4 : 3, 100), item('3', 760, 10, 'Body', 297.75)]
    }
  ]
  if (kind === 'foreign-prose')
    pages[2].items.splice(
      2,
      0,
      item('An independent experimental paragraph is outside the bibliographic record.', 150)
    )
  for (const page of pages.slice(1)) page.items.unshift(page.items.pop()!)
  return pages
}

test.each([
  'complete',
  'missing-number',
  'ordinary-heading',
  'body-heading',
  'unknown-end',
  'foreign-prose'
])('protects only a complete native supplementary bibliography range: %s', (kind) => {
  const pages = supplementaryBibliography(kind)
  const result = groupPdfTranslationPages({
    pages,
    ...(kind === 'unknown-end' ? {} : { pageCount: pages.length })
  })
  const records = result.units.filter((u) => /^\d+\. A\. Writer/u.test(u.source))
  expect(records).toHaveLength(3)
  expect(records.every((u) => !!u.sourceOnly)).toBe(kind === 'complete')
  expect(result.units.find((u) => u.source.startsWith('The ordinary'))?.sourceOnly).not.toBe(true)
  expect(result.units.flatMap((u) => u.items).sort()).toEqual(
    pages.flatMap((p) => p.items.map((_, i) => `${p.page}:${i}`)).sort()
  )
})

test.each(['unindented continuation', 'detached continuation', 'closed record', 'complete wrap'])(
  'requires a continuous native hanging range before the bibliography ends: %s',
  (kind) => {
    const pages = supplementaryBibliography('complete'),
      body = pages[2].items.find((i) => i.str.startsWith('A. Writer.'))!
    if (kind !== 'closed record') body.str = body.str.replace(' (2020).', '')
    pages[2].items.push(
      item(
        kind === 'complete wrap'
          ? 'Journal of Independent Measurements 15, 20–28 (2021).'
          : 'The independent experimental paragraph reports complete measurements (2021).',
        kind === 'detached continuation' ? 180 : 112,
        10,
        'Body',
        kind === 'unindented continuation' ? 60 : 78
      )
    )
    const before = structuredClone(pages),
      result = groupPdfTranslationPages({ pages, pageCount: pages.length }),
      continuation = result.units.find((u) => u.items.includes(`3:${pages[2].items.length - 1}`))
    expect(continuation).toBeDefined()
    expect(!!continuation?.sourceOnly).toBe(kind === 'complete wrap')
    expect(pages).toEqual(before)
    expect(result.units.flatMap((u) => u.items).sort()).toEqual(
      pages.flatMap((p) => p.items.map((_, i) => `${p.page}:${i}`)).sort()
    )
  }
)

test('keeps an independent native item after a closed same-line publication eligible', () => {
  const pages = supplementaryBibliography('complete')
  pages[2].items.push(item('Data 2021.', 100, 10, 'Foreign', 550))
  const result = groupPdfTranslationPages({ pages, pageCount: pages.length }),
    foreign = result.units.find((u) => u.source === 'Data 2021.')
  expect(foreign).toBeDefined()
  expect(foreign?.sourceOnly).not.toBe(true)
})

test('does not complete an unfinished publication with a detached same-line native field', () => {
  const pages = supplementaryBibliography('complete'),
    body = pages[2].items.find((i) => i.str.startsWith('A. Writer.'))!
  body.str = body.str.replace(' (2020).', '')
  pages[2].items.push(item('Data 2021.', 100, 10, 'Foreign', 550))
  const result = groupPdfTranslationPages({ pages, pageCount: pages.length }),
    foreign = result.units.find((u) => u.source === 'Data 2021.')
  expect(foreign).toBeDefined()
  expect(foreign?.sourceOnly).not.toBe(true)
})

function wholeLineCaptionLeaf(kind: string): PdfLayoutPage[] {
  const pages: PdfLayoutPage[] = [
    {
      page: 1,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        ...(kind === 'no-witness'
          ? [item('An earlier ordinary paragraph contains no caption style witness.', 40)]
          : [
              item(
                'Figure 1: An earlier eligible drawing explains the complete ordinary measurement.',
                40
              )
            ])
      ]
    },
    {
      page: 2,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        item('References', 110, 14, 'Section'),
        item('[1] A. Writer. Complete publication details in the preceding bibliography.', 140),
        item('[2] B. Author. Another complete reference before the separate drawing leaf.', 165)
      ]
    },
    {
      page: 3,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        item(
          'Figure 2: A complete drawing caption describes its independent graphical observation,',
          600
        ),
        item('with enough ordinary detail to explain the measured result.', 612),
        item(kind === 'wrong-footer' ? '8' : '3', 760, 10, 'Body', 297.75)
      ]
    }
  ]
  if (kind === 'missing-metrics') pages[2].items[0].fontAscent = undefined
  if (kind === 'foreign-prose')
    pages[2].items.splice(
      2,
      0,
      item('This independent ordinary prose does not belong to the drawing caption.', 660)
    )
  if (kind === 'mixed-references')
    pages[2].items.splice(
      2,
      0,
      item('[3] C. Author. Bibliographic content shares this page with the drawing.', 660)
    )
  return pages
}

test.each(['bibliography', 'caption'])(
  'requires the complete native footer font box inside the page for a %s proof',
  (kind) => {
    const pages =
        kind === 'bibliography'
          ? supplementaryBibliography('complete')
          : wholeLineCaptionLeaf('complete'),
      footer = pages[2].items.find((i) => i.str === '3')!
    footer.transform[5] = 1
    const before = structuredClone(pages),
      result = groupPdfTranslationPages({ pages, pageCount: pages.length }),
      target = result.units.find((u) =>
        u.source.startsWith(kind === 'bibliography' ? '3. A. Writer.' : 'Figure 2:')
      )
    expect(target).toBeDefined()
    expect(!!target?.sourceOnly).toBe(kind === 'caption')
    expect(pages).toEqual(before)
  }
)

test.each([
  'complete',
  'wrong-footer',
  'missing-metrics',
  'foreign-prose',
  'mixed-references',
  'no-witness'
])('releases only an independently proven whole-line caption leaf: %s', (kind) => {
  const pages = wholeLineCaptionLeaf(kind),
    result = groupPdfTranslationPages({ pages, pageCount: pages.length })
  const caption = result.units.find((u) => u.source.startsWith('Figure 2:'))
  expect(caption).toBeDefined()
  expect(!!caption?.sourceOnly).toBe(kind !== 'complete')
  expect(
    result.units.find((u) => u.source === (kind === 'wrong-footer' ? '8' : '3'))?.sourceOnly
  ).toBe(true)
  expect(result.units.find((u) => u.source.startsWith('[1]'))?.sourceOnly).toBe(true)
})

test.each([
  'single-line',
  'inline-and-wrapped',
  'foreign-prose',
  'mixed-references',
  'missing-panel-metrics',
  'inconsistent-footer-metrics',
  'overlapping-panel',
  'incomplete-caption',
  'no-witness'
])('requires an exhaustive native panel/caption/footer leaf: %s', (kind) => {
  const pages = wholeLineCaptionLeaf(kind),
    leaf = pages[2],
    caption =
      'Figure 2: A complete drawing caption explains independent observations and preserves every ordinary detail.',
    first = item(caption, 600),
    panels = [
      item('(a) Local example', 570, 9, 'Panel', 95),
      item('(b) Remote example', 570, 9, 'Panel', 340)
    ]
  first.width = 470
  leaf.items = [...panels, first, item('3', 760, 10, 'Body', 297.75)]
  if (kind === 'inline-and-wrapped') {
    const prefix = item('Figure 2:', 600),
      body = item(
        'A complete drawing caption explains independent observations',
        600,
        10,
        'Body',
        105
      ),
      tail = item('and preserves every ordinary detail.', 612)
    prefix.width = 40
    prefix.hasEOL = false
    prefix.transform[0] = 10.2
    body.width = 360
    leaf.items.splice(2, 1, prefix, body, tail)
  }
  if (kind === 'foreign-prose' || kind === 'mixed-references')
    leaf.items.splice(
      leaf.items.length - 1,
      0,
      item(
        kind === 'mixed-references'
          ? '[3] C. Author. A complete reference on this same page.'
          : 'Independent ordinary prose shares this page with the drawing.',
        660
      )
    )
  if (kind === 'missing-panel-metrics') panels[1].fontAscent = undefined
  if (kind === 'inconsistent-footer-metrics') leaf.items.at(-1)!.transform[3] = 200
  if (kind === 'overlapping-panel') panels[1].transform[5] = first.transform[5]
  if (kind === 'incomplete-caption') first.str = first.str.slice(0, -1)
  const before = structuredClone(pages),
    result = groupPdfTranslationPages({ pages, pageCount: pages.length }),
    owner = result.units.find((u) => u.source.startsWith('Figure 2:'))
  expect(owner).toBeDefined()
  expect(!!owner?.sourceOnly).toBe(!['single-line', 'inline-and-wrapped'].includes(kind))
  expect(pages).toEqual(before)
  expect(result.units.flatMap((u) => u.items).sort()).toEqual(
    pages.flatMap((p) => p.items.map((_, i) => `${p.page}:${i}`)).sort()
  )
  expect(result.units.find((u) => u.source.startsWith('[1]'))?.sourceOnly).toBe(true)
})

function fixture(title: 'decimal' | 'declarations' | 'supplement'): PdfLayoutPage {
  const items = [
    item('References', 100, 14, 'Section'),
    ...Array.from({ length: 5 }, (_, i) =>
      item(
        `[${i + 1}] A. Writer. A complete synthetic publication with its journal details.`,
        130 + i * 15
      )
    ),
    item(
      title === 'decimal'
        ? 'A Derivation of Results 2.3 and 4.5'
        : title === 'declarations'
          ? 'Declarations'
          : 'S1 Additional Experimental',
      240,
      14,
      'Section'
    )
  ]
  if (title === 'declarations')
    items.push(
      item('• Funding: This study received no external financial support.', 270),
      item('• Competing interests: The authors declare no competing interests.', 285)
    )
  if (title === 'supplement') items.push(item('Details and Evaluation', 256, 14, 'Section', 78))
  const bodyY = title === 'declarations' ? 315 : title === 'supplement' ? 286 : 270
  items.push(
    item(
      'The following independent section explains the experimental procedure and its controls.',
      bodyY
    ),
    item(
      'Its measurements and analysis are separate from the preceding bibliographic records.',
      bodyY + 14
    ),
    item('This ordinary explanatory paragraph belongs to the body of the document.', bodyY + 28)
  )
  return { page: 1, width: 600, height: 800, rotation: 0, items }
}

test.each(['decimal', 'declarations', 'supplement'] as const)(
  'ends references at the independently styled %s section',
  (title) => {
    const page = fixture(title)
    const result = groupPdfTranslationPages({ pages: [page] })
    expect(
      result.units.find((u) => u.source.startsWith('The following independent'))?.sourceOnly
    ).not.toBe(true)
    expect(result.units.find((u) => u.source.startsWith('[1]'))?.sourceOnly).toBe(true)
    expect(result.units.find((u) => u.source.startsWith('[1]'))?.preserve).toBe('reference')
    expect(
      result.units.find((u) => u.source.startsWith('The following independent'))?.preserve
    ).toBeUndefined()
    if (title === 'declarations')
      expect(result.units.find((u) => u.source.startsWith('• Funding'))?.sourceOnly).not.toBe(true)
    expect(result.units.flatMap((u) => u.items).sort()).toEqual(
      page.items.map((_, i) => `1:${i}`).sort()
    )
  }
)

test.each(['decimal', 'declarations', 'supplement'] as const)(
  'retains references when the %s heading is only body-sized',
  (title) => {
    const page = fixture(title)
    for (const i of page.items.slice(6))
      if (i.fontName === 'Section') {
        i.height = 10
        i.transform[0] = 10
        i.transform[3] = 10
        i.fontName = 'Body'
      }
    const result = groupPdfTranslationPages({ pages: [page] })
    expect(
      result.units.find((u) => u.source.startsWith('The following independent'))?.sourceOnly
    ).toBe(true)
  }
)

test('accepts native declaration markers whose symbol font has no ascent or descent', () => {
  const page = fixture('declarations')
  const first = [
    item('•', 270, 10, 'Symbols'),
    item('Funding:', 270, 10, 'Bold', 70),
    item('This study received no external financial support.', 270, 10, 'Body', 115)
  ]
  const second = [
    item('•', 285, 10, 'Symbols'),
    item('Competing interests:', 285, 10, 'Bold', 70),
    item('The authors declare no competing interests.', 285, 10, 'Body', 165)
  ]
  for (const line of [first, second]) {
    line[0].fontAscent = 0
    line[0].fontDescent = 0
    line[0].hasEOL = false
    line[1].hasEOL = false
  }
  page.items.splice(7, 2, ...first, ...second)
  const result = groupPdfTranslationPages({ pages: [page] })
  expect(result.units.find((u) => u.source.startsWith('• Funding'))?.sourceOnly).not.toBe(true)
  expect(
    result.units.find((u) => u.source.startsWith('The following independent'))?.sourceOnly
  ).not.toBe(true)
  expect(result.units.flatMap((u) => u.items).sort()).toEqual(
    page.items.map((_, i) => `1:${i}`).sort()
  )
})

test.each(['different-font', 'missing-list', 'foreign-ink', 'different-tail-font', 'missing-body'])(
  'does not release bibliography without complete native section evidence: %s',
  (fault) => {
    const title = fault.includes('tail') || fault === 'missing-body' ? 'supplement' : 'declarations'
    const page = fixture(title)
    if (fault === 'different-font') page.items[6].fontName = 'CitationTitle'
    if (fault === 'missing-list') page.items[8].str = '[9] Another independent bibliography record.'
    if (fault === 'foreign-ink') page.items.push(item('unrelated', 245, 10, 'Other', 90))
    if (fault === 'different-tail-font') page.items[7].fontName = 'Other'
    if (fault === 'missing-body') page.items = page.items.slice(0, 8)
    const result = groupPdfTranslationPages({ pages: [page] })
    const target = result.units.find((u) =>
      u.source.startsWith(fault === 'missing-body' ? 'S1 ' : 'The following independent')
    )
    expect(target?.sourceOnly).toBe(true)
  }
)

function wrappedSupplement(): PdfLayoutPage[] {
  const references = fixture('decimal')
  references.items = references.items.slice(0, 6)
  const title = [
    item(
      'Supplementary Material for “A General Investigation of Calibrated and Robust Estimation',
      70,
      12,
      'Section'
    ),
    item('under Discrete Sampling with Uncertain Observations and Error Bounds”', 88, 12, 'Section')
  ]
  for (const line of title) line.transform[4] = (600 - line.width) / 2
  const items = [
    ...title,
    item(
      'The supplementary material follows an independent sequence. Section S1 provides a complete account',
      120
    ),
    item(
      'of the derivation and its assumptions, while Section S2 explains additional measurements',
      134
    ),
    item(
      'and provides independent controls that remain separate from the cited publications.',
      148
    ),
    item('S1 Further Derivations', 195, 14, 'Section'),
    item('S1.1 Detailed Conditions', 225, 12, 'Section'),
    item(
      'The independent supplementary explanation describes the experimental assumptions in ordinary prose.',
      255
    ),
    item(
      'The supporting argument belongs to this section rather than to a bibliographic entry.',
      269
    )
  ]
  return [references, { page: 2, width: 600, height: 800, rotation: 0, items }]
}

test('ends references at a complete wrapped quoted supplement title and independent overview', () => {
  const pages = wrappedSupplement()
  const result = groupPdfTranslationPages({ pages })
  expect(
    result.units.find((u) => u.source.startsWith('The supplementary material'))?.sourceOnly
  ).not.toBe(true)
  expect(
    result.units.find((u) => u.source.startsWith('The independent supplementary'))?.sourceOnly
  ).not.toBe(true)
  expect(result.units.find((u) => u.source.startsWith('[1]'))?.sourceOnly).toBe(true)
  expect(result.units.find((u) => u.source.startsWith('[1]'))?.preserve).toBe('reference')
  expect(
    result.units.find((u) => u.source.startsWith('The supplementary material'))?.preserve
  ).toBeUndefined()
  expect(result.units.flatMap((u) => u.items).sort()).toEqual(
    pages.flatMap((p) => p.items.map((_, i) => `${p.page}:${i}`)).sort()
  )
})

test.each([
  'body-font-title',
  'different-tail-font',
  'broken-quote',
  'missing-overview',
  'unreferenced-section',
  'missing-metrics',
  'foreign-source',
  'nonterminal-overview'
])('retains references when the wrapped title proof is incomplete: %s', (fault) => {
  const pages = wrappedSupplement(),
    p = pages[1]
  if (fault === 'body-font-title') p.items[0].fontName = 'Body'
  if (fault === 'different-tail-font') p.items[1].fontName = 'Citation'
  if (fault === 'broken-quote') p.items[1].str = p.items[1].str.replace('”', '')
  if (fault === 'missing-overview') p.items.splice(2, 3)
  if (fault === 'unreferenced-section') p.items[5].str = 'S3 Further Derivations'
  if (fault === 'missing-metrics') p.items[0].fontAscent = undefined
  if (fault === 'foreign-source')
    p.items.splice(1, 0, item('Unrelated content', 400, 10, 'Other', 450))
  if (fault === 'nonterminal-overview') p.items[4].str = p.items[4].str.replace(/\.$/u, '')
  const result = groupPdfTranslationPages({ pages })
  expect(
    result.units.find((u) => u.source.startsWith('The independent supplementary'))?.sourceOnly
  ).toBe(true)
})

test('keeps independent formula pieces protected when restoring supplementary prose', () => {
  const pages = wrappedSupplement()
  pages[1].items.push(
    item('=', 310, 10, 'Symbols'),
    item('E', 310, 10, 'Body', 70),
    item('p', 310, 7, 'Italic', 78),
    item('x', 310, 10, 'Italic', 85)
  )
  const result = groupPdfTranslationPages({ pages })
  const formulas = result.units.filter((u) =>
    u.items.some((key) => Number(key.split(':')[1]) >= 9 && key.startsWith('2:'))
  )
  expect(formulas.length).toBeGreaterThan(0)
  expect(formulas.every((u) => u.sourceOnly)).toBe(true)
  expect(
    result.units.find((u) => u.source.startsWith('The supplementary material'))?.sourceOnly
  ).not.toBe(true)
})

test('restores a complete supplementary sentence with an unfinished native continuation', () => {
  const pages = wrappedSupplement()
  pages[1].items[8].str =
    'The supporting argument continues through the remaining derivation and introduces the next'
  const result = groupPdfTranslationPages({ pages })
  expect(
    result.units.find((u) => u.source.startsWith('The independent supplementary'))?.sourceOnly
  ).not.toBe(true)
})

function wrappedNumberedSection(): PdfLayoutPage[] {
  const pages = wrappedSupplement()
  const label = item('S4', 80, 14, 'Section')
  const title = item('Independent Sampling Procedure for Measurements', 80, 14, 'Section', 95)
  title.width = 440
  const tail = item('Details', 100.5, 14, 'Section', 95)
  label.hasEOL = false
  tail.hasEOL = false
  const blank = item('', 110)
  blank.width = 0
  blank.height = 0
  blank.hasEOL = true
  const items = [
    label,
    title,
    tail,
    blank,
    item('Algorithm S2 An independent procedure under controlled conditions', 131, 10, 'Section'),
    item('for each controlled observation do', 153),
    item('h ∈ A', 175, 10, 'Symbols')
  ]
  pages.push({ page: 3, width: 600, height: 800, rotation: 0, items })
  return pages
}
test('restores only the complete native wrapped numbered heading tail', () => {
  const pages = wrappedNumberedSection(),
    result = groupPdfTranslationPages({ pages })
  const title = result.units.find((u) => u.source.startsWith('S4 ')),
    tail = result.units.find((u) => u.source === 'Details')
  expect(title).toBeDefined()
  expect(tail).toBeDefined()
  expect(title?.sourceOnly).not.toBe(true)
  expect(tail?.sourceOnly).not.toBe(true)
  expect(
    result.units
      .filter((u) => u.fragments[0].page === 3 && u !== title && u !== tail)
      .every((u) => u.sourceOnly)
  ).toBe(true)
  expect(result.units.flatMap((u) => u.items).sort()).toEqual(
    pages
      .flatMap((p) =>
        p.items.map((_, i) => `${p.page}:${i}`).filter((_, i) => p.items[i].str.trim())
      )
      .sort()
  )
})
test.each([
  'missing-metrics',
  'different-font',
  'different-size',
  'misaligned-tail',
  'missing-line-end',
  'missing-boundary',
  'distant-next-block',
  'same-size-next-block',
  'foreign-source',
  'unnumbered-title',
  'incomplete-ordinary-title',
  'not-near-full-width',
  'invalid-metrics',
  'tall-foreign-source',
  'next-block-outside-page'
])('keeps a short heading tail protected without complete native wrapper evidence: %s', (fault) => {
  const pages = wrappedNumberedSection(),
    p = pages[2]
  if (fault === 'next-block-outside-page') p.items[4].width = 800
  if (fault === 'missing-metrics') p.items[2].fontAscent = undefined
  if (fault === 'invalid-metrics') p.items[2].fontDescent = 4
  if (fault === 'tall-foreign-source') p.items.push(item('Independent', 130, 60, 'Other', 450))
  if (fault === 'different-font') p.items[2].fontName = 'Other'
  if (fault === 'different-size') {
    p.items[2].height = 13
    p.items[2].transform[0] = 13
    p.items[2].transform[3] = 13
  }
  if (fault === 'misaligned-tail') p.items[2].transform[4] += 10
  if (fault === 'missing-line-end') p.items[1].hasEOL = false
  if (fault === 'missing-boundary') p.items[3].hasEOL = false
  if (fault === 'distant-next-block') p.items[4].transform[5] -= 90
  if (fault === 'same-size-next-block') {
    p.items[4].height = 14
    p.items[4].transform[0] = 14
    p.items[4].transform[3] = 14
  }
  if (fault === 'foreign-source')
    p.items.splice(2, 0, item('independent text', 170, 10, 'Other', 450))
  if (fault === 'unnumbered-title') p.items[0].str = 'A4'
  if (fault === 'incomplete-ordinary-title') p.items[1].str = 'X ∈ A'
  if (fault === 'not-near-full-width') p.items[1].width = 100
  const result = groupPdfTranslationPages({ pages }),
    tail = result.units.find((u) => u.source === 'Details')
  expect(tail).toBeDefined()
  expect(tail?.sourceOnly).toBe(true)
})

// Native section roles close an unpunctuated appendix without releasing math.
function plainAppendixPage(fault = ''): PdfLayoutPage {
  const make = (
    str: string,
    y: number,
    size = 10,
    fontName = 'Body',
    x = 60
  ): PdfLayoutTextItem => ({
    ...item(str, y, size, fontName, x),
    fontAscent: 0.8,
    fontDescent: -0.2,
    fontVertical: false
  })
  const items = [
    make('1 Methods', 100, 12, 'Section'),
    make(
      'The complete method describes the independent experiment and explains every measured outcome.',
      130
    ),
    make('A second ordinary sentence documents the inputs and the reproducible analysis.', 150),
    make('2 Results', 200, 12, 'Section'),
    make(
      'The complete results describe the independent observations and their measured uncertainty.',
      230
    ),
    make('Another ordinary sentence documents all observations and the reproducible result.', 250),
    make('References', 300, 12, 'Section'),
    make('[1] A. Author. A complete publication. Journal, 2020.', 330, 8),
    make('[2] B. Writer. Another complete publication. Journal, 2021.', 350, 8),
    make('Appendix A Independent methods', 400, 12, 'Section'),
    make(
      'The independent appendix explains the complete procedure and its reproducible implementation.',
      430
    ),
    make('x = y + 1', 470)
  ]
  if (fault === 'wrong-role') items[9].fontName = 'Body'
  if (fault === 'wrong-size') items[9].height = items[9].transform[0] = items[9].transform[3] = 14
  if (fault === 'wrong-margin') items[9].transform[4] += 10
  if (fault === 'missing-witness') items[3].str = 'Results without a section number'
  if (fault === 'ordinary-title') items[9].str = 'A study of appendix methods'
  const fonts = Object.fromEntries(
    ['Body', 'Section'].map((name) => [
      name,
      { ascent: 0.8, descent: -0.2, vertical: false as const, nativeMetrics: true as const }
    ])
  )
  if (fault === 'missing-font') delete (fonts as Partial<typeof fonts>).Section
  return {
    page: 1,
    width: 600,
    height: 800,
    rotation: 0,
    items,
    nativeSectionFontEvidence: { complete: true, fonts }
  }
}
test('ends a same-page bibliography at a complete unpunctuated native appendix role', () => {
  const page = plainAppendixPage(),
    result = groupPdfTranslationPages({ pages: [page], pageCount: 1 }),
    title = result.units.find((u) => u.source === 'Appendix A Independent methods')!,
    body = result.units.find((u) => u.source.startsWith('The independent appendix'))!
  expect(title.referenceBoundary).toBe(true)
  expect(body.sourceOnly).not.toBe(true)
  expect(body.preserve).not.toBe('reference')
  expect(result.units.find((u) => u.source.startsWith('[1]'))?.preserve).toBe('reference')
  expect(result.units.find((u) => u.source === 'x = y + 1')?.sourceOnly).toBe(true)
})
test.each([
  'wrong-role',
  'wrong-size',
  'wrong-margin',
  'missing-witness',
  'ordinary-title',
  'missing-font'
])('requires the full native appendix role: %s', (fault) => {
  const page = plainAppendixPage(fault),
    result = groupPdfTranslationPages({ pages: [page], pageCount: 1 }),
    body = result.units.find((u) => u.source.startsWith('The independent appendix'))!
  expect(body.sourceOnly).toBe(true)
  expect(body.preserve).toBe('reference')
})
function closedAlgorithmPage(fault = ''): PdfLayoutPage {
  const make = (str: string, y: number, width: number): PdfLayoutTextItem => ({
      ...item(str, 800 - y, 10, 'Body'),
      width,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false
    }),
    items = [
      make('Algorithm 1 Update values', 690, 180),
      make('Input: an initial value', 670, 160),
      make('1: if ready then', 650, 140),
      make('2: return value', 630, 140),
      make('3: end if', 620, 100),
      make('The separate argument is ordinary prose and remains translatable.', 600, 380),
      make('X', 590, 10),
      make('k < N', 580, 40)
    ],
    rules = [700, 680, 610].map((baseline, n) => ({
      left: 60,
      right: 460,
      baseline,
      halfHeight: 0.2,
      operators: [n]
    }))
  if (fault === 'unfinished-prose')
    items[5].str = 'An incomplete explanatory phrase without a confirmed ending'
  if (fault === 'wrong-rail') rules[2].right++
  const page: PdfLayoutPage = {
    page: 1,
    width: 600,
    height: 800,
    rotation: 0,
    items,
    nativeNumberedPacketEvidence: {
      complete: true,
      rules,
      fonts: { Body: { ascent: 0.8, descent: -0.2, vertical: false, nativeMetrics: true } }
    }
  }
  if (fault === 'missing-font' && page.nativeNumberedPacketEvidence?.complete)
    delete page.nativeNumberedPacketEvidence.fonts.Body
  if (fault === 'missing-proof')
    page.nativeNumberedPacketEvidence = { complete: false, reason: 'missing native rule' }
  return page
}
test('stops an algorithm at its complete native closing rule before ordinary prose', () => {
  const page = closedAlgorithmPage(),
    result = groupPdfTranslationPages({ pages: [page], pageCount: 1 })
  expect(
    result.units.find((u) => u.source.startsWith('The separate argument'))?.sourceOnly
  ).not.toBe(true)
  expect(result.units.find((u) => u.source.startsWith('2: return'))?.preserve).toBe('code')
  expect(result.units.find((u) => u.source === 'X')?.sourceOnly).toBe(true)
  expect(result.units.find((u) => u.source === 'k < N')?.sourceOnly).toBe(true)
})
test.each(['wrong-rail', 'missing-proof', 'missing-font'])(
  'does not invent a native algorithm closing boundary: %s',
  (fault) => {
    const page = closedAlgorithmPage(fault),
      result = groupPdfTranslationPages({ pages: [page], pageCount: 1 })
    expect(result.units.find((u) => u.source.startsWith('The separate argument'))?.sourceOnly).toBe(
      true
    )
  }
)

test('does not restore an unfinished external phrase merely because it is below a closing rule', () => {
  const page = closedAlgorithmPage('unfinished-prose'),
    result = groupPdfTranslationPages({ pages: [page], pageCount: 1 })
  expect(
    result.units.find((u) => u.source.startsWith('An incomplete explanatory phrase'))?.sourceOnly
  ).toBe(true)
})

function nativeFolioCollision(fault = ''): PdfLayoutPage[] {
  return Array.from({ length: 8 }, (_, n) => {
    const number = n + 1,
      body = item(
        'The complete ordinary argument has several independently native words.',
        200,
        10,
        'Body'
      ),
      folio = item(String(number), 610, 10, 'Body', number % 2 ? 287.5 : 307.5)
    folio.width = 5
    folio.fontVertical = false
    body.fontVertical = false
    if (number === 6) {
      body.str = 'Figure 1. The complete measured caption keeps the genuine value 1.28.'
      body.width = 360
      body.transform[5] = 190
    }
    if (fault === 'not-last' && number === 6)
      return { page: number, width: 600, height: 800, rotation: 0, items: [folio, body] }
    if (fault === 'font' && number === 6) folio.fontAscent = 0.7
    if (fault === 'false-number' && number === 6) folio.str = '7'
    if (fault === 'rail') folio.transform[5] += number
    if (fault === 'no-gutter' && number !== 6) body.transform[5] = 190
    return {
      page: number,
      width: 600,
      height: 800,
      rotation: 0,
      items: [body, folio],
      nativeFolioFontEvidence:
        fault === 'missing-native'
          ? { complete: false }
          : {
              complete: true,
              fonts: {
                Body: { ascent: 0.78, descent: -0.22, vertical: false, nativeMetrics: true }
              }
            }
    } as PdfLayoutPage
  })
}
test('isolates only a complete native pagination rail from a colliding caption', () => {
  const pages = nativeFolioCollision(),
    before = structuredClone(pages),
    result = groupPdfTranslationPages({ pages, pageCount: pages.length }),
    folio = result.units.find((u) => u.items.includes('6:1'))!,
    caption = result.units.find((u) => u.items.includes('6:0'))!
  expect(folio.source).toBe('6')
  expect(folio.sourceOnly).toBe(true)
  expect(folio.preserve).toBe('literal')
  expect(caption.source).toContain('1.28.')
  expect(caption.items).not.toContain('6:1')
  expect(pages).toEqual(before)
  expect(result.units.flatMap((u) => u.items).filter((k) => k === '6:1')).toHaveLength(1)
})
test.each(['font', 'false-number', 'rail', 'no-gutter', 'missing-native'])(
  'does not infer a colliding folio from incomplete %s evidence',
  (fault) => {
    const pages = nativeFolioCollision(fault),
      result = groupPdfTranslationPages({ pages, pageCount: pages.length }),
      owner = result.units.find((u) => u.items.includes('6:1'))!
    const baseline = groupPdfTranslationPages({
      pages: pages.map((p) => ({ ...p, nativeFolioFontEvidence: undefined })),
      pageCount: pages.length
    })
    expect(owner).toEqual(baseline.units.find((u) => u.items.includes('6:1')))
  }
)

function centeredReferencesTail(fault = ''): PdfLayoutPage {
  const title = item('References', 60, 12, 'Native', 270)
  title.width = 60
  const items = [
    title,
    item('[1] A. Author. Complete independent book citation.', 100, 10, 'Native'),
    item('100pp.', 118, 10, 'Native', 80),
    item('[2] B. Writer. Another complete publication record.', 150, 10, 'Native')
  ]
  for (const i of items) {
    i.fontAscent = 0.8
    i.fontDescent = -0.2
    i.fontVertical = false
  }
  const page: PdfLayoutPage = {
    page: 1,
    width: 600,
    height: 800,
    rotation: 0,
    items,
    nativeReferenceEvidence: {
      complete: true,
      rules: [],
      fonts: { Native: { ascent: 0.8, descent: -0.2, vertical: false, nativeMetrics: true } }
    }
  }
  if (fault === 'right-column') title.transform[4] = 330
  if (fault === 'above-heading') items[2].transform[5] = 770
  if (fault === 'missing-evidence')
    page.nativeReferenceEvidence = { complete: false, reason: 'missing native font' }
  if (fault === 'missing-font' && page.nativeReferenceEvidence?.complete)
    delete page.nativeReferenceEvidence.fonts.Native
  if (fault === 'zero-metrics') title.fontAscent = 0
  if (fault === 'vertical-font') title.fontVertical = true
  if (fault === 'inconsistent-metrics' && page.nativeReferenceEvidence?.complete)
    page.nativeReferenceEvidence.fonts.Native.ascent = 0.7
  if (fault === 'shifted-center') title.transform[4] += 1
  return page
}

test.each([
  '',
  'right-column',
  'above-heading',
  'missing-evidence',
  'missing-font',
  'zero-metrics',
  'vertical-font',
  'inconsistent-metrics',
  'shifted-center'
])('keeps a short native bibliography tail under its centered References heading: %s', (fault) => {
  const page = centeredReferencesTail(fault),
    before = structuredClone(page),
    result = groupPdfTranslationPages({ pages: [page], pageCount: 1 })
  const tail = result.units.find((u) => u.items.includes('1:2'))!
  expect(tail.sourceOnly === true && tail.preserve === 'reference').toBe(!fault)
  if (!fault)
    expect(result.units.filter((u) => /^\[[12]\]/u.test(u.source)).every((u) => u.sourceOnly)).toBe(
      true
    )
  expect(page).toEqual(before)
})

test.each(['complete', 'missing number', 'foreign prose'])(
  'protects a continuous terminal decimal reference column: %s',
  (shape) => {
    const row = (
      text: string,
      x: number,
      y: number,
      width: number,
      face = 'Reference',
      size = 9
    ): PdfLayoutTextItem => ({
      ...item(text, 800 - y, size, face, x),
      width,
      fontAscent: 0.75,
      fontDescent: -0.24,
      fontVertical: false
    })
    const left = [1, 2, 3, 4].flatMap((number, index) => [
      row(
        `${number}. T. Example and C. Reader, “Catalogue of samples,”`,
        61,
        198 - 23 * index,
        233
      ),
      row('J. of Methods 8, 70–74 (2019). (document)', 74, 187 - 23 * index, 203)
    ])
    const right = [5, 6, 7].flatMap((number, index) => [
      row(
        `${shape === 'missing number' && index === 1 ? number + 4 : number}. L. Example and F. Reader, “Measuring a variable,”`,
        319,
        737 - 33 * index,
        238
      ),
      row(
        index === 1
          ? 'J. of Samples 6, 8–14 (2020). (docu-'
          : 'An independent study published in the archive.',
        333,
        726 - 33 * index,
        222
      ),
      row(
        index === 1 ? 'ment)' : 'J. of Samples 6, 8–14 (2020). (document)',
        333,
        715 - 33 * index,
        199
      )
    ])
    const ordinary = row(
      'The first assessment was completed with the control device.',
      52,
      538,
      243,
      'Body',
      10
    )
    const foreign = row(
      'The following sentence resumes normal reporting after the list.',
      319,
      625,
      238,
      'Body',
      10
    )
    const items = [
      ordinary,
      row('An independent paragraph ends above the reference heading.', 52, 526, 243, 'Body', 10),
      row('References', 53, 223, 58, 'Heading', 10),
      ...left,
      ...right,
      ...(shape === 'foreign prose' ? [foreign] : []),
      row('1', 303, 25, 5, 'Folio', 10)
    ]
    const page = { page: 1, width: 612, height: 792, rotation: 0, items }
    const original = structuredClone(page)
    const { units } = groupPdfTranslationPages({ pages: [page], pageCount: 1 })
    const owners = (runs: PdfLayoutTextItem[]): typeof units => {
      const keys = runs.map((run) => `1:${items.indexOf(run)}`)
      return units.filter((unit) => unit.items.some((key) => keys.includes(key)))
    }
    const continuation = owners(right)
    expect(continuation.length).toBeGreaterThan(1)
    expect(continuation.every((unit) => unit.sourceOnly && unit.preserve === 'reference')).toBe(
      shape === 'complete'
    )
    expect(owners(left).every((unit) => unit.sourceOnly && unit.preserve === 'reference')).toBe(
      true
    )
    expect(owners([ordinary])[0].sourceOnly).toBeUndefined()
    if (shape === 'foreign prose') expect(owners([foreign])[0].sourceOnly).toBeUndefined()
    expect(page).toEqual(original)
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.map((_, index) => `1:${index}`).sort()
    )
  }
)

test.each([false, true])(
  'keeps a hanging page-count continuation with consecutive references (shifted=%s)',
  (shifted) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = true
    ): PdfLayoutTextItem => ({
      ...item(str, y, 8, 'Reference', x),
      width,
      hasEOL,
      fontVertical: false
    })
    const heading = { ...item('References', 126, 10, 'Title', 272), width: 56 }
    const tail = row('pages, to appear in Journal of Methods.', shifted ? 162 : 141, 151, 100)
    const items = [
      heading,
      row('1. A. Reader, Measurements in a channel.', 130, 141, 168, false),
      row('Preprint series archive, 32', 301, 141, 183),
      tail,
      row('2. B. Writer, Analysis of data. J. Methods 5 (2022).', 130, 161, 351),
      row('3. C. Editor, A separate study. J. Examples 6 (2023).', 130, 171, 351)
    ]
    const pages = [{ page: 1, width: 600, height: 800, rotation: 0, items }]
    const { units } = groupPdfTranslationPages({ pages, pageCount: 1 })
    const owner = units.find((unit) => unit.items.includes(`1:${items.indexOf(tail)}`))
    expect(owner?.source).toBe(tail.str)
    expect(owner?.sourceOnly === true && owner?.preserve === 'reference').toBe(!shifted)
  }
)

test.each([false, true])(
  'keeps a wrapped ancillary-file locator in consecutive bracketed references (displaced=%s)',
  (displaced) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = true
    ): PdfLayoutTextItem => ({
      ...item(str, y, 8, 'Reference', x),
      width,
      hasEOL,
      fontVertical: false
    })
    const locator = row('file at arXiv:0000.00000v2.', displaced ? 112 : 85.2, 240, 100, false)
    const items = [
      { ...item('References', 204, 10, 'Title', 272), width: 56 },
      row(
        '[1] Ada Reader and Benjamin Author. Measurements from a remote station.',
        72,
        220,
        286,
        false
      ),
      row('J. Stations, 22, 30–44, 2022.', 361, 220, 96),
      row(
        '[2] Casey Writer. Observations from another station [technical report]. Available as an ancillary',
        72,
        230,
        450
      ),
      locator,
      row('', 0, 0, 0),
      {
        ...item(
          'Institute of Applied Observations, 120 Example Avenue, Anytown, Country.',
          258,
          8,
          'Affiliation',
          84
        ),
        width: 400
      },
      { ...item('E-mail address: test@example.invalid', 278, 8, 'Affiliation', 84), width: 120 }
    ]
    const pages = [{ page: 1, width: 600, height: 800, rotation: 0, items }]
    const { units } = groupPdfTranslationPages({ pages, pageCount: 1 })
    const owner = units.find((unit) => unit.items.includes(`1:${items.indexOf(locator)}`))
    expect(owner?.source).toBe(locator.str)
    expect(owner?.sourceOnly === true && owner?.preserve === 'reference').toBe(!displaced)
  }
)

test.each([false, true])(
  'retains a wrapped journal name on the numbered reference rail (shifted=%s)',
  (shifted) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      hasEOL = false
    ): PdfLayoutTextItem => ({
      ...item(str, y, 10, fontName, x),
      width,
      hasEOL,
      fontVertical: false
    })
    const first = row('Measurement,Volume 12, 18', shifted ? 63 : 55, 376.5, 141)
    const items = [
      { ...item('REFERENCES', 317, 12, 'Heading', 265), width: 70, fontVertical: false },
      row('[1]', 55, 342, 12),
      row(
        'P. Writer, “Methods in signal analysis,” Systems Review 7, 20–32 (2021).',
        73,
        342,
        467,
        'Body',
        true
      ),
      row('[2]', 55, 353.5, 12),
      row(
        'R. Editor, “An introduction to wave patterns,” Field Studies 8, 10–18 (2023).',
        73,
        353.5,
        467,
        'Body',
        true
      ),
      row('[3]', 55, 365, 12),
      row('L.P.', 76, 365, 20, 'Alternate'),
      row('Reader,', 105, 365, 35, 'Alternate'),
      row(
        'K.T. Other, “A study of sampled signals in simple instruments”,Applied',
        145,
        365,
        395,
        'Alternate',
        true
      ),
      first,
      row('-', 196.1, 376.5, 3.3),
      row('25 (2022)', 199.5, 376.5, 46, 'Body', true),
      row('[4]', 55, 388, 12),
      row(
        'M. Analyst, “Field calibration of instruments,” Signal Reports 18, 61–74 (2024).',
        73,
        388,
        467,
        'Body',
        true
      )
    ]
    const pages = [{ page: 1, width: 600, height: 800, rotation: 0, items }]
    const { units } = groupPdfTranslationPages({ pages, pageCount: 1 })
    const owner = units.find((unit) => unit.items.includes(`1:${items.indexOf(first)}`))
    expect(owner?.source).toBe('Measurement,Volume 12, 18-25 (2022)')
    expect(owner?.sourceOnly === true && owner?.preserve === 'reference').toBe(!shifted)
  }
)

test.each([true, false])(
  'retains a complete author-date lane with wrapped initials (%s)',
  (closed) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Reference',
      size = 9,
      hasEOL = true
    ): PdfLayoutTextItem => ({
      ...item(str, 800 - y, size, fontName, x),
      width,
      hasEOL,
      fontVertical: false
    })
    const tail = 'Series, 12, doi: 10.0000/example-b'
    const items = [
      row(
        'The final body section describes an independent processing method.',
        50,
        650,
        508,
        'Body',
        10
      ),
      row('REFERENCES', 272, 606, 68, 'Heading', 10),
      row('Arden, T., Irvine, P., Pa´', 50, 587, 120, 'Reference', 9, false),
      row('z, B., et al. 2020,', 167, 587, 103),
      row('Example Review, 12, 130,', 59.2, 570, 158),
      row('35, doi: 10.0000/example-a', 59.2, 553, 152),
      row('Cove, P. 2018, Journal of Methods', 50, 531, 228),
      row(tail, 59.2, 514, 145),
      row('Hale, J., Rowan, M., Wells, P., &', 50, 492, 220),
      row('Vale, R. 2016, Test Reports, 6, 14–19,', 59.2, 475, 195),
      row(closed ? 'doi: 10.0000/example-c' : 'A free-standing note.', 59.2, 458, 115),
      row('Stone, J., Vale, G., et al. 2021, Journal of Examples, 5,', 320, 587, 230),
      row('32, doi: 10.0000/example-d', 329.2, 573, 142),
      row('Zale, S., Burke, H., & Cora, D. 2006, Review Series, 3,', 320, 559, 228),
      row('40, doi: 10.0000/example-e', 329.2, 545, 136)
    ]
    const pages = [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    const { units } = groupPdfTranslationPages({ pages, pageCount: 1 })
    const owner = units.find((unit) => unit.items.includes('1:7'))
    expect(owner?.source).toBe(tail)
    expect(owner?.sourceOnly === true && owner.preserve === 'reference').toBe(closed)
  }
)
const deferredFigureKinds = [
  'complete',
  'different chart label',
  'missing DOI rail',
  'ticks',
  'ticks changed value',
  'ticks shifted panel',
  'ticks missing DOI rail'
]

test.each(deferredFigureKinds)(
  'keeps a deferred full-width figure caption between bibliography pages eligible: %s',
  (kind) => {
    const numeric = kind.startsWith('ticks')
    const heading = { ...item('REFERENCES', 600, 10, 'Section', 267), width: 66 }
    const records = (x: number, y: number): PdfLayoutTextItem[] =>
      ['Author', 'Editor', 'Writer'].flatMap((name, index) => [
        item(`${name}, A. 2021. Measurement notes.`, y + index * 26, 9, 'Body', x),
        item(
          kind.endsWith('missing DOI rail') && x === 320 && y === gutter
            ? 'Journal 28, 193.'
            : 'Journal 28, 193, doi: 10.9999/sample',
          y + index * 26 + 13,
          9,
          'Body',
          x + 9
        )
      ])
    const textLabels = [90, 240, 390].flatMap((x, index) => [
      item('Control', 353, 10, 'Legend', x),
      item(
        index === 2 && kind === 'different chart label' ? 'Derived' : 'Measured',
        353,
        10,
        'Legend',
        x + 54
      )
    ])
    const ticks = [115, 255, 395].flatMap((x, panel) =>
      ['80', '40', '0', '40', '80'].map((value, tick) => ({
        ...item(
          panel === 2 && tick === 4 && kind === 'ticks changed value' ? '90' : value,
          panel ? 370 : 371,
          7,
          'Axis',
          x + tick * 20 + (panel === 2 && kind === 'ticks shifted panel' ? 4 : 0)
        ),
        hasEOL: false
      }))
    )
    const chart = numeric ? ticks : textLabels
    const gutter = numeric ? 440 : 451
    const caption = [
      { ...item('Figure 1.', 410, 9, 'Label'), hasEOL: false, width: 40 },
      {
        ...item(
          'The curves illustrate the predicted values across the three observation groups under fixed operating conditions.',
          410,
          9,
          'Body',
          105
        ),
        width: 435
      },
      {
        ...item(
          'Shaded areas show the uncertainty while the independent measurements are marked with circles for clarity.',
          421,
          9,
          'Body'
        ),
        width: 480
      },
      item('All quantities are expressed in the same units.', 432, 9, 'Body')
    ]
    if (numeric) caption.pop()
    const pages = [
      [
        item('An independent body paragraph provides background and experimental context.', 520),
        heading,
        ...records(60, 620),
        ...records(320, 620)
      ],
      [...chart, ...caption, ...records(60, gutter), ...records(320, gutter)]
    ].map((items, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items: items.map((text) => ({
        ...text,
        fontVertical: text.fontName === 'Axis' ? undefined : false
      }))
    }))
    const result = groupPdfTranslationPages({ pages, pageCount: pages.length })
    const owner = result.units.find((unit) => unit.source.startsWith('Figure 1.'))
    expect(owner?.items).toEqual(caption.map((_, index) => `2:${index + chart.length}`))
    expect(!!owner?.sourceOnly).toBe(kind !== 'complete' && kind !== 'ticks')
    const sourceOnly = new Set(
      result.units.filter((unit) => unit.sourceOnly).flatMap((unit) => unit.items)
    )
    expect(
      pages[1].items
        .slice(chart.length + caption.length)
        .every((_, index) => sourceOnly.has(`2:${index + chart.length + caption.length}`))
    ).toBe(true)
  }
)

test.each([0, 4])(
  'preserves a publication locator on its bibliography rail (shift %i)',
  (shift) => {
    const native = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL: boolean,
      size = 9,
      fontName = 'Body'
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: size,
      dir: 'ltr',
      hasEOL,
      fontName,
      fontVertical: false,
      fontAscent: 0.75,
      fontDescent: -0.25,
      transform: [size, 0, 0, size, x, y]
    })
    const rows = [
      native(
        'The experiments in this study compare independent models for several measured systems.',
        72,
        514,
        464,
        true,
        11
      ),
      native('References', 274, 430, 64, false, 11, 'Heading'),
      native(
        '[Bel22] A. Bell, An early study of numerical forms, Sample Press, 2022.',
        71,
        413,
        333,
        true
      ),
      native('[Nor23]', 71, 402, 29, false),
      native(
        'F. North, A study of independent sequences and their variances, Notes in Research 15',
        107,
        402,
        372,
        false
      ),
      native('(2023), no. 2,', 479, 402, 55, true),
      native('Paper No. e13750, 14.', 107 + shift, 391, 89, true),
      native(
        '[Ree24] L. Reed, Revisiting closed forms in numerical examples, Sample Press, 2024.',
        71,
        380,
        386,
        true
      ),
      native('[Sno25] R. Snow, Notes on counting, Sample Press, 2025.', 71, 369, 338, true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items: rows }]
    })
    const locator = units.find((unit) => unit.items.includes('1:6'))
    expect(locator?.source).toBe(rows[6].str)
    expect(locator?.preserve).toBe(shift === 0 ? 'reference' : undefined)
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(rows.map((_, n) => `1:${n}`).sort())
  }
)

test.each([false, true])(
  'protects the last two numbered references above a figure caption (gap=%s)',
  (gap) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = true
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: str.trim() ? 9 : 0,
      dir: 'ltr',
      fontName: 'Bibliography',
      hasEOL,
      fontAscent: 0.75,
      fontDescent: -0.22,
      fontVertical: false,
      transform: [9, 0, 0, 9, x, y]
    })
    const record = (n: number, x: number, y: number, right = false): PdfLayoutTextItem[] => {
      const labelWidth = n > 9 ? 12 : 7
      return [
        item('', x, y, 0),
        item(`${n}.`, x, y, labelWidth, false),
        item(' ', x + labelWidth, y, 18 - labelWidth, false),
        item(
          right
            ? 'A. Reader, B. Author, and C. Writer, Sample Review'
            : `A. Reader, B. Author, and C. Writer, J. Field Stud. 12, ${n + 6} (2008).`,
          x + 18,
          y,
          229,
          right
        ),
        ...(right ? [item(`11, ${20 + n} (2009).`, x + 18, y - 11, 65, false)] : [])
      ]
    }
    const prefix = [
      item('The observations were repeated using a second instrument.', 50, 208, 235),
      item('', 50, 188, 0),
      item('References', 50, 188, 45, false),
      ...Array.from({ length: 9 }, (_, i) => record(i + 1, 50, 171 - 11 * i)).flat()
    ]
    const start = prefix.length
    const items = [
      ...prefix,
      ...record(gap ? 11 : 10, 315, 729, true),
      ...record(gap ? 12 : 11, 315, 707, true),
      item('', 324, 679, 0),
      item('Fig. 1. A comparison of the responses observed before', 324, 679, 237),
      item('and after adjusting the sample.', 315, 668, 151, false)
    ]
    const { units } = groupPdfTranslationPages({
      pageCount: 1,
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const owner = (index: number): (typeof units)[number] | undefined =>
      units.find((unit) => unit.items.includes(`1:${index}`))
    expect(owner(2)?.preserve).toBe('reference')
    expect(owner(start + 3)?.preserve).toBe(gap ? undefined : 'reference')
    expect(owner(start + 4)?.preserve).toBe(gap ? 'formula' : 'reference')
    expect(owner(start + 8)?.preserve).toBe(gap ? undefined : 'reference')
    expect(owner(start + 11)?.sourceOnly).toBeUndefined()
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.flatMap((entry, index) => (entry.str.trim() ? [`1:${index}`] : [])).sort()
    )
  }
)

test.each(['closed', 'prose', 'unmarked overlap'] as const)(
  'protects complete author-date references on an inset final right column (%s)',
  (kind) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      options: { font?: string; size?: number; eol?: boolean } = {}
    ): PdfLayoutTextItem => ({
      ...item(str, 800 - y, options.size ?? 10, options.font ?? 'Body', x),
      width,
      hasEOL: options.eol ?? true,
      fontVertical: false
    })
    const items = [
      row('The report concludes with a discussion of measurement reliability.', 48, 300, 235),
      row('References', 48, 120, 58, { font: 'Heading', size: 12 }),
      row('Aster J., 2019, Test Reports, 2, 7', 48, 97, 150),
      row('Brook P., 2020, Field Notes, 18, 22', 48, 85, 150),
      row('Cloud R., 2021, in Methods for Comparing Samples,', 48, 73, 235),
      row('Volume 4, pp. 20–28', 58, 61, 93),
      row('Fern L., 2020, Field Notes, 7, 13', 297, 300, 145),
      row(kind === 'unmarked overlap' ? 'Gale H., Mor' : 'Gale H., Mor`', 297, 288, 55, {
        eol: false
      }),
      row('es J., Wells F.,', 348, 288, 58),
      row('Lane M., 2022, Test Reports, 4, 31', 307, 276, 149),
      row('Lake S., 2023, Lab Notes, 5, 10', 297, 264, 145),
      row(
        kind === 'prose'
          ? 'This text continues the discussion.'
          : 'Reed K., 2024, Lab Notes, 6, A2',
        297,
        252,
        147,
        { eol: false }
      ),
      row('Printed locally', 48, 13, 43, { font: 'Footer', size: 6, eol: false })
    ]
    const pages = [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    const { units } = groupPdfTranslationPages({ pages, pageCount: 1 })
    for (let i = 6; i <= 11; i++) {
      const owner = units.find((unit) => unit.items.includes(`1:${i}`))
      expect(owner?.sourceOnly === true && owner.preserve === 'reference').toBe(kind === 'closed')
    }
  }
)

test.each(['closed', 'unfinished record', 'unrelated ending'])(
  'keeps all terminal author-date records before a separate typesetting note (%s)',
  (shape) => {
    const rows = [
      item('An independent discussion of the measurements ends here.', 465),
      item('REFERENCES', 660, 9, 'Heading'),
      ...['Amber', 'Bass', 'Cedar', 'Dune', 'Elm', 'Fern'].map((name, i) =>
        item(`${name} A., 2020, Field Notes, 5, ${i + 1}`, 676 + i * 10, 8)
      ),
      item('Gale A., River N., 2021, Field Notes, 12,', 68, 8, 'Body', 307),
      item('18', 78, 8, 'Body', 321),
      item('Hay B., Editor A., 2021, Lab Reports, 7, A13', 88, 8, 'Body', 307),
      item('Iris D., 2022, Lab Reports, 12, 9', 98, 8, 'Body', 307),
      item('June K., Hill L., 2023, Journal of Sampled', 108, 8, 'Body', 307),
      item(
        shape === 'unfinished record' ? 'Panels and their uses' : 'Panels, 14, 92',
        118,
        8,
        'Body',
        321
      ),
      item(
        shape === 'unrelated ending'
          ? 'Further observations are discussed elsewhere.'
          : 'This paper was typeset from materials supplied by the author.',
        144,
        8,
        'Body',
        307
      )
    ]
    for (const row of rows) row.fontVertical = false
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 800, rotation: 0, items: rows }],
      pageCount: 1
    })
    for (const index of [8, 10, 11, 12, 13]) {
      const owner = units.find((unit) => unit.items.includes(`1:${index}`))
      expect(owner).toBeDefined()
      expect(owner?.sourceOnly === true && owner.preserve === 'reference').toBe(shape === 'closed')
    }
    const colophon = units.find((unit) => unit.items.includes('1:14'))
    expect(colophon?.source).toBe(rows[14].str)
    expect(colophon?.sourceOnly).toBeUndefined()
  }
)

test.each(['overprint', 'shifted heading', 'missing number'])(
  'keeps a terminal bibliography with overprinted heading and volume glyphs (%s)',
  (shape) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      eol = true
    ): PdfLayoutTextItem => ({
      ...item(str, 800 - y, 10, 'Body', x),
      width,
      hasEOL: eol,
      fontVertical: false
    })
    const items = [
      row('The report closes with a separate conclusion.', 306, 240, 168),
      row('References', shape === 'shifted heading' ? 315 : 306.24, 210.24, 46, false),
      row('References', 306, 210, 46, false),
      row('References', 306.24, 210, 46, false),
      row('References', 306, 210.24, 46)
    ]
    for (const [i, volume] of ['12', '14', '19', '21'].entries()) {
      const y = 199.44 - i * 10.8
      const number = shape === 'missing number' && i === 2 ? 4 : i + 1
      items.push(
        row(`${number}.`, 316, y, 8, false),
        row(`A. Sample, Journal of Tests ${volume}`, 334, y, 140, false),
        row(volume, 464, y - 0.24, 10, false),
        row(volume, 464.24, y - 0.24, 10, false),
        row(`${volume}, 21–28 (2020).`, 464, y, 77)
      )
    }
    const pages = [{ page: 1, width: 600, height: 800, rotation: 0, items }]
    const { units } = groupPdfTranslationPages({ pages, pageCount: 1 })
    const citations = units.filter((unit) => unit.source.includes('Journal of Tests'))
    expect(citations).toHaveLength(4)
    expect(citations.every((unit) => unit.sourceOnly && unit.preserve === 'reference')).toBe(
      shape === 'overprint'
    )
    expect(
      units.find((unit) => unit.source.includes('separate conclusion'))?.sourceOnly
    ).toBeUndefined()
  }
)

test.each(['aligned', 'detached lane'] as const)(
  'preserves the opening reference read before a centered heading (%s)',
  (kind) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      size = 9,
      font = 'Reference',
      hasEOL = true
    ): PdfLayoutTextItem => ({
      ...item(str, 800 - y, size, font, x),
      width,
      hasEOL,
      fontVertical: false
    })
    const rightY = kind === 'detached lane' ? 131 : 136
    const items = [
      row(
        'We report the final calibration measurements of each panel before the bibliography.',
        50,
        212,
        502,
        10,
        'Body'
      ),
      row(
        'These tests agree with the previous estimates for samples in each independent setting.',
        50,
        200,
        476,
        10,
        'Body'
      ),
      row('REFERENCES', 272, 154, 68, 10, 'Heading'),
      row('Veleˇ', 50, 136, 25, 9, 'Reference', false),
      row('rin, E., & West, D. 2019, Test Reports, 3, 74', 71, 136, 150),
      row('Hale, C., & Miller, R. 2020,', 320, rightY, 151),
      row('Field Notes, 4, 55', 329, rightY - 16, 93),
      row('Meyer, J., Fellow, G., & Vale, R.', 320, 97, 166),
      row('2021, Lab Reports, 8, 16', 329, 81, 104)
    ]
    const pages = [
      { page: 1, width: 612, height: 792, rotation: 0, items },
      {
        page: 2,
        width: 612,
        height: 792,
        rotation: 0,
        items: [row('Smith, D. 2022, Archive, 8, 55', 50, 700, 122)]
      }
    ]
    const { units } = groupPdfTranslationPages({ pages, pageCount: 2 })
    const owner = units.find((unit) => unit.items.includes('1:3'))
    expect(owner?.sourceOnly === true && owner.preserve === 'reference').toBe(kind === 'aligned')
  }
)

test.each(['catalog locator', 'volume and locator', 'shifted', 'skipped number'])(
  'retains a Math Reviews locator on a witnessed reference continuation (%s)',
  (shape) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Reference',
      hasEOL = true
    ): PdfLayoutTextItem => ({
      ...item(str, y, 10, fontName, x),
      width,
      hasEOL,
      fontVertical: false
    })
    const splitVolume = shape === 'volume and locator'
    const runs = [
      row('References', 272, 126, 56, 'Title'),
      row('1. A. Reader,', 65, 150, 64, 'Reference', false),
      row('An independent study of local systems', 132, 150, 164, 'Article', false),
      row(
        splitVolume ? ', Journal of Methods' : ', Journal of Methods 22 (1997), 4–31.',
        296,
        150,
        243
      ),
      ...(splitVolume ? [row('14', 77.5, 162, 10, 'Volume', false)] : []),
      row(
        splitVolume ? '(1999), no. 4, 12–33. MR 0000000' : 'MR 0000000',
        shape === 'shifted' ? 72 : splitVolume ? 90 : 77.5,
        162,
        172
      ),
      row(
        shape === 'skipped number' ? '3. B. Writer,' : '2. B. Writer,',
        65,
        174,
        64,
        'Reference',
        false
      ),
      row('A different example', 132, 174, 101, 'Article', false),
      row(', Journal of Examples 39 (1998), 5–90.', 233, 174, 150),
      row('4. C. Editor, Subsequent work. Journal of Research 2 (2001), 8–31.', 65, 186, 350)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 800, rotation: 0, items: runs }],
      pageCount: 1
    })
    const tailIndex = runs.findIndex((run) => run.str.endsWith('MR 0000000'))
    const owner = units.find((unit) => unit.items.includes(`1:${tailIndex}`))
    expect(owner?.source.endsWith('MR 0000000')).toBe(true)
    expect(owner?.items).not.toContain(`1:${tailIndex + 1}`)
    expect(owner?.sourceOnly === true && owner.preserve === 'reference').toBe(
      shape === 'catalog locator' || splitVolume
    )
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      runs.map((_, index) => `1:${index}`).sort()
    )
  }
)

test.each(['aligned', 'different year', 'detached row'] as const)(
  'retains a hanging publication locator in the left reference column (%s)',
  (shape) => {
    const body =
      'The measurements were recorded under identical conditions and assessed independently.'
    const year = shape === 'different year' ? 2021 : 2020
    const items = [
      { ...item(body, 570, 10, 'Body', 50), width: 488 },
      { ...item('REFERENCES', 638, 10, 'Body', 273), width: 66 },
      {
        ...item('Reed A., Vale B., and Moss C. 2020, Regional Survey', 656, 9, 'Citation', 50),
        width: 241
      },
      {
        ...item(
          `Field Circulars, ${year}-A25`,
          shape === 'detached row' ? 680 : 669,
          9,
          'Citation',
          59
        ),
        width: 115
      },
      { ...item('Quill, D. E. 2019, Field Reports, 4, 12', 656, 9, 'Citation', 320), width: 180 }
    ].map((line) => ({ ...line, fontVertical: false }))
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 800, rotation: 0, items }],
      pageCount: 1
    })
    const owners = units.filter((unit) => unit.items.includes('1:3'))
    expect(owners).toHaveLength(1)
    expect(owners[0].preserve).toBe(shape === 'aligned' ? 'reference' : undefined)
    expect(owners[0].sourceOnly).toBe(shape === 'aligned' ? true : undefined)
    expect(owners[0].source).toBe(items[3].str)
    expect(units.find((unit) => unit.source === body)?.sourceOnly).toBeUndefined()
  }
)

test.each(['closed lanes', 'ordinary last row', 'misaligned columns'] as const)(
  'keeps the complete hanging citations below a shared reference heading (%s)',
  (shape) => {
    const body = 'The instruments were calibrated independently before the survey began.'
    const lane = (x: number, y: number, records: string[][]): PdfLayoutTextItem[] =>
      records.flat().map((text, row) => ({
        ...item(text, y + row * 13, 10, 'Citation', x + (row % 3 ? 10 : 0)),
        width: row % 3 ? 150 : x < 306 ? [197, 155, 199][row / 3] : 181
      }))
    const items = [
      { ...item(body, 488, 12, 'Body', 90), width: 432 },
      { ...item('REFERENCES', 524, 12, 'Body', 266), width: 80 },
      ...lane(90, 545, [
        ['Moss, B., Vale, R., & Quill, J.', '2021, Field Letters, 5,', 'doi: 10.9999/field-a'],
        ['Page, S., Glen, T., & Reed, D.', '2020, Survey Notes, 2,', 'doi: 10.9999/field-b'],
        ['Rowe, A., Dale, C., & West, K.', '2022, Survey Almanac, 1,', 'doi: 2022/31']
      ]),
      ...lane(320, shape === 'misaligned columns' ? 563 : 545, [
        ['Vale, R., Moss, B., & Dale, C.', '2020, Field Letters, 2,', 'doi: 10.9999/field-c'],
        ['West, K., Reed, D., & Glen, T.', '2021, Survey Notes, 5,', 'doi: 10.9999/field-d'],
        [
          'York, N., Rowe, A., & Lane, M.',
          '2023, Land Reports, 7,',
          shape === 'ordinary last row' ? 'The calibration was checked.' : 'doi: 10.9999/field-e'
        ]
      ])
    ]
    for (const line of items) line.fontVertical = false
    const { units } = groupPdfTranslationPages({
      pages: [
        { page: 1, width: 612, height: 800, rotation: 0, items },
        { page: 2, width: 612, height: 800, rotation: 0, items: [] }
      ],
      pageCount: 2
    })
    expect(units.find((unit) => unit.source === body)?.sourceOnly).toBeUndefined()
    const owners = units.filter((unit) =>
      unit.items.some(
        (key) =>
          key.startsWith('1:') && Number(key.split(':')[1]) >= 2 && Number(key.split(':')[1]) <= 10
      )
    )
    expect(owners.flatMap((unit) => unit.items).sort()).toEqual(
      items
        .slice(2, 11)
        .map((_, index) => `1:${index + 2}`)
        .sort()
    )
    expect(owners.every((unit) => unit.sourceOnly && unit.preserve === 'reference')).toBe(
      shape === 'closed lanes'
    )
  }
)

test.each(['aligned', 'shifted peer'] as const)(
  'retains a hanging journal row only when both reference columns agree (%s)',
  (shape) => {
    const body = 'The measurements were recorded independently under identical conditions.'
    const items = [
      { ...item(body, 580, 10, 'Body', 50), width: 482 },
      { ...item('REFERENCES', 662, 10, 'Body', 273), width: 66 },
      { ...item('Reed, A. B., Vale, F., et al. 2020, The', 680, 9, 'Citation', 50), width: 237 },
      { ...item('Journal of Regional Measurement, 18, 25', 704, 9, 'Citation', 59), width: 191 },
      { ...item('Quill, D. E., Moss, C., et al. 2019, The', 680, 9, 'Citation', 321), width: 230 },
      {
        ...item(
          'Review of Field Methods, 6, 14',
          704,
          9,
          'Citation',
          shape === 'aligned' ? 330 : 335
        ),
        width: 175
      }
    ].map((run) => ({ ...run, fontVertical: false }))
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 800, rotation: 0, items }],
      pageCount: 1
    })
    const owners = units.filter((unit) => unit.items.includes('1:3'))
    expect(owners).toHaveLength(1)
    expect(owners[0].source).toBe(items[3].str)
    expect(owners[0].preserve).toBe(shape === 'aligned' ? 'reference' : undefined)
    expect(units.find((unit) => unit.source === body)?.sourceOnly).toBeUndefined()
  }
)

test.each([0, 8])('keeps a reference continuation on its native hanging rail (%s)', (shift) => {
  const body = 'The discussion preceding the bibliography explains the measurement procedure.'
  const tail = 'press).'
  const items = [
    { ...item(body, 100, 12, 'Body', 72), width: 430 },
    { ...item('References', 250, 12, 'Heading', 271), width: 70 },
    item('1. A. Reed, Window measurements, Field Notes 12 (2020), 7–15.', 269, 10, 'Body', 77),
    item('2. B. Moss, Seasonal intervals, Survey Letters 5 (2019), 2–8.', 281, 10, 'Body', 77),
    item('3. C. Dale, Adjustment factors, Methods Circular (in', 293, 10, 'Body', 77),
    item(tail, 305, 10, 'Body', 90 + shift),
    item('4. D. Vale, Baseline variance, Reports 9 (2021), 23–27.', 317, 10, 'Body', 77),
    item('5. E. Cole, Range estimates, Annual Review 3 (2018), 8–16.', 329, 10, 'Body', 77),
    item('The next section discusses a distinct calibration method.', 381, 12, 'Body', 72)
  ].map((run) => ({ ...run, fontVertical: false }))
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 800, rotation: 0, items }],
    pageCount: 1
  })
  const owners = units.filter((unit) => unit.items.includes('1:5'))
  expect(owners).toHaveLength(1)
  expect(owners[0].source).toBe(tail)
  expect(owners[0].preserve).toBe(shift === 0 ? 'reference' : undefined)
  expect(owners[0].sourceOnly).toBe(shift === 0 ? true : undefined)
  expect(units.find((unit) => unit.source === body)?.sourceOnly).toBeUndefined()
})

test.each(['complete', 'missing-ordinal', 'wrong-date', 'off-lane'])(
  'retains only proved native split bracketed reference continuations (%s)',
  (fault) => {
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      height = 8,
      hasEOL = true
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      fontName,
      hasEOL,
      dir: 'ltr',
      fontAscent: 0.75,
      fontDescent: -0.24,
      fontVertical: false,
      transform: [height, 0, 0, height, x, y]
    })
    const prose = 'Earlier ordinary text explains the complete method and records the conditions.',
      items = [
        run(prose, 52, 310, 248, 'Body', 10),
        run('R', 148, 161, 7, 'Body', 10, false),
        run('EFERENCES', 155.5, 161, 48)
      ],
      tail = 'Writer, “A publication with a complicated packet of native runs,”'
    const record = (n: number, x: number, y: number, split = false): PdfLayoutTextItem[] => [
      run(`[${n}]`, x, y, 10, 'Body', 8, false),
      ...(split
        ? [run('A.', x + 15, y, 7, 'Body', 8, false), run(tail, x + 23, y, 200)]
        : [run('A. Writer, “A publication with a complete analytical account,”', x + 15, y, 218)]),
      run('published in a journal documenting a reproducible sample,', x + 15, y - 9, 219),
      run('Journal of Synthetic Examples', x + 15, y - 18, 117, 'Italic', 8, false),
      run(', 2024.', x + 132, y - 18, 27)
    ]
    for (let n = 1; n <= 3; n++) items.push(...record(n, 52, 145 - (n - 1) * 27))
    for (let n = 4; n <= 6; n++) items.push(...record(n, 316, 732 - (n - 4) * 27, n === 4))
    const lastMarker = items.find((entry) => entry.str === '[6]')!
    if (fault === 'missing-ordinal') lastMarker.str = '[5]'
    if (fault === 'wrong-date') items.at(-1)!.str = 'Final note.'
    if (fault === 'off-lane') lastMarker.transform[4] += 2

    const { units } = groupPdfTranslationPages({
      pageCount: 1,
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const continuation = units.find((unit) => unit.source.startsWith(tail))
    expect(continuation).toBeDefined()
    expect(continuation?.preserve === 'reference').toBe(fault === 'complete')
    expect(continuation?.sourceOnly === true).toBe(fault === 'complete')
    expect(units.find((unit) => unit.source === prose)?.sourceOnly).toBeUndefined()
  }
)

test.each(['complete', 'shifted tail', 'foreign row', 'missing ordinal'] as const)(
  'retains an opposite-column bracketed bibliography with printed publication years (%s)',
  (variant) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Reference',
      em = 7,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      ...item(str, y, em, fontName, x),
      width,
      hasEOL,
      fontVertical: false
    })
    const items = [
      row('Proceedings of the Annual Symposium', 395, 68, 158, 'Running'),
      row(
        'The complete ordinary discussion precedes the acknowledgements.',
        54,
        115,
        239,
        'Body',
        9,
        true
      ),
      row('References', 54, 220, 60, 'Heading', 11, true)
    ]
    const complete = (n: number, x: number, y: number): PdfLayoutTextItem => {
      const right = x > 300
      const title = `${String.fromCharCode(64 + n)}. Editor. 202${n}. Research methods and their applications.`
      const author = row(
        right ? `[${n}] ${title}` : title,
        right ? x : x + 12,
        y,
        right ? 235 : 223,
        'Reference',
        7,
        true
      )
      if (!right) items.push(row(`[${n}]`, x, y, 8))
      items.push(
        author,
        row(
          'International Studies Journal',
          x + 12 + (variant === 'shifted tail' && n === 6 ? 5 : 0),
          y + 8,
          100,
          'Italic'
        ),
        row(`13 (202${n}), 4–16.`, x + 116, y + 8, 60, 'Reference', 7, true)
      )
      return author
    }
    for (let n = 1; n <= 3; n++) complete(n, 57.5, 231 + (n - 1) * 16)
    const first = complete(variant === 'missing ordinal' ? 5 : 4, 321, 95)
    for (let n = 5; n <= 8; n++) complete(n, 321, 95 + (n - 4) * 16)
    if (variant === 'foreign row')
      items.splice(items.indexOf(first) + 3, 0, row('Separate ordinary text.', 337, 107, 157))
    const pages = [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    const { units } = groupPdfTranslationPages({ pages, pageCount: 1 })
    const owner = units.find((unit) => unit.items.includes(`1:${items.indexOf(first)}`))
    expect(owner?.source).toContain(first.str)
    expect(owner?.sourceOnly === true && owner?.preserve === 'reference').toBe(
      variant === 'complete'
    )
    expect(units.find(({ items: keys }) => keys.includes('1:0'))?.sourceOnly).toBeUndefined()
  }
)

test.each([false, true])(
  'retains a terminal book title across the bibliography gutter (%s)',
  (wrongFont) => {
    const row = (
      str: string,
      x: number,
      baseline: number,
      width: number,
      fontName = 'Body',
      hasEOL = true,
      size = 10
    ): PdfLayoutTextItem => ({
      ...item(str, 800 - baseline, size, fontName, x),
      width,
      hasEOL,
      fontVertical: false
    })
    const items = [
      row('M. Researcher', 56, 805, 60, 'Body', false),
      row('Notes on Experiments', 420, 805, 100),
      row('Several trials gave the same reading on the instrument.', 56, 768, 219),
      row('We review previous work after discussing our measurements.', 56, 756, 215),
      row('A final observation provides a useful comparison.', 56, 744, 200),
      row('References', 56, 423, 75, 'Heading', true, 14),
      row('[1]', 62, 403, 14, 'Body', false),
      row('B. Author, The design of recorded surveys.', 81, 403, 208),
      row('Methods and Results, 44 (2002), 21–25.', 81, 391, 190),
      row('[2]', 62, 140, 14, 'Body', false),
      row('C. Analyst, Records from the third observing set.', 81, 140, 208),
      row('The Journal of Research, 26 (2008), 78–98.', 81, 128, 205),
      row('[3]', 62, 84, 14, 'Body', false),
      row('D. Editor, Analysis of the historical sampling record', 81, 84, 208),
      row('and its comparison across instruments, in:', 81, 72, 155, 'Body', false),
      row('Practical', 241, 72, 47, 'Italic'),
      row(
        'Methods, Tools and Techniques for Exploratory',
        332,
        766,
        207,
        wrongFont ? 'Body' : 'Italic'
      ),
      row('Measurement: A Guide for Research Teams', 332, 754, 205, 'Italic'),
      row('and Their Assistants', 332, 742, 85, 'Italic', false),
      row(', N. Reader, E. Writer,', 417, 742, 120),
      row('B. Reviewer, Eds., Academic Press, 2020.', 332, 730, 200),
      row('1', 295, 43, 5.5, 'Body', false)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595.276, height: 841.89, rotation: 0, items }],
      pageCount: 1
    })
    const owner = units.find((u) => u.items.includes('1:16'))
    expect(owner?.items).toEqual(['1:16', '1:17', '1:18', '1:19', '1:20'])
    expect(owner?.preserve === 'reference' && owner?.sourceOnly === true).toBe(!wrongFont)
    expect(units.find((u) => u.items.includes('1:1'))?.sourceOnly).toBeUndefined()
  }
)

test.each(['complete', 'missing ordinal', 'misaligned row', 'wider overlap'])(
  'retains hanging rows of a centered bracket-numbered bibliography (%s)',
  (shape) => {
    const row = (
      str: string,
      y: number,
      x: number,
      width: number,
      face = 'Reference'
    ): PdfLayoutTextItem => ({
      ...item(str, y, 10, face, x),
      width,
      fontVertical: false
    })
    const heading = {
        ...item('References', 520, 12, 'Heading', 262.5),
        width: 70,
        fontVertical: false
      },
      prior = row(
        'The opening discussion is distinct from the citations and remains available to translate.',
        479,
        85,
        425,
        'Body'
      ),
      first = row('[1] A. Writer. A separate study of bounded structures. In', 539, 85, 425),
      book = row('A Collection of Methods', 551, 100.5, 210, 'Italic'),
      pages = row('pages 11–20. Example Press, 2018.', 563, 100.5, 288),
      second = row('[2] B. Author. A complete report on independent families,', 575, 85, 425),
      year = row('2021. Preprint,', 587, 100.5, 65),
      locator = row('Locator:0000.00000', 587, 169, 75),
      period = row('.', 587, shape === 'wider overlap' ? 243.1 : 243.43, 2.7),
      third = row('[3] C. Reader. Some examples of abstract systems.', 599, 85, 353),
      journal = row('J. Abstract Math.', 599, 441, 69, 'Italic'),
      series = row('Example Ser. (2)', 611, shape === 'misaligned row' ? 104 : 100.5, 67, 'Italic'),
      issue = row(', 12:311–318, 2016.', 611, series.transform[4] + 67, 82.7),
      last = row(
        shape === 'missing ordinal'
          ? '[5] D. Analyst. The number of small examples in a class.'
          : '[4] D. Analyst. The number of small examples in a class.',
        623,
        85,
        425
      )
    heading.hasEOL = false
    year.hasEOL = locator.hasEOL = third.hasEOL = series.hasEOL = false
    const items = [
        prior,
        heading,
        first,
        book,
        pages,
        second,
        year,
        locator,
        period,
        third,
        journal,
        series,
        issue,
        last
      ],
      page: PdfLayoutPage = { page: 1, width: 595, height: 842, rotation: 0, items },
      before = structuredClone(page)
    const { units } = groupPdfTranslationPages({ pages: [page], pageCount: 1 })
    for (const target of [locator, issue]) {
      const key = '1:' + items.indexOf(target)
      const owners = units.filter((unit) => unit.items.includes(key))
      expect(owners).toHaveLength(1)
      expect(owners[0].sourceOnly === true && owners[0].preserve === 'reference').toBe(
        shape === 'complete'
      )
    }
    expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).not.toBe(true)
    expect(page).toEqual(before)
  }
)

test.each([false, true])(
  'protects a wide hanging reference column with a closed publication locator (gap=%s)',
  (gap) => {
    const row = (
      text: string,
      x: number,
      y: number,
      width: number,
      face = 'Reference',
      em = 8
    ): PdfLayoutTextItem => ({
      ...item(text, 800 - y, em, face, x),
      width,
      fontAscent: 0.75,
      fontDescent: -0.24,
      fontVertical: false
    })
    const record = (
      number: number,
      x: number,
      y: number,
      closing: string,
      wrap: boolean
    ): PdfLayoutTextItem[] => [
      { ...row(`${number}.`, x, y, 6), hasEOL: false },
      row('A. Reader and T. Writer, A catalogue for sample readings,', x + 18.5, y, 221),
      row('an independent evaluation of the selected devices,', x + 18.5, y - 10.5, 201),
      ...(wrap
        ? [row('with documentation of the published observations,', x + 18.5, y - 21, 220)]
        : []),
      row(closing, x + 18.5, y - (wrap ? 31.5 : 21), 196)
    ]
    const left = Array.from({ length: 4 }, (_, n) =>
      record(n + 1, 42, 174 - n * 42, 'Journal of Samples 9, 50 (2021).', true)
    ).flat()
    const right = Array.from({ length: 6 }, (_, n) =>
      record(
        n + 5 + (gap && n > 0 ? 1 : 0),
        315,
        270 - n * 31.5,
        ['(Sample Press, 2022), pp. 3–8.', '(Archive Press, 2023), 2nd ed.'][n] ??
          'Journal of Methods 7, 42 (2020).',
        false
      )
    ).flat()
    const prose = row(
      'Ordinary experimental remarks precede the bibliography.',
      42,
      222,
      230,
      'Body',
      10
    )
    const items = [prose, row('REFERENCES', 42, 191, 61, 'Heading', 10), ...left, ...right]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 300, rotation: 0, items }],
      pageCount: 1
    })
    const owners = (runs: PdfLayoutTextItem[]): typeof units => {
      const keys = new Set(runs.map((run) => `1:${items.indexOf(run)}`))
      return units.filter((unit) => unit.items.some((key) => keys.has(key)))
    }
    expect(owners(left).every((unit) => unit.preserve === 'reference')).toBe(true)
    expect(owners(right.slice(0, 8)).every((unit) => unit.preserve === 'reference')).toBe(!gap)
    expect(owners([prose])[0].sourceOnly).toBeUndefined()
  }
)

test.each(['hanging citation', 'detached note', 'finished citation'] as const)(
  'uses the native author-date rows around a short tail below a centered bibliography (%s)',
  (shape) => {
    const row = (
      text: string,
      y: number,
      x: number,
      width: number,
      fontName = 'Entry'
    ): PdfLayoutTextItem => ({
      ...item(text, y, 12, fontName, x),
      width,
      hasEOL: false,
      fontVertical: false
    })
    const items = [
      row('REFERENCES', 84, 266, 80, 'Heading'),
      row('Moss, L. (2015). A publication with an extended title. The Review', 108, 72, 452),
      row('of Science, 16(1), 201-220.', 124, 108, 151),
      row(
        `Reed, A. R. (2017). Another entry with a long original title. Blue${shape === 'finished citation' ? '.' : ''}`,
        148,
        72,
        430
      ),
      row('Horizon.', shape === 'detached note' ? 174 : 164, 108, 42),
      row('Vale, E. (2018). Measurement and analysis in a field study. Applied', 188, 72, 455),
      row('research, 7(2), 155-170.', 204, 108, 104),
      row(
        'West, J. M. (2019). The effect of the reference data on other measurements.',
        228,
        72,
        460
      ),
      row('Journal of Research, 12(3), 21-37.', 244, 108, 211)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 800, rotation: 0, items }],
      pageCount: 1
    })
    expect(units.find((unit) => unit.items.includes('1:4'))).toMatchObject({ source: 'Horizon.' })
    expect(units.find((unit) => unit.items.includes('1:4'))?.sourceOnly === true).toBe(
      shape === 'hanging citation'
    )
    expect(units.find((unit) => unit.items.includes('1:6'))?.preserve).toBe('reference')
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.map((_, index) => `1:${index}`).sort()
    )
  }
)
