import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
type NativeLine = {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}
type FlagFixture = {
  tables: { rect: number[] }[]
  rules: number[][]
  page: { width?: number; height?: number; lines: NativeLine[] }
}
const line = (text: string, x: number, y: number, width: number, height = 9): NativeLine => ({
  text,
  x,
  y,
  width,
  height,
  fontSize: height
})
const flags = (): FlagFixture => ({
  tables: [{ rect: [10, 30, 300, 100] }],
  rules: [[10, 98, 300, 98]],
  page: {
    lines: [
      line('Flag', 30, 35, 20),
      line('a', 50, 34, 3, 6),
      line('Class', 100, 35, 24),
      line('b', 124, 34, 3, 6),
      line('Group', 200, 35, 25),
      line('c', 225, 34, 3, 6),
      line('Note', 15, 101, 20),
      ...[
        '0: inactive, 1: active',
        '0: field, 1: stream, 2: core',
        '0: isolated, 1: satellite, 2: central'
      ].flatMap((text, n) => [
        line(String.fromCharCode(97 + n), 15, 111 + n * 11, 3, 6),
        line(text, 22, 112 + n * 11, 180)
      ]),
      line('The following paragraph describes a separate result.', 15, 147, 270)
    ]
  }
})

it('owns only a complete adjacent raised-letter definition series explicitly cited by headers', () => {
  const f = flags(),
    before = structuredClone(f)
  const notes = associateTableNotes(f.page, f.tables, f.rules)[0]
  expect(notes.map((n: { text: string }) => n.text)).toEqual([
    'a 0: inactive, 1: active',
    'b 0: field, 1: stream, 2: core',
    'c 0: isolated, 1: satellite, 2: central'
  ])
  expect(f).toEqual(before)
  const nativeBoundary = structuredClone(f)
  nativeBoundary.tables[0].rect[1] = 34 + 1e-13
  expect(
    associateTableNotes(nativeBoundary.page, nativeBoundary.tables, nativeBoundary.rules)[0]
  ).toEqual(notes)
})

it('refuses uncited, non-raised, distant, competing or ordinary prose definitions', () => {
  for (const mutation of ['uncited', 'ordinary', 'distant', 'competing', 'prose', 'no-rule']) {
    const f = flags()
    if (mutation === 'uncited')
      f.page.lines = f.page.lines.filter((l) => l.text !== 'b' || l.y > 100)
    if (mutation === 'ordinary')
      for (const l of f.page.lines.filter((l) => l.y > 100 && /^[abc]$/.test(l.text))) {
        l.height = l.fontSize = 9
        l.y += 1
      }
    if (mutation === 'distant') for (const l of f.page.lines.filter((l) => l.y > 100)) l.y += 100
    if (mutation === 'competing') f.tables.push(structuredClone(f.tables[0]))
    if (mutation === 'prose')
      f.page.lines.find((l) => l.text.startsWith('0: field'))!.text =
        '0: field, this ordinary paragraph describes a separate result.'
    if (mutation === 'no-rule') f.rules = []
    expect(associateTableNotes(f.page, f.tables, f.rules).flat(), mutation).toEqual([])
  }
})

const centeredNote = (): FlagFixture => ({
  tables: [{ rect: [75, 20, 270, 65] }],
  rules: [[75, 64, 270, 64]],
  page: {
    width: 340,
    height: 200,
    lines: [
      line('Note—All displayed fields use the same reporting convention. The', 20, 68, 300),
      line('source rows have complete printed values in each independent field.', 25, 80, 290),
      line('Remaining text belongs to this explicitly marked source note and', 30, 92, 280),
      line('describes the records before the complete final source words', 25, 104, 290),
      line('field values.', 140, 116, 60),
      line('A separate paragraph begins after its own visible source gap.', 20, 148, 300)
    ]
  }
})

it('keeps a whole centered ruled note including its short final source line', () => {
  const f = centeredNote(),
    before = structuredClone(f)
  const notes = associateTableNotes(f.page, f.tables, f.rules)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toBe(
    f.page.lines
      .slice(0, 5)
      .map((l) => l.text)
      .join(' ')
  )
  expect(notes[0].rect).toEqual([20, 68, 320, 125])
  expect(f).toEqual(before)
})

it('does not infer centered note ownership from a short line alone', () => {
  for (const mutation of ['off-center', 'gap', 'font', 'no-rule', 'competing', 'caption']) {
    const f = centeredNote(),
      tail = f.page.lines[4]
    if (mutation === 'off-center') tail.x += 15
    if (mutation === 'gap') tail.y += 30
    if (mutation === 'font') tail.fontSize = tail.height = 12
    if (mutation === 'no-rule') f.rules = []
    if (mutation === 'competing') f.tables.push(structuredClone(f.tables[0]))
    if (mutation === 'caption') tail.text = 'Table 9. Separate source result.'
    expect(
      associateTableNotes(f.page, f.tables, f.rules)
        .flat()
        .some((n: { text: string }) => n.text.includes(tail.text)),
      mutation
    ).toBe(false)
  }
})

it('preserves two separately marked centered notes with wider continuation rows', () => {
  const f: FlagFixture = {
    tables: [{ rect: [60, 20, 280, 65] }],
    rules: [[60, 64, 280, 64]],
    page: {
      width: 340,
      height: 180,
      lines: [
        line('Group', 100, 24, 30, 8),
        line('a', 130, 23.2, 3, 6),
        line('Value', 190, 24, 30, 8),
        line('b', 220, 23.2, 3, 6),
        line('a', 65, 68, 4, 6),
        line('The first convention uses complete printed records,', 71, 69, 204, 8),
        line('0.4 of the records share the same source convention,', 45, 79, 250, 8),
        line('with complete values.', 130, 89, 80, 8),
        line('b', 50, 98, 4, 6),
        line('The second convention describes the same records;', 56, 99, 234, 8),
        line('both source statements retain their original scope and', 45, 109, 250, 8),
        line('complete source labels.', 130, 119, 80, 8)
      ]
    }
  }
  const notes = associateTableNotes(f.page, f.tables, f.rules)[0]
  expect(notes.map((n: { text: string }) => n.text)).toEqual([
    'a The first convention uses complete printed records, 0.4 of the records share the same source convention, with complete values.',
    'b The second convention describes the same records; both source statements retain their original scope and complete source labels.'
  ])
})

const citedReferences = (): FlagFixture => ({
  tables: [{ rect: [75, 20, 275, 65] }],
  rules: [[76, 66, 274, 66]],
  page: {
    width: 340,
    height: 180,
    lines: [
      line('Value Ref.', 170, 24, 60),
      line('a', 230, 20.2, 4),
      line('a', 64, 67, 4),
      line('References: (1) Source A (2001), (2) Source B', 69, 70.8, 210),
      line('(2002), (3) Source C and Source D (2003),', 69.5, 81.8, 210),
      line('(4) Source E', 69.5, 92.8, 210),
      line('(2004).', 69.5, 103.8, 30),
      line('The following paragraph is independent of the cited records.', 70, 138, 240)
    ]
  }
})

it('owns a whole numbered reference footer only through its raised Ref. header citation', () => {
  const f = citedReferences(),
    before = structuredClone(f)
  const notes = associateTableNotes(f.page, f.tables, f.rules)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toBe(
    'a ' +
      f.page.lines
        .slice(3, 7)
        .map((l) => l.text)
        .join(' ')
  )
  expect(notes[0].rect).toEqual([64, 67, 279.5, 112.8])
  expect(f).toEqual(before)
})

it('rejects unowned, incomplete or competing numbered bibliography paragraphs', () => {
  for (const mutation of [
    'uncited',
    'ordinary-header',
    'ordinary-footer',
    'no-rule',
    'competing',
    'non-sequential',
    'incomplete',
    'gap',
    'intervening-prose'
  ]) {
    const f = citedReferences()
    if (mutation === 'uncited') f.page.lines.splice(1, 1)
    if (mutation === 'ordinary-header') f.page.lines[1].y = 24
    if (mutation === 'ordinary-footer') f.page.lines[2].y = 70.8
    if (mutation === 'no-rule') f.rules = []
    if (mutation === 'competing') f.tables.push(structuredClone(f.tables[0]))
    if (mutation === 'non-sequential') f.page.lines[4].text = '(2002), (5) Source C (2003),'
    if (mutation === 'incomplete') f.page.lines.splice(6, 1)
    if (mutation === 'gap') f.page.lines[5].y += 20
    if (mutation === 'intervening-prose')
      f.page.lines.push(line('A separate discussion.', 80, 67, 100))
    expect(associateTableNotes(f.page, f.tables, f.rules).flat(), mutation).toEqual([])
  }
})

const citedRaisedParagraphs = (): FlagFixture => ({
  tables: [{ rect: [40, 30, 290, 100] }],
  rules: [[42, 103, 288, 103]],
  page: {
    width: 340,
    height: 260,
    lines: [
      line('Count', 65, 35, 25),
      line('a', 90, 35.2, 3, 6),
      line('Group', 155, 35, 25),
      line('b', 180, 35.2, 3, 6),
      line('Class', 230, 35, 25),
      line('c', 255, 35.2, 3, 6),
      ...[
        ['The first cited paragraph retains all native words', 'and its complete final sentence.'],
        [
          'The second cited paragraph has independent records',
          'and its complete final source words.'
        ],
        [
          'The third cited paragraph describes the native fields',
          'and its complete closing sentence.'
        ]
      ].flatMap(([first, last], n) => [
        line(String.fromCharCode(97 + n), 44, 105 + n * 34, 4),
        line(first, 49, 108.8 + n * 34, 235),
        line(last, 49.5, 120 + n * 34, 160)
      ]),
      line('An independent body paragraph starts after a source gap.', 44, 220, 240)
    ]
  }
})

it('owns three whole paragraphs through smaller in-table citations and full-size raised footer letters', () => {
  const f = citedRaisedParagraphs(),
    before = structuredClone(f)
  expect(associateTableNotes(f.page, f.tables, f.rules)[0]).toEqual([
    {
      text: 'a The first cited paragraph retains all native words and its complete final sentence.',
      rect: [44, 105, 284, 129]
    },
    {
      text: 'b The second cited paragraph has independent records and its complete final source words.',
      rect: [44, 139, 284, 163]
    },
    {
      text: 'c The third cited paragraph describes the native fields and its complete closing sentence.',
      rect: [44, 173, 284, 197]
    }
  ])
  expect(f).toEqual(before)
})

it.each([
  'uncited',
  'ordinary-footer',
  'ordinary-citation',
  'no-rule',
  'competing',
  'incomplete',
  'gap',
  'foreign-left',
  'foreign-right',
  'foreign-top',
  'foreign-bottom'
])('refuses a full-size raised paragraph series with %s', (mutation) => {
  const f = citedRaisedParagraphs()
  if (mutation === 'uncited') f.page.lines.splice(3, 1)
  if (mutation === 'ordinary-footer')
    for (const l of f.page.lines.filter((l) => /^[abc]$/.test(l.text) && l.y > 100)) l.y += 3.8
  if (mutation === 'ordinary-citation')
    for (const l of f.page.lines.filter((l) => /^[abc]$/.test(l.text) && l.y < 100)) l.y = 38
  if (mutation === 'no-rule') f.rules = []
  if (mutation === 'competing') f.tables.push(structuredClone(f.tables[0]))
  if (mutation === 'incomplete') f.page.lines[8].text = 'and incomplete final source words'
  if (mutation === 'gap') f.page.lines[8].y += 25
  if (mutation.startsWith('foreign-')) {
    const bounds = {
      'foreign-left': [39, 110, 10],
      'foreign-right': [285, 110, 10],
      'foreign-top': [70, 99, 20],
      'foreign-bottom': [70, 195, 20]
    }[mutation]!
    f.page.lines.push(line('Foreign source words', bounds[0], bounds[1], bounds[2]))
  }
  expect(associateTableNotes(f.page, f.tables, f.rules).flat(), mutation).toEqual([])
})

const centeredReferencedContinuation = (): FlagFixture => ({
  tables: [{ rect: [40, 30, 300, 100] }],
  rules: [[42, 103, 298, 103]],
  page: {
    width: 340,
    height: 210,
    lines: [
      line('Mean total', 100, 35, 60),
      line('†', 160, 34, 3, 6.5),
      line('†', 24, 105.4, 3, 6.5),
      line(
        'Native recorded totals refer to complete measurements; all shown values use the same convention.',
        28,
        106.6,
        288
      ),
      line('Estimated totals are the displayed means multiplied by ten.', 70, 119.8, 200),
      line('A separate body paragraph follows its own source gap.', 40, 158, 260, 11)
    ]
  }
})

it('retains a complete centered totals sentence in its already cited symbol note', () => {
  const f = centeredReferencedContinuation(),
    before = structuredClone(f)
  expect(associateTableNotes(f.page, f.tables, f.rules)[0]).toEqual([
    {
      text: '† Native recorded totals refer to complete measurements; all shown values use the same convention. Estimated totals are the displayed means multiplied by ten.',
      rect: [24, 105.4, 316, 128.8]
    }
  ])
  expect(f).toEqual(before)
})

it.each([
  'uncited',
  'ordinary-citation',
  'no-rule',
  'competing',
  'unrelated',
  'off-center',
  'font',
  'gap',
  'incomplete',
  'caption',
  'new-marker',
  'duplicate-font',
  'foreign-left',
  'foreign-right',
  'foreign-top',
  'foreign-bottom'
])('does not extend the centered symbol note without complete %s proof', (mutation) => {
  const f = centeredReferencedContinuation()
  if (mutation === 'uncited') f.page.lines.splice(1, 1)
  if (mutation === 'ordinary-citation') f.page.lines[1].y = 37.5
  if (mutation === 'no-rule') f.rules = []
  if (mutation === 'competing') f.tables.push(structuredClone(f.tables[0]))
  if (mutation === 'unrelated')
    f.page.lines[4].text = 'An independent centered paragraph states a different result.'
  if (mutation === 'off-center') f.page.lines[4].x += 4
  if (mutation === 'font') f.page.lines[4].fontSize = 11
  if (mutation === 'gap') f.page.lines[4].y += 12
  if (mutation === 'incomplete')
    f.page.lines[4].text = 'Estimated totals are the displayed means multiplied by'
  if (mutation === 'caption')
    f.page.lines[4].text = 'Table 2: Estimated totals are the displayed means multiplied by ten.'
  if (mutation === 'new-marker')
    f.page.lines[4].text = '‡ Estimated totals are the displayed means multiplied by ten.'
  if (mutation === 'duplicate-font') f.page.lines.push(structuredClone(f.page.lines[4]))
  if (mutation.startsWith('foreign-')) {
    const bounds = {
      'foreign-left': [20, 119, 10],
      'foreign-right': [311, 119, 10],
      'foreign-top': [100, 98, 20],
      'foreign-bottom': [100, 125, 20]
    }[mutation]!
    f.page.lines.push(line('Foreign native words', bounds[0], bounds[1], bounds[2]))
  }
  const before = structuredClone(f)
  expect(
    associateTableNotes(f.page, f.tables, f.rules)
      .flat()
      .some(
        (n: ReturnType<typeof JSON.parse>) =>
          n.text.includes('Estimated totals are') && n.text.startsWith('† ')
      ),
    mutation
  ).toBe(false)
  expect(f).toEqual(before)
})
