import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
// Minimized from clinical Table 1: the last predicted row ends above the
// source text centers, yet intersects their top edges. It contains no text.
const table = {
  id: 'last-row',
  cropRect: [0, 0, 300, 80],
  structure: {
    objects: [
      { label: 'table row', rect: [0, 0, 300, 20] },
      { label: 'table row', rect: [0, 30, 300, 42] },
      ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 80] }))
    ]
  }
}
const token = (
  text: string,
  x: number,
  y: number
): {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
} => ({
  text,
  rect: [x, y, x + 50, y + 12],
  baseline: y + 12,
  height: 12,
  horizontal: true
})
const first = [token('First', 5, 4), token('10', 105, 4), token('20', 205, 4)]
const last = [token('Last', 5, 38), token('30', 105, 38), token('40', 205, 38)]

it('recovers a merged count and percentage column from repeated headers and aligned records', () => {
  const source = {
    id: 'count-percent-columns',
    cropRect: [0, 0, 600, 150],
    structure: {
      objects: [
        ...[0, 100, 200, 300, 400].map((x) => ({
          label: 'table column',
          rect: [x, 0, x === 400 ? 600 : x + 100, 150]
        })),
        ...[0, 30, 60, 90, 120].map((y) => ({ label: 'table row', rect: [0, y, 600, y + 30] })),
        { label: 'table column header', rect: [0, 0, 600, 30] }
      ]
    }
  }
  const values = [
    ['Infection', 'Weekly', '16', '5', '3', '1'],
    ['Diarrhea', 'Weekly', '16', '5', '0', '0'],
    ['Neuropathy', 'Weekly', '84', '24', '1', '< 1'],
    ['Fatigue', 'Weekly', '20', '6', '1', '< 1']
  ]
  const headers = ['Toxicity', 'Treatment', 'No.', '%', 'No.', '%']
  const items = [headers, ...values].flatMap((row, r) =>
    row.map((text, c) => token(text, c * 100 + 20, r * 30 + 4))
  )
  const result = refineTable(source, items)
  expect(result.grid).toEqual([headers, ...values])
  expect(result.unassigned).toEqual([])
  expect(result.repairs).toContain('count-percent-column-recovered')
  // A pair of values alone does not establish separate columns.
  const withoutHeader = refineTable(
    source,
    items.filter((item) => item.baseline > 30)
  )
  expect(withoutHeader.grid[0]).toHaveLength(5)
  const incomplete = refineTable(
    source,
    items.filter((item) => !(item.text === '0' && item.rect[0] > 500))
  )
  expect(incomplete.grid[0]).toHaveLength(5)
})

it('keeps a recovered header separate from a data row with P-value columns', () => {
  const source = {
    id: 'p-value-header',
    cropRect: [0, 0, 400, 100],
    structure: {
      objects: [
        ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 30, x + 100, 100] })),
        ...[30, 60].map((y) => ({ label: 'table row', rect: [0, y, 400, y + 22] }))
      ]
    }
  }
  const items = [
    ...['Factor', 'DFS at 10 years', 'Univariate analysis', 'Multivariate analysis'].map((s, c) =>
      token(s, c * 100 + 5, 4)
    ),
    ...['Tumor size', '95.8%', 'P < 0.01', 'P = 0.228'].map((s, c) => token(s, c * 100 + 5, 34)),
    ...['Clinical appearance', '90.9%', 'P = ns'].map((s, c) => token(s, c * 100 + 5, 64))
  ]
  const result = refineTable(source, items, [
    { page: 1, lines: ['Table 7. Factors'], rect: [0, -20, 400, -5] }
  ])
  expect(result.grid).toEqual([
    ['Factor', 'DFS at 10 years', 'Univariate analysis', 'Multivariate analysis'],
    ['Tumor size', '95.8%', 'P < 0.01', 'P = 0.228'],
    ['Clinical appearance', '90.9%', 'P = ns', '']
  ])
  expect(result.unassigned).toEqual([])
  const wrapped = refineTable(
    source,
    [
      token('Group A', 105, 4),
      token('Group B', 205, 4),
      token('Group C', 305, 4),
      token('(without', 105, 32),
      token('positive MRI)', 105, 45),
      token('(with', 205, 32),
      token('positive MRI)', 205, 45),
      token('(MRI', 305, 32),
      token('negative)', 305, 45),
      token('n', 5, 64),
      token('12', 105, 64),
      token('93', 205, 64),
      token('72', 305, 64)
    ],
    [{ page: 1, lines: ['Table 4. Groups'], rect: [0, -20, 400, -5] }]
  )
  expect(wrapped.grid[0]).toEqual([
    '',
    'Group A (without positive MRI)',
    'Group B (with positive MRI)',
    'Group C (MRI negative)'
  ])
})

it('keeps wrapped text in recovered headers and records before the next supported row', () => {
  const source = {
    id: 'missing-wrapped-start',
    cropRect: [0, 0, 400, 160],
    structure: {
      objects: [
        ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 160] })),
        { label: 'table row', rect: [0, 110, 400, 140] }
      ]
    }
  }
  const items = [
    token('Type', 5, 4),
    token('Effects', 105, 4),
    token('Pathways affected by', 205, 4),
    token('References', 305, 4),
    token('Agent', 205, 18),
    token('Breast', 5, 42),
    token('Tumor reduction', 105, 42),
    token('Activation;', 205, 42),
    token('[65,66]', 305, 42),
    token('Cell proliferation', 105, 56),
    token('Reactive oxygen', 205, 56),
    token('inhibition', 105, 70),
    token('species activation', 205, 70),
    token('Colorectal', 5, 112),
    token('Tumor regression', 105, 112),
    token('Apoptosis', 205, 112),
    token('[67]', 305, 112)
  ]
  const result = refineTable(source, items)
  expect(result.grid).toEqual([
    ['Type', 'Effects', 'Pathways affected by Agent', 'References'],
    [
      'Breast',
      'Tumor reduction Cell proliferation inhibition',
      'Activation; Reactive oxygen species activation',
      '[65,66]'
    ],
    ['Colorectal', 'Tumor regression', 'Apoptosis', '[67]']
  ])
  expect(result.unassigned).toEqual([])
  // A gap or a new first-column label breaks continuation, even inside the crop.
  for (const extra of [token('Detached text', 205, 94), token('Another record', 5, 84)]) {
    expect(refineTable(source, [...items, extra]).unassigned).toContain(
      (extra as { text: string }).text
    )
  }
  // A final recovered record has no following boundary to separate notes.
  const final = refineTable({ ...source, cropRect: [0, 0, 400, 190] }, [
    ...items,
    token('Last', 5, 144),
    token('Value', 105, 144),
    token('Potential note', 105, 158)
  ])
  expect(final.grid.at(-1)?.[0]).toBe('Last')
  expect(final.unassigned).toContain('Potential note')
})

it('aligns an empty predicted row with overlapping multi-column source text without adding a row', () => {
  const result = refineTable(table, [...first, ...last])
  expect(result.grid).toEqual([
    ['First', '10', '20'],
    ['Last', '30', '40']
  ])
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
})

it('does not move an occupied row or absorb an isolated footnote', () => {
  const occupied = refineTable(table, [...first, token('Existing', 5, 29), ...last])
  expect(occupied.grid[1][0]).toBe('Existing')
  expect(occupied.unassigned).toEqual(['Last', '30', '40'])
  const note = refineTable(table, [...first, token('* A note', 5, 38)])
  expect(note.grid[1]).toEqual(['', '', ''])
  expect(note.unassigned).toEqual(['* A note'])
})

it('does not choose between two empty row bands intersecting the same source line', () => {
  const ambiguous = {
    ...table,
    structure: {
      objects: [...table.structure.objects, { label: 'table row', rect: [0, 50, 300, 62] }]
    }
  }
  const result = refineTable(ambiguous, [
    ...first,
    token('Last', 5, 40),
    token('30', 105, 40),
    token('40', 205, 40)
  ])
  expect(result.grid.slice(1)).toEqual([
    ['', '', ''],
    ['', '', '']
  ])
  expect(result.unassigned).toEqual(['Last', '30', '40'])
})

it('separates two complete numeric records captured by one shifted model row', () => {
  const shifted = {
    ...table,
    structure: {
      objects: [
        ...table.structure.objects.filter((o) => o.label !== 'table row'),
        { label: 'table row', rect: [0, 10, 300, 41] }
      ]
    }
  }
  const result = refineTable(shifted, [
    token('Group A', 5, 5),
    token('108 (86)', 105, 5),
    token('55 (89)', 205, 5),
    token('Group B', 5, 28),
    token('17 (14)', 105, 28),
    token('7 (11)', 205, 28)
  ])
  expect(result.grid).toEqual([
    ['Group A', '108 (86)', '55 (89)'],
    ['Group B', '17 (14)', '7 (11)']
  ])
  expect(result.unassigned).toEqual([])
})

it.each(['occupied-neighbor', 'overlapping-empty-bands'])(
  'recovers complete name/URL records despite %s',
  (mode) => {
    const source = {
      id: 'resource-links',
      cropRect: [0, 0, 200, 100],
      structure: {
        objects: [
          { label: 'table column', rect: [0, 0, 100, 100] },
          { label: 'table column', rect: [100, 0, 200, 100] },
          { label: 'table row', rect: [0, 0, 200, 20] },
          ...(mode === 'occupied-neighbor'
            ? [{ label: 'table row', rect: [0, 38, 200, 60] }]
            : [
                { label: 'table row', rect: [0, 30, 200, 50] },
                { label: 'table row', rect: [0, 42, 200, 62] }
              ]),
          { label: 'table row', rect: [0, 70, 200, 90] }
        ]
      }
    }
    const entries = [
      [token('First', 5, 4), token('https://first.test', 105, 4)],
      [
        token('Missing', 5, mode === 'occupied-neighbor' ? 30 : 40),
        token('https://missing.test', 105, mode === 'occupied-neighbor' ? 30 : 40)
      ],
      ...(mode === 'occupied-neighbor'
        ? [[token('Neighbor', 5, 46), token('https://neighbor.test', 105, 46)]]
        : []),
      [token('Last', 5, 74), token('https://last.test', 105, 74)]
    ]
    const result = refineTable(source, entries.flat())
    expect(result.grid).toEqual([
      ['First', 'https://first.test'],
      ['Missing', 'https://missing.test'],
      ...(mode === 'occupied-neighbor' ? [['Neighbor', 'https://neighbor.test']] : []),
      ['Last', 'https://last.test']
    ])
    expect(result.unassigned).toEqual([])
  }
)

it('does not rebuild a URL row across neighboring prose', () => {
  const source = {
    id: 'links-and-prose',
    cropRect: [0, 0, 200, 100],
    structure: {
      objects: [
        { label: 'table column', rect: [0, 0, 100, 100] },
        { label: 'table column', rect: [100, 0, 200, 100] },
        { label: 'table row', rect: [0, 0, 200, 20] },
        { label: 'table row', rect: [0, 38, 200, 64] },
        { label: 'table row', rect: [0, 70, 200, 90] }
      ]
    }
  }
  const result = refineTable(source, [
    token('First', 5, 4),
    token('https://first.test', 105, 4),
    token('Missing', 5, 30),
    token('https://missing.test', 105, 30),
    token('Description', 5, 46),
    token('Wrapped prose', 105, 46),
    token('Last', 5, 74),
    token('https://last.test', 105, 74)
  ])
  expect(result.grid[1]).toEqual(['Description', 'Wrapped prose'])
  expect(result.unassigned).toEqual(['Missing', 'https://missing.test'])
})

it.each(['plain', 'wrapped', 'list'])(
  'recovers top-aligned records with model names: %s',
  (mode) => {
    const wrapped = mode === 'wrapped'
    const model = (i: number): string =>
      i === 3 ? 'Other organism' : `Repeated organism${mode === 'list' && i >= 5 ? ',' : ''}`
    const entries = Array.from({ length: 7 }, (_, i) => [
      token(`Treatment ${i}`, 5, 30 + i * 40),
      token(wrapped ? (i === 3 ? 'Other' : 'Repeated') : model(i), 105, 30 + i * 40),
      ...(wrapped ? [token('organism', 105, 44 + i * 40), token('extract', 5, 44 + i * 40)] : []),
      ...(mode === 'list' && i >= 5 ? [token('Additional organism', 105, 44 + i * 40)] : []),
      token(`Outcome ${i}`, 205, 30 + i * 40),
      token(`(Author, 202${i})`, 305, 30 + i * 40),
      token(`tail ${i}`, 205, 44 + i * 40)
    ]).flat()
    const source = {
      id: 'wrapped-review',
      cropRect: [0, 0, 400, 310],
      structure: {
        objects: [
          ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 310] })),
          { label: 'table row', rect: [0, 0, 400, 20] },
          ...Array.from({ length: 7 }, (_, i) => ({
            label: 'table row',
            rect: [0, 40 + i * 35, 400, 80 + i * 35]
          }))
        ]
      }
    }
    const result = refineTable(source, [
      token('Treatment', 5, 4),
      token('Model', 105, 4),
      token('Outcome', 205, 4),
      token('References', 305, 4),
      ...entries
    ])
    expect(result.grid.slice(1)).toEqual(
      Array.from({ length: 7 }, (_, i) => [
        `Treatment ${i}${wrapped ? ' extract' : ''}`,
        `${model(i)}${mode === 'list' && i >= 5 ? ' Additional organism' : ''}`,
        `Outcome ${i} tail ${i}`,
        `(Author, 202${i})`
      ])
    )
    expect(result.unassigned).toEqual([])
  }
)

it('preserves centered row labels with description text above the label baseline', () => {
  const source = {
    id: 'centered-review',
    cropRect: [0, 0, 400, 450],
    structure: {
      objects: [
        ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 450] })),
        ...Array.from({ length: 7 }, (_, i) => ({
          label: 'table row',
          rect: [0, 8 + i * 60, 400, 65 + i * 60]
        }))
      ]
    }
  }
  const result = refineTable(
    source,
    Array.from({ length: 7 }, (_, i) => [
      token(`Treatment ${i}`, 5, 34 + i * 60),
      token('Repeated organism', 105, 34 + i * 60),
      token(`(Author, 202${i})`, 305, 34 + i * 60),
      token('Start', 205, 10 + i * 60),
      token('Middle', 205, 34 + i * 60),
      token('End', 205, 50 + i * 60)
    ]).flat()
  )
  expect(result.grid).toEqual(
    Array.from({ length: 7 }, (_, i) => [
      `Treatment ${i}`,
      'Repeated organism',
      'Start Middle End',
      `(Author, 202${i})`
    ])
  )
})

it('recovers a short continued table and preserves leading carry-over text separately', () => {
  const source = {
    id: 'short-continuation',
    cropRect: [0, 0, 400, 380],
    structure: {
      objects: [
        ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 380] })),
        { label: 'table row', rect: [0, 0, 400, 24] },
        ...Array.from({ length: 5 }, (_, i) => ({
          label: 'table row',
          rect: [0, 58 + i * 60, 400, 98 + i * 60]
        }))
      ]
    }
  }
  const entries = Array.from({ length: 5 }, (_, i) => [
    token(`Treatment ${i}`, 5, 80 + i * 60),
    token('DSS', 105, 80 + i * 60),
    token(`Effect ${i}`, 205, 80 + i * 60),
    token(`(Author, 202${i})`, 305, 80 + i * 60),
    token(`middle ${i}`, 205, 94 + i * 60),
    token(`tail ${i}`, 205, 108 + i * 60),
    token(`end ${i}`, 205, 122 + i * 60)
  ]).flat()
  const result = refineTable(
    source,
    [
      token('Product', 5, 4),
      token('Model', 105, 4),
      token('Effect', 205, 4),
      token('References', 305, 4),
      token('Prior record', 205, 32),
      token('continued here', 205, 46),
      ...entries
    ],
    [{ page: 1, lines: ['Table 6 (continued)'], rect: [0, -24, 390, -8] }]
  )
  expect(result.grid).toEqual([
    ['Product', 'Model', 'Effect', 'References'],
    ['', '', 'Prior record continued here', ''],
    ...Array.from({ length: 5 }, (_, i) => [
      `Treatment ${i}`,
      'DSS',
      `Effect ${i} middle ${i} tail ${i} end ${i}`,
      `(Author, 202${i})`
    ])
  ])
  expect(result.unassigned).toEqual([])
})

it.each(['References', '(Refs.)'])(
  'uses %s to recover wrapped records without a repeated model column',
  (referenceLabel) => {
    const source = {
      id: 'numbered-references',
      cropRect: [0, 0, 400, 400],
      structure: {
        objects: [
          ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 400] })),
          { label: 'table row', rect: [0, 0, 400, 24] },
          ...Array.from({ length: 6 }, (_, i) => ({
            label: 'table row',
            rect: [0, 38 + i * 60, 400, 68 + i * 60]
          }))
        ]
      }
    }
    const captions = [{ page: 1, lines: ['Table 1. Treatments'], rect: [0, -24, 390, -8] }]
    const items = [
      token('Agent', 5, 4),
      token('Mechanism', 105, 4),
      token('Toxicity', 205, 4),
      token(referenceLabel, 305, 4),
      ...Array.from({ length: 6 }, (_, i) => [
        token(`Agent ${i}`, 5, 40 + i * 60),
        token(`Mechanism ${i}`, 105, 40 + i * 60),
        token(`Toxicity ${i}`, 205, 40 + i * 60),
        token(
          referenceLabel === '(Refs.)' ? `(${i})` : i % 2 ? `[${i}, ${i + 1}]` : `[${i}–${i + 1}]`,
          305,
          40 + i * 60
        ),
        token('continued', 105, 56 + i * 60),
        token('final effect', 205, 72 + i * 60)
      ]).flat()
    ]
    const result = refineTable(source, items, captions)
    expect(result.grid).toEqual([
      ['Agent', 'Mechanism', 'Toxicity', referenceLabel],
      ...Array.from({ length: 6 }, (_, i) => [
        `Agent ${i}`,
        `Mechanism ${i} continued`,
        `Toxicity ${i} final effect`,
        referenceLabel === '(Refs.)' ? `(${i})` : i % 2 ? `[${i}, ${i + 1}]` : `[${i}–${i + 1}]`
      ])
    ])
    expect(result.unassigned).toEqual([])
    // Numeric measurements in a final column must not become citation anchors.
    expect(refineTable(source, items).repairs).not.toContain(
      'text-supported-wrapped-records-recovered'
    )
    const withoutHeader = items.filter((item: { text?: string }) => item.text !== referenceLabel)
    expect(refineTable(source, withoutHeader, captions).repairs).not.toContain(
      'text-supported-wrapped-records-recovered'
    )
  }
)

it('recovers dense one-line numeric records from shifted and overlapping row predictions', () => {
  const source = {
    cropRect: [0, 0, 300, 280],
    structure: {
      objects: [
        ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 280] })),
        ...Array.from({ length: 13 }, (_, i) => ({
          label: 'table row',
          rect: [0, i * 20 + 12, 300, i * 20 + 28]
        }))
      ]
    }
  }
  const items = [
    token('Variable', 5, 4),
    token('Group A', 105, 4),
    token('Group B', 205, 4),
    token('Section', 5, 24),
    ...Array.from({ length: 11 }, (_, i) => [
      token(String(i), 5, 44 + i * 20),
      token('33 (65)', 105, 44 + i * 20),
      token('36 (68)', 205, 44 + i * 20)
    ]).flat()
  ]
  const result = refineTable(source, items)
  expect(result.unassigned).toEqual([])
  expect(result.grid).toHaveLength(13)
  expect(result.grid[2]).toEqual(['0', '33 (65)', '36 (68)'])
  expect(result.grid[12]).toEqual(['10', '33 (65)', '36 (68)'])
  // A small raised footnote beside the stub is part of that record, not a
  // standalone section line that disables numeric row recovery.
  const marker = { text: 'a', rect: [56, 64, 60, 71], baseline: 71, height: 7, horizontal: true }
  const annotated = refineTable(source, [...items, marker])
  expect(annotated.unassigned).toEqual([])
  expect(annotated.grid).toHaveLength(13)
  expect(annotated.grid[3]).toEqual(['1a', '33 (65)', '36 (68)'])
  expect(
    annotated.cells.find((cell: { text: string }) => cell.text === '1a').textRuns
  ).toContainEqual(expect.objectContaining({ text: 'a', position: 'superscript' }))
  const missingValues = items.map((item) => ({
    ...item,
    text: item.text === '36 (68)' ? '/' : item.text
  }))
  const withSlashes = refineTable(source, missingValues)
  expect(withSlashes.unassigned).toEqual([])
  expect(withSlashes.grid[4]).toEqual(['2', '33 (65)', '/'])
  // Consecutive section lines may be one wrapped label. This numeric fallback
  // must not split that label merely because all other rows contain numbers.
  const wrappedSection = refineTable(source, [...items, token('section continuation', 5, 37)])
  expect(wrappedSection.repairs).not.toContain('text-supported-numeric-rows-recovered')
  // A value-only continuation must not be promoted to a fresh numeric record.
  const wrapped = refineTable(source, [...items, token('continued text', 105, 37)])
  expect(wrapped.repairs).not.toContain('text-supported-numeric-rows-recovered')
})

it('recovers a captioned ruled numeric table when the model predicts columns but no rows', () => {
  const raw = {
    cropRect: [0, 0, 400, 115],
    structure: {
      objects: [
        ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 115] })),
        { label: 'table column header', rect: [0, 5, 400, 30] }
      ]
    }
  }
  const source = [
    token('Suction drain', 105, 5),
    token('Corrugated', 205, 5),
    token('P-value', 305, 5),
    token('drain', 205, 18),
    ...['Volume', '516 (337)', '539 (326)', '0.946'].map((s, c) => token(s, c * 100 + 5, 40)),
    token('aspirated (mL)', 15, 54),
    ...['Aspirations', '5 (4)', '5.1 (4)', '0.836'].map((s, c) => token(s, c * 100 + 5, 72)),
    ...['Duration', '25.1 (18)', '22.6 (20)', '0.510'].map((s, c) => token(s, c * 100 + 5, 96))
  ]
  const captions = [{ page: 1, lines: ['Table 3. Comparison'], rect: [0, -25, 400, -10] }]
  const rules = [
    [0, 1, 400, 1],
    [0, 35, 400, 35],
    [0, 112, 400, 112]
  ]
  const result = refineTable(raw, source, captions, [], rules)
  expect(result.grid).toEqual([
    ['', 'Suction drain', 'Corrugated drain', 'P-value'],
    ['Volume aspirated (mL)', '516 (337)', '539 (326)', '0.946'],
    ['Aspirations', '5 (4)', '5.1 (4)', '0.836'],
    ['Duration', '25.1 (18)', '22.6 (20)', '0.510']
  ])
  expect(result.unassigned).toEqual([])
  expect(result.issues).not.toContain('missing-row-or-column')
  expect(refineTable(raw, source, [], [], rules).grid).toEqual([])
  expect(refineTable(raw, source, captions, [], []).grid).toEqual([])
  expect(
    refineTable(
      raw,
      source.filter((i) => i.text !== '0.836'),
      captions,
      [],
      rules
    ).grid
  ).toEqual([])
})

it('excludes full-width repeated dot rules while retaining literal missing-value dots', () => {
  const source = {
    cropRect: [0, 0, 300, 100],
    structure: {
      objects: [
        ...[0, 150].map((x) => ({ label: 'table column', rect: [x, 0, x + 150, 100] })),
        ...[0, 30, 60].map((y) => ({ label: 'table row', rect: [0, y, 300, y + 25] }))
      ]
    }
  }
  const sourceItems = [
    token('Response', 5, 4),
    token('Count', 155, 4),
    token('Complete', 5, 34),
    token('18 (21%)', 155, 34),
    token('Missing', 5, 64),
    token('.', 155, 64)
  ]
  const dottedRule = {
    text: '.'.repeat(100),
    rect: [5, 27, 295, 29],
    baseline: 29,
    height: 2,
    horizontal: true
  }
  const result = refineTable(source, [...sourceItems, dottedRule])
  expect(result.grid).toEqual([
    ['Response', 'Count'],
    ['Complete', '18 (21%)'],
    ['Missing', '.']
  ])
  expect(result.unassigned).toEqual([])
  const literal = refineTable(source, [...sourceItems, token('...', 60, 34)])
  expect(literal.grid.flat().join(' ')).toContain('...')
})

it('keeps recovered section rows when a wide table also qualifies for dense numeric alignment', () => {
  const headings = ['Age, y', 'Menopausal status', 'Tumor size, cm†']
  const source = Array.from({ length: 9 }, (_, c) =>
    token(c ? 'Group' : 'Characteristic', c * 100 + 5, 5)
  )
  const bands: number[] = []
  const expected: string[][] = [['Characteristic', ...Array(8).fill('Group')]]
  let y = 30
  for (const title of headings) {
    source.push(token(title, 5, y))
    expected.push([title, ...Array(8).fill('')])
    y += 18
    for (let r = 0; r < 4; r++, y += 18) {
      const cells = [`Category ${r}`, ...Array.from({ length: 8 }, (_, c) => String(10 + r + c))]
      source.push(...cells.map((s, c) => token(s, c * 100 + (c ? 5 : 17), y)))
      bands.push(y)
      expected.push(cells)
    }
  }
  const raw = {
    id: 'sectioned-wide',
    cropRect: [0, 0, 900, y + 10],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 900, 22] },
        ...bands.map((b) => ({ label: 'table row', rect: [0, b - 4, 900, b + 16] })),
        ...Array.from({ length: 9 }, (_, c) => ({
          label: 'table column',
          rect: [c * 100, 0, (c + 1) * 100, y + 10]
        }))
      ]
    }
  }
  const result = refineTable(raw, source, [
    { lines: ['Table 1. Characteristics'], rect: [0, -20, 900, -5] }
  ])
  expect(result.grid).toEqual(expected)
  expect(result.unassigned).toEqual([])
  expect(result.repairs).not.toContain('dense-statistical-rows-recovered')
  for (const heading of headings) {
    expect(result.cells.find((cell: { text: string }) => cell.text === heading)).toMatchObject({
      column: 0,
      colSpan: 9,
      rowSpan: 1
    })
  }
  const aligned = refineTable(
    raw,
    source.map((item) =>
      headings.includes(item.text)
        ? { ...item, rect: item.rect.map((value, index) => (index % 2 === 0 ? value + 12 : value)) }
        : item
    )
  )
  expect(
    aligned.cells
      .filter((cell: { text: string }) => headings.includes(cell.text))
      .every((cell: { colSpan: number }) => cell.colSpan === 1)
  ).toBe(true)
  const withoutSections = refineTable(
    raw,
    source.filter((item) => !headings.includes(item.text)),
    [{ lines: ['Table 1. Characteristics'], rect: [0, -20, 900, -5] }]
  )
  expect(withoutSections.grid).toEqual(expected.filter((row) => !headings.includes(row[0])))
  expect(withoutSections.repairs).toContain('dense-statistical-rows-recovered')
})

it.each([
  ['Chemo- +', 'hormonal therapy', 5, '21 (20)', '6 (5)'],
  ['No. of lymph nodes', 'removed (range)', 12, '54 (3–78)', '18.1 (16–25)']
])(
  'keeps the %s prefix with its following lowercase line',
  (prefix, tail, indent, prior, value) => {
    const raw = {
      id: 'wrapped-treatment',
      cropRect: [0, 0, 300, 80],
      structure: {
        objects: [
          ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 80] })),
          ...[
            [0, 20],
            [20, 50],
            [50, 80]
          ].map(([a, b]) => ({ label: 'table row', rect: [0, a, 300, b] }))
        ]
      }
    }
    const text = (value: string, x: number, y: number): object => ({
      text: value,
      rect: [x, y, x + value.length * 3, y + 8],
      height: 8,
      baseline: y + 8,
      horizontal: true
    })
    const source = [
      text('Treatment', 5, 5),
      text('Arm A', 110, 5),
      text('Arm B', 210, 5),
      text('Chemotherapy', 5, 24),
      text(prior, 110, 24),
      text('16 (15)', 210, 24),
      text(prefix, 5, 40),
      text(tail, indent, 52),
      text(value, 110, 52),
      text('6 (5)', 210, 52)
    ]
    const result = refineTable(raw, source)
    expect(result.grid).toEqual([
      ['Treatment', 'Arm A', 'Arm B'],
      ['Chemotherapy', prior, '16 (15)'],
      [prefix + ' ' + tail, value, '6 (5)']
    ])
    expect(result.unassigned).toEqual([])
    const unmatched = source.filter((_, i) => i !== 9)
    expect(refineTable(raw, unmatched).repairs).not.toContain('forward-wrapped-label-recovered')
  }
)

it('recovers a projected section between numeric records without borrowing their values', () => {
  const raw = {
    cropRect: [0, 0, 400, 70],
    structure: {
      objects: [
        ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 70] })),
        { label: 'table row', rect: [0, 0, 400, 16] },
        { label: 'table column header', rect: [0, 0, 400, 16] },
        { label: 'table row', rect: [0, 16, 400, 34] },
        { label: 'table row', rect: [0, 38, 400, 65] },
        { label: 'table projected row header', rect: [0, 31, 400, 40] }
      ]
    }
  }
  const text = (s: string, x: number, y: number): object => ({
    text: s,
    rect: [x, y, x + 60, y + 8],
    height: 8,
    baseline: y + 8,
    horizontal: true
  })
  const source = [
    ...['Visit', 'Arm A', 'Arm B', 'P'].map((s, i) => text(s, i * 100 + 5, 3)),
    ...['12 mo', '0 (0–3)', '1 (0–4)', '0.02*'].map((s, i) => text(s, i * 100 + 5, 19)),
    text('Pain at rest', 5, 31),
    ...['1 mo', '0 (0–5)', '0 (0–8)', '0.204'].map((s, i) => text(s, i * 100 + 5, 46))
  ]
  const result = refineTable(raw, source)
  expect(result.grid).toContainEqual(['Pain at rest', '', '', ''])
  expect(result.grid.at(-1)).toEqual(['1 mo', '0 (0–5)', '0 (0–8)', '0.204'])
  expect(
    refineTable(
      {
        ...raw,
        structure: {
          objects: raw.structure.objects.filter((o) => o.label !== 'table projected row header')
        }
      },
      source
    ).unassigned
  ).toContain('Pain at rest')
})
