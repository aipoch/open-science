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
