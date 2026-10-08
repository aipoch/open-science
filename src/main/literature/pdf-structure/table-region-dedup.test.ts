import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { deduplicateTableRegions, narrativeDuplicateTableIndices } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-regions.mjs')).href
)
const { constrainCaptionLaneCrop } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it('collapses overlapping detections only when they own the same source tokens', () => {
  const a = { cropRect: [0, 0, 300, 100], detection: { score: 0.8 } }
  const b = { cropRect: [1, 1, 301, 101], detection: { score: 0.9 } }
  const source = [
    { text: 'Group', rect: [10, 10, 50, 20] },
    { text: '25', rect: [200, 40, 220, 50] }
  ]
  expect(deduplicateTableRegions([a, b], source)).toEqual([b])
  expect(
    deduplicateTableRegions([a, b], [...source, { text: '0', rect: [0, 30, 0.8, 40] }])
  ).toEqual([a, b])
  expect(deduplicateTableRegions([a, b], [])).toEqual([a, b])
  expect(deduplicateTableRegions([a, { ...b, cropRect: [0, 110, 300, 210] }], source)).toHaveLength(
    2
  )
})

it('trims a lower detector region past an embedded descriptive table caption', () => {
  const table = {
    cropRect: [0, 0, 300, 160],
    detection: { score: 0.8 },
    structure: { objects: [{ label: 'table row', rect: [0, 40, 300, 60] }] }
  }
  const caption = {
    page: 1,
    lines: ['Table 2: Lower results'],
    rect: [10, 48, 290, 60]
  }
  const items = [
    { text: 'Model', horizontal: true, baseline: 70, height: 8, rect: [10, 64, 80, 72] },
    { text: '1', horizontal: true, baseline: 86, height: 8, rect: [10, 80, 30, 88] },
    { text: '2', horizontal: true, baseline: 102, height: 8, rect: [10, 96, 30, 104] },
    { text: '3', horizontal: true, baseline: 118, height: 8, rect: [10, 112, 30, 120] },
    { text: '4', horizontal: true, baseline: 134, height: 8, rect: [10, 128, 30, 136] }
  ]
  const [result] = deduplicateTableRegions([table], items, [caption])
  expect(result.cropRect).toEqual([0, 62, 300, 160])
  expect(result.structure.objects[0].rect).toEqual([0, -22, 300, -2])
})

it('keeps a caption-like region when the following source is too short to prove a table', () => {
  const table = {
    cropRect: [0, 0, 300, 160],
    detection: { score: 0.8 },
    structure: { objects: [] }
  }
  const caption = { page: 1, lines: ['Table 2: Note'], rect: [10, 48, 290, 60] }
  const items = [
    { text: 'One line', horizontal: true, baseline: 70, height: 8, rect: [10, 64, 80, 72] }
  ]
  expect(deduplicateTableRegions([table], items, [caption])[0].cropRect).toEqual(table.cropRect)
})

it('keeps a right-column table inside the lane of its original caption', () => {
  const table = {
    cropRect: [104, 111, 766, 516],
    structure: { objects: [{ label: 'table column', rect: [393, 0, 643, 400] }] }
  }
  const detectorCrop = [497, 103, 766, 516]
  const captions = [
    { lines: ['Table 5. Left'], rect: [75, 63, 429, 93] },
    { lines: ['Table 7. Right'], rect: [463, 63, 818, 93] }
  ]
  const result = constrainCaptionLaneCrop(table, detectorCrop, captions)
  expect(result.cropRect).toEqual([459, 111, 766, 516])
  expect(result.structure.objects[0].rect).toEqual([38, 0, 288, 400])
})

const object = (label: string, rect: number[]): { label: string; rect: number[] } => ({
  label,
  rect
})
type SyntheticTable = {
  id: string
  cropRect: number[]
  structure: { objects: { label: string; rect: number[] }[] }
}
const syntheticTable = (id: string, cropRect: number[], columns = 2): SyntheticTable => ({
  id,
  cropRect,
  structure: {
    objects: [
      ...Array.from({ length: columns }, (_, index) =>
        object('table column', [index * 100, 0, index * 100 + 100, 200])
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        object('table row', [0, index * 40, columns * 100, index * 40 + 25])
      )
    ]
  }
})
const token = (
  text: string,
  rect: number[]
): { text: string; rect: number[]; horizontal: boolean } => ({
  text,
  rect,
  horizontal: true
})

it('drops a prose-containing detector box when a narrower right table proves ownership', () => {
  const outer = syntheticTable('outer', [0, 0, 1000, 300], 4)
  const inner = syntheticTable('inner', [550, 80, 990, 280], 2)
  const items = [
    token('As an illustration, we provide a prose paragraph beside the table.', [40, 90, 500, 105]),
    token('Guardrails', [620, 95, 700, 110]),
    token('MT Bench', [800, 95, 880, 110]),
    token('No system prompt', [580, 140, 750, 155]),
    token('6.84', [820, 140, 860, 155]),
    token('Llama 2 system prompt', [580, 180, 760, 195]),
    token('6.38', [820, 180, 860, 195])
  ]
  expect(deduplicateTableRegions([outer, inner], items)).toEqual([inner])
})

it('keeps a captioned wide detector box for later caption-aware refinement', () => {
  const outer = syntheticTable('outer', [0, 40, 1000, 340], 4)
  const inner = syntheticTable('inner', [550, 120, 990, 320], 2)
  const items = [
    token(
      'As an illustration, we provide a prose paragraph beside the table.',
      [40, 130, 500, 145]
    ),
    token('Guardrails', [620, 135, 700, 150]),
    token('MT Bench', [800, 135, 880, 150]),
    token('No system prompt', [580, 180, 750, 195]),
    token('6.84', [820, 180, 860, 195]),
    token('Llama 2 system prompt', [580, 220, 760, 235]),
    token('6.38', [820, 220, 860, 235])
  ]
  const caption = { lines: ['Table 1. Evaluation results'], rect: [40, 10, 400, 25] }
  expect(deduplicateTableRegions([outer, inner], items, [caption])).toEqual([outer, inner])
})

it('keeps a wide table whose long stub label belongs to its first column', () => {
  const outer = syntheticTable('outer', [0, 0, 1000, 300], 4)
  const inner = syntheticTable('inner', [550, 80, 990, 280], 2)
  const items = [
    token('A long explanatory label belongs to the first table column.', [40, 90, 240, 105]),
    token('Guardrails', [620, 95, 700, 110]),
    token('MT Bench', [800, 95, 880, 110]),
    token('No system prompt', [580, 140, 750, 155]),
    token('6.84', [820, 140, 860, 155]),
    token('Llama 2 system prompt', [580, 180, 760, 195]),
    token('6.38', [820, 180, 860, 195])
  ]
  expect(deduplicateTableRegions([outer, inner], items)).toHaveLength(2)
})

it('keeps independent adjacent tables without a prose-plus-grid witness', () => {
  const left = syntheticTable('left', [0, 0, 450, 200])
  const right = syntheticTable('right', [550, 0, 1000, 200])
  const items = [
    token('Header', [40, 20, 100, 35]),
    token('12', [40, 60, 60, 75]),
    token('Header', [600, 20, 660, 35]),
    token('34', [600, 60, 620, 75])
  ]
  expect(deduplicateTableRegions([left, right], items)).toHaveLength(2)
})

it('keeps an independent adjacent grid when a wide detector has a prose cell', () => {
  const outer = syntheticTable('outer', [0, 0, 700, 200], 4)
  const right = syntheticTable('right', [750, 0, 1200, 200], 2)
  const items = [
    token('A long explanatory sentence belongs to the left table.', [40, 20, 600, 35]),
    token('Header', [800, 20, 860, 35]),
    token('12', [800, 60, 820, 75]),
    token('34', [800, 100, 820, 115])
  ]
  expect(deduplicateTableRegions([outer, right], items)).toHaveLength(2)
})

it('drops a refined narrative duplicate beside the numeric grid', () => {
  const outer = {
    cropRect: [152, 752, 753, 837],
    grid: [
      ['We use a set of unsafe prompts for evaluating safety.', 'Guardrails', 'MT Bench'],
      ['The model declines to answer harmful questions.', 'No system prompt', '6.84 ± 0.07']
    ],
    unassigned: ['As an illustration, we provide in the table the answers of']
  }
  const inner = {
    cropRect: [455, 769, 759, 855],
    grid: [
      ['', 'Guardrails', 'MT Bench'],
      ['', 'No system prompt', '6.84 ± 0.07'],
      ['', 'Llama 2 system prompt', '6.38 ± 0.07']
    ],
    unassigned: []
  }
  expect(narrativeDuplicateTableIndices([outer, inner])).toEqual(new Set([0]))
})

it('drops a tall captionless duplicate that repeats an independent inner grid', () => {
  const grid = [
    ['Model', 'Top-K', 'Ours'],
    ['Alpha', '64.6', '66.1'],
    ['Beta', '62.7', '65.0'],
    ['Gamma', '61.3', '63.8']
  ]
  const outer = {
    cropRect: [100, 100, 500, 420],
    grid,
    unassigned: ['Model', 'Top-K', 'Ours', 'Alpha', '64.6', '66.1'],
    issues: ['unassigned-source-text']
  }
  const inner = {
    cropRect: [105, 300, 495, 390],
    grid,
    unassigned: [],
    issues: []
  }
  expect(narrativeDuplicateTableIndices([outer, inner])).toEqual(new Set([0]))
})

it('keeps a captioned wide candidate even when a narrower numeric grid overlaps it', () => {
  const outer = {
    cropRect: [152, 752, 753, 837],
    grid: [
      ['Captioned narrative table', 'Guardrails', 'MT Bench'],
      ['The model declines to answer harmful questions.', 'No system prompt', '6.84 ± 0.07']
    ],
    unassigned: ['As an illustration, we provide in the table the answers of']
  }
  const inner = {
    cropRect: [455, 769, 759, 855],
    grid: [
      ['', 'Guardrails', 'MT Bench'],
      ['', 'No system prompt', '6.84 ± 0.07'],
      ['', 'Llama 2 system prompt', '6.38 ± 0.07']
    ],
    unassigned: []
  }
  expect(
    narrativeDuplicateTableIndices([outer, inner], { captionedIndices: new Set([0]) })
  ).toEqual(new Set())
})

it('drops a captioned side-by-side spill when the adjacent complete grid owns the suffix', () => {
  const outer = {
    cropRect: [405, 329, 734, 404],
    grid: [
      ['Similarity ↑', 'Model', 'SECS ↑', 'Musicality ↑', 'Similarity ↑'],
      ['79 ± 0.09', 'Ground Truth', '0.62', '3.63 ± 0.08', '3.57 ± 0.08'],
      ['27 ± 0.11 ± 0.08', 'VALL - E', '0.66', '3.34 ± 0.07', '3.30 ± 0.08'],
      ['', 'SongCreator', '0.68', '3.57 ± 0.06', '3.55 ± 0.07']
    ],
    issues: ['text-crosses-crop-boundary'],
    unassigned: ['82']
  }
  const inner = {
    cropRect: [465, 321, 751, 406],
    grid: [
      ['Model', 'SECS ↑', 'Musicality ↑', 'Similarity ↑'],
      ['Ground Truth', '0.62', '3.63 ± 0.08', '3.57 ± 0.08'],
      ['VALL - E', '0.66', '3.34 ± 0.07', '3.30 ± 0.08'],
      ['SongCreator', '0.68', '3.57 ± 0.06', '3.55 ± 0.07']
    ],
    issues: [],
    unassigned: []
  }
  expect(
    narrativeDuplicateTableIndices([outer, inner], { captionedIndices: new Set([0]) })
  ).toEqual(new Set([0]))
})

it('drops a partial side-by-side crop after its caption moves to the complete grid', () => {
  const outer = {
    cropRect: [405, 329, 734, 404],
    grid: [
      ['Similarity ↑', 'Model', 'SECS ↑', 'Musicality ↑', 'Similarity ↑'],
      ['79 ± 0.09', 'Ground Truth', '0.62', '3.63 ± 0.08', '3.57 ± 0.08']
    ],
    issues: ['text-crosses-crop-boundary'],
    unassigned: ['VALL - E', '0.66', '3.34 ± 0.07']
  }
  const inner = {
    cropRect: [465, 321, 751, 406],
    grid: [
      ['Model', 'SECS ↑', 'Musicality ↑', 'Similarity ↑'],
      ['Ground Truth', '0.62', '3.63 ± 0.08', '3.57 ± 0.08'],
      ['VALL - E', '0.66', '3.34 ± 0.07', '3.30 ± 0.08']
    ],
    issues: [],
    unassigned: []
  }
  expect(
    narrativeDuplicateTableIndices([outer, inner], { captionedIndices: new Set([1]) })
  ).toEqual(new Set([0]))
})

it('keeps a wide narrative table when the overlapping numeric grid has no matching cells', () => {
  const outer = {
    cropRect: [152, 752, 753, 837],
    grid: [
      ['A long explanatory sentence belongs to this table.', 'Left metric', 'Right metric'],
      ['A second narrative row remains in the same table.', 'Alpha', 'Beta']
    ],
    unassigned: ['The surrounding prose is part of the table.']
  }
  const inner = {
    cropRect: [455, 769, 759, 855],
    grid: [
      ['', 'Other metric', 'Score'],
      ['', 'Gamma', '1.2'],
      ['', 'Delta', '2.4']
    ],
    unassigned: []
  }
  expect(narrativeDuplicateTableIndices([outer, inner])).toEqual(new Set())
})

it('keeps long stub labels when they are assigned table cells', () => {
  const outer = {
    cropRect: [152, 752, 753, 837],
    grid: [
      ['A long study arm label with details.', 'Guardrails', 'MT Bench'],
      ['Another long study arm label with details.', 'No system prompt', '6.84 ± 0.07']
    ],
    unassigned: []
  }
  const inner = {
    cropRect: [455, 769, 759, 855],
    grid: [
      ['', 'Guardrails', 'MT Bench'],
      ['', 'No system prompt', '6.84 ± 0.07'],
      ['', 'Llama 2 system prompt', '6.38 ± 0.07']
    ],
    unassigned: []
  }
  expect(narrativeDuplicateTableIndices([outer, inner])).toEqual(new Set())
})

it('drops a numeric left-column spill when the remaining rows match a clean grid', () => {
  const outer = {
    cropRect: [398, 250, 762, 1060],
    grid: [
      ['Rows', 'Finance', 'Cols', 'Rows'],
      ['81 M', 'AR_ADJUSTMENTS_ALL', '25', '0'],
      ['', 'AR_AGING_BUCKETS', '9', '1'],
      ['40', 'AR_AGING_BUCKET_LINES_B', '11', '5'],
      ['', 'AR_BATCHES_ALL', '22', '493'],
      ['70', 'CE_BANK_ACCOUNTS', '34', '1']
    ],
    unassigned: ['25', '493', '34'],
    issues: ['text-crosses-crop-boundary']
  }
  const inner = {
    cropRect: [434, 254, 764, 1081],
    grid: [
      ['Finance', '', '79 tables'],
      ['AR_ADJUSTMENTS_ALL', '25', '0'],
      ['AR_AGING_BUCKETS', '9', '1'],
      ['AR_AGING_BUCKET_LINES_B', '11', '5'],
      ['AR_BATCHES_ALL', '22', '493'],
      ['CE_BANK_ACCOUNTS', '34', '1']
    ],
    unassigned: []
  }
  expect(narrativeDuplicateTableIndices([outer, inner])).toEqual(new Set([0]))
})

it('keeps a real numeric stub column beside an independent grid', () => {
  const outer = {
    cropRect: [100, 100, 500, 400],
    grid: [
      ['1', 'Left', 'Value'],
      ['2', 'A', '10'],
      ['3', 'B', '20'],
      ['4', 'C', '30']
    ],
    unassigned: []
  }
  const inner = {
    cropRect: [560, 100, 900, 400],
    grid: [
      ['Right', 'Value'],
      ['A', '10'],
      ['B', '20'],
      ['C', '30']
    ],
    unassigned: []
  }
  expect(narrativeDuplicateTableIndices([outer, inner])).toEqual(new Set())
})

it('drops an oversized record that merges independently ruled labelled panels', () => {
  const panel = (
    top: number,
    bottom: number
  ): {
    cropRect: number[]
    grid: string[][]
    unassigned: string[]
    issues: string[]
  } => ({
    cropRect: [10, top, 190, bottom],
    grid: [
      ['Header', 'Value'],
      ['Row A', '1'],
      ['Row B', '2']
    ],
    unassigned: [],
    issues: []
  })
  const outer = {
    cropRect: [0, 0, 200, 240],
    grid: Array.from({ length: 24 }, () => Array.from({ length: 9 }, () => 'value')),
    unassigned: [
      '(a) First panel',
      '(b) Second panel',
      '(c) Third panel',
      'First panel note',
      'Second panel note',
      'Third panel note',
      '7',
      '8'
    ],
    issues: ['nonrectangular-spanning-cell', 'conflicting-spanning-cells']
  }
  const rules = [
    [0, 10, 200, 10],
    [0, 100, 200, 100],
    [0, 110, 200, 110],
    [0, 200, 200, 200]
  ]
  expect(
    narrativeDuplicateTableIndices([outer, panel(10, 100), panel(110, 200)], { rules })
  ).toEqual(new Set([0]))
})

it('keeps a wide table when panel boundaries are not independently ruled', () => {
  const outer = {
    cropRect: [0, 0, 200, 240],
    grid: Array.from({ length: 24 }, () => Array.from({ length: 9 }, () => 'value')),
    unassigned: ['(a) footnote', '(b) footnote', 'text', 'text', 'text', 'text'],
    issues: ['nonrectangular-spanning-cell']
  }
  const inner = {
    cropRect: [10, 10, 190, 100],
    grid: [
      ['Header', 'Value'],
      ['Row A', '1'],
      ['Row B', '2']
    ],
    unassigned: [],
    issues: []
  }
  expect(narrativeDuplicateTableIndices([outer, inner], { rules: [] })).toEqual(new Set())
})
