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
