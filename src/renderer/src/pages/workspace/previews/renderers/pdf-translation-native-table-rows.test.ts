import assert from 'node:assert/strict'
import { it as test } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from './pdf-translation-layout'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  font = 9,
  hasEOL = false,
  fontName = 'table'
): PdfLayoutTextItem => ({
  str,
  width,
  height: font,
  fontName,
  dir: 'ltr',
  hasEOL,
  transform: [font, 0, 0, font, x, 800 - y]
})
const extract = (
  items: PdfLayoutTextItem[]
): ReturnType<typeof groupPdfTranslationPages>['pages'][number]['blocks'] =>
  groupPdfTranslationPages({
    pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
  }).pages[0].blocks

// CVPR table geometry: 8pt header, 9pt rows, independent 10pt body
// column on the same baselines. Complete native rows end before that body.
const narrow = (
  options: {
    header?: boolean
    end?: boolean
    drift?: boolean
    fontMismatch?: boolean
    rows?: number
    missingFont?: boolean
    operator?: boolean
  } = {}
): PdfLayoutTextItem[] => {
  const items: PdfLayoutTextItem[] =
    options.header === false
      ? []
      : [item('Method', 72, 100, 30, 8), item('Top error', 208, 100, 55, 9, true)]
  for (let row = 0; row < (options.rows ?? 3); row++) {
    const y = 112 + row * 12
    items.push(
      item(
        ['Alpha network', 'Beta network', 'Gamma network'][row],
        72,
        y,
        95,
        9,
        false,
        options.fontMismatch && row === 1 ? 'foreign' : 'table'
      )
    )
    if (options.operator) items.push(item('=', 180, y, 6))
    items.push(
      item(
        ['7.32', '6.66', '4.94'][row],
        228 + (options.drift ? row * 12 : 0),
        y,
        16,
        9,
        options.end !== false
      )
    )
    items.push(
      item('Independent body continues with several ordinary words.', 320, y, 260, 10, true, 'body')
    )
  }
  if (options.missingFont) for (const run of items) delete run.fontName
  return items
}

test('native table rows retain their labels separately from neighboring larger body text', () => {
  const blocks = extract(narrow())
  for (const label of ['Alpha network', 'Beta network', 'Gamma network']) {
    assert.ok(
      blocks.some((block) => block.tableCell && block.source === label),
      JSON.stringify(blocks)
    )
  }
  assert.ok(
    blocks.some((block) => /Independent body/u.test(block.source) && !block.tableCell),
    JSON.stringify(blocks)
  )
  assert.ok(
    !blocks.some((block) => /network.*Independent/u.test(block.source)),
    JSON.stringify(blocks)
  )
  for (const number of ['7.32', '6.66', '4.94']) {
    assert.ok(
      blocks.some((block) => block.tableCell && block.sourceOnly && block.source === number),
      JSON.stringify(blocks)
    )
  }
})

test('first-column labels keep their native left edge while using empty space on the right', () => {
  const runs = narrow(),
    before = structuredClone(runs),
    blocks = extract(runs)
  for (const label of ['Alpha network', 'Beta network', 'Gamma network']) {
    const block = blocks.find((entry) => entry.tableCell && entry.source === label)
    assert.ok(block)
    assert.equal(block.rect.x, 72, 'the label must stay inside its original column')
    assert.ok(block.rect.right > 167, 'available space before the value remains usable')
    assert.ok(block.rect.right <= 219, 'one em separates the label and measured value')
  }
  assert.deepEqual(runs, before, 'table padding must not change native glyph positions')
})

test.each([
  ['2h45', '3h30', '4h15'],
  ['Conv dw / s2', 'Conv dw / s1', 'Conv / s1'],
  ['5× Conv dw / s1', 'Block dw / s2', 'Layer / s1']
])('compact first-column parameters retain bounded horizontal capacity: %j', (...labels) => {
  const runs = labels.flatMap((label, row) => {
    const y = 112 + row * 12
    return [
      item(label, 72, y, 95),
      item('7.32', 228, y, 16),
      item('6.66', 280, y, 16),
      item('4.94', 332, y, 16, 9, true)
    ]
  })
  const before = structuredClone(runs),
    blocks = extract(runs)
  for (const label of labels) {
    const block = blocks.find((entry) => entry.tableCell && entry.source === label)
    assert.ok(block, JSON.stringify(blocks))
    assert.equal(block.rect.x, 63, 'compact values retain one em of native band padding')
    assert.ok(block.rect.right <= 219, 'padding must not reach the measured value')
    assert.ok(block.rect.bottom - block.rect.y < 10, 'padding must not borrow the next row')
  }
  assert.deepEqual(runs, before, 'capacity must not change the original native glyphs')
})

test.each([
  'Descriptive stage 1 label',
  'Accuracy',
  'GP visit T1',
  'GP-phone T2',
  'Stage 2',
  'Conv dw / s0',
  'Conv dw / s2 output'
])('descriptive first-column label %s keeps its native left edge', (label) => {
  const runs = narrow()
  for (let row = 0; row < 3; row++) runs[2 + row * 3].str = label
  const blocks = extract(runs)
  assert.ok(blocks.some((entry) => entry.tableCell && entry.source === label))
  for (const block of blocks.filter((entry) => entry.tableCell && entry.source === label))
    assert.equal(block.rect.x, 72)
})

test.each([
  { name: 'no native header', header: false },
  { name: 'unfinalized row runs', end: false },
  { name: 'drifting measured columns', drift: true },
  { name: 'different descriptor font', fontMismatch: true },
  { name: 'only two matching rows', rows: 2 },
  { name: 'missing native font identity', missingFont: true },
  { name: 'equation operator joining operands', operator: true }
])('$name does not infer a table from neighboring body text', (options) => {
  const blocks = extract(narrow(options))
  assert.ok(
    !blocks.some(
      (block) => block.tableCell && /^(?:Alpha|Beta|Gamma) network$/u.test(block.source)
    ),
    JSON.stringify(blocks)
  )
  assert.ok(
    blocks.some((block) => /Independent body/u.test(block.source) && !block.tableCell),
    JSON.stringify(blocks)
  )
})

test.each([
  ['0.6B', '1.2B', '16.2B'],
  ['4M (21x)', '28M (1.5x)', '64M (8.7x)']
])('keeps scaled technical counts in their measured columns: %j', (...counts) => {
  const items = [
    item('Model', 72, 90, 30, 8),
    item('Count', 215, 90, 40, 8),
    item('Accuracy', 285, 90, 40, 8, true)
  ]
  for (const [row, count] of counts.entries()) {
    const y = 104 + row * 12
    items.push(item(['Alpha model', 'Beta model', 'Gamma model'][row], 72, y, 90, 8))
    items.push(
      item(count, 215, y, 48, 8),
      item(['71.2%', '74.8%', '78.1%'][row], 290, y, 25, 8, true)
    )
  }
  const blocks = extract(items)
  for (const count of counts)
    assert.ok(
      blocks.some((b) => b.tableCell && b.sourceOnly && b.source === count),
      JSON.stringify(blocks)
    )
  for (const label of ['Alpha model', 'Beta model', 'Gamma model'])
    assert.ok(
      blocks.some((b) => b.tableCell && b.source === label),
      JSON.stringify(blocks)
    )
})

const longTable = (gap = false): PdfLayoutTextItem[] => {
  const items = [
    item('Model', 72, 80, 30, 8),
    item('Compute', 220, 80, 38, 8),
    item('Accuracy', 280, 80, 38, 8, true)
  ]
  for (let row = 0; row < 12; row++) {
    const y = 94 + row * 12 + (gap && row >= 8 ? 160 : 0)
    items.push(item(`Network ${String.fromCharCode(65 + row)}`, 72, y, 95, 8))
    items.push(item('16.2B', 228, y, 18, 8), item('78.1%', 290, y, 22, 8, true))
    if (row >= 8)
      items.push(item(`Plot ${row}`, 355, y, 35, 6), item('axis description', 405, y, 80, 6, true))
  }
  return items
}

test('a continuous native record chain keeps the end of a long table beside plot labels', () => {
  const blocks = extract(longTable())
  for (const label of ['Network I', 'Network J', 'Network K', 'Network L'])
    assert.ok(
      blocks.some((b) => b.tableCell && b.source === label),
      JSON.stringify(blocks)
    )
  assert.ok(!blocks.some((b) => /Network.*Plot/u.test(b.source)), JSON.stringify(blocks))
  assert.ok(
    blocks.some((b) => !b.tableCell && /Plot/u.test(b.source)),
    JSON.stringify(blocks)
  )
})

test('a distant native header cannot prove records beyond a break in the aligned chain', () => {
  const blocks = extract(longTable(true))
  assert.ok(!blocks.some((b) => b.tableCell && b.source === 'Network L'), JSON.stringify(blocks))
})

// PLOS row geometry: two repeated scores prove both a wide frame and a
// narrower frame. The actual complete first row must own all of its native ink.
test('a narrower later frame cannot capture a complete wide table row', () => {
  const blocks = extract([
    item('Body measure', 36, 100, 120, 8),
    item('28.5 (4.09)', 279, 100, 34, 8),
    item('27.7 (3.51)', 394, 100, 34, 8),
    item('.65', 520, 100, 10, 8, true),
    item('Status', 36, 112, 30, 8, true),
    item('Single', 169, 124, 25, 8),
    item('6', 290, 124, 4, 8),
    item('3', 406, 124, 4, 8, true),
    item('Married', 169, 136, 30, 8),
    item('10', 288, 136, 8, 8),
    item('8', 406, 136, 4, 8, true),
    item('Previous measure', 36, 88, 100, 8),
    item('30.5 (5.09)', 279, 88, 34, 8),
    item('31.7 (3.51)', 394, 88, 34, 8),
    item('.73', 520, 88, 10, 8, true)
  ])
  assert.ok(
    blocks.some((block) => block.tableCell && block.source === 'Body measure'),
    JSON.stringify(blocks)
  )
  assert.ok(
    blocks.some((block) => block.tableCell && block.source === '.65' && block.sourceOnly),
    JSON.stringify(blocks)
  )
  assert.ok(
    !blocks.some((block) => /Body measure.*Status/u.test(block.source)),
    JSON.stringify(blocks)
  )
})

const wide = (withProof = true, mismatch = false): PdfLayoutTextItem[] => {
  const columns = [36, 205, 266, 306, 352, 412, 452]
  const items = columns.map((x, index) =>
    item(
      ['Outcome', 'Mean value', 'Median', 'Range', 'Mean score', 'Median', 'Range'][index],
      x,
      80,
      index === 0 ? 50 : 27,
      8,
      index === 6
    )
  )
  for (let row = 0; row < (withProof ? 3 : 2); row++) {
    const y = 92 + row * 48
    items.push(item('Group', 36, y, 24, 8), item('Baseline', 81, y, 32, 8))
    for (const [index, x] of columns.slice(1).entries())
      items.push(
        item(
          ['1.8 (1.4)', '1.5', '.6–3.3', '2.9 (1.8)', '2.8', '1.6–4.5'][index],
          x,
          y,
          index % 3 === 0 ? 30 : 22,
          8,
          index === 5
        )
      )
    items.push(item('In Week 6', 81, y + 12, 40, 8, false, mismatch ? 'foreign' : 'table'))
    items.push(item('1.8 (1.4)', 205, y + 12, 30, 8), item('2.9 (1.8)', 352, y + 12, 30, 8, true))
    items.push(item('Effects within groups', 81, y + 24, 76, 8, true))
    items.push(item('(Baseline to Week 6)', 81, y + 33, 73, 8, true))
    items.push(
      item('1.41 (1.58)', 205, y + 24, 34, 8),
      item('-0.46 (1.12)', 352, y + 24, 39, 8, true)
    )
    items.push(
      item('Significance within groups', 81, y + 44, 100, 8),
      item('.001', 205, y + 44, 13, 8),
      item('.17', 352, y + 44, 10, 8, true)
    )
  }
  items.push(
    item(
      'Following ordinary paragraph must remain outside the table.',
      36,
      270,
      370,
      10,
      true,
      'body'
    )
  )
  return items
}

test('sparse measured rows keep their own descriptor while unmeasured wraps stay together', () => {
  const blocks = extract(wide())
  for (const label of [
    'In Week 6',
    'Effects within groups (Baseline to Week 6)',
    'Significance within groups'
  ]) {
    assert.equal(
      blocks.filter((block) => block.tableCell && block.source === label).length,
      3,
      JSON.stringify(blocks)
    )
  }
  assert.ok(
    blocks.some((block) => !block.tableCell && /Following ordinary paragraph/u.test(block.source)),
    JSON.stringify(blocks)
  )
  assert.ok(
    !blocks.some((block) => /Week 6 Effects|Week 6\) Significance/u.test(block.source)),
    JSON.stringify(blocks)
  )
})

test('two complete records cannot establish a wide narrative frame', () => {
  const blocks = extract(wide(false))
  assert.ok(
    !blocks.some(
      (block) => block.tableCell && block.source === 'Effects within groups (Baseline to Week 6)'
    ),
    JSON.stringify(blocks)
  )
})

test('a foreign native label anchor does not establish a sparse record', () => {
  const blocks = extract(wide(true, true))
  assert.ok(
    blocks.some((block) => block.items.includes('1:9') && block.items.includes('1:16')),
    JSON.stringify(blocks)
  )
  assert.ok(
    !blocks.some((block) => block.items.length === 1 && block.items[0] === '1:16'),
    JSON.stringify(blocks)
  )
})

const sampleCount = (
  suffix = '22) received advice about managing symptoms.',
  x = 200,
  fontName = 'body',
  gap = 14
): PdfLayoutTextItem[] => [
  item(
    'Participants in the intervention arm were randomly allocated (n =',
    200,
    100,
    310,
    9.5,
    true,
    'body'
  ),
  item(suffix, x, 100 + gap, 310, 9.5, true, fontName)
]

test('native closed sample count continues its clinical sentence', () => {
  const blocks = extract(sampleCount())
  assert.ok(
    blocks.some(
      (block) => !block.sourceOnly && /allocated \(n = 22\) received/u.test(block.source)
    ),
    JSON.stringify(blocks)
  )
})

test.each([
  { name: 'an equation definition', suffix: '22) where n denotes the matrix dimension.' },
  {
    name: 'a numbered list with period marker',
    suffix: '22. Participants received further advice.'
  },
  { name: 'another text column', x: 320 },
  { name: 'another native font', fontName: 'foreign' },
  { name: 'a distant row', gap: 30 }
])('$name does not become a sample count continuation', ({ suffix, x, fontName, gap }) => {
  const blocks = extract(sampleCount(suffix, x, fontName, gap))
  assert.ok(!blocks.some((block) => block.items.length === 2), JSON.stringify(blocks))
})

test('intervening native content prevents sample count continuation', () => {
  const items = sampleCount()
  items.splice(1, 0, item('Independent caption.', 40, 150, 110, 8, true, 'caption'))
  const blocks = extract(items)
  assert.ok(
    !blocks.some((block) => block.items.includes('1:0') && block.items.includes('1:2')),
    JSON.stringify(blocks)
  )
})

test('a complete visual band does not claim the neighboring long prose column', () => {
  const items: PdfLayoutTextItem[] = []
  const prose = [
    'Ordinary neighboring paragraph begins here and continues onward',
    'The same body column has another unfinished continuation',
    'Its closing sentence stays in the original body paragraph.'
  ]
  for (let row = 0; row < 3; row++) {
    const y = 100 + row * 12
    items.push(item(prose[row], 36, y, [250, 230, 215][row], 10, true, 'body'))
    items.push(item(['Alpha', 'Beta', 'Gamma'][row], 320, y, 30, 10, false, 'table'))
    items.push(item(['59.7', '63.7', '66.1'][row], 390, y, 20, 10))
    items.push(
      item(['61.0', '65.5', '68.2'][row], 440, y, 20, 10),
      item(['61.5', '66.0', '69.0'][row], 485, y, 20, 10),
      item(['37.5', '42.5', '45.0'][row], 530, y, 20, 10, true)
    )
  }
  const blocks = extract(items)
  assert.ok(
    blocks.some((block) => block.source === prose.join(' ') && !block.tableCell),
    JSON.stringify(blocks)
  )
  for (const label of ['Alpha', 'Beta', 'Gamma']) {
    assert.ok(
      blocks.some((block) => block.source === label && block.tableCell),
      JSON.stringify(blocks)
    )
  }
})

const scoreHeader = (
  options: { rows?: number; headerFont?: string; combined?: boolean; drift?: number } = {}
): PdfLayoutTextItem[] => {
  const items = [item('Model', 96.43, 100, 19.93, 8)]
  if (options.combined) items.push(item('top-1 err. top-5 err.', 165.67, 100, 74.67, 8, true))
  else
    items.push(
      item(
        'top-1 err.',
        165.67 + (options.drift ?? 0),
        100,
        29.22,
        8,
        false,
        options.headerFont ?? 'table'
      ),
      item('top-5 err.', 210.82, 100, 29.22, 8, true)
    )
  items.push(item('relu', 330, 100, 24, 11, true, 'figure'))
  for (let row = 0; row < (options.rows ?? 3); row++) {
    const y = 112.45 + row * 12.06
    items.push(item(['Alpha model', 'Beta model', 'Gamma model'][row], 96.43, y, 43, 8))
    items.push(item(['28.07', '24.27', '22.85'][row], 170.19, y, 20.17))
    items.push(item(['9.33', '7.38', '6.71'][row], 217.58, y, 15.69, 9, true))
    items.push(item('relu', 330, y, 24, 11, true, 'figure'))
  }
  return items
}

test('complete native score headers inherit the frame they independently proved', () => {
  const blocks = extract(scoreHeader())
  for (const label of ['top-1 err.', 'top-5 err.']) {
    assert.ok(
      blocks.some((block) => block.tableCell && block.source === label),
      JSON.stringify(blocks)
    )
  }
  assert.ok(
    !blocks.some((block) => block.source === 'top-1 err. top-5 err.'),
    JSON.stringify(blocks)
  )
})

test.each([
  { name: 'only two numeric records', rows: 2 },
  { name: 'different header native type', headerFont: 'foreign' },
  { name: 'header outside its score anchor', drift: 24 },
  { name: 'one native run crossing both columns', combined: true }
])('$name does not acquire independent score-header cells', (options) => {
  const blocks = extract(scoreHeader(options))
  assert.ok(
    !blocks.some((block) => block.tableCell && block.source === 'top-1 err.'),
    JSON.stringify(blocks)
  )
})

const spanningHeader = (
  options: {
    proof?: boolean
    foreign?: boolean
    drift?: number
    distant?: boolean
    combined?: boolean
  } = {}
): PdfLayoutTextItem[] => {
  const rows = wide(options.proof !== false)
  for (const [index, run] of rows.entries()) if (index >= 7) run.transform[5] -= 10
  const y = options.distant ? 45 : 67.53
  const header = options.combined
    ? [item('Groups Study Group (n = 22)', 173.76, y, 101.94, 8)]
    : [
        item('Groups', 173.76, y, 25.15, 8),
        item(
          'Study Group (n = 22)',
          204.38 + (options.drift ?? 0),
          y,
          71.32,
          8,
          false,
          options.foreign ? 'foreign' : 'table'
        )
      ]
  header.push(
    item('Control Group (n = 22)', 351.21, y, 78.46, 8, true, options.foreign ? 'foreign' : 'table')
  )
  return [...header, ...rows]
}

test('proven wide columns preserve each full native spanning group header', () => {
  const blocks = extract(spanningHeader())
  for (const label of ['Groups', 'Study Group (n = 22)', 'Control Group (n = 22)']) {
    assert.ok(
      blocks.some((block) => block.tableCell && block.source === label && block.items.length === 1),
      JSON.stringify(blocks)
    )
  }
  assert.ok(
    !blocks.some((block) => block.source === 'Groups Study Group (n = 22)'),
    JSON.stringify(blocks)
  )
})

test.each([
  { name: 'an unproven wide table', proof: false },
  { name: 'unproven spanning header font', foreign: true },
  { name: 'a group label missing its measured anchor', drift: 20 },
  { name: 'a distant preceding paragraph', distant: true },
  { name: 'a native run spanning label and measured group', combined: true }
])('$name does not split a spanning native group header', (options) => {
  const blocks = extract(spanningHeader(options))
  assert.ok(
    !blocks.some((block) => block.tableCell && block.source === 'Groups'),
    JSON.stringify(blocks)
  )
})

const clinicalHeaders = (
  options: { rows?: number; drift?: boolean; symbolic?: boolean } = {}
): PdfLayoutTextItem[] => {
  const runs = [
    item('Characteristic', 56, 100, 48, 8, false, 'bold'),
    item('C-STAPB group', 137, 100, 52, 8, true, 'bold'),
    item('(', 137, 109, 2, 8, false, 'bold'),
    item('n', 140, 109, 4, 8, false, 'italic'),
    item('=', 145, 109, 5, 8, false, 'math'),
    item('46)', 151, 109, 11, 8, true, 'bold'),
    item('Conventional', 195, 100, 46, 8, true, 'bold'),
    item('group (', 195, 109, 25, 8, false, 'bold'),
    item(options.symbolic ? 'x' : 'n', 221, 109, 4, 8, false, 'italic'),
    item('=', 226, 109, 5, 8, false, 'math'),
    item('49)', 232, 109, 11, 8, true, 'bold'),
    item('P', 261, 100, 4, 8, false, 'italic'),
    item('value', 267, 100, 19, 8, true, 'bold')
  ]
  for (let row = 0; row < (options.rows ?? 3); row++) {
    const y = 140 + row * 12,
      drift = options.drift ? row * 8 : 0
    runs.push(item(['Morning pain', 'Evening pain', 'Next day pain'][row], 64, y, 55, 8))
    runs.push(item('1.33 ± 0.60', 137 + drift, y, 33, 8))
    runs.push(item('1.27 ± 0.45', 195 + drift, y, 33, 8))
    runs.push(item('<', 261 + drift, y, 5, 8), item('0.001', 267 + drift, y, 17, 8, true))
  }
  return runs
}

test('repeated measured rows preserve separate wrapped group headers and native count variables', () => {
  const runs = clinicalHeaders(),
    before = structuredClone(runs),
    blocks = extract(runs)
  for (const label of ['C-STAPB group (n = 46)', 'Conventional group (n = 49)', 'P value']) {
    assert.ok(
      blocks.some((block) => block.tableCell && block.source.replace(/\(\s+/gu, '(') === label),
      JSON.stringify(blocks)
    )
  }
  for (const label of ['Morning pain', 'Evening pain', 'Next day pain']) {
    assert.ok(
      blocks.some((block) => block.tableCell && block.source === label),
      JSON.stringify(blocks)
    )
  }
  assert.ok(
    blocks.some((block) => block.tableCell && block.sourceOnly && block.source === '< 0.001'),
    JSON.stringify(blocks)
  )
  assert.deepEqual(runs, before)
})

test.each([
  { name: 'too few complete measured rows', rows: 2 },
  { name: 'drifting measured column anchors', drift: true },
  { name: 'a symbolic header operand', symbolic: true }
])('$name cannot claim a complete group-count header', (options) => {
  const blocks = extract(clinicalHeaders(options))
  assert.ok(
    !blocks.some(
      (block) =>
        block.tableCell &&
        new RegExp(
          'Conventional group\\s*\\(\\s*' + (options.symbolic ? 'x' : 'n') + '\\s*=\\s*49\\)',
          'u'
        ).test(block.source)
    ),
    JSON.stringify(blocks)
  )
})

test('an invalid clock-minute suffix does not restore compact parameter padding', () => {
  const runs = [112, 124, 136].flatMap((y) => [
    item('2h99', 72, y, 95),
    item('7.32', 228, y, 16),
    item('6.66', 280, y, 16),
    item('4.94', 332, y, 16, 9, true)
  ])
  const blocks = extract(runs).filter((block) => block.tableCell && block.source === '2h99')
  assert.equal(blocks.length, 3)
  assert.ok(blocks.every((block) => block.rect.x === 72))
})

test.each(['complete header', 'open native line', 'offset baseline', 'symbolic suffix'])(
  'a measured anchor inside an italic P-value label keeps strict ownership: %s',
  (shape) => {
    const runs = [
      item('Characteristic', 40, 100, 50, 8, false, 'bold'),
      item('Group A', 160, 100, 30, 8, false, 'bold'),
      item('Group B', 220, 100, 30, 8, false, 'bold'),
      item('P', 280, 100, 5, 8, shape === 'open native line', 'italic'),
      item(
        shape === 'symbolic suffix' ? '- value + x' : '- value',
        287,
        shape === 'offset baseline' ? 104 : 100,
        25,
        8,
        true,
        'bold'
      ),
      ...[112, 124, 136].flatMap((y, row) => [
        item(`Variable ${row}`, 40, y, 45, 8, false),
        item('13.2', 160, y, 15, 8, false),
        item('15.7', 220, y, 15, 8, false),
        item('0.001', 287, y, 17, 8, true)
      ])
    ]
    const blocks = extract(runs)
    assert.equal(
      blocks.some((block) => block.source === 'P - value'),
      shape === 'complete header',
      JSON.stringify(blocks)
    )
    assert.equal(blocks.flatMap((block) => block.items).length, runs.length)
  }
)

test.each(['complete proof', 'missing header', 'drifting response', 'missing native row end'])(
  'a mixed native categorical table requires closed responses and full header proof: %s',
  (shape) => {
    const runs = [
      ...(shape === 'missing header'
        ? []
        : [
            item('Model', 40, 100, 25, 8),
            item('Matrix', 170, 100, 25, 8),
            item('Pretrain', 220, 100, 30, 8),
            item('Tasks', 280, 100, 22, 8),
            item('Adaptive', 340, 100, 20, 8, true)
          ]),
      ...[112, 124, 136].flatMap((y, row) => [
        item(`Model ${['Alpha', 'Beta', 'Gamma'][row]} (2020)`, 40, y, 90, 8),
        item('sparse', 170, y, 25, 8),
        item('yes', 225 + (shape === 'drifting response' ? row * 10 : 0), y, 12, 8),
        item('no', 285, y, 10, 8),
        item('yes', 345, y, 12, 8, shape !== 'missing native row end')
      ])
    ]
    const blocks = extract(runs)
    assert.equal(
      blocks.some((block) => block.tableCell && block.source === 'Model Alpha (2020)'),
      shape === 'complete proof',
      JSON.stringify(blocks)
    )
    assert.equal(blocks.flatMap((block) => block.items).length, runs.length)
  }
)

test('complete native categorical headers may span two columns and right-align the final label', () => {
  const runs = [
    item('Model', 40, 100, 25, 8),
    item('Matrix Pretrain', 168, 100, 76, 8),
    item('Tasks', 280, 100, 22, 8),
    item('Adaptation', 312, 100, 45, 8, true),
    ...[112, 124, 136].flatMap((y, row) => [
      item(`Model ${['Alpha', 'Beta', 'Gamma'][row]} (2020)`, 40, y, 90, 8),
      item('sparse', 170, y, 25, 8),
      item('yes', 225, y, 12, 8),
      item('no', 285, y, 10, 8),
      item('yes', 345, y, 12, 8, true)
    ])
  ]
  const blocks = extract(runs)
  assert.ok(
    blocks.some((block) => block.tableCell && block.source === 'Model Alpha (2020)'),
    JSON.stringify(blocks)
  )
  assert.equal(blocks.flatMap((block) => block.items).length, runs.length)
})

test.each(['aligned outer edge', 'drifting placeholder'])(
  'native dash placeholders borrow only the measured score outer edge: %s',
  (shape) => {
    const runs = [
      item('Model', 40, 100, 25, 8),
      item('Params', 155, 100, 30, 8),
      item('Dev', 216, 100, 18, 8),
      item('Test', 255, 100, 20, 8, true),
      ...[112, 124, 136, 148].flatMap((y, row) => [
        item(`Model ${['Alpha', 'Beta', 'Gamma', 'Delta'][row]}`, 40, y, 90, 8),
        item('44M', 168, y, 17, 8),
        item(
          row === 3 ? '1.04' : '-',
          row === 3 ? 216 : 231 + (shape === 'drifting placeholder' ? row * 8 : 0),
          y,
          row === 3 ? 18 : 3,
          8
        ),
        item('1.05', 256, y, 18, 8, true)
      ])
    ]
    const blocks = extract(runs)
    assert.equal(
      blocks.some((block) => block.tableCell && block.source === 'Model Alpha'),
      shape === 'aligned outer edge',
      JSON.stringify(blocks)
    )
    assert.equal(blocks.flatMap((block) => block.items).length, runs.length)
  }
)

test('closed response native rows preserve short task identifiers in proven mixed columns', () => {
  const runs = [
    item('Model', 40, 100, 25, 8),
    item('Matrix', 170, 100, 25, 8),
    item('Pretrain', 220, 100, 30, 8),
    item('Tasks', 280, 100, 22, 8),
    item('Adaptive', 340, 100, 20, 8, true),
    ...[112, 124, 136].flatMap((y, row) => [
      item(`Model ${['Alpha', 'Beta', 'Gamma'][row]} (2020)`, 40, y, 90, 8),
      item('sparse', 170, y, 25, 8),
      item('yes', 225, y, 12, 8),
      item(['no', 'MT', 'QA'][row], 285, y, 10, 8),
      item('yes', 345, y, 12, 8, true)
    ])
  ]
  const blocks = extract(runs)
  for (const name of ['Alpha', 'Beta', 'Gamma'])
    assert.ok(
      blocks.some((block) => block.tableCell && block.source === `Model ${name} (2020)`),
      JSON.stringify(blocks)
    )
  for (const name of ['MT', 'QA'])
    assert.ok(
      blocks.some((block) => block.tableCell && block.source === name),
      JSON.stringify(blocks)
    )
  assert.equal(blocks.flatMap((block) => block.items).length, runs.length)
})

const rangeTable = (
  options: { dash?: string; complete?: boolean; symbolic?: boolean } = {}
): PdfLayoutTextItem[] => {
  const dash = options.dash ?? '–'
  const rows = ['Operation duration (min)', 'Blood loss (mL)', 'Drug dose (mg)']
  return [
    item('Variable', 40, 100, 35, 8),
    item('Group Alpha', 210, 100, 55, 8),
    item('Group Beta', 320, 100, 55, 8),
    item('P value', 440, 100, 30, 8, true),
    ...rows.flatMap((label, row) => [
      item(label, 40, 113 + row * 13, 100, 8),
      item(
        `120 (100${dash}${options.symbolic ? 'x' : '140'}${options.complete === false ? '' : ')'}`,
        210,
        113 + row * 13,
        65,
        8,
        false,
        'values'
      ),
      item(
        `110 (90${dash}${options.symbolic ? 'x' : '125'}${options.complete === false ? '' : ')'}`,
        320,
        113 + row * 13,
        60,
        8,
        false,
        'values'
      ),
      item(
        options.complete === false || options.symbolic ? 'x' : '0.075',
        440,
        113 + row * 13,
        22,
        8,
        true,
        'values'
      )
    ]),
    item(
      'Data are shown as median (IQR), with separate notes below the table.',
      40,
      154,
      380,
      8,
      true
    )
  ]
}

test.each(['–', ' – ', '−', '-', ' to '])(
  'complete statistical ranges using %s prove independent native table labels',
  (dash) => {
    const blocks = extract(rangeTable({ dash }))
    for (const label of ['Operation duration (min)', 'Blood loss (mL)', 'Drug dose (mg)']) {
      assert.ok(
        blocks.some((b) => b.tableCell && !b.sourceOnly && b.source === label),
        JSON.stringify(blocks)
      )
    }
    assert.ok(
      blocks.some((b) => !b.tableCell && /^Data are shown/u.test(b.source)),
      JSON.stringify(blocks)
    )
    assert.ok(
      blocks.some((b) => b.tableCell && b.sourceOnly && b.source === `120 (100${dash}140)`),
      JSON.stringify(blocks)
    )
  }
)

test.each([{ complete: false }, { symbolic: true }])(
  'open or symbolic ranges cannot establish numeric table columns: %j',
  (options) => {
    const blocks = extract(rangeTable(options))
    assert.ok(!blocks.some((b) => b.tableCell && /^120 \(/u.test(b.source)), JSON.stringify(blocks))
  }
)

const bracketRangeRows = (fault = ''): PdfLayoutTextItem[] => [
  item('Duration', 40, 100, 60, 8),
  item('First group', 205, 100, 60, 8),
  item('Second group', 325, 100, 70, 8),
  item('P value', 440, 100, 30, 8, true),
  ...['Block duration (min)', 'Operating duration (min)', 'Recovery duration (min)'].flatMap(
    (label, row) => [
      item(label, 40, 113 + row * 13, 120, 8),
      item(
        fault === 'symbolic'
          ? '3 [3–x]'
          : fault === 'unclosed'
            ? '3 [3–4'
            : fault === 'mixed'
              ? '3 [3–4)'
              : '3 [3 –4]',
        205 + (fault === 'drift' ? row * 20 : 0),
        113 + row * 13,
        40,
        8
      ),
      item(
        fault && fault !== 'drift' ? '4 [3–x]' : '4 [3 –5]',
        325 + (fault === 'drift' ? row * 20 : 0),
        113 + row * 13,
        40,
        8
      ),
      item(
        fault && fault !== 'drift' ? 'x' : '0.110',
        440 + (fault === 'drift' ? row * 20 : 0),
        113 + row * 13,
        24,
        8,
        true
      )
    ]
  )
]
test('closed bracketed numeric ranges prove separate clinical table rows', () => {
  const blocks = extract(bracketRangeRows())
  for (const label of [
    'Block duration (min)',
    'Operating duration (min)',
    'Recovery duration (min)'
  ])
    assert.ok(
      blocks.some((b) => b.tableCell && !b.sourceOnly && b.source === label),
      JSON.stringify(blocks)
    )
  assert.ok(
    blocks.some((b) => b.tableCell && b.sourceOnly && b.source === '3 [3 –4]'),
    JSON.stringify(blocks)
  )
})
test.each(['symbolic', 'unclosed', 'mixed', 'drift'])(
  'bracket ranges cannot invent a numeric frame from %s cells',
  (fault) => {
    const blocks = extract(bracketRangeRows(fault))
    assert.ok(
      !blocks.some((b) => b.tableCell && b.source.startsWith('3 [')),
      JSON.stringify(blocks)
    )
  }
)
