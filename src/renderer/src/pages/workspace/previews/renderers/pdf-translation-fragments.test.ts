import { expect, it } from 'vitest'
import { createPdfTranslationSource } from './pdf-translation'
import { pdfTranslationLayoutFragments } from './pdf-translation-fragments'

it.each([
  { text: 'Page 2 of 10', gap: 40, extra: 24 },
  { text: 'POD2', gap: 40, extra: 24 },
  { text: 'Length of PACU stay', gap: 20, extra: 18 },
  { text: 'Result', gap: 5, extra: 3 },
  { text: 'Result', gap: 0, extra: 0 },
  { text: '-5 (-8 to', gap: 5, extra: 3 },
  { text: '(12)', gap: 40, extra: 0 },
  { text: '0.05', gap: 40, extra: 0 }
])(
  'allocates short-line space with the same boundary rule: $text / $gap',
  ({ text, gap, extra }) => {
    const source = createPdfTranslationSource({
      resourceRequestKey: 'regions',
      fingerprint: 'regions',
      pages: [{ width: 600, height: 800 }],
      units: [
        {
          id: 'label',
          source: text,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 60 / 600, y: 80 / 800, width: 24 / 600, height: 12 / 800 },
              items: [{ index: 0, text }]
            }
          ]
        },
        {
          id: 'neighbor',
          source: '17.0',
          sourceOnly: true,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: (84 + gap) / 600, y: 80 / 800, width: 20 / 600, height: 12 / 800 },
              items: [{ index: 1, text: '17.0' }]
            }
          ]
        }
      ]
    })
    const before = JSON.stringify(source),
      prepared = pdfTranslationLayoutFragments(source.units[0], source)
    expect(prepared[0].rect.width * 600).toBeCloseTo(24 + extra)
    expect(prepared[0].rect.height * 800).toBeCloseTo(12 + (/[a-z]/iu.test(text) ? 0.25 : 0))
    expect(prepared[0].items).toEqual(source.units[0].fragments[0].items)
    expect(JSON.stringify(source)).toBe(before)
  }
)

it('stops at the page edge and keeps neighboring rows outside the borrowed area', () => {
  const source = createPdfTranslationSource({
    resourceRequestKey: 'edge',
    fingerprint: 'edge',
    pages: [{ width: 600, height: 800 }],
    units: [
      {
        id: 'label',
        source: 'Page 2',
        fragments: [
          {
            pageNumber: 1,
            rect: { x: 570 / 600, y: 80 / 800, width: 24 / 600, height: 12 / 800 },
            items: [{ index: 0, text: 'Page 2' }]
          }
        ]
      },
      {
        id: 'below',
        source: '18.0',
        sourceOnly: true,
        fragments: [
          {
            pageNumber: 1,
            rect: { x: 580 / 600, y: 100 / 800, width: 20 / 600, height: 12 / 800 },
            items: [{ index: 1, text: '18.0' }]
          }
        ]
      }
    ]
  })
  const rect = pdfTranslationLayoutFragments(source.units[0], source)[0].rect
  expect((rect.x + rect.width) * 600).toBeCloseTo(598)
  expect((rect.y + rect.height) * 800).toBeCloseTo(92.25)
})

it.each([0, 0.15, 0.3, 2.1, 3])(
  'bounds short-label native font margin by the next source row: %s pt',
  (gap) => {
    const source = createPdfTranslationSource({
      resourceRequestKey: 'font-margin',
      fingerprint: 'font-margin',
      pages: [{ width: 600, height: 800 }],
      units: ['Heading', '12'].map((text, index) => ({
        id: String(index),
        source: text,
        ...(index === 1 ? { sourceOnly: true as const } : {}),
        fragments: [
          {
            pageNumber: 1,
            rect: { x: 0.1, y: (80 + index * (12 + gap)) / 800, width: 0.1, height: 12 / 800 },
            items: [{ index, text }]
          }
        ]
      }))
    })
    const prepared = pdfTranslationLayoutFragments(source.units[0], source)[0]
    expect(prepared.rect.height * 800).toBeCloseTo(12 + Math.max(0, Math.min(0.25, gap - 2)))
    expect(prepared.rect.y).toBe(source.units[0].fragments[0].rect.y)
    expect(prepared.items).toEqual(source.units[0].fragments[0].items)
  }
)

it.each([
  { label: 'POD1', repeat: 'POD2', numeric: '17.0', extra: 12 },
  { label: 'T1', repeat: 'T2', numeric: '-2.5', extra: 12 },
  { label: 'POD', repeat: 'POD', numeric: '17.0', extra: 0.25 },
  { label: 'POD1', repeat: 'POD', numeric: '17.0', extra: 0.25 },
  { label: 'POD1', repeat: 'POD2', numeric: 'Mean', extra: 0.25 },
  { label: 'POD1', repeat: 'T2', numeric: '17.0', extra: 0.25 },
  { label: 'POD1', repeat: 'POD2', numeric: '17.0', intervening: true, extra: 1 }
])(
  'borrows a numbered table row only with column evidence: $label / $repeat / $numeric',
  (test) => {
    const source = createPdfTranslationSource({
      resourceRequestKey: 'numbered-row',
      fingerprint: 'numbered-row',
      pages: [{ width: 600, height: 800 }],
      units: [
        { id: 'label', text: test.label, x: 60, y: 80, width: 24 },
        { id: 'numeric', text: test.numeric, x: 120, y: 80, width: 20 },
        { id: 'repeat', text: test.repeat, x: 60, y: 116, width: 24 },
        ...(test.intervening ? [{ id: 'intervening', text: '1.0', x: 70, y: 95, width: 20 }] : [])
      ].map((unit, index) => ({
        id: unit.id,
        source: unit.text,
        fragments: [
          {
            pageNumber: 1,
            rect: { x: unit.x / 600, y: unit.y / 800, width: unit.width / 600, height: 12 / 800 },
            items: [{ index, text: unit.text }]
          }
        ]
      }))
    })
    const prepared = pdfTranslationLayoutFragments(source.units[0], source)[0]
    expect(prepared.rect.height * 800).toBeCloseTo(12 + test.extra)
    expect(prepared.items).toEqual(source.units[0].fragments[0].items)
  }
)

it.each([
  { text: 'Received: 12 January 2023 / Accepted: 2 June 2023', extra: 12 },
  { text: 'Submitted: 3 May 2022 / Published: 4 October 2023', extra: 12 },
  { text: 'Received: 12 January 2023 / Accepted: 2 June', extra: 0.25 },
  { text: '12 January 2023', extra: 0.25 },
  { text: 'Read Figure 2(a) for details', extra: 0.25 }
])('borrows a date field only when all fields are complete: $text', ({ text, extra }) => {
  const source = createPdfTranslationSource({
    resourceRequestKey: 'date-fields',
    fingerprint: 'date-fields',
    pages: [{ width: 600, height: 800 }],
    units: [
      {
        id: 'dates',
        source: text,
        fragments: [
          {
            pageNumber: 1,
            rect: { x: 60 / 600, y: 80 / 800, width: 180 / 600, height: 12 / 800 },
            items: [{ index: 0, text }]
          }
        ]
      }
    ]
  })
  expect(pdfTranslationLayoutFragments(source.units[0], source)[0].rect.height * 800).toBeCloseTo(
    12 + extra
  )
})

it.each([
  { start: 'Figure 1 shows', extra: 0 },
  { start: 'Fig. 1(a) illustrates', extra: 0 },
  { start: 'Figure 1: shows', extra: 24 },
  { start: 'Figure 1 Model architecture', extra: 24 }
])('only actual captions borrow figure-caption whitespace: $start', ({ start, extra }) => {
  const source = createPdfTranslationSource({
    resourceRequestKey: 'caption-boundary',
    fingerprint: 'caption-boundary',
    pages: [{ width: 600, height: 800 }],
    units: [
      {
        id: 'paragraph',
        source: `${start} the detailed measurements and the relationships between all included scientific variables`,
        fragments: [100, 111].map((y, index) => ({
          pageNumber: 1,
          rect: { x: 40 / 600, y: y / 800, width: 220 / 600, height: 10 / 800 },
          items: [
            {
              index,
              text: index
                ? 'all included scientific variables'
                : `${start} the detailed measurements`
            }
          ]
        }))
      }
    ]
  })
  const fragments = pdfTranslationLayoutFragments(source.units[0], source)
  expect(fragments).toHaveLength(1)
  expect(fragments[0].rect.height * 800).toBeCloseTo(21 + extra)
})

it.each([
  { start: 'Figure 1 shows', merged: false },
  { start: 'Figure 1: Measurements', merged: true }
])(
  'keeps a narrowed prose footprint separate from caption capacity: $start',
  ({ start, merged }) => {
    const source = createPdfTranslationSource({
      resourceRequestKey: 'caption-footprint',
      fingerprint: 'caption-footprint',
      pages: [{ width: 600, height: 800 }],
      units: [
        {
          id: 'paragraph',
          source: `${start} the detailed measurements and the relationships between all included scientific variables`,
          fragments: [100, 111].map((y, index) => ({
            pageNumber: 1,
            rect: { x: 40 / 600, y: y / 800, width: (index ? 110 : 220) / 600, height: 10 / 800 },
            items: [
              {
                index,
                text: index
                  ? 'all included scientific variables'
                  : `${start} the detailed measurements`
              }
            ]
          }))
        }
      ]
    })
    const fragments = pdfTranslationLayoutFragments(source.units[0], source)
    expect(fragments).toHaveLength(merged ? 1 : 2)
    if (merged) expect(fragments[0].rect.height * 800).toBeCloseTo(45)
    else {
      expect(fragments[0].rect.height * 800).toBeCloseTo(10)
      expect(fragments[1].rect.width * 600).toBeCloseTo(110)
    }
  }
)

it.each([
  { gap: 12, expected: 10 },
  { gap: 2, expected: 0 },
  { gap: 0, expected: 0 },
  { gap: 40, expected: 24 },
  { gap: 12, expected: 24, neighboringRow: true },
  { gap: 40, expected: 8, nearPageEdge: true },
  { gap: 12, expected: 0, singleItem: true },
  { gap: 12, expected: 0, incomplete: true },
  { gap: 12, expected: 0, missingUrl: true }
])('bounds wrapped URL prose by complete source and neighboring content: %j', (test) => {
  const text =
      'Additional documentation provides a detailed overview of every available method at ' +
      (test.missingUrl ? 'the documentation page' : 'https://example.org/reference/tutorial/') +
      (test.incomplete ? '' : '.'),
    x = test.nearPageEdge ? 390 : 40,
    source = createPdfTranslationSource({
      resourceRequestKey: 'wrapped-uri',
      fingerprint: 'wrapped-uri',
      pages: [{ width: 600, height: 800 }],
      units: [
        {
          id: 'paragraph',
          source: text,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: x / 600, y: 80 / 800, width: 200 / 600, height: 32 / 800 },
              items: test.singleItem
                ? [{ index: 0, text }]
                : [
                    { index: 0, text: text.slice(0, 60) },
                    { index: 1, text: text.slice(60) }
                  ]
            }
          ]
        },
        {
          id: 'native-neighbor',
          source: '42',
          sourceOnly: true,
          fragments: [
            {
              pageNumber: 1,
              rect: {
                x: (x + 200 + test.gap) / 600,
                y: (test.neighboringRow ? 120 : 80) / 800,
                width: 20 / 600,
                height: 12 / 800
              },
              items: [{ index: 2, text: '42' }]
            }
          ]
        }
      ]
    }),
    snapshot = JSON.stringify(source),
    [prepared] = pdfTranslationLayoutFragments(source.units[0], source)
  expect(prepared.rect.width * 600).toBeCloseTo(200 + test.expected)
  expect(prepared.rect.height * 800).toBeCloseTo(test.singleItem ? 56 : 32)
  expect(prepared.rect.x).toBe(source.units[0].fragments[0].rect.x)
  expect(prepared.rect.y).toBe(source.units[0].fragments[0].rect.y)
  expect(prepared.items).toEqual(source.units[0].fragments[0].items)
  expect(JSON.stringify(source)).toBe(snapshot)
})
