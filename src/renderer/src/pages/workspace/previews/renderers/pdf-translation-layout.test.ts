import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readPdfTranslationCases } from '../../../../../../../test/fixtures/pdf-translation/read-cases'
/* eslint-disable @typescript-eslint/explicit-function-return-type -- infer synthetic fixture helpers */
import { expect, it as test } from 'vitest'
import assert from 'node:assert/strict'
import {
  groupPdfTranslationPages as extractDocument,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from './pdf-translation-layout'
const extractPage = (page: PdfLayoutPage) => extractDocument({ pages: [page] }).pages[0]
const item = (str: string, x: number, y: number, width = 240, size = 10, hasEOL = true) => ({
  str,
  width,
  height: size,
  dir: 'ltr',
  hasEOL,
  transform: [size, 0, 0, size, x, 800 - y]
})
const page = (items: PdfLayoutPage['items'], n = 1) => ({
  page: n,
  width: 600,
  height: 800,
  rotation: 0,
  items
})
const document = (pages: PdfLayoutPage[]) => ({ id: 'synthetic', sha256: 'fixture', pages })

test.each(
  [
    'inline-sequence-numbered-tail.jsonl',
    'wrapped-chained-parameter.jsonl',
    'baseline-comma-definition.jsonl'
  ].flatMap((file) =>
    readPdfTranslationCases<{
      name: string
      page: PdfLayoutPage
      leftItem: number
      rightItem: number
      neighborItem: number
      join: boolean
      wholeSource?: string
    }>(file)
  )
)('$name keeps complete prose and separate neighboring owners', (fixture) => {
  const result = extractDocument(document([fixture.page])),
    owner = (index: number) => result.units.find((unit) => unit.items.includes(`1:${index}`)),
    paragraph = owner(fixture.leftItem)
  assert.equal(paragraph === owner(fixture.rightItem), fixture.join)
  assert.notEqual(paragraph, owner(fixture.neighborItem))
  if (fixture.wholeSource) {
    assert.equal(paragraph?.source, fixture.wholeSource)
    assert.equal(paragraph?.sourceOnly, undefined)
  }
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, fixture.page.items.filter((part) => part.str.trim()).length)
  for (const unit of result.units)
    assert.deepEqual(
      unit.originalStrings,
      unit.items.map((key) => fixture.page.items[Number(key.split(':')[1])].str)
    )
})

test.each(
  readPdfTranslationCases<{
    name: string
    page: PdfLayoutPage
    citationJoined: boolean
    columnJoined: boolean
    titleSeparate: boolean | null
    headItem: number
    firstItem: number
    citationItem: number
    lastItem: number
    captionItem: number
    neighborItem: number
  }>('wrapped-citation-float-column.jsonl')
)('$name preserves whole prose and independent native owners', (fixture) => {
  const result = extractDocument(document([fixture.page])),
    owner = (index: number) => result.units.find((unit) => unit.items.includes(`1:${index}`)),
    first = owner(fixture.firstItem)
  assert.equal(first === owner(fixture.citationItem), fixture.citationJoined)
  assert.equal(first === owner(fixture.lastItem), fixture.columnJoined)
  assert.notEqual(first, owner(fixture.captionItem))
  assert.notEqual(first, owner(fixture.neighborItem))
  if (fixture.titleSeparate) {
    assert.equal(owner(fixture.headItem)?.source, '2 Background')
    assert.notEqual(first, owner(fixture.headItem))
    assert.equal(first?.sourceOnly, undefined)
    assert.equal(
      first?.source,
      'The complete study considers nearby models (NLMs) and System [12, 27] and Method [8] have enabled new tools for ordinary applications while consistently reducing the cost of model serving for all requests with consistent results.'
    )
  }
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, fixture.page.items.filter((item) => item.str.trim()).length)
  for (const unit of result.units)
    assert.deepEqual(
      unit.originalStrings,
      unit.items.map((key) => fixture.page.items[Number(key.split(':')[1])].str)
    )
})

test.each(
  readPdfTranslationCases<{
    name: string
    page: PdfLayoutPage
    join: boolean
    leftItem: number
    rightItem: number
    neighborItem: number
  }>('wrapped-inline-identifier.jsonl')
)('$name verifies the full paragraph and native boundary ownership', (fixture) => {
  const result = extractDocument(document([fixture.page])),
    owner = (index: number) =>
      result.units.find((unit) => unit.items.includes(`${fixture.page.page}:${index}`))
  assert.equal(owner(fixture.leftItem) === owner(fixture.rightItem), fixture.join)
  assert.notEqual(owner(fixture.leftItem), owner(fixture.neighborItem))
  if (fixture.join) {
    assert.equal(owner(fixture.leftItem)?.sourceOnly, undefined)
    assert.match(
      owner(fixture.leftItem)!.source,
      /training\s*\(mesh_train\), encoding \(mesh_encode\), and decoding \(mesh_decode\)/u
    )
    assert.ok(
      owner(fixture.leftItem)!.source.endsWith('input through mesh_encode and mesh_decode.')
    )
  }
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, fixture.page.items.filter((item) => item.str.trim()).length)
  for (const unit of result.units)
    assert.deepEqual(
      unit.originalStrings,
      unit.items.map((key) => fixture.page.items[Number(key.split(':')[1])].str)
    )
})

test.each(
  readPdfTranslationCases<{
    name: string
    page: PdfLayoutPage
    separate: boolean
    heading: string
    leftItem: number
    rightItem: number
  }>('wide-numbered-heading.jsonl')
)('$name keeps the standalone title, body and neighbor boundaries intact', (fixture) => {
  const result = extractDocument(document([fixture.page])),
    owner = (index: number) =>
      result.units.find((unit) => unit.items.includes(`${fixture.page.page}:${index}`))
  if (fixture.separate) {
    assert.notEqual(owner(fixture.leftItem), owner(fixture.rightItem))
    assert.equal(owner(fixture.leftItem)?.source, fixture.heading)
    assert.equal(
      owner(fixture.rightItem)?.source,
      'The complete body explains the independent conversion steps while preserving every neighboring source item.'
    )
  } else assert.equal(owner(fixture.leftItem), owner(fixture.rightItem))
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, fixture.page.items.filter((item) => item.str.trim()).length)
})

const latexitItems = (size = 0.00000033) => [
  { ...item('<latexit', 120, 100, size * 4.8, size, false), fontName: 'metadata' },
  {
    ...item(
      'sha1_base64="YWJjZA==">YWJjZGVmZ2g=</latexit>',
      120 + size * 5.4,
      100,
      size * 100,
      size
    ),
    fontName: 'metadata'
  }
]

test('zero-size closed LaTeXiT payloads retain independent source-only native owners', () => {
  const inputs = [item('Visible formula label', 100, 100, 120), ...latexitItems()],
    before = structuredClone(inputs),
    result = extractDocument(document([page(inputs)]))
  assert.ok(
    result.units.some((unit) => unit.source === 'Visible formula label' && !unit.sourceOnly)
  )
  for (const key of ['1:1', '1:2']) {
    const owners = result.units.filter((unit) => unit.items.includes(key))
    assert.equal(owners.length, 1)
    assert.equal(owners[0].items.length, 1)
    assert.ok(owners[0].sourceOnly)
  }
  assert.deepEqual(inputs, before)
})

test.each(['visible', 'open-xml', 'font-mismatch', 'wide-payload'])(
  'LaTeXiT metadata isolation requires a closed zero-size pair: %s',
  (fault) => {
    const inputs = latexitItems(fault === 'visible' ? 9 : undefined)
    if (fault === 'open-xml') inputs[1].str = inputs[1].str.replace('</latexit>', '')
    if (fault === 'font-mismatch') inputs[1].fontName = 'other'
    if (fault === 'wide-payload') inputs[1].width = 10
    const result = extractDocument(document([page(inputs)]))
    assert.ok(!result.units.some((unit) => unit.risks.includes('metadata-extraction')))
  }
)

test('a closed numeric citation can also close its introducing parenthetical prose', () => {
  const inputs = [
    item('These models are related to denoising score', 40, 100, 300),
    item('matching [', 40, 112, 50, 10, false),
    item('11', 90, 112, 10, 10, false),
    item(',', 100, 112, 3, 10, false),
    item('55', 103, 112, 10, 10, false),
    item(']). We find high quality samples in the experiment.', 113, 112, 340)
  ]
  const result = extractDocument(document([page(inputs)]))
  assert.ok(
    result.units.some(
      (unit) => !unit.sourceOnly && /score matching \[11,\s*55\]\)\. We find/u.test(unit.source)
    ),
    JSON.stringify(result.units)
  )
})

test('mixed-size table labels and the final descriptive row stay in their own cells', () => {
  const inputs = [
    item('Task', 78, 85, 17, 9, false),
    item('Tool', 126, 85, 17, 9, false),
    item('Language A', 214, 85, 31, 9, false),
    item('Language B', 257, 85, 28, 9),
    ...[98, 110, 122].flatMap((y, index) => [
      item(index ? 'NimbusNet' : 'Train', 78, y, 24, 9, false),
      item('Tokenizer', 126, y, 42, 9, false),
      item('56.9', 226, y, 19, 11, false),
      item('54.1', 266, y, 19, 11)
    ]),
    item('Pre-tokenization', 78, 134, 56, 9, false),
    item('Tool A / Tool B', 138, 134, 59, 7, false),
    item('24.6', 226, 134, 19, 11, false),
    item('15.8', 266, 134, 19, 11)
  ]
  const result = extractDocument(document([page(inputs)]))
  for (const label of [
    'Task',
    'Tool',
    'Language A',
    'Language B',
    'Pre-tokenization Tool A / Tool B'
  ])
    assert.ok(
      result.units.some((unit) => unit.source === label),
      label
    )
  assert.ok(!result.units.some((unit) => unit.source.includes('24.6') && !unit.sourceOnly))
})

test.each([false, true])(
  'tensor columns keep final operation cells independent (drift %s)',
  (drift) => {
    const inputs = [
      ...[100, 112, 124].flatMap((y, index) => [
        item('Convolution', 314, y, 48, 9, false),
        item(
          index % 2 ? '1 × 1 × 1024 × 1024' : '3 × 3 × 3 × 32',
          388,
          y,
          index % 2 ? 80 : 56,
          9,
          false
        ),
        item(
          index % 2 ? '7 × 7 × 1024' : '224 × 224 × 3',
          drift ? 490 + index * 20 : 478,
          y,
          index % 2 ? 50 : 55,
          9
        )
      ]),
      item('Softmax / s1', 314, 136, 46, 9, false),
      item('Classifier', 388, 136, 35, 9, false),
      item('1 × 1 × 1000', 478, 136, 50, 9)
    ]
    const result = extractDocument(document([page(inputs)]))
    assert.equal(
      result.units.some((unit) => unit.source === 'Softmax / s1'),
      !drift
    )
    if (!drift) assert.ok(result.units.some((unit) => unit.source === 'Classifier'))
  }
)

test.each([false, true])(
  'a neighboring prose column supplies independent table evidence (%s)',
  (prose) => {
    const inputs = [
      item('Task', 78, 85, 17, 9, false),
      item('Tool', 126, 85, 17, 9, false),
      item('Language A', 214, 85, 31, 9, false),
      item('Language B', 257, 85, 28, 9),
      ...[98, 110, 122, 134, 146, 158].flatMap((y, index) => [
        ...(index === 0 ? [item('Train', 78, y, 20, 9, false)] : []),
        item('NimbusNet', 109, y, 52, 9, false),
        item('yes', 181, y, 12, 9, false),
        item('10.1', 226, y, 19, 11, false),
        item('16.8', 266, y, 19, 11),
        ...([0, 1, 2, 4].includes(index)
          ? [
              item(
                prose
                  ? 'This independent native prose line stays in its own column.'
                  : 'Unclassified note',
                310,
                y,
                219,
                10
              )
            ]
          : [])
      ])
    ]
    const result = extractDocument(document([page(inputs)]))
    assert.equal(
      result.units.some((unit) => unit.source === 'Task'),
      prose
    )
    if (prose)
      assert.ok(result.units.some((unit) => unit.source.includes('independent native prose')))
  }
)

test('a results paragraph stays intact beside a table whose final row shares its baseline', () => {
  const inputs = [
    item('well as their two approaches based on recurrent', 72, 455, 226, 10.9),
    item('networks with combined evaluation.', 72, 468, 196, 10.9),
    ...[450, 455, 468, 483].flatMap((y, index) => [
      item(`Model ${index}`, 316, y, 58, 10, false),
      item('63.7', 383, y, 18, 10, false),
      item('65.5', 427, y, 18, 10, false),
      item('66.0', 471, y, 18, 10, false),
      item('42.5', 511, y, 18, 10)
    ]),
    item('Results.', 72, 490, 37, 10.9, false),
    item('We present the results in Figure 1.', 120, 490, 157, 10.9, false),
    item('We', 285, 490, 14, 10.9),
    item('use 10 hidden units and run', 72, 503, 138, 10.9, false),
    item('NimbusNet', 216, 503, 53, 10.9, false),
    item('for 5', 275, 503, 24, 10.9),
    item('NimbusNet', 316, 503, 48, 10, false),
    item('64.2', 383, 503, 18, 10, false),
    item('66.2', 427, 503, 18, 10, false),
    item('66.6', 471, 503, 18, 10, false),
    item('45.2', 511, 503, 18, 10),
    item('epochs with a learning rate selected on a validation set.', 72, 516, 227, 10.9)
  ]
  const result = extractDocument(document([page(inputs)]))
  assert.ok(
    result.units.some(
      (unit) =>
        unit.source ===
        'Results. We present the results in Figure 1. We use 10 hidden units and run NimbusNet for 5 epochs with a learning rate selected on a validation set.'
    )
  )
  assert.ok(result.units.some((unit) => unit.source === 'NimbusNet'))
  assert.ok(result.units.some((unit) => unit.source === '64.2' && unit.sourceOnly))
})

test.each([
  { value: '95 (99%)', drift: 0, separate: true },
  { value: '95(99.5%)a', drift: 0, separate: true },
  { value: '95 (99%) patients', drift: 0, separate: false },
  { value: '95 (99%)', drift: 28, separate: false }
])(
  'count-percentage table values require complete literals and aligned columns: $value / $drift',
  ({ value, drift, separate }) => {
    const inputs = [100, 112, 124].flatMap((y, index) => [
      item(`Category ${index}`, 40, y, 100, 9, false),
      item(value, 310 + drift * index, y, 46, 9, false),
      item(value, 465 + drift * index, y, 46, 9)
    ])
    const result = extractDocument(document([page(inputs)]))
    assert.equal(
      result.units.some((unit) => unit.source === 'Category 0'),
      separate
    )
    if (separate) {
      assert.equal(
        result.units.filter((unit) => unit.source === value && unit.sourceOnly).length,
        6
      )
      for (const index of [0, 1, 2])
        assert.ok(result.units.some((unit) => unit.source === `Category ${index}`))
    }
  }
)

test('a count with a percentage in ordinary prose remains translatable', () => {
  const result = extractDocument(
    document([
      page([
        item('The study included 95 (99%) participants in the active group.', 40, 100, 290),
        item('Each participant completed the planned assessment.', 40, 112, 290)
      ])
    ])
  )
  assert.equal(result.units.length, 1)
  assert.equal(result.units[0].sourceOnly, undefined)
  assert.ok(result.units[0].source.includes('95 (99%) participants'))
})

test.each([
  { start: 'Figure 3 shows', join: true },
  { start: 'Table 2 reports', join: true },
  { start: 'Fig. 1(a) illustrates', join: true },
  { start: 'Figure 3: shows', join: false },
  { start: 'Table 2. reports', join: false },
  { start: 'Figure 3 Model architecture', join: false }
])('figure/table prose references are not captions: $start', ({ start, join }) => {
  const left = `${start} the detailed measurements and their dependence on all of the included input variables through`
  const right =
    'the shared representation which retains all useful information from the original sample.'
  const result = extractDocument(
    document([page([item(left, 40, 600, 220), item(right, 340, 100, 220)])])
  )
  assert.equal(
    result.units.some((unit) => unit.source === `${left} ${right}`),
    join
  )
})

test.each([
  { size: 14.3, shift: 0, interrupted: false, join: true },
  { size: 12, shift: 0, interrupted: false, join: false },
  { size: 14.3, shift: 22, interrupted: false, join: false },
  { size: 14.3, shift: 0, interrupted: true, join: false }
])(
  'a centered front-page title uses matching native font and adjacency: $size / $shift / $interrupted',
  ({ size, shift, interrupted, join }) => {
    const inputs = [
      {
        ...item('NimbusNet: Learning Deep Contextual Representations for', 118, 32, 364, size),
        fontName: 'title'
      },
      ...(interrupted ? [{ ...item('Independent note', 40, 100, 120), fontName: 'body' }] : []),
      { ...item('Language Understanding', 222 + shift, 48, 156, size), fontName: 'title' },
      { ...item('Alex Example and Jordan Sample', 160, 92, 280, 12), fontName: 'author' },
      ...[200, 214, 228, 242, 256].map((y) => ({
        ...item(
          'The main body of this document provides independent scientific context.',
          40,
          y,
          240,
          11
        ),
        fontName: 'body'
      }))
    ]
    const result = extractDocument(document([page(inputs)]))
    assert.equal(
      result.units.some(
        (unit) =>
          unit.source ===
          'NimbusNet: Learning Deep Contextual Representations for Language Understanding'
      ),
      join
    )
    assert.ok(result.units.some((unit) => unit.source === 'Alex Example and Jordan Sample'))
  }
)

test.each([
  { offset: 9, interrupted: false, join: true },
  { offset: 26, interrupted: false, join: false },
  { offset: 9, interrupted: true, join: false }
])(
  'inline bullet text retains its aligned native continuation: $offset / $interrupted',
  ({ offset, interrupted, join }) => {
    const inputs = [
      item('• We demonstrate the importance of contextual information', 74, 150, 216, 11),
      ...(interrupted ? [item('Independent material', 400, 180, 110, 11)] : []),
      item(
        'for learning representations that retain the full semantic context',
        74 + offset,
        164,
        216 - offset,
        11
      ),
      item('in every relevant input.', 74 + offset, 178, 124, 11),
      item('• The next bullet remains a separate list entry.', 74, 202, 216, 11)
    ]
    const result = extractDocument(document([page(inputs)]))
    assert.equal(
      result.units.some((unit) =>
        unit.source.includes('contextual information for learning representations')
      ),
      join
    )
    if (join)
      assert.ok(result.units.some((unit) => unit.source.endsWith('in every relevant input.')))
    assert.ok(result.units.some((unit) => unit.source.startsWith('• The next bullet')))
  }
)

test('staggered neighboring table subheaders do not merge independent column labels', () => {
  const inputs = [
    item('Method', 122, 255, 26, 10, false),
    item('Dataset A', 198, 255, 24, 10, false),
    item('Dataset B', 237, 255, 32),
    item('Method', 340, 249, 26, 10, false),
    item('Parameters', 402, 249, 35, 10, false),
    item('Time', 453, 249, 35),
    item('(Millions)', 399, 260, 40, 10, false),
    item('(seconds)', 451, 260, 38),
    ...[282, 293].flatMap((y, index) => [
      item(`Method ${index ? 'B' : 'A'}`, 122, y, 45, 10, false),
      item(index ? '92.82' : '93.46', 199, y, 22, 10, false),
      item(index ? '77.7/85.8' : '81.2/88.5', 234, y, 38),
      item(`Method ${index ? 'D' : 'C'}`, 340, y, 45, 10, false),
      item(index ? '110' : '180', 412, y, 15, 10, false),
      item(index ? '668' : '895', 463, y, 15)
    ])
  ]
  const result = extractDocument(document([page(inputs)]))
  for (const label of ['Dataset A', 'Dataset B', 'Parameters', 'Time', '(Millions)', '(seconds)'])
    assert.ok(
      result.units.some((unit) => unit.source === label),
      label
    )
  for (const value of ['93.46', '92.82', '81.2/88.5', '77.7/85.8', '180', '110', '895', '668'])
    assert.ok(
      result.units.some((unit) => unit.source === value && unit.sourceOnly),
      value
    )
  assert.deepEqual(
    result.units.flatMap((unit) => unit.originalStrings).sort(),
    inputs.map((input) => input.str).sort()
  )
})

test.each([9.2, 10])(
  'separates adjacent table frames sharing body/header baselines at font %s',
  (rightFont) => {
    const inputs = [
      item('Method', 85, 150, 50, 10, false),
      item('462', 191, 150, 15, 10, false),
      item('2.36', 247, 150, 18),
      item('Expanded method label', 56, 162, 110, 10, false),
      item('52.3', 190, 162, 18, 10, false),
      item('0.27', 247, 162, 18),
      item('Method B', 90, 174, 40, 10, false),
      item('29.6', 190, 174, 18, 10, false),
      item('0.15', 247, 174, 18),
      item('Method C', 90, 187, 40, 10, false),
      item('15.1', 190, 187, 18, 10, false),
      item('0.15', 247, 187, 18),
      item('Table 5. Comparison of the models', 356, 155, 141, 9),
      item('Model', 338, 163, 24, rightFont, false),
      item('Accuracy', 397, 163, 36, rightFont, false),
      item('Cost', 451, 163, 28, rightFont, false),
      item('Parameters', 503, 163, 28, rightFont),
      item('Model A', 321, 187, 58, rightFont, false),
      item('68.4%', 404, 187, 24, rightFont, false),
      item('325', 458, 187, 14, rightFont, false),
      item('2.6', 511, 187, 12, rightFont),
      item('Model B', 314, 202, 72, rightFont, false),
      item('65.3%', 404, 202, 24, rightFont, false),
      item('307', 458, 202, 14, rightFont, false),
      item('2.9', 511, 202, 12, rightFont)
    ]
    const result = extractDocument(document([page(inputs)]))
    for (const label of [
      'Table 5. Comparison of the models',
      'Expanded method label',
      'Model',
      'Accuracy',
      'Cost',
      'Parameters',
      'Model A',
      'Model B'
    ])
      assert.ok(
        result.units.some((unit) => unit.source === label),
        label
      )
    for (const number of ['52.3', '0.27', '68.4%', '325', '2.6', '65.3%', '307', '2.9'])
      assert.ok(
        result.units.some((unit) => unit.source === number && unit.sourceOnly),
        number
      )
    assert.deepEqual(
      result.units.flatMap((unit) => unit.originalStrings).sort(),
      inputs.map((input) => input.str).sort()
    )
  }
)

test.each(
  readPdfTranslationCases<{ name: string; values: string[]; drift: number; table: boolean }>(
    'numeric-table-with-trailing-description.jsonl'
  )
)('$name', ({ values, drift, table }) => {
  const items = [100, 114, 128].flatMap((y, row) => [
    item('stride 2', 40, y, 40, 10, false),
    ...values.map((value, column) =>
      item(value, 110 + column * 90 + row * drift, y, 60, 10, false)
    ),
    item('max + pass through', 440, y, 100)
  ])
  const result = extractDocument(document([page(items)]))
  const numeric = result.units.filter((unit) => values.includes(unit.source) && unit.sourceOnly)
  assert.equal(numeric.length, table ? values.length * 3 : 0)
  if (table) {
    assert.equal(result.units.filter((unit) => unit.source === 'stride 2').length, 3)
    assert.equal(result.units.filter((unit) => unit.source === 'max + pass through').length, 3)
  }
  assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
})

test.each(
  readPdfTranslationCases<{ name: string; intervening: boolean; joined: boolean }>(
    'raised-formula-prose-continuation.jsonl'
  )
)('$name', ({ intervening, joined }) => {
  const first = item('The objective uses the full probability', 40, 100, 380)
  const tail = item('distribution. We compute p =', 40, 116, 240)
  const numerator = item('exp(z/T)', 340, 108, 60, 7)
  const denominator = item('exp(q/T)', 340, 124, 60, 7)
  const items = intervening
    ? [first, numerator, tail, denominator]
    : [first, tail, numerator, denominator]
  const result = extractDocument(document([page(items)]))
  assert.equal(
    result.units.some((unit) => unit.source.includes('probability distribution.')),
    joined
  )
  assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
})

test.each(
  readPdfTranslationCases<{ name: string; tail: string; translated: boolean; lead?: string }>(
    'formula-where-explanation-boundary.jsonl'
  )
)('$name', ({ tail, translated, lead = 'where' }) => {
  const items = [
    item('x = log(y)', 40, 100, 60, 10, false),
    item(lead, 105, 100, 28, 10, false),
    item('q', 138, 100, 5, 10, false),
    item(tail, 148, 100, 180)
  ]
  const result = extractDocument(document([page(items)]))
  const explanation = result.units.find((unit) => unit.source.includes('where'))!
  assert.equal(!explanation.sourceOnly, translated)
  if (translated) {
    assert.ok(explanation.source.startsWith(lead + ' q'))
    assert.ok(result.units.some((unit) => unit.source === 'x = log(y)' && unit.sourceOnly))
  }
  assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
})

test.each(
  readPdfTranslationCases<{
    name: string
    gap: number
    raised: number
    joined: boolean
    segmented?: boolean
  }>('leading-alphabetic-footnotes.jsonl')
)('$name', ({ gap, raised, joined, segmented }) => {
  const items = [
    item('b', 40, 100 - raised, 3, 6),
    ...(segmented
      ? [
          item('Values', 43 + gap, 100, 30),
          item('are means unless otherwise stated.', 76 + gap, 100, 207)
        ]
      : [item('Values are means unless otherwise stated.', 43 + gap, 100, 240)])
  ]
  const result = extractPage(page(items))
  assert.equal(
    result.blocks.some((block) => /^b\s*Values/u.test(block.source)),
    joined
  )
  assert.deepEqual(
    result.blocks.flatMap((block) => block.originalStrings).sort(),
    items.map((i) => i.str).sort()
  )
})

test.each(
  readPdfTranslationCases<{ name: string; source: string; sourceOnly: boolean; parts?: string[] }>(
    'named-extremum-attached-index.jsonl'
  )
)('$name', ({ source, sourceOnly, parts }) => {
  const result = extractDocument(
    document([
      page(
        parts
          ? parts.map((text, index) =>
              item(text, 40 + index * 100, 100, 100, 10, index === parts.length - 1)
            )
          : [item(source, 40, 100, 350)]
      )
    ])
  )
  assert.equal(result.units.length, 1)
  assert.equal(result.units[0].source, source)
  assert.equal(Boolean(result.units[0].sourceOnly), sourceOnly)
})

test.each(
  readPdfTranslationCases<{
    name: string
    equationX: number | null
    intervening: boolean
    joined: boolean
  }>('short-equation-lead-continuation.jsonl')
)('$name', ({ equationX, intervening, joined }) => {
  const prefix = 'Applying the same bound to all remaining terms, we',
    items = [
      item(prefix, 40, 100, 280),
      ...(intervening ? [item('x = y', 325, 100, 35)] : []),
      item('get', 40, 112, 12),
      ...(equationX === null ? [] : [item('z = x + y', equationX, 136, 100)])
    ],
    result = extractDocument(document([page(items)]))
  assert.equal(
    result.units.some((unit) => unit.source === `${prefix} get`),
    joined
  )
  assert.ok(
    result.units.filter((unit) => unit.source.includes('get')).every((unit) => !unit.sourceOnly)
  )
  assert.deepEqual(
    result.units.flatMap((unit) => unit.originalStrings).sort(),
    items.map((entry) => entry.str).sort()
  )
})

test.each(
  readPdfTranslationCases<{
    name: string
    items: Array<{
      text: string
      x: number
      y: number
      width: number
      size: number
      fontName?: string
    }>
    before?: string
    after?: string
    symbol?: string
    formula?: string
    proseOnly?: boolean
  }>('stacked-inline-math-prose-boundaries.jsonl')
)('$name', ({ items, before, after, symbol = 'β', formula, proseOnly }) => {
  const result = extractDocument(
    document([
      page(
        items.map((i) => ({
          ...item(i.text, i.x, i.y, i.width, i.size, false),
          fontName: i.fontName
        }))
      )
    ])
  )
  if (proseOnly) assert.ok(result.units.every((u) => !u.sourceOnly))
  else {
    assert.ok(result.units.some((u) => u.source === before && !u.sourceOnly))
    assert.ok(result.units.some((u) => u.source === after && !u.sourceOnly))
    assert.ok(result.units.some((u) => u.sourceOnly && u.originalStrings.includes(symbol)))
  }
  if (formula)
    assert.ok(
      result.units.some((u) => u.sourceOnly && u.source === formula),
      JSON.stringify(result.units.map((u) => u.source))
    )
  assert.deepEqual(
    result.units.flatMap((u) => u.originalStrings).sort(),
    items.map((i) => i.text).sort()
  )
})

test.each(
  readPdfTranslationCases<{
    name: string
    numeratorX: number
    scripts: boolean
    expected?: string
  }>('inline-radical-fraction-boundaries.jsonl')
)('$name', ({ numeratorX, scripts, expected }) => {
  const items = [
    item('The rate is', 40, 100, 52, 10, false),
    item(scripts ? 'β' : 'α', numeratorX, 96, 4.5, 7, false),
    { ...item('√', 100, 98.6, 6.4, 7, false), fontAscent: 0.775, fontDescent: -0.96 },
    item(scripts ? 'β' : 't', 106.4, 104, 4.5, 7, false),
    ...(scripts
      ? [
          item('1', numeratorX + 4.5, 97.5, 3, 5, false),
          item('2', numeratorX + 4.5, 93.5, 3, 5, false),
          item('2', 110.9, 105, 3, 5, false)
        ]
      : []),
    item('and remains stable.', 120, 100, 90, 10, false)
  ]
  const result = extractDocument(document([page(items)]))
  const formulas = result.units.filter((u) => u.source.includes('/(√'))
  if (expected) {
    assert.equal(formulas.length, 1)
    assert.equal(formulas[0].source, expected)
    assert.equal(formulas[0].sourceOnly, true)
    assert.ok(result.units.some((u) => u.source.includes('The rate') && !u.sourceOnly))
    assert.ok(result.units.some((u) => u.source.includes('remains stable') && !u.sourceOnly))
  } else assert.equal(formulas.length, 0)
  assert.deepEqual(
    result.units.flatMap((u) => u.originalStrings).sort(),
    items.map((i) => i.str).sort()
  )
})

test.each(
  readPdfTranslationCases<{
    name: string
    rootY: number
    fontDescent?: number
    root?: string
    preservedBase?: boolean
    baseX: number
    base: string
    joined: boolean
  }>('inline-radical-source-ownership.jsonl')
)('$name', ({ rootY, baseX, base, joined, root = '√', preservedBase, fontDescent = -0.96 }) => {
  const items = [
    ...(!preservedBase ? [item('The update uses', 40, 100, 75, 10, false)] : []),
    { ...item(root, 118, rootY, 8, 10, false), fontAscent: 0.775, fontDescent },
    item(base, baseX, 100, 5, 10, false),
    ...(!preservedBase ? [item('as the denominator.', 134, 100, 95, 10, false)] : [])
  ]
  const result = extractDocument(document([page(items)]))
  const prose = result.units.find((unit) => unit.source.includes('The update'))!
  if (!preservedBase) assert.equal(prose.source.includes('√'), joined)
  if (preservedBase) assert.equal(result.units.find((u) => u.source === base)?.sourceOnly, true)
  if (joined) assert.ok(prose.source.includes('√' + base))
  else assert.equal(result.units.find((unit) => unit.source === root)?.sourceOnly, true)
  assert.deepEqual(
    result.units.flatMap((unit) => unit.originalStrings).sort(),
    items.map((i) => i.str).sort()
  )
})

test.each(
  [
    'adjacent-scripts-and-wrapped-list-boundaries.jsonl',
    'decimal-prose-boundary.jsonl',
    'wrapped-prose-operator-prefix.jsonl',
    'short-terminal-prose-wrap.jsonl',
    'parenthesized-statistics-prose.jsonl',
    'closed-citation-and-count-prose.jsonl',
    'hanging-caption-prose-boundaries.jsonl',
    'wrapped-numeric-citation-prose.jsonl'
  ].flatMap((file) =>
    readPdfTranslationCases<{
      name: string
      items: Array<{ text: string; x: number; y: number; width: number; size: number }>
      expected: string[]
    }>(file)
  )
)('$name', ({ items, expected }) => {
  const result = extractDocument(
    document([page(items.map((i) => item(i.text, i.x, i.y, i.width, i.size, false)))])
  )
  assert.deepEqual(
    result.units.map((unit) => unit.source),
    expected
  )
  assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
})

test.each(
  readPdfTranslationCases<{
    name: string
    items: Array<{ text: string; x: number; y: number; width: number; size: number }>
    left: string
    right: string
    operand: string
  }>('prose-does-not-bridge-equation-operands.jsonl')
)('$name', ({ items, left, right, operand }) => {
  const result = extractDocument(
    document([page(items.map((i) => item(i.text, i.x, i.y, i.width, i.size, false)))])
  )
  const before = result.units.find((unit) => unit.source.includes(left))!
  const after = result.units.find((unit) => unit.source.includes(right))!
  assert.ok(before && after)
  assert.notEqual(before.id, after.id)
  assert.equal(result.units.find((unit) => unit.source === operand)?.sourceOnly, true)
  assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
})

test.each(
  readPdfTranslationCases<{ name: string; source: string; preserved: boolean }>(
    'standalone-symbolic-expressions-and-prose.jsonl'
  ).concat(readPdfTranslationCases('indexed-named-function-expressions.jsonl'))
)('$name', ({ source, preserved }) => {
  const result = extractDocument(document([page([item(source, 40, 100)])]))
  assert.equal(Boolean(result.units[0].sourceOnly), preserved)
})

test.each(
  readPdfTranslationCases<{
    name: string
    operator: string
    fontDescent: number
    fontAscent?: number
    width?: number
    preserved?: boolean
    limit?: { x: number; y: number; size: number; preserved: boolean }
  }>('descending-math-operator-body-boundaries.jsonl')
)('$name', ({ operator, fontDescent, fontAscent, width = 10, preserved = true, limit }) => {
  const result = extractDocument(
    document([
      page([
        item('The measurement remains stable.', 40, 100, 170, 10, false),
        {
          ...item(operator, limit ? 240 : 40, limit ? 150 : 104.4, width, 10, false),
          fontDescent,
          fontAscent
        },
        ...(limit ? [item('T', limit.x, limit.y, 4, limit.size, false)] : [])
      ])
    ])
  )
  const prose = result.units.find((unit) => unit.source.includes('measurement'))!
  if (preserved) {
    assert.equal(prose.source, 'The measurement remains stable.')
    assert.equal(result.units.find((unit) => unit.source === operator)?.sourceOnly, true)
  } else {
    assert.ok(prose.source.includes(operator))
    assert.equal(prose.sourceOnly, undefined)
  }
  if (limit)
    assert.equal(
      Boolean(result.units.find((unit) => unit.source === 'T')?.sourceOnly),
      limit.preserved
    )
  assert.equal(result.units.flatMap((unit) => unit.items).length, limit ? 3 : 2)
})

test.each(
  readPdfTranslationCases<{
    name: string
    items: Array<{ text: string; x: number; y: number; width: number; size: number }>
    expected: string
  }>('inline-fraction-source-order.jsonl').concat(
    readPdfTranslationCases<{
      name: string
      items: Array<{ text: string; x: number; y: number; width: number; size: number }>
      expected: string
    }>('inline-floor-fraction-prose-order.jsonl')
  )
)('$name', ({ items, expected }) => {
  const result = extractDocument(
    document([page(items.map((i) => item(i.text, i.x, i.y, i.width, i.size, false)))])
  )
  assert.equal(result.units[0].source, expected)
  assert.deepEqual(
    result.units.flatMap((unit) => unit.originalStrings).sort(),
    items.map((i) => i.text).sort()
  )
})

test.each(
  readPdfTranslationCases<{
    name: string
    items: Array<{ text: string; x: number; y: number; width: number; size: number }>
    preserved: boolean
  }>('stacked-fraction-source-boundaries.jsonl')
)('$name', ({ items, preserved }) => {
  const result = extractDocument(
    document([page(items.map((i) => item(i.text, i.x, i.y, i.width, i.size)))])
  )
  const formula = result.units.find((unit) => unit.source.includes('r ate'))!
  assert.ok(formula)
  assert.equal(Boolean(formula.sourceOnly), preserved)
  assert.equal(
    result.units.find((unit) => unit.source.includes('Nearby prose'))?.sourceOnly,
    undefined
  )
  assert.deepEqual(
    result.units.flatMap((unit) => unit.originalStrings).sort(),
    items.map((i) => i.text).sort()
  )
})

test.each(
  readPdfTranslationCases<{
    name: string
    items: Array<{ text: string; x: number; y: number; width: number; size: number }>
    expected: string
  }>('raised-power-of-ten-source.jsonl')
)('$name', ({ items, expected }) => {
  const result = extractDocument(
    document([page(items.map((i) => item(i.text, i.x, i.y, i.width, i.size, false)))])
  )
  assert.equal(result.units[0].source, expected)
  assert.deepEqual(
    result.units[0].originalStrings,
    items.map((i) => i.text)
  )
})

test.each(
  readPdfTranslationCases<{
    name: string
    pages: Array<{
      number: number
      lines: Array<{ text: string; x: number; y: number; width: number; size: number }>
    }>
    groups: number[][]
    preserved: number[]
  }>('cross-page-continuations-and-preserved-boundaries.jsonl')
)('$name', ({ pages, groups, preserved }) => {
  const result = extractDocument(
    document(
      pages.map(({ number, lines }) =>
        page(
          lines.map((line) => item(line.text, line.x, line.y, line.width, line.size)),
          number
        )
      )
    )
  )
  assert.deepEqual(
    result.units.map((unit) => unit.fragments.map((fragment) => fragment.page)),
    groups
  )
  assert.deepEqual(
    result.units.flatMap((unit, index) => (unit.sourceOnly ? [index] : [])),
    preserved
  )
  assert.equal(
    result.joins.length,
    groups.reduce((count, group) => count + group.length - 1, 0)
  )
  // Every source item must survive exactly once, including running page numbers.
  assert.deepEqual(
    result.units.flatMap((unit) => unit.originalStrings).sort(),
    pages.flatMap(({ lines }) => lines.map(({ text }) => text)).sort()
  )
})

test.each(
  readPdfTranslationCases<{
    name: string
    pages: Array<Array<{ text: string; x: number; y: number; width?: number; size?: number }>>
    preservedFrom?: string
    resumeFrom?: string
  }>('bibliography-boundaries-and-numbered-body.jsonl')
)('$name', ({ pages, preservedFrom, resumeFrom }) => {
  const d = extractDocument(
    document(
      pages.map((lines, index) =>
        page(
          lines.map((line) => item(line.text, line.x, line.y, line.width, line.size)),
          index + 1
        )
      )
    )
  )
  if (!preservedFrom) {
    assert.ok(d.units.every((u) => !u.sourceOnly))
    return
  }
  const start = d.units.findIndex((u) => u.source === preservedFrom)
  const end = d.units.findIndex((u) => u.source === resumeFrom)
  assert.ok(start > 0 && end > start)
  assert.ok(d.units.slice(0, start).every((u) => !u.sourceOnly))
  assert.ok(d.units.slice(start, end).every((u) => u.sourceOnly))
  assert.ok(d.units.slice(end).every((u) => !u.sourceOnly))
})

test.each(
  readPdfTranslationCases<{
    name: string
    pages: Array<Array<{ text: string; x: number; y: number; width: number; size: number }>>
    preserved: string[]
    translated: string[]
  }>('narrow-column-bibliography-reading-order.jsonl')
)('$name', ({ pages, preserved, translated }) => {
  const result = extractDocument(
    document(
      pages.map((lines, index) =>
        page(
          lines.map((line) => item(line.text, line.x, line.y, line.width, line.size)),
          index + 1
        )
      )
    )
  )
  for (const source of preserved)
    assert.equal(result.units.find((unit) => unit.source === source)?.sourceOnly, true, source)
  for (const source of translated) {
    const unit = result.units.find((unit) => unit.source === source)
    assert.ok(unit, source)
    assert.equal(Boolean(unit.sourceOnly), false, source)
  }
  assert.deepEqual(
    result.units.flatMap((unit) => unit.originalStrings).sort(),
    pages.flatMap((lines) => lines.map((line) => line.text)).sort()
  )
})

test('keeps a two-column body continuation translatable after a reference heading', () => {
  const result = extractDocument(
    document([
      page([
        item('Discussion', 40, 80, 120, 12),
        item('References', 330, 80, 120, 12),
        item(
          'Bengio, Yoshua and Glorot, Xavier. Understanding the difficulty of training deep feedforward neural networks.',
          330,
          120,
          230
        ),
        item(
          'Interestingly, our method bears similarity to the standardization layer, though the methods stem from different goals and perform different tasks.',
          40,
          180,
          230
        ),
        item(
          'Dean, Jeffrey, Corrado, Greg S., and Ng, Andrew Y. Large scale distributed deep networks.',
          330,
          220,
          230
        )
      ])
    ])
  )
  assert.equal(
    result.units.find((unit) => unit.source.startsWith('Interestingly, our method'))?.sourceOnly,
    undefined
  )
  assert.equal(
    result.units.find((unit) => unit.source.startsWith('Bengio, Yoshua'))?.sourceOnly,
    true
  )
  assert.equal(
    result.units.find((unit) => unit.source.startsWith('Dean, Jeffrey'))?.sourceOnly,
    true
  )
})

test('explicit native line completion preserves justified words across wide gaps', () => {
  const p = page([
    item('Ethical', 40, 100, 30, 10, false),
    item('clearance', 90, 100, 40, 10, false),
    item('number', 165, 100, 30)
  ])
  assert.equal(extractPage(p).blocks[0].source, 'Ethical clearance number')
})

test('an unfinished native line is not evidence for joining separate columns', () => {
  const p = page([
    item('Left column', 40, 100, 240, 10, false),
    item('Right column', 330, 100, 240, 10, false)
  ])
  assert.equal(extractPage(p).blocks.length, 2)
  p.items[1].hasEOL = true
  assert.equal(extractPage(p).blocks.length, 2)
})

test('adaptive leading retains every double-spaced line and recognizes a new indent', () => {
  const lines = [
    'The first paragraph contains enough printed text to establish line spacing',
    'and this second line continues without skipping any of the original words',
    'until this final line reaches its end.',
    'The next paragraph begins with a clearly visible first-line indentation',
    'and its second line returns to the common left edge of the body text.'
  ]
  const p = page(
    lines.map((text, i) =>
      item(text, [0, 3].includes(i) ? 58 : 40, 100 + i * 24, i === 2 ? 180 : 360)
    )
  )
  const blocks = extractPage(p).blocks
  assert.equal(blocks.length, 2)
  assert.deepEqual(
    blocks.map((b) => b.items.length),
    [3, 2]
  )
})

const before = 'The patients in this study described a number of difficulties with their daily'
const after = 'activities and this continuation belongs to the same sentence on the next page.'
test('cross-page continuation retains distinct physical anchors', () => {
  const d = extractDocument(
    document([page([item(before, 330, 700)]), page([item(after, 40, 100)], 2)])
  )
  assert.equal(d.joins.length, 1)
  assert.equal(d.units.length, 1)
  assert.deepEqual(
    d.units[0].fragments.map((f) => f.page),
    [1, 2]
  )
  assert.ok(d.units[0].source.includes('daily activities'))
})

test('headings, skipped pages and short intervening body lines prevent unsafe joins', () => {
  const first = page([item(before, 330, 700)])
  for (const second of [
    page([item('Results', 40, 65, 80, 11), item(after, 40, 100)], 2),
    page([item(after, 40, 100)], 3),
    page([item('Unclassified short body line.', 40, 65, 180), item(after, 40, 100)], 2)
  ]) {
    assert.equal(extractDocument(document([first, second])).joins.length, 0)
  }
})

test.each(['table', 'heading', 'body', 'complete'] as const)(
  'joins a broken-word page tail past only a proven floating table: %s',
  (kind) => {
    const prefix = 'The measured response changes with the input scale of each sample and we ap-'
    const tail =
      'ply the same setting to all measured samples and report the final response separately.'
    const rows = [100, 112, 124].flatMap((y, index) => [
      item(
        index === 0 ? 'apply' : `Method ${String.fromCharCode(65 + index)}`,
        40,
        y,
        50,
        10,
        false
      ),
      item(String(462 - index), 160, y, 20, 10, false),
      item(String(32 - index), 230, y, 20)
    ])
    const inputs = [
      item('Table 2. Measured responses', 40, 85, 190, 9),
      ...rows,
      ...(kind === 'heading' ? [item('Results', 40, 145, 80, 11)] : []),
      ...(kind === 'body' ? [item('An independent body note.', 40, 145, 180)] : []),
      item(tail, 40, 170, 240)
    ]
    const result = extractDocument(
      document([
        page([item(kind === 'complete' ? prefix.replace('ap-', 'apply.') : prefix, 330, 700)]),
        page(inputs, 2)
      ])
    )
    assert.equal(result.joins.length, kind === 'table' ? 1 : 0)
    if (kind === 'table') {
      const paragraph = result.units.find((unit) => unit.source.startsWith('The measured'))!
      assert.deepEqual(
        paragraph.fragments.map((fragment) => fragment.page),
        [1, 2]
      )
      assert.ok(paragraph.source.includes('apply the same'))
      assert.ok(!paragraph.source.includes('Measured responses'))
    }
    assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length + 1)
  }
)

test('ambiguous visible hyphens survive; independent source spelling permits dehyphenation', () => {
  const d = extractDocument(
    document([
      page([
        item('The outcome was recorded through a participant-', 40, 100),
        item('completed questionnaire.', 40, 112),
        item('Independent measurement was validated.', 40, 160),
        item('A different measure-', 40, 200),
        item('ment was retained.', 40, 212)
      ])
    ])
  )
  assert.ok(
    d.units.some(
      (u) => u.source.includes('participant-completed') && u.risks.includes('ambiguous-line-hyphen')
    )
  )
  assert.ok(d.units.some((u) => u.source.includes('measurement was retained')))
})

test('keeps formula text with damaged PDF ligature extraction in the original', () => {
  const p = page([
    item(
      'The method uses pffiffiffiffiffi in a formula and continues with enough prose to remain a paragraph.',
      40,
      100,
      500
    )
  ])
  const result = extractDocument(document([p]))
  assert.equal(result.units.length, 1)
  assert.equal(result.units[0].sourceOnly, true)
  assert.ok(result.units[0].risks.includes('formula-extraction'))
})

test.each(
  readPdfTranslationCases<{
    name: string
    top: number
    pageNumber: number
    markerSize: number
    rise: number
    separate: boolean
  }>('numbered-affiliation-row-boundaries.jsonl')
)('$name', ({ top, pageNumber, markerSize, rise, separate }) => {
  const inputs = [
    item('Ada Example', 260, top, 100),
    item('1', 240, top + 12 - rise, 4, markerSize, false),
    item('School of Computing, Example University', 244, top + 12, 140),
    item('2', 220, top + 24 - rise, 4, markerSize, false),
    item('Institute of Science, Another University', 224, top + 24, 180)
  ]
  const result = extractDocument(document([page(inputs, pageNumber)]))
  assert.equal(result.units.length, separate ? 3 : 1)
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
  if (separate) {
    assert.equal(result.units[0].source, 'Ada Example')
    assert.ok(result.units[1].source.startsWith('1School'))
    assert.ok(result.units[2].source.startsWith('2Institute'))
  }
})

test('keeps author metadata with superscript markers in the original', () => {
  const p = page([
    item('Sara Stoudt 1,2☯, Valeri N. Vasquez 1,3☯, Ciera C. Martinez 1,4*', 40, 100, 500)
  ])
  const result = extractDocument(document([p]))
  assert.equal(result.units[0].sourceOnly, true)
  assert.ok(result.units[0].risks.includes('metadata-extraction'))
})

test('three-em first-line rounding joins the return line but preserves a new indent', () => {
  const p = page([
    item('Context. This first sentence contains enough words to continue', 70.01, 100, 340),
    item('on the following line and retain its paragraph identity.', 40, 124, 360),
    item('Objectives. A different paragraph begins at the same indented position', 70.01, 148, 340),
    item('and continues here until its final sentence.', 40, 172, 280)
  ])
  assert.deepEqual(
    extractPage(p).blocks.map((b) => b.items.length),
    [2, 2]
  )
  const references = page([
    item('A complete reference entry ends here. Journal 2020;3:42.', 70.01, 100, 340),
    item('4. A different reference begins on the following printed line', 40, 124, 360)
  ])
  assert.equal(extractPage(references).blocks.length, 2)
})

test('short lower-case prose tails join, while numeric rows and headings remain separate', () => {
  const first = item('No significant differences were seen for cosmetic outcomes and', 58, 100, 230)
  for (const [text, count] of [
    ['pain scores.', 1],
    ['12.34', 2],
    ['Results.', 2]
  ] as const) {
    const p = page([first, item(text, 40, 112, 50)])
    assert.equal(extractPage(p).blocks.length, count, text)
  }
})

test('explicit keyword metadata stays separate after a full-width paragraph ending', () => {
  const p = page([
    item('The conclusion contains sufficiently long text to span the full column.', 40, 100, 340),
    item('Keywords: yoga, meditation, cancer pain, metastatic breast cancer', 40, 112, 350)
  ])
  assert.equal(extractPage(p).blocks.length, 2)
})

test('standalone same-size styled headings separate without splitting inline emphasis', () => {
  const styled = (text: string, x: number, y: number, width: number, fontName: string) => ({
    ...item(text, x, y, width),
    fontName
  })
  const p = page([
    styled(
      'The preceding paragraph ends with sufficiently long text in this line.',
      40,
      100,
      400,
      'body'
    ),
    styled('Treatment effects on daily pain', 40, 112, 170, 'emphasis'),
    styled(
      'This following paragraph contains a label and continues in the same text block',
      55,
      124,
      400,
      'body'
    ),
    styled('The statistical ', 40, 136, 66, 'body'),
    styled('F', 106, 136, 5, 'emphasis'),
    styled(' value remains part of the surrounding sentence.', 111, 136, 230, 'body')
  ])
  const blocks = extractPage(p).blocks
  assert.equal(blocks.length, 3)
  assert.equal(blocks[1].source, 'Treatment effects on daily pain')
  assert.equal(blocks[2].items.length, 4)
})

test('line-initial styled labels separate abstract sections without splitting their continuations', () => {
  const styled = (text: string, x: number, y: number, width: number, fontName = 'body') => ({
    ...item(text, x, y, width),
    fontName
  })
  for (const labelFont of ['label', 'body']) {
    const p = page([
      styled('Design:', 40, 100, 35, labelFont),
      styled('The study examined participants over several visits.', 80, 100, 310),
      styled('All follow-up assessments were conducted as scheduled.', 40, 112, 350),
      styled('Findings:', 40, 124, 40, labelFont),
      styled('The groups did not differ in the primary outcome.', 85, 124, 305),
      styled('The difference was small at all subsequent visits.', 40, 136, 340),
      styled('The ', 40, 148, 20),
      styled('secondary', 60, 148, 45, 'label'),
      styled(' outcome also remained unchanged.', 105, 148, 220)
    ])
    const blocks = extractPage(p).blocks
    assert.deepEqual(
      blocks.map((block) => block.items.length),
      labelFont === 'label' ? [3, 6] : [9]
    )
  }
})

test('larger styled headings separate from flush-left body without promoting smaller styled lines', () => {
  for (const headingSize of [11, 10, 9]) {
    const p = page([
      {
        ...item('Study design and eligibility criteria', 40, 100, 200, headingSize),
        fontName: 'heading'
      },
      {
        ...item(
          'The randomized study enrolled eligible participants from the clinic',
          40,
          116,
          300
        ),
        fontName: 'body'
      },
      {
        ...item('and followed their outcomes over the entire observation period.', 40, 128, 300),
        fontName: 'body'
      }
    ])
    assert.deepEqual(
      extractPage(p).blocks.map((block) => block.items.length),
      headingSize === 11 ? [1, 2] : [3]
    )
  }
})

test('a styled label wrapping inside a numbered sentence remains in its paragraph', () => {
  const p = page([
    {
      ...item('We assessed (1) Retention: the completed visits and (2)', 40, 100, 350),
      fontName: 'body'
    },
    { ...item('Adherence:', 40, 112, 50), fontName: 'label' },
    {
      ...item('the number of days with completed self-monitoring.', 95, 112, 295),
      fontName: 'body'
    }
  ])
  assert.deepEqual(
    extractPage(p).blocks.map((block) => block.items.length),
    [3]
  )
})

test('numbered entries retain hanging lines and short numeric year tails', () => {
  const p = page([
    item('1.', 40, 100, 10, 10, false),
    item('Author A. A reference entry with a long title', 70, 100, 260),
    item('The continuation belongs to the first entry.', 70, 112, 220),
    item('2020;4:8.', 70, 124, 40),
    item('2.', 40, 136, 10, 10, false),
    item('Author B. A different reference entry', 70, 136, 230),
    item('More source text for the second reference.', 70, 148, 230),
    item('5.2', 400, 148, 20)
  ])
  const blocks = extractPage(p).blocks
  const first = blocks.find((b) => b.items.includes('1:0')),
    second = blocks.find((b) => b.items.includes('1:4'))
  assert.ok(first && second)
  assert.deepEqual(first.items, ['1:0', '1:1', '1:2', '1:3'])
  assert.deepEqual(second.items, ['1:4', '1:5', '1:6'])
  assert.ok(!first.items.includes('1:7') && !second.items.includes('1:7'))
})

test('a short hyphenated ending remains with its preceding scientific phrase', () => {
  const p = page([
    item('The rates were strongly correlated with attendance (Pearson two-', 40, 100, 360, 12),
    item('tailed).', 40.0006, 115, 30, 12)
  ])
  const d = extractDocument(document([p]))
  assert.equal(d.units.length, 1)
  assert.ok(d.units[0].source.endsWith('two-tailed).'))
})

test('square-bracket numbered entries do not become cross-column prose continuations', () => {
  const d = extractDocument(
    document([
      page([
        item(
          '[11] Author A. This reference contains enough printed words for the prose length gate',
          40,
          700,
          240
        ),
        item(
          'continued source words on the right column should not be presumed to be body prose',
          330,
          100,
          240
        )
      ])
    ])
  )
  assert.equal(d.joins.length, 0)
})

test('a narrow terminal word joins a multiline paragraph, not an isolated label', () => {
  const lines = [
    item('The library offers several ways of displaying observations and supports', 40, 100, 240),
    item('a consistent mapping between visual properties and each semantic variable', 40, 112, 240)
  ]
  for (const [tail, x, count] of [
    ['type.', 40, 1],
    ['of 2.75%.', 40, 1],
    ['2.75%.', 40, 2],
    ['of 2.75%.', 330, 2],
    ['Type.', 40, 2],
    ['3.14', 40, 2],
    ['type.', 330, 2]
  ] as const)
    assert.equal(extractPage(page([...lines, item(tail, x, 124, 20)])).blocks.length, count, tail)
  assert.equal(extractPage(page([lines[1], item('type.', 40, 124, 20)])).blocks.length, 2)
})

test('keeps superscripts with their native line across staggered columns', () => {
  const p = page([
    item('Left paragraph ends here.', 40, 200, 200, 9.25, false),
    item('24', 240, 196.64, 8, 7.03, false),
    item(' and continues.', 250, 200, 30),
    // Its baseline is closer to the left superscript than the left body baseline.
    item('Right column begins here.', 330, 194.87, 230, 9.25),
    item('Next line in the left paragraph.', 40, 211, 240, 9.25)
  ])
  const blocks = extractPage(p).blocks
  assert.ok(blocks.some((block) => block.source.includes('here.24 and continues.')))
  assert.ok(!blocks.some((block) => block.source === '24'))
  assert.equal(blocks.flatMap((block) => block.items).length, p.items.length)
})

test.each(
  readPdfTranslationCases<{
    name: string
    items: Array<{ text: string; x: number; y: number; width: number; size: number }>
    fraction: string
    prefix: string
    continuation: string
  }>('inline-fraction-body-boundaries.jsonl')
)('$name', ({ items, fraction, prefix, continuation }) => {
  const result = extractDocument(
    document([page(items.map((i) => item(i.text, i.x, i.y, i.width, i.size, false)))])
  )
  assert.equal(result.units.find((unit) => unit.source === fraction)?.sourceOnly, true)
  assert.ok(result.units.some((unit) => unit.source === prefix && !unit.sourceOnly))
  assert.ok(result.units.some((unit) => unit.source === continuation && !unit.sourceOnly))
  assert.deepEqual(
    result.units.flatMap((unit) => unit.originalStrings).sort(),
    items.map((i) => i.text).sort()
  )
})

test.each(
  readPdfTranslationCases<{
    name: string
    first: string
    tail: string
    change: string
    combined?: boolean
    joined?: string
  }>('hanging-hyphenated-heading-boundaries.jsonl')
)('$name', ({ first, tail, change, combined, joined }) => {
  const items = [
    ...(combined
      ? [{ ...item(`3.2 ${first}`, 40, 100, 206, 12), fontName: 'heading' }]
      : [
          { ...item('3.2', 40, 100, 18, 12, false), fontName: 'heading' },
          { ...item(first, 66, 100, 180, 12), fontName: 'heading' }
        ]),
    ...(!combined || change === 'intervening'
      ? [{ ...item('A separate column remains independent.', 330, 108, 210, 10), fontName: 'body' }]
      : []),
    {
      ...item(tail, change === 'column' ? 330 : 66, change === 'gap' ? 150 : 114, 140, 12),
      fontName: change === 'style' ? 'different' : 'heading'
    },
    {
      ...item(
        'These networks provide sufficiently detailed body text to identify the ordinary document style.',
        40,
        180,
        260,
        10
      ),
      fontName: 'body'
    }
  ]
  const result = extractDocument(document([page(items)])),
    sources = result.units.map((u) => u.source)
  if (joined) assert.ok(sources.includes(joined), JSON.stringify(sources))
  else {
    assert.ok(sources.includes(`3.2 ${first}`), JSON.stringify(sources))
    assert.ok(sources.includes(tail), JSON.stringify(sources))
  }
  assert.equal(result.units.flatMap((u) => u.items).length, items.length)
})

test.each(
  readPdfTranslationCases<{ name: string; first: string; second: string; separate: boolean }>(
    'algorithm-comment-row-ownership.jsonl'
  )
)('$name', ({ first, second, separate }) => {
  const result = extractDocument(
    document([
      page([
        item('m ← 0', 40, 100, 30, 10, false),
        item(first, 75, 100, 200),
        ...(separate ? [item('v ← 0', 40, 112, 30, 10, false)] : []),
        item(second, 75, 112, 200)
      ])
    ])
  )
  const comments = result.units.filter((u) => !u.sourceOnly)
  assert.equal(comments.length, separate ? 2 : 1)
  assert.equal(comments.map((u) => u.source).join(' '), `${first} ${second}`)
  assert.deepEqual(
    result.units.flatMap((u) => u.originalStrings).sort(),
    ['m ← 0', first, ...(separate ? ['v ← 0'] : []), second].sort()
  )
})

test.each(
  readPdfTranslationCases<{ name: string; source: string; sourceOnly: boolean }>(
    'named-math-operators-preserve-source.jsonl'
  )
)('$name', ({ source, sourceOnly }) => {
  const result = extractDocument(document([page([item(source, 40, 100)])]))
  assert.equal(result.units.length, 1)
  assert.equal(Boolean(result.units[0].sourceOnly), sourceOnly)
  assert.equal(result.units[0].source, source)
})

test.each(
  readPdfTranslationCases<{
    name: string
    top: number
    secondFont: string
    expectedJoined: boolean
    horizontalOffset?: number
    leftAligned?: boolean
    intervening?: boolean
    gap?: number
  }>('centered-wrapped-paper-title.jsonl')
)(
  '$name',
  ({
    top,
    secondFont,
    expectedJoined,
    horizontalOffset = 0,
    leftAligned,
    intervening,
    gap = 23
  }) => {
    const first = 'Efficient Computing with Only One',
      second = leftAligned ? 'cache' : 'Shared Cache'
    const result = extractDocument(
      document([
        page([
          { ...item(first, 120 + horizontalOffset, top, 360, 18), fontName: 'title' },
          ...(intervening ? [{ ...item('Note', 500, top, 40, 10), fontName: 'body' }] : []),
          {
            ...item(
              second,
              (leftAligned ? 120 : 250) + horizontalOffset,
              top + gap,
              leftAligned ? 45 : 100,
              18
            ),
            fontName: secondFont
          },
          { ...item('A. Researcher', 260, top + 65, 80, 12), fontName: 'author' },
          {
            ...item(
              'Ordinary body text provides an independent font size for the page.',
              40,
              top + 150,
              400,
              10
            ),
            fontName: 'body'
          },
          {
            ...item('Additional ordinary body text continues here.', 40, top + 162, 300, 10),
            fontName: 'body'
          }
        ])
      ])
    )
    assert.equal(
      result.units.some((unit) => unit.source === first + ' ' + second),
      expectedJoined
    )
    assert.equal(result.units.flatMap((unit) => unit.items).length, intervening ? 6 : 5)
  }
)

test.each(
  readPdfTranslationCases<{ name: string; header: string; body: string[]; preserved: boolean }>(
    'indented-python-listing-preserves-source.jsonl'
  )
)('$name', ({ header, body, preserved }) => {
  const texts = [header, ...body]
  const prose = 'The surrounding explanation must still be translated.'
  const items = [
    item(header, 60, 80, 240),
    ...body.map((text, index) => item(text, 75, 92 + index * 12, 260)),
    item(prose, 60, 92 + body.length * 12, 340)
  ]
  const result = extractDocument(document([page(items)]))
  if (preserved) {
    for (const text of texts)
      assert.equal(
        result.units.find((unit) => unit.originalStrings.includes(text))?.sourceOnly,
        true
      )
  } else assert.ok(result.units.some((unit) => !unit.sourceOnly && unit.source.includes(body[0])))
  assert.ok(result.units.some((unit) => !unit.sourceOnly && unit.source.includes(prose)))
  assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
})

test.each(
  readPdfTranslationCases<{ name: string; prefix: string; preserved: boolean }>(
    'numeric-citation-before-prose.jsonl'
  )
)('$name', ({ prefix, preserved }) => {
  const result = extractDocument(
    document([
      page([
        item(prefix, 40, 100, 100, 10, false),
        item(']. These results remain consistent.', 140, 100, 200, 10, true)
      ])
    ])
  )
  assert.equal(
    result.units.find((unit) => unit.originalStrings.includes(prefix))?.sourceOnly === true,
    preserved
  )
  if (!preserved) {
    assert.equal(result.units.length, 1)
    assert.ok(result.units[0].source.includes('These results remain consistent.'))
  }
  assert.equal(result.units.flatMap((unit) => unit.items).length, 2)
})

test.each(
  readPdfTranslationCases<{ name: string; prefix: string }>('citation-lead-in-is-not-formula.jsonl')
)('$name', ({ prefix }) => {
  const texts = [prefix, 'Example et al., 2020', '], we compare the two methods.']
  const result = extractDocument(
    document([
      page([
        item(texts[0], 40, 100, 60, 10, false),
        item(texts[1], 100, 100, 100, 10, false),
        item(texts[2], 200, 100, 180, 10, true)
      ])
    ])
  )
  assert.equal(result.units.length, 1)
  assert.ok(!result.units[0].sourceOnly)
  assert.ok(result.units[0].source.startsWith(prefix))
  assert.deepEqual(result.units[0].originalStrings, texts)
})

test.each(
  readPdfTranslationCases<{
    name: string
    first: string
    next: string
    gap: number
    joined: boolean
    nextWidth?: number
    nextX?: number
  }>('wrapped-caption-numeric-parameter.jsonl')
)('$name', ({ first, next, gap, joined, nextWidth = 360, nextX = 40 }) => {
  const result = extractDocument(
    document([page([item(first, 40, 100, 480), item(next, nextX, 100 + gap, nextWidth)])])
  )
  assert.equal(
    result.units.some((unit) => unit.source === first + ' ' + next),
    joined
  )
  assert.equal(result.units.flatMap((unit) => unit.items).length, 2)
})

test.each(
  readPdfTranslationCases<{
    name: string
    tail: string
    joined: boolean
    tailFirst?: boolean
    continued?: boolean
  }>('formula-prose-short-wrap.jsonl')
)('$name', ({ tail, joined, tailFirst, continued }) => {
  const first = 'we can use a larger batch when memory'
  const tailItem = item(tail, 40, continued ? 124 : 112, 100)
  const inputs = [
    item('1', 150, 96, 4, 7, false),
    item('N', 149, 103.5, 6, 7, false),
    item(first, 180, 100, 350),
    ...(continued ? [item('is allocated according to the estimated workload', 180, 112, 350)] : [])
  ]
  if (tailFirst) inputs.unshift(tailItem)
  else inputs.push(tailItem)
  const result = extractDocument(document([page(inputs)]))
  assert.equal(
    result.units.some((u) => u.source.includes(first) && u.source.endsWith(tail)),
    joined
  )
  assert.equal(result.units.flatMap((u) => u.items).length, inputs.length)
})

test.each(
  readPdfTranslationCases<{ name: string; first: string; next: string; expected: string }>(
    'hyphenated-prose-before-formula.jsonl'
  )
)('$name', ({ first, next, expected }) => {
  const result = extractDocument(
    document([
      page([
        item(first, 60, 100, 420),
        item(next, 40, 112, 50),
        item('1', 110, 108, 4, 7, false),
        item('N', 109, 115.5, 6, 7, false),
        item(').', 125, 112, 10),
        item('These operations are counted.', 40, 180, 240)
      ])
    ])
  )
  assert.ok(result.units.some((u) => u.source === expected))
  assert.ok(result.units.some((u) => u.sourceOnly && u.source === '1/N'))
  assert.equal(result.units.flatMap((u) => u.items).length, 6)
})

test.each(
  readPdfTranslationCases<{
    name: string
    rows: number
    columnDrift: number
    table: boolean
    boldLastValue: boolean
  }>('aligned-numeric-table-cells.jsonl')
)('$name', ({ rows, columnDrift, table, boldLastValue }) => {
  const inputs = [
    item('Method', 50, 100, 35, 10, false),
    item('Training', 110, 100, 35, 10, false),
    item('Inference', 170, 100, 40, 10, false),
    item('Search', 240, 100, 35, 10, true),
    ...Array.from({ length: rows }, (_, row) => {
      const y = 124 + row * 12
      const drift = columnDrift * row
      return [
        item(`variant-${String.fromCharCode(97 + row)}`, 50, y, 40, 10, false),
        item(`${11 + row}.2`, 115 + drift, y, 20, 10, false),
        item(`${21 + row}.3`, 175 + drift, y, 20, 10, false),
        ...(boldLastValue
          ? [
              item('2.4 /', 245 + drift, y, 20, 10, false),
              { ...item('3.5', 268 + drift, y, 15, 10, true), fontName: 'bold' }
            ]
          : [item('31.4', 245 + drift, y, 20, 10, true)])
      ]
    }).flat()
  ]
  const result = extractDocument(document([page(inputs)]))
  assert.deepEqual(
    result.units.flatMap((u) => u.originalStrings).sort(),
    inputs.map((i) => i.str).sort()
  )
  if (!table) {
    assert.ok(result.units.some((u) => u.source.includes('variant-a') && u.source.includes('11.2')))
    return
  }
  for (const label of ['Method', 'Training', 'Inference', 'Search'])
    assert.ok(result.units.some((u) => u.source === label && !u.sourceOnly))
  for (let row = 0; row < rows; row++) {
    assert.ok(
      result.units.some(
        (u) => u.source === `variant-${String.fromCharCode(97 + row)}` && !u.sourceOnly
      )
    )
    for (const value of [`${11 + row}.2`, `${21 + row}.3`, boldLastValue ? '2.4 / 3.5' : '31.4']) {
      const cell = result.units.find(
        (u) => u.source === value && u.fragments[0].rect.y > 110 + row * 12
      )
      assert.ok(cell?.sourceOnly, value)
      assert.equal(cell.fragments.length, 1)
      assert.ok(cell.fragments[0].rect.bottom - cell.fragments[0].rect.y < 12)
    }
  }
})

test.each(
  readPdfTranslationCases<{
    name: string
    sign: string
    rows: number
    drift: number
    gap: number
    table: boolean
  }>('signed-two-column-table.jsonl')
)('$name', ({ sign, rows, drift, gap, table }) => {
  const inputs = Array.from({ length: rows }, (_, row) => {
    const y = 120 + row * 12
    return [
      ...(row < rows - 1
        ? [
            item('L', 50, y, 7, 10, false),
            item('ab', 57, y + 1.5, 8, 7, false),
            item('- ∅', 68, y, 18, 10, false)
          ]
        : [item('Random initialization', 50, y, 100, 10, false)]),
      item(`${sign}${row + 1}.25`, 150 + gap + row * drift, y, 25)
    ]
  }).flat()
  const result = extractDocument(document([page(inputs)]))
  assert.equal(result.units.flatMap((u) => u.items).length, inputs.length)
  const label = result.units.find((u) => u.source === 'Random initialization')
  const formula = result.units.find((u) => u.source === 'Lab - ∅')
  if (!table) {
    assert.ok(!label || !formula?.sourceOnly)
    return
  }
  assert.ok(label && !label.sourceOnly)
  assert.equal(result.units.filter((u) => u.source === 'Lab - ∅' && u.sourceOnly).length, rows - 1)
  for (let row = 0; row < rows; row++)
    assert.ok(result.units.some((u) => u.source === `${sign}${row + 1}.25` && u.sourceOnly))
  assert.ok(result.units.every((u) => u.fragments[0].rect.bottom - u.fragments[0].rect.y < 14))
})

test.each(
  readPdfTranslationCases<{ name: string; value: string; drift: number; table: boolean }>(
    'scientific-notation-table-columns.jsonl'
  )
)('$name', ({ value, drift, table }) => {
  const inputs = [0, 1, 2].flatMap((row) => [
    item(`Variant ${String.fromCharCode(65 + row)}`, 50, 120 + row * 12, 50, 10, false),
    item(value, 160 + row * drift, 120 + row * 12, 50, 10, false),
    item(`${70 + row}.2%`, 260 + row * drift, 120 + row * 12, 30)
  ])
  const result = extractDocument(document([page(inputs)]))
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
  assert.equal(
    result.units.filter((unit) => unit.source === value && unit.sourceOnly).length,
    table ? 3 : 0
  )
  if (table)
    assert.equal(result.units.filter((unit) => /^Variant [A-C]$/u.test(unit.source)).length, 3)
})

test.each(
  readPdfTranslationCases<{ name: string; drift: number; rowGap: number; table: boolean }>(
    'sparse-score-table-columns.jsonl'
  )
)('$name', ({ drift, rowGap, table }) => {
  const inputs = Array.from({ length: 4 }, (_, row) => {
    const y = 120 + row * rowGap + (row === 3 ? 4 : 0)
    return [
      item(`Variant ${String.fromCharCode(65 + row)}`, 50, y, 50, 10, false),
      ...(row % 2 ? [item('1', 280, y, 5, 10, false)] : []),
      item(`${row + 1}.25`, 380 + row * drift, y, 25)
    ]
  }).flat()
  const result = extractDocument(document([page(inputs)]))
  assert.equal(result.units.flatMap((u) => u.items).length, inputs.length)
  for (let row = 0; row < 4; row++) {
    const label = result.units.find((u) => u.source === `Variant ${String.fromCharCode(65 + row)}`)
    assert.equal(
      result.pages[0].blocks.some(
        (block) => block.tableCell && block.source === `Variant ${String.fromCharCode(65 + row)}`
      ),
      table
    )
    if (table) assert.equal(label!.fragments[0].rect.x, 50)
    if (table) {
      assert.ok(!label!.sourceOnly)
      const value = result.units.find((u) => u.source === `${row + 1}.25`)
      assert.ok(value?.sourceOnly)
      assert.ok(value.fragments[0].rect.bottom - value.fragments[0].rect.y < 12)
    }
  }
})

test.each(
  readPdfTranslationCases<{ name: string; rotation: number }>(
    'rotated-margin-stamp-column-order.jsonl'
  )
)('$name', ({ rotation }) => {
  const left = ['First left paragraph ends here.', 'Second left paragraph ends here.']
  const right = ['First right paragraph ends here.', 'Second right paragraph ends here.']
  const stamp = item('Example publication margin stamp', 20, 310, 340, 20)
  stamp.transform = [0, rotation * 20, -rotation * 20, 0, 20, 490]
  const result = extractDocument(
    document([
      page([
        item('A spanning paper title', 70, 90, 460, 18),
        item(left[0], 45, 260, 235),
        item(left[1], 45, 300, 235),
        item(right[0], 320, 240, 235),
        item(right[1], 320, 280, 235),
        stamp
      ])
    ])
  )
  assert.deepEqual(
    result.units.filter((u) => [...left, ...right].includes(u.source)).map((u) => u.source),
    [...left, ...right]
  )
  assert.equal(
    result.units.flatMap((u) => u.originalStrings).filter((text) => text === stamp.str).length,
    1
  )
})

test.each(
  readPdfTranslationCases<{ name: string; prefix: string; preserved: boolean }>(
    'cited-model-conjunction-prose.jsonl'
  )
)('$name', ({ prefix, preserved }) => {
  const result = extractDocument(
    document([
      page([
        item(prefix, 40, 100, 100, 10, false),
        item('OtherNet remains efficient in small networks.', 145, 100, 290, 10, true)
      ])
    ])
  )
  assert.equal(
    Boolean(result.units.find((u) => u.originalStrings.includes(prefix))?.sourceOnly),
    preserved
  )
  if (!preserved) assert.equal(result.units.length, 1)
  assert.equal(result.units.flatMap((u) => u.originalStrings).length, 2)
})

test.each(
  readPdfTranslationCases<{
    name: string
    rows: Array<{ label?: string; values: string[] }>
  }>('dimension-table-blank-label-rows.jsonl')
)('$name', ({ rows }) => {
  const headers = ['Layer', 'Output size', 'Stride', 'Repeat', 'Channels'].slice(
    0,
    rows[0].values.length + 1
  )
  const inputs = headers.map((text, i) =>
    item(text, 40 + i * 95, 100, 70, 10, i === headers.length - 1)
  )
  for (const [r, row] of rows.entries()) {
    if (row.label) inputs.push(item(row.label, 40, 127 + r * 12, 65, 10, false))
    row.values.forEach((text, c) =>
      inputs.push(item(text, 135 + c * 95, 127 + r * 12, 50, 10, c === row.values.length - 1))
    )
  }
  const result = extractDocument(document([page(inputs)]))
  assert.deepEqual(
    result.units.flatMap((u) => u.originalStrings).sort(),
    inputs.map((i) => i.str).sort()
  )
  for (const label of [...headers, ...rows.flatMap((row) => (row.label ? [row.label] : []))])
    assert.ok(
      result.units.some((u) => u.source === label && !u.sourceOnly),
      label
    )
  for (const value of rows.flatMap((row) => row.values))
    assert.ok(
      result.units.some((u) => u.source === value && u.sourceOnly),
      value
    )
})

test.each(
  readPdfTranslationCases<{
    name: string
    kind: 'authors' | 'roman' | 'formula'
    authors?: string[]
    affiliations?: string[]
    contacts?: string[]
    markers?: string[]
  }>('author-rows-and-roman-list-boundaries.jsonl')
)('$name', ({ kind, authors, affiliations, contacts, markers }) => {
  const items =
    kind === 'authors'
      ? authors!.flatMap((author, index) => [
          item(author, 40 + index * 180, 100, 100),
          item(affiliations![index], 40 + index * 180, 112, 110),
          item(contacts![index], 40 + index * 180, 124, 120)
        ])
      : markers!.flatMap((marker, index) => [
          item(marker, 40, 100 + index * 24, 12, 10, false),
          item('the method converges under this', 60, 100 + index * 24, 220),
          item('condition.', 60, 112 + index * 24, 48)
        ])
  const result = extractDocument(document([page(items)]))
  if (kind === 'authors') {
    for (const text of [...authors!, ...affiliations!, ...contacts!])
      assert.ok(
        result.units.some((u) => u.source === text),
        text
      )
  } else if (kind === 'roman') {
    for (const marker of markers!)
      assert.ok(
        result.units.some(
          (u) =>
            !u.sourceOnly && u.source === marker + ' the method converges under this condition.'
        ),
        marker
      )
  } else {
    assert.ok(result.units.some((u) => u.source === '(x)' && u.sourceOnly))
    assert.ok(result.units.some((u) => !u.sourceOnly && u.source.includes('the method')))
  }
  assert.deepEqual(
    result.units.flatMap((u) => u.originalStrings).sort(),
    items.map((i) => i.str).sort()
  )
})

test.each(
  readPdfTranslationCases<{ name: string; styled: boolean }>(
    'numbered-definition-paragraph-boundaries.jsonl'
  )
)('$name', ({ styled }) => {
  const texts = [
    { ...item('We introduce the following definitions.', 40, 100, 300), fontName: 'body' },
    { ...item('Definition 1 ', 40, 112, 55, 10, false), fontName: styled ? 'bold' : 'body' },
    { ...item('A function has the following property.', 95, 112, 245), fontName: 'body' },
    { ...item('Definition 2 ', 40, 124, 55, 10, false), fontName: styled ? 'bold' : 'body' },
    { ...item('A set satisfies the stated condition.', 95, 124, 245), fontName: 'body' }
  ]
  const result = extractDocument(document([page(texts)]))
  assert.equal(result.units.length, styled ? 3 : 1)
  if (styled) assert.ok(result.units.some((u) => u.source.startsWith('Definition 2')))
  assert.deepEqual(
    result.units.flatMap((u) => u.originalStrings).sort(),
    texts.map((i) => i.str).sort()
  )
})

test.each(
  readPdfTranslationCases<{ name: string; symbol: string; extension: boolean }>(
    'legacy-extension-bracket-source-ownership.jsonl'
  )
)('$name', ({ symbol, extension }) => {
  const items = [
    item('1', 40, 100, 5, 10, false),
    {
      ...item(symbol, 48, extension ? 95.7 : 100, 4.7, 10),
      fontAscent: extension ? 0.04 : 0.75,
      fontDescent: extension ? -0.6 : -0.25
    },
    item('The following sentence remains translatable.', 40, 140, 260)
  ]
  const result = extractDocument(document([page(items)]))
  const owner = result.units.find((unit) => unit.originalStrings.includes(symbol))!
  assert.equal(Boolean(owner.sourceOnly), extension)
  assert.equal(owner.source, extension ? symbol : `1 ${symbol}`)
  assert.ok(!result.units.find((unit) => unit.source.includes('following sentence'))?.sourceOnly)
  assert.deepEqual(
    result.units.flatMap((unit) => unit.originalStrings).sort(),
    items.map((i) => i.str).sort()
  )
})

test.each(
  readPdfTranslationCases<{ name: string; detached: boolean }>(
    'tall-inline-delimiter-prose-ownership.jsonl'
  )
)('$name', ({ detached }) => {
  const items = [
    item('exp(x)', 40, 100, 35, 10, false),
    {
      ...item(')', 77, detached ? 88.8 : 100, 6, 10, false),
      fontAscent: detached ? 0.04 : 0.75,
      fontDescent: detached ? -0.6 : -0.25
    },
    item('. The following sentence is ordinary prose.', 86, 100, 250, 10, false)
  ]
  const result = extractDocument(document([page(items)]))
  const prose = result.units.find((u) => u.source.includes('ordinary prose'))!
  assert.ok(!prose.sourceOnly)
  assert.ok(!prose.source.includes('exp(x)'))
  assert.equal(
    result.units.some((u) => u.source === ')' && u.sourceOnly),
    detached
  )
  assert.deepEqual(
    result.units.flatMap((u) => u.originalStrings).sort(),
    items.map((i) => i.str).sort()
  )
})

test.each(
  readPdfTranslationCases<{
    name: string
    operator: string
    offset: number
    size: number
    attached: boolean
  }>('named-operator-lower-limit-ownership.jsonl')
)('$name', ({ operator, offset, size, attached }) => {
  const items = [
    item(', where q ∈', 40, 100, 50, 10, false),
    item(operator, 92, 100, 32, 10, false),
    item('k', 114, 100 + offset, 4.2, size, false),
    item('ak', 126, 100, 10, 10, true)
  ]
  const result = extractDocument(document([page(items)]))
  const prose = result.units.find((u) => u.source.includes('where'))!
  assert.equal(prose.originalStrings.includes('k'), attached)
  assert.deepEqual(
    result.units.flatMap((u) => u.originalStrings).sort(),
    items.map((i) => i.str).sort()
  )
})

test.each(
  readPdfTranslationCases<{ name: string; symbol: string }>(
    'unmapped-control-glyph-prose-boundaries.jsonl'
  )
)('$name', ({ symbol }) => {
  const items = [
    item('The parameter approaches', 40, 100, 120, 10, false),
    item(symbol, 163, 100, 5, 10, false),
    item('under this condition.', 171, 100, 100, 10, true)
  ]
  const result = extractDocument(document([page(items)]))
  assert.ok(result.units.some((u) => u.source === symbol && u.sourceOnly))
  assert.ok(result.units.some((u) => u.source === 'The parameter approaches' && !u.sourceOnly))
  assert.ok(result.units.some((u) => u.source === 'under this condition.' && !u.sourceOnly))
  assert.deepEqual(
    result.units.flatMap((u) => u.originalStrings).sort(),
    items.map((i) => i.str).sort()
  )
})

test.each(
  readPdfTranslationCases<{
    name: string
    indexSize: number
    indexY: number
    prose?: string
    sourceOnly: boolean
  }>('standalone-letter-index-not-unit-name.jsonl')
)('$name', ({ indexSize, indexY, prose, sourceOnly }) => {
  const items = [
    item('m', 40, 100, 8, 10, false),
    item('l', 48, indexY, 3, indexSize, !prose),
    ...(prose ? [item(prose, 54, 100, 220)] : [])
  ]
  const result = extractDocument(document([page(items)]))
  assert.equal(result.units.length, 1)
  assert.equal(Boolean(result.units[0].sourceOnly), sourceOnly)
  assert.deepEqual(
    result.units[0].originalStrings,
    items.map((value) => value.str)
  )
})

test.each(
  readPdfTranslationCases<{ name: string; marker: string; start: string; nextMarker: string }>(
    'lowercase-list-hanging-continuation.jsonl'
  )
)('$name', ({ marker, start, nextMarker }) => {
  const first = `${start} is a composition of several blocks,`,
    tail = 'each containing a simple activation function.',
    next = `${start} also obeys a separate condition.`,
    items = [
      item(marker, 40, 100, 8, 10, false),
      item(first, 54, 100, 240),
      item(tail, 54, 112, 220),
      item(nextMarker, 40, 130, 8, 10, false),
      item(next, 54, 130, 240)
    ],
    result = extractDocument(document([page(items)]))
  assert.deepEqual(
    result.units.map((u) => u.source),
    [`${marker} ${first} ${tail}`, `${nextMarker} ${next}`]
  )
  assert.ok(result.units.every((u) => !u.sourceOnly))
  assert.deepEqual(
    result.units.flatMap((u) => u.items).sort(),
    items.map((_, i) => `1:${i}`).sort()
  )
})

test.each(
  readPdfTranslationCases<{ name: string; operator: string; operatorX: number; blocked: boolean }>(
    'raised-operator-reading-order-barrier.jsonl'
  )
)('$name', ({ operator, operatorX, blocked }) => {
  const prefix = 'The total is',
    continuation = 'the combined contribution of every component.',
    items = [
      item(prefix, 40, 100, 75, 10, false),
      {
        ...item(operator, operatorX, 92.5, 10, 10, false),
        fontAscent: 0.04,
        fontDescent: -0.6
      },
      ...(blocked ? [item('which grows in proportion to', 160, 100, 170)] : []),
      item(continuation, 40, 112, 290)
    ],
    result = extractDocument(document([page(items)])),
    before = result.units.find((unit) => unit.source.startsWith(prefix))!
  assert.ok(before)
  assert.equal(before.source.includes(continuation), !blocked)
  assert.deepEqual(
    result.units.flatMap((unit) => unit.originalStrings).sort(),
    items.map((entry) => entry.str).sort()
  )
})

test.each(
  readPdfTranslationCases<{
    name: string
    items: Array<{ text: string; x: number; y: number; width: number; size: number; eol: boolean }>
    expected: string[]
    sourceOnly: boolean[]
  }>('inline-formula-wrapped-reading-order.jsonl')
)('$name', ({ items, expected, sourceOnly }) => {
  const result = extractDocument(
    document([page(items.map((i) => item(i.text, i.x, i.y, i.width, i.size, i.eol)))])
  )
  assert.deepEqual(
    result.units.map((unit) => unit.source),
    expected
  )
  assert.deepEqual(
    result.units.map((unit) => Boolean(unit.sourceOnly)),
    sourceOnly
  )
  assert.deepEqual(
    result.units.flatMap((unit) => unit.originalStrings).sort(),
    items.map((i) => i.text).sort()
  )
})

test.each(
  readPdfTranslationCases<{
    name: string
    scores: number
    drift: number
    longLabel: boolean
    table: boolean
    rowGap?: number
    header?: boolean
  }>('multiple-label-table-columns.jsonl')
)('$name', ({ scores, drift, longLabel, table, rowGap = 12, header }) => {
  const inputs = Array.from({ length: 3 }, (_, row) => {
    const y = 120 + row * rowGap
    return [
      item(`Network ${String.fromCharCode(65 + row)}`, 40, y, 60, 10, false),
      item(
        longLabel
          ? 'This is ordinary prose with more than eight words in the description.'
          : 'Pruning method',
        120,
        y,
        110,
        10,
        false
      ),
      item('8 bit', 250, y, 25, 10, false),
      item('24MB', 295, y, 30, 10, false),
      ...Array.from({ length: scores }, (_, column) =>
        item(
          `${70 + row + column}.5%`,
          350 + column * 75 + row * drift,
          y,
          30,
          10,
          column === scores - 1
        )
      )
    ]
  }).flat()
  if (header) inputs.unshift(item('Model', 40, 86, 60, 10, false), item('Method', 120, 86, 110, 10))
  const result = extractDocument(document([page(inputs)]))
  if (header)
    assert.ok(result.pages[0].blocks.some((block) => block.source === 'Model' && block.tableCell))
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
  for (let row = 0; row < 3; row++) {
    const label = result.units.find(
      (unit) => unit.source === `Network ${String.fromCharCode(65 + row)}`
    )
    assert.equal(
      result.pages[0].blocks.some(
        (block) => block.tableCell && block.source === `Network ${String.fromCharCode(65 + row)}`
      ),
      table
    )
    if (table) assert.equal(label!.fragments[0].rect.x, 40)
    if (table) {
      assert.equal(result.units.filter((unit) => unit.source === 'Pruning method').length, 3)
      assert.ok(result.units.some((unit) => unit.source === `${70 + row}.5%` && unit.sourceOnly))
      assert.ok(label!.fragments[0].rect.bottom - label!.fragments[0].rect.y < 12)
    }
  }
})

test.each(
  readPdfTranslationCases<{ name: string; value: string; preserved: boolean; proof?: boolean }>(
    'technical-numeric-table-cells.jsonl'
  )
)('$name', ({ value, preserved, proof = true }) => {
  const inputs = Array.from({ length: 3 }, (_, row) => [
    item(`Variant ${String.fromCharCode(65 + row)}`, 40, 120 + row * 12, 70, 10, false),
    item(value, 160, 120 + row * 12, 90, 10, false),
    item(`${75 + row}.5%`, 300, 120 + row * 12, 30, 10, false),
    ...(proof ? [item(`${85 + row}.5%`, 380, 120 + row * 12, 30)] : [])
  ]).flat()
  const result = extractDocument(document([page(inputs)]))
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
  const values = result.units.filter((unit) => unit.source === value && unit.sourceOnly)
  assert.equal(values.length, preserved ? 3 : 0)
  if (preserved) {
    for (const unit of values) {
      assert.equal(unit.fragments.length, 1)
      assert.ok(unit.fragments[0].rect.bottom - unit.fragments[0].rect.y < 12)
    }
    assert.ok(result.units.some((unit) => unit.source === 'Variant A' && !unit.sourceOnly))
  }
})

test.each(
  [
    'kernel-size-parameter-preservation.jsonl',
    'standalone-numeric-symbol-preservation.jsonl'
  ].flatMap((file) =>
    readPdfTranslationCases<{ name: string; source: string; sourceOnly: boolean }>(file)
  )
)('$name', ({ source, sourceOnly }) => {
  const result = extractDocument(document([page([item(source, 40, 100, 260)])]))
  assert.equal(result.units.length, 1)
  assert.equal(result.units[0].source, source)
  assert.equal(Boolean(result.units[0].sourceOnly), sourceOnly)
  assert.deepEqual(result.units[0].originalStrings, [source])
})

test.each(
  readPdfTranslationCases<{ name: string; value: string; table: boolean }>(
    'statistical-table-row-boundaries.jsonl'
  )
)('$name', ({ value, table }) => {
  const inputs = Array.from({ length: 3 }, (_, row) => [
    item(`Measure ${String.fromCharCode(65 + row)}`, 40, 120 + row * 12, 70),
    item(value, 180, 120 + row * 12, 85),
    item(value, 320, 120 + row * 12, 85)
  ]).flat()
  const result = extractDocument(document([page(inputs)]))
  assert.deepEqual(
    result.units.flatMap((unit) => unit.originalStrings).sort(),
    inputs.map((i) => i.str).sort()
  )
  assert.equal(
    result.units.filter((unit) => unit.source === value && unit.sourceOnly).length,
    table ? 6 : 0
  )
  if (table)
    for (let row = 0; row < 3; row++) {
      const unit = result.units.find(
        (unit) => unit.source === `Measure ${String.fromCharCode(65 + row)}`
      )
      assert.ok(unit && !unit.sourceOnly)
      assert.ok(unit.fragments[0].rect.bottom - unit.fragments[0].rect.y < 12)
    }
})

test.each(
  readPdfTranslationCases<{
    name: string
    nextX: number
    label: string
    labelWidth: number
    right: number
    singleLabel?: string
  }>('first-column-label-whitespace.jsonl')
)('$name', ({ nextX, label, labelWidth, right, singleLabel }) => {
  const inputs = Array.from({ length: 3 }, (_, row) => [
    item(label, 40, 120 + row * 12, labelWidth, 8, false),
    item('21.3', nextX, 120 + row * 12, 18, 8, false),
    item('32.4', 250, 120 + row * 12, 18, 8, true)
  ]).flat()
  if (singleLabel) inputs.unshift(item(singleLabel, 40, 108, 90, 8, true))
  const result = extractDocument(document([page(inputs)]))
  if (singleLabel) {
    const heading = result.units.find((unit) => unit.source === singleLabel)!
    assert.ok(!heading.sourceOnly)
    assert.equal(heading.fragments[0].rect.right, nextX - 8)
  }
  const labels = result.units.filter((u) => u.source === label)
  assert.equal(labels.length, 3)
  for (const [row, cell] of labels.entries()) {
    const rect = cell.fragments[0].rect
    assert.equal(rect.x, /\p{L}/u.test(label) ? 40 : 32)
    assert.equal(rect.right, right)
    assert.ok(rect.bottom - rect.y < 12)
    assert.ok(rect.y < 120 + row * 12 && rect.bottom >= 120 + row * 12)
  }
  for (const value of result.units.filter((u) => u.source === '21.3')) {
    assert.ok(value.sourceOnly)
    assert.equal(value.fragments[0].rect.right, nextX + 26)
    assert.ok(value.fragments[0].rect.x >= right)
  }
  assert.deepEqual(
    result.units.flatMap((u) => u.originalStrings).sort(),
    inputs.map((i) => i.str).sort()
  )
})

test.each(
  readPdfTranslationCases<{ name: string; markers: string[]; joinedMarkers: boolean }>(
    'parenthesized-numbered-prose.jsonl'
  )
)('$name', ({ markers, joinedMarkers }) => {
  const inputs = markers.flatMap((marker, index) => [
    item(marker, 40, 100 + index * 36, 12, 10, false),
    item('The recorded result is evaluated for each', 56, 100 + index * 36, 250, 10),
    item('participant in the study.', 56, 112 + index * 36, 130, 10)
  ])
  const result = extractDocument(document([page(inputs)]))
  for (const marker of markers) {
    const unit = result.units.find((u) => u.source.startsWith(marker))
    assert.ok(unit)
    assert.equal(unit.source.includes('The recorded result'), joinedMarkers)
    if (joinedMarkers) {
      assert.ok(unit.source.endsWith('participant in the study.'))
      assert.equal(markers.filter((value) => unit.source.includes(value)).length, 1)
    }
  }
  assert.deepEqual(
    result.units.flatMap((u) => u.originalStrings).sort(),
    inputs.map((i) => i.str).sort()
  )
})

test.each(
  readPdfTranslationCases<{ name: string; shift: number }>('staggered-adjacent-captions.jsonl')
)('$name', ({ shift }) => {
  const result = extractDocument(
    document([
      page([
        item('axis', 40, 70, 20, 10, false),
        item('Figure 2:', 40, 100, 38, 10, false),
        item('Measurements across groups.', 94, 100, 126, 10, true),
        item('The left caption continues.', 40, 112, 180),
        item('Table 3: Independent observations.', 224, 100 + shift, 250),
        item('The right caption continues.', 224, 112 + shift, 250)
      ])
    ])
  )
  assert.ok(
    result.units.some(
      (u) => u.source === 'Figure 2: Measurements across groups. The left caption continues.'
    )
  )
  assert.ok(
    result.units.some(
      (u) => u.source === 'Table 3: Independent observations. The right caption continues.'
    )
  )
  assert.equal(result.units.flatMap((u) => u.items).length, 6)
})

test.each(
  readPdfTranslationCases<{
    name: string
    size: number
    lower: number
    sourceOnly: boolean
    base?: string
    tail?: string
  }>('isolated-letter-subscript-variable.jsonl')
)('$name', ({ size, lower, sourceOnly, base = 'g', tail = ',' }) => {
  const baseWidth = base.length === 1 ? 5 : 20
  const result = extractDocument(
    document([
      page([
        item(base, 40, 100, baseWidth, 10, false),
        item('i', 40 + baseWidth, 100 + lower, 2, size, false),
        item(tail, 42 + baseWidth, 100, 2, 10, true)
      ])
    ])
  )
  assert.equal(result.units.length, 1)
  assert.equal(Boolean(result.units[0].sourceOnly), sourceOnly)
})

test.each(
  readPdfTranslationCases<{ name: string; drift: number; rows: number; table: boolean }>(
    'decimal-aligned-duration-table.jsonl'
  )
)('$name', ({ drift, rows, table }) => {
  const inputs = Array.from({ length: rows }, (_, row) => [
    item(`Variant ${String.fromCharCode(65 + row)}`, 40, 120 + row * 12, 52, 10, false),
    item(row % 2 ? '12.50' : '2.50', 112 + row * drift, 120 + row * 12, 20, 10, false),
    item('±', 132 + row * drift, 120 + row * 12, 7, 10, false),
    item(
      row > 1 ? '0.125s (35.2%)' : '0.125s',
      139 + row * drift,
      120 + row * 12,
      row > 1 ? 62 : 27
    )
  ]).flat()
  const result = extractDocument(document([page(inputs)]))
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
  assert.equal(
    result.units.filter((unit) => /^Variant [A-D]$/.test(unit.source)).length,
    table ? rows : 0
  )
  if (table)
    assert.equal(
      result.units.filter((unit) => unit.sourceOnly && unit.source.includes('±')).length,
      rows
    )
})

test('a proven timing table keeps its first row separate beside a prose column', () => {
  const inputs = [item('A nearby paragraph continues across this left column.', 40, 116, 230, 10)]
  for (let row = 0; row < 4; row++)
    inputs.push(
      item(`Variant ${String.fromCharCode(65 + row)}`, 320, 120 + row * 10, 42, 9, false),
      item('2.50', 380, 120 + row * 10, 16, 9, false),
      item('±', 396, 120 + row * 10, 7, 9, false),
      item('0.125s', 403, 120 + row * 10, 26, 9)
    )
  const result = extractDocument(document([page(inputs)]))
  assert.ok(result.units.some((unit) => unit.source === 'Variant A' && !unit.sourceOnly))
  assert.equal(
    result.units.filter((unit) => unit.source === '2.50±0.125s' && unit.sourceOnly).length,
    4
  )
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
})

test('preserves detached symbolic operands and overprinted copyright metadata', () => {
  const result = extractDocument(
    document([
      page([
        item("['New', '_York']", 320, 280, 180, 10),
        item('Brussels, 2018. ©c 2018 Association for Computational Linguistics', 40, 765, 480, 9),
        item('The model uses D channels and M filters.', 40, 180, 300),
        item('© 2018 Association for Computational Linguistics', 40, 680, 400, 9)
      ])
    ])
  )
  assert.ok(result.units.some((unit) => unit.source.includes('_York') && unit.sourceOnly))
  assert.equal(result.units.find((unit) => unit.source.includes('©c'))?.sourceOnly, true)
  assert.equal(
    result.units.find((unit) => unit.source.startsWith('The model'))?.sourceOnly,
    undefined
  )
  assert.equal(result.units.find((unit) => unit.source.startsWith('© 2018'))?.sourceOnly, undefined)
  assert.equal(result.units.flatMap((unit) => unit.items).length, 4)
})

test('preserves separate diagram indices without treating letter-spaced headings as formulas', () => {
  const items = [
    item('D', 320, 100, 7, 10, false),
    item('K', 327, 103, 5, 7, false),
    item('1', 333, 111, 5, 8),
    ...['T', 'I', 'M', 'E'].map((letter, i) => item(letter, 40 + i * 7, 200, 7, 10, i === 3)),
    item('The layer is efficient.', 40, 240, 200)
  ]
  const result = extractDocument(document([page(items)]))
  assert.ok(
    result.units
      .filter((unit) => unit.items.some((key) => ['1:0', '1:1', '1:2'].includes(key)))
      .every((unit) => unit.sourceOnly)
  )
  assert.ok(result.units.some((unit) => unit.source === 'TIME' && !unit.sourceOnly))
  assert.ok(result.units.some((unit) => unit.source.startsWith('The layer') && !unit.sourceOnly))
  assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
})

test.each([true, false])('preserves repeated shell commands and their output: %s', (repeated) => {
  const items = [
    item('% tool_train --input=sample.txt', 82, 100, 180),
    item('--model_prefix=demo', 87, 112, 140),
    item(
      repeated ? '% echo "Hello world." | tool_encode' : 'The model processes natural language.',
      82,
      136,
      215
    ),
    item('--model=demo.model', 102, 148, 150),
    item('Hello world.', 82, 160, 90),
    item('Figure 1: Command line usage', 76, 180, 220),
    item('The program comprises four components.', 72, 210, 240),
    item('A nearby column explains the model.', 320, 112, 240)
  ]
  const result = extractDocument(document([page(items)]))
  assert.equal(
    Boolean(
      result.units.find(
        (unit) => unit.source.includes('Hello world.') && !unit.source.includes('echo')
      )?.sourceOnly
    ),
    repeated
  )
  assert.ok(result.units.some((unit) => unit.source.startsWith('Figure 1') && !unit.sourceOnly))
  assert.ok(result.units.some((unit) => unit.source.startsWith('The program') && !unit.sourceOnly))
  assert.ok(result.units.some((unit) => unit.source.startsWith('A nearby') && !unit.sourceOnly))
  assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
})

test.each([false, true])(
  'keeps paired counts in table columns beside separate code: %s',
  (nearbyCode) => {
    const items = [
      'Word model (baseline)',
      'Tokenizer',
      'Tokenizer w/ preprocessing',
      'Word/Tokenizer',
      'Tokenizer/Word'
    ].flatMap((label, i) => {
      const y = 100 + i * 13
      return [
        item(label, 320, y, i === 2 ? 93 : 70, 9, false),
        item(i === 1 || i === 2 ? '8k' : '64k/8k', 422, y, i === 1 || i === 2 ? 11 : 36, 11, false),
        ...(i === 1 || i === 2 ? [item('(shared)', 436, y, 23, 7, false)] : []),
        item('27.34', 472, y, 25, 11)
      ]
    })
    if (nearbyCode) items.push(item('text = [sample]; output = session.run(text)', 40, 126, 250, 9))
    const result = extractDocument(document([page(items)]))
    assert.equal(
      result.units.filter((unit) => unit.source === '27.34' && unit.sourceOnly).length,
      5
    )
    assert.equal(
      result.units.filter((unit) => unit.source === '64k/8k' && unit.sourceOnly).length,
      3
    )
    assert.equal(
      result.units.filter((unit) => unit.source === '8k (shared)' && !unit.sourceOnly).length,
      2
    )
    assert.ok(
      result.units.some((unit) => unit.source === 'Tokenizer w/ preprocessing' && !unit.sourceOnly)
    )
    assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
  }
)

test.each([true, false])(
  'preserves an imported Python listing only with assignment evidence: %s',
  (code) => {
    const items = [
      item('import tensor_module as tm', 82, 100, 180),
      item(code ? 'model = tm.load("model.bin")' : 'The model processes input text.', 82, 124, 220),
      item(
        code ? 'output = model.encode(text)' : 'Output can be inspected in a notebook.',
        82,
        136,
        220
      ),
      item('with tm.Session() as sess:', 82, 160, 180),
      item("text = ['sample', '_tokens']", 90, 172, 200),
      item('Figure 2: API example', 76, 195, 200),
      item('The program comprises four components.', 72, 226, 250)
    ]
    const result = extractDocument(document([page(items)]))
    assert.equal(
      Boolean(result.units.find((unit) => unit.source.includes('with tm.Session()'))?.sourceOnly),
      code
    )
    assert.ok(result.units.some((unit) => unit.source.startsWith('Figure 2') && !unit.sourceOnly))
    assert.ok(
      result.units.some((unit) => unit.source.startsWith('The program') && !unit.sourceOnly)
    )
    assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
  }
)

test.each([false, true])(
  'keeps a justified prose column outside a neighboring numeric table: %s',
  (splitTail) => {
    const prose = [
      'The smaller network processes all the samples efficiently.',
      'These samples were gathered under the same conditions.',
      'The resulting measurements support the proposed comparison.',
      'All the remaining networks follow the same procedure.',
      'This procedure preserves the original evaluation protocol.'
    ]
    const items = [
      item('Network', 320, 100, 55, 10, false),
      item('Score', 414, 100, 25, 10, false),
      item('Cost', 465, 100, 20, 10),
      ...prose.flatMap((text, i) => [
        ...(splitTail && i === 2
          ? [
              item(text.slice(0, -11), 50, 113 + i * 13, 210, 10, false),
              item(text.slice(-11), 270, 113 + i * 13, 15, 10)
            ]
          : [item(text, 50, 113 + i * 13, 235, 10)]),
        item('SmallNet-' + i, 320, 113 + i * 13, 75, 10, false),
        item('88.1%', 414, 113 + i * 13, 25, 10, false),
        item('3.2', 465, 113 + i * 13, 15, 10)
      ])
    ]
    const result = extractDocument(document([page(items)]))
    assert.ok(result.units.some((unit) => unit.source === prose.join(' ')))
    for (const text of ['Network', 'Score', 'Cost'])
      assert.ok(result.units.some((unit) => unit.source === text && !unit.sourceOnly))
    assert.equal(
      result.units.filter((unit) => unit.source === '88.1%' && unit.sourceOnly).length,
      5
    )
    assert.equal(result.units.filter((unit) => unit.source === '3.2' && unit.sourceOnly).length, 5)
    assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
  }
)

test('preserves indented quoted continuations in a Python API listing', () => {
  const items = [
    item('import tokenizer as tk', 320, 100, 140),
    item("params = ('--input=input.txt '", 320, 120, 180),
    item("'--model_prefix=demo '", 385, 132, 145),
    item("'--vocab_size=1000')", 385, 144, 120),
    item('tk.Trainer.Train(params)', 320, 164, 150),
    item('processor = tk.Processor()', 320, 184, 170),
    item("print(processor.Encode('Hello world.'))", 320, 204, 240),
    item('Figure 2: API usage', 320, 226, 150),
    item('The library can be used from several languages.', 320, 254, 240)
  ]
  const result = extractDocument(document([page(items)]))
  assert.ok(result.units.some((unit) => unit.source.includes('--model_prefix') && unit.sourceOnly))
  assert.ok(result.units.some((unit) => unit.source.includes('Hello world.') && unit.sourceOnly))
  assert.ok(result.units.some((unit) => unit.source.startsWith('Figure 2') && !unit.sourceOnly))
  assert.ok(result.units.some((unit) => unit.source.startsWith('The library') && !unit.sourceOnly))
  assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
})

test.each([true, false])(
  'preserves C++ listings with repeated include and statement evidence: %s',
  (code) => {
    const items = [
      item('#include <tokenizer.h>', 320, 100, 145),
      item(
        code ? '#include <trainer.h>' : 'The library includes several interfaces.',
        320,
        112,
        200
      ),
      item('Trainer::Train(', 320, 136, 100),
      item('"--model_prefix=demo");', 340, 148, 160),
      item('Processor processor;', 320, 172, 130),
      item('processor.Encode("Hello world.");', 320, 196, 200),
      item('Figure 3: API usage', 320, 220, 150)
    ]
    const result = extractDocument(document([page(items)]))
    assert.equal(
      Boolean(result.units.find((unit) => unit.source.includes('Hello world.'))?.sourceOnly),
      code
    )
    assert.ok(result.units.some((unit) => unit.source.startsWith('Figure 3') && !unit.sourceOnly))
    assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
  }
)

test.each([
  { x: 0.00001, rise: 0.4, font: 'label', size: 6, preserve: true },
  { x: 20, rise: 0, font: 'label', size: 6, preserve: false },
  { x: 0, rise: 0.4, font: 'other', size: 6, preserve: false },
  { x: 0, rise: 0.4, font: 'label', size: 4, preserve: false },
  { x: 0, rise: 2, font: 'label', size: 6, preserve: false }
])('retains only proven overprinted native labels: %j', ({ x, rise, font, size, preserve }) => {
  const inputs = [
    { ...item('Token 1', 100, 150, 20, 6, false), fontName: 'label' },
    { ...item('Token 1', 100 + x, 150 + rise, 20, size, false), fontName: font },
    { ...item('Token 2', 145, 150, 20, 6), fontName: 'label' }
  ]
  const result = extractDocument(document([page(inputs)]))
  assert.equal(
    result.units.some((unit) => unit.source.includes('Token 1') && unit.sourceOnly),
    preserve
  )
  assert.deepEqual(result.units.flatMap((unit) => unit.items).sort(), ['1:0', '1:1', '1:2'])
})

test('long body prose with repeated native words is not classified as a diagram label', () => {
  const long =
    'This ordinary scientific paragraph contains enough words to distinguish its body prose from independently positioned diagram labels and continues with data analysis'
  const inputs = [
    { ...item(long, 40, 150, 500, 10, false), fontName: 'body' },
    { ...item(long, 40, 150.4, 500, 10), fontName: 'body' }
  ]
  const result = extractDocument(document([page(inputs)]))
  assert.ok(result.units.every((unit) => !unit.sourceOnly))
  assert.deepEqual(result.units.flatMap((unit) => unit.items).sort(), ['1:0', '1:1'])
})

test('dense native benchmark columns preserve values, placeholders and aligned headers beside larger prose', () => {
  const xs = [160, 185, 210, 235]
  const inputs = [
    item('Model', 40, 84, 32, 10, false),
    ...xs.map((x, index) => item(`Set ${index + 1}`, x - 4, 84, 26, 10, index === 3)),
    ...[100, 112, 124].flatMap((y, row) => [
      item(`Model ${String.fromCharCode(65 + row)}`, 40, y, 46, 10, false),
      ...xs.map((x, col) =>
        item(
          row >= 1 && col < row ? '-' : `${81 + row}.${col}`,
          row >= 1 && col < row ? x + 6 : x,
          y,
          row >= 1 && col < row ? 6 : 18,
          10,
          col === 3
        )
      ),
      item(
        'The neighboring scientific paragraph remains independent of all measured values in the table.',
        320,
        y,
        240,
        12
      )
    ])
  ]
  const result = extractDocument(document([page(inputs)]))
  for (const label of ['Model A', 'Model B', 'Model C', 'Set 1', 'Set 2', 'Set 3', 'Set 4'])
    assert.ok(
      result.units.some((unit) => unit.source === label && !unit.sourceOnly),
      label
    )
  for (const value of ['81.0', '81.1', '81.2', '81.3', '82.1', '82.2', '82.3', '83.2', '83.3', '-'])
    assert.ok(
      result.units.some((unit) => unit.source === value && unit.sourceOnly),
      value
    )
  assert.ok(
    result.units
      .filter((unit) => unit.source.includes('neighboring scientific'))
      .every((unit) => !unit.sourceOnly && !/81\.\d/u.test(unit.source))
  )
})

test.each([
  { rows: 2, cols: 4, drift: 0, mixedFont: false },
  { rows: 2, cols: 2, drift: 0, mixedFont: false },
  { rows: 3, cols: 4, drift: 8, mixedFont: false },
  { rows: 3, cols: 4, drift: 0, mixedFont: true }
])(
  'dense-column evidence rejects sparse, drifting or different-font values: %j',
  ({ rows, cols, drift, mixedFont }) => {
    const inputs = Array.from({ length: rows }, (_, row) => [
      item(`Model ${String.fromCharCode(65 + row)}`, 40, 100 + row * 12, 46, 10, false),
      ...Array.from({ length: cols }, (_, col) =>
        item(
          `${81 + row}.${col}`,
          160 + col * 25 + row * drift,
          100 + row * 12,
          18,
          mixedFont && row === 1 ? 13 : 10,
          col === cols - 1
        )
      )
    ]).flat()
    const result = extractDocument(document([page(inputs)]))
    assert.ok(!result.units.some((unit) => unit.source === '81.1' && unit.sourceOnly))
  }
)

test('ordinary prose numbers and dash lists do not establish dense native score columns', () => {
  const inputs = [
    ...[100, 112, 124].map((y, index) =>
      item(
        `We report ${81 + index}.0 and ${82 + index}.1 with ${83 + index}.2 percent confidence in the ordinary scientific prose.`,
        40,
        y,
        250,
        10
      )
    ),
    ...[180, 192, 204].flatMap((y, index) => [
      item('-', 40, y, 4, 10, false),
      item(`The ordinary list item ${index + 1} describes the study results.`, 55, y, 220, 10)
    ])
  ]
  const result = extractDocument(document([page(inputs)]))
  assert.ok(result.units.every((unit) => !unit.source.includes('We report') || !unit.sourceOnly))
  assert.ok(
    result.units
      .filter((unit) => unit.source.includes('ordinary list'))
      .every((unit) => !unit.sourceOnly)
  )
})

test('dash markers before two ordinary quantities cannot supply a third numeric column', () => {
  const inputs = [100, 112, 124].flatMap((y, row) => [
    item(`Observation ${row + 1}`, 40, y, 64, 10, false),
    item('-', 140, y, 4, 10, false),
    item(`${81 + row}.0`, 160, y, 18, 10, false),
    item(`${82 + row}.1`, 185, y, 18, 10)
  ])
  const result = extractDocument(document([page(inputs)]))
  assert.ok(!result.units.some((unit) => unit.source === '81.0' && unit.sourceOnly))
})

test.each(['×', 'x', '*', '·', '+', '=', '<', '≤'])(
  'native %s keeps repeated tensor operands in one source cell',
  (operator) => {
    const inputs = [100, 112, 124].flatMap((y) => [
      item('Convolution', 40, y, 48, 10, false),
      item('3', 100, y, 5, 10, false),
      item(operator, 107, y, 6, 10, false),
      item('3', 117, y, 5, 10, false),
      item(operator, 125, y, 6, 10, false),
      item('32', 135, y, 10, 10, false),
      item('dw', 148, y, 8, 10)
    ])
    const result = extractDocument(document([page(inputs)]))
    assert.equal(
      result.units.filter((unit) => unit.source.includes(`3 ${operator} 3 ${operator} 32 dw`))
        .length,
      1
    )
    assert.ok(!result.units.some((unit) => unit.source === '32 dw'))
    assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
  }
)

test('three native score pairs establish two columns before accepting dash and raised-footnote rows', () => {
  const inputs = [
    ...[100, 112, 136].flatMap((y, row) => [
      { ...item(`Scoring model ${row + 1}`, 40, y, 74, 10, false), fontName: 'label' },
      { ...item(`${81 + row}.0`, 144, y, 18, 10, false), fontName: row === 2 ? 'bold' : 'label' },
      { ...item(`${82 + row}.1`, 169, y, 18, 10), fontName: row === 2 ? 'bold' : 'label' }
    ]),
    ...[154, 166].flatMap((y, row) => [
      {
        ...item(
          row ? 'Human (five annotations)' : 'Human (expert)',
          40,
          y,
          row ? 87 : 64,
          10,
          false
        ),
        fontName: 'label'
      },
      { ...item('†', row ? 127 : 104, y - 4.2, 4, 6, false), fontName: 'symbol' },
      { ...item('-', 150, y, 6, 10, false), fontName: 'label' },
      { ...item(`${85 + row}.0`, 169, y, 18, 10), fontName: 'label' }
    ])
  ]
  const result = extractDocument(document([page(inputs)]))
  for (const value of ['81.0', '82.1', '82.0', '83.1', '83.0', '84.1', '85.0', '86.0', '-'])
    assert.ok(
      result.units.some((unit) => unit.source === value && unit.sourceOnly),
      value
    )
  for (const label of ['Human (expert)†', 'Human (five annotations)†'])
    assert.ok(
      result.units.some((unit) => unit.source === label && !unit.sourceOnly),
      label
    )
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
})

test.each(['then', 'or', 'kg', '+', '=', '×'])(
  'two aligned values joined by native %s remain ordinary prose or an expression',
  (connector) => {
    const inputs = [100, 112, 124].flatMap((y, row) => [
      item('We observed', 40, y, 64, 10, false),
      item(`${12 + row}`, 144, y, 10, 10, false),
      item(connector, 156, y, 12, 10, false),
      item(`${7 + row}`, 170, y, 10, 10)
    ])
    const result = extractDocument(document([page(inputs)]))
    assert.ok(!result.units.some((unit) => unit.source === '12' && unit.sourceOnly))
    assert.ok(result.units.some((unit) => unit.source.includes(`12 ${connector} 7`)))
    assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
  }
)

test.each(['different descriptor size', 'multiple descriptor columns'])(
  'two-column detection rejects %s without discarding native label ink',
  (shape) => {
    const inputs = [100, 112, 124].flatMap((y, row) => [
      item('Observation', 40, y, 46, shape === 'different descriptor size' ? 8 : 10, false),
      ...(shape === 'multiple descriptor columns' ? [item('Method', 105, y, 28, 10, false)] : []),
      item(`${81 + row}.0`, 160, y, 18, 10, false),
      item(`${82 + row}.1`, 185, y, 18, 10)
    ])
    const result = extractDocument(document([page(inputs)]))
    assert.ok(!result.units.some((unit) => unit.source === '81.0' && unit.sourceOnly))
    assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
  }
)

test('sparse two-score rows do not override the four-column frame containing them', () => {
  const inputs = [
    ...[100, 112, 124, 146].flatMap((y, row) => [
      item('Benchmark model', 40, y, 96, 10, false),
      ...[0, 1, 2, 3].map((col) => item(`${81 + row}.${col}`, 160 + col * 25, y, 18, 10, col === 3))
    ]),
    ...[128, 134, 140].flatMap((y, row) => [
      item('Benchmark model', 40, y, 96, 10, false),
      item(`${71 + row}.2`, 210, y, 18, 10, false),
      item(`${71 + row}.3`, 235, y, 18, 10)
    ])
  ]
  const result = extractDocument(document([page(inputs)]))
  for (const value of ['84.0', '84.1', '84.2', '84.3'])
    assert.ok(
      result.units.some((unit) => unit.source === value && unit.sourceOnly),
      value
    )
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
})

test('a sparse wider-table row cannot lend a partial frame to the final complete row', () => {
  const inputs = [
    ...[100, 112, 124, 156].flatMap((y, row) => [
      item('Benchmark model', 40, y, 96, 10, false),
      ...[0, 1, 2, 3].map((col) => item(`${81 + row}.${col}`, 160 + col * 25, y, 18, 10, col === 3))
    ]),
    item('Sparse model', 40, 140, 96, 10, false),
    item('-', 166, 140, 6, 10, false),
    item('71.4', 210, 140, 18, 10, false),
    item('74.4', 235, 140, 18, 10)
  ]
  const result = extractDocument(document([page(inputs)]))
  for (const value of ['84.0', '84.1', '84.2', '84.3'])
    assert.ok(
      result.units.some((unit) => unit.source === value && unit.sourceOnly),
      value
    )
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
})

test('wide narrative table records own complete native cell wraps and separate adjacent rows', () => {
  const anchors = [40, 100, 160, 220, 280, 340, 440]
  const inputs = [
    ...['Study', 'Count', 'Age', 'Rate', 'Condition', 'Exercise', 'Frequency'].map((s, c) =>
      item(s, anchors[c], 60, 38, 10)
    ),
    item('design', 40, 72, 38, 10),
    item('A continued cell', 340, 94, 80, 10),
    item('from the previous page', 340, 106, 90, 10),
    ...[118, 178, 238].flatMap((y, row) => [
      item(`Study ${row + 1}`, 40, y, 38, 10),
      item(`${101 + row}`, 100, y, 18, 10, false),
      item(`${51 + row}`, 160, y, 18, 10, false),
      item(`${81 + row}`, 220, y, 18, 10),
      item('Survivors', 280, y, 48, 10),
      item('Supervised', 340, y, 58, 10),
      item('aerobic exercise', 340, y + 12, 84, 10),
      item('dose – 8–12 reps', 340, y + 24, 78, 10),
      item('for three sets', 340, y + 36, 58, 10),
      item('3/week for', 440, y, 48, 10, false),
      item('six weeks', 440, y + 12, 48, 10)
    ]),
    item('Footer kept outside the completed table.', 40, 310, 270, 10)
  ]
  const result = extractDocument(document([page(inputs)]))
  assert.equal(
    result.units.filter(
      (u) => u.source === 'Supervised aerobic exercise dose – 8–12 reps for three sets'
    ).length,
    3
  )
  assert.equal(result.units.filter((u) => u.source === '3/week for six weeks').length, 3)
  assert.ok(result.units.some((u) => u.source === 'A continued cell from the previous page'))
  assert.ok(!result.units.some((u) => u.source.includes('three sets 3/week')))
  for (const value of ['101', '51', '81'])
    assert.ok(
      result.units.some((u) => u.source === value && u.sourceOnly),
      value
    )
  assert.equal(result.units.flatMap((u) => u.items).length, inputs.length)
})

test.each(['two records', 'drifting columns', 'native prose crosses a seam'])(
  'wide narrative frame rejects %s instead of assigning uncertain cell ownership',
  (shape) => {
    const anchors = [40, 100, 160, 220, 280, 340]
    const inputs = [
      ...['Study', 'Count', 'Age', 'Rate', 'Condition', 'Exercise'].map((s, c) =>
        item(s, anchors[c], 60, 38, 10)
      ),
      ...[120, 180, ...(shape === 'two records' ? [] : [240])].flatMap((y, row) => [
        item(`Study ${row + 1}`, 40, y, 38, 10),
        item(`${101 + row}`, 100 + (shape === 'drifting columns' ? row * 8 : 0), y, 18, 10),
        item(`${51 + row}`, 160 + (shape === 'drifting columns' ? row * 8 : 0), y, 18, 10),
        item(`${81 + row}`, 220 + (shape === 'drifting columns' ? row * 8 : 0), y, 18, 10),
        item('Survivors', 280, y, 48, 10),
        item('Supervised', 340, y, 58, 10),
        item(
          shape === 'native prose crosses a seam'
            ? 'This native body sentence spans multiple presumed column boundaries.'
            : 'Short exercise',
          280,
          y + 12,
          shape === 'native prose crosses a seam' ? 220 : 48,
          10
        )
      ])
    ]
    const result = extractDocument(document([page(inputs)]))
    if (shape === 'native prose crosses a seam')
      assert.ok(
        result.units.some(
          (u) =>
            u.source.includes(
              'This native body sentence spans multiple presumed column boundaries.'
            ) && !u.sourceOnly
        )
      )
    else assert.ok(!result.pages[0].blocks.some((b) => b.source === 'Exercise' && b.tableCell))
    assert.equal(result.units.flatMap((u) => u.items).length, inputs.length)
  }
)

test.each([
  'valid',
  'two records',
  'drifting values',
  'mixed header fonts',
  'crossing header',
  'late header'
])('complete native table records prove a bold local header beside another table: %s', (shape) => {
  const make = (
    text: string,
    x: number,
    y: number,
    width: number,
    eol = false,
    fontName = 'body'
  ) => ({ ...item(text, x, y, width, 10, eol), fontName })
  const header = (x: number) => [
    make('Model', x, 84, 30, false, 'bold'),
    make(
      shape === 'crossing header' ? '#Param PPL' : '#Param',
      x + 155,
      84,
      shape === 'crossing header' ? 63 : 30,
      false,
      'bold'
    ),
    ...(shape === 'crossing header'
      ? []
      : [make('PPL', x + 200, 84, 20, false, shape === 'mixed header fonts' ? 'other' : 'bold')])
  ]
  const records = (x: number) =>
    Array.from({ length: shape === 'two records' ? 2 : 3 }, (_, row) => [
      make(`Method ${String.fromCharCode(65 + row)} with cache`, x, 100 + row * 12, 110),
      make(
        row < 2 ? '-' : '151M',
        x + (row < 2 ? 174 : 166) + (shape === 'drifting values' ? row * 8 : 0),
        100 + row * 12,
        row < 2 ? 4 : 20
      ),
      make(`${44 - row}.9`, x + 200, 100 + row * 12, 18, true)
    ]).flat()
  const headings = [...header(40), ...header(280), make('', 280, 84, 0, true, 'bold')]
  const inputs = [
    make('Page footer', 40, 760, 50),
    ...(shape === 'late header' ? [] : headings),
    ...records(40),
    ...records(280),
    ...(shape === 'late header' ? headings : [])
  ]
  const result = extractDocument(document([page(inputs)]))
  assert.equal(
    result.units.some((unit) => unit.source === 'Method A with cache' && !unit.sourceOnly),
    shape === 'valid'
  )
  if (shape === 'valid') {
    for (const value of ['-', '151M', '44.9', '43.9', '42.9'])
      assert.ok(
        result.units.some((unit) => unit.source === value && unit.sourceOnly),
        value
      )
    for (const label of ['Model', '#Param', 'PPL'])
      assert.ok(
        result.units.some((unit) => unit.source === label && !unit.sourceOnly),
        label
      )
  }
  assert.equal(
    result.units.flatMap((unit) => unit.items).length,
    inputs.filter((input) => input.str.trim()).length
  )
  assert.equal(
    new Set(result.units.flatMap((unit) => unit.items)).size,
    inputs.filter((input) => input.str.trim()).length
  )
})

test('compact descriptive table labels keep their original native left edge', () => {
  const inputs = [100, 112, 124].flatMap((y, row) => [
    item(`GP visit T${row + 1}`, 40, y, 52, 10, false),
    item(`${11 + row}.2`, 160, y, 18, 10, false),
    item(`${12 + row}.4`, 200, y, 18, 10)
  ])
  const result = extractDocument(document([page(inputs)]))
  const unit = result.units.find((unit) => unit.source === 'GP visit T1')
  assert.ok(unit)
  assert.equal(unit.fragments[0].rect.x, 40)
})

test.each([
  'closed citation',
  'open citation',
  'math function',
  'different font',
  'native break',
  'distant author'
])('closed author-year citation requires native prose adjacency: %s', (shape) => {
  const inputs = [
    {
      ...item(
        shape === 'math function' ? 'log (' : 'training (',
        40,
        112,
        46,
        10,
        shape === 'native break'
      ),
      fontName: 'body'
    },
    {
      ...item('Smith et al.', shape === 'distant author' ? 106 : 86, 112, 52, 10, false),
      fontName: shape === 'different font' ? 'math' : 'body'
    },
    { ...item(', 2020', 138, 112, 28, 10, false), fontName: 'body' },
    {
      ...item(
        shape === 'open citation'
          ? ' improves the resulting scientific model.'
          : ') improves the resulting scientific model.',
        166,
        112,
        200,
        10
      ),
      fontName: 'body'
    }
  ]
  const result = extractDocument(document([page(inputs)]))
  assert.equal(
    result.units.some((unit) => unit.sourceOnly && /^(?:training|log) \($/u.test(unit.source)),
    shape !== 'closed citation'
  )
  if (shape === 'closed citation') {
    assert.ok(
      result.units.some(
        (unit) => unit.source.includes('training (Smith et al., 2020) improves') && !unit.sourceOnly
      )
    )
  }
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
})

test.each(['closed locator', 'open locator', 'interposed native object', 'distant locator'])(
  'a section reference keeps its complete native locator: %s',
  (shape) => {
    const inputs = [
      { ...item('implementation (', 40, 100, 70, 10, false), fontName: 'body' },
      { ...item('§', 110, 100, 5, 10, false), fontName: 'symbol' },
      ...(shape === 'interposed native object' ? [item('Independent column', 400, 200, 80)] : []),
      {
        ...item(
          shape === 'open locator'
            ? '3 also contains a custom implementation.'
            : '3) also contains a custom implementation.',
          shape === 'distant locator' ? 140 : 115,
          100,
          170
        ),
        fontName: 'body'
      }
    ]
    const result = extractDocument(document([page(inputs)]))
    assert.equal(
      result.units.some((unit) => unit.sourceOnly && unit.source === 'implementation (§'),
      shape !== 'closed locator',
      JSON.stringify(result.units)
    )
    assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
  }
)

test.each([
  'caption continuation',
  'body paragraph',
  'math function',
  'open abbreviation',
  'different column'
])('a styled abbreviation requires serial caption continuation: %s', (shape) => {
  const x = shape === 'different column' ? 340 : 40
  const inputs = [
    {
      ...item(
        shape === 'body paragraph'
          ? 'The models were trained using varying batch'
          : 'Table 3: Models were trained using varying batch',
        40,
        100,
        225
      ),
      fontName: 'body'
    },
    {
      ...item(shape === 'math function' ? 'log (' : 'sizes (', x, 112, 26, 10, false),
      fontName: 'body'
    },
    { ...item('bsz', x + 26, 112, 13, 10, false), fontName: 'italic' },
    {
      ...item(
        shape === 'open abbreviation'
          ? ' improves the resulting scientific model.'
          : '). We tune the learning rate for each setting.',
        x + 39,
        112,
        210
      ),
      fontName: 'body'
    }
  ]
  const result = extractDocument(document([page(inputs)]))
  assert.equal(
    result.units.some((unit) => unit.sourceOnly && /^(?:sizes|log) \($/u.test(unit.source)),
    shape !== 'caption continuation',
    JSON.stringify(result.units)
  )
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
})

test.each(['larger appendix heading', 'body-sized citation title', 'lowercase citation entry'])(
  'title-case lettered appendices release bibliography mode only with heading proof: %s',
  (shape) => {
    const result = extractDocument(
      document([
        page(
          [
            item('References', 40, 100, 70, 12),
            item('Smith, A. 2020. A bibliographic entry.', 40, 120, 180)
          ],
          1
        ),
        page(
          [
            item(
              shape === 'lowercase citation entry'
                ? 'A implementation details'
                : 'A Implementation Details',
              40,
              100,
              180,
              shape === 'larger appendix heading' ? 12 : 10
            ),
            item(
              'The implementation uses a custom kernel to calculate local attention efficiently.',
              40,
              124,
              280
            ),
            item(
              'The parameters were configured using the same training data and evaluation protocol.',
              40,
              138,
              280
            )
          ],
          2
        )
      ])
    )
    assert.equal(
      result.units.find((unit) => unit.source.startsWith('The implementation'))?.sourceOnly ===
        true,
      shape !== 'larger appendix heading',
      JSON.stringify(result.units)
    )
  }
)

test.each(['independent panels', 'missing serial marker', 'narrow inline list'])(
  'lettered figure titles require a broad serial panel row: %s',
  (shape) => {
    const inputs = [
      '(a) Full attention',
      '(b) Sliding window attention',
      '(c) Dilated window attention'
    ].map((text, index) => ({
      ...item(
        shape === 'missing serial marker' && index === 1 ? 'Sliding window attention' : text,
        40 + index * (shape === 'narrow inline list' ? 65 : 180),
        100,
        95,
        10,
        false
      ),
      fontName: 'body'
    }))
    const result = extractDocument(document([page(inputs)]))
    assert.equal(
      result.units.some((unit) => unit.source === '(b) Sliding window attention'),
      shape === 'independent panels',
      JSON.stringify(result.units)
    )
    assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
  }
)

test.each(['none', 'column', 'font', 'gap', 'intervening', 'body'])(
  'a complete numbered uppercase heading wrap respects %s evidence',
  (change) => {
    const first =
      change === 'body'
        ? 'A body paragraph is followed by an independent uppercase label'
        : 'DISENTANGLED ATTENTION: A TWO-VECTOR APPROACH TO POSITION'
    const items = [
      { ...item('3.1', 40, 100, 18, 10, false), fontName: 'native' },
      { ...item(first, 66, 100, 410, 10), fontName: 'native' },
      ...(change === 'intervening'
        ? [{ ...item('Independent column text.', 490, 105, 90, 10), fontName: 'native' }]
        : []),
      {
        ...item('EMBEDDING', change === 'column' ? 330 : 66, change === 'gap' ? 150 : 111, 54, 10),
        fontName: change === 'font' ? 'foreign' : 'native'
      },
      {
        ...item(
          'The following prose describes an ordinary body section in detail.',
          40,
          134,
          420,
          10
        ),
        fontName: 'native'
      }
    ]
    const result = extractDocument(document([page(items)])),
      sources = result.units.map((u) => u.source)
    assert.equal(
      sources.some((s) => s === `3.1 ${first} EMBEDDING`),
      change === 'none',
      JSON.stringify(sources)
    )
    assert.ok(
      sources.some((s) => s.startsWith('The following prose')),
      JSON.stringify(sources)
    )
    assert.equal(result.units.flatMap((u) => u.items).length, items.length)
  }
)

test.each([
  'A systematic review found a consistent effect.',
  'Another study found a consistent effect.'
])('a closed numeric citation retains a complete prose article: %s', (suffix) => {
  const inputs = [
    item('Perineural administration produces longer-lasting effects.', 40, 100, 310),
    item('[', 40, 112, 3, 10, false),
    item('5', 43, 112, 5, 10, false),
    item('–', 48, 112, 5, 10, false),
    item('7', 53, 112, 5, 10, false),
    item(']. ' + suffix, 58, 112, 340)
  ]
  const result = extractDocument(
    document([page(inputs.map((part) => ({ ...part, fontName: 'body' })))])
  )
  assert.ok(
    result.units.some((u) => !u.sourceOnly && u.source.includes('[5–7]. ' + suffix)),
    JSON.stringify(result.units)
  )
})
test.each([
  '. A = symbolic',
  '. x follows an indexed operand',
  '. A',
  ', A systematic review continued without closing the index'
])('an article cannot close an indexed or incomplete expression: %s', (suffix) => {
  const inputs = [
    item('[', 40, 112, 3, 10, false),
    item('5', 43, 112, 5, 10, false),
    item('–', 48, 112, 5, 10, false),
    item('7', 53, 112, 5, 10, false),
    item(suffix, 58, 112, 340)
  ]
  const result = extractDocument(document([page(inputs)]))
  assert.ok(
    !result.units.some((u) => !u.sourceOnly && u.source.includes('[5–7' + suffix)),
    JSON.stringify(result.units)
  )
})

const oversizedTrademark = (fault = ''): PdfLayoutTextItem[] => [
  { ...item('The supplement was associated with', 40, 100, 310, 9), fontName: 'body' },
  { ...item('Magnesium', 40, 112, 45, 9, false), fontName: 'body' },
  {
    ...item(
      fault === 'operand' ? '+' : '®',
      fault === 'column' ? 300 : 85,
      fault === 'baseline' ? 119 : 115,
      fault === 'wide' ? 20 : 4.8,
      15,
      false
    ),
    fontName: 'symbol'
  },
  {
    ...item(
      'was well-tolerated and safe.',
      fault === 'column' ? 305 : 94,
      fault === 'baseline' ? 119 : 112,
      240,
      9
    ),
    fontName: fault === 'font' ? 'foreign' : 'body'
  },
  { ...item('The adverse reactions were mild and transient.', 40, 124, 310, 9), fontName: 'body' },
  {
    ...item('A separate later paragraph reports other effects.', 40, 170, 310, 9),
    fontName: 'body'
  }
]
test('an oversized narrow inline trademark does not determine body row order', () => {
  const result = extractDocument(document([page(oversizedTrademark())]))
  assert.ok(
    result.units.some(
      (u) =>
        !u.sourceOnly &&
        /supplement.*Magnesium® was well-tolerated and safe\. The adverse reactions/u.test(u.source)
    ),
    JSON.stringify(result.units)
  )
  assert.ok(!result.units.some((u) => /Magnesium.*separate later/u.test(u.source)))
  for (let i = 0; i < 6; i++)
    assert.equal(result.units.filter((u) => u.items.includes('1:' + i)).length, 1)
})
test.each(['operand', 'column', 'baseline', 'wide', 'font'])(
  'a %s symbol cannot borrow the trademark body anchor',
  (fault) => {
    const result = extractDocument(document([page(oversizedTrademark(fault))]))
    assert.ok(
      !result.units.some((u) =>
        /supplement.*Magnesium® was well-tolerated and safe\. The adverse reactions/u.test(u.source)
      ),
      JSON.stringify(result.units)
    )
  }
)

test.each(['shifted', 'foreign', 'column', 'function'])(
  'a prose article citation requires native closure and alignment: %s',
  (fault) => {
    const inputs = [
      { ...item(fault === 'function' ? 'sin[' : '[', 40, 112, 10, 10, false), fontName: 'body' },
      { ...item('5–7', 50, 112, 15, 10, false), fontName: 'body' },
      {
        ...item(
          ']. A systematic review found an effect.',
          fault === 'column' ? 400 : 65,
          fault === 'shifted' ? 113 : 112,
          300
        ),
        fontName: fault === 'foreign' ? 'foreign' : 'body'
      }
    ]
    const result = extractDocument(document([page(inputs)]))
    assert.ok(
      !result.units.some((u) => !u.sourceOnly && /\[5–7\]\. A systematic/u.test(u.source)),
      JSON.stringify(result.units)
    )
  }
)

const detachedDiaereses = (fault = ''): PdfLayoutTextItem[] => [
  { ...item('The measurements followed (Kynk', 40, 112, 150, 9, false), fontName: 'body' },
  {
    ...item(
      '¨',
      fault === 'column' ? 340 : 190.5,
      fault === 'baseline' ? 114 : 111.95,
      fault === 'wide' ? 9 : 3,
      9,
      false
    ),
    fontName: fault === 'font' ? 'foreign' : 'body'
  },
  ...(fault === 'interposed'
    ? [{ ...item('An independent native object.', 450, 180, 100, 9), fontName: 'body' }]
    : []),
  { ...item('a', 190, 112, 4, 9, false), fontName: 'body' },
  { ...item('¨', 194.5, 111.95, 3, 9, false), fontName: 'body' },
  { ...item('anniemi et al., 2019), using the same protocol.', 194, 112, 180, 9), fontName: 'body' }
]
test('detached native Latin diaereses compose only with their following overlapping letters', () => {
  const result = extractDocument(document([page(detachedDiaereses())]))
  assert.ok(
    result.units.some(
      (u) => u.source.includes('Kynkäänniemi et al., 2019)') && !u.source.includes('¨')
    ),
    JSON.stringify(result.units)
  )
  for (let i = 0; i < 5; i++)
    assert.equal(result.units.filter((u) => u.items.includes('1:' + i)).length, 1)
})
test.each(['column', 'baseline', 'wide', 'font', 'interposed'])(
  'a %s diaeresis does not compose with an unproven first letter',
  (fault) => {
    const result = extractDocument(document([page(detachedDiaereses(fault))]))
    assert.ok(
      !result.units.some((u) => u.source.includes('Kynkäänniemi')),
      JSON.stringify(result.units)
    )
  }
)

test.each(['x', 'ξ'])(
  'a native spacing diaeresis over %s keeps its mathematical/unknown meaning',
  (letter) => {
    const inputs = detachedDiaereses()
    inputs[2].str = letter
    inputs[4].str = letter + 'nnemi follows in the same native font.'
    const result = extractDocument(document([page(inputs)]))
    assert.ok(
      result.units.some((u) => u.source.includes('¨')),
      JSON.stringify(result.units)
    )
    assert.ok(
      !result.units.some((u) => u.source.includes(letter + '\u0308')),
      JSON.stringify(result.units)
    )
  }
)

const runningHeaderFixture = (fault = 'none') =>
  [1, 2, 3].slice(0, fault === 'two pages' ? 2 : 3).map((n) =>
    page(
      [
        {
          ...item(
            fault === 'unique titles'
              ? `Unique running title number ${n}`
              : 'Repeated centered running document title',
            fault === 'off center' ? 50 : 200,
            fault === 'body location' ? 95 : 60,
            200,
            fault === 'font size' && n === 3 ? 11 : 9,
            false
          ),
          fontName: fault === 'font identity' && n === 3 ? 'foreign' : 'header'
        },
        item(
          'Left opening paragraph contains enough readable words to establish the independent first body column.',
          50,
          120,
          240
        ),
        item(
          'Left final paragraph contains enough readable words and must precede the right opening paragraph.',
          50,
          560,
          240
        ),
        item(
          'Right opening paragraph contains enough readable words to establish the independent second body column.',
          310,
          100,
          240
        ),
        item(
          'Right final paragraph contains enough readable words and must follow the right opening paragraph.',
          310,
          350,
          240
        )
      ],
      n
    )
  )

test('repeated native running headers cannot interleave independent column bodies', () => {
  const inputs = runningHeaderFixture(),
    before = structuredClone(inputs)
  const result = extractDocument(document(inputs))
  for (const current of result.pages) {
    assert.deepEqual(
      current.blocks.map((block) => block.source.split(' ').slice(0, 2).join(' ')),
      ['Repeated centered', 'Left opening', 'Left final', 'Right opening', 'Right final']
    )
    const header = result.units.find((unit) => unit.items.includes(`${current.page}:0`))!
    assert.ok(header.sourceOnly)
  }
  const owners = result.units.flatMap((unit) => unit.items)
  assert.equal(owners.length, 15)
  assert.equal(new Set(owners).size, 15)
  assert.deepEqual(inputs, before)
})

test.each([
  'two pages',
  'unique titles',
  'off center',
  'body location',
  'font size',
  'font identity'
])('running header isolation requires repeated margin font and geometry: %s', (fault) => {
  const result = extractDocument(document(runningHeaderFixture(fault)))
  assert.ok(
    result.units.filter((unit) => unit.items.includes('1:0')).every((unit) => !unit.sourceOnly)
  )
})

test.each([
  'none',
  'unknown word',
  'early page tail',
  'different width',
  'different font',
  'interposed heading',
  'interposed math'
])(
  'short page word continuations need an independent complete word and native column proof: %s',
  (fault) => {
    const first = page([
      item(
        fault === 'unknown word' ? 'We evaluate sampling.' : 'We evaluate striding.',
        50,
        100,
        240
      ),
      item(
        'This sufficiently long native paragraph describes the sampling procedure and finally uses constant strid-',
        310,
        fault === 'early page tail' ? 400 : 710,
        240
      )
    ])
    const continuation = page(
      [
        ...(fault === 'interposed heading'
          ? [item('New independent section', 50, 90, 200, 12)]
          : []),
        ...(fault === 'interposed math' ? [item('x = y + z', 50, 90, 100)] : []),
        item(
          'ing from another algorithm, wherein the final timestep is defined',
          50,
          130,
          fault === 'different width' ? 150 : 240,
          fault === 'different font' ? 12 : 10
        )
      ],
      2
    )
    const result = extractDocument(document([first, continuation]))
    assert.equal(
      result.joins.some((join) => join.kind === 'page'),
      fault === 'none',
      JSON.stringify(result.joins)
    )
    assert.equal(
      new Set(result.units.flatMap((unit) => unit.items)).size,
      first.items.length + continuation.items.length
    )
  }
)

test.each([
  'none',
  'body-sized title',
  'foreign font',
  'different alignment',
  'not first content',
  'lower page title',
  'citation continuation',
  'unfinished prose',
  'unknown math'
])(
  'an unnumbered section releases bibliography only with a native section heading and complete new-page body: %s',
  (fault) => {
    const withFont = (value: ReturnType<typeof item>, fontName = 'section') => ({
      ...value,
      fontName
    })
    const referencePage = page([
      withFont(item('References', 50, 100, 75, 12)),
      withFont(
        item(
          '[1] Native reference author and publication details remain in their original bibliography layout, including a very long complete title and the full journal name.',
          50,
          140,
          400
        ),
        'body'
      ),
      withFont(
        item(
          '[2] A second native bibliographic entry also preserves its complete author list and publication information instead of masquerading as a new section of body text.',
          50,
          200,
          400
        ),
        'body'
      )
    ])
    let prose =
      'These additional experiments describe complete new results and provide sufficient explanatory text for the reader to interpret all measured values in the following comparison table.'
    if (fault === 'citation continuation') prose = '[3] Native Author. ' + prose
    if (fault === 'unfinished prose') prose = prose.slice(0, -1)
    if (fault === 'unknown math') prose = 'x = y + z'
    const appendixPage = page(
      [
        ...(fault === 'not first content'
          ? [withFont(item('Independent earlier body text.', 50, 65, 400), 'body')]
          : []),
        withFont(
          item(
            'Additional evaluations',
            fault === 'different alignment' ? 80 : 50,
            fault === 'lower page title' ? 300 : 80,
            160,
            fault === 'body-sized title' ? 10 : 12
          ),
          fault === 'foreign font' ? 'foreign' : 'section'
        ),
        withFont(item(prose, 50, fault === 'lower page title' ? 330 : 110, 400), 'body'),
        withFont(item('x = y + z', 50, 180, 100), 'body')
      ],
      2
    )
    const result = extractDocument(document([referencePage, appendixPage]))
    const restored = result.units.find((unit) => unit.source.startsWith('Additional evaluations'))!
    assert.equal(!!restored.sourceOnly, fault !== 'none', JSON.stringify(result.units))
    assert.ok(
      result.units.find((unit) => unit.items.includes('2:2')) || fault === 'not first content'
    )
    for (const unit of result.units.filter((unit) => unit.source === 'x = y + z'))
      assert.ok(unit.sourceOnly)
  }
)

test('a repeated running title matching the reference section font cannot release bibliography', () => {
  const named = (value: ReturnType<typeof item>, fontName: string) => ({ ...value, fontName })
  const inputs = [
    page([
      named(item('References', 200, 100, 80, 12), 'section'),
      named(
        item(
          '[1] This complete bibliographic entry contains a long publication title and sufficient body-sized text to preserve the native bibliography font measurement for this test case.',
          50,
          140,
          400
        ),
        'body'
      )
    ]),
    ...[2, 3, 4].map((n) =>
      page(
        [
          named(item('Repeated centered running document title', 200, 60, 200, 12), 'section'),
          named(
            item(
              'This complete wrapped bibliographic continuation contains a long publication title and sufficient descriptive words to resemble ordinary prose without being a new section of the document.',
              200,
              90,
              350
            ),
            'body'
          )
        ],
        n
      )
    )
  ]
  const result = extractDocument(document(inputs))
  for (const unit of result.units) assert.ok(unit.sourceOnly, JSON.stringify(unit))
  assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, 8)
})

test.each(['e.g', 'i.e'])(
  'a closed %s example retains its adjacent styled abbreviation and body runs',
  (marker) => {
    const inputs = [
      {
        ...item('The native paragraph describes attention within local windows', 40, 100, 300),
        fontName: 'body'
      },
      { ...item('(', 40, 112, 4, 10, false), fontName: 'body' },
      { ...item(marker, 44, 112, 13, 10, false), fontName: 'italic' },
      {
        ...item('. attention within local windows) continues in the same paragraph.', 57, 112, 283),
        fontName: 'body'
      }
    ]
    const before = structuredClone(inputs),
      result = extractDocument(document([page(inputs)]))
    assert.ok(
      result.units.some(
        (unit) =>
          !unit.sourceOnly &&
          unit.items.length === 4 &&
          unit.source.includes(`(${marker}. attention`)
      ),
      JSON.stringify(result.units)
    )
    assert.deepEqual(inputs, before)
  }
)

test.each([
  'open example',
  'function',
  'operand',
  'baseline',
  'column',
  'foreign return font',
  'interposed object',
  'unknown glyph'
])(
  'example-marker restoration requires closed prose and adjacent native body proof: %s',
  (fault) => {
    const inputs = [
      {
        ...item(
          fault === 'function' ? 'log (' : '(',
          40,
          100,
          fault === 'function' ? 20 : 4,
          10,
          false
        ),
        fontName: 'body'
      },
      { ...item('e.g', fault === 'function' ? 60 : 44, 100, 13, 10, false), fontName: 'italic' },
      ...(fault === 'interposed object'
        ? [{ ...item('independent native object', 440, 250, 120), fontName: 'body' }]
        : []),
      ...(fault === 'unknown glyph'
        ? [{ ...item('\u0015', 57, 100, 5, 10, false), fontName: 'symbol' }]
        : []),
      {
        ...item(
          fault === 'open example'
            ? '. attention within local windows remains open'
            : fault === 'operand'
              ? '. x + y) remains a formula.'
              : '. attention within local windows) remains independent prose.',
          fault === 'column' ? 340 : fault === 'function' ? 73 : 57,
          fault === 'baseline' ? 103 : 100,
          260
        ),
        fontName: fault === 'foreign return font' ? 'foreign' : 'body'
      }
    ]
    const result = extractDocument(document([page(inputs)]))
    assert.ok(
      !result.units.some(
        (unit) =>
          !unit.sourceOnly &&
          unit.items.includes('1:0') &&
          unit.items.includes(`1:${inputs.length - 1}`)
      ),
      JSON.stringify(result.units)
    )
    assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, inputs.length)
  }
)

test.each([
  'none',
  'ordinary list',
  'function',
  'unproved example',
  'wrong column',
  'wrong font',
  'wrong baseline',
  'interposed object'
])('a numeric model suffix is a native example wrap, never an independent list: %s', (fault) => {
  const first =
    fault === 'unproved example'
      ? 'We train the standard baseline model using a new procedure (e.g Model-'
      : fault === 'ordinary list'
        ? 'This complete preceding sentence ends here.'
        : fault === 'function'
          ? 'This complete native paragraph defines a function log (Model-'
          : 'We train the standard baseline model using a new procedure (e.g. Model-'
  const inputs = [
    { ...item(first, 52, 100, 288), fontName: 'body' },
    ...(fault === 'interposed object'
      ? [{ ...item('Independent native owner', 440, 105, 100), fontName: 'body' }]
      : []),
    {
      ...item(
        '50) trained with an improved procedure and evaluated on the benchmark.',
        fault === 'wrong column' ? 340 : 40,
        fault === 'wrong baseline' ? 160 : 112,
        300,
        fault === 'wrong font' ? 12 : 10
      ),
      fontName: fault === 'wrong font' ? 'foreign' : 'body'
    }
  ]
  const result = extractDocument(document([page(inputs)]))
  assert.equal(
    result.units.some((unit) => unit.items.length === 2),
    fault === 'none',
    JSON.stringify(result.units)
  )
  assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, inputs.length)
})

test('a wrapped two-letter acronym and linked citation stay inside their body paragraph', () => {
  const inputs = [
    item(
      'These clinical complications threaten the long-term prognosis of patients with',
      40,
      100,
      234
    ),
    item('BC [', 40, 112, 21, 10, false),
    item('4', 61, 112, 5, 10, false),
    item('], which calls for careful postoperative recovery.', 66, 112, 208),
    item('The treatment continues with clinical assessment.', 40, 124, 234)
  ].map((part) => ({ ...part, fontName: 'body' }))
  const result = extractDocument(document([page(inputs)]))
  assert.equal(result.units.length, 1)
  assert.match(result.units[0].source, /patients with BC \[4\], which/u)
  assert.deepEqual(
    result.units[0].items,
    inputs.map((_, index) => `1:${index}`)
  )
})

test.each(
  readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
    'wrapped-citation-native-body.jsonl'
  )
)('$name', ({ page: nativePage }) => {
  const result = extractDocument(document([nativePage]))
  const paragraph = result.units.find((unit) => unit.source.startsWith('INFO is'))!
  assert.match(paragraph.source, /by both results and distinct \[20\]\. The data/u)
  assert.ok(paragraph.source.endsWith('results [7].'))
  assert.equal(paragraph.sourceOnly, undefined)
  assert.equal(result.units.length, 2)
  assert.equal(
    new Set(result.units.flatMap((unit) => unit.items)).size,
    nativePage.items.filter((part) => part.str.trim()).length
  )
})

test.each(
  readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
    'inline-reference-native-caption.jsonl'
  )
)('$name', ({ page: nativePage }) => {
  const result = extractDocument(document([nativePage]))
  assert.equal(result.units.length, 1)
  assert.equal(result.units[0].sourceOnly, undefined)
  assert.match(result.units[0].source, /different broad collections \(w\)\. All baseline/u)
  assert.ok(result.units[0].source.endsWith('parent with properties 299x299.'))
  assert.equal(
    new Set(result.units.flatMap((unit) => unit.items)).size,
    nativePage.items.filter((part) => part.str.trim()).length
  )
})

test.each([
  ['and patients', '20', 'The', 'body'],
  ['and patients', '20', 'A', 'body'],
  ['from Müller', '12; 14', 'The', 'body'],
  ['with clinicians', '8—10', 'The', 'body'],
  ['and patients', '20', 'The', 'link'],
  ['with clinicians', '8–10', 'A', 'link']
])(
  'a continuous citation tolerates literal reference variants: %s [%s] %s %s',
  (lead, reference, next, font) => {
    const inputs = [
      item('The assessment provides reliable results and has high acceptability', 40, 100, 234),
      item(lead + ' [', 40, 112, 60, 10, false),
      { ...item(reference, 100, 112, 20, 10, false), fontName: font },
      item(']. ' + next + ' clinical evaluation continues with careful assessment.', 120, 112, 154),
      item('These are related parts of the same clinical assessment.', 40, 124, 234)
    ].map((part) => ({ fontName: 'body', ...part }))
    const result = extractDocument(document([page(inputs)]))
    assert.equal(result.units.length, 1, JSON.stringify(result.units))
    assert.equal(result.units[0].sourceOnly, undefined)
    assert.ok(result.units[0].source.includes(lead + ' [' + reference + ']. ' + next))
    assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, inputs.length)
  }
)

test.each(['changed-prose-font', 'raised-link', 'open-reference', 'new-paragraph'])(
  'a styled citation cannot hide a body boundary: %s',
  (fault) => {
    const x = fault === 'new-paragraph' ? 48 : 40
    const inputs = [
      {
        ...item(
          'The assessment provides reliable results and has high acceptability',
          40,
          100,
          234
        ),
        fontName: 'body'
      },
      { ...item('and patients [', x, 112, 60, 10, false), fontName: 'body' },
      {
        ...item('20', x + 60, fault === 'raised-link' ? 105 : 112, 10, 10, false),
        fontName: 'link'
      },
      {
        ...item(
          (fault === 'open-reference' ? '' : ']') + '. A clinical evaluation follows.',
          x + 70,
          112,
          164
        ),
        fontName: fault === 'changed-prose-font' ? 'other' : 'body'
      }
    ]
    const result = extractDocument(document([page(inputs)]))
    assert.ok(
      !result.units
        .find((unit) => unit.source.startsWith('The assessment'))!
        .source.includes('patients')
    )
    assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, inputs.length)
  }
)

test.each(['w', 'bsz', 'D2'])(
  'a caption keeps a closed styled identifier %s with its explanation',
  (identifier) => {
    const inputs = [
      {
        ...item('Figure 4. Network performance with different width', 40, 100, 234),
        fontName: 'body'
      },
      { ...item('coefficient (', 40, 112, 50, 10, false), fontName: 'body' },
      { ...item(identifier, 90, 112, 15, 10, false), fontName: 'italic' },
      {
        ...item('). A separate model is trained for each setting.', 105, 112, 169),
        fontName: 'body'
      }
    ]
    const result = extractDocument(document([page(inputs)]))
    assert.equal(result.units.length, 1, JSON.stringify(result.units))
    assert.equal(result.units[0].sourceOnly, undefined)
    assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, inputs.length)
  }
)

test.each([
  'operator',
  'open-reference',
  'native-break',
  'intervening-item',
  'changed-body-font',
  'distant-run'
])('a caption identifier still requires a closed serial body row: %s', (fault) => {
  const inputs = [
    {
      ...item('Figure 4. Network performance with different width', 40, 100, 234),
      fontName: 'body'
    },
    { ...item('coefficient (', 40, 112, 50, 10, fault === 'native-break'), fontName: 'body' },
    { ...item(fault === 'operator' ? 'w+z' : 'w', 90, 112, 15, 10, false), fontName: 'italic' },
    {
      ...item(
        (fault === 'open-reference' ? '' : ')') + '. A separate model is trained for each setting.',
        fault === 'distant-run' ? 125 : 105,
        112,
        169
      ),
      fontName: fault === 'changed-body-font' ? 'other' : 'body'
    }
  ]
  if (fault === 'intervening-item')
    inputs.splice(3, 0, { ...item('Other column.', 350, 112, 100), fontName: 'body' })
  const result = extractDocument(document([page(inputs)]))
  assert.ok(
    result.units.some((unit) => unit.sourceOnly && unit.source.startsWith('coefficient (')),
    JSON.stringify(result.units)
  )
  assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, inputs.length)
})

test.each(['and patients', 'from investigators', 'with patients', 'for clinicians', 'by doctors'])(
  'a continuous body citation keeps the short prose lead-in %s',
  (lead) => {
    const inputs = [
      item('The assessment provides reliable results and has high acceptability', 40, 100, 234),
      item(lead + ' [', 40, 112, 60, 10, false),
      item('20', 100, 112, 10, 10, false),
      item(']. The evaluation continues with clinical assessment.', 110, 112, 164),
      item('These are related parts of the same clinical assessment.', 40, 124, 234),
      item('Another topic begins in a separate indented paragraph.', 48, 136, 226)
    ].map((part) => ({ ...part, fontName: 'body' }))
    const result = extractDocument(document([page(inputs)]))
    assert.equal(result.units.length, 2)
    assert.ok(result.units[0].source.includes('acceptability ' + lead + ' [20]. The evaluation'))
    assert.equal(result.units[0].sourceOnly, undefined)
    assert.ok(result.units[1].source.startsWith('Another topic'))
    assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, inputs.length)
  }
)

test.each([
  'new-paragraph',
  'wide-gap',
  'different-font',
  'intervening-item',
  'completed-sentence',
  'open-reference',
  'function-operand'
])('a short cited continuation requires native body evidence: %s', (fault) => {
  const x = fault === 'new-paragraph' ? 48 : 40
  const y = fault === 'wide-gap' ? 140 : 112
  const inputs = [
    item(
      'The assessment provides reliable results and has high acceptability' +
        (fault === 'completed-sentence' ? '.' : ''),
      40,
      100,
      234
    ),
    item(fault === 'function-operand' ? 'sin patients [' : 'and patients [', x, y, 60, 10, false),
    item('20', x + 60, y, 10, 10, false),
    item(
      fault === 'open-reference'
        ? '. The clinical evaluation continues.'
        : ']. The clinical evaluation continues.',
      x + 70,
      y,
      164
    )
  ].map((part, index) => ({
    ...part,
    fontName: fault === 'different-font' && index ? 'other' : 'body'
  }))
  if (fault === 'intervening-item')
    inputs.splice(1, 0, { ...item('Separate column content.', 350, 100, 180), fontName: 'body' })
  const result = extractDocument(document([page(inputs)]))
  const paragraph = result.units.find((unit) => unit.source.startsWith('The assessment'))!
  assert.ok(!paragraph.source.includes('patients'))
  assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, inputs.length)
})

test.each(['[8–10].', '[8, 10].', '[8].'])(
  'a wrapped terminal citation %s stays with its sentence',
  (citation) => {
    const inputs = [
      item('The treatment improves postoperative recovery and clinical safety', 40, 100, 234),
      item('and deserves to be promoted in clinical anesthesia management', 40, 112, 234),
      item(citation, 40, 124, 32),
      item('Nevertheless, research mainly focuses on antidepressant therapy.', 48, 136, 226),
      item('These remain important separate questions for future studies.', 40, 148, 234)
    ].map((part) => ({ ...part, fontName: 'body' }))
    const result = extractDocument(document([page(inputs)]))
    assert.equal(result.units.length, 2)
    assert.ok(result.units[0].source.endsWith(citation))
    assert.ok(result.units[1].source.startsWith('Nevertheless'))
    assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
  }
)

test.each([
  'compact-index',
  'variable-index',
  'different-font',
  'new-paragraph',
  'intervening-item'
])('an acronym citation needs continuous body context: %s', (fault) => {
  const inputs = [
    item(
      'These clinical complications threaten the long-term prognosis of patients with',
      40,
      100,
      234
    ),
    item(
      fault === 'compact-index' ? 'BC[' : fault === 'variable-index' ? 'x [' : 'BC [',
      fault === 'new-paragraph' ? 48 : 40,
      112,
      21,
      10,
      false
    ),
    item('4', fault === 'new-paragraph' ? 69 : 61, 112, 5, 10, false),
    item(
      '], which calls for careful postoperative recovery.',
      fault === 'new-paragraph' ? 74 : 66,
      112,
      208
    )
  ].map((part, index) => ({
    ...part,
    fontName: fault === 'different-font' && index ? 'math' : 'body'
  }))
  if (fault === 'intervening-item')
    inputs.splice(1, 0, { ...item('Independent column content.', 350, 100, 180), fontName: 'body' })
  const result = extractDocument(document([page(inputs)]))
  const before = result.units.find((unit) => unit.source.startsWith('These clinical'))!
  assert.ok(before.source.endsWith('patients with'))
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
})

test.each([
  'different-font',
  'indented-reference',
  'wide-gap',
  'intervening-item',
  'completed-sentence'
])('a terminal reference needs an unfinished adjacent body sentence: %s', (fault) => {
  const inputs = [
    item('The treatment improves postoperative recovery and clinical safety', 40, 100, 234),
    item(
      'and deserves to be promoted in clinical anesthesia management' +
        (fault === 'completed-sentence' ? '.' : ''),
      40,
      112,
      234
    ),
    item('[8–10].', fault === 'indented-reference' ? 48 : 40, fault === 'wide-gap' ? 140 : 124, 32)
  ].map((part, index) => ({
    ...part,
    fontName: fault === 'different-font' && index === 2 ? 'reference' : 'body'
  }))
  if (fault === 'intervening-item')
    inputs.splice(2, 0, { ...item('Independent column content.', 350, 112, 180), fontName: 'body' })
  const result = extractDocument(document([page(inputs)]))
  assert.ok(result.units.some((unit) => unit.source === '[8–10].'))
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
})

// Continuation decisions use the native body row rather than a particular acronym or word.
test.each(['CT', 'MRI', 'HRQoL', 'pH', 'Hb'])(
  'a body continuation keeps the cited identifier %s and its prose together',
  (identifier) => {
    const inputs = [
      item('The clinical outcome was measured with the established assessment', 40, 100, 234),
      item(identifier + ' [', 40, 112, 28, 10, false),
      item('12', 68, 112, 10, 10, false),
      item('], which was recorded throughout the follow-up period.', 78, 112, 196)
    ].map((part) => ({ ...part, fontName: 'body' }))
    const result = extractDocument(document([page(inputs)]))
    assert.equal(result.units.length, 1)
    assert.ok(result.units[0].source.includes(identifier + ' [12], which'))
    assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
  }
)

test.each(['Cancer.', 'New York.', '[18–20].', 'HRQoL [12].'])(
  'a short terminal body wrap %s stays with its introducing sentence',
  (tail) => {
    const inputs = [
      item('The clinical assessment was performed using the published scale for', 40, 100, 234),
      item(tail, 40, 112, 32),
      item('Nevertheless, a separate clinical paragraph begins here.', 48, 124, 226),
      item('The next sentence discusses a different research question.', 40, 136, 234)
    ].map((part) => ({ ...part, fontName: 'body' }))
    const result = extractDocument(document([page(inputs)]))
    assert.equal(result.units.length, 2)
    assert.ok(result.units[0].source.endsWith(tail))
    assert.ok(result.units[1].source.startsWith('Nevertheless'))
    assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
  }
)

test.each([
  'indented',
  'other-column',
  'style-change',
  'wide-gap',
  'complete-sentence',
  'missing-font'
])('a short capitalized row cannot cross a paragraph boundary: %s', (fault) => {
  const inputs = [
    {
      ...item(
        'The clinical assessment was performed using the published scale for' +
          (fault === 'complete-sentence' ? '.' : ''),
        40,
        100,
        234
      ),
      fontName: fault === 'missing-font' ? undefined : 'body'
    },
    {
      ...item(
        'Cancer.',
        fault === 'indented' ? 48 : fault === 'other-column' ? 350 : 40,
        fault === 'wide-gap' ? 140 : 112,
        32
      ),
      fontName: fault === 'missing-font' ? undefined : fault === 'style-change' ? 'heading' : 'body'
    }
  ]
  const result = extractDocument(document([page(inputs)]))
  assert.equal(result.units.length, 2)
  assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
})

test.each(['ln', 'log', 'sin', 'det'])(
  'body continuity cannot consume the mathematical function %s',
  (name) => {
    for (const suffix of ['].', '], where the value is evaluated for each observation.']) {
      const inputs = [
        item('The clinical assessment uses a transformation of the recorded values', 40, 100, 234),
        item('and the following expression defines the computation for each sample', 40, 112, 234),
        item(name + ' [', 40, 124, 21, 10, false),
        item('4', 61, 124, 5, 10, false),
        item(suffix, 66, 124, suffix.length > 3 ? 208 : 7)
      ].map((part) => ({ ...part, fontName: 'body' }))
      const result = extractDocument(document([page(inputs)]))
      assert.ok(result.units.some((unit) => unit.sourceOnly && unit.source.startsWith(name + ' [')))
      assert.ok(
        !result.units
          .find((unit) => unit.source.startsWith('The clinical'))!
          .source.includes(name + ' [')
      )
      assert.equal(result.units.flatMap((unit) => unit.items).length, inputs.length)
    }
  }
)

test.each(
  readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
    'closed-parenthetical-native-body.jsonl'
  )
)('$name keeps its complete native prose paragraph', ({ name, page: nativePage }) => {
  const result = extractDocument(document([nativePage]))
  assert.equal(result.units.length, 1)
  assert.equal(result.units[0].sourceOnly, undefined)
  if (name.startsWith('swin'))
    assert.match(
      result.units[0].source,
      /body-measureme observation \(Path Observation widths\) are ordered/u
    )
  else assert.match(result.units[0].source, /43\.5% AP \(65\.7% AP50\) for the MS LINE/u)
  assert.equal(
    new Set(result.units.flatMap((unit) => unit.items)).size,
    nativePage.items.filter((part) => part.str.trim()).length
  )
})

test.each([
  'feature extraction blocks',
  'multi-head attention modules',
  'Müller clinical assessments'
])('a closed styled prose term remains inside its introducing sentence: %s', (term) => {
  const nativePage = structuredClone(
    readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
      'closed-parenthetical-native-body.jsonl'
    )[0].page
  )
  nativePage.items[2].str = term
  const result = extractDocument(document([nativePage]))
  assert.equal(result.units.length, 1)
  assert.equal(result.units[0].sourceOnly, undefined)
  assert.ok(result.units[0].source.includes('observation (' + term + ') are ordered'))
})

test.each([
  'open-parenthesis',
  'function-call',
  'symbolic-argument',
  'no-returning-font',
  'wide-gap'
])('a styled term requires a complete serial prose parenthesis: %s', (fault) => {
  const nativePage = structuredClone(
    readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
      'closed-parenthetical-native-body.jsonl'
    )[0].page
  )
  if (fault === 'open-parenthesis') nativePage.items[3].str = ' are ordered on these'
  if (fault === 'function-call') nativePage.items[1].str = 'softmax ('
  if (fault === 'symbolic-argument') nativePage.items[2].str = 'x + y'
  if (fault === 'no-returning-font') nativePage.items[3].fontName = 'other'
  if (fault === 'wide-gap') nativePage.items[2].transform[4] += 20
  const result = extractDocument(document([nativePage]))
  assert.ok(
    result.units.some(
      (unit) =>
        unit.sourceOnly &&
        unit.source.startsWith(fault === 'function-call' ? 'softmax (' : 'observation (')
    )
  )
})

test.each([
  'completed-sentence',
  'new-paragraph',
  'unclosed-value',
  'raised-index',
  'no-percentage'
])('a reported metric requires a closed value and adjacent body context: %s', (fault) => {
  const nativePage = structuredClone(
    readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
      'closed-parenthetical-native-body.jsonl'
    )[1].page
  )
  const at = nativePage.items.findIndex((part) => part.str.startsWith('AP ('))
  if (fault === 'completed-sentence') nativePage.items[at - 1].str += '.'
  if (fault === 'new-paragraph')
    for (const part of nativePage.items.slice(at, at + 3)) part.transform[4] += 12
  if (fault === 'unclosed-value') nativePage.items[at + 2].str = ' for the MS LINE dataset'
  if (fault === 'raised-index') nativePage.items[at + 1].transform[5] += 4
  if (fault === 'no-percentage') nativePage.items[at].str = 'AP (65.7 AP'
  const result = extractDocument(document([nativePage]))
  assert.ok(result.units.some((unit) => unit.sourceOnly && unit.source.startsWith('AP (')))
})

test.each(['AP', 'AUC', 'ACC'])(
  'a percentage metric %s and its indexed alternate remain in the prose paragraph',
  (metric) => {
    const nativePage = structuredClone(
      readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
        'closed-parenthetical-native-body.jsonl'
      )[1].page
    )
    const at = nativePage.items.findIndex((part) => part.str.startsWith('AP ('))
    nativePage.items[at].str = metric + ' (65.7% ' + metric
    const result = extractDocument(document([nativePage]))
    assert.equal(result.units.length, 1)
    assert.equal(result.units[0].sourceOnly, undefined)
    assert.ok(result.units[0].source.includes('43.5% ' + metric + ' (65.7% ' + metric + '50)'))
  }
)

test.each(
  readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
    'inline-letter-numeric-fraction-native-body.jsonl'
  )
)('$name preserves both stacked denominators in its source paragraph', ({ page: nativePage }) => {
  const result = extractDocument(document([nativePage]))
  assert.equal(result.units.length, 1)
  assert.equal(result.units[0].sourceOnly, undefined)
  assert.match(result.units[0].source, /number of tokens \( H\/4 × W\/4 \), and variable/u)
  assert.equal(
    new Set(result.units.flatMap((unit) => unit.items)).size,
    nativePage.items.filter((part) => part.str.trim()).length
  )
})

test.each(
  readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
    'native-margin-appendix-heading.jsonl'
  )
)('$name ends the bibliography at its native section heading', ({ pages: nativePages }) => {
  const result = extractDocument(document(nativePages))
  assert.equal(result.units.find((unit) => unit.source === 'A Appendix')?.sourceOnly, undefined)
  assert.equal(
    result.units.find((unit) => unit.source.startsWith('Since our model'))?.sourceOnly,
    undefined
  )
  assert.ok(result.units.find((unit) => unit.source.startsWith('1. Al-Font'))?.sourceOnly)
  assert.equal(
    new Set(result.units.flatMap((unit) => unit.items)).size,
    nativePages.flatMap((nativePage) => nativePage.items.filter((part) => part.str.trim())).length
  )
})

test.each([
  'section-font',
  'body-size',
  'citation-title',
  'wrong-subsection',
  'missing-body',
  'wide-gap'
])('a page-margin appendix needs native section and subsection/body evidence: %s', (fault) => {
  const nativePages = structuredClone(
    readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
      'native-margin-appendix-heading.jsonl'
    )[0].pages
  )
  const appendixPage = nativePages[1]
  if (fault === 'section-font')
    for (const part of appendixPage.items.slice(4, 7)) part.fontName = 'different-section'
  if (fault === 'body-size')
    for (const part of appendixPage.items.slice(4, 7)) {
      part.height = 10
      part.transform[0] = part.transform[3] = 10
    }
  if (fault === 'citation-title') appendixPage.items[6].str = 'Appendix publication details'
  if (fault === 'wrong-subsection') appendixPage.items[8].str = 'B.1'
  if (fault === 'missing-body') appendixPage.items = appendixPage.items.slice(0, 12)
  if (fault === 'wide-gap') for (const part of appendixPage.items.slice(12)) part.transform[5] -= 40
  const result = extractDocument(document(nativePages))
  assert.ok(result.units.find((unit) => unit.source.startsWith('A Appendix'))?.sourceOnly)
  assert.ok(result.units.find((unit) => unit.source.startsWith('1. Al-Font'))?.sourceOnly)
})

test.each(
  readPdfTranslationCases<{ name: string; joined: string; page: PdfLayoutPage }>(
    'short-native-prose-continuations.jsonl'
  )
)('joins short prose continuations with native flow evidence: $name', ({ page, joined }) => {
  const result = extractDocument({ pages: [page] })
  assert.ok(
    result.units.some((unit) => unit.source.includes(joined)),
    joined
  )
  const owners = result.units.flatMap((unit) => unit.items)
  assert.equal(owners.length, new Set(owners).size)
})

test.each(['font', 'native-interruption', 'terminal', 'heading', 'formula', 'citation'])(
  'keeps short cross-column text separate without prose-flow evidence: %s',
  (fault) => {
    const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
      'short-native-prose-continuations.jsonl'
    )[1]
    const input = structuredClone(fixture.page)
    const start = input.items.findIndex((item) => item.str.startsWith('models are separate'))
    if (fault === 'font') input.items[start].fontName = 'separate-heading-font'
    if (fault === 'native-interruption')
      input.items.splice(start, 0, {
        ...input.items[start],
        str: 'x = y',
        transform: [...input.items[start].transform.slice(0, 4), 100, 50]
      })
    if (fault === 'terminal') input.items[start - 1].str += '.'
    if (fault === 'heading') input.items[start].str = 'Independent section heading'
    if (fault === 'formula') input.items[start].str = 'x = y + z'
    if (fault === 'citation') input.items[start].str = '[12] Independent reference.'
    const result = extractDocument({ pages: [input] })
    assert.ok(
      !result.units.some(
        (unit) =>
          unit.items.includes(`1:${start - 1}`) &&
          unit.items.includes(`1:${fault === 'native-interruption' ? start + 1 : start}`)
      )
    )
  }
)

test.each(['font', 'gap', 'indent', 'native-interruption'])(
  'keeps short same-column prose separate when flow changes: %s',
  (fault) => {
    const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
      'short-native-prose-continuations.jsonl'
    )[0]
    const input = structuredClone(fixture.page)
    const tail = input.items.findIndex((item) => item.str === 'source.')
    if (fault === 'font') input.items[tail].fontName = 'separate-caption-font'
    if (fault === 'gap') input.items[tail].transform[5] -= 16
    if (fault === 'indent') input.items[tail].transform[4] += 20
    if (fault === 'native-interruption')
      input.items.splice(tail, 0, {
        ...input.items[tail],
        str: 'x = y',
        width: 22,
        transform: [...input.items[tail].transform.slice(0, 4), 200, 381]
      })
    const result = extractDocument({ pages: [input] })
    assert.ok(!result.units.some((unit) => unit.source.includes('less than a source.')))
  }
)

test.each(['new-name', 'first-line-indent', 'font', 'terminal'])(
  'does not use uppercase names to bridge an unsupported column boundary: %s',
  (fault) => {
    const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
      'short-native-prose-continuations.jsonl'
    )[3]
    const input = structuredClone(fixture.page)
    const next = input.items.findIndex((item) => item.str === 'SequeNce')
    if (fault === 'new-name') input.items[next].str = 'Results'
    if (fault === 'first-line-indent') input.items[next].transform[4] += 12
    if (fault === 'font') input.items[next].fontName = 'separate-heading-font'
    if (fault === 'terminal') input.items[next - 1].str += '.'
    const result = extractDocument({ pages: [input] })
    assert.ok(
      !result.units.some(
        (unit) => unit.items.includes(`2:${next - 1}`) && unit.items.includes(`2:${next}`)
      )
    )
  }
)

test.each(
  readPdfTranslationCases<{ name: string; page: PdfLayoutPage; expectedJoined: string }>(
    'adam-parenthetical-native-body.jsonl'
  )
)(
  'keeps a native parenthesized inline variable inside its prose: $name',
  ({ page, expectedJoined }) => {
    const result = extractDocument({ pages: [page] })
    assert.ok(result.units.some((unit) => unit.source.includes(expectedJoined)))
    assert.ok(
      !result.units.some((unit) => unit.source === '(vt' || unit.source.startsWith(') where'))
    )
  }
)

test.each(['no-introducing-prose', 'font', 'equation', 'no-close'])(
  'keeps independent mathematical prefixes isolated: %s',
  (fault) => {
    const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
      'adam-parenthetical-native-body.jsonl'
    )[0]
    const input = structuredClone(fixture.page)
    if (fault === 'no-introducing-prose') input.items[3].str += '.'
    if (fault === 'font') input.items[7].fontName = 'different-row'
    if (fault === 'equation') input.items[6].str = '=x'
    if (fault === 'no-close') input.items[7].str = 'where the final-typography'
    const result = extractDocument({ pages: [input] })
    assert.ok(
      !result.units.some((unit) => unit.items.includes('2:4') && unit.items.includes('2:7'))
    )
  }
)

test.each([
  ...readPdfTranslationCases<{ name: string; page: PdfLayoutPage; joined: string }>(
    'wrapped-citation-prose-boundaries.jsonl'
  ),
  ...readPdfTranslationCases<{ name: string; page: PdfLayoutPage; joined: string }>(
    'citation-native-body-continuations.jsonl'
  )
])(
  'keeps native prose continuations across citation and formula seams: $name',
  ({ page, joined }) => {
    const result = extractDocument({ pages: [page] })
    assert.ok(
      result.units.some((unit) => unit.source.includes(joined)),
      `${joined}: ${JSON.stringify(result.units.map((unit) => unit.source))}`
    )
    const owners = result.units.flatMap((unit) => unit.items)
    assert.equal(owners.length, new Set(owners).size)
  }
)

test.each(['font', 'gap', 'intervening-equation', 'finished-sentence', 'math-function'])(
  'requires native prose evidence before accepting dotted citation lead-ins: %s',
  (fault) => {
    const fixture = readPdfTranslationCases<{ page: PdfLayoutPage; joined: string }>(
      'citation-native-body-continuations.jsonl'
    )[1]
    const input = structuredClone(fixture.page)
    const next = input.items.findIndex((item) => item.str === 'et al.')
    const previous = input.items.findLastIndex((item) => item.str.endsWith('how Cue'))
    if (fault === 'font') input.items[next].fontName = 'independent-citation'
    if (fault === 'gap') for (const item of input.items.slice(next)) item.transform[5] -= 20
    if (fault === 'finished-sentence') input.items[previous].str += '.'
    if (fault === 'math-function') input.items[next].str = 'softmax'
    if (fault === 'intervening-equation')
      input.items.splice(next, 0, {
        ...input.items[next],
        str: 'x = y',
        width: 25,
        transform: [
          ...input.items[next].transform.slice(0, 4),
          108,
          input.items[next].transform[5] + 5
        ]
      })
    const result = extractDocument({ pages: [input] })
    assert.ok(!result.units.some((unit) => unit.source.includes(fixture.joined)))
    if (fault === 'math-function')
      assert.ok(!result.units.some((unit) => unit.source.includes('softmax [4] and Chiang')))
  }
)

test.each(['no-caption', 'open-label', 'symbolic-label', 'separate-baseline'])(
  'does not join unproven parenthesized caption labels: %s',
  (fault) => {
    const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
      'citation-native-body-continuations.jsonl'
    )[2]
    const input = structuredClone(fixture.page)
    const closing = input.items.findIndex((item) => item.str.startsWith(') with'))
    if (fault === 'no-caption') input.items[0].str = 'A separate model definition follows here.'
    if (fault === 'open-label') input.items[closing].str = input.items[closing].str.slice(1)
    if (fault === 'symbolic-label') input.items[2].str = 'x'
    if (fault === 'separate-baseline') input.items[2].transform[5] -= 8
    const result = extractDocument({ pages: [input] })
    assert.ok(
      !result.units.some(
        (unit) => unit.items.includes('2:0') && unit.items.includes(`2:${closing}`)
      )
    )
  }
)

test.each(
  readPdfTranslationCases<{ name: string; page: PdfLayoutPage; joined: string }>(
    'resnet-floating-caption-native.jsonl'
  )
)('flows around a geometrically bounded floating figure: $name', ({ page, joined }) => {
  const result = extractDocument({ pages: [page] })
  assert.ok(
    result.units.some((unit) => unit.source.includes(joined)),
    joined
  )
  assert.ok(result.units.some((unit) => unit.source.startsWith('Figure 1.')))
  const owners = result.units.flatMap((unit) => unit.items)
  assert.equal(owners.length, new Set(owners).size)
})

test.each(['no-caption', 'body-font', 'caption-width', 'out-of-column', 'finished-sentence'])(
  'does not jump across an unproven floating region: %s',
  (fault) => {
    const fixture = readPdfTranslationCases<{ page: PdfLayoutPage; joined: string }>(
      'resnet-floating-caption-native.jsonl'
    )[0]
    const input = structuredClone(fixture.page)
    const caption = input.items.findIndex((item) => item.str.startsWith('Figure 1.'))
    const footnote = input.items.findIndex((item) => item.str === 'https://example.invalid/source')
    const finalBody = input.items.findIndex((item) => item.str.endsWith('have also'))
    if (fault === 'no-caption') input.items[caption].str = 'Unclassified label'
    if (fault === 'body-font') {
      input.items[footnote].transform[0] = input.items[finalBody].transform[0]
      input.items[footnote].transform[3] = input.items[finalBody].transform[3]
      input.items[footnote].height = input.items[finalBody].height
    }
    if (fault === 'caption-width') input.items[caption].width *= 1.5
    if (fault === 'out-of-column') input.items[footnote].transform[4] = 295
    if (fault === 'finished-sentence') input.items[finalBody].str += '.'
    const result = extractDocument({ pages: [input] })
    assert.ok(!result.units.some((unit) => unit.source.includes(fixture.joined)))
  }
)

test.each(['font', 'gap', 'closed-citation'])(
  'does not attach an independent year to prose: %s',
  (fault) => {
    const fixture = readPdfTranslationCases<{ page: PdfLayoutPage; joined: string }>(
      'wrapped-citation-prose-boundaries.jsonl'
    )[0]
    const input = structuredClone(fixture.page)
    if (fault === 'font') input.items.at(-1)!.fontName = 'different-year-font'
    if (fault === 'gap') input.items.at(-1)!.transform[5] -= 20
    if (fault === 'closed-citation') input.items.at(-2)!.str += ').'
    const result = extractDocument({ pages: [input] })
    assert.ok(
      !result.units.some((unit) => unit.items.includes('1:6') && unit.items.includes('1:7'))
    )
  }
)

test.each(['different-left-edge', 'intervening-object', 'uppercase'])(
  'requires the native formula prefix to prove a prose-tail wrap: %s',
  (fault) => {
    const fixture = readPdfTranslationCases<{ page: PdfLayoutPage; joined: string }>(
      'wrapped-citation-prose-boundaries.jsonl'
    )[3]
    const input = structuredClone(fixture.page)
    if (fault === 'different-left-edge') input.items[2].transform[4] += 15
    if (fault === 'uppercase') input.items[17].str = 'New section title'
    if (fault === 'intervening-object')
      input.items.splice(17, 0, {
        ...input.items[17],
        str: 'x = y',
        width: 25,
        transform: [...input.items[17].transform.slice(0, 4), 108, 693]
      })
    const result = extractDocument({ pages: [input] })
    assert.ok(!result.units.some((unit) => unit.source.includes(fixture.joined)))
  }
)

const numericCompoundBulletFixture = () =>
  structuredClone(
    readPdfTranslationCases<{ page: PdfLayoutPage }>('numeric-compound-bullet-native-body.jsonl')[0]
      .page
  )

test('numeric compound bullets retain complete native list records and unique owners', () => {
  const input = numericCompoundBulletFixture()
  const result = extractDocument({ pages: [input] })
  assert.equal(result.units.length, 4)
  assert.equal(
    result.units[1].source,
    '• Measureme no positioned observation: Arrangement the inputs as a tag of columns.'
  )
  assert.equal(
    result.units[2].source,
    '• 1-arrangement positioned measureme: Arrangement the inputs as a standard of columns in the values exact (precise across all other arrangement in this frame).'
  )
  assert.ok(result.units[3].source.startsWith('• 2-arrangement positioned measureme:'))
  assert.ok(result.units[3].source.includes('in run positioned.'))
  const owned = result.units.flatMap((unit) => unit.items)
  const expected = input.items.flatMap((item, index) => (item.str.trim() ? [`16:${index}`] : []))
  assert.deepEqual([...owned].sort(), expected.sort())
})

test.each(['font', 'gap', 'indent', 'interrupted', 'finished-bullet', 'uppercase'])(
  'numeric compound bullet terminal wraps require native prose evidence: %s',
  (fault) => {
    const input = numericCompoundBulletFixture()
    const lead = input.items.findIndex((item) => item.str.startsWith('• 1-arrangement'))
    const tail = input.items.findIndex((item) => item.str.startsWith('the values exact'))
    if (fault === 'font') input.items[tail].fontName = 'independent-font'
    if (fault === 'gap') input.items[tail].transform[5] -= 20
    if (fault === 'indent') input.items[tail].transform[4] += 20
    if (fault === 'finished-bullet') input.items[lead].str += '.'
    if (fault === 'uppercase') input.items[tail].str = 'The independent section ends here.'
    if (fault === 'interrupted')
      input.items.splice(tail, 0, {
        ...input.items[tail],
        str: 'x = y',
        width: 25,
        transform: [...input.items[tail].transform.slice(0, 4), 540, 100]
      })
    const result = extractDocument({ pages: [input] })
    assert.ok(!result.units.some((unit) => unit.source.includes('columns in the values exact')))
  }
)

const yearProseTailFixture = () =>
  structuredClone(
    readPdfTranslationCases<{ page: PdfLayoutPage }>('year-prose-tail-native-body.jsonl')[0].page
  )

test('a native publication year tail stays with its complete quoted-title sentence', () => {
  const input = yearProseTailFixture()
  const result = extractDocument({ pages: [input] })
  assert.equal(result.units.length, 1)
  assert.ok(result.units[0].source.endsWith('was measureme in 1926.'))
  assert.deepEqual(result.units[0].items, ['8:0', '8:1', '8:2', '8:4', '8:5', '8:6'])
})

test.each([
  'font',
  'gap',
  'column',
  'interrupted',
  'finished-sentence',
  'standalone-year',
  'partial-year',
  'year-range',
  'unclosed-title',
  'equation',
  'timeline'
])('publication year tails require continuous native prose: %s', (fault) => {
  const input = yearProseTailFixture()
  const tail = input.items.at(-1)!
  if (fault === 'font') tail.fontName = 'independent-year'
  if (fault === 'gap') tail.transform[5] -= 12
  if (fault === 'column') tail.transform[4] += 220
  if (fault === 'finished-sentence') input.items[5].str += '.'
  if (fault === 'standalone-year') tail.str = '1926.'
  if (fault === 'partial-year') tail.str = 'in 26.'
  if (fault === 'year-range') tail.str = 'in 1926–1927.'
  if (fault === 'unclosed-title') input.items[4].str = '”The Tag Also Rules'
  if (fault === 'equation') input.items[4].str = '”x = y”'
  if (fault === 'timeline') {
    input.items[2].str = 'A'
    input.items[4].str = 'B'
    input.items[5].str = 'C'
  }
  if (fault === 'interrupted')
    input.items.splice(6, 0, {
      ...tail,
      str: 'x = y',
      width: 20,
      transform: [...tail.transform.slice(0, 4), 400, 650]
    })
  const result = extractDocument({ pages: [input] })
  assert.ok(!result.units.some((unit) => unit.source.includes('was measureme in 1926.')))
  if (fault !== 'column')
    assert.ok(
      !result.units.some(
        (unit) =>
          unit.items.includes('8:5') && unit.items.includes(`8:${fault === 'interrupted' ? 7 : 6}`)
      )
    )
})

const literalQuantityFixtures = () =>
  readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
    'wrapped-literal-quantity-native-body.jsonl'
  )

test.each(literalQuantityFixtures())(
  'wrapped numeric comparisons retain one complete native prose owner: $name',
  ({ page }) => {
    const result = extractDocument({ pages: [page] })
    assert.equal(result.units.length, 1)
    assert.ok(!result.units[0].sourceOnly)
    assert.ok(
      result.units[0].source.includes(
        page.page === 1 ? 'fast inference (5× higher throughput' : 'continuation case (>1M tokens).'
      )
    )
    assert.deepEqual(
      [...result.units[0].items].sort(),
      page.items.flatMap((item, index) => (item.str.trim() ? [`${page.page}:${index}`] : [])).sort()
    )
  }
)

test.each(
  literalQuantityFixtures().flatMap((fixture) =>
    [
      'font',
      'gap',
      'column',
      'interrupted',
      'finished-sentence',
      'no-context',
      'symbolic-operand',
      'no-close',
      'operator-baseline',
      'operator-size'
    ].map((fault) => ({ ...fixture, fault }))
  )
)('wrapped literal quantities require native body context: $name / $fault', ({ page, fault }) => {
  const input = structuredClone(page)
  const first = input.items.findIndex(
    (item) => item.str === '(' || item.str.startsWith('inference (5')
  )
  const operator = input.items.findIndex((item) => item.str === '×' || item.str === '>')
  const after = input.items.findIndex((item, index) => index > operator && Boolean(item.str.trim()))
  const previous = input.items.findLastIndex(
    (item, index) => index < first && Boolean(item.str.trim())
  )
  if (fault === 'font') input.items[after].fontName = 'independent-body'
  if (fault === 'gap') for (const item of input.items.slice(first)) item.transform[5] -= 20
  if (fault === 'column') for (const item of input.items.slice(first)) item.transform[4] += 220
  if (fault === 'finished-sentence') input.items[previous].str += '.'
  if (fault === 'no-context') input.items = input.items.slice(first)
  if (fault === 'symbolic-operand')
    input.items[after].str = 'x + y) where the result is calculated.'
  if (fault === 'no-close') input.items[after].str = input.items[after].str.replace(')', '')
  if (fault === 'operator-baseline') input.items[operator].transform[5] -= 3
  if (fault === 'operator-size') {
    input.items[operator].height *= 1.5
    input.items[operator].transform[0] *= 1.5
    input.items[operator].transform[3] *= 1.5
  }
  if (fault === 'interrupted')
    input.items.splice(first, 0, {
      ...input.items[first],
      str: 'x = y',
      width: 25,
      transform: [...input.items[first].transform.slice(0, 4), 560, 300]
    })
  const result = extractDocument({ pages: [input] })
  assert.ok(
    !result.units.some((unit) =>
      unit.source.includes(
        page.page === 1 ? 'fast inference (5× higher throughput' : 'continuation case (>1M tokens).'
      )
    )
  )
})

const wrappedNumericSentenceFixture = () =>
  structuredClone(
    readPdfTranslationCases<{ page: PdfLayoutPage }>(
      'wrapped-numeric-sentence-native-body.jsonl'
    )[0].page
  )

test('a wrapped prose literal sentence ending does not start an unrelated numbered list', () => {
  const input = wrappedNumericSentenceFixture()
  const result = extractDocument({ pages: [input] })
  assert.equal(result.units.length, 1)
  assert.ok(
    result.units[0].source.includes('the total standard length minus 20. To samples offsets')
  )
  assert.ok(!result.units[0].sourceOnly)
  assert.deepEqual(
    [...result.units[0].items].sort(),
    input.items.flatMap((item, index) => (item.str.trim() ? [`27:${index}`] : [])).sort()
  )
})

test.each([
  'font',
  'gap',
  'column',
  'interrupted',
  'finished-sentence',
  'list-introduction',
  'no-quantity-context',
  'symbolic-expression',
  'page-number',
  'table-label'
])(
  'literal prose numbers require native continuation instead of list/table evidence: %s',
  (fault) => {
    const input = wrappedNumericSentenceFixture()
    const last = input.items.findIndex((item) => item.str.endsWith('length minus'))
    const next = input.items.findIndex((item) => item.str.startsWith('20. To samples'))
    if (fault === 'font') input.items[next].fontName = 'independent-list-font'
    if (fault === 'gap') for (const item of input.items.slice(next)) item.transform[5] -= 20
    if (fault === 'column') for (const item of input.items.slice(next)) item.transform[4] += 220
    if (fault === 'finished-sentence') input.items[last].str += '.'
    if (fault === 'list-introduction')
      input.items[last].str = 'The following steps describe this measurement procedure:'
    if (fault === 'no-quantity-context')
      input.items[last].str = input.items[last].str.replace('minus', 'and')
    if (fault === 'symbolic-expression') input.items[last].str = 'A = B + C minus'
    if (fault === 'page-number') input.items[next].str = '20.'
    if (fault === 'table-label') {
      input.items[last].str = 'Length minus'
      input.items[last].width = 55
      input.items = input.items.slice(last)
    }
    if (fault === 'interrupted')
      input.items.splice(next, 0, {
        ...input.items[next],
        str: 'Independent material',
        width: 65,
        transform: [...input.items[next].transform.slice(0, 4), 560, 350]
      })
    const result = extractDocument({ pages: [input] })
    assert.ok(!result.units.some((unit) => unit.source.includes('minus 20. To samples offsets')))
    if (fault === 'page-number')
      assert.ok(!result.units.some((unit) => unit.source.endsWith('minus 20.')))
  }
)

const parentheticalTerminalWordFixture = () =>
  structuredClone(
    readPdfTranslationCases<{ page: PdfLayoutPage }>(
      'parenthetical-terminal-word-native-body.jsonl'
    )[0].page
  )

test('a short native word closes its open multiword parenthetical prose sentence', () => {
  const input = parentheticalTerminalWordFixture()
  const result = extractDocument({ pages: [input] })
  assert.equal(result.units.length, 1)
  assert.ok(result.units[0].source.endsWith('all models for these task).'))
  assert.deepEqual(result.units[0].items, ['32:0', '32:1', '32:2'])
})

test.each([
  'font',
  'gap',
  'column',
  'interrupted',
  'closed-parenthesis',
  'no-parenthesis',
  'function-operand',
  'annotation'
])('a closing parenthetical word requires its adjacent native prose owner: %s', (fault) => {
  const input = parentheticalTerminalWordFixture()
  if (fault === 'font') input.items[2].fontName = 'independent-tail'
  if (fault === 'gap') input.items[2].transform[5] -= 20
  if (fault === 'column') input.items[2].transform[4] += 220
  if (fault === 'closed-parenthesis') input.items[1].str += ')'
  if (fault === 'no-parenthesis') input.items[1].str = input.items[1].str.replace('(', '')
  if (fault === 'function-operand')
    input.items[1].str = 'length for HellaSwag and ARC-challenge using sigmoid(task'
  if (fault === 'annotation') input.items[2].str = '(Independent annotation).'
  if (fault === 'interrupted')
    input.items.splice(2, 0, {
      ...input.items[2],
      str: 'x = y',
      width: 25,
      transform: [...input.items[2].transform.slice(0, 4), 560, 300]
    })
  const result = extractDocument({ pages: [input] })
  assert.ok(
    !result.units.some(
      (unit) =>
        unit.items.includes('32:1') && unit.items.includes(`32:${fault === 'interrupted' ? 3 : 2}`)
    )
  )
})

const colonTailProseFixtures = () =>
  readPdfTranslationCases<{ name: string; kind: string; page: PdfLayoutPage }>(
    'colon-tail-native-body-continuations.jsonl'
  )

test.each(colonTailProseFixtures())(
  'real native prose keeps its terminal word and list ownership: $name',
  ({ page, kind }) => {
    const result = extractDocument({ pages: [page] })
    assert.equal(result.units.length, 1)
    assert.ok(!result.units[0].sourceOnly)
    assert.ok(
      result.units[0].source.includes(
        kind === 'lowercase-colon-tail'
          ? 'following text ordered:'
          : kind === 'alphanumeric-bullet-hanging-wrap'
            ? 'using degree models'
            : 'Text et al. [2019a].'
      )
    )
    assert.deepEqual(
      [...result.units[0].items].sort(),
      page.items.flatMap((item, index) => (item.str.trim() ? [`${page.page}:${index}`] : [])).sort()
    )
  }
)

test.each(
  colonTailProseFixtures().flatMap((fixture) =>
    ['font', 'gap', 'column', 'interrupted', 'missing-context'].map((fault) => ({
      ...fixture,
      fault
    }))
  )
)(
  'terminal prose/list continuations require native body evidence: $name / $fault',
  ({ page, kind, fault }) => {
    const input = structuredClone(page)
    const next =
      kind === 'alphanumeric-bullet-hanging-wrap'
        ? input.items.findIndex((item) => item.str.startsWith('models, we movement'))
        : input.items.length - 1
    const previous = input.items.findLastIndex(
      (item, index) => index < next && Boolean(item.str.trim())
    )
    if (fault === 'font') input.items[next].fontName = 'independent-prose'
    if (fault === 'gap') for (const item of input.items.slice(next)) item.transform[5] -= 20
    if (fault === 'column') for (const item of input.items.slice(next)) item.transform[4] += 220
    if (fault === 'missing-context') {
      if (kind === 'alphanumeric-bullet-hanging-wrap') input.items[0].str = 'Independent'
      else input.items[previous].str += '.'
    }
    if (fault === 'interrupted')
      input.items.splice(next, 0, {
        ...input.items[next],
        str: 'Independent material',
        width: 65,
        transform: [...input.items[next].transform.slice(0, 4), 560, 300]
      })
    const result = extractDocument({ pages: [input] })
    assert.ok(
      !result.units.some((unit) =>
        unit.source.includes(
          kind === 'lowercase-colon-tail'
            ? 'following text ordered:'
            : kind === 'alphanumeric-bullet-hanging-wrap'
              ? 'using degree models'
              : 'Text et al. [2019a].'
        )
      )
    )
  }
)

test.each(['no-author', 'no-year', 'unclosed-citation', 'function', 'uppercase-colon'])(
  'short terminal reference and colon tails retain their semantic boundary: %s',
  (fault) => {
    const fixture = colonTailProseFixtures()[fault === 'uppercase-colon' ? 0 : 2]
    const input = structuredClone(fixture.page)
    const last = input.items.length - 1
    if (fault === 'no-author')
      input.items[last - 1].str = input.items[last - 1].str.replace('Text', 'text')
    if (fault === 'no-year') input.items[last].str = 'et al. [x].'
    if (fault === 'unclosed-citation') input.items[last].str = 'et al. [2019a.'
    if (fault === 'function') input.items[last].str = 'exp [2019a].'
    if (fault === 'uppercase-colon') input.items[last].str = 'Corpora:'
    const result = extractDocument({ pages: [input] })
    assert.ok(
      !result.units.some(
        (unit) =>
          unit.items.includes(`${input.page}:${last - 1}`) &&
          unit.items.includes(`${input.page}:${last}`)
      )
    )
  }
)

test.each(['standalone-citation', 'standalone-year', 'display-math', 'indent'])(
  'dated author tails do not absorb independent bibliography or mathematical material: %s',
  (fault) => {
    const input = structuredClone(colonTailProseFixtures()[2].page)
    const last = input.items.length - 1
    if (fault === 'standalone-citation') input.items = input.items.slice(last)
    if (fault === 'standalone-year') {
      input.items[last].str = '2019a.'
      input.items = input.items.slice(last)
    }
    if (fault === 'display-math') {
      input.items[last - 1].str = 'f(x) = sin(x)'
      input.items[last - 1].width = 75
      input.items = input.items.slice(last - 1)
    }
    if (fault === 'indent') input.items[last].transform[4] += 15
    const result = extractDocument({ pages: [input] })
    if (fault === 'standalone-citation') {
      assert.equal(result.units.length, 1)
      assert.ok(result.units[0].sourceOnly)
    } else if (fault === 'standalone-year') {
      assert.equal(result.units.length, 1)
      assert.equal(result.units[0].source, '2019a.')
    } else if (fault === 'display-math') {
      assert.ok(result.units.every((unit) => unit.sourceOnly))
    } else
      assert.ok(
        !result.units.some(
          (unit) => unit.items.includes(`24:${last - 1}`) && unit.items.includes(`24:${last}`)
        )
      )
  }
)

const runInFieldFixtures = () =>
  readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>('run-in-field-native-body.jsonl')

test.each(runInFieldFixtures())(
  'real styled example fields keep their hanging body continuation: $name',
  ({ page }) => {
    const result = extractDocument({ pages: [page] })
    assert.equal(result.units.length, 1)
    assert.ok(!result.units[0].sourceOnly)
    assert.deepEqual(
      [...result.units[0].items].sort(),
      page.items.flatMap((item, index) => (item.str.trim() ? [`${page.page}:${index}`] : [])).sort()
    )
    assert.ok(result.units[0].source.endsWith(page.items.at(-1)!.str))
  }
)

test.each([
  'font',
  'font-size',
  'operator-baseline',
  'gap',
  'column',
  'interrupted',
  'finished',
  'unlabelled',
  'same-font',
  'standalone-label',
  'new-field',
  'display-math',
  'table-row'
])('run-in fields require an immediate native body continuation: %s', (fault) => {
  const input = structuredClone(runInFieldFixtures()[5].page)
  const last = input.items.length - 1
  if (fault === 'font') input.items[last].fontName = 'other-body'
  if (fault === 'font-size') {
    input.items[last].height *= 1.3
    input.items[last].transform[0] *= 1.3
    input.items[last].transform[3] *= 1.3
  }
  if (fault === 'operator-baseline') {
    input.items[last].width /= 2
    input.items.push({
      ...input.items[last],
      str: 'separate raised annotation',
      transform: [
        ...input.items[last].transform.slice(0, 4),
        150,
        input.items[last].transform[5] + 2
      ]
    })
  }
  if (fault === 'gap') input.items[last].transform[5] -= 20
  if (fault === 'column') input.items[last].transform[4] += 220
  if (fault === 'interrupted')
    input.items.splice(last, 0, {
      ...input.items[last],
      str: 'Independent material',
      width: 65,
      transform: [...input.items[last].transform.slice(0, 4), 560, 300]
    })
  if (fault === 'finished') input.items[last - 1].str += '.'
  if (fault === 'unlabelled') input.items[0].str = 'Independent heading'
  if (fault === 'same-font') input.items[0].fontName = input.items[last].fontName
  if (fault === 'standalone-label') input.items.splice(1, last - 1)
  if (fault === 'new-field') {
    input.items[last].str = 'Processed target: another independent example.'
    input.items[last].fontName = input.items[0].fontName
  }
  if (fault === 'display-math') input.items[last].str = 'f(x) = sin(x)'
  if (fault === 'table-row') {
    input.items[last].str = '12.0'
    input.items[last].width = 20
    input.items.push({
      ...input.items[last],
      str: '31.0',
      transform: [...input.items[last].transform.slice(0, 4), 300, input.items[last].transform[5]]
    })
  }
  const result = extractDocument({ pages: [input] })
  const tail = fault === 'interrupted' ? last + 1 : fault === 'standalone-label' ? 1 : last
  assert.ok(
    !result.units.some(
      (unit) =>
        unit.items.includes(`${input.page}:0`) && unit.items.includes(`${input.page}:${tail}`)
    )
  )
})

test('a run-in field preserves stable hanging x across several body rows and separates the next field', () => {
  const input = structuredClone(runInFieldFixtures()[5].page)
  input.items.at(-1)!.str = 'court before considering another open question'
  input.items.push({
    ...input.items.at(-1)!,
    str: 'about the final outcome.',
    transform: [
      ...input.items.at(-1)!.transform.slice(0, 5),
      input.items.at(-1)!.transform[5] - 11.956
    ]
  })
  const nextField = structuredClone(runInFieldFixtures()[6].page.items)
  const offset = nextField[0].transform[5] - input.items.at(-1)!.transform[5] + 19
  for (const item of nextField) item.transform[5] -= offset
  input.items.push(...nextField)
  const result = extractDocument({ pages: [input] })
  assert.equal(result.units.length, 2)
  assert.ok(result.units[0].source.endsWith('about the final outcome.'))
  assert.ok(result.units[1].source.startsWith('Processed input:'))
})

test('a styled field does not change its hanging indent mid-example', () => {
  const input = structuredClone(runInFieldFixtures()[5].page)
  input.items.at(-1)!.str = 'court before considering another open question'
  input.items.push({
    ...input.items.at(-1)!,
    str: 'about the final outcome.',
    transform: [
      ...input.items.at(-1)!.transform.slice(0, 4),
      input.items.at(-1)!.transform[4] + 8,
      input.items.at(-1)!.transform[5] - 11.956
    ]
  })
  const result = extractDocument({ pages: [input] })
  assert.ok(
    !result.units.some((unit) => unit.items.includes('50:0') && unit.items.includes('50:4'))
  )
})

const fractionNeighborFixture = () =>
  structuredClone(
    readPdfTranslationCases<{ page: PdfLayoutPage }>('fraction-neighbor-native-body.jsonl')[0].page
  )

test('a fraction drawn later in the other column does not interrupt contiguous clinical prose', () => {
  const input = fractionNeighborFixture()
  const result = extractDocument({ pages: [input] })
  assert.ok(
    result.units.some(
      (unit) =>
        !unit.sourceOnly &&
        unit.source.includes('INFO in the ordered trace was 27.5%') &&
        unit.items.includes('5:0') &&
        unit.items.includes('5:1') &&
        unit.items.includes('5:2')
    )
  )
  assert.ok(result.units.some((unit) => unit.sourceOnly && unit.items.includes('5:3')))
  assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, 5)
})

test.each(['adjacent', 'large-gap', 'multiple-candidates', 'interrupted-native'])(
  'fraction-tail boundaries depend on local geometry and the same native sequence: %s',
  (fault) => {
    const input = fractionNeighborFixture()
    const [first, next, last, numerator, denominator] = input.items
    input.items = [first, numerator, denominator, next, last]
    if (fault === 'large-gap') {
      numerator.transform[4] -= 50
      denominator.transform[4] -= 50
    }
    if (fault === 'multiple-candidates')
      input.items.unshift(
        {
          ...numerator,
          transform: [...numerator.transform.slice(0, 4), 100, numerator.transform[5]]
        },
        {
          ...denominator,
          transform: [...denominator.transform.slice(0, 4), 100, denominator.transform[5]]
        }
      )
    if (fault === 'interrupted-native')
      input.items.splice(3, 0, {
        ...first,
        str: 'Independent native material',
        transform: [...first.transform.slice(0, 4), 560, 500],
        width: 30
      })
    const result = extractDocument({ pages: [input] })
    assert.equal(
      result.units.some((unit) => unit.source.includes('INFO in the ordered trace was 27.5%')),
      fault === 'large-gap' || fault === 'interrupted-native'
    )
    assert.ok(result.units.some((unit) => unit.sourceOnly && unit.source.includes('0.018*')))
    assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, input.items.length)
  }
)

test('DDPM preserves the intervening equation when a fraction has a symbolic suffix before prose', () => {
  const { page } = readPdfTranslationCases<{ page: PdfLayoutPage }>(
    'fraction-symbol-suffix-native-body.jsonl'
  )[0]
  const result = extractDocument({ pages: [page] })
  const before = result.units.find((unit) => unit.source.startsWith('from xt.'))!
  const after = result.units.find((unit) => unit.source.startsWith(', where z'))!
  assert.ok(before && after && before !== after)
  assert.equal(before.source, 'from xt. To output xt−1 ∼ pθ(xt−1|xt) is')
  assert.equal(after.source, ', where z ∼ N (0, I). The movement complete')
  assert.ok(result.units.some((unit) => unit.sourceOnly && unit.source === '+ σtz'))
  assert.deepEqual(
    result.units.flatMap((unit) => unit.items).sort(),
    page.items.flatMap((item, index) => (item.str.trim() ? [`4:${index}`] : [])).sort()
  )
})

test.each(['local', 'prose', 'baseline', 'column', 'gap', 'overlap', 'size'])(
  'a symbolic fraction suffix must stay in its immediate native geometry: %s',
  (fault) => {
    const input = fractionNeighborFixture()
    const [first, next, last, numerator, denominator] = input.items
    const suffix = {
      ...next,
      str: 'σ',
      fontName: 'native-math',
      width: 5,
      transform: [...next.transform.slice(0, 4), 282, next.transform[5]]
    }
    input.items = [first, numerator, denominator, suffix, next, last]
    if (fault === 'prose') suffix.str = 'external prose'
    if (fault === 'baseline') suffix.transform[5] += 30
    if (fault === 'column') suffix.transform[4] = 600
    if (fault === 'gap') suffix.transform[4] += 10
    if (fault === 'overlap') suffix.width += 25
    if (fault === 'size') {
      suffix.height *= 2
      suffix.transform[0] *= 2
      suffix.transform[3] *= 2
    }
    const result = extractDocument({ pages: [input] })
    assert.equal(
      result.units.some((unit) => unit.source.includes('INFO in the ordered trace was 27.5%')),
      fault !== 'local'
    )
    assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, input.items.length)
  }
)

const numberedTitleFixtures = () =>
  readPdfTranslationCases<{
    name: string
    joined: string
    headIndex: number
    tailIndex: number
    page: PdfLayoutPage
  }>('numbered-title-wrap-native.jsonl')

test.each(numberedTitleFixtures())('$name keeps its complete native title', ({ page, joined }) => {
  const result = extractDocument({ pages: [page] })
  assert.ok(result.units.some((unit) => unit.source === joined && !unit.sourceOnly))
  assert.deepEqual(
    result.units.flatMap((unit) => unit.items).sort(),
    page.items.flatMap((item, index) => (item.str.trim() ? [`${page.page}:${index}`] : [])).sort()
  )
})

test.each([
  'font',
  'body-font',
  'font-size',
  'gap',
  'indent',
  'interrupted',
  'terminal',
  'formula'
])('a wrapped numbered title requires adjacent matching heading ownership: %s', (fault) => {
  const { page: input, headIndex, tailIndex } = structuredClone(numberedTitleFixtures()[1])
  const first = input.items[headIndex]
  const title = input.items[headIndex + 2]
  const tail = input.items[tailIndex]
  if (fault === 'font') tail.fontName = 'other-heading'
  if (fault === 'body-font') {
    for (let index = headIndex; index <= tailIndex; index++)
      input.items[index].fontName = input.items.at(-1)!.fontName
  }
  if (fault === 'font-size') tail.transform[3] *= 1.3
  if (fault === 'gap') tail.transform[5] -= 20
  if (fault === 'indent') tail.transform[4] += 8
  if (fault === 'interrupted') {
    input.items.splice(tailIndex, 0, {
      ...first,
      str: 'Intervening independent text',
      width: 100,
      transform: [first.height!, 0, 0, first.height!, 350, first.transform[5]]
    })
  }
  if (fault === 'terminal') title.str += '.'
  if (fault === 'formula') tail.str = 'x + y = z'
  const result = extractDocument({ pages: [input] })
  assert.ok(
    !result.units.some(
      (unit) =>
        unit.items.includes(`${input.page}:${headIndex}`) &&
        unit.items.includes(`${input.page}:${input.items.indexOf(tail)}`)
    )
  )
})

test('native norm scripts are retained without inventing a numeric fraction', () => {
  const { page } = readPdfTranslationCases<{ page: PdfLayoutPage }>(
    'norm-script-native-body.jsonl'
  )[0]
  const result = extractDocument({ pages: [page] })
  assert.equal(result.units.length, 1)
  assert.ok(result.units[0].source.includes('λ‖w‖22'))
  assert.ok(!result.units[0].source.includes('2/2'))
  assert.deepEqual(
    result.units[0].items.slice().sort(),
    page.items.flatMap((item, index) => (item.str.trim() ? [`${page.page}:${index}`] : [])).sort()
  )
})

test.each(['’', "'"])(
  'a native question heading keeps the possessive tail (%s) separate from following prose',
  (apostrophe) => {
    const { page, joined } = readPdfTranslationCases<{ page: PdfLayoutPage; joined: string }>(
      'question-title-wrap-native.jsonl'
    )[0]
    page.items[3].str = page.items[3].str.replace('’', apostrophe)
    const result = extractDocument({ pages: [page] })
    assert.ok(result.units.some((unit) => unit.source === joined.replace('’', apostrophe)))
    assert.ok(result.units.some((unit) => unit.source.startsWith('Since update SPAn')))
    assert.deepEqual(
      result.units.flatMap((unit) => unit.items).sort(),
      page.items.flatMap((item, index) => (item.str.trim() ? [`${page.page}:${index}`] : [])).sort()
    )
  }
)

test.each([
  'body-font',
  'terminal-heading',
  'equation',
  'semicolon',
  'indent',
  'native-interruption'
])('question-title punctuation does not bypass native ownership: %s', (fault) => {
  const { page } = readPdfTranslationCases<{ page: PdfLayoutPage }>(
    'question-title-wrap-native.jsonl'
  )[0]
  const tail = page.items[3]
  if (fault === 'body-font') tail.fontName = page.items[5].fontName
  if (fault === 'terminal-heading') page.items[2].str += '?'
  if (fault === 'equation') tail.str = 'P(y|x) = 1?'
  if (fault === 'semicolon') tail.str = 'biLM; representations?'
  if (fault === 'indent') tail.transform[4] += 8
  if (fault === 'native-interruption')
    page.items.splice(3, 0, {
      ...tail,
      str: 'Intervening content',
      transform: [10.9091, 0, 0, 10.9091, 350, tail.transform[5]]
    })
  const result = extractDocument({ pages: [page] })
  assert.ok(
    !result.units.some(
      (unit) => unit.items.includes('7:0') && unit.items.includes(`7:${page.items.indexOf(tail)}`)
    )
  )
})

const standaloneHeadingFixtures = () =>
  readPdfTranslationCases<{
    name: string
    headings: string[]
    body: string
    page: PdfLayoutPage
  }>('standalone-heading-native-body.jsonl')

test.each(standaloneHeadingFixtures())(
  '$name keeps independently drawn section labels outside body prose',
  ({ headings, body, page }) => {
    const result = extractDocument({ pages: [page] })
    for (const heading of headings)
      assert.ok(result.units.some((unit) => unit.source === heading && !unit.sourceOnly))
    assert.ok(result.units.some((unit) => unit.source.startsWith(body)))
    assert.deepEqual(
      result.units.flatMap((unit) => unit.items).sort(),
      page.items.flatMap((item, index) => (item.str.trim() ? [`${page.page}:${index}`] : [])).sort()
    )
  }
)

test.each([
  'body-font',
  'missing-font',
  'inline-number',
  'lowercase',
  'lowercase-body',
  'run-in',
  'finished'
])('short numbered text requires independent heading evidence: %s', (fault) => {
  const { page } = structuredClone(standaloneHeadingFixtures()[1])
  const title = page.items[2],
    body = page.items[4]
  if (fault === 'body-font')
    for (const item of page.items.slice(0, 3)) item.fontName = body.fontName
  if (fault === 'missing-font') for (const item of page.items.slice(0, 3)) item.fontName = undefined
  if (fault === 'inline-number') {
    page.items[0].str += ' ' + title.str
    page.items[0].width = title.transform[4] + title.width - page.items[0].transform[4]
    title.str = ''
  }
  if (fault === 'lowercase') title.str = title.str.toLowerCase()
  if (fault === 'lowercase-body')
    body.str = 'is trained using all of the available examples in the corpus'
  if (fault === 'finished') title.str += '.'
  if (fault === 'run-in') {
    body.transform[4] = title.transform[4] + title.width + 5
    body.transform[5] = title.transform[5]
  }
  const result = extractDocument({ pages: [page] })
  assert.ok(result.units.some((unit) => unit.items.includes('3:0') && unit.items.includes('3:4')))
})

test.each(['body-font', 'finished', 'long-label', 'same-row', 'interrupted', 'lowercase-body'])(
  'an unnumbered label must independently precede its body: %s',
  (fault) => {
    const { page } = structuredClone(standaloneHeadingFixtures()[0])
    const title = page.items[2],
      body = page.items[4]
    if (fault === 'body-font') title.fontName = body.fontName
    if (fault === 'finished') title.str += '?'
    if (fault === 'long-label') title.width = body.width * 0.9
    if (fault === 'lowercase-body') {
      title.str = 'The proposed model'
      body.str = 'is trained using all of the available examples in the corpus'
    }
    if (fault === 'same-row') {
      body.transform[4] = title.transform[4] + title.width + 5
      body.transform[5] = title.transform[5]
    }
    if (fault === 'interrupted')
      page.items[3] = {
        ...title,
        str: 'Independent note',
        transform: [title.height!, 0, 0, title.height!, 72, title.transform[5]]
      }
    const result = extractDocument({ pages: [page] })
    assert.ok(result.units.some((unit) => unit.items.includes('2:2') && unit.items.includes('2:4')))
  }
)

const wrappedDoseFixture = () =>
  readPdfTranslationCases<{ source: string; page: PdfLayoutPage }>(
    'wrapped-dose-native-body.jsonl'
  )[0]

test('clinical anesthesia doses retain one complete prose owner and their raised unit powers', () => {
  const { source, page } = wrappedDoseFixture()
  const result = extractDocument({ pages: [page] })
  assert.deepEqual(
    result.units.map((unit) => unit.source),
    ['Structured', source]
  )
  assert.ok(result.units.every((unit) => !unit.sourceOnly))
  assert.deepEqual(
    result.units.flatMap((unit) => unit.items).sort(),
    page.items.flatMap((item, index) => (item.str.trim() ? [`3:${index}`] : [])).sort()
  )
})

test.each(['column', 'font', 'intervening-object', 'flat-powers', 'unknown-unit'])(
  'wrapped physical quantities require continuous body geometry and supported units: %s',
  (fault) => {
    const { page } = structuredClone(wrappedDoseFixture())
    if (fault === 'column') for (const item of page.items.slice(57, 69)) item.transform[4] += 260
    if (fault === 'font') page.items[57].fontName = 'unrelated-math-font'
    if (fault === 'intervening-object') {
      page.items[56] = {
        ...page.items[57],
        str: 'x = y',
        width: 30,
        transform: [9.8, 0, 0, 9.8, 450, page.items[57].transform[5]]
      }
    }
    if (fault === 'flat-powers')
      for (const item of page.items.slice(57, 68))
        if (item.height! < 9) {
          item.height = 9.8
          item.fontName = page.items[57].fontName
          item.transform[0] = item.transform[3] = 9.8
          item.transform[5] = page.items[57].transform[5]
        }
    if (fault === 'unknown-unit') page.items[57].str = page.items[57].str.replace('ug', 'xu')
    const result = extractDocument({ pages: [page] })
    assert.ok(
      !result.units.some((unit) => unit.items.includes('3:2') && unit.items.includes('3:57'))
    )
    assert.deepEqual(
      result.units.flatMap((unit) => unit.items).sort(),
      page.items.flatMap((item, index) => (item.str.trim() ? [`3:${index}`] : [])).sort()
    )
  }
)

test.each(
  ['min(x)', 'argmin(x)', 'x/y', 'x≠y', 'x−y', 'x=y', 'min (2 mg/kg)', 'argmax (2 mg/kg)'].flatMap(
    (symbol) => ['before', 'after'].map((position) => ({ symbol, position }))
  )
)('a dose cannot exempt neighboring mathematics: $position $symbol', ({ symbol, position }) => {
  const before = position === 'before'
  const inputs = [
    item('The response was estimated from the measured exposure using', 40, 100, 300),
    ...(before ? [item(symbol, 40, 112, 90, 10, false)] : []),
    item(
      before ? ' after propofol (1 mg/kg' : 'propofol (1 mg/kg',
      before ? 133 : 40,
      112,
      before ? 80 : 115,
      10,
      false
    ),
    item('−1', before ? 213 : 155, 109, 5, 7, false),
    item(
      before ? '), followed by evaluation.' : '), ',
      before ? 218 : 160,
      112,
      before ? 122 : 15,
      10,
      before
    ),
    ...(!before
      ? [item(symbol, 175, 112, 90, 10, false), item(' is evaluated.', 268, 112, 72)]
      : [])
  ].map((part) => ({ ...part, fontName: 'body' }))
  const result = extractDocument(document([page(inputs)]))
  const mathIndex = before ? 1 : 4
  assert.ok(
    !result.units.some(
      (unit) => unit.items.includes('1:0') && unit.items.includes(`1:${mathIndex}`)
    )
  )
})

test.each(['joint', 'split', 'digit-with-tail', 'minus-with-base', 'half-raised'])(
  'inverse-unit powers require the complete exponent to have raised native geometry: %s',
  (shape) => {
    const parts =
      shape === 'joint'
        ? [item('−1', 155, 112, 6, 10, false), item('), followed by evaluation.', 161, 112, 179)]
        : shape === 'digit-with-tail'
          ? [item('−', 155, 112, 3, 10, false), item('1), followed by evaluation.', 158, 112, 182)]
          : [
              ...(shape === 'minus-with-base'
                ? []
                : [
                    item(
                      '−',
                      155,
                      shape === 'half-raised' ? 109 : 112,
                      3,
                      shape === 'half-raised' ? 7 : 10,
                      false
                    )
                  ]),
              item('1', 158, 112, 3, 10, false),
              item('), followed by evaluation.', 161, 112, 179)
            ]
    const inputs = [
      item('The response was estimated from the measured exposure using', 40, 100, 300),
      item(
        shape === 'minus-with-base' ? 'propofol (1 mg/kg−' : 'propofol (1 mg/kg',
        40,
        112,
        shape === 'minus-with-base' ? 118 : 115,
        10,
        false
      ),
      ...parts
    ].map((part) => ({ ...part, fontName: 'body' }))
    const result = extractDocument(document([page(inputs)]))
    assert.ok(
      !result.units.some((unit) => unit.items.includes('1:0') && unit.items.includes('1:1'))
    )
  }
)

const observedTimeFixtures = () =>
  readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
    'observed-time-and-numeric-tail.jsonl'
  )

test.each(observedTimeFixtures())('$name remains complete native prose', ({ page }) => {
  const result = extractDocument({ pages: [page] })
  assert.equal(result.units.length, 1)
  assert.ok(!result.units[0].sourceOnly)
  assert.ok(
    result.units[0].source.includes(page.page === 3 ? 'end of minimum (T0)' : 'precision at 1.')
  )
  assert.deepEqual(
    result.units[0].items.sort(),
    page.items.flatMap((item, index) => (item.str.trim() ? [`${page.page}:${index}`] : [])).sort()
  )
})

test.each(['A', 'B', 'S'])(
  'observation labels use their documented sequence, not a fixed letter: %s',
  (label) => {
    const { page } = structuredClone(observedTimeFixtures()[0])
    for (const item of page.items) item.str = item.str.replace(/\(T(\d)\)/gu, `(${label}$1)`)
    const result = extractDocument({ pages: [page] })
    assert.equal(result.units.length, 1)
    assert.ok(!result.units[0].sourceOnly)
  }
)

test.each([
  'unordered',
  'duplicate',
  'mixed-labels',
  'missing-duration',
  'function',
  'formula-tail',
  'column',
  'font',
  'inserted-object',
  'raised-label',
  'argmin',
  'argmax',
  'missing-closing-label',
  'duplicate-closing-label',
  'skipped-closing-label',
  'closing-font',
  'closing-column'
])('timepoint prose requires a complete sequence and uninterrupted body ownership: %s', (fault) => {
  const { page } = structuredClone(observedTimeFixtures()[0])
  const line = page.items[23]
  if (fault === 'unordered') line.str = line.str.replace('(T2)', '(T5)')
  if (fault === 'duplicate') line.str = line.str.replace('(T2)', '(T1)')
  if (fault === 'mixed-labels') line.str = line.str.replace('(T2)', '(A2)')
  if (fault === 'missing-duration') line.str = line.str.replace('6 h (T2)', '(T2)')
  if (fault === 'function') line.str = line.str.replace('minimum', 'softmax')
  if (fault === 'argmin' || fault === 'argmax') line.str = line.str.replace('minimum', fault)
  if (fault === 'missing-closing-label')
    page.items[25].str = page.items[25].str.replace('(T4) ', '')
  if (fault === 'duplicate-closing-label')
    page.items[25].str = page.items[25].str.replace('(T4)', '(T3)')
  if (fault === 'skipped-closing-label')
    page.items[25].str = page.items[25].str.replace('(T4)', '(T7)')
  if (fault === 'closing-font') page.items[25].fontName = 'other'
  if (fault === 'closing-column') page.items[25].transform[4] += 260

  if (fault === 'formula-tail') line.str += ' + f(x)'
  if (fault === 'column') line.transform[4] += 260
  if (fault === 'font') line.fontName = 'math'
  if (fault === 'inserted-object')
    page.items[22] = {
      ...line,
      str: 'Independent annotation',
      width: 70,
      transform: [9.8, 0, 0, 9.8, 40, line.transform[5]]
    }
  if (fault === 'raised-label') {
    const prefix = { ...line, str: 'surgery ', width: 35 }
    const label = {
      ...line,
      str: '(T0)',
      width: 16,
      height: 6.8,
      transform: [6.8, 0, 0, 6.8, line.transform[4] + 35, line.transform[5] + 3]
    }
    const tail = {
      ...line,
      str: line.str.slice('surgery (T0)'.length),
      width: line.width - 51,
      transform: [...line.transform]
    }
    tail.transform[4] += 51
    page.items.splice(23, 1, prefix, label, tail)
  }
  const result = extractDocument({ pages: [page] })
  assert.ok(
    !result.units.some((unit) => unit.items.includes('3:21') && unit.items.includes('3:23'))
  )
  assert.deepEqual(
    result.units.flatMap((unit) => unit.items).sort(),
    page.items.flatMap((item, index) => (item.str.trim() ? [`3:${index}`] : [])).sort()
  )
})

test.each(['finished', 'column', 'font', 'native-gap', 'formula', 'list'])(
  'a short numeric sentence ending requires its own preceding body row: %s',
  (fault) => {
    const { page } = structuredClone(observedTimeFixtures()[1])
    if (fault === 'finished') page.items[1].str += '.'
    if (fault === 'column') page.items[2].transform[4] += 270
    if (fault === 'font') page.items[2].fontName = 'math'
    if (fault === 'native-gap')
      page.items.splice(2, 0, {
        ...page.items[2],
        str: 'Separate note',
        transform: [10, 0, 0, 10, 350, page.items[2].transform[5]]
      })
    if (fault === 'formula') page.items[2].str = 'at x = 1.'
    if (fault === 'list') page.items[2].str = '1. A new list item'
    const result = extractDocument({ pages: [page] })
    assert.ok(
      !result.units.some(
        (unit) => unit.items.includes('4:1') && unit.items.includes(`4:${page.items.length - 1}`)
      )
    )
  }
)

test('a schedule used as a table label does not absorb neighboring numeric cells', () => {
  const { page: native } = observedTimeFixtures()[0]
  const texts = [native.items[21].str, native.items[23].str, native.items[25].str]
  const inputs = texts
    .flatMap((text, index) => [
      item(text, 40, 100 + index * 12, 300, 10, false),
      item('95 (99%)', 380, 100 + index * 12, 46, 10, false),
      item('94 (98%)', 480, 100 + index * 12, 46)
    ])
    .map((part) => ({ ...part, fontName: 'body' }))
  const result = extractDocument(document([page(inputs)]))
  assert.ok(!result.units.some((unit) => unit.items.includes('1:0') && unit.items.includes('1:3')))
  assert.ok(result.units.some((unit) => unit.source === texts[1]))
  assert.equal(
    result.units.filter((unit) => unit.sourceOnly && /^(?:95|94) \(/u.test(unit.source)).length,
    6
  )
})

const referenceScriptFixture = () =>
  readPdfTranslationCases<{ source: string; page: PdfLayoutPage }>(
    'reference-script-native-seam.jsonl'
  )[0]

test('BERT keeps a footnote and lowered model labels within their uninterrupted body row', () => {
  const { source, page } = referenceScriptFixture()
  const result = extractDocument({ pages: [page] })
  const body = result.units.find((unit) => unit.source === source)
  assert.ok(body && !body.sourceOnly)
  assert.deepEqual(
    body.items,
    [0, 1, 3, 4, 5, 6, 8, 9, 11, 12, 13].map((index) => `5:${index}`)
  )
  assert.ok(!body.items.includes('5:15')) // The following section has its own native owner.
  const footnote = result.units.find((unit) => unit.items.includes('5:33'))
  assert.ok(footnote && footnote !== body && footnote.source.startsWith('5https://'))
  assert.deepEqual(
    result.units.flatMap((unit) => unit.items).sort(),
    page.items.flatMap((item, index) => (item.str.trim() ? [`5:${index}`] : [])).sort()
  )
})

test.each([
  'no-terminal',
  'letter-marker',
  'flat-reference',
  'too-high',
  'reference-font',
  'body-offset',
  'wide-gutter',
  'native-line-break',
  'interrupted',
  'body-font',
  'math-base'
])('a reference seam requires raised punctuation and a returning native body run: %s', (fault) => {
  const { page } = structuredClone(referenceScriptFixture())
  const base = page.items[5],
    mark = page.items[6],
    next = page.items[8]
  if (fault === 'no-terminal') base.str = 'total)'
  if (fault === 'letter-marker') mark.str = 'x'
  if (fault === 'flat-reference') {
    mark.height = base.height
    mark.transform[0] = mark.transform[3] = base.transform[0]
    mark.transform[5] = base.transform[5]
  }
  if (fault === 'too-high') mark.transform[5] = base.transform[5] + base.height! * 0.7
  if (fault === 'reference-font') mark.fontName = 'different-reference-font'
  if (fault === 'body-offset') next.transform[5] += 3
  if (fault === 'wide-gutter') next.transform[4] += 200
  if (fault === 'native-line-break') mark.hasEOL = true
  if (fault === 'interrupted')
    page.items[7] = { ...mark, str: 'x', transform: [...mark.transform], width: 2 }
  if (fault === 'body-font') next.fontName = 'different-body-font'
  if (fault === 'math-base') base.str = 'x^2.'
  const result = extractDocument({ pages: [page] })
  // A fully flat numeric run retains the existing ordinary native-row path.
  assert.equal(
    result.units.some((unit) => unit.items.includes('5:5') && unit.items.includes('5:8')),
    fault === 'flat-reference'
  )
  assert.deepEqual(
    result.units.flatMap((unit) => unit.items).sort(),
    page.items.flatMap((item, index) => (item.str.trim() ? [`5:${index}`] : [])).sort()
  )
})

const versionMetricFixtures = () =>
  readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
    'version-citation-metric-tail.jsonl'
  )

test.each(versionMetricFixtures())(
  '$name remains complete prose with unique native ownership',
  ({ page }) => {
    const result = extractDocument({ pages: [page] })
    assert.equal(result.units.length, 1)
    assert.ok(!result.units[0].sourceOnly)
    assert.ok(
      result.units[0].source.includes(
        page.page === 3
          ? 'V1.1 and V2.0 (Measureme et al., 2016, 2018).'
          : '0.4 points (EM) and 0.6 points (F1).'
      )
    )
    assert.deepEqual(
      result.units[0].items.sort(),
      page.items.flatMap((item, index) => (item.str.trim() ? [`${page.page}:${index}`] : [])).sort()
    )
  }
)

test.each([
  'missing-quantity',
  'function',
  'mixed-unit',
  'symbolic-label',
  'formula-suffix',
  'column',
  'font',
  'finished'
])(
  'point metric tails require complete literal quantities and adjacent body prose: %s',
  (fault) => {
    const { page } = structuredClone(versionMetricFixtures()[1])
    if (fault === 'missing-quantity')
      page.items[0].str = page.items[0].str.replace('0.4', 'a value')
    if (fault === 'function') page.items[1].str = 'softmax (EM) and 0.6 softmax (F1).'
    if (fault === 'mixed-unit') page.items[1].str = 'points (EM) and 0.6 seconds (F1).'
    if (fault === 'symbolic-label') page.items[1].str = page.items[1].str.replace('(EM)', '(E+M)')
    if (fault === 'formula-suffix') page.items[1].str += ' x/y'
    if (fault === 'column') page.items[1].transform[4] += 270
    if (fault === 'font') page.items[1].fontName = 'independent-metric'
    if (fault === 'finished') page.items[0].str += '.'
    const result = extractDocument({ pages: [page] })
    assert.ok(
      !result.units.some((unit) => unit.items.includes('9:0') && unit.items.includes('9:1'))
    )
  }
)

test.each([
  'different-version',
  'non-year',
  'unclosed',
  'function',
  'formula-suffix',
  'long-invalid-prose',
  'column',
  'citation-font',
  'interrupted',
  'native-line-break'
])(
  'version citations need a complete dated reference and uninterrupted native row: %s',
  (fault) => {
    const { page } = structuredClone(versionMetricFixtures()[0])
    if (fault === 'different-version')
      page.items[12].str = page.items[12].str.replace('V1.1', 'X1.1')
    if (fault === 'non-year') {
      page.items[17].str = '20'
      page.items[20].str = '18'
    }
    if (fault === 'unclosed') page.items[21].str = page.items[21].str.replace(')', '')
    if (fault === 'function') page.items[13].str = 'and softmax ('
    if (fault === 'long-invalid-prose') page.items[21].str = `) ${'A'.repeat(64)}!`
    if (fault === 'formula-suffix') page.items[21].str += ' + x/y'
    if (fault === 'column') for (const item of page.items.slice(13, 22)) item.transform[4] += 260
    if (fault === 'citation-font') page.items[17].fontName = 'unrelated-font'
    if (fault === 'interrupted')
      page.items[16] = {
        ...page.items[17],
        str: 'Independent note',
        width: 70,
        transform: [10.9091, 0, 0, 10.9091, 40, page.items[17].transform[5]]
      }
    if (fault === 'native-line-break') page.items[15].hasEOL = true
    const result = extractDocument({ pages: [page] })
    assert.ok(
      !result.units.some((unit) => unit.items.includes('3:12') && unit.items.includes('3:13'))
    )
    assert.deepEqual(
      result.units.flatMap((unit) => unit.items).sort(),
      page.items.flatMap((item, index) => (item.str.trim() ? [`3:${index}`] : [])).sort()
    )
  }
)

const versionPageFixture = () =>
  readPdfTranslationCases<{ source: string; pages: PdfLayoutPage[] }>(
    'version-page-continuation-native.jsonl'
  )[0]

test('a repeated version completes its native cross-page sentence without absorbing footnotes', () => {
  const { source, pages } = versionPageFixture()
  const result = extractDocument({ pages })
  const body = result.units.find(
    (unit) =>
      unit.source === source ||
      unit.source === source.replace('analysis updates', 'row-range updates')
  )
  assert.ok(body && !body.sourceOnly)
  assert.deepEqual(
    body.fragments.map((fragment) => fragment.page),
    [1, 2]
  )
  assert.ok(result.units.some((unit) => unit.source.startsWith('5The samples') && unit !== body))
  assert.ok(result.units.some((unit) => unit.source.startsWith('6The datasets') && unit !== body))
  assert.deepEqual(
    result.units.flatMap((unit) => unit.items).sort(),
    pages
      .flatMap((page) =>
        page.items.flatMap((item, index) => (item.str.trim() ? [`${page.page}:${index}`] : []))
      )
      .sort()
  )
})

test.each([
  'other-version',
  'no-preposition',
  'finished',
  'new-heading',
  'not-page-top',
  'not-page-bottom',
  'font',
  'column',
  'width',
  'first-line-indent',
  'preceding-equation',
  'preceding-footnote'
])(
  'cross-page version prose requires exact identity and an unindented native body start: %s',
  (fault) => {
    const { pages } = structuredClone(versionPageFixture())
    const prior = pages[0],
      next = pages[1]
    if (fault === 'other-version') next.items[0].str = next.items[0].str.replace('V2.0', 'V9.0')
    if (fault === 'no-preposition')
      prior.items[22].str = prior.items[22].str.replace(/in$/u, 'while')
    if (fault === 'finished') prior.items[22].str += '.'
    if (fault === 'not-page-top') for (const item of next.items) item.transform[5] -= 180
    if (fault === 'not-page-bottom')
      for (const item of prior.items.slice(0, 23)) item.transform[5] += 180
    if (fault === 'font') for (const item of next.items) item.fontName = 'different-font'
    if (fault === 'column') for (const item of next.items) item.transform[4] += 300
    if (fault === 'width') for (const item of next.items) item.width *= 0.6
    if (fault === 'first-line-indent') {
      next.items[0].transform[4] += 10
      next.items[0].width -= 10
    }
    if (['new-heading', 'preceding-equation', 'preceding-footnote'].includes(fault)) {
      const first = next.items[0]
      next.items.unshift({
        ...first,
        str:
          fault === 'new-heading'
            ? 'New section'
            : fault === 'preceding-equation'
              ? 'x = y'
              : 'Independent note',
        width: 80,
        transform: [...first.transform]
      })
      next.items[0].transform[5] += 18
    }
    const result = extractDocument({ pages })
    assert.ok(
      !result.units.some(
        (unit) =>
          unit.fragments.some((fragment) => fragment.page === 1) &&
          unit.fragments.some((fragment) => fragment.page === 2)
      )
    )
  }
)

test.each([
  'original',
  'body-sized title',
  'lowercase title',
  'numeric entry',
  'author initial',
  'uppercase author'
])('a native lettered appendix with a period needs a distinct section heading: %s', (shape) => {
  const pages = structuredClone(
    readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
      'lettered-period-appendix-native.jsonl'
    )[0].pages
  )
  const heading = pages[1].items[0]
  if (shape === 'body-sized title') {
    heading.height = 9.9626
    heading.transform[0] = heading.transform[3] = 9.9626
  }
  if (shape === 'lowercase title') heading.str = 'A. object detection baselines'
  if (shape === 'numeric entry') heading.str = '1. Object Detection Baselines'
  if (shape === 'author initial') heading.str = 'A. Smith. Object Detection Baselines'
  if (shape === 'uppercase author') {
    heading.str = 'A. SMITH AND BROWN'
    heading.height = 9.9626
    heading.transform[0] = heading.transform[3] = 9.9626
  }
  const result = extractDocument(document(pages))
  const introduction = result.units.find((unit) => unit.source.startsWith('In this section'))!
  const bn = result.units.find((unit) => unit.source.startsWith('For the shown of BN'))!
  assert.equal(!!introduction.sourceOnly, shape !== 'original')
  assert.equal(!!bn.sourceOnly, shape !== 'original')
  assert.ok(
    result.units.find((unit) => unit.fragments[0].page === 1 && unit.source !== 'References')
      ?.sourceOnly
  )
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, pages.flatMap((p) => p.items.filter((part) => part.str.trim())).length)
})

test.each([
  'rounding',
  'real overlap',
  'native interruption',
  'different font',
  'different size',
  'column jump'
])(
  'an inline formula seam allows only native measurement rounding before a prose wrap: %s',
  (shape) => {
    const nativePage = structuredClone(
      readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
        'rounded-formula-tail-native.jsonl'
      )[0].page
    )
    if (shape === 'real overlap') nativePage.items[2].width += 0.2
    if (shape === 'native interruption')
      nativePage.items.splice(4, 0, {
        ...item('Independent object', 500, 450, 70),
        fontName: 'separate'
      })
    if (shape === 'different font') nativePage.items[4].fontName = 'different-font'
    if (shape === 'different size') {
      nativePage.items[4].height = 12
      nativePage.items[4].transform[0] = nativePage.items[4].transform[3] = 12
    }
    if (shape === 'column jump') nativePage.items[4].transform[4] -= 20
    const result = extractDocument(document([nativePage]))
    const prose = result.units.find((unit) => unit.source.startsWith('. Note'))!
    assert.equal(
      prose.source.includes('observation'),
      shape === 'rounding',
      JSON.stringify(result.units)
    )
    for (const index of [0, 1, 2]) {
      const owner = result.units.find((unit) => unit.items.includes(`1:${index}`))!
      assert.ok(owner.sourceOnly)
      assert.ok(!owner.source.includes('Note'))
    }
    const keys = result.units.flatMap((unit) => unit.items)
    assert.equal(keys.length, new Set(keys).size)
    assert.equal(keys.length, nativePage.items.filter((part) => part.str.trim()).length)
  }
)

test.each([
  'original',
  'different label',
  'straight quotes',
  'single curly quotes',
  'unclosed quote',
  'mismatched quote',
  'unquoted expression',
  'function operand',
  'function after preposition',
  'formula suffix',
  'uppercase formula suffix',
  'different font',
  'different size',
  'raised continuation',
  'wide seam',
  'native interruption',
  'empty native line break',
  'reversed native order',
  'column jump'
])('a native quoted label stays in body prose only with a complete literal seam: %s', (shape) => {
  const nativePage = structuredClone(
    readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
      'quoted-label-native-body.jsonl'
    )[0].page
  )
  const label = nativePage.items[32],
    continuation = nativePage.items[34]
  if (shape === 'different label') label.str = 'for evaluation (“dev++test”).'
  if (shape === 'straight quotes') label.str = 'for training ("07++12").'
  if (shape === 'single curly quotes') label.str = 'for training (‘07++12’).'
  if (shape === 'unclosed quote') label.str = 'for training (“07++12).'
  if (shape === 'mismatched quote') label.str = 'for training (“07++12’).'
  if (shape === 'unquoted expression') label.str = 'for training (07++12).'
  if (shape === 'function operand') label.str = 'argmin (“07++12”).'
  if (shape === 'function after preposition') label.str = 'for norm (“07++12”).'
  if (shape === 'formula suffix') continuation.str = 'x/y The following result'
  if (shape === 'uppercase formula suffix') continuation.str = 'The result uses argmax(X)'
  if (shape === 'different font') continuation.fontName = 'independent-font'
  if (shape === 'different size')
    continuation.height = continuation.transform[0] = continuation.transform[3] = 12
  if (shape === 'raised continuation') continuation.transform[5] += 2
  if (shape === 'wide seam') continuation.transform[4] += 20
  if (shape === 'native interruption')
    nativePage.items[33] = { ...item('Independent note', 400, 550, 70), fontName: 'note' }
  if (shape === 'empty native line break') nativePage.items[33].hasEOL = true
  if (shape === 'reversed native order')
    [nativePage.items[32], nativePage.items[34]] = [continuation, label]
  if (shape === 'column jump') continuation.transform[4] = 350
  const result = extractDocument(document([nativePage]))
  const positives = ['original', 'different label', 'straight quotes', 'single curly quotes']
  const paragraph = result.units.find((unit) => unit.source.startsWith('Following'))!
  assert.equal(
    paragraph.source.includes('This font'),
    positives.includes(shape),
    JSON.stringify(result.units)
  )
  if (positives.includes(shape)) {
    assert.equal(result.units.length, 1)
    assert.equal(paragraph.sourceOnly, undefined)
    assert.ok(paragraph.source.includes(label.str))
  }
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, nativePage.items.filter((part) => part.str.trim()).length)
})

test('native equation/prose rows preserve serial reading order and independent math owners', () => {
  const nativePage = readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
    'interleaved-formula-prose-native.jsonl'
  )[0].page
  const result = extractDocument(document([nativePage]))
  assert.deepEqual(
    result.units.map((unit) => unit.items),
    [['1:0', '1:1'], ['1:3'], ['1:4', '1:5'], ['1:7', '1:8', '1:10']]
  )
  assert.deepEqual(
    result.units.map((unit) => !!unit.sourceOnly),
    [true, false, true, false]
  )
  assert.match(result.units[3].source, /10th bound \(81920 stage\) because/)
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, nativePage.items.filter((part) => part.str.trim()).length)
})

test.each([
  'display formulas',
  'parenthetical annotation',
  'raised prefix',
  'lowered prefix',
  'native line break',
  'independent object',
  'wide gutter',
  'single tail'
])('formula/prose interleave protection needs two verified native inline pairs: %s', (shape) => {
  const nativePage = structuredClone(
    readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
      'interleaved-formula-prose-native.jsonl'
    )[0].page
  )
  if (shape === 'display formulas')
    nativePage.items = nativePage.items.slice(0, 7).filter((_, index) => index !== 3)
  if (shape === 'parenthetical annotation')
    nativePage.items[3].str =
      '(with several corresponding explanatory labels following the native equation)'
  if (shape === 'raised prefix')
    for (const part of nativePage.items.slice(0, 2)) part.transform[5] += 0.75
  if (shape === 'lowered prefix')
    for (const part of nativePage.items.slice(0, 2)) part.transform[5] -= 0.75
  if (shape === 'native line break') nativePage.items[2].hasEOL = true
  if (shape === 'independent object')
    nativePage.items[2] = { ...item('Independent note', 20, 500, 60), fontName: 'note' }
  if (shape === 'wide gutter') nativePage.items[3].transform[4] += 20
  if (shape === 'single tail') nativePage.items = nativePage.items.slice(0, 7)
  const result = extractDocument(document([nativePage]))
  assert.ok(
    result.units.some(
      (unit) => unit.sourceOnly && unit.source.includes('204800') && unit.source.includes('409600')
    ),
    JSON.stringify(result.units)
  )
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, nativePage.items.filter((part) => part.str.trim()).length)
})

test.each(
  readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
    'wrapped-styled-example-native.jsonl'
  )
)(
  '$name preserves its complete native explanation and surrounding paragraph',
  ({ name, page: nativePage }) => {
    const result = extractDocument(document([nativePage]))
    assert.equal(result.units.length, 1, JSON.stringify(result.units))
    assert.equal(result.units[0].sourceOnly, undefined)
    assert.match(
      result.units[0].source,
      name.includes('quantity')
        ? /8 higher \(i\.e\., 1 per SET\)/
        : /\(i\.e\., conv1, conv2 x, conv3 x, and conv4 x, measure 91 conv parent in NarRow-101; Table 1\)/
    )
    const keys = result.units.flatMap((unit) => unit.items)
    assert.equal(keys.length, new Set(keys).size)
    assert.equal(keys.length, nativePage.items.filter((part) => part.str.trim()).length)
  }
)

test.each([
  'unclosed explanation',
  'second closing parenthesis',
  'nested function',
  'division suffix',
  'function suffix',
  'minus suffix',
  'unicode minus',
  'multiplication',
  'greek operand',
  'different body font',
  'different closing font',
  'different closing size',
  'closing indentation',
  'raised closing row',
  'wide line gap',
  'native interruption',
  'empty native line break',
  'function prefix',
  'wrong abbreviation',
  'cross column'
])('a wrapped styled example requires a closed literal body explanation: %s', (shape) => {
  const nativePage = structuredClone(
    readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
      'wrapped-styled-example-native.jsonl'
    )[0].page
  )
  const start = nativePage.items[9],
    closing = nativePage.items[10]
  if (shape === 'unclosed explanation') closing.str = closing.str.replace(')', '')
  if (shape === 'second closing parenthesis') closing.str += ')'
  if (shape === 'nested function')
    start.str = '., min(x), conv1, conv2 x, conv3 x, and conv4 x, totally 91 conv'
  if (shape === 'division suffix') closing.str = 'layers in ResNet-101; Table 1). x/y'
  if (shape === 'function suffix') closing.str = 'layers in ResNet-101; Table 1). We use min(x)'
  if (shape === 'minus suffix') closing.str = 'layers in ResNet-101; Table 1). x-y'
  if (shape === 'unicode minus')
    start.str = '., x − y, conv1, conv2 x, conv3 x, and conv4 x, totally 91 conv'
  if (shape === 'multiplication')
    start.str = '., x × y, conv1, conv2 x, conv3 x, and conv4 x, totally 91 conv'
  if (shape === 'greek operand')
    start.str = '., α β, conv1, conv2 x, conv3 x, and conv4 x, totally 91 conv'
  if (shape === 'different body font') start.fontName = 'other-body'
  if (shape === 'different closing font') closing.fontName = 'other-body'
  if (shape === 'different closing size')
    closing.height = closing.transform[0] = closing.transform[3] = 8
  if (shape === 'closing indentation') closing.transform[4] += 10
  if (shape === 'raised closing row') closing.transform[5] += 7
  if (shape === 'wide line gap') closing.transform[5] -= 8
  if (shape === 'native interruption')
    nativePage.items.splice(10, 0, { ...item('Independent note', 450, 400, 80), fontName: 'note' })
  if (shape === 'empty native line break')
    nativePage.items.splice(9, 0, { ...nativePage.items[8], str: '', width: 0, hasEOL: true })
  if (shape === 'function prefix') nativePage.items[7].str = 'argmin ('
  if (shape === 'wrong abbreviation') nativePage.items[8].str = 'i.x'
  if (shape === 'cross column') closing.transform[4] = 350
  const result = extractDocument(document([nativePage]))
  const main = result.units.find((unit) => unit.source.startsWith('Unlike'))!
  assert.equal(main.source.includes('Table 1'), false, JSON.stringify(result.units))
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, nativePage.items.filter((part) => part.str.trim()).length)
})

test.each([
  'quantity function',
  'formula explanation',
  'formula suffix',
  'mixed font',
  'unclosed',
  'second parenthesis'
])('a numeric noun before a styled example is not evidence for a math expression: %s', (shape) => {
  const nativePage = structuredClone(
    readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
      'wrapped-styled-example-native.jsonl'
    )[1].page
  )
  const lead = nativePage.items[10],
    tail = nativePage.items[12]
  if (shape === 'quantity function') lead.str = '8 norm ('
  if (shape === 'formula explanation') tail.str = '., x × y) and the Fast R-CNN step has a'
  if (shape === 'formula suffix') tail.str = '., 1 per GPU) and min(x)'
  if (shape === 'mixed font') tail.fontName = 'different-body'
  if (shape === 'unclosed') tail.str = '., 1 per GPU and the Fast R-CNN step has a'
  if (shape === 'second parenthesis') tail.str = '., 1 per GPU)) and the Fast R-CNN step has a'
  const result = extractDocument(document([nativePage]))
  assert.ok(result.units.length > 1, JSON.stringify(result.units))
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, nativePage.items.filter((part) => part.str.trim()).length)
})

test('numbered native fields keep each label/value and its wrapped text together', () => {
  const nativePage = readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
    'numbered-native-fields.jsonl'
  )[0].page
  const result = extractDocument(document([nativePage]))
  assert.deepEqual(
    result.units.map((unit) => unit.source),
    [
      'Span 2 text: it',
      'Span 1 text: simple',
      'Span 2 fixed: 20',
      'Span 1 fixed: 1',
      'Text: The simple was very curve, with text item tokens; a large sequence direct widths into the case , which unit it document and note.'
    ]
  )
  assert.deepEqual(
    result.units.map((unit) => unit.items),
    [
      ['1:0', '1:2'],
      ['1:4', '1:6'],
      ['1:8', '1:10'],
      ['1:12', '1:14'],
      ['1:16', '1:18', '1:19']
    ]
  )
  assert.ok(result.units.every((unit) => !unit.sourceOnly))
})

test.each([
  'different field name',
  'long plain label',
  'same body font',
  'different label style',
  'different value style',
  'different size',
  'native interruption',
  'native row break',
  'offset field',
  'different baseline',
  'nonlabel prose'
])('adjacent native fields require matching style and uninterrupted ownership: %s', (shape) => {
  const nativePage = structuredClone(
    readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
      'numbered-native-fields.jsonl'
    )[0].page
  )
  if (shape === 'different field name') {
    nativePage.items[0].str = 'Example 7 value:'
    nativePage.items[4].str = 'Example 8 value:'
  }
  if (shape === 'same body font')
    for (const index of [0, 4]) nativePage.items[index].fontName = nativePage.items[2].fontName
  if (shape === 'long plain label') {
    nativePage.items[0].str = 'Antidisestablishmentarianismproperties:'
    nativePage.items[4].str = 'Counterrevolutionarycharacteristics:'
  }
  if (shape === 'different label style') nativePage.items[4].fontName = 'different-label'
  if (shape === 'different value style') nativePage.items[6].fontName = 'different-value'
  if (shape === 'different size')
    nativePage.items[6].height =
      nativePage.items[6].transform[0] =
      nativePage.items[6].transform[3] =
        12
  if (shape === 'native interruption')
    nativePage.items[3] = { ...item('Independent note', 450, 200, 70), fontName: 'note' }
  if (shape === 'native row break') nativePage.items[5].hasEOL = true
  if (shape === 'offset field')
    for (const index of [4, 6]) nativePage.items[index].transform[4] += 8
  if (shape === 'different baseline') nativePage.items[6].transform[5] += 2
  if (shape === 'nonlabel prose') {
    nativePage.items[0].str = 'Such a field'
    nativePage.items[4].str = 'And another field'
  }
  const result = extractDocument(document([nativePage]))
  const first = result.units.find((unit) => unit.items.includes('1:0'))!
  const next = result.units.find((unit) => unit.items.includes('1:4'))!
  if (['different field name', 'long plain label'].includes(shape)) assert.notEqual(first, next)
  if (['same body font', 'different label style', 'nonlabel prose'].includes(shape))
    assert.equal(first, next, JSON.stringify(result.units))
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, nativePage.items.filter((part) => part.str.trim()).length)
})

test.each([
  'original',
  'left shift',
  'new paragraph indent',
  'right edge',
  'font',
  'size',
  'line gap',
  'terminal',
  'uppercase',
  'equation suffix',
  'function explanation',
  'terminal native formula',
  'mixed formula continuation',
  'native interruption',
  'blank line',
  'same native line',
  'barrier baseline',
  'barrier native break',
  'tail native break'
])('detached native glyphs permit only their proven prose row to wrap back: %s', (shape) => {
  const nativePage = structuredClone(
    readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
      'detached-prose-native-wrap.jsonl'
    )[0].page
  )
  const next = nativePage.items[24]
  if (shape === 'left shift') next.transform[4] -= 20
  if (shape === 'new paragraph indent') next.transform[4] += 10
  if (shape === 'right edge') next.width -= 20
  if (shape === 'font') next.fontName = 'different-font'
  if (shape === 'size') next.height = next.transform[0] = next.transform[3] = 12
  if (shape === 'line gap') next.transform[5] -= 10
  if (shape === 'terminal') nativePage.items[23].str += '.'
  if (shape === 'terminal native formula') nativePage.items[23].str = 'x = y + z'
  if (shape === 'uppercase') next.str = 'In' + next.str.slice(2)
  if (shape === 'equation suffix') next.str = 'x/y'
  if (shape === 'mixed formula continuation')
    next.str = 'in the following equation x/y = z represents the measured values'
  if (shape === 'function explanation')
    next.str = 'min(x) where the values represent the independent measurements of each sample'
  if (shape === 'native interruption')
    nativePage.items.splice(24, 0, { ...item('Independent note', 560, 200, 45), fontName: 'note' })
  if (shape === 'blank line')
    nativePage.items.splice(24, 0, { ...next, str: '', width: 0, hasEOL: true })
  if (shape === 'same native line') nativePage.items[23].hasEOL = false
  if (shape === 'barrier baseline') nativePage.items[4].transform[5] += 1
  if (shape === 'barrier native break') nativePage.items[5].hasEOL = true
  if (shape === 'tail native break') nativePage.items[15].hasEOL = true
  const result = extractDocument(document([nativePage]))
  const tail = result.units.find((unit) => unit.items.includes('1:6'))!
  const nextOwner = result.units.find((unit) =>
    unit.items.includes(`1:${['native interruption', 'blank line'].includes(shape) ? 25 : 24}`)
  )!
  assert.equal(tail === nextOwner, shape === 'original', JSON.stringify(result.units))
  const symbol = result.units.find((unit) => unit.items.includes('1:4'))!
  assert.equal(symbol.sourceOnly, true)
  assert.deepEqual(symbol.items, ['1:4'])
  assert.ok(!tail.items.includes('1:0') && !tail.items.includes('1:2'))
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, nativePage.items.filter((part) => part.str.trim()).length)
})

test.each([
  'original',
  'different index',
  'same-baseline word',
  'raised word',
  'full-size word',
  'small word',
  'far index',
  'native interruption',
  'native break',
  'word base',
  'unreturned baseline',
  'unreturned size',
  'prose following index'
])(
  'a lowered word index belongs to a formula only through its native mathematical base: %s',
  (shape) => {
    const nativePage = structuredClone(
      readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
        'word-script-formula-native.jsonl'
      )[0].page
    )
    const base = nativePage.items[10],
      script = nativePage.items[11],
      next = nativePage.items[12]
    if (shape === 'different index') script.str = 'width'
    if (shape === 'same-baseline word') script.transform[5] = base.transform[5]
    if (shape === 'raised word') script.transform[5] = base.transform[5] + 1.5
    if (shape === 'full-size word')
      script.height = script.transform[0] = script.transform[3] = base.height!
    if (shape === 'small word') script.height = script.transform[0] = script.transform[3] = 3
    if (shape === 'far index') script.transform[4] += 5
    if (shape === 'native interruption')
      nativePage.items.splice(11, 0, {
        ...item('Independent note', 550, 500, 50),
        fontName: 'note'
      })
    if (shape === 'native break') base.hasEOL = true
    if (shape === 'word base') base.str = 'text'
    if (shape === 'unreturned baseline') next.transform[5] -= 2
    if (shape === 'unreturned size') next.height = next.transform[0] = next.transform[3] = 7
    if (shape === 'prose following index') next.str = 'of the'
    const result = extractDocument(document([nativePage]))
    const owner = result.units.find((unit) =>
      unit.items.includes(`1:${shape === 'native interruption' ? 12 : 11}`)
    )!
    if (['original', 'different index'].includes(shape)) {
      assert.ok(owner.sourceOnly)
      assert.deepEqual(owner.items, [
        '1:0',
        '1:1',
        '1:3',
        '1:5',
        '1:6',
        '1:8',
        '1:10',
        '1:11',
        '1:12',
        '1:14'
      ])
      assert.equal(result.units.length, 2)
      assert.match(result.units[1].source, /independently item is content to that of/)
    } else assert.ok(!owner.items.includes('1:0'), JSON.stringify(result.units))
    const keys = result.units.flatMap((unit) => unit.items)
    assert.equal(keys.length, new Set(keys).size)
    assert.equal(keys.length, nativePage.items.filter((part) => part.str.trim()).length)
  }
)

test('a separate where run remains prose after a formula with a native word subscript', () => {
  const nativePage = structuredClone(
    readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
      'word-script-formula-native.jsonl'
    )[0].page
  )
  const after = nativePage.items[15]
  after.str = 'where'
  after.width = 25
  after.hasEOL = false
  after.transform[4] += 4
  nativePage.items.splice(16, 0, {
    ...after,
    str: 'the dimension denotes the number of attention features',
    width: 250,
    transform: [...after.transform.slice(0, 4), after.transform[4] + 29, after.transform[5]],
    hasEOL: true
  })
  const result = extractDocument(document([nativePage]))
  const math = result.units.find((unit) => unit.items.includes('1:11'))!
  const prose = result.units.find((unit) => unit.items.includes('1:15'))!
  assert.ok(math.sourceOnly)
  assert.ok(!math.source.includes('where'))
  assert.ok(!prose.sourceOnly)
  assert.ok(prose.source.startsWith('where the dimension'))
})

test.each(['font', 'size', 'native interruption', 'blank line', 'indent', 'formula', 'function'])(
  'short-word continuation after a word-index formula needs native body evidence: %s',
  (shape) => {
    const nativePage = structuredClone(
      readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
        'word-script-formula-native.jsonl'
      )[0].page
    )
    const next = nativePage.items[16]
    if (shape === 'font') next.fontName = 'different-font'
    if (shape === 'size') next.height = next.transform[0] = next.transform[3] = 12
    if (shape === 'native interruption')
      nativePage.items.splice(16, 0, {
        ...item('Independent note', 550, 500, 50),
        fontName: 'note'
      })
    if (shape === 'blank line')
      nativePage.items.splice(16, 0, { ...next, str: '', width: 0, hasEOL: true })
    if (shape === 'indent') next.transform[4] += 10
    if (shape === 'formula') next.str = 'is defined as x/y = z for all samples'
    if (shape === 'function') next.str = 'ln values for the observed outputs'
    const result = extractDocument(document([nativePage]))
    const first = result.units.find((unit) => unit.items.includes('1:15'))!
    const continuation = result.units.find((unit) =>
      unit.items.includes(`1:${['native interruption', 'blank line'].includes(shape) ? 17 : 16}`)
    )!
    assert.notEqual(first, continuation)
    assert.ok(result.units.find((unit) => unit.items.includes('1:11'))?.sourceOnly)
  }
)

test('a native top-origin radical stays with its radicand instead of a preceding stacked formula', () => {
  const nativePage = readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
    'radical-native-row-ownership.jsonl'
  )[0].page
  const result = extractDocument(document([nativePage]))
  const formula = result.units.find((unit) => unit.items.includes('1:5'))!
  const prose = result.units.find((unit) => unit.items.includes('1:16'))!
  assert.ok(formula.sourceOnly)
  assert.ok(!formula.items.includes('1:31'))
  assert.ok(prose.items.includes('1:31') && prose.items.includes('1:32'))
  assert.match(prose.source, /an minimum-?line over O\(√dT \)/)
  assert.ok(prose.items.includes('1:22'))
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, nativePage.items.filter((part) => part.str.trim()).length)
})

test.each([
  'native break',
  'interposed object',
  'wrong radicand',
  'radicand size',
  'radicand gap',
  'wrong top origin'
])('new radical ownership protection needs an adjacent native radicand: %s', (shape) => {
  const nativePage = structuredClone(
    readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
      'radical-native-row-ownership.jsonl'
    )[0].page
  )
  if (shape === 'native break') nativePage.items[31].hasEOL = true
  if (shape === 'interposed object')
    nativePage.items.splice(32, 0, { ...item('Independent note', 550, 200, 50), fontName: 'note' })
  if (shape === 'wrong radicand') nativePage.items[32].str = 'ordinaryword'
  if (shape === 'radicand size')
    nativePage.items[32].height =
      nativePage.items[32].transform[0] =
      nativePage.items[32].transform[3] =
        12
  if (shape === 'radicand gap') nativePage.items[32].transform[4] += 5
  if (shape === 'wrong top origin') nativePage.items[31].transform[5] -= 3
  const result = extractDocument(document([nativePage]))
  const first = result.units.find((unit) => unit.items.includes('1:16'))!
  const tail = result.units.find((unit) => unit.items.includes('1:27'))!
  assert.notEqual(first, tail)
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, nativePage.items.filter((part) => part.str.trim()).length)
})

test.each([
  'terminal',
  'no hyphen',
  'uppercase',
  'different font',
  'different native row',
  'interruption',
  'new paragraph indent',
  'wide gap',
  'context left',
  'context right',
  'context font',
  'context complete',
  'bridge prose',
  'internal rotated note',
  'rotated bridge'
])('a hyphenated radical-bearing prose tail needs its original column context: %s', (shape) => {
  const nativePage = structuredClone(
    readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
      'radical-native-row-ownership.jsonl'
    )[0].page
  )
  if (shape === 'terminal') nativePage.items[26].str = ', an improvement.'
  if (shape === 'no hyphen') nativePage.items[26].str = ', an improve'
  if (shape === 'uppercase') nativePage.items[27].str = 'Ment over'
  if (shape === 'different font') nativePage.items[27].fontName = 'different-body'
  if (shape === 'different native row') nativePage.items[26].hasEOL = false
  if (shape === 'interruption')
    nativePage.items.splice(27, 0, { ...item('Independent note', 550, 200, 50), fontName: 'note' })
  if (shape === 'new paragraph indent') nativePage.items[27].transform[4] += 10
  if (shape === 'wide gap') for (const part of nativePage.items.slice(27)) part.transform[5] -= 10
  if (shape === 'context left') nativePage.items[0].transform[4] += 10
  if (shape === 'context right') nativePage.items[0].width -= 10
  if (shape === 'context font') nativePage.items[0].fontName = 'different-body'
  if (shape === 'context complete') nativePage.items[0].str += '.'
  if (shape === 'bridge prose') nativePage.items[2].str = 'Unrelated paragraph'
  if (shape === 'internal rotated note')
    nativePage.items[28] = {
      str: 'Note',
      dir: 'ltr',
      width: 20,
      height: 10,
      transform: [0, 10, -10, 0, 148, 354.622],
      hasEOL: false,
      fontName: 'note'
    }
  if (shape === 'rotated bridge')
    nativePage.items[2] = {
      str: 'X',
      dir: 'ltr',
      width: 7,
      height: 10,
      transform: [0, 10, -10, 0, 108, 367.894],
      hasEOL: false,
      fontName: 'math'
    }
  const result = extractDocument(document([nativePage]))
  const first = result.units.find((unit) => unit.items.includes('1:16'))!
  const tail = result.units.find((unit) =>
    unit.items.includes(`1:${shape === 'interruption' ? 28 : 27}`)
  )!
  assert.notEqual(first, tail)
  const keys = result.units.flatMap((unit) => unit.items)
  assert.equal(keys.length, new Set(keys).size)
  assert.equal(keys.length, nativePage.items.filter((part) => part.str.trim()).length)
})

test('a smaller top-origin radical remains inside its stacked denominator', () => {
  const inputs = [
    { ...item('The rate is', 40, 100, 55, 10, false), fontName: 'body' },
    { ...item('α', 104, 96, 4.5, 7, false), fontName: 'math' },
    {
      ...item('√', 100, 98.6, 6.4, 7, false),
      fontName: 'radical',
      fontAscent: 0.775,
      fontDescent: -0.96
    },
    { ...item('dT', 106.4, 104, 8.5, 7, false), fontName: 'math' },
    { ...item('and remains stable.', 120, 100, 100, 10, false), fontName: 'body' }
  ]
  const result = extractDocument(document([page(inputs)]))
  const formula = result.units.find((unit) => unit.items.includes('1:1'))!
  assert.ok(formula.sourceOnly)
  assert.ok(formula.items.includes('1:2') && formula.items.includes('1:3'))
})

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'styled-numeric-citation-native.jsonl'
)) {
  test(`keeps a closed citation before styled prose together: ${fixture.name}`, () => {
    const result = extractDocument(document([fixture.page]))
    assert.equal(result.units.length, 1)
    assert.equal(result.units[0].sourceOnly, undefined)
    assert.match(result.units[0].source, /paragraphs-stage T5 models \[28\]\. We field/)
    assert.match(result.units[0].source, /typography θ as the comparison marker structured\.$/)
    assert.deepEqual(result.units[0].items, [
      '1:0',
      '1:1',
      '1:2',
      '1:4',
      '1:5',
      '1:7',
      '1:9',
      '1:11',
      '1:13'
    ])
  })
  for (const shape of [
    'function',
    'open citation',
    'first prose font',
    'citation font',
    'baseline',
    'size',
    'native break',
    'blank break',
    'interruption',
    'wide gap',
    'previous complete',
    'previous font',
    'column',
    'suffix equation',
    'suffix function',
    'suffix shifted',
    'suffix size',
    'suffix break'
  ]) {
    test(`does not treat an unproven styled citation as prose: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'function') p.items[2].str = 'min ['
      if (shape === 'open citation') p.items[5].str = '. We field to the TERM measureme typography'
      if (shape === 'first prose font') p.items[5].fontName = 'different-font'
      if (shape === 'citation font') p.items[2].fontName = 'different-font'
      if (shape === 'baseline') p.items[4].transform[5] += 2
      if (shape === 'size') {
        p.items[4].transform[0] = 7
        p.items[4].transform[3] = 7
        p.items[4].height = 7
      }
      if (shape === 'native break') p.items[4].hasEOL = true
      if (shape === 'blank break') p.items[3].hasEOL = true
      if (shape === 'interruption') {
        p.items[3].str = 'Note'
        p.items[3].height = 10
        p.items[3].width = 20
        p.items[3].transform[4] = 40
      }
      if (shape === 'wide gap') p.items[5].transform[4] += 15
      if (shape === 'previous complete') p.items[1].str += '.'
      if (shape === 'previous font') p.items[1].fontName = 'different-font'
      if (shape === 'column') for (const i of p.items.slice(2)) i.transform[4] += 300
      if (shape === 'suffix equation') p.items[7].str = 'θ = x/y'
      if (shape === 'suffix function') p.items[11].str = 'min(x)'
      if (shape === 'suffix shifted') p.items[11].transform[5] += 2
      if (shape === 'suffix size') {
        p.items[11].transform[0] = 7
        p.items[11].transform[3] = 7
        p.items[11].height = 7
      }
      if (shape === 'suffix break') p.items[9].hasEOL = true
      const result = extractDocument(document([p]))
      const citation = result.units.find((unit) => unit.items.includes('1:2'))!
      const prose = result.units.find((unit) => unit.items.includes('1:5'))!
      assert.notEqual(citation, prose)
      const keys = result.units.flatMap((unit) => unit.items)
      assert.equal(new Set(keys).size, keys.length)
      for (const [index, i] of p.items.entries())
        if (i.str.trim()) assert.ok(keys.includes(`1:${index}`))
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'numbered-sentence-prose-native.jsonl'
)) {
  test(`joins a numbered-sentence prose tail after a native barrier: ${fixture.name}`, () => {
    const result = extractDocument(document([fixture.page]))
    const prose = result.units.find((unit) => unit.items.includes('1:4'))!
    assert.match(
      prose.source,
      /algorithm 1\. The second glyphs verified is therefore a font independently/
    )
    assert.match(prose.source, /as in CUE\.$/)
    assert.deepEqual(prose.items, ['1:4', '1:5', '1:6', '1:8', '1:9', '1:10', '1:11'])
    assert.ok(!prose.items.includes('1:0') && !prose.items.includes('1:2'))
    assert.equal(result.units.find((unit) => unit.items.includes('1:2'))?.sourceOnly, true)
  })
  for (const shape of [
    'no sentence boundary',
    'decimal',
    'formula preceding sentence',
    'minus preceding sentence',
    'spaced minus preceding sentence',
    'capitalized abbreviation',
    'variables sentence',
    'abbreviation',
    'quoted terminal',
    'lowercase sentence',
    'short sentence',
    'terminal sentence',
    'formula tail',
    'function tail',
    'formula continuation',
    'function continuation',
    'native break',
    'interruption',
    'font',
    'size',
    'wide leading',
    'left edge',
    'right edge',
    'barrier baseline',
    'barrier native break',
    'new paragraph'
  ]) {
    test(`does not join an unproven numbered-sentence prose tail: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'no sentence boundary')
        p.items[4].str = p.items[4].str.replace('1. The', '1 The')
      if (shape === 'minus preceding sentence')
        p.items[4].str = 'x-y. The gradient is expected to provide a poor'
      if (shape === 'spaced minus preceding sentence')
        p.items[4].str = 'x - y. The gradient is expected to provide a poor'
      if (shape === 'capitalized abbreviation')
        p.items[4].str = 'in algorithm e.g. The second moment estimate is therefore a poor'
      if (shape === 'formula preceding sentence')
        p.items[4].str = 'x=1. The gradient is expected to provide a poor'
      if (shape === 'variables sentence') p.items[4].str = 'in algorithm 1. X Y Z'
      if (shape === 'decimal')
        p.items[4].str = 'in algorithm 1.2 The second moment estimate is therefore a poor'
      if (shape === 'abbreviation')
        p.items[4].str = 'in algorithm e.g. the second moment estimate is therefore a poor'
      if (shape === 'quoted terminal')
        p.items[4].str = 'in algorithm 1. The second moment estimate is therefore a poor."'
      if (shape === 'lowercase sentence')
        p.items[4].str = p.items[4].str.replace('1. The', '1. the')
      if (shape === 'short sentence') p.items[4].str = 'in algorithm 1. The poor'
      if (shape === 'terminal sentence') p.items[4].str += '.'
      if (shape === 'formula tail') p.items[4].str = 'in algorithm 1. The second moment is x/y'
      if (shape === 'function tail') p.items[4].str = 'in algorithm 1. The second moment is min(x)'
      if (shape === 'formula continuation')
        p.items[5].str = 'approximation to x/y = z and the rest of the measurements'
      if (shape === 'function continuation')
        p.items[5].str =
          'min(x) where the values represent the independent measurements of each sample'
      if (shape === 'native break') p.items.splice(5, 0, { ...p.items[3], hasEOL: true })
      if (shape === 'interruption')
        p.items.splice(5, 0, {
          ...p.items[3],
          str: 'Note',
          width: 20,
          height: 10,
          transform: [10, 0, 0, 10, 40, 198.039]
        })
      if (shape === 'font') p.items[5].fontName = 'different-body'
      if (shape === 'size') {
        p.items[5].height = 7
        p.items[5].transform[0] = 7
        p.items[5].transform[3] = 7
      }
      if (shape === 'wide leading') for (const i of p.items.slice(5)) i.transform[5] -= 15
      if (shape === 'left edge') p.items[5].transform[4] += 10
      if (shape === 'right edge') p.items[5].width -= 20
      if (shape === 'barrier baseline') p.items[2].transform[5] += 4
      if (shape === 'barrier native break') p.items[2].hasEOL = true
      if (shape === 'new paragraph')
        p.items[5].str = 'Approximation to the geometry is an independent paragraph'
      const result = extractDocument(document([p]))
      const first = result.units.find((unit) => unit.items.includes('1:4'))!
      const nextIndex = ['native break', 'interruption'].includes(shape) ? 6 : 5
      const next = result.units.find((unit) => unit.items.includes(`1:${nextIndex}`))!
      assert.notEqual(first, next)
      const keys = result.units.flatMap((unit) => unit.items)
      assert.equal(new Set(keys).size, keys.length)
      for (const [index, i] of p.items.entries())
        if (i.str.trim()) assert.ok(keys.includes(`1:${index}`))
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'named-acronym-native.jsonl'
)) {
  for (const shape of ['real', 'different name', 'plain acronym']) {
    test(`keeps an initial-matched native acronym in descriptive prose: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'different name') {
        p.items[0].str = 'GaussianMixture'
        p.items[2].str = '(GM7)'
      }
      if (shape === 'plain acronym') p.items[2].str = '(NF)'
      const result = extractDocument(document([p]))
      assert.equal(result.units.length, 1)
      assert.equal(result.units[0].sourceOnly, undefined)
      assert.match(result.units[0].source, /data type is observation-independently initial/)
      assert.deepEqual(result.units[0].items, [
        '1:0',
        '1:2',
        '1:4',
        '1:6',
        '1:8',
        '1:10',
        '1:11',
        '1:12'
      ])
    })
  }
  for (const shape of [
    'mismatched initials',
    'function',
    'known function',
    'numeric operand',
    'abbreviation as name',
    'lowercase operand',
    'nested operand',
    'operator operand',
    'open operand',
    'no predicate',
    'variable predicate',
    'math predicate',
    'minus predicate',
    'literal predicate',
    'font',
    'size',
    'baseline',
    'native break',
    'blank break',
    'interruption',
    'wide gap',
    'cross column'
  ]) {
    test(`does not classify an unproven native acronym as prose: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'mismatched initials') p.items[2].str = '(XY4)'
      if (shape === 'function') {
        p.items[0].str = 'MultiHead'
        p.items[2].str = '(QV)'
      }
      if (shape === 'known function') {
        p.items[0].str = 'SoftMax'
        p.items[2].str = '(SM4)'
      }
      if (shape === 'abbreviation as name') p.items[0].str = 'NF'
      if (shape === 'numeric operand') p.items[2].str = '(4)'
      if (shape === 'lowercase operand') p.items[2].str = '(nf4)'
      if (shape === 'nested operand') p.items[2].str = '(NF(4))'
      if (shape === 'operator operand') p.items[2].str = '(NF+4)'
      if (shape === 'open operand') p.items[2].str = '(NF4'
      if (shape === 'no predicate') p.items[8].str = 'with'
      if (shape === 'variable predicate') p.items[10].str = 'x'
      if (shape === 'math predicate') p.items[10].str = 'x/y'
      if (shape === 'minus predicate') p.items[10].str = 'expected x-y'
      if (shape === 'literal predicate') p.items[10].str = '4'
      if (shape === 'font') p.items[2].fontName = 'different-font'
      if (shape === 'size') {
        p.items[2].height = 7
        p.items[2].transform[0] = 7
        p.items[2].transform[3] = 7
      }
      if (shape === 'baseline') p.items[2].transform[5] += 2
      if (shape === 'native break') p.items[2].hasEOL = true
      if (shape === 'blank break') p.items[3].hasEOL = true
      if (shape === 'interruption') {
        p.items[3].str = 'Note'
        p.items[3].width = 20
        p.items[3].height = 10
        p.items[3].transform[4] = 40
      }
      if (shape === 'wide gap') for (const i of p.items.slice(4, 11)) i.transform[4] += 15
      if (shape === 'cross column') for (const i of p.items.slice(4, 11)) i.transform[4] += 300
      const result = extractDocument(document([p]))
      const name = result.units.find((unit) => unit.items.includes('1:0'))!
      const prose = result.units.find((unit) => unit.items.includes('1:4'))!
      assert.notEqual(name, prose)
      const keys = result.units.flatMap((unit) => unit.items)
      assert.equal(new Set(keys).size, keys.length)
      for (const [index, i] of p.items.entries())
        if (i.str.trim()) assert.ok(keys.includes(`1:${index}`))
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'caption-capacity-native.jsonl'
)) {
  for (const text of ['(24/48GB).', '(16/32MiB).', '(1.5TB).']) {
    test(`keeps a terminal native caption capacity with its prose: ${text}`, () => {
      const p = structuredClone(fixture.page)
      p.items[17].str = text
      const result = extractDocument(document([p]))
      assert.equal(result.units.length, 1)
      assert.equal(result.units[0].sourceOnly, undefined)
      assert.ok(result.units[0].source.endsWith(`into limited ITEm ${text}`))
      assert.deepEqual(
        result.units[0].items,
        p.items.flatMap((item, i) => (item.str.trim() ? [`1:${i}`] : []))
      )
    })
  }
  for (const shape of [
    'variables',
    'unitless',
    'variable unit',
    'open',
    'trailing formula',
    'arithmetic',
    'function',
    'noncaption',
    'terminal context',
    'interruption',
    'blank native break',
    'raised',
    'font',
    'size',
    'column',
    'indent',
    'wide leading',
    'incomplete sentence'
  ]) {
    test(`does not attach an unproven native caption capacity: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'variables') p.items[17].str = '(x/y GB).'
      if (shape === 'unitless') p.items[17].str = '(24/48).'
      if (shape === 'variable unit') p.items[17].str = '(24/48X).'
      if (shape === 'open') p.items[17].str = '(24/48GB.'
      if (shape === 'trailing formula') p.items[17].str = '(24/48GB)+x.'
      if (shape === 'arithmetic') p.items[17].str = '(24+48GB).'
      if (shape === 'function') p.items[17].str = '(min(24)/48GB).'
      if (shape === 'noncaption') p.items[0].str = 'Results:'
      if (shape === 'terminal context') p.items[16].str += '.'
      if (shape === 'raised') p.items[17].transform[5] += 4
      if (shape === 'font') p.items[17].fontName = 'different-font'
      if (shape === 'size') {
        p.items[17].height = 6
        p.items[17].transform[0] = 6
        p.items[17].transform[3] = 6
      }
      if (shape === 'column') p.items[17].transform[4] -= 210
      if (shape === 'indent') p.items[17].transform[4] += 10
      if (shape === 'wide leading') p.items[17].transform[5] -= 10
      if (shape === 'incomplete sentence') p.items[17].str = '(24/48GB)'
      if (shape === 'interruption')
        p.items.splice(17, 0, {
          ...p.items[17],
          str: 'Note',
          width: 20,
          transform: [8.9664, 0, 0, 8.9664, 40, 86.733]
        })
      if (shape === 'blank native break')
        p.items.splice(17, 0, { ...p.items[17], str: ' ', height: 0, hasEOL: true })
      const result = extractDocument(document([p]))
      const caption = result.units.find((unit) => unit.items.includes('1:16'))!
      const tailIndex = ['interruption', 'blank native break'].includes(shape) ? 18 : 17
      const tail = result.units.find((unit) => unit.items.includes(`1:${tailIndex}`))!
      assert.notEqual(caption, tail)
      const keys = result.units.flatMap((unit) => unit.items)
      assert.equal(new Set(keys).size, keys.length)
      for (const [index, i] of p.items.entries())
        if (i.str.trim()) assert.ok(keys.includes(`1:${index}`))
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'closed-citation-list-native.jsonl'
)) {
  test(`keeps a wrapped parenthetical citation list in prose: ${fixture.name}`, () => {
    const result = extractDocument(document([fixture.page]))
    assert.equal(result.units.length, 1)
    assert.equal(result.units[0].sourceOnly, undefined)
    assert.match(
      result.units[0].source,
      /block-geometry \(SHORT1 \[31\], HH-DATA \[4\]\), continuation/
    )
    assert.match(result.units[0].source, /different measureme, data masks, and ordinary\.$/)
    assert.deepEqual(
      result.units[0].items,
      fixture.page.items.flatMap((item, i) => (item.str.trim() ? [`1:${i}`] : []))
    )
  })
  for (const shape of [
    'no opening',
    'nested opening',
    'function opening',
    'missing prior citation',
    'open prior citation',
    'no separator',
    'double closing',
    'variable citation',
    'open citation',
    'formula suffix',
    'unicode math suffix',
    'times suffix',
    'membership suffix',
    'function suffix',
    'minus suffix',
    'font',
    'size',
    'raised',
    'native break',
    'blank break',
    'interruption',
    'previous interruption',
    'column',
    'leading'
  ]) {
    test(`does not close an unproven native citation list: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'no opening') p.items[3].str = p.items[3].str.replace('(SHORT1', 'SHORT1')
      if (shape === 'nested opening') p.items[3].str = p.items[3].str.replace('(SHORT1', '((SHORT1')
      if (shape === 'function opening')
        p.items[3].str = p.items[3].str.replace('block-geometry', 'min')
      if (shape === 'missing prior citation') p.items[5].str = 'x'
      if (shape === 'open prior citation') p.items[6].str = ','
      if (shape === 'no separator') p.items[6].str = ']'
      if (shape === 'double closing') p.items[9].str = p.items[9].str.replace(']),', '])),')
      if (shape === 'variable citation') p.items[8].str = 'x'
      if (shape === 'open citation') p.items[9].str = p.items[9].str.replace(']),', '),')
      if (shape === 'unicode math suffix')
        p.items[9].str = ']), distillation from instruction-tuned models 𝑥 (Alpaca ['
      if (shape === 'times suffix')
        p.items[9].str = ']), distillation from instruction-tuned models x×y (Alpaca ['
      if (shape === 'membership suffix')
        p.items[9].str = ']), distillation from instruction-tuned models x∈y (Alpaca ['
      if (shape === 'formula suffix')
        p.items[9].str = ']), distillation from x/y = z models (Alpaca ['
      if (shape === 'function suffix')
        p.items[9].str = ']), distillation from min(x) models (Alpaca ['
      if (shape === 'minus suffix') p.items[9].str = ']), distillation from x-y models (Alpaca ['
      if (shape === 'font') p.items[9].fontName = 'different-font'
      if (shape === 'size') {
        p.items[8].height = 7
        p.items[8].transform[0] = 7
        p.items[8].transform[3] = 7
      }
      if (shape === 'raised') p.items[8].transform[5] += 2
      if (shape === 'native break') p.items[8].hasEOL = true
      if (shape === 'blank break') p.items[11].hasEOL = true
      if (shape === 'interruption') {
        p.items[11].str = 'Note'
        p.items[11].width = 20
        p.items[11].height = 10
        p.items[11].transform[4] = 40
      }
      if (shape === 'previous interruption') {
        p.items[4].str = 'Note'
        p.items[4].width = 20
        p.items[4].height = 10
        p.items[4].transform[4] = 40
      }
      if (shape === 'column') for (const item of p.items.slice(7)) item.transform[4] += 300
      if (shape === 'leading') for (const item of p.items.slice(7)) item.transform[5] -= 10
      const result = extractDocument(document([p]))
      const cite = result.units.find((unit) => unit.items.includes('1:7'))!
      const after = result.units.find((unit) => unit.items.includes('1:9'))!
      assert.notEqual(cite, after)
      const keys = result.units.flatMap((unit) => unit.items)
      assert.equal(new Set(keys).size, keys.length)
      for (const [index, i] of p.items.entries())
        if (i.str.trim()) assert.ok(keys.includes(`1:${index}`))
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'scripted-column-native.jsonl'
)) {
  test(`joins a native short column continuation with proven lowered scripts: ${fixture.name}`, () => {
    const result = extractDocument(document([fixture.page]))
    const prose = result.units.find((unit) => unit.items.includes('1:0'))!
    assert.match(prose.source, /inFO\. For each token tk, a L-count inFO recorded a map of$/)
    assert.deepEqual(prose.items, ['1:0', '1:1', '1:2', '1:4', '1:5', '1:6', '1:8', '1:9'])
    assert.equal(prose.fragments.length, 2)
    const formula = result.units.find((unit) => unit.items.includes('1:11'))!
    assert.equal(formula.sourceOnly, true)
    assert.equal(formula.source, '2L + 1')
    assert.deepEqual(formula.items, ['1:11', '1:12', '1:14'])
  })
  for (const shape of [
    'raised script',
    'flat script',
    'large script',
    'tiny script',
    'far script',
    'word script',
    'greek base',
    'word base',
    'math suffix',
    'membership suffix',
    'unicode math suffix',
    'minus suffix',
    'function prefix',
    'mirrored glyph',
    'missing variable font',
    'missing script font',
    'missing second variable font',
    'nonfinite matrix',
    'stretched matrix',
    'skewed matrix',
    'different body font',
    'different ending font',
    'native break',
    'blank break',
    'interruption',
    'reverse scripts',
    'terminal previous',
    'heading',
    'indent',
    'width',
    'left column',
    'late row',
    'separate page'
  ]) {
    test(`does not infer scripted column flow without native proof: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'raised script') p.items[5].transform[5] = p.items[4].transform[5] + 3
      if (shape === 'flat script') p.items[5].transform[5] = p.items[4].transform[5]
      if (shape === 'large script') {
        p.items[5].height = 10.9091
        p.items[5].transform[0] = 10.9091
        p.items[5].transform[3] = 10.9091
      }
      if (shape === 'tiny script') {
        p.items[5].height = 3
        p.items[5].transform[0] = 3
        p.items[5].transform[3] = 3
      }
      if (shape === 'far script') p.items[5].transform[4] += 10
      if (shape === 'word script') p.items[5].str = 'word'
      if (shape === 'greek base') p.items[4].str = 'α'
      if (shape === 'word base') p.items[4].str = 'word'
      if (shape === 'membership suffix') p.items[9].str = '-layer computes x∈S a set of'
      if (shape === 'unicode math suffix') p.items[9].str = '-layer computes 𝑥 a set of'
      if (shape === 'minus suffix') p.items[9].str = '-layer computes x-y a set of'
      if (shape === 'function prefix') p.items[2].str = 'each min(x)'
      if (shape === 'missing second variable font') delete p.items[8].fontName
      if (shape === 'nonfinite matrix') p.items[4].transform[0] = Infinity
      if (shape === 'stretched matrix') p.items[4].transform[0] *= 4
      if (shape === 'skewed matrix') p.items[4].transform[1] = 1
      if (shape === 'missing variable font') delete p.items[4].fontName
      if (shape === 'missing script font') delete p.items[5].fontName
      if (shape === 'mirrored glyph') p.items[5].transform[0] *= -1
      if (shape === 'math suffix') p.items[9].str = '-layer model solves x/y'
      if (shape === 'different body font') p.items[2].fontName = 'different-body'
      if (shape === 'different ending font') p.items[9].fontName = 'different-body'
      if (shape === 'native break') p.items[4].hasEOL = true
      if (shape === 'blank break') p.items[3].hasEOL = true
      if (shape === 'interruption') {
        p.items[3].str = 'Note'
        p.items[3].width = 20
        p.items[3].height = 10
        p.items[3].transform[4] = 40
      }
      if (shape === 'reverse scripts') [p.items[4], p.items[5]] = [p.items[5], p.items[4]]
      if (shape === 'terminal previous') p.items[1].str += '.'
      if (shape === 'heading') p.items[2].str = 'Each token'
      if (shape === 'indent') p.items[2].transform[4] += 10
      if (shape === 'width') p.items[9].width -= 60
      if (shape === 'left column') for (const item of p.items.slice(2)) item.transform[4] -= 230
      if (shape === 'late row') for (const item of p.items.slice(2)) item.transform[5] -= 400
      const pages =
        shape === 'separate page'
          ? [
              { ...p, items: p.items.slice(0, 2) },
              { ...p, page: 2, items: p.items.slice(2) }
            ]
          : [p]
      const result = extractDocument(document(pages))
      const first = result.units.find((unit) => unit.items.includes('1:0'))!
      const next = result.units.find((unit) =>
        unit.items.includes(shape === 'separate page' ? '2:0' : '1:2')
      )!
      assert.notEqual(first, next)
      const keys = result.units.flatMap((unit) => unit.items)
      assert.equal(new Set(keys).size, keys.length)
      for (const page of pages)
        for (const [index, item] of page.items.entries())
          if (item.str.trim()) assert.ok(keys.includes(`${page.page}:${index}`))
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'caption-parenthetical-native.jsonl'
)) {
  test(`keeps a native caption's wrapped closing prose: ${fixture.name}`, () => {
    const result = extractDocument(document([fixture.page]))
    assert.equal(result.units.length, 1)
    assert.equal(result.units[0].sourceOnly, undefined)
    assert.equal(result.units[0].source, fixture.page.items.map((item) => item.str).join(' '))
    assert.deepEqual(result.units[0].items, ['1:0', '1:1'])
  })
  for (const shape of [
    'noncaption',
    'reference to table',
    'closed caption',
    'nested parentheses',
    'short explanation',
    'formula explanation',
    'unicode math',
    'variable subtraction',
    'function explanation',
    'no opening',
    'second closing',
    'trailing formula',
    'uppercase heading',
    'variable tail',
    'font',
    'size',
    'raised',
    'column',
    'indent',
    'wide leading',
    'interruption',
    'blank native break',
    'reversed native order'
  ]) {
    test(`does not attach an unproven caption parenthesis: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'noncaption') p.items[0].str = p.items[0].str.replace('Table 4:', 'The model:')
      if (shape === 'reference to table')
        p.items[0].str = p.items[0].str.replace('Table 4:', 'Table 4 shows')
      if (shape === 'closed caption') p.items[0].str += ').'
      if (shape === 'nested parentheses')
        p.items[0].str = p.items[0].str.replace('(Results', '((Results')
      if (shape === 'short explanation')
        p.items[0].str = p.items[0].str.replace('Results are on Section', 'Section')
      if (shape === 'formula explanation') p.items[0].str += ' x/y'
      if (shape === 'unicode math') p.items[0].str += ' 𝑥'
      if (shape === 'variable subtraction') p.items[0].str += ' x-y'
      if (shape === 'function explanation') p.items[0].str += ' min(x)'
      if (shape === 'no opening') p.items[0].str = p.items[0].str.replace('(', '')
      if (shape === 'second closing') p.items[1].str += ')'
      if (shape === 'trailing formula') p.items[1].str += ' x/y'
      if (shape === 'uppercase heading') p.items[1].str = 'Table Results)'
      if (shape === 'variable tail') p.items[1].str = 'of x)'
      if (shape === 'font') p.items[1].fontName = 'different-font'
      if (shape === 'size') {
        p.items[1].height = 7
        p.items[1].transform[0] = p.items[1].transform[3] = 7
      }
      if (shape === 'raised') p.items[1].transform[5] += 5
      if (shape === 'column') p.items[1].transform[4] += 300
      if (shape === 'indent') p.items[1].transform[4] += 10
      if (shape === 'wide leading') p.items[1].transform[5] -= 15
      if (shape === 'interruption')
        p.items.splice(1, 0, {
          ...p.items[1],
          str: 'Note',
          width: 20,
          transform: [9.9626, 0, 0, 9.9626, 40, 382.58]
        })
      if (shape === 'blank native break')
        p.items.splice(1, 0, { ...p.items[1], str: '', height: 0, hasEOL: true })
      if (shape === 'reversed native order') p.items.reverse()
      const result = extractDocument(document([p]))
      const keys = result.units.flatMap((unit) => unit.items)
      assert.equal(new Set(keys).size, keys.length)
      for (const [index, item] of p.items.entries())
        if (item.str.trim()) assert.ok(keys.includes(`1:${index}`))
      const tailIndex = ['interruption', 'blank native break'].includes(shape) ? 2 : 1
      assert.notEqual(
        result.units.find((unit) => unit.items.includes('1:0')),
        result.units.find((unit) => unit.items.includes(`1:${tailIndex}`))
      )
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'styled-bullet-terminal-native.jsonl'
)) {
  for (const label of ['A', 'B']) {
    test(`keeps a short terminal bullet's native label in prose: ${label}`, () => {
      const p = structuredClone(fixture.page)
      p.items[3].str = label
      const result = extractDocument(document([p]))
      assert.equal(result.units.length, 1)
      assert.equal(result.units[0].sourceOnly, undefined)
      assert.equal(
        result.units[0].source,
        `• For single-sentence inputs we only use the sentence ${label} structured.`
      )
      assert.deepEqual(result.units[0].items, ['1:0', '1:1', '1:3', '1:5'])
    })
  }
  for (const shape of [
    'nonbullet',
    'complete first row',
    'no determiner',
    'short context',
    'operator',
    'greek',
    'multiple letters',
    'numeric label',
    'lowercase variable',
    'unclosed sentence',
    'new bullet',
    'heading',
    'foreign first word',
    'foreign last word',
    'missing font',
    'small label',
    'raised label',
    'nonfinite matrix',
    'rotated label',
    'reversed matrix',
    'wide leading',
    'near baseline',
    'column',
    'no indent',
    'extra indent',
    'native break',
    'blank native break',
    'interruption',
    'reversed native order'
  ]) {
    test(`does not attach an unproven styled terminal bullet: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'nonbullet') p.items[0].str = p.items[0].str.replace('• ', '')
      if (shape === 'complete first row') p.items[0].str += '.'
      if (shape === 'no determiner') p.items[0].str = p.items[0].str.replace('the', 'with')
      if (shape === 'short context') p.items[0].str = '• We use the'
      if (shape === 'operator') p.items[3].str = 'A +'
      if (shape === 'greek') p.items[3].str = 'Γ'
      if (shape === 'multiple letters') p.items[3].str = 'AB'
      if (shape === 'numeric label') p.items[3].str = '1'
      if (shape === 'lowercase variable') p.items[3].str = 'x'
      if (shape === 'unclosed sentence') p.items[5].str = 'structured'
      if (shape === 'new bullet') p.items[1].str = '• sentence'
      if (shape === 'heading') p.items[1].str = 'Sentence'
      if (shape === 'foreign first word') p.items[1].fontName = 'foreign-font'
      if (shape === 'foreign last word') p.items[5].fontName = 'foreign-font'
      if (shape === 'missing font') p.items[3].fontName = undefined
      if (shape === 'small label') {
        p.items[3].height = 7
        p.items[3].transform[0] = p.items[3].transform[3] = 7
      }
      if (shape === 'raised label') p.items[3].transform[5] += 4
      if (shape === 'nonfinite matrix') p.items[3].transform[0] = Infinity
      if (shape === 'rotated label')
        p.items[3].transform = [0, 10.9091, -10.9091, 0, 134.105, 371.703]
      if (shape === 'reversed matrix') p.items[3].transform[0] *= -1
      if (shape === 'wide leading') for (const item of p.items.slice(1)) item.transform[5] -= 14
      if (shape === 'near baseline') for (const item of p.items.slice(1)) item.transform[5] += 7
      if (shape === 'column') for (const item of p.items.slice(1)) item.transform[4] += 300
      if (shape === 'no indent') for (const item of p.items.slice(1)) item.transform[4] -= 8.799
      if (shape === 'extra indent') for (const item of p.items.slice(1)) item.transform[4] += 20
      if (shape === 'native break') p.items[3].hasEOL = true
      if (shape === 'blank native break') p.items[2].hasEOL = true
      if (shape === 'interruption')
        p.items[2] = {
          ...p.items[2],
          str: 'Note',
          width: 20,
          height: 10.9091,
          transform: [10.9091, 0, 0, 10.9091, 40, 371.703]
        }
      if (shape === 'reversed native order') p.items.reverse()
      const result = extractDocument(document([p]))
      const first = result.units.find(
        (unit) => unit.source.includes('For single-sentence') || unit.source.startsWith('• We use')
      )!
      const label = result.units.find((unit) => unit.source.includes('structured'))!
      assert.ok(first)
      assert.ok(label)
      // Same-left prose already follows the existing non-hanging body path.
      if (shape === 'no indent') assert.equal(first, label)
      else assert.notEqual(first, label)
      const keys = result.units.flatMap((unit) => unit.items)
      assert.equal(new Set(keys).size, keys.length)
      for (const [index, item] of p.items.entries())
        if (item.str.trim()) assert.ok(keys.includes(`1:${index}`))
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'short-formula-prose-native.jsonl'
)) {
  test(`keeps a short native prose wrap after its formula: ${fixture.name}`, () => {
    const result = extractDocument(document([fixture.page]))
    assert.equal(result.units.length, 2)
    const formula = result.units.find((unit) => unit.sourceOnly)!
    assert.equal(formula.source, 'β2 = 0.98')
    assert.deepEqual(formula.items, ['1:0', '1:1', '1:3', '1:4', '1:5'])
    const prose = result.units.find((unit) => !unit.sourceOnly)!
    assert.equal(prose.source, 'to minimum measureme when training with large local masks.')
    assert.deepEqual(prose.items, ['1:7', '1:8'])
  })
  for (const shape of [
    'short context',
    'complete context',
    'variable words',
    'math in context',
    'math in tail',
    'function',
    'unicode math',
    'heading',
    'one word',
    'missing period',
    'different font',
    'missing font',
    'small tail',
    'raised tail',
    'rotated tail',
    'nonfinite matrix',
    'reversed matrix',
    'large leading',
    'column',
    'indent',
    'prefix gap',
    'wrong formula edge',
    'formula different baseline',
    'prefix native break',
    'prefix blank break',
    'tail blank break',
    'prefix interruption',
    'tail interruption',
    'reversed native order'
  ]) {
    test(`does not attach an unproven short formula prose wrap: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'short context') p.items[7].str = 'to improve stability with'
      if (shape === 'complete context') p.items[7].str += '.'
      if (shape === 'variable words') p.items[7].str = 'to improve with x y z'
      if (shape === 'math in context') p.items[7].str = 'to improve stability with x/y'
      if (shape === 'math in tail') p.items[8].str = 'large x-y sizes.'
      if (shape === 'function') p.items[8].str = 'min(x) for sizes.'
      if (shape === 'unicode math') p.items[8].str = 'large 𝑥 sizes.'
      if (shape === 'heading') p.items[8].str = 'Large Batch Sizes.'
      if (shape === 'one word') p.items[8].str = 'sizes.'
      if (shape === 'missing period') p.items[8].str = 'large local masks'
      if (shape === 'different font') p.items[8].fontName = 'different-font'
      if (shape === 'missing font') p.items[8].fontName = undefined
      if (shape === 'small tail') {
        p.items[8].height = 7
        p.items[8].transform[0] = p.items[8].transform[3] = 7
      }
      if (shape === 'raised tail') p.items[8].transform[5] += 7
      if (shape === 'rotated tail') p.items[8].transform = [0, 10.9091, -10.9091, 0, 72, 659.7404]
      if (shape === 'nonfinite matrix') p.items[8].transform[0] = Infinity
      if (shape === 'reversed matrix') p.items[8].transform[0] *= -1
      if (shape === 'large leading') p.items[8].transform[5] -= 14
      if (shape === 'column') p.items[8].transform[4] += 250
      if (shape === 'indent') p.items[8].transform[4] += 15
      if (shape === 'prefix gap') p.items[7].transform[4] += 10
      if (shape === 'wrong formula edge')
        for (const item of p.items.slice(0, 6)) item.transform[4] -= 15
      if (shape === 'formula different baseline')
        for (const item of p.items.slice(0, 6)) item.transform[5] += 20
      if (shape === 'prefix native break') p.items[5].hasEOL = true
      if (shape === 'prefix blank break') p.items[6].hasEOL = true
      if (shape === 'tail blank break')
        p.items.splice(8, 0, { ...p.items[8], str: '', height: 0, hasEOL: true })
      if (shape === 'prefix interruption')
        p.items[6] = {
          ...p.items[6],
          str: 'Note',
          height: 10.9091,
          width: 20,
          transform: [10.9091, 0, 0, 10.9091, 40, 673.3006]
        }
      if (shape === 'tail interruption')
        p.items.splice(8, 0, {
          ...p.items[8],
          str: 'Note',
          width: 20,
          transform: [10.9091, 0, 0, 10.9091, 40, 660]
        })
      if (shape === 'reversed native order') p.items.reverse()
      const result = extractDocument(document([p]))
      const firstKey = shape === 'reversed native order' ? '1:1' : '1:7'
      const nextKey =
        shape === 'reversed native order'
          ? '1:0'
          : ['tail blank break', 'tail interruption'].includes(shape)
            ? '1:9'
            : '1:8'
      const first = result.units.find((unit) => unit.items.includes(firstKey))!
      const next = result.units.find((unit) => unit.items.includes(nextKey))!
      assert.ok(first)
      assert.ok(next)
      assert.notEqual(first, next)
      const keys = result.units.flatMap((unit) => unit.items)
      assert.equal(new Set(keys).size, keys.length)
      for (const [index, item] of p.items.entries())
        if (item.str.trim()) assert.ok(keys.includes(`1:${index}`))
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'floating-table-native-ownership.jsonl'
)) {
  test(`separates native floating-table ownership from neighboring prose: ${fixture.name}`, () => {
    const result = extractDocument(document([fixture.page]))
    const owner = (index: number) => result.units.find((unit) => unit.items.includes(`1:${index}`))!
    expect(owner(164).source).toBe('5.2 Evaluation')
    expect(owner(164).items).toEqual(['1:164', '1:166'])
    expect(owner(265)).toBe(owner(274))
    expect(owner(265).source).toBe(
      'Following layout sequence, we use the LINK (Tag-stable Measureme Geometry Independently) measureme [24] to samples observation on a group of geometry un-observation tasks. This is a evidence-simple measureme ordinary 57 tasks including controlled collections, US ordered, standard regions, key, and more. We report 5-line test accuracy.'
    )
    expect(owner(265).items).toEqual(
      [265, 266, 267, 268, 270, 271, 272, 273, 274].map((i) => `1:${i}`)
    )
    expect(owner(168)).toBe(owner(172))
    expect(owner(168).source).toBe(
      'Table 5: LINK 5-line test results for different masks of TRaCE measureme on the independently datasets using TEsTS.'
    )
    expect(owner(168).items).toEqual([168, 170, 171, 172].map((i) => `1:${i}`))
    for (const i of [176, 178, 180, 182, 185, 187, 189, 191]) {
      expect(owner(i).sourceOnly).toBe(true)
      expect(owner(i)).not.toBe(owner(265))
      expect(owner(i)).not.toBe(owner(168))
    }
    const keys = result.units.flatMap((unit) => unit.items)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.toSorted()).toEqual(
      fixture.page.items.flatMap((item, i) => (item.str.trim() ? [`1:${i}`] : [])).toSorted()
    )
  })
  for (const shape of [
    'table row break',
    'table missing font',
    'table mixed font',
    'same size table',
    'body native row break',
    'short table descriptor'
  ]) {
    test(`does not use an unproven smaller native table frame: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'table row break') p.items[178].hasEOL = true
      if (shape === 'table missing font') p.items[174].fontName = undefined
      if (shape === 'table mixed font') p.items[178].fontName = 'different-font'
      if (shape === 'same size table')
        for (const item of p.items.slice(174, 183)) {
          item.height = 9.9626
          item.transform[0] = item.transform[3] = 9.9626
        }
      if (shape === 'body native row break') p.items[272].hasEOL = false
      if (shape === 'short table descriptor') p.items[272].str = 'Description of measured tasks'
      const result = extractDocument(document([p]))
      const owner = (index: number) =>
        result.units.find((unit) => unit.items.includes(`1:${index}`))!
      expect(owner(265)).not.toBe(owner(266))
      expect(owner(174)).not.toBe(owner(272))
      const keys = result.units.flatMap((unit) => unit.items)
      expect(new Set(keys).size).toBe(keys.length)
      expect(keys.toSorted()).toEqual(
        p.items.flatMap((item, i) => (item.str.trim() ? [`1:${i}`] : [])).toSorted()
      )
    })
  }
  for (const shape of [
    'left note',
    'right unknown note',
    'no caption',
    'body style heading',
    'same style body',
    'unnumbered heading'
  ]) {
    test(`does not skip unproven interleaved objects after a native heading: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'left note' || shape === 'right unknown note')
        p.items[167] = {
          ...p.items[168],
          str: 'Independent note',
          width: 55,
          transform: [8.9664, 0, 0, 8.9664, shape === 'left note' ? 108 : 530, 244],
          hasEOL: true
        }
      if (shape === 'no caption') p.items[168].str = 'Results:'
      if (shape === 'body style heading')
        for (const i of [164, 166]) p.items[i].fontName = p.items[265].fontName
      if (shape === 'same style body') p.items[265].fontName = p.items[164].fontName
      if (shape === 'unnumbered heading') p.items[164].str = 'Appendix'
      const result = extractDocument(document([p]))
      const heading = result.units.find((unit) => unit.items.includes('1:166'))!
      const body = result.units.find((unit) => unit.items.includes('1:265'))!
      expect(heading).toBe(body)
      const keys = result.units.flatMap((unit) => unit.items)
      expect(new Set(keys).size).toBe(keys.length)
      expect(keys.toSorted()).toEqual(
        p.items.flatMap((item, i) => (item.str.trim() ? [`1:${i}`] : [])).toSorted()
      )
    })
  }
}

test('keeps long descriptive native table cells with their own smaller measured columns', () => {
  const descriptors = [
    'Participants receiving the initial treatment protocol.',
    'Participants completing the secondary response visit.',
    'Participants reporting the final treatment outcome.'
  ]
  const items = descriptors.flatMap((str, row) => [
    { ...item(str, 40, 100 + row * 12, 225, 10, false), fontName: 'description' },
    { ...item(String(20 + row), 282, 100 + row * 12, 12, 8, false), fontName: 'values' },
    { ...item(String(30 + row), 315, 100 + row * 12, 12, 8, true), fontName: 'values' }
  ])
  const result = extractDocument(document([page(items)]))
  for (const [row, description] of descriptors.entries()) {
    const owner = result.units.find((unit) => unit.items.includes(`1:${row * 3}`))!
    assert.equal(owner.source, description)
    assert.deepEqual(owner.items, [`1:${row * 3}`])
    for (const column of [1, 2]) {
      const value = result.units.find((unit) => unit.items.includes(`1:${row * 3 + column}`))!
      assert.equal(value.sourceOnly, true)
      assert.deepEqual(value.items, [`1:${row * 3 + column}`])
    }
  }
  assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, 9)
})

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'styled-section-reference-native.jsonl'
)) {
  for (const sanitized of [false, true]) {
    test(`keeps native styled section labels with their prose, sanitized=${sanitized}`, () => {
      const p = structuredClone(fixture.page)
      if (sanitized)
        p.items = p.items.map((part) =>
          part.str.trim()
            ? part
            : {
                str: '',
                width: 0,
                height: 0,
                dir: 'ltr',
                transform: [0, 0, 0, 0, 0, 0],
                hasEOL: part.hasEOL
              }
        )
      const result = extractDocument(document([p]))
      for (const index of [32, 66, 151, 183]) {
        const owner = result.units.find((unit) => unit.items.includes(`1:${index}`))!
        expect(owner.sourceOnly).toBeUndefined()
        expect(owner.items).toContain(`1:${index + 2}`)
        expect(
          owner.source.startsWith(
            p.items[index].str + ' ' + p.items[index + 2].str.replace(/-$/u, '')
          )
        ).toBe(true)
      }
      const keys = result.units.flatMap((unit) => unit.items)
      expect(keys.length).toBe(new Set(keys).size)
      expect(keys.toSorted()).toEqual(
        p.items.flatMap((part, i) => (part.str.trim() ? [`1:${i}`] : [])).toSorted()
      )
    })
  }
  for (const shape of [
    'variables',
    'operator',
    'function',
    'unicode math',
    'minus',
    'missing marker',
    'variable section',
    'nested',
    'range',
    'known function',
    'missing font',
    'same font',
    'small label',
    'raised label',
    'rotation',
    'stretched',
    'nonfinite',
    'blank line break',
    'label line break',
    'inserted object',
    'column gap',
    'short prose',
    'different body font',
    'space baseline',
    'space reversed',
    'space missing font',
    'space coverage',
    'noncanonical empty',
    'canonical foreign font',
    'canonical break'
  ] as const) {
    test(`rejects unproven styled section-reference prose: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'space baseline') p.items[33].transform[5] += 20
      if (shape === 'space reversed') p.items[33].transform[0] *= -1
      if (shape === 'space missing font') p.items[33].fontName = undefined
      if (shape === 'space coverage') p.items[33].width += 2
      if (
        shape === 'noncanonical empty' ||
        shape === 'canonical foreign font' ||
        shape === 'canonical break'
      ) {
        p.items[33] = {
          str: '',
          width: 0,
          height: 0,
          dir: 'ltr',
          transform: [0, 0, 0, 0, 0, 0],
          hasEOL: shape === 'canonical break'
        }
        if (shape === 'noncanonical empty') p.items[33].transform[4] = 50
        if (shape === 'canonical foreign font') p.items[33].fontName = 'foreign'
      }
      if (shape === 'variables') p.items[34].str = 'X Y Z A B'
      if (shape === 'operator') p.items[34].str = 'The new value is x = y'
      if (shape === 'function') p.items[34].str = 'The new value is min(x)'
      if (shape === 'unicode math') p.items[34].str = 'The new value is 𝑥'
      if (shape === 'minus') p.items[34].str = 'The new value is x-y'
      if (shape === 'missing marker') p.items[32].str = 'Task (2).'
      if (shape === 'variable section') p.items[32].str = 'Task (§x).'
      if (shape === 'nested') p.items[32].str = 'Task ((§2)).'
      if (shape === 'range') p.items[32].str = 'Task (§2–3).'
      if (shape === 'known function') p.items[32].str = 'Softmax (§2).'
      if (shape === 'missing font') p.items[32].fontName = undefined
      if (shape === 'same font') p.items[32].fontName = p.items[34].fontName
      if (shape === 'small label') {
        p.items[32].height *= 0.7
        p.items[32].transform[0] *= 0.7
        p.items[32].transform[3] *= 0.7
      }
      if (shape === 'raised label') p.items[32].transform[5] += 3
      if (shape === 'rotation') p.items[32].transform[1] = 2
      if (shape === 'stretched') p.items[32].transform[0] *= 4
      if (shape === 'nonfinite') p.items[32].transform[0] = Infinity
      if (shape === 'blank line break') p.items[33].hasEOL = true
      if (shape === 'label line break') p.items[32].hasEOL = true
      if (shape === 'inserted object') p.items[33].str = 'Unknown'
      if (shape === 'column gap') p.items[34].transform[4] += 200
      if (shape === 'short prose') p.items[34].str = 'The model'
      if (shape === 'different body font') {
        const original = p.items[34]
        original.width /= 2
        original.str = 'In CUE and more'
        original.hasEOL = false
        p.items[35] = {
          ...original,
          str: 'verified standard native,',
          fontName: 'other-body',
          transform: [
            ...original.transform.slice(0, 4),
            original.transform[4] + original.width,
            original.transform[5]
          ]
        }
      }
      const result = extractDocument(document([p]))
      const label = result.units.find((unit) => unit.items.includes('1:32'))!
      if (shape === 'variables') expect(label.sourceOnly).toBe(true)
      else expect(label.items).not.toContain('1:34')
      const keys = result.units.flatMap((unit) => unit.items)
      expect(new Set(keys).size).toBe(keys.length)
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'smallcaps-year-citation-native.jsonl'
)) {
  for (const sanitized of [false, true]) {
    test(`completes native year citations after baseline small caps, sanitized=${sanitized}`, () => {
      const p = structuredClone(fixture.page)
      if (sanitized)
        p.items = p.items.map((part) =>
          part.str.trim()
            ? part
            : {
                str: '',
                width: 0,
                height: 0,
                dir: 'ltr',
                transform: [0, 0, 0, 0, 0, 0],
                hasEOL: part.hasEOL
              }
        )
      const result = extractDocument(document([p]))
      const owner = result.units.find((unit) => unit.items.includes('1:149'))!
      expect(owner.items).toEqual(
        [141, 142, 143, 145, 146, 147, 148, 149, 151, 153, 154, 155, 157, 158].map((i) => `1:${i}`)
      )
      expect(owner.source).toBe(
        '8Large local training can minimum training properties even without large broad movement verified through distinct ac-controlled, updates measureme from evidence item-regions are collections targets before each measurements node. This independently is measureme averaged in SOURCES (Job et al., 2019).'
      )
      expect(owner.sourceOnly).toBeUndefined()
      const keys = result.units.flatMap((unit) => unit.items)
      expect(keys.length).toBe(new Set(keys).size)
      expect(keys.toSorted()).toEqual(
        p.items.flatMap((part, i) => (part.str.trim() ? [`1:${i}`] : [])).toSorted()
      )
    })
  }
  for (const shape of [
    'raised name',
    'lowered name',
    'tiny script',
    'body sized',
    'foreign font',
    'missing font',
    'rotation',
    'stretched',
    'nonfinite',
    'short variable',
    'lowercase name',
    'operator name',
    'math prefix',
    'ascii minus',
    'missing author',
    'missing open',
    'non year',
    'unclosed',
    'second smallcaps',
    'blank break',
    'name break',
    'inserted note',
    'cross column',
    'large leading',
    'reversed year',
    'mixed body font'
  ] as const) {
    test(`preserves unproven small-caps citation boundaries: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'raised name') p.items[151].transform[5] += 3
      if (shape === 'lowered name') p.items[151].transform[5] -= 3
      if (shape === 'tiny script' || shape === 'body sized') {
        const size = p.items[149].height * (shape === 'tiny script' ? 0.6 : 1)
        p.items[151].height = size
        p.items[151].transform[0] = size
        p.items[151].transform[3] = size
      }
      if (shape === 'foreign font') p.items[151].fontName = 'different'
      if (shape === 'missing font') p.items[151].fontName = undefined
      if (shape === 'rotation') p.items[151].transform[1] = 2
      if (shape === 'stretched') p.items[151].transform[0] *= 4
      if (shape === 'nonfinite') p.items[151].transform[0] = Infinity
      if (shape === 'short variable') p.items[151].str = 'XY'
      if (shape === 'lowercase name') p.items[151].str = 'fairseq'
      if (shape === 'operator name') p.items[151].str = 'X+Y'
      if (shape === 'math prefix') p.items[149].str = 'the calculated value x/y is from'
      if (shape === 'ascii minus') p.items[149].str = 'the calculated value x-y is from'
      if (shape === 'missing author') p.items[154].str = 'X'
      if (shape === 'missing open') p.items[153].str = '['
      if (shape === 'non year') p.items[157].str = '21'
      if (shape === 'unclosed') p.items[158].str = '.'
      if (shape === 'second smallcaps') {
        p.items[154].height *= 0.8
        p.items[154].transform[0] *= 0.8
        p.items[154].transform[3] *= 0.8
      }
      if (shape === 'blank break') p.items[152].hasEOL = true
      if (shape === 'name break') p.items[151].hasEOL = true
      if (shape === 'inserted note')
        p.items[152] = {
          ...p.items[151],
          str: 'Independent',
          width: 20,
          transform: [7.1731, 0, 0, 7.1731, 320, 88.9]
        }
      if (shape === 'cross column') for (const i of [157, 158]) p.items[i].transform[4] += 240
      if (shape === 'large leading') for (const i of [157, 158]) p.items[i].transform[5] -= 30
      if (shape === 'reversed year') [p.items[157], p.items[158]] = [p.items[158], p.items[157]]
      if (shape === 'mixed body font') p.items[154].fontName = 'foreign-body'
      const result = extractDocument(document([p]))
      const owner = result.units.find((unit) => unit.items.includes('1:149'))!
      if (shape === 'body sized')
        expect(owner.items).toContain('1:157') // Existing same-size citation path.
      else expect(owner.items).not.toContain('1:157')
      const keys = result.units.flatMap((unit) => unit.items)
      expect(keys.length).toBe(new Set(keys).size)
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'cited-name-example-native.jsonl'
)) {
  for (const shape of ['actual', 'sanitized', 'other cited name', 'citation list'] as const) {
    test(`keeps a native cited-name example inside its paragraph: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'sanitized')
        p.items = p.items.map((part) =>
          part.str.trim()
            ? part
            : {
                str: '',
                width: 0,
                height: 0,
                dir: 'ltr',
                transform: [0, 0, 0, 0, 0, 0],
                hasEOL: part.hasEOL
              }
        )
      if (shape === 'other cited name')
        p.items[203].str = p.items[203].str.replace('CORE·E', 'OtherModel')
      if (shape === 'citation list') p.items[203].str = p.items[203].str.replace('[83]', '[12, 83]')
      const result = extractDocument(document([p]))
      const owner = result.units.find((unit) => unit.items.includes('1:200'))!
      for (const i of [188, 201, 202, 203, 204, 205, 206]) expect(owner.items).toContain(`1:${i}`)
      expect(owner.source.startsWith('Comparison models have also been analysis')).toBe(true)
      expect(owner.source.endsWith('baseline training data does not lines.')).toBe(true)
      expect(owner.sourceOnly).toBeUndefined()
      const keys = result.units.flatMap((unit) => unit.items)
      expect(keys.length).toBe(new Set(keys).size)
      expect(keys.toSorted()).toEqual(
        p.items.flatMap((part, i) => (part.str.trim() ? [`1:${i}`] : [])).toSorted()
      )
    })
  }
  for (const shape of [
    'variable product',
    'numeric product',
    'function name',
    'missing citation',
    'variable citation',
    'unclosed citation',
    'extra parenthesis',
    'operator suffix',
    'function suffix',
    'variable suffix',
    'minus suffix',
    'unicode suffix',
    'unclosed example',
    'raised example',
    'small example',
    'missing font',
    'foreign body font',
    'stretched',
    'rotation',
    'nonfinite',
    'native break',
    'previous break',
    'interposed note',
    'cross column',
    'large leading',
    'complete previous'
  ] as const) {
    test(`rejects an unproven native cited-name example: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'variable product') p.items[203].str = p.items[203].str.replace('CORE·E', 'X·Y')
      if (shape === 'numeric product')
        p.items[203].str = p.items[203].str.replace('CORE·E', '24·48')
      if (shape === 'function name')
        p.items[203].str = p.items[203].str.replace('CORE·E', 'Softmax')
      if (shape === 'missing citation') p.items[203].str = p.items[203].str.replace(' [83]', '')
      if (shape === 'variable citation') p.items[203].str = p.items[203].str.replace('[83]', '[x]')
      if (shape === 'unclosed citation') p.items[203].str = p.items[203].str.replace('[83]', '[83')
      if (shape === 'extra parenthesis') p.items[203].str = p.items[203].str.replace(']).', '])).')
      if (shape === 'operator suffix') p.items[203].str += ' x/y'
      if (shape === 'function suffix') p.items[203].str += ' min(x)'
      if (shape === 'variable suffix')
        p.items[203].str = p.items[203].str.replace('While much sequence has', 'X Y Z A B')
      if (shape === 'minus suffix') p.items[203].str += ' x-y'
      if (shape === 'unicode suffix') p.items[203].str += ' 𝑥'
      if (shape === 'unclosed example') p.items[203].str = p.items[203].str.replace(']).', '].')
      if (shape === 'raised example') p.items[202].transform[5] += 3
      if (shape === 'small example') {
        p.items[202].height *= 0.7
        p.items[202].transform[0] *= 0.7
        p.items[202].transform[3] *= 0.7
      }
      if (shape === 'missing font') p.items[202].fontName = undefined
      if (shape === 'foreign body font') p.items[203].fontName = 'other'
      if (shape === 'stretched') p.items[202].transform[0] *= 4
      if (shape === 'rotation') p.items[202].transform[1] = 2
      if (shape === 'nonfinite') p.items[202].transform[0] = Infinity
      if (shape === 'native break') p.items[202].hasEOL = true
      if (shape === 'previous break')
        p.items.splice(201, 0, {
          str: '',
          width: 0,
          height: 0,
          dir: 'ltr',
          transform: [0, 0, 0, 0, 0, 0],
          hasEOL: true
        })
      if (shape === 'interposed note')
        p.items.splice(202, 0, {
          ...p.items[202],
          str: 'Independent note',
          width: 60,
          transform: [9.9626, 0, 0, 9.9626, 50, 267.167]
        })
      if (shape === 'cross column') for (const i of [201, 202, 203]) p.items[i].transform[4] -= 250
      if (shape === 'large leading') for (const i of [201, 202, 203]) p.items[i].transform[5] -= 25
      if (shape === 'complete previous') p.items[200].str += '.'
      const result = extractDocument(document([p]))
      const owner = result.units.find((unit) => unit.items.includes('1:200'))!
      expect(owner.items).not.toContain(
        ['previous break', 'interposed note'].includes(shape) ? '1:204' : '1:203'
      )
      const keys = result.units.flatMap((unit) => unit.items)
      expect(keys.length).toBe(new Set(keys).size)
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'paired-footnote-native.jsonl'
)) {
  for (const sanitized of [false, true]) {
    test(`separates consecutive native raised footnotes, sanitized=${sanitized}`, () => {
      const p = structuredClone(fixture.page)
      if (sanitized)
        p.items = p.items.map((part) =>
          part.str.trim()
            ? part
            : {
                str: '',
                width: 0,
                height: 0,
                dir: 'ltr',
                transform: [0, 0, 0, 0, 0, 0],
                hasEOL: part.hasEOL
              }
        )
      const result = extractDocument(document([p]))
      const note2 = result.units.find((unit) => unit.items.includes('1:185'))!
      const note3 = result.units.find((unit) => unit.items.includes('1:188'))!
      expect(note2.source).toBe('2https://example.invalid/source')
      expect(note2.items).toEqual(['1:185', '1:186'])
      expect(note3).not.toBe(note2)
      expect(note3.source).toBe(
        '3E.g. CASE-base’s arrangement for a object token in "I point this is the beginning of a measureme [STEP]" complete run unit arrangement tokens (tag and info) and a case note of bound arrangement (header, curve, lines. . . ).'
      )
      expect(note3.items).toEqual(
        [188, 189, 191, 192, 193, 194, 195, 197, 199, 200, 201, 202, 203, 205, 206, 208, 209].map(
          (i) => `1:${i}`
        )
      )
      const keys = result.units.flatMap((unit) => unit.items)
      expect(keys.length).toBe(new Set(keys).size)
      expect(keys.toSorted()).toEqual(
        p.items.flatMap((part, i) => (part.str.trim() ? [`1:${i}`] : [])).toSorted()
      )
    })
  }
  for (const shape of [
    'missing peer',
    'duplicate marker',
    'nonconsecutive marker',
    'letter marker',
    'same baseline',
    'lowered marker',
    'large marker',
    'tiny marker',
    'foreign marker font',
    'missing font',
    'function lead',
    'variable lead',
    'body row break',
    'marker row break',
    'interruption',
    'marker gap',
    'peer shifted',
    'above footer',
    'stretched',
    'rotation',
    'math equation',
    'math greek',
    'math alphabet',
    'math minus',
    'math function',
    'reversed numbers',
    'single math names'
  ] as const) {
    test(`does not infer separate footnotes without paired native proof: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'math equation') p.items[186].str = 'Gamma equals the value x=1'
      if (shape === 'math greek') p.items[186].str = 'Gamma equals the value α'
      if (shape === 'math alphabet') p.items[186].str = 'Gamma equals the value 𝑥'
      if (shape === 'math minus') p.items[186].str = 'Gamma equals the value x-y'
      if (shape === 'math function') p.items[186].str = 'Gamma equals the value min(x)'
      if (shape === 'reversed numbers') {
        p.items[185].str = '3'
        p.items[188].str = '2'
      }
      if (shape === 'single math names') {
        p.items[186].str = 'Gamma'
        p.items[189].str = 'Delta'
        p.items[191].str = ''
        p.items[192].str = ''
      }
      if (shape === 'missing peer') p.items[185].str = ''
      if (shape === 'duplicate marker') p.items[188].str = '2'
      if (shape === 'nonconsecutive marker') p.items[188].str = '8'
      if (shape === 'letter marker') p.items[188].str = 'x'
      if (shape === 'same baseline') p.items[188].transform[5] = p.items[189].transform[5]
      if (shape === 'lowered marker') p.items[188].transform[5] = p.items[189].transform[5] - 2
      if (shape === 'large marker' || shape === 'tiny marker') {
        const scale = shape === 'large marker' ? 1.45 : 0.65
        p.items[188].height *= scale
        p.items[188].transform[0] *= scale
        p.items[188].transform[3] *= scale
      }
      if (shape === 'foreign marker font') p.items[188].fontName = 'foreign'
      if (shape === 'missing font') p.items[188].fontName = undefined
      if (shape === 'function lead') p.items[189].str = 'Softmax(x)'
      if (shape === 'variable lead') p.items[189].str = 'x'
      if (shape === 'body row break') p.items[190].hasEOL = true
      if (shape === 'marker row break') p.items[188].hasEOL = true
      if (shape === 'interruption')
        p.items[190] = {
          ...p.items[189],
          str: 'Independent note',
          width: 50,
          transform: [8.9664, 0, 0, 8.9664, 520, 91.925]
        }
      if (shape === 'marker gap') p.items[188].transform[4] -= 3
      if (shape === 'peer shifted') for (const i of [185, 186]) p.items[i].transform[4] += 4
      if (shape === 'above footer') for (const part of p.items) part.transform[5] += 150
      if (shape === 'stretched') p.items[188].transform[0] *= 3
      if (shape === 'rotation') p.items[188].transform[1] = 2
      const result = extractDocument(document([p]))
      const note2 = result.units.find((unit) => unit.items.includes('1:186'))!
      const note3 = result.units.find((unit) => unit.items.includes('1:189'))!
      if (shape === 'body row break' || shape === 'rotation' || shape === 'single math names')
        expect(note2).not.toBe(note3) // Existing native/orientation boundary.
      else expect(note2).toBe(note3)
      const keys = result.units.flatMap((unit) => unit.items)
      expect(keys.length).toBe(new Set(keys).size)
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'paired-prose-footnote-native.jsonl'
)) {
  test('separates two native raised prose footnotes without relying on a URL', () => {
    const result = extractDocument(document([fixture.page]))
    const note5 = result.units.find((unit) => unit.items.includes('1:179'))!
    const note6 = result.units.find((unit) => unit.items.includes('1:182'))!
    expect(note5.items).toEqual(['1:179', '1:180'])
    expect(note6.items).toEqual(['1:182', '1:183'])
    expect(note5.source).toBe(
      '5UNIFORM repeated more LOWEr per node because it boundary of the measureme as well as the independently.'
    )
    expect(note6.source).toBe(
      '6JOB is content in size to CASE-Base, but is trained for local stage.'
    )
    const keys = result.units.flatMap((unit) => unit.items)
    expect(keys.length).toBe(new Set(keys).size)
    expect(keys.toSorted()).toEqual(
      fixture.page.items.flatMap((part, i) => (part.str.trim() ? [`1:${i}`] : [])).toSorted()
    )
  })
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'paired-url-footnote-native.jsonl'
)) {
  for (const sanitized of [false, true]) {
    test(`keeps two native URL footnotes separate, sanitized=${sanitized}`, () => {
      const p = structuredClone(fixture.page)
      if (sanitized)
        p.items = p.items.map((part) =>
          part.str.trim()
            ? part
            : {
                str: '',
                width: 0,
                height: 0,
                dir: 'ltr',
                transform: [0, 0, 0, 0, 0, 0],
                hasEOL: part.hasEOL
              }
        )
      const result = extractDocument(document([p]))
      const note2 = result.units.find((unit) => unit.items.includes('1:243'))!
      const note3 = result.units.find((unit) => unit.items.includes('1:246'))!
      expect(note2.items).toEqual(['1:243', '1:244'])
      expect(note3.items).toEqual(['1:246', '1:247'])
      expect(note2.source).toBe('2https://example.invalid/source')
      expect(note3.source).toBe('3https://example.invalid/source')
      // The corresponding raised references remain with their body paragraphs.
      for (const index of [195, 204]) {
        const owner = result.units.find((unit) => unit.items.includes(`1:${index}`))!
        expect(owner).not.toBe(note2)
        expect(owner).not.toBe(note3)
        expect(owner.items.length).toBeGreaterThan(1)
      }
      const keys = result.units.flatMap((unit) => unit.items)
      expect(keys.length).toBe(new Set(keys).size)
      expect(keys.toSorted()).toEqual(
        p.items.flatMap((part, index) => (part.str.trim() ? [`1:${index}`] : [])).toSorted()
      )
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; page: PdfLayoutPage }>(
  'hanging-bibliography-native.jsonl'
)) {
  for (const sanitized of [false, true]) {
    test(`keeps native hanging bibliography entries complete and separate, sanitized=${sanitized}`, () => {
      const p = structuredClone(fixture.page)
      if (sanitized)
        p.items = p.items.map((part) =>
          part.str.trim()
            ? part
            : {
                str: '',
                width: 0,
                height: 0,
                dir: 'ltr',
                transform: [0, 0, 0, 0, 0, 0],
                hasEOL: part.hasEOL
              }
        )
      const result = extractDocument(document([p]))
      const owner = (index: number) =>
        result.units.find((unit) => unit.items.includes(`1:${index}`))!
      const entries = [
        [12, 13, 15, 16],
        [17, 18],
        [19, 20, 22, 23, 24],
        [25, 27, 28],
        [29, 30, 32, 33],
        [34, 35, 37, 38],
        [39, 41, 42],
        [43, 45, 46, 47],
        [48, 49, 50, 52, 53],
        [54, 56, 57, 59, 60],
        [61, 62, 64, 65],
        [66, 67, 68, 69, 71, 73, 74, 76, 77],
        [78, 79, 81, 82],
        [83, 84, 86, 87],
        [88, 89, 91, 92],
        [93, 95, 96],
        [97, 98, 100, 101],
        [102, 103, 105, 106],
        [107, 108, 110, 111],
        [112, 114, 115],
        [116, 117, 119, 120]
      ]
      for (const indices of entries) {
        expect(owner(indices[0]).items).toEqual(indices.map((index) => `1:${index}`))
        expect(owner(indices[0]).sourceOnly).toBe(true)
      }
      expect(new Set(entries.map((indices) => owner(indices[0]))).size).toBe(21)
      expect(owner(12).source).toBe(
        'Index Signal, Font-Job Exact, Margin Tag, and Complete Measureme. Case: Pre-training of unit independently measurements for geometry independently. In TESTS-BOX, 2018.'
      )
      const keys = result.units.flatMap((unit) => unit.items)
      expect(keys.length).toBe(new Set(keys).size)
      expect(keys.toSorted()).toEqual(
        p.items.flatMap((part, i) => (part.str.trim() ? [`1:${i}`] : [])).toSorted()
      )
    })
  }
  for (const shape of [
    'missing heading',
    'heading after',
    'same size heading',
    'missing heading font',
    'rotated venue',
    'reversed venue',
    'first row equation',
    'first row variables',
    'first row subtraction',
    'appendix between',
    'peer beyond heading',
    'no repeated pattern',
    'no authors comma',
    'short first row',
    'ordinary paragraph',
    'no indent',
    'large indent',
    'left column',
    'large leading',
    'small continuation',
    'raised continuation',
    'different first font',
    'different edge font',
    'missing font',
    'stretched',
    'rotation',
    'native break',
    'blank break',
    'interposed object'
  ] as const) {
    test(`rejects unproven hanging bibliography flow: ${shape}`, () => {
      const p = structuredClone(fixture.page)
      if (shape === 'missing heading') p.items[10].str = 'Sources'
      if (shape === 'heading after') p.items[10].transform[5] = 580
      if (shape === 'missing heading font') p.items[10].fontName = undefined
      if (shape === 'rotated venue') p.items[15].transform[1] = 1
      if (shape === 'reversed venue') p.items[15].transform[0] *= -1
      if (shape === 'first row equation')
        p.items[12].str = 'Alpha, these tokens satisfy the formula x=1 for all values'
      if (shape === 'first row variables')
        p.items[12].str = 'Alpha, these tokens satisfy the formula α for all values'
      if (shape === 'first row subtraction')
        p.items[12].str = 'Alpha, these tokens satisfy the formula x-y for all values'
      if (shape === 'same size heading') {
        p.items[10].height = 8.9664
        p.items[10].transform[0] = 8.9664
        p.items[10].transform[3] = 8.9664
      }
      if (shape === 'appendix between')
        p.items[11] = {
          ...p.items[10],
          str: 'Appendix',
          width: 45,
          transform: [11.9552, 0, 0, 11.9552, 108, 609],
          hasEOL: true
        }
      if (shape === 'peer beyond heading')
        p.items[17] = {
          ...p.items[10],
          str: 'Appendix',
          width: 45,
          transform: [11.9552, 0, 0, 11.9552, 108, 575.843],
          hasEOL: true
        }
      if (shape === 'no repeated pattern') p.items = p.items.slice(0, 17)
      if (shape === 'no authors comma') p.items[12].str = p.items[12].str.replaceAll(',', '')
      if (shape === 'short first row') p.items[12].str = 'Jacob Devlin, Bert'
      if (shape === 'ordinary paragraph')
        p.items[12].str =
          'The following paragraph introduces all of the methods used in this paper.'
      if (shape === 'no indent' || shape === 'large indent' || shape === 'left column')
        for (const i of [13, 15, 16])
          p.items[i].transform[4] +=
            shape === 'no indent' ? -9.963 : shape === 'large indent' ? 20 : -100
      if (shape === 'large leading') for (const i of [13, 15, 16]) p.items[i].transform[5] -= 8
      if (shape === 'small continuation')
        for (const i of [13, 15, 16]) {
          p.items[i].height *= 0.8
          p.items[i].transform[0] *= 0.8
          p.items[i].transform[3] *= 0.8
        }
      if (shape === 'raised continuation') p.items[15].transform[5] += 3
      if (shape === 'different first font') p.items[12].fontName = 'other'
      if (shape === 'different edge font') p.items[13].fontName = 'other'
      if (shape === 'missing font') p.items[13].fontName = undefined
      if (shape === 'stretched') p.items[13].transform[0] *= 3
      if (shape === 'rotation') p.items[13].transform[1] = 2
      if (shape === 'native break') p.items[13].hasEOL = true
      if (shape === 'blank break') p.items[14].hasEOL = true
      if (shape === 'interposed object')
        p.items[14] = {
          ...p.items[13],
          str: 'Independent note',
          width: 40,
          transform: [8.9664, 0, 0, 8.9664, 520, 592.349],
          hasEOL: false
        }
      const result = extractDocument(document([p]))
      const first = result.units.find((unit) => unit.items.includes('1:12'))!
      if (shape === 'no indent')
        expect(first.items).toContain('1:13') // Existing ordinary same-edge wrap.
      else expect(first.items).not.toContain('1:13')
      const keys = result.units.flatMap((unit) => unit.items)
      expect(keys.length).toBe(new Set(keys).size)
    })
  }
}

for (const fixture of readPdfTranslationCases<{
  name: string
  page: PdfLayoutPage
  entries: { indices: number[]; following: number }[]
}>('hanging-bibliography-additional-native.jsonl')) {
  for (const sanitized of [false, true]) {
    test(`preserves actual hanging bibliography ownership for ${fixture.name}, sanitized=${sanitized}`, () => {
      const p = structuredClone(fixture.page)
      if (sanitized)
        p.items = p.items.map((part) =>
          part.str.trim()
            ? part
            : {
                str: '',
                width: 0,
                height: 0,
                dir: 'ltr',
                transform: [0, 0, 0, 0, 0, 0],
                hasEOL: part.hasEOL
              }
        )
      const result = extractDocument(document([p]))
      const owner = (index: number) =>
        result.units.find((unit) => unit.items.includes(`1:${index}`))!
      for (const entry of fixture.entries) {
        const unit = owner(entry.indices[0])
        expect(unit.items).toEqual(entry.indices.map((index) => `1:${index}`))
        expect(unit.sourceOnly).toBe(true)
        expect(owner(entry.following)).not.toBe(unit)
      }
      if (
        fixture.name === 'hanging-bibliography-additional-native hanging entries across columns'
      ) {
        // The later cross-column measur-/ing boundary remains conservative.
        expect(owner(93).source).toMatch(/measur-$/u)
      }
      const keys = result.units.flatMap((unit) => unit.items)
      expect(keys.length).toBe(new Set(keys).size)
      expect(keys.toSorted()).toEqual(
        p.items.flatMap((part, index) => (part.str.trim() ? [`1:${index}`] : [])).toSorted()
      )
    })
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
  'cross-column-reference-native.jsonl'
)) {
  for (const sanitized of [false, true]) {
    const input = (): PdfLayoutPage[] =>
      structuredClone(fixture.pages).map((p) => ({
        ...p,
        items: p.items.map((part) =>
          !sanitized || part.str.trim()
            ? part
            : {
                str: '',
                width: 0,
                height: 0,
                dir: 'ltr',
                transform: [0, 0, 0, 0, 0, 0],
                hasEOL: part.hasEOL
              }
        )
      }))
    test(`restores the native cross-column reference word, sanitized=${sanitized}`, () => {
      const pages = input(),
        result = extractDocument(document(pages))
      const owner = result.units.find((u) => u.items.includes('1:93'))!
      expect(owner.items).toEqual([93, 94, 95, 96, 98, 99, 100].map((i) => `1:${i}`))
      expect(owner.sourceOnly).toBe(true)
      expect(owner.source).toContain(
        'measureme for measuring sequence in arrangement geometry standard.'
      )
      expect(owner.source).toContain('Line Point-set.') // No guessed correction to an unrelated proper name.
      expect(owner.fragments).toHaveLength(2)
      expect(owner.fragments[0].rect.right).toBeLessThan(owner.fragments[1].rect.x)
      expect(result.units.find((u) => u.items.includes('1:101'))).not.toBe(owner)
      const keys = result.units.flatMap((u) => u.items)
      expect(keys.length).toBe(new Set(keys).size)
      expect(keys.toSorted()).toEqual(
        pages
          .flatMap((p) => p.items.flatMap((i, n) => (i.str.trim() ? [`${p.page}:${n}`] : [])))
          .toSorted()
      )
    })
    for (const shape of [
      'no reference heading',
      'no complete word',
      'known compound',
      'missing break',
      'capitalized suffix',
      'formula suffix',
      'variable division',
      'variable minus',
      'function suffix',
      'not bottom',
      'not top',
      'same column',
      'different width',
      'author indent',
      'small author',
      'large author',
      'author gap',
      'not author',
      'missing font',
      'different seam font',
      'small type',
      'raised glyph',
      'rotation',
      'reversed matrix',
      'nonfinite matrix',
      'nonfinite height',
      'nonfinite width',
      'no EOL',
      'extra blank EOL',
      'interposed object',
      'partial original row'
    ] as const) {
      test(`rejects unproven cross-column reference word: ${shape}, sanitized=${sanitized}`, () => {
        const pages = input(),
          p = pages[0]
        if (shape === 'no reference heading')
          for (const item of p.items) if (item.str === 'References') item.str = 'Discussion'
        if (shape === 'no complete word' || shape === 'known compound')
          for (const q of pages)
            for (const item of q.items)
              item.str = item.str.replace(
                /\bmeasuring\b/gu,
                shape === 'no complete word' ? 'counting' : 'measur-ing'
              )
        if (shape === 'missing break')
          p.items[95].str = p.items[95].str.replace(/measur-$/u, 'measure')
        if (shape === 'capitalized suffix')
          p.items[96].str = p.items[96].str.replace(/^ing/u, 'Ing')
        if (shape === 'formula suffix') p.items[96].str = 'ing progress in the calculation x=1.'
        if (shape === 'variable division') p.items[96].str = 'ing progress in the calculation x/y.'
        if (shape === 'variable minus') p.items[96].str = 'ing progress in the calculation x-y.'
        if (shape === 'function suffix') p.items[96].str = 'ing progress in the calculation min(x).'
        if (shape === 'not bottom') for (const i of [93, 94, 95]) p.items[i].transform[5] += 120
        if (shape === 'not top')
          for (const i of [96, 97, 98, 99, 100]) p.items[i].transform[5] -= 120
        if (shape === 'same column')
          for (const i of [96, 97, 98, 99, 100]) p.items[i].transform[4] -= 235
        if (shape === 'different width') p.items[98].width += 50
        if (shape === 'small author' || shape === 'large author') {
          const scale = shape === 'small author' ? 0.8 : 1.2
          p.items[101].height *= scale
          p.items[101].transform[0] *= scale
          p.items[101].transform[3] *= scale
        }
        if (shape === 'author indent') p.items[101].transform[4] += 10.909
        if (shape === 'author gap') p.items[101].transform[5] -= 30
        if (shape === 'not author')
          p.items[101].str = 'This paragraph describes another independent subject.'
        if (shape === 'missing font') p.items[96].fontName = undefined
        if (shape === 'different seam font') p.items[96].fontName = 'other'
        if (shape === 'small type') p.items[96].height *= 0.7
        if (shape === 'raised glyph') p.items[98].transform[5] += 5
        if (shape === 'rotation') p.items[98].transform[1] = 2
        if (shape === 'reversed matrix') p.items[98].transform[0] *= -1
        if (shape === 'nonfinite height') p.items[95].height = NaN
        if (shape === 'nonfinite width') p.items[95].width = NaN
        if (shape === 'nonfinite matrix') p.items[98].transform[0] = Infinity
        if (shape === 'no EOL') p.items[95].hasEOL = false
        if (shape === 'extra blank EOL')
          p.items.splice(96, 0, {
            str: '',
            width: 0,
            height: 0,
            dir: 'ltr',
            transform: [0, 0, 0, 0, 0, 0],
            hasEOL: true
          })
        if (shape === 'interposed object')
          p.items.splice(96, 0, {
            ...p.items[95],
            str: 'Independent note',
            width: 70,
            hasEOL: true
          })
        if (shape === 'partial original row')
          p.items[97] = {
            ...p.items[96],
            str: 'Note',
            width: 20,
            transform: [0, 9.9626, -9.9626, 0, 499, 768.123],
            hasEOL: false
          }
        const result = extractDocument(document(pages))
        const owner = result.units.find((u) => u.items.includes('1:93'))!
        const tail = shape === 'extra blank EOL' || shape === 'interposed object' ? '1:97' : '1:96'
        expect(owner.items).not.toContain(tail)
        const keys = result.units.flatMap((u) => u.items)
        expect(keys.length).toBe(new Set(keys).size)
      })
    }
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
  'short-page-column-native.jsonl'
)) {
  for (const sanitized of [false, true]) {
    const input = (): PdfLayoutPage[] =>
      structuredClone(fixture.pages).map((p) => ({
        ...p,
        items: p.items.map((part) =>
          !sanitized || part.str.trim()
            ? part
            : {
                str: '',
                width: 0,
                height: 0,
                dir: 'ltr',
                transform: [0, 0, 0, 0, 0, 0],
                hasEOL: part.hasEOL
              }
        )
      }))
    test(`joins a short page word using independent native column rows, sanitized=${sanitized}`, () => {
      const pages = input(),
        result = extractDocument(document(pages))
      const unit = result.units.find((u) => u.items.includes('1:155'))!
      expect(unit.items).toEqual(
        [138, 140, 142, 144, 145, 146, 147, 148, 149, 150, 152, 153, 154, 155]
          .map((i) => `1:${i}`)
          .concat([0, 2, 3, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((i) => `2:${i}`))
      )
      expect(unit.source).toContain('arrangement of token tk given the ordered (t1, ..., tk−1):')
      expect(unit.sourceOnly).toBeUndefined()
      expect(unit.fragments.map((f) => f.page)).toEqual([1, 2])
      // The equation below the continuation is neither a width witness nor translated prose.
      for (const i of [
        17, 18, 19, 20, 21, 22, 23, 24, 26, 28, 29, 31, 32, 34, 35, 36, 37, 39, 41, 42, 43, 44, 45,
        46, 47, 48, 49, 50
      ]) {
        const owner = result.units.find((u) => u.items.includes(`2:${i}`))!
        expect(owner).not.toBe(unit)
        expect(owner.sourceOnly).toBe(true)
      }
      const keys = result.units.flatMap((u) => u.items)
      expect(keys.length).toBe(new Set(keys).size)
      expect(keys.toSorted()).toEqual(
        pages
          .flatMap((p) => p.items.flatMap((i, n) => (i.str.trim() ? [`${p.page}:${n}`] : [])))
          .toSorted()
      )
    })
    for (const shape of [
      'no lexicon',
      'compound lexicon',
      'one witness',
      'no witnesses',
      'math witnesses',
      'foreign witnesses',
      'column witnesses',
      'first page note',
      'new page note',
      'first page blank EOL',
      'new page blank EOL',
      'not page bottom',
      'not page top',
      'wrong column',
      'indented suffix',
      'overwide suffix',
      'capitalized suffix',
      'body font',
      'missing font',
      'missing script font',
      'raised script',
      'flat small script',
      'wide script gap',
      'multi letter script',
      'Greek script',
      'misaligned script cluster',
      'raised body',
      'formula prose',
      'function prose',
      'matrix stretch',
      'rotated script',
      'nonfinite height',
      'nonfinite width',
      'native EOL',
      'formula same native row'
    ] as const) {
      test(`rejects unproven short page column: ${shape}, sanitized=${sanitized}`, () => {
        const pages = input(),
          old = pages[0],
          p = pages[1]
        if (shape === 'no lexicon' || shape === 'compound lexicon')
          for (const q of pages)
            for (const item of q.items)
              item.str = item.str.replace(
                /\btoken\b/gu,
                shape === 'no lexicon' ? 'symbol' : 'to-ken'
              )
        if (shape === 'one witness') for (const i of [55, 72, 109]) p.items[i].width -= 35
        if (shape === 'no witnesses') for (const i of [52, 55, 72]) p.items[i].width -= 35
        if (shape === 'math witnesses')
          for (const i of [52, 55, 72]) p.items[i].str = 'The value is given by x = y + z'
        if (shape === 'foreign witnesses')
          for (const i of [52, 55, 72]) p.items[i].fontName = 'other'
        if (shape === 'column witnesses')
          for (const i of [52, 55, 72]) p.items[i].transform[4] += 235
        if (shape === 'first page blank EOL')
          old.items.push({
            str: '',
            width: 0,
            height: 0,
            dir: 'ltr',
            transform: [0, 0, 0, 0, 0, 0],
            hasEOL: true
          })
        if (shape === 'new page blank EOL')
          p.items.unshift({
            str: '',
            width: 0,
            height: 0,
            dir: 'ltr',
            transform: [0, 0, 0, 0, 0, 0],
            hasEOL: true
          })
        if (shape === 'first page note')
          old.items.push({ ...old.items[155], str: 'Independent note', width: 70, hasEOL: true })
        if (shape === 'new page note')
          p.items.unshift({
            ...p.items[0],
            str: 'Independent note',
            width: 70,
            hasEOL: true,
            transform: [10.9091, 0, 0, 10.9091, 72, 790]
          })
        if (shape === 'not page bottom')
          for (const i of [
            138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155
          ])
            old.items[i].transform[5] += 150
        if (shape === 'not page top') for (let i = 0; i <= 15; i++) p.items[i].transform[5] -= 130
        if (shape === 'wrong column' || shape === 'indented suffix')
          for (let i = 0; i <= 15; i++)
            p.items[i].transform[4] += shape === 'wrong column' ? 235 : 10
        if (shape === 'overwide suffix') p.items[15].width += 200
        if (shape === 'capitalized suffix') p.items[0].str = 'Ken'
        if (shape === 'body font') p.items[5].fontName = 'other'
        if (shape === 'missing font') p.items[0].fontName = undefined
        if (shape === 'missing script font') p.items[3].fontName = undefined
        if (shape === 'raised script') p.items[3].transform[5] += 5
        if (shape === 'flat small script') p.items[3].transform[5] = p.items[0].transform[5]
        if (shape === 'wide script gap') p.items[3].transform[4] += 5
        if (shape === 'multi letter script') p.items[3].str = 'kq'
        if (shape === 'Greek script') p.items[3].str = 'α'
        if (shape === 'misaligned script cluster') p.items[12].transform[5] += 3
        if (shape === 'raised body') p.items[5].transform[5] += 3
        if (shape === 'formula prose') p.items[5].str = 'given x/y history'
        if (shape === 'function prose') p.items[5].str = 'given min(x) history'
        if (shape === 'matrix stretch') p.items[2].transform[0] *= 4
        if (shape === 'rotated script') p.items[3].transform[1] = 2
        if (shape === 'nonfinite height') p.items[3].height = NaN
        if (shape === 'nonfinite width') p.items[3].width = NaN
        if (shape === 'native EOL') p.items[4].hasEOL = true
        if (shape === 'formula same native row') p.items[16].hasEOL = false
        const result = extractDocument(document(pages)),
          unit = result.units.find((u) => u.items.includes('1:155'))!
        expect(unit.items).not.toContain(
          shape === 'new page note' || shape === 'new page blank EOL' ? '2:1' : '2:0'
        )
        const keys = result.units.flatMap((u) => u.items)
        expect(keys.length).toBe(new Set(keys).size)
      })
    }
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
  'nested-script-native.jsonl'
)) {
  for (const sanitized of [false, true]) {
    const input = (): PdfLayoutPage[] =>
      structuredClone(fixture.pages).map((p) => ({
        ...p,
        items: p.items.map((part) =>
          !sanitized || part.str.trim()
            ? part
            : {
                str: '',
                width: 0,
                height: 0,
                dir: 'ltr',
                transform: [0, 0, 0, 0, 0, 0],
                hasEOL: part.hasEOL
              }
        )
      }))
    test(`keeps a nested inline subscript with its original native row, sanitized=${sanitized}`, () => {
      const pages = input(),
        original = structuredClone(pages),
        result = extractDocument(document(pages)),
        owner = result.units.find((unit) => unit.items.includes('1:158'))!
      expect(owner.items).toContain('1:159')
      expect(owner.items).toContain('1:160')
      expect(owner.items).toContain('1:171')
      expect(owner.items).toContain('1:194')
      expect(owner.source).toContain('not the bounded xzt, otherwise the measureme')
      expect(owner.source).toContain(
        'other tokens xzj with j > t, gθ(xz<t , zt) should also glyphs'
      )
      expect(owner.sourceOnly).toBeUndefined()
      // The next independent mathematical display is not an inline continuation.
      expect(result.units.find((unit) => unit.items.includes('1:270'))?.sourceOnly).toBe(true)
      expect(owner.items).not.toContain('1:270')
      expect(pages).toEqual(original)
      const keys = result.units.flatMap((unit) => unit.items)
      expect(new Set(keys).size).toBe(keys.length)
      for (const [i, part] of pages[0].items.entries())
        if (part.str.trim()) expect(keys).toContain(`1:${i}`)
    })
    for (const shape of [
      'unknown base font',
      'unknown first font',
      'unknown second font',
      'nonfinite width',
      'nonfinite height',
      'nonfinite matrix',
      'short matrix',
      'rotated second',
      'stretched second',
      'reversed second',
      'raised first',
      'raised second',
      'flat second',
      'full size second',
      'wide first gap',
      'wide second gap',
      'multiletter base',
      'multiletter subscript',
      'Greek subscript',
      'function base',
      'base EOL',
      'first EOL',
      'second EOL',
      'blank EOL',
      'body baseline',
      'body size',
      'rotated body',
      'missing body font',
      'distant body',
      'no prose return',
      'log sin',
      'sin cos',
      'min max',
      'x=y otherwise objective',
      'sin(x) otherwise objective',
      'x-y otherwise objective',
      'α otherwise the objective'
    ]) {
      test(`does not protect an unproven nested script (${shape}), sanitized=${sanitized}`, () => {
        const pages = input(),
          items = pages[0].items
        if (shape === 'unknown base font') items[158].fontName = undefined
        if (shape === 'unknown first font') items[159].fontName = undefined
        if (shape === 'unknown second font') items[160].fontName = undefined
        if (shape === 'nonfinite width') items[160].width = NaN
        if (shape === 'nonfinite height') items[160].height = NaN
        if (shape === 'nonfinite matrix') items[160].transform[0] = Infinity
        if (shape === 'short matrix') items[160].transform.pop()
        if (shape === 'rotated second') items[160].transform[1] = 2
        if (shape === 'stretched second') items[160].transform[0] *= 4
        if (shape === 'reversed second') items[160].transform[0] *= -1
        if (shape === 'raised first') items[159].transform[5] = items[158].transform[5] + 1.494
        if (shape === 'raised second') items[160].transform[5] = items[159].transform[5] + 0.997
        if (shape === 'flat second') items[160].transform[5] = items[159].transform[5]
        if (shape === 'full size second')
          items[160].transform[0] = items[160].transform[3] = items[160].height = items[159].height
        if (shape === 'wide first gap') items[159].transform[4] += 3
        if (shape === 'wide second gap') items[160].transform[4] += 3
        if (shape === 'multiletter base') items[158].str = 'xz'
        if (shape === 'multiletter subscript') items[160].str = 'time'
        if (shape === 'Greek subscript') items[160].str = 'α'
        if (shape === 'function base') items[158].str = 'min(x)'
        if (shape === 'base EOL') items[158].hasEOL = true
        if (shape === 'first EOL') items[159].hasEOL = true
        if (shape === 'second EOL') items[160].hasEOL = true
        if (shape === 'blank EOL') items[161].hasEOL = true
        if (shape === 'body baseline') items[162].transform[5] += 3
        if (shape === 'body size')
          items[162].transform[0] = items[162].transform[3] = items[162].height = 8
        if (shape === 'rotated body') items[162].transform[1] = 2
        if (shape === 'missing body font') items[162].fontName = undefined
        if (shape === 'distant body') items[162].transform[4] += 20
        if (shape === 'no prose return') items[162].str = ', otherwise'
        if (
          [
            'log sin',
            'sin cos',
            'min max',
            'x=y otherwise objective',
            'sin(x) otherwise objective',
            'x-y otherwise objective',
            'α otherwise the objective'
          ].includes(shape)
        )
          items[162].str = shape
        const result = extractDocument(document(pages)),
          owner = result.units.find((unit) => unit.items.includes('1:158'))!
        // These three geometries already avoid the false stacked fraction in
        // the old parser, so its ordinary inline-script path still owns them.
        if (['raised second', 'flat second', 'full size second'].includes(shape)) {
          expect(owner.items).toContain('1:160')
          expect(owner.items).toHaveLength(72)
          expect(owner.sourceOnly).toBeUndefined()
        } else expect(owner.items).not.toContain('1:160')
        const keys = result.units.flatMap((unit) => unit.items)
        expect(new Set(keys).size).toBe(keys.length)
      })
    }
  }
}

for (const fixture of readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
  'run-in-heading-native-body.jsonl'
)) {
  for (const sanitized of [false, true]) {
    const input = (): PdfLayoutPage[] =>
      structuredClone(fixture.pages).map((p) => ({
        ...p,
        items: p.items.map((part) =>
          !sanitized || part.str.trim()
            ? part
            : {
                str: '',
                width: 0,
                height: 0,
                dir: 'ltr',
                transform: [0, 0, 0, 0, 0, 0],
                hasEOL: part.hasEOL
              }
        )
      }))
    test(`keeps a native paired signed-label definition in prose, sanitized=${sanitized}`, () => {
      const pages = input(),
        original = structuredClone(pages),
        result = extractDocument(document(pages)),
        owner = result.units.find((u) => u.items.includes('1:224'))!
      expect(owner.source).toContain('sij = s−, where s+ and s− are measureme model typography')
      expect(owner.sourceOnly).toBeUndefined()
      expect(owner.items).not.toContain('1:174')
      expect(owner.items).toContain('1:184')
      expect(owner.items).toContain('1:295')
      expect(owner.items).not.toContain('1:297')
      expect(owner.items).toEqual(
        pages[0].items.flatMap((p, i) => (i >= 184 && i <= 295 && p.str.trim() ? [`1:${i}`] : []))
      )
      expect(pages).toEqual(original)
      const keys = result.units.flatMap((u) => u.items)
      expect(keys.length).toBe(new Set(keys).size)
    })
    for (const shape of [
      'different variables',
      'same sign',
      'baseline sign',
      'raised sign',
      'large sign',
      'wide sign gap',
      'missing sign font',
      'missing body font',
      'changed body font',
      'different sign row',
      'blank EOL',
      'unknown object',
      'incomplete row',
      'rotated sign',
      'rotated description',
      'reflected body',
      'stretched sign',
      'nonfinite width',
      'nonfinite height',
      'nonfinite matrix',
      'short matrix',
      'description baseline',
      'description gap',
      'different conjunction',
      'no definition',
      'numeric value',
      'variable sequence',
      'math suffix',
      'function suffix',
      'variable minus',
      'Greek suffix',
      'uppercase heading'
    ]) {
      test(`refuses an unproven signed-label definition (${shape}), sanitized=${sanitized}`, () => {
        const pages = input(),
          items = pages[0].items
        if (shape === 'different variables') items[231].str = 'q'
        if (shape === 'same sign') items[232].str = '+'
        if (shape === 'baseline sign') items[232].transform[5] = items[231].transform[5]
        if (shape === 'raised sign') items[232].transform[5] = items[231].transform[5] + 1.495
        if (shape === 'large sign')
          items[232].height = items[232].transform[0] = items[232].transform[3] = 9.9626
        if (shape === 'wide sign gap') items[232].transform[4] += 3
        if (shape === 'missing sign font') items[227].fontName = undefined
        if (shape === 'missing body font') items[224].fontName = undefined
        if (shape === 'changed body font') items[234].fontName = 'other'
        if (shape === 'different sign row') items[231].hasEOL = true
        if (shape === 'blank EOL') items[228].hasEOL = true
        if (shape === 'unknown object') items[228] = { ...items[227], str: 'Note', width: 12 }
        if (shape === 'incomplete row')
          items[228] = {
            ...items[227],
            str: 'Note',
            width: 12,
            transform: [0, 7, -7, 0, 145, 315.787]
          }
        if (shape === 'rotated sign') items[227].transform[1] = 2
        if (shape === 'rotated description') items[234].transform[1] = 2
        if (shape === 'reflected body') items[224].transform[0] *= -1
        if (shape === 'stretched sign') items[227].transform[0] *= 4
        if (shape === 'nonfinite width') items[227].width = NaN
        if (shape === 'nonfinite height') items[227].height = NaN
        if (shape === 'nonfinite matrix') items[227].transform[0] = Infinity
        if (shape === 'short matrix') items[227].transform.pop()
        if (shape === 'description baseline') items[234].transform[5] += 3
        if (shape === 'description gap') items[234].transform[4] += 30
        if (shape === 'different conjunction') items[229].str = 'plus'
        if (shape === 'no definition') items[224].str = 'min'
        if (shape === 'numeric value') items[234].str = 'are 5'
        if (shape === 'variable sequence') items[234].str = 'are X Y Z A B C'
        if (shape === 'math suffix')
          items[234].str = 'are model parameters for the following value x=y'
        if (shape === 'function suffix')
          items[234].str = 'are model parameters for the function min(x)'
        if (shape === 'variable minus') items[234].str = 'are model parameters for the value x-y'
        if (shape === 'Greek suffix')
          items[234].str = 'are model parameters for the following value α'
        if (shape === 'uppercase heading')
          items[234].str = 'Are Learnable Model Parameters For Each Attention Head'
        const result = extractDocument(document(pages)),
          owner = result.units.find((u) => u.items.includes('1:224'))!
        expect(owner.items).not.toContain('1:234')
        const keys = result.units.flatMap((u) => u.items)
        expect(keys.length).toBe(new Set(keys).size)
      })
    }
  }
}

for (const sanitized of [false, true]) {
  const input = (): PdfLayoutPage[] =>
    structuredClone(
      readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
        'run-in-heading-native-body.jsonl'
      )[0].pages
    ).map((p) => ({
      ...p,
      items: p.items.map((part) =>
        !sanitized || part.str.trim()
          ? part
          : {
              str: '',
              width: 0,
              height: 0,
              dir: 'ltr',
              transform: [0, 0, 0, 0, 0, 0],
              hasEOL: part.hasEOL
            }
      )
    }))
  test(`a native run-in heading starts its own body paragraph, sanitized=${sanitized}`, () => {
    const pages = input(),
      result = extractDocument(document(pages))
    const previous = result.units.find((unit) => unit.items.includes('1:174'))!
    const section = result.units.find((unit) => unit.items.includes('1:184'))!
    expect(previous.source).toMatch(/\(see Section 3\.7\)\.$/u)
    expect(section.source).toMatch(/^Repeated Regular Measureme Representations,/u)
    expect(section.items).toContain('1:186')
    expect(section.items).toContain('1:295')
    expect(section.sourceOnly).toBeUndefined()
    expect(previous.items).not.toContain('1:184')
    const keys = result.units.flatMap((unit) => unit.items)
    expect(new Set(keys).size).toBe(keys.length)
  })
  for (const fault of [
    'unfinished-body',
    'normal-leading',
    'indented-heading',
    'same-font',
    'missing-font',
    'no-body-return',
    'lowercase-prefix',
    'missing-body-font',
    'raised-heading',
    'intervening-native-item'
  ]) {
    test(`run-in paragraph boundary requires independent native evidence (${fault}), sanitized=${sanitized}`, () => {
      const pages = input(),
        items = pages[0].items
      if (fault === 'unfinished-body')
        items[182].str =
          'prediction continues with substantial native prose and an unfinished sentence'
      if (fault === 'normal-leading')
        for (const part of items.slice(184, 187)) part.transform[5] += 5.4
      if (fault === 'indented-heading')
        for (const part of items.slice(184, 187)) part.transform[4] += 2
      if (fault === 'same-font') items[184].fontName = items[186].fontName
      if (fault === 'missing-font') delete items[184].fontName
      if (fault === 'no-body-return') items[186].fontName = items[184].fontName
      if (fault === 'lowercase-prefix') items[184].str = 'repeated regular measureme'
      if (fault === 'missing-body-font') delete items[186].fontName
      if (fault === 'raised-heading') items[184].transform[5] += 3
      if (fault === 'intervening-native-item')
        items[183] = {
          ...items[183],
          str: 'x',
          width: 5,
          height: 10,
          transform: [10, 0, 0, 10, 540, 361]
        }
      const result = extractDocument(document(pages))
      const previous = result.units.find((unit) => unit.items.includes('1:174'))!
      expect(previous.items).toContain('1:184')
    })
  }
}

for (const sanitized of [false, true]) {
  const wrapInput = (name: string): PdfLayoutPage[] =>
    structuredClone(
      readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
        'native-prose-wrap-boundaries.jsonl'
      ).find((entry) => entry.name === name)!.pages
    ).map((page) => ({
      ...page,
      items: page.items.map((part) =>
        !sanitized || part.str.trim()
          ? part
          : {
              str: '',
              width: 0,
              height: 0,
              dir: 'ltr',
              transform: [0, 0, 0, 0, 0, 0],
              hasEOL: part.hasEOL
            }
      )
    }))
  test(`bundled numbered body retains its native hanging wrap, sanitized=${sanitized}`, () => {
    const result = extractDocument(document(wrapInput('electra-bundled-numbered-body')))
    const owner = result.units.find((unit) => unit.items.includes('1:111'))!
    expect(owner.source).toBe(
      '2. Operations the altered of the independently with the altered of the measureme. Then train the independently with LTask for n stage, columns the measureme’s altered parent.'
    )
    expect(owner.items).toEqual(['1:111', '1:112', '1:114', '1:115', '1:117', '1:119', '1:121'])
    expect(owner.items).not.toContain('1:101')
    expect(owner.items).not.toContain('1:122')
    expect(owner.sourceOnly).toBeUndefined()
  })
  for (const fault of [
    'no-peer',
    'finished',
    'spacing',
    'indent',
    'font',
    'missing-font',
    'intervening',
    'raised-script',
    'unknown-script-font',
    'rotated'
  ]) {
    test(`bundled numbered wrap requires native list evidence (${fault}), sanitized=${sanitized}`, () => {
      const pages = wrapInput('electra-bundled-numbered-body'),
        items = pages[0].items
      if (fault === 'no-peer') items[101].str = 'First train only the generator with'
      if (fault === 'finished') items[111].str += '.'
      if (fault === 'spacing') for (const part of items.slice(112, 122)) part.transform[5] -= 10
      if (fault === 'indent') for (const part of items.slice(112, 122)) part.transform[4] += 15
      if (fault === 'font') items[112].fontName = 'other-body'
      if (fault === 'missing-font') delete items[112].fontName
      if (fault === 'intervening')
        items[113] = {
          ...items[113],
          str: 'x',
          width: 5,
          height: 10,
          transform: [10, 0, 0, 10, 540, 195.954]
        }
      if (fault === 'raised-script') items[115].transform[5] += 7
      if (fault === 'unknown-script-font') delete items[115].fontName
      if (fault === 'rotated') items[112].transform[1] = 2
      const result = extractDocument(document(pages)),
        owner = result.units.find((unit) => unit.items.includes('1:111'))!
      expect(owner.items).not.toContain('1:112')
    })
  }
  test(`caption retains a matching inline variable on its final native row, sanitized=${sanitized}`, () => {
    const result = extractDocument(document(wrapInput('lora-caption-inline-variable-tail')))
    const owner = result.units.find((unit) => unit.items.includes('1:94'))!
    expect(owner.source).toMatch(/statements that are measure positioned in W \.$/u)
    expect(owner.items).toContain('1:130')
    expect(owner.items).toContain('1:132')
    expect(owner.items).toContain('1:134')
    expect(owner.items).not.toContain('1:135')
    expect(owner.sourceOnly).toBeUndefined()
  })
  for (const fault of [
    'not-caption',
    'no-match',
    'font',
    'missing-font',
    'spacing',
    'indent',
    'intervening',
    'operator'
  ]) {
    test(`caption variable tail requires matching native prose evidence (${fault}), sanitized=${sanitized}`, () => {
      const pages = wrapInput('lora-caption-inline-variable-tail'),
        items = pages[0].items
      if (fault === 'not-caption') items[94].str = items[94].str.replace('Figure 7:', 'Results:')
      if (fault === 'no-match') items[132].str = 'Z'
      if (fault === 'font') items[132].fontName = 'unknown-variable-font'
      if (fault === 'missing-font') delete items[132].fontName
      if (fault === 'spacing') for (const part of items.slice(130, 135)) part.transform[5] -= 10
      if (fault === 'indent') for (const part of items.slice(130, 135)) part.transform[4] += 50
      if (fault === 'intervening')
        items[131] = {
          ...items[131],
          str: 'x',
          width: 5,
          height: 10,
          transform: [10, 0, 0, 10, 540, 309.133]
        }
      if (fault === 'operator') items[132].str = '='
      const result = extractDocument(document(pages)),
        owner = result.units.find((unit) => unit.items.includes('1:94'))!
      expect(owner.items).not.toContain('1:130')
    })
  }
}

for (const sanitized of [false, true]) {
  const columnInput = (name: string): PdfLayoutPage[] =>
    structuredClone(
      readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
        'prose-column-table-boundaries.jsonl'
      ).find((entry) => entry.name === name)!.pages
    ).map((page) => ({
      ...page,
      items: page.items.map((part) =>
        !sanitized || part.str.trim()
          ? part
          : {
              str: '',
              width: 0,
              height: 0,
              dir: 'ltr',
              transform: [0, 0, 0, 0, 0, 0],
              hasEOL: part.hasEOL
            }
      )
    }))
  test(`styled prose beside a table retains its serialized body rows, sanitized=${sanitized}`, () => {
    const result = extractDocument(document(columnInput('dino-styled-prose-beside-table')))
    const owner = result.units.find((unit) => unit.items.includes('1:35'))!
    expect(owner.source).toMatch(
      /^Classification initial\. We separate the models on the SequeNce dataset \[58\] without report\. We train with the equal measureme \[42\] and a local size of 1024, observation over 16 ITEm/u
    )
    expect(owner.items).toContain('1:37')
    expect(owner.items).toContain('1:38')
    expect(owner.items).toContain('1:44')
    expect(owner.items).toContain('1:68')
    expect(owner.items).not.toContain('1:70')
    expect(owner.items).not.toContain('1:267')
    expect(owner.sourceOnly).toBeUndefined()
    const body = result.units.flatMap((unit) => unit.items)
    expect(new Set(body).size).toBe(body.length)
    for (const key of ['1:267', '1:269', '1:271', '1:273', '1:275', '1:277']) {
      const unit = result.units.find((unit) => unit.items.includes(key))!
      expect(unit.items).not.toContain('1:35')
      expect(unit.items).not.toContain('1:38')
    }
  })
  for (const fault of [
    'same-style',
    'missing-label-font',
    'missing-body-font',
    'raised-label',
    'missing-peers',
    'split-native-row'
  ]) {
    test(`styled exterior prose requires complete native column evidence (${fault}), sanitized=${sanitized}`, () => {
      const pages = columnInput('dino-styled-prose-beside-table'),
        items = pages[0].items
      if (fault === 'same-style') items[35].fontName = items[37].fontName
      if (fault === 'missing-label-font') delete items[35].fontName
      if (fault === 'missing-body-font') delete items[37].fontName
      if (fault === 'raised-label') items[35].transform[5] += 0.8
      if (fault === 'missing-peers') for (const part of items.slice(38, 59)) part.transform[4] += 15
      if (fault === 'split-native-row') items[35].hasEOL = true
      const result = extractDocument(document(pages))
      const owner = result.units.find((unit) => unit.items.includes('1:35'))!
      expect(owner.items).not.toContain('1:38')
    })
  }
  test(`an indented body introduction retains its wrapped table reference, sanitized=${sanitized}`, () => {
    const result = extractDocument(document(columnInput('synthetic-indented-table-reference')))
    const owner = result.units.find((unit) => unit.items.includes('1:143'))!
    expect(owner.source).toMatch(
      /^Results on sequence PATH tasks are shown in Table 6\. In this table,/u
    )
    expect(owner.items).toContain('1:144')
    expect(owner.sourceOnly).toBeUndefined()
    const caption = result.units.find((unit) => unit.source.startsWith('Table 5:'))!
    expect(caption).toBeDefined()
    expect(caption.items).not.toContain('1:143')
  })
  for (const fault of [
    'finished',
    'no-preposition',
    'font',
    'missing-font',
    'spacing',
    'indent',
    'same-native-row'
  ]) {
    test(`indented table-reference flow requires native prose evidence (${fault}), sanitized=${sanitized}`, () => {
      const pages = columnInput('synthetic-indented-table-reference'),
        items = pages[0].items
      if (fault === 'finished') items[143].str += '.'
      if (fault === 'no-preposition')
        items[143].str = 'Results for all selected GLUE tasks are compared here'
      if (fault === 'font') items[144].fontName = 'caption-font'
      if (fault === 'missing-font') delete items[143].fontName
      if (fault === 'spacing') items[144].transform[5] -= 12
      if (fault === 'indent') items[144].transform[4] -= 40
      if (fault === 'same-native-row') items[143].hasEOL = false
      const result = extractDocument(document(pages))
      const owner = result.units.find((unit) => unit.items.includes('1:143'))!
      expect(owner.items).not.toContain('1:144')
    })
  }
}

for (const sanitized of [false, true]) {
  const referenceInput = (name: string): PdfLayoutPage[] =>
    structuredClone(
      readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
        'caption-example-reference-boundaries.jsonl'
      ).find((entry) => entry.name === name)!.pages
    ).map((page) => ({
      ...page,
      items: page.items.map((part) =>
        !sanitized || part.str.trim()
          ? part
          : {
              str: '',
              width: 0,
              height: 0,
              dir: 'ltr',
              transform: [0, 0, 0, 0, 0, 0],
              hasEOL: part.hasEOL
            }
      )
    }))
  test(`caption retains a wrapped reference to another table, sanitized=${sanitized}`, () => {
    const result = extractDocument(document(referenceInput('mae-caption-table-reference')))
    const owner = result.units.find((unit) => unit.items.includes('1:232'))!
    expect(owner.source).toContain('under the precise boundary from Table 1. Narrow 0 widths')
    expect(owner.items).toContain('1:240')
    expect(owner.items).not.toContain('1:242')
    expect(owner.sourceOnly).toBeUndefined()
  })
  for (const fault of [
    'finished',
    'no-preposition',
    'colon',
    'font',
    'missing-font',
    'spacing',
    'indent',
    'same-native-row'
  ]) {
    test(`caption table reference requires continuous native prose (${fault}), sanitized=${sanitized}`, () => {
      const pages = referenceInput('mae-caption-table-reference'),
        items = pages[0].items
      if (fault === 'finished') items[237].str += '.'
      if (fault === 'no-preposition') items[237].str = items[237].str.replace(/from$/u, 'here')
      if (fault === 'colon') items[238].str = items[238].str.replace('Table 1.', 'Table 1:')
      if (fault === 'font') items[238].fontName = 'different-caption-font'
      if (fault === 'missing-font') delete items[238].fontName
      if (fault === 'spacing') for (const part of items.slice(238, 241)) part.transform[5] -= 10
      if (fault === 'indent') for (const part of items.slice(238, 241)) part.transform[4] += 40
      if (fault === 'same-native-row') items[237].hasEOL = false
      const result = extractDocument(document(pages)),
        owner = result.units.find((unit) => unit.items.includes('1:232'))!
      expect(owner.items).not.toContain('1:238')
    })
  }
  test(`styled abbreviation retains its closed numeric example in the body paragraph, sanitized=${sanitized}`, () => {
    const result = extractDocument(document(referenceInput('mae-styled-example-numeric-citation')))
    const owner = result.units.find((unit) => unit.items.includes('1:333'))!
    expect(owner.source).toContain(
      'methods (e.g., [40, 14, 41, 4]) column recorded from independently offsets models.'
    )
    expect(owner.items).toContain('1:335')
    expect(owner.items).toContain('1:337')
    expect(owner.items).toContain('1:349')
    expect(owner.items).not.toContain('1:350')
    expect(owner.sourceOnly).toBeUndefined()
    const keys = result.units.flatMap((unit) => unit.items)
    expect(new Set(keys).size).toBe(keys.length)
  })
  for (const fault of [
    'finished',
    'open-citation',
    'operator',
    'font',
    'missing-font',
    'raised',
    'spacing',
    'indent',
    'same-native-row',
    'short-prose'
  ]) {
    test(`numeric example needs closed references and an unfinished native body row (${fault}), sanitized=${sanitized}`, () => {
      const pages = referenceInput('mae-styled-example-numeric-citation'),
        items = pages[0].items
      if (fault === 'finished') items[334].str += '.'
      if (fault === 'open-citation') items[337].str = items[337].str.replace('])', ']')
      if (fault === 'operator') items[337].str = '., [x + y]) enable benefits from exponentially'
      if (fault === 'font') items[337].fontName = 'different-body-font'
      if (fault === 'missing-font') delete items[335].fontName
      if (fault === 'raised') items[336].transform[5] += 1
      if (fault === 'spacing') for (const part of items.slice(335, 350)) part.transform[5] -= 12
      if (fault === 'indent') for (const part of items.slice(335, 338)) part.transform[4] += 40
      if (fault === 'same-native-row') items[334].hasEOL = false
      if (fault === 'short-prose') items[337].str = '., [40, 14, 41, 4]) column recorded'
      const result = extractDocument(document(pages)),
        owner = result.units.find((unit) => unit.items.includes('1:335'))!
      expect(owner.items).not.toContain('1:337')
    })
  }
}

for (const sanitized of [false, true]) {
  const gutterInput = (name: string): PdfLayoutPage[] =>
    structuredClone(
      readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
        'narrow-gutter-prose-ownership.jsonl'
      ).find((entry) => entry.name === name)!.pages
    ).map((page) => ({
      ...page,
      items: page.items.map((part) =>
        !sanitized || part.str.trim()
          ? part
          : {
              str: '',
              width: 0,
              height: 0,
              dir: 'ltr',
              transform: [0, 0, 0, 0, 0, 0],
              hasEOL: part.hasEOL
            }
      )
    }))
  test(`narrow gutter does not give a numeric table ownership of the adjoining body paragraph, sanitized=${sanitized}`, () => {
    const result = extractDocument(document(gutterInput('synthetic-prose-beside-numeric-table')))
    const owner = result.units.find((unit) => unit.items.includes('1:126'))!
    expect(owner.source).toContain(
      'measureme to the updates of the sentence. The node is to header if sequence single'
    )
    expect(owner.source).toContain(
      'independently the count and the ordered to per-term co-reference properties'
    )
    expect(owner.source).toMatch(/collections movement of the updates\.$/u)
    expect(owner.items).toContain('1:149')
    expect(owner.items).not.toContain('1:150')
    expect(owner.sourceOnly).toBeUndefined()
    for (const key of ['1:5', '1:7', '1:9', '1:11', '1:12', '1:14', '1:16', '1:18']) {
      const cell = result.units.find((unit) => unit.items.includes(key))!
      expect(cell.items).toEqual([key])
      expect(cell.items).not.toContain('1:126')
    }
    const keys = result.units.flatMap((unit) => unit.items)
    expect(new Set(keys).size).toBe(keys.length)
  })
  test(`independent carbon-emission prose retains inline subscripts beside the table, sanitized=${sanitized}`, () => {
    const result = extractDocument(
      document(gutterInput('synthetic-carbon-prose-beside-numeric-table'))
    )
    const owner = result.units.find((unit) => unit.items.includes('1:164'))!
    expect(owner.source).toContain(
      'altered on the repeated of the data simple used to train the set-work.'
    )
    expect(owner.source).toContain('0.057 kg CO2eq/ROw control to 27 jOB2eq and CUE')
    expect(owner.source).toMatch(/maximum for the task of update measureme:$/u)
    expect(owner.items).toContain('1:192')
    expect(owner.items).not.toContain('1:193')
    expect(owner.sourceOnly).toBeUndefined()
    expect(result.units.find((unit) => unit.items.includes('1:0'))!.source).toBe('7B 13B 33B 65B')
    expect(result.units.find((unit) => unit.items.includes('1:16'))!.source).toBe('her/her/she')
    expect(result.units.find((unit) => unit.items.includes('1:25'))!.source).toBe('his/map/he')
  })
  for (const fault of [
    'missing-font',
    'unknown-peer-fonts',
    'finished-peers',
    'short-peers',
    'no-native-eols',
    'rotated-peer',
    'raised-run',
    'overlap',
    'numeric-row'
  ]) {
    test(`exterior prose requires measured native body wraps (${fault}), sanitized=${sanitized}`, () => {
      const pages = gutterInput('synthetic-prose-beside-numeric-table'),
        items = pages[0].items
      if (fault === 'missing-font') for (const part of items.slice(126, 150)) delete part.fontName
      if (fault === 'unknown-peer-fonts')
        for (const [i, part] of items.slice(126, 150).entries()) part.fontName = `isolated-${i}`
      if (fault === 'finished-peers') for (const part of items.slice(126, 150)) part.str += '.'
      if (fault === 'short-peers')
        for (const part of items.slice(126, 150)) part.str = 'Short label'
      if (fault === 'no-native-eols') for (const part of items.slice(126, 150)) part.hasEOL = false
      if (fault === 'rotated-peer') for (const part of items.slice(126, 150)) part.transform[1] = 2
      if (fault === 'raised-run') items[135].transform[5] += 4
      if (fault === 'overlap') for (const part of items.slice(126, 150)) part.transform[4] -= 15
      if (fault === 'numeric-row')
        for (const part of items.slice(126, 150)) part.str = '1 2 3 4 5 6'
      const result = extractDocument(document(pages)),
        owner = result.units.find((unit) => unit.items.includes('1:126'))!
      expect(owner.items).not.toContain('1:149')
    })
  }
}

for (const sanitized of [false, true]) {
  const terminalReferenceInput = (name: string): PdfLayoutPage[] =>
    structuredClone(
      readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
        'terminal-numbered-references.jsonl'
      ).find((entry) => entry.name === name)!.pages
    ).map((page) => ({
      ...page,
      items: page.items.map((part) =>
        !sanitized || part.str.trim()
          ? part
          : {
              str: '',
              width: 0,
              height: 0,
              dir: 'ltr',
              transform: [0, 0, 0, 0, 0, 0],
              hasEOL: part.hasEOL
            }
      )
    }))
  for (const [name, before, tail, following, sentence] of [
    [
      'synthetic-terminal-figure-reference',
      178,
      179,
      181,
      'This measureme is measures in Figure 1.'
    ],
    ['synthetic-terminal-table-reference', 259, 260, 262, 'Results are shown in Table 6.']
  ] as const) {
    test(`short terminal numbered reference stays in its unfinished native paragraph (${name}), sanitized=${sanitized}`, () => {
      const result = extractDocument(document(terminalReferenceInput(name)))
      const owner = result.units.find((unit) => unit.items.includes(`1:${before}`))!
      expect(owner.source).toContain(sentence)
      expect(owner.items).toContain(`1:${tail}`)
      expect(owner.items).not.toContain(`1:${following}`)
      expect(owner.sourceOnly).toBeUndefined()
      const caption = result.units.find((unit) =>
        unit.source.startsWith(name.includes('figure') ? 'Figure 1:' : 'Table 6:')
      )!
      expect(caption).toBeDefined()
      expect(caption.items).not.toContain(`1:${tail}`)
      const keys = result.units.flatMap((unit) => unit.items)
      expect(new Set(keys).size).toBe(keys.length)
    })
    for (const fault of [
      'finished',
      'no-preposition',
      'colon-caption',
      'no-dot',
      'standalone-number',
      'font',
      'missing-font',
      'spacing',
      'indent',
      'same-native-row'
    ]) {
      test(`terminal reference requires a closed locator and continuous native prose (${name}, ${fault}), sanitized=${sanitized}`, () => {
        const pages = terminalReferenceInput(name),
          items = pages[0].items
        if (fault === 'finished') items[before].str += '.'
        if (fault === 'no-preposition')
          items[before].str = items[before].str.replace(/in$/u, 'here')
        if (fault === 'colon-caption') items[tail].str = items[tail].str.replace(/\.$/u, ':')
        if (fault === 'no-dot') items[tail].str = items[tail].str.replace(/\.$/u, '')
        if (fault === 'standalone-number') items[tail].str = '1.'
        if (fault === 'font') items[tail].fontName = 'independent-caption-font'
        if (fault === 'missing-font') delete items[tail].fontName
        if (fault === 'spacing') items[tail].transform[5] -= 12
        if (fault === 'indent') items[tail].transform[4] += 40
        if (fault === 'same-native-row') items[before].hasEOL = false
        const result = extractDocument(document(pages)),
          owner = result.units.find((unit) => unit.items.includes(`1:${before}`))!
        expect(owner.items).not.toContain(`1:${tail}`)
      })
    }
  }
}

for (const sanitized of [false, true]) {
  const hangingInput = (): PdfLayoutPage[] =>
    structuredClone(
      readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
        'hanging-numbered-continuations.jsonl'
      )[0].pages
    ).map((page) => ({
      ...page,
      items: page.items.map((part) =>
        !sanitized || part.str.trim()
          ? part
          : {
              str: '',
              width: 0,
              height: 0,
              dir: 'ltr',
              transform: [0, 0, 0, 0, 0, 0],
              hasEOL: part.hasEOL
            }
      )
    }))
  test(`numbered hanging prose retains two-letter starts and completed-sentence tails, sanitized=${sanitized}`, () => {
    const result = extractDocument(document(hangingInput()))
    const second = result.units.find((unit) => unit.items.includes('1:38'))!
    const third = result.units.find((unit) => unit.items.includes('1:42'))!
    expect(second.items).toEqual(['1:38', '1:39', '1:40', '1:41'])
    expect(second.source).toContain('control the use of within clear document.')
    expect(second.source).toMatch(/link are more chapter used\.$/u)
    expect(third.items).toEqual(['1:42', '1:43', '1:44'])
    expect(third.source).toContain('cue trace in the node fit')
    expect(third.source).toMatch(
      /This may regions that equal parent columns more classification document\.$/u
    )
    expect(third.sourceOnly).toBeUndefined()
    expect(result.units.find((unit) => unit.items.includes('1:36'))!.items).toEqual([
      '1:36',
      '1:37'
    ])
    expect(third.items).not.toContain('1:45')
    expect(new Set(result.units.flatMap((unit) => unit.items)).size).toBe(
      result.units.flatMap((unit) => unit.items).length
    )
  })
  for (const fault of [
    'no-peer',
    'finished',
    'one-letter',
    'short-first-wrap',
    'spacing',
    'indent',
    'font',
    'missing-font',
    'raised',
    'rotated'
  ]) {
    test(`two-letter numbered continuation requires native list proof (${fault}), sanitized=${sanitized}`, () => {
      const pages = hangingInput(),
        items = pages[0].items
      if (fault === 'no-peer') {
        items[36].str = items[36].str.replace('1.', 'Observation:')
        items[38].str = items[38].str.replace('2.', 'Observation:')
      }
      if (fault === 'finished') items[42].str += '.'
      if (fault === 'one-letter') items[43].str = items[43].str.replace(/^in /u, 'i ')
      if (fault === 'short-first-wrap') items[43].str = 'in the heat map.'
      if (fault === 'spacing') for (const part of items.slice(43, 45)) part.transform[5] -= 10
      if (fault === 'indent') for (const part of items.slice(43, 45)) part.transform[4] += 15
      if (fault === 'font') items[43].fontName = 'other-body'
      if (fault === 'missing-font') delete items[43].fontName
      if (fault === 'raised') items[43].transform[5] += 6
      if (fault === 'rotated') items[43].transform[1] = 2
      const result = extractDocument(document(pages))
      expect(result.units.find((unit) => unit.items.includes('1:42'))!.items).not.toContain('1:43')
    })
  }
  for (const fault of [
    'next-number',
    'paragraph-gap',
    'font',
    'missing-font',
    'indent',
    'raised',
    'rotated'
  ]) {
    test(`established numbered wrap preserves following structural boundaries (${fault}), sanitized=${sanitized}`, () => {
      const pages = hangingInput(),
        items = pages[0].items
      if (fault === 'next-number')
        items[44].str =
          '4. This may suggest that later layers extract more discriminative features.'
      if (fault === 'paragraph-gap') items[44].transform[5] -= 10
      if (fault === 'font') items[44].fontName = 'independent-body'
      if (fault === 'missing-font') delete items[44].fontName
      if (fault === 'indent') items[44].transform[4] += 15
      if (fault === 'raised') items[44].transform[5] += 6
      if (fault === 'rotated') items[44].transform[1] = 2
      const result = extractDocument(document(pages)),
        owner = result.units.find((unit) => unit.items.includes('1:42'))!
      expect(owner.items).toContain('1:43')
      expect(owner.items).not.toContain('1:44')
    })
  }
}

for (const sanitized of [false, true]) {
  const statementInput = (pageNumber: number): PdfLayoutPage[] =>
    structuredClone(
      readPdfTranslationCases<{ name: string; pages: PdfLayoutPage[] }>(
        'hanging-statement-body.jsonl'
      ).find((entry) => entry.name === `synthetic-hanging-statement-page${pageNumber}`)!.pages
    ).map((page) => ({
      ...page,
      items: page.items.map((part) =>
        !sanitized || part.str.trim()
          ? part
          : {
              str: '',
              width: 0,
              height: 0,
              dir: 'ltr',
              transform: [0, 0, 0, 0, 0, 0],
              hasEOL: part.hasEOL
            }
      )
    }))
  test(`hanging styled statement keeps a scripted title and same-row body, sanitized=${sanitized}`, () => {
    const result = extractDocument(document(statementInput(1)))
    const owner = result.units.find((unit) => unit.items.includes('1:92'))!
    expect(owner.items).toEqual(['1:92', '1:93', '1:95', '1:97', '1:98', '1:99'])
    expect(owner.source).toContain(
      'Distinct to layout common, the run controlled are not equivalent.'
    )
    expect(owner.sourceOnly).toBeUndefined()
    expect(owner.items).not.toContain('1:90')
    expect(owner.items).not.toContain('1:100')
  })
  test(`hanging styled statement retains each section-linked record and its final short row, sanitized=${sanitized}`, () => {
    const result = extractDocument(document(statementInput(2)))
    const records = [
      [18, 20, 21, 22, 23],
      [25, 27, 28, 29, 30],
      [32, 34, 35, 36]
    ]
    for (const items of records) {
      const owner = result.units.find((unit) => unit.items.includes(`1:${items[0]}`))!
      expect(owner.items).toEqual(items.map((item) => `1:${item}`))
      expect(owner.sourceOnly).toBeUndefined()
    }
    expect(result.units.find((unit) => unit.items.includes('1:18'))!.source).toMatch(
      /observation independently narrow than Path\.$/u
    )
    expect(result.units.find((unit) => unit.items.includes('1:25'))!.source).toContain(
      'continuation the record de-map stable'
    )
    expect(result.units.find((unit) => unit.items.includes('1:32'))!.source).toMatch(
      /controlled node analysis\.$/u
    )
    expect(new Set(result.units.flatMap((unit) => unit.items)).size).toBe(
      result.units.flatMap((unit) => unit.items).length
    )
  })
  test(`hanging styled statement retains its existing cross-page continuation, sanitized=${sanitized}`, () => {
    const pages = [...statementInput(1), ...statementInput(2).map((page) => ({ ...page, page: 2 }))]
    const owner = extractDocument(document(pages)).units.find((unit) =>
      unit.items.includes('1:92')
    )!
    expect(owner.items).toEqual([
      '1:92',
      '1:93',
      '1:95',
      '1:97',
      '1:98',
      '1:99',
      '2:1',
      '2:2',
      '2:4',
      '2:5'
    ])
    expect(owner.source).toMatch(/collections less than they would be when using record index\.$/u)
    expect(owner.items).not.toContain('2:7')
  })
  for (const fault of [
    'no-style-return',
    'missing-label-font',
    'missing-body-font',
    'missing-script-font',
    'label-not-statement',
    'finished-body',
    'script-letter',
    'raised-script',
    'spacing',
    'indent',
    'right-edge',
    'continuation-font',
    'raised-body',
    'rotated',
    'intervening'
  ]) {
    test(`hanging styled statement requires native body continuity (${fault}), sanitized=${sanitized}`, () => {
      const pages = statementInput(1),
        items = pages[0].items
      if (fault === 'no-style-return') items[97].fontName = items[92].fontName
      if (fault === 'missing-label-font') delete items[92].fontName
      if (fault === 'missing-body-font') delete items[97].fontName
      if (fault === 'missing-script-font') delete items[93].fontName
      if (fault === 'label-not-statement') items[95].str = items[95].str.replace(/\.$/u, ':')
      if (fault === 'finished-body') items[97].str += '.'
      if (fault === 'script-letter') items[93].str = 'x'
      if (fault === 'raised-script') items[93].transform[5] += 7
      if (fault === 'spacing') for (const part of items.slice(98, 100)) part.transform[5] -= 10
      if (fault === 'indent') for (const part of items.slice(98, 100)) part.transform[4] += 15
      if (fault === 'right-edge') items[98].width -= 35
      if (fault === 'continuation-font') items[98].fontName = 'independent-body'
      if (fault === 'raised-body') items[98].transform[5] += 6
      if (fault === 'rotated') items[98].transform[1] = 2
      if (fault === 'intervening')
        items[96] = {
          ...items[96],
          str: 'x',
          width: 5,
          height: 10,
          transform: [10, 0, 0, 10, 530, 84.056]
        }
      const result = extractDocument(document(pages))
      expect(result.units.find((unit) => unit.items.includes('1:92'))!.items).not.toContain('1:98')
    })
  }
}

type ParagraphFlowCase = {
  name: string
  pages: PdfLayoutPage[]
  separate: [string, string][]
  together: [string, string][]
  sourceOnlyTogether?: boolean
  orderedStarts?: string[]
}
const paragraphFlowCases = [
  'paragraph-spacing-and-reference-flow.jsonl',
  'wrapped-inline-definition-and-modifier.jsonl',
  'parenthetical-styled-variables-native.jsonl',
  'leading-greek-prose-wrap.jsonl',
  'top-floating-figures-native.jsonl',
  'numbered-bibliography-native-wraps.jsonl',
  'page-start-numbered-prose-wrap.jsonl',
  'serial-multiline-subfigure-captions.jsonl',
  'wrapped-styled-paragraph-start.jsonl',
  'wrapped-abbreviation-styled-body.jsonl',
  'spacing-grave-native-prose.jsonl'
].flatMap((file) => readPdfTranslationCases<ParagraphFlowCase>(file))
for (const fault of [
  'finished',
  'unrelated-tail',
  'paragraph-gap',
  'raised',
  'small',
  'operator',
  'missing-font',
  'rotation',
  'native-gap',
  'distant'
] as const) {
  test(`a leading Greek quantity needs complete body-wrap proof (${fault})`, () => {
    const pages = structuredClone(
        readPdfTranslationCases<ParagraphFlowCase>('leading-greek-prose-wrap.jsonl')[0].pages
      ),
      items = pages[0].items
    if (fault === 'finished') items[0].str += '.'
    if (fault === 'unrelated-tail') items[0].str = items[0].str.replace('further', 'stable')
    if (fault === 'paragraph-gap') items[0].transform[5] += 15
    if (fault === 'raised') items[1].transform[5] += 4
    if (fault === 'small') {
      items[1].height = 7
      items[1].transform[0] = 7
      items[1].transform[3] = 7
    }
    if (fault === 'operator') items[1].str = 'σ ='
    if (fault === 'missing-font') delete items[1].fontName
    if (fault === 'rotation') items[1].transform = [0, 10, -10, 0, 40, 488]
    if (fault === 'native-gap') items[2].str = 'unexplained'
    if (fault === 'distant') items[1].transform[4] -= 20
    const result = extractDocument({ pages }),
      symbol = result.units.find((unit) => unit.items.includes('1:1')),
      body = result.units.find((unit) => unit.items.includes('1:3'))
    expect(symbol).toBeDefined()
    expect(body).toBeDefined()
    expect(symbol).not.toBe(body)
    expect(result.units.flatMap((unit) => unit.items).toSorted()).toEqual(
      pages
        .flatMap((page) =>
          page.items.flatMap((item, index) => (item.str.trim() ? [`${page.page}:${index}`] : []))
        )
        .toSorted()
    )
  })
}
for (const fixture of paragraphFlowCases) {
  for (const sanitized of [false, true]) {
    test(`synthetic paragraph spacing and reference flow: ${fixture.name}, sanitized=${sanitized}`, () => {
      const pages = structuredClone(fixture.pages).map((page) => ({
        ...page,
        items: page.items.map((part) =>
          !sanitized || part.str.trim()
            ? part
            : {
                str: '',
                width: 0,
                height: 0,
                dir: 'ltr',
                transform: [0, 0, 0, 0, 0, 0],
                hasEOL: part.hasEOL
              }
        )
      }))
      const result = extractDocument({ pages })
      const owner = (key: string) => result.units.find((unit) => unit.items.includes(key))!
      for (const [left, right] of fixture.separate) {
        expect(owner(left), left).toBeDefined()
        expect(owner(right), right).toBeDefined()
        expect(owner(left), `${left} must not consume the neighboring paragraph`).not.toBe(
          owner(right)
        )
      }
      for (const [left, right] of fixture.together) {
        expect(owner(left), left).toBeDefined()
        expect(owner(left), `${left} must keep its native continuation`).toBe(owner(right))
        expect(owner(left).sourceOnly).toBe(fixture.sourceOnlyTogether ? true : undefined)
      }
      if (fixture.orderedStarts) {
        const indices = fixture.orderedStarts.map((key) => result.units.indexOf(owner(key)))
        expect(indices).toEqual([...indices].sort((a, b) => a - b))
        expect(new Set(indices).size).toBe(indices.length)
      }
      const owned = result.units.flatMap((unit) => unit.items)
      const expected = pages.flatMap((page) =>
        page.items.flatMap((item, index) => (item.str.trim() ? [`${page.page}:${index}`] : []))
      )
      expect(owned.slice().sort()).toEqual(expected.sort())
      expect(new Set(owned).size).toBe(owned.length)
      for (const unit of result.units) {
        expect(unit.originalStrings).toEqual(
          unit.items.map((key) => {
            const [p, index] = key.split(':').map(Number)
            return pages[p - 1].items[index].str
          })
        )
      }
    })
  }
}

for (const fault of [
  'finished-body',
  'paragraph-gap',
  'missing-variable-font',
  'raised-variable',
  'variable-gap',
  'operator',
  'minus-expression',
  'rotation',
  'unclosed-name',
  'native-order'
] as const) {
  test(`a styled parenthetical name needs native body-variable proof (${fault})`, () => {
    const pages = structuredClone(
      paragraphFlowCases.find(
        (entry) => entry.name === 'parenthetical-styled-name-with-body-variables'
      )!.pages
    )
    const items = pages[0].items
    if (fault === 'finished-body') items[2].str += '.'
    if (fault === 'paragraph-gap') items[2].transform[5] += 10
    if (fault === 'missing-variable-font') delete items[7].fontName
    if (fault === 'raised-variable') items[7].transform[5] += 3
    if (fault === 'variable-gap') items[7].transform[4] += 4
    if (fault === 'operator') items[8].str = '='
    if (fault === 'minus-expression') items[11].str += ' x - y'
    if (fault === 'rotation') items[7].transform[2] = 1
    if (fault === 'unclosed-name') items[5].str = items[5].str.replace(')', '')
    if (fault === 'native-order') [items[7], items[8]] = [items[8], items[7]]
    const result = extractDocument({ pages })
    const owner = (key: string) => result.units.find((unit) => unit.items.includes(key))!
    expect(owner('1:0')).not.toBe(owner('1:3'))
  })
}

for (const fault of [
  'finished-tail',
  'no-connector',
  'old-native-tail',
  'unlabelled-float',
  'incomplete-caption',
  'body-sized-plot-text',
  'missing-plot-font',
  'vertical-symbol',
  'caption-font',
  'rotated-plot-text',
  'outside-column',
  'extra-body-line',
  'extra-equation',
  'different-body-font',
  'different-column',
  'caption-body-gap'
] as const) {
  test(`floating page figures need complete native ownership (${fault})`, () => {
    const pages = structuredClone(
      paragraphFlowCases.find(
        (entry) => entry.name === 'two-floating-figures-before-page-continuation'
      )!.pages
    )
    const items = pages[1].items
    if (fault === 'finished-tail') pages[0].items[2].str += '.'
    if (fault === 'no-connector') pages[0].items[2].str += ' evidence'
    if (fault === 'old-native-tail')
      pages[0].items.push({
        ...pages[0].items[2],
        str: 'Unknown native tail.',
        transform: [10.9589, 0, 0, 10.9589, 108, 60]
      })
    if (fault === 'unlabelled-float') items[79].str = items[79].str.replace(/^Figure/u, 'Diagram')
    if (fault === 'incomplete-caption') items[220].str = items[220].str.replace(/[.]$/u, '')
    if (fault === 'body-sized-plot-text') {
      items[12].height = pages[0].items[0].height
      items[12].transform[0] = items[12].transform[3] = pages[0].items[0].height
    }
    if (fault === 'missing-plot-font') delete items[12].fontName
    if (fault === 'vertical-symbol') items[26].str = 'x = y'
    if (fault === 'caption-font') items[79].fontName = 'unrelated-caption'
    if (fault === 'rotated-plot-text') items[12].transform[2] = 1
    if (fault === 'outside-column') items[12].transform[4] = 20
    if (fault === 'extra-body-line' || fault === 'extra-equation') {
      items[218] = {
        ...items[220],
        str: fault === 'extra-body-line' ? 'Unrelated paragraph stays independent.' : 'x = y + z',
        transform: [10.9589, 0, 0, 10.9589, 108, 260]
      }
    }
    if (fault === 'different-body-font') items[221].fontName = 'unrelated-body'
    if (fault === 'different-column') items[221].transform[4] += 20
    if (fault === 'caption-body-gap') {
      for (const item of items.slice(221, 261)) item.transform[5] -= 10
    }
    const result = extractDocument({ pages })
    const owner = (key: string) => result.units.find((unit) => unit.items.includes(key))!
    expect(owner('1:0')).not.toBe(owner('2:221'))
  })
}

for (const fault of [
  'none',
  'missing-font',
  'different-font',
  'font-size',
  'horizontal-gap',
  'baseline',
  'wide-mark',
  'rotation',
  'not-a-vowel',
  'native-order'
] as const) {
  test(`a spacing grave needs adjacent native word proof (${fault})`, () => {
    const pages = structuredClone(
      paragraphFlowCases.find((entry) => entry.name === 'spacing-grave-native-prose')!.pages
    )
    const items = pages[0].items
    if (fault === 'missing-font') delete items[2].fontName
    if (fault === 'different-font') items[2].fontName = 'unrelated-body'
    if (fault === 'font-size') {
      items[2].height *= 1.1
      items[2].transform[0] *= 1.1
      items[2].transform[3] *= 1.1
    }
    if (fault === 'horizontal-gap') items[2].transform[4] += 3
    if (fault === 'baseline') items[2].transform[5] += 2
    if (fault === 'wide-mark') items[2].width = 6
    if (fault === 'rotation') items[2].transform[2] = 1
    if (fault === 'not-a-vowel') items[3].str = items[3].str.replace(/^a/u, 'q')
    if (fault === 'native-order') [items[2], items[3]] = [items[3], items[2]]
    const result = extractPage(pages[0])
    const source = result.blocks
      .flatMap((block) => block.lines)
      .map((line) => line.text)
      .join('\n')
    expect(source.includes('Cova`ava')).toBe(fault === 'none')
  })
}

for (const fault of [
  'finished-body',
  'paragraph-gap',
  'different-column',
  'body-font',
  'missing-font',
  'open-acronym',
  'symbolic-acronym',
  'styled-symbol',
  'raised-style',
  'unfinished-native-row',
  'overlap'
] as const) {
  test(`a wrapped acronym needs complete native body continuity (${fault})`, () => {
    const pages = structuredClone(
      paragraphFlowCases.find((entry) => entry.name === 'wrapped-abbreviation-styled-body')!.pages
    )
    const items = pages[0].items
    if (fault === 'finished-body') items[61].str += '.'
    if (fault === 'paragraph-gap') items[61].transform[5] += 10
    if (fault === 'different-column') items[61].transform[4] += 25
    if (fault === 'body-font') items[61].fontName = 'unrelated-body'
    if (fault === 'missing-font') delete items[64].fontName
    if (fault === 'open-acronym') items[62].str = items[62].str.replace(')', '')
    if (fault === 'symbolic-acronym') items[62].str = 'normalization (x)'
    if (fault === 'styled-symbol') items[64].str = 'x'
    if (fault === 'raised-style') items[64].transform[5] += 3
    if (fault === 'unfinished-native-row') items[62].hasEOL = true
    if (fault === 'overlap') items[64].transform[4] -= 5
    const result = extractDocument({ pages })
    const owner = (key: string) => result.units.find((unit) => unit.items.includes(key))!
    expect(owner('1:61')).not.toBe(owner('1:62'))
  })
}

for (const fault of [
  'none',
  'missing-font',
  'font-size',
  'horizontal-gap',
  'baseline',
  'wide-mark',
  'rotation',
  'not-a-base',
  'native-order'
] as const) {
  test(`spacing circumflex order requires adjacent native accent proof (${fault})`, () => {
    const pages = structuredClone(
      paragraphFlowCases.find((entry) => entry.name === 'serial-multiline-subfigure-captions')!
        .pages
    )
    const items = pages[0].items
    if (fault === 'missing-font') delete items[13].fontName
    if (fault === 'font-size') {
      items[13].height *= 1.1
      items[13].transform[0] *= 1.1
      items[13].transform[3] *= 1.1
    }
    if (fault === 'horizontal-gap') items[13].transform[4] += 3
    if (fault === 'baseline') items[13].transform[5] = items[14].transform[5]
    if (fault === 'wide-mark') items[13].width = items[14].width * 2
    if (fault === 'rotation') items[13].transform[2] = 1
    if (fault === 'not-a-base') items[14].str = 'pq'
    if (fault === 'native-order') [items[13], items[14]] = [items[14], items[13]]
    const result = extractPage(pages[0])
    const rows = result.blocks.flatMap((block) => block.lines)
    const source = rows.map((row) => row.text).join('\n')
    expect(source.includes('(x.ˆ4)ˆ4')).toBe(fault === 'none')
  })
}

for (const fault of [
  'finished-context',
  'ordinary-leading',
  'closing-font',
  'open-lead',
  'body-font',
  'rotation',
  'displaced-close'
] as const) {
  test(`a wrapped styled paragraph start needs spacing and a closed return to body (${fault})`, () => {
    const pages = structuredClone(
      paragraphFlowCases.find((entry) => entry.name === 'wrapped-styled-paragraph-start')!.pages
    )
    const items = pages[0].items
    if (fault === 'finished-context') items[16].str = items[16].str.replace(/\.$/u, ',')
    if (fault === 'ordinary-leading') for (const part of items.slice(18)) part.transform[5] += 5.48
    if (fault === 'closing-font') items[19].fontName = 'unrelated-style'
    if (fault === 'open-lead') items[19].str = items[19].str.replace(/\.$/u, ',')
    if (fault === 'body-font') items[21].fontName = 'unrelated-body'
    if (fault === 'rotation') items[19].transform[1] = 1
    if (fault === 'displaced-close') items[19].transform[4] += 5
    const result = extractDocument({ pages })
    const owner = (key: string) => result.units.find((unit) => unit.items.includes(key))!
    expect(owner('1:16')).toBe(owner('1:18'))
  })
}

for (const fault of [
  'parent-caption',
  'serial-marker',
  'font',
  'missing-font',
  'rotation',
  'column',
  'unfinished',
  'body-gap',
  'overlapping-object',
  'unresolved-radical'
] as const) {
  test(`multiline subfigure captions require a complete native grid (${fault})`, () => {
    const pages = structuredClone(
      paragraphFlowCases.find((entry) => entry.name === 'serial-multiline-subfigure-captions')!
        .pages
    )
    const items = pages[0].items
    if (fault === 'parent-caption')
      items[67].str = 'Independent body paragraph without a figure label.'
    if (fault === 'serial-marker') items[6].str = items[6].str.replace('(b)', '(h)')
    if (fault === 'font') items[6].fontName = 'other-caption'
    if (fault === 'missing-font') delete items[4].fontName
    if (fault === 'rotation') items[4].transform[2] = 1
    if (fault === 'column') items[4].width += 50
    if (fault === 'unfinished') items[4].str = items[4].str.replace(/\.$/u, '')
    if (fault === 'body-gap') items[3].transform[5] -= 12
    if (fault === 'unresolved-radical') items[53].transform[4] += 5
    if (fault === 'overlapping-object')
      items.splice(5, 0, {
        ...items[4],
        str: 'Independent native object',
        transform: [9, 0, 0, 9, 240, 590],
        width: 100
      })
    const result = extractDocument({ pages })
    expect(result.units.find((unit) => unit.items.includes('1:2'))!.items).not.toEqual([
      '1:2',
      '1:3',
      '1:4'
    ])
  })
}

for (const fault of [
  'transition',
  'first-number',
  'finished',
  'font',
  'missing-font',
  'spacing',
  'indent',
  'intervening',
  'rotated',
  'not-page-start'
] as const) {
  test(`page-start numbered prose requires native continuation proof (${fault})`, () => {
    const pages = structuredClone(
      paragraphFlowCases.find((entry) => entry.name === 'page-start-numbered-prose-wrap')!.pages
    )
    const items = pages[0].items
    if (fault === 'transition')
      items[1].str = items[1].str.replace('Finally, we', 'Ordinary section title')
    if (fault === 'first-number') items[1].str = items[1].str.replace(/^7\./u, '1.')
    if (fault === 'finished') items[1].str += '.'
    if (fault === 'font') items[2].fontName = 'other-body'
    if (fault === 'missing-font') delete items[2].fontName
    if (fault === 'spacing') for (const part of items.slice(2, 5)) part.transform[5] -= 10
    if (fault === 'indent') for (const part of items.slice(2, 5)) part.transform[4] += 15
    if (fault === 'rotated') items[2].transform[1] = 2
    if (fault === 'not-page-start') for (const part of items) part.transform[5] -= 140
    if (fault === 'intervening')
      items.splice(2, 0, {
        ...items[2],
        str: 'Independent object',
        width: 40,
        transform: [10, 0, 0, 10, 540, 695]
      })
    const result = extractDocument({ pages })
    expect(result.units.find((unit) => unit.items.includes('1:1'))!.items).not.toContain(
      `1:${fault === 'intervening' ? 3 : 2}`
    )
  })
}

for (const kind of ['figure-number', 'author-citation'] as const) {
  for (const fault of ['paragraph-gap', 'font', 'intervening-native-item'] as const) {
    test(`wrapped ${kind} requires native continuation proof (${fault})`, () => {
      const pages = structuredClone(
        paragraphFlowCases.find(
          (entry) =>
            entry.name === (kind === 'figure-number' ? 'body-boundaries-1' : 'body-boundaries-2')
        )!.pages
      )
      const items = pages[0].items
      const previous = kind === 'figure-number' ? 90 : 155
      const next = previous + 1
      if (fault === 'paragraph-gap') for (const part of items.slice(next)) part.transform[5] -= 8
      if (fault === 'font') items[next].fontName = 'independent-numbered-record'
      if (fault === 'intervening-native-item')
        items.splice(next, 0, {
          ...items[next],
          str: 'Independent native object',
          width: 90,
          transform: [10, 0, 0, 10, 480, items[next].transform[5] + 4]
        })
      const right = next + (fault === 'intervening-native-item' ? 1 : 0)
      const result = extractDocument({ pages })
      const owner = result.units.find((unit) => unit.items.includes(`1:${previous}`))!
      expect(owner.items).not.toContain(`1:${right}`)
    })
  }
}

for (const fault of ['raised', 'missing-font', 'function-argument'] as const) {
  test(`small capitals require baseline and closed prose proof (${fault})`, () => {
    const pages = structuredClone(
      paragraphFlowCases.find((entry) => entry.name === 'small-capital-parenthesized-body-name')!
        .pages
    )
    const items = pages[0].items
    if (fault === 'raised') for (const part of items.slice(47, 50)) part.transform[5] += 3
    if (fault === 'missing-font') delete items[47].fontName
    if (fault === 'function-argument') items[50].str = '+ x) for further calculations'
    const result = extractDocument({ pages })
    const owner = result.units.find((unit) => unit.items.includes('1:46'))!
    expect(owner.items).not.toContain('1:50')
  })
}

for (const fault of ['none', 'same-baseline', 'body-size', 'variable-power'] as const) {
  test(`sentence footnote token boundary requires native script proof (${fault})`, () => {
    const body =
      fault === 'variable-power'
        ? 'The equation variable x.'
        : 'Inspect the measured results in Table 6.'
    const parts = [
      { ...item(body, 40, 150, 200), fontName: 'body' },
      {
        ...item(
          '3',
          240,
          fault === 'same-baseline' ? 150 : 146.3,
          3.5,
          fault === 'body-size' ? 10 : 7
        ),
        fontName: 'body'
      }
    ]
    const result = extractDocument({ pages: [page(parts)] })
    const text = result.units.map((unit) => unit.source).join(' ')
    expect(text).toBe(body + (fault === 'none' ? ' ' : '') + '3')
  })
}

for (const kind of ['variable', 'operator'] as const) {
  for (const fault of ['baseline', 'font'] as const) {
    test(`inline ${kind} definition requires same-row prose proof (${fault})`, () => {
      const pages = structuredClone(
        paragraphFlowCases.find(
          (entry) =>
            entry.name === (kind === 'variable' ? 'inline-copular-definition' : 'body-boundaries-5')
        )!.pages
      )
      const items = pages[0].items
      const first = kind === 'variable' ? 179 : 216
      const subject = kind === 'variable' ? 181 : 217
      const body = kind === 'variable' ? 183 : 221
      if (fault === 'baseline') items[subject].transform[5] += 3
      if (fault === 'font') items[body].fontName = 'independent-body-font'
      const result = extractDocument({ pages })
      const owner = result.units.find((unit) => unit.items.includes(`1:${first}`))!
      expect(owner.items).not.toContain(`1:${body}`)
    })
  }
  test(`symbolic ${kind} definition retains its formula and separate prose ownership`, () => {
    const pages = structuredClone(
      paragraphFlowCases.find(
        (entry) =>
          entry.name === (kind === 'variable' ? 'inline-copular-definition' : 'body-boundaries-5')
      )!.pages
    )
    const first = kind === 'variable' ? 181 : 216
    const body = kind === 'variable' ? 183 : 221
    // Replace the entire native row, not just its first prose run: leaving the
    // original explanations and operands would not create a standalone formula.
    pages[0].items = pages[0].items.slice(first, body + 1)
    const rhs = pages[0].items.at(-1)!
    Object.assign(rhs, { str: '= z + q', width: 35, hasEOL: true })
    pages[0].items.push({
      ...rhs,
      str: 'Independent prose follows the displayed definition.',
      width: 210,
      transform: [...rhs.transform.slice(0, 4), 108, rhs.transform[5] - 22]
    })
    const result = extractDocument({ pages })
    expect(result.units).toHaveLength(2)
    expect(result.units[0].sourceOnly).toBe(true)
    expect(result.units[0].source).toContain('= z + q')
    expect(result.units[1].source).toBe('Independent prose follows the displayed definition.')
    expect(result.units[0].items).not.toContain(`1:${pages[0].items.length - 1}`)
  })
}

test('all PDF translation fixtures exclude source identities and use reserved contact domains', () => {
  const directory = resolve('test/fixtures/pdf-translation')
  const leaks: string[] = []
  const check = (value: unknown, location: string): void => {
    if (typeof value === 'string') {
      // This guards explicit identifiers; synthetic wording still requires review.
      if (
        /\/Users\/|\/home\/|[A-Z]:\\Users\\|-----BEGIN .*PRIVATE KEY|\b(?:19|20|21|22|23|24|25|26)\d{2}\.\d{4,5}(?:v\d+)?\b/u.test(
          value
        )
      )
        leaks.push(location)
      for (const match of value.matchAll(
        /https?:\/\/([^\s/\])<>]+)|[\w.+%-]+@([\w.-]+\.[a-z]+)/giu
      )) {
        const host = match[1] ?? match[2]
        if (!/^(?:[a-z0-9-]+\.)*example\.(?:invalid|org|com|net)$/iu.test(host))
          leaks.push(location)
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => check(item, `${location}[${index}]`))
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (/^(?:provenance|arxiv|pdfSha256)$/iu.test(key)) leaks.push(`${location}.${key}`)
        check(item, `${location}.${key}`)
      }
    }
  }
  const files = readdirSync(directory).filter((file) => /\.jsonl?$/u.test(file))
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const text = readFileSync(resolve(directory, file), 'utf8')
    const records: unknown = file.endsWith('.jsonl')
      ? text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : JSON.parse(text)
    check(records, file)
  }
  expect(leaks).toEqual([])
})

for (const fault of [
  'finished-context',
  'paragraph-gap',
  'raised-function',
  'body-font',
  'symbolic-value'
] as const) {
  test(`wrapped function definition needs native prose context (${fault})`, () => {
    const pages = structuredClone(
      paragraphFlowCases.find((entry) => entry.name === 'wrapped-function-definition')!.pages
    )
    const items = pages[0].items
    if (fault === 'finished-context') items[95].str += '.'
    if (fault === 'paragraph-gap') for (const part of items.slice(96)) part.transform[5] -= 8
    if (fault === 'raised-function') items[98].transform[5] += 3
    if (fault === 'body-font') items[104].fontName = 'independent-body-font'
    if (fault === 'symbolic-value') items[96].str = '= z + q and'
    const result = extractDocument({ pages })
    const owner = (key: string) => result.units.find((unit) => unit.items.includes(key))!
    if (fault === 'finished-context' || fault === 'paragraph-gap')
      expect(owner('1:82')).not.toBe(owner('1:96'))
    else expect(owner('1:96')).not.toBe(owner('1:104'))
  })
}

for (const fault of [
  'finished-context',
  'paragraph-gap',
  'unresolved-root',
  'displaced-radicand',
  'body-font',
  'formula-rhs'
] as const) {
  test(`radical adjective needs resolved geometry and body wrap (${fault})`, () => {
    const pages = structuredClone(
      paragraphFlowCases.find((entry) => entry.name === 'inline-copular-definition')!.pages
    )
    const items = pages[0].items
    if (fault === 'finished-context') items[102].str += '.'
    if (fault === 'paragraph-gap') for (const part of items.slice(103)) part.transform[5] -= 8
    if (fault === 'unresolved-root') items[103].str = '∑'
    if (fault === 'displaced-radicand') items[104].transform[4] += 5
    if (fault === 'body-font') items[105].fontName = 'independent-body-font'
    if (fault === 'formula-rhs') items[105].str = '= z + q'
    const result = extractDocument({ pages })
    const owner = (key: string) => result.units.find((unit) => unit.items.includes(key))!
    if (fault === 'finished-context' || fault === 'paragraph-gap')
      expect(owner('1:102')).not.toBe(owner('1:103'))
    else if (fault === 'formula-rhs') {
      expect(owner('1:103').sourceOnly).toBe(true)
      expect(owner('1:103')).not.toBe(owner('1:106'))
    } else expect(owner('1:103')).not.toBe(owner('1:105'))
  })
}

for (const fault of [
  'finished-context',
  'paragraph-gap',
  'raised-modifier',
  'body-font',
  'unclosed-name',
  'function-name'
] as const) {
  test(`parenthetical styled name needs closed body continuation (${fault})`, () => {
    const pages = structuredClone(
      paragraphFlowCases.find((entry) => entry.name === 'body-boundaries-13')!.pages
    )
    const items = pages[0].items
    if (fault === 'finished-context') items[124].str += '.'
    if (fault === 'paragraph-gap') for (const part of items.slice(125)) part.transform[5] -= 8
    if (fault === 'raised-modifier') items[126].transform[5] += 3
    if (fault === 'body-font') items[127].fontName = 'independent-body-font'
    if (fault === 'unclosed-name') items[127].str = items[127].str.replace(/^\)/u, '+')
    if (fault === 'function-name') items[125].str = 'Softmax ('
    const result = extractDocument({ pages })
    const owner = (key: string) => result.units.find((unit) => unit.items.includes(key))!
    if (fault === 'finished-context' || fault === 'paragraph-gap')
      expect(owner('1:110')).not.toBe(owner('1:125'))
    else expect(owner('1:125')).not.toBe(owner('1:127'))
  })
}

for (const kind of ['marker', 'hanging-wrap'] as const) {
  for (const fault of [
    'no-reference-heading',
    'font',
    'baseline',
    'column',
    'intervening',
    'independent-entry'
  ] as const) {
    test(`numbered bibliography ${kind} requires native ownership proof (${fault})`, () => {
      const pages = structuredClone(
        paragraphFlowCases.find((entry) => entry.name === 'numbered-bibliography-native-wraps')!
          .pages
      )
      const items = pages[0].items
      const left = kind === 'marker' ? 128 : 13
      let right = kind === 'marker' ? 130 : 14
      if (fault === 'no-reference-heading') items[0].str = 'Methods'
      if (fault === 'font') items[right].fontName = 'independent-entry-font'
      if (fault === 'baseline') items[right].transform[5] -= 8
      if (fault === 'column') items[right].transform[4] += 210
      if (fault === 'independent-entry')
        items[right].str = '[72] An independent bibliographic record.'
      if (fault === 'intervening') {
        items.splice(right, 0, {
          ...items[right],
          str: 'Independent native text',
          width: 80,
          transform: [10, 0, 0, 10, 510, items[right].transform[5] + 3]
        })
        right++
      }
      const result = extractDocument({ pages })
      const owner = (key: string) => result.units.find((unit) => unit.items.includes(key))!
      expect(owner(`1:${left}`)).not.toBe(owner(`1:${right}`))
    })
  }
}

test('a finished numbered bibliography record does not consume the following native record', () => {
  const pages = structuredClone(
    paragraphFlowCases.find((entry) => entry.name === 'numbered-bibliography-native-wraps')!.pages
  )
  pages[1].items[22].str += '.'
  const result = extractDocument({ pages })
  const owner = (key: string) => result.units.find((unit) => unit.items.includes(key))!
  expect(owner('2:22')).not.toBe(owner('2:23'))
})
