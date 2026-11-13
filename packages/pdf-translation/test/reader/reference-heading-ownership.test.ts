import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'
import { createPdfTranslationSource } from '../../src/reader/source.js'
import { applyPdfContentFirstPolicy } from '../../src/reader/content-policy.js'

function item(str: string, y: number, x = 60, size = 10, width = 240): PdfLayoutTextItem {
  return {
    str,
    width,
    height: size,
    dir: 'ltr',
    hasEOL: true,
    transform: [size, 0, 0, size, x, 800 - y],
    fontName: size < 8 ? 'Diagram' : size > 10 ? 'Heading' : 'Body',
    fontAscent: 0.8,
    fontDescent: -0.2,
    fontVertical: false
  }
}
function pages(label: string): PdfLayoutPage[] {
  return [
    {
      page: 1,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        item(
          'The complete ordinary explanation introduces several independent measurements and controls before the drawing.',
          100
        ),
        item(
          'A second ordinary paragraph describes the construction and reports all relevant experimental observations.',
          140
        ),
        item(label, 220, 455, 4.5, 28),
        item('Input samples', 200, 365, 4.5, 45),
        item('Output signals', 245, 455, 4.5, 45),
        item('Fig. 1. A diagram of the measurement system.', 300, 330, 9, 220),
        item(
          'This complete discussion after the drawing explains the measured behavior and remains ordinary scientific prose.',
          350
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
          'The next page continues the ordinary discussion with complete independent measurements and several useful controls.',
          100
        ),
        item(
          '1. Collect an independent measurement before comparing the complete experimental conditions and the control.',
          150
        ),
        item('References', 300, 60, 14, 110),
        item(
          '[1] A. Writer. Complete independent bibliographic entry. Journal 12, 1–8 (2020).',
          340,
          60,
          10,
          470
        ),
        item(
          '[2] B. Author. Another complete bibliographic entry. Journal 14, 5–9 (2021).',
          380,
          60,
          10,
          470
        )
      ]
    },
    {
      page: 3,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        item(
          '[3] C. Editor. A continued complete bibliographic entry. Journal 20, 2–7 (2022).',
          100,
          60,
          10,
          470
        )
      ]
    }
  ]
}

it.each(['References', 'Bibliography', 'Works Cited'])(
  'does not let a small native diagram label start a document-wide %s section',
  (label) => {
    const raw = pages(label),
      before = structuredClone(raw),
      layout = groupPdfTranslationPages({ pages: raw, pageCount: raw.length })
    for (const prefix of [
      'The complete ordinary',
      'A second ordinary',
      'This complete discussion',
      'The next page'
    ]) {
      const unit = layout.units.find((u) => u.source.startsWith(prefix))!
      expect(unit).toBeDefined()
      expect(unit.sourceOnly).not.toBe(true)
      expect(unit.preserve).not.toBe('reference')
    }
    const diagram = layout.units.find((u) => u.items.includes('1:2'))!
    expect(diagram.preserve).not.toBe('reference')
    expect(layout.units.find((u) => u.items.includes('2:1'))?.preserve).not.toBe('reference')
    const citations = layout.units.filter((u) => /^\[\d\]/u.test(u.source))
    expect(citations).toHaveLength(3)
    expect(citations.every((u) => u.sourceOnly && u.preserve === 'reference')).toBe(true)
    expect(layout.units.flatMap((u) => u.items).sort()).toEqual(
      raw.flatMap((p) => p.items.map((_, i) => `${p.page}:${i}`)).sort()
    )
    expect(raw).toEqual(before)
  }
)

it('carries native diagram ownership through content policy and a source copy without changing reference scope', () => {
  const raw = pages('References'),
    layout = groupPdfTranslationPages({ pages: raw, pageCount: raw.length })
  const source = createPdfTranslationSource({
    resourceRequestKey: 'native-label',
    fingerprint: 'native-label',
    pages: raw.map((p) => ({ width: p.width, height: p.height })),
    units: layout.units.map((u) => ({
      id: u.id,
      source: u.source,
      ...(u.figure ? { figure: true as const } : {}),
      ...(u.sourceOnly ? { sourceOnly: true as const } : {}),
      ...(u.preserve ? { preserve: u.preserve } : {}),
      fragments: u.fragments.map((f) => ({
        pageNumber: f.page,
        rect: {
          x: f.rect.x / 600,
          y: f.rect.y / 800,
          width: (f.rect.right - f.rect.x) / 600,
          height: (f.rect.bottom - f.rect.y) / 800
        },
        items: u.items
          .filter((k) => k.startsWith(f.page + ':'))
          .map((k) => ({
            index: Number(k.split(':')[1]),
            text: raw[f.page - 1].items[Number(k.split(':')[1])].str
          }))
      }))
    }))
  })
  const copied = createPdfTranslationSource(JSON.parse(JSON.stringify(source))),
    result = applyPdfContentFirstPolicy(copied)
  const label = result.units.find(
    (u) => u.source === 'References' && u.fragments[0].pageNumber === 1
  )!
  expect(label.figure).toBe(true)
  expect(label.sourceOnly).toBe(true)
  expect(label.preserve).toBeUndefined()
  for (const prefix of ['This complete discussion', 'The next page']) {
    const body = result.units.find((u) => u.source.startsWith(prefix))!
    expect(body.sourceOnly).not.toBe(true)
    expect(body.preserve).not.toBe('reference')
  }
  expect(
    result.units.filter((u) => /^\[\d\]/u.test(u.source)).every((u) => u.preserve === 'reference')
  ).toBe(true)
  expect(result.units.map((u) => [u.id, u.source, u.fragments])).toEqual(
    source.units.map((u) => [u.id, u.source, u.fragments])
  )
})

it.each([
  'missing caption',
  'missing peer',
  'different peer font',
  'unknown orientation',
  'nonfinite metric',
  'heading-sized'
])('keeps the reference policy conservative when diagram ownership lacks %s proof', (fault) => {
  const raw = pages('References')
  if (fault === 'missing caption') raw[0].items[5].str = 'Independent visual results.'
  if (fault === 'missing peer') raw[0].items[3].str = ''
  if (fault === 'different peer font') raw[0].items[3].fontName = 'Other'
  if (fault === 'unknown orientation') delete raw[0].items[2].fontVertical
  if (fault === 'nonfinite metric') raw[0].items[2].transform[4] = NaN
  if (fault === 'heading-sized') {
    const label = raw[0].items[2]
    label.height = 14
    label.transform[0] = label.transform[3] = 14
  }
  const result = groupPdfTranslationPages({ pages: raw, pageCount: raw.length }),
    label = result.units.find((u) => u.source === 'References' && u.fragments[0].page === 1)
  expect(label?.figure).not.toBe(true)
  if (fault !== 'nonfinite metric')
    expect(result.units.find((u) => u.source.startsWith('The next page'))?.sourceOnly).toBe(true)
})
