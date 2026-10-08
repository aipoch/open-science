import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)

const token = (
  text: string,
  x: number,
  y: number,
  height = 13.45
): {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
  font: string
} => ({
  text,
  rect: [x, y, x + Math.max(4, text.length * 4), y + height],
  baseline: y + height,
  height,
  horizontal: true,
  font: 'Anonymous-Regular'
})

const sourceTable = (): ReturnType<typeof JSON.parse> => ({
  id: 'anonymous-development-clips',
  page: 1,
  cropRect: [0, 0, 700, 300],
  structure: {
    objects: [
      ...Array.from({ length: 7 }, (_, column) => ({
        label: 'table column',
        score: 0.99,
        rect: [column * 100, 0, (column + 1) * 100, 300]
      })),
      { label: 'table column header', score: 0.99, rect: [0, 0, 700, 20] },
      { label: 'table column header', score: 0.99, rect: [0, 20, 700, 40] },
      { label: 'table row', score: 0.99, rect: [0, 0, 700, 20] },
      { label: 'table row', score: 0.99, rect: [0, 20, 700, 40] },
      ...Array.from({ length: 14 }, (_, index) => ({
        label: 'table row',
        score: 0.99,
        rect: [0, 40 + index * 16, 700, 54 + index * 16]
      }))
    ]
  }
})

const caption = [
  {
    page: 1,
    lines: [
      'Table 13: Development clips, per clip: poses used, forecasts scored at 1.2 s, and paired raw-truth NLL differences.'
    ],
    rect: [0, -40, 600, -30]
  }
]

const records: Array<[string, string, string, string, string, string, string, string[]]> = [
  [
    'clip-01',
    'ARKit',
    '130',
    '−0.30',
    '−0.59',
    '−0.48',
    '+0.14',
    ['−0.48,−0.11', '−0.89,−0.23', '−1.03,+0.55', '−0.06,+0.35']
  ],
  [
    'clip-02',
    'reference',
    '267',
    '−0.92',
    '−0.72',
    '+0.10',
    '−0.34',
    ['−1.24,−0.63', '−1.33,−0.24', '−1.42,+0.92', '−0.56,−0.15']
  ],
  [
    'clip-03',
    'ARKit',
    '178',
    '−0.19',
    '−0.03',
    '+0.24',
    '+0.22',
    ['−0.41,+0.00', '−0.66,+0.52', '−1.65,+0.75', '+0.06,+0.40']
  ],
  [
    'clip-04',
    'reference',
    '729',
    '−0.15',
    '−0.28',
    '−0.49',
    '+1.42',
    ['−0.31,+0.06', '−0.54,+0.11', '−0.90,+0.14', '+1.28,+1.53']
  ],
  [
    'clip-05',
    'reference',
    '301',
    '+0.42',
    '+0.46',
    '+0.24',
    '+0.42',
    ['+0.18,+0.68', '+0.12,+0.79', '−0.15,+0.75', '+0.25,+0.59']
  ],
  [
    'clip-20',
    'ARKit',
    '133',
    '−0.34',
    '−0.79',
    '−1.14',
    '−0.02',
    ['−0.57,−0.15', '−1.09,−0.50', '−1.62,−0.77', '−0.14,+0.09']
  ],
  [
    'clip-21',
    'ARKit',
    '132',
    '+0.17',
    '+0.17',
    '−0.41',
    '+0.18',
    ['−0.07,+0.46', '−0.41,+0.79', '−0.81,−0.02', '+0.05,+0.32']
  ]
]

const tokens = (): ReturnType<typeof token>[] => {
  const result = [
    ...['Clip', 'poses', 'n'].map((text, column) => token(text, column * 100 + 10, 5)),
    ...['final', '−', 'CV'].map((text, index) => token(text, 350 + index * 12, 5)),
    ...['Tier A', '−', 'CV', '1.2 s'].map((text, index) => token(text, 610 + index * 18, 5)),
    ...['1.2 s', '2.4 s', '4.8 s'].map((text, index) => token(text, 370 + index * 100, 25))
  ]
  let y = 46
  for (const [label, pose, n, value1, value2, value3, value4, intervals] of records) {
    result.push(token(label, 10, y), token(pose, 110, y), token(n, 210, y))
    ;[value1, value2, value3, value4].forEach((value, column) =>
      result.push(token(value, 310 + column * 100, y - 7))
    )
    intervals.forEach((value, column) =>
      result.push(token(`[${value}]`, 310 + column * 100, y + 10, 10.46))
    )
    y += 30
  }
  return result
}

it('recovers paired point and interval rows in a wide development-clips table', () => {
  const result = refineTable(
    sourceTable(),
    tokens(),
    caption,
    [],
    [
      [0, 20, 700, 20],
      [0, 40, 700, 40]
    ]
  )
  expect(
    result.grid
      .filter((row: string[]) => row[0].startsWith('clip-'))
      .map((row: string[]) => row[0])
      .slice(-7)
  ).toEqual(['clip-01', 'clip-02', 'clip-03', 'clip-04', 'clip-05', 'clip-20', 'clip-21'])
  expect(result.grid).toContainEqual([
    '',
    '',
    '',
    '[+0.18,+0.68]',
    '[+0.12,+0.79]',
    '[−0.15,+0.75]',
    '[+0.25,+0.59]'
  ])
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.repairs).toContain('source-development-clips-paired-rows-recovered')
})

it('does not apply the paired-row repair to another caption', () => {
  const result = refineTable(
    sourceTable(),
    tokens(),
    [{ ...caption[0], lines: ['Table 12: Other metric summary.'] }],
    [],
    [
      [0, 20, 700, 20],
      [0, 40, 700, 40]
    ]
  )
  expect(result.repairs).not.toContain('source-development-clips-paired-rows-recovered')
})
