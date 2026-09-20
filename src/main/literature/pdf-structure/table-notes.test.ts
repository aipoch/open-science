import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
it('keeps a bibliographic source beneath a table without absorbing modified-result prose', () => {
  const line = (text: string, y = 184): object => ({
    text,
    x: 51,
    y,
    width: 292,
    height: 8.5,
    fontSize: 8.5
  })
  const source = 'Modified from Silverstein MJ; Ductal Carcinoma in Situ of the breast 2nd ed. 2002'
  const table = [{ rect: [44, 75, 551, 176] }]
  expect(
    associateTableNotes({ lines: [line(source)] }, table)[0].map((n: { text: string }) => n.text)
  ).toEqual([source])
  expect(associateTableNotes({ lines: [line(source, 240)] }, table)).toEqual([[]])
  expect(
    associateTableNotes(
      { lines: [line('Modified from baseline in 2002, the score increased.')] },
      table
    )
  ).toEqual([[]])
  expect(
    associateTableNotes(
      { lines: [line('Modified from Standard treatment to another protocol.')] },
      table
    )
  ).toEqual([[]])
})
it('recognizes a period-and-dash note prefix without consuming ordinary Note prose', () => {
  const line = (text: string): object => ({
    text,
    x: 20,
    y: 110,
    width: 260,
    height: 8,
    fontSize: 8
  })
  for (const prefix of ['Note.—', 'Note. —', 'Notes.–']) {
    const text = prefix + 'Numbers in parentheses are percentages.'
    expect(
      associateTableNotes({ lines: [line(text)] }, [{ rect: [10, 20, 300, 100] }])[0][0]?.text
    ).toBe(text)
  }
  expect(
    associateTableNotes({ lines: [line('Note that these results require further study.')] }, [
      { rect: [10, 20, 300, 100] }
    ])
  ).toEqual([[]])
})
it('keeps indented abbreviation keys and their outdented continuation together', () => {
  const line = (text: string, x: number, y: number): object => ({
    text,
    x,
    y,
    width: 240,
    height: 8,
    fontSize: 8
  })
  for (const [first, second] of [
    [
      'BCT, breast conservation therapy; LABC, locally advanced breast cancer;',
      'MRM, modified radical mastectomy; OBC, operable breast cancer.'
    ],
    [
      'CI, confidence interval; LABC, locally advanced breast cancer; OBC,',
      'operable breast cancer; RR, response rate.'
    ]
  ]) {
    const page = { lines: [line(first, 50, 262), line(second, 42, 271)] }
    expect(
      associateTableNotes(page, [{ rect: [40, 75, 295, 254] }])[0].map(
        (n: { text: string }) => n.text
      )
    ).toEqual([first + ' ' + second])
  }
  expect(
    associateTableNotes(
      { lines: [line('CI, confidence interval;', 50, 262), line('RR, response rate.', 42, 271)] },
      [{ rect: [40, 75, 295, 254] }]
    )
  ).toEqual([[]])
})
it('keeps count and confidence-interval explanations below the table as notes', () => {
  const text = 'Data are n (%, 95% CI). *Calculated by the McNemar’s test.'
  const page = {
    lines: [
      { text, x: 10, y: 105, width: 260, height: 9, fontSize: 9 },
      {
        text: 'Non-high-grade without necroses.',
        x: 10,
        y: 116,
        width: 180,
        height: 9,
        fontSize: 9
      }
    ]
  }
  expect(associateTableNotes(page, [{ rect: [10, 20, 300, 100] }])[0][0].text).toBe(
    text + ' Non-high-grade without necroses.'
  )
  expect(associateTableNotes(page, [{ rect: [10, 20, 300, 130] }])).toEqual([[]])
})
it('recovers a single abbreviation below a closing rule and hanging marker continuations', () => {
  const line = (text: string, y: number, x = 14, width = 200): object => ({
    text,
    x,
    y,
    width,
    height: 10,
    fontSize: 10
  })
  const table = [{ rect: [10, 0, 310, 100] }]
  const page = {
    lines: [line('Last record', 85), line('CME, continuing medical education.', 105, 14, 140)]
  }
  expect(
    associateTableNotes(page, table, [[10, 102, 310, 102]])[0].map((n: { text: string }) => n.text)
  ).toEqual(['CME, continuing medical education.'])
  expect(associateTableNotes(page, table)).toEqual([[]])
  const hanging = {
    lines: [
      line('*Values shown are risks', 105, 20),
      line('compared with the other group.', 116, 10)
    ]
  }
  expect(associateTableNotes(hanging, table)[0][0].text).toBe(
    '*Values shown are risks compared with the other group.'
  )
})

it('associates explicit abbreviation notes below a table and excludes embedded captions', () => {
  const note = 'Abbreviations: OR, odds ratio; CI, confidence interval.'
  expect(
    associateTableNotes(
      { lines: [{ text: note, x: 10, y: 105, width: 260, height: 9, fontSize: 9 }] },
      [{ rect: [0, 20, 300, 100] }]
    )[0].map((n: { text: string }) => n.text)
  ).toEqual([note])
  const raw = {
    cropRect: [0, 0, 300, 100],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 30, 300, 50] },
        { label: 'table row', rect: [0, 60, 300, 80] },
        ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 30, x + 100, 80] }))
      ]
    }
  }
  const items = [
    { text: 'Table 3. Response', rect: [10, 5, 160, 15] },
    { text: 'Group', rect: [10, 35, 50, 45] },
    { text: 'No.', rect: [110, 35, 140, 45] },
    { text: 'Treatment', rect: [10, 65, 70, 75] },
    { text: '20', rect: [110, 65, 130, 75] }
  ].map((item) => ({ ...item, baseline: item.rect[3], height: 10, horizontal: true }))
  const result = refineTable(raw, items, [
    { page: 1, lines: ['Table 3. Response'], rect: [10, 5, 160, 15] }
  ])
  expect(result.grid).toEqual([
    ['Group', 'No.', ''],
    ['Treatment', '20', '']
  ])
  expect(result.unassigned).toEqual([])
  expect(result.excludedCaptionItems).toEqual(['Table 3. Response'])
  // A caption-looking value within the data rows is still table content.
  expect(
    refineTable(raw, items, [
      { page: 1, lines: ['Table 3. Treatment'], rect: [10, 65, 70, 75] }
    ]).grid.flat()
  ).toContain('Treatment')
})

it('associates raised letter notes and single-letter abbreviation keys, not normal prose', () => {
  const line = (text: string, y: number, fontSize = 9, x = 10, width = 270): object => ({
    text,
    x,
    y,
    width,
    height: fontSize,
    fontSize
  })
  const table = [{ rect: [0, 0, 300, 100] }]
  const page = {
    lines: [
      line('a', 105.4, 5.4, 10, 2.4),
      line('Explanation of the measurement.', 105, 9, 12.4, 240),
      line('N, number; GC, gastric cancer; CI, confidence interval.', 116)
    ]
  }
  expect(
    associateTableNotes(page, table)
      .flat()
      .map((n: { text: string }) => n.text)
  ).toEqual([
    'a Explanation of the measurement.',
    'N, number; GC, gastric cancer; CI, confidence interval.'
  ])
  expect(associateTableNotes({ lines: [line('a normal paragraph follows.', 105)] }, table)).toEqual(
    [[]]
  )
})

it('requires a bottom rule and smaller type for an unmarked table explanation', () => {
  const page = {
    lines: [
      { text: 'Last row', x: 10, y: 85, width: 70, height: 10, fontSize: 10 },
      {
        text: 'Characteristics of participants in both study cohorts',
        x: 10,
        y: 108,
        width: 250,
        height: 8,
        fontSize: 8
      }
    ]
  }
  const tables = [{ rect: [0, 0, 300, 100] }]
  const rules = [
    [10, 104, 150, 104],
    [150, 104, 290, 104]
  ]
  expect(associateTableNotes(page, tables, rules)[0]).toHaveLength(1)
  expect(associateTableNotes(page, tables)).toEqual([[]])
  expect(
    associateTableNotes(
      { ...page, lines: page.lines.map((line) => ({ ...line, fontSize: 10, height: 10 })) },
      tables,
      rules
    )
  ).toEqual([[]])
})

it('keeps a separately associated footnote out of clipped and unassigned cell text', () => {
  const table = {
    cropRect: [0, 0, 300, 45],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 300, 20] },
        { label: 'table row', rect: [0, 20, 300, 40] },
        ...[0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 40] }))
      ]
    }
  }
  const tokens = [
    { text: 'Term', rect: [10, 5, 45, 15] },
    { text: 'Value', rect: [110, 5, 145, 15] },
    { text: 'Age', rect: [10, 25, 45, 35] },
    { text: '10', rect: [110, 25, 130, 35] },
    { text: '* Original note.', rect: [10, 41, 100, 47] }
  ].map((item) => ({
    ...item,
    baseline: item.rect[3],
    height: item.rect[3] - item.rect[1],
    horizontal: true
  }))
  const before = refineTable(table, tokens)
  expect(before.issues).toContain('text-crosses-crop-boundary')
  expect(before.unassigned).toEqual(['* Original note.'])
  const page = {
    lines: tokens.map((t) => ({
      text: t.text,
      x: t.rect[0],
      y: t.rect[1],
      width: t.rect[2] - t.rect[0],
      height: t.height,
      fontSize: t.height
    }))
  }
  const [notes] = associateTableNotes(page, [{ rect: [0, 0, 300, 40] }])
  expect(notes).toMatchObject([{ text: '* Original note.' }])
  const after = refineTable(table, tokens, [], notes)
  expect(after.grid).toEqual(before.grid)
  expect(after.clipped).toEqual([])
  expect(after.unassigned).toEqual([])
  expect(after.issues).toEqual([])

  // Merely labelling real cell content a note cannot remove it.
  expect(refineTable(table, tokens, [], [{ text: 'Age', rect: [10, 25, 45, 35] }]).grid).toEqual(
    before.grid
  )
})

it('keeps unprefixed mean/deviation explanations below a table', () => {
  const text = 'Group 1 and 2 drainage volumes (ml) are expressed as mean ± standard deviation'
  const line = { text, x: 50, y: 205, width: 380, height: 8, fontSize: 8 }
  expect(
    associateTableNotes({ lines: [line] }, [{ rect: [50, 50, 450, 200] }])[0].map(
      (n: { text: string }) => n.text
    )
  ).toEqual([text])
  const prose = { ...line, text: 'The groups are compared in the following section.' }
  expect(associateTableNotes({ lines: [prose] }, [{ rect: [50, 50, 450, 200] }])).toEqual([[]])
})

it('keeps both lines of a wrapped descriptive-statistics note', () => {
  const first = {
    text: 'Age, postmenopausal period, menarch age and number of',
    x: 57,
    y: 674,
    width: 228,
    height: 10,
    fontSize: 10
  }
  const last = {
    ...first,
    text: 'pregnancies are expressed as mean ± standard deviation',
    y: 686,
    width: 214
  }
  const table = [{ rect: [50, 300, 290, 666] }]
  expect(
    associateTableNotes({ lines: [first, last] }, table)[0].map((n: { text: string }) => n.text)
  ).toEqual([first.text + ' ' + last.text])
  const unrelated = { ...first, text: 'We next considered the clinical implications.' }
  expect(
    associateTableNotes({ lines: [unrelated, last] }, table)[0].map((n: { text: string }) => n.text)
  ).toEqual([last.text])
  expect(associateTableNotes({ lines: [first, { ...last, x: 310 }] }, table)).toEqual([[]])
})

it('associates a ruled statistical explanation with its symbol definitions, without absorbing prose', () => {
  const line = (text: string, y: number): object => ({
    text,
    x: 57,
    y,
    width: 390,
    height: 10,
    fontSize: 10
  })
  const explanation =
    'The decrease in amount of drainage was only found related in β-glucan administration (p = 0.002)'
  const definitions =
    'β beta (standardized regression coefficients), SE standard error, OR odds ratio, CI confidence interval'
  const page = {
    lines: [
      line('(Constant) 5.266 2.037 0.011 1.225 9.308', 420),
      line(explanation, 439),
      line(definitions, 451),
      line('The expression levels of IL-6 are usually elevated.', 477)
    ]
  }
  const table = [{ rect: [50, 240, 530, 430] }]
  const rules = [[57, 434, 525, 434]]
  expect(associateTableNotes(page, table, rules)[0].map((n: { text: string }) => n.text)).toEqual([
    explanation,
    definitions
  ])
  expect(associateTableNotes(page, table)[0].map((n: { text: string }) => n.text)).toEqual([
    definitions
  ])
  expect(
    associateTableNotes({ lines: page.lines.filter((_, i) => i !== 2) }, table, rules)
  ).toEqual([[]])
})
it('keeps a marked definition below the bottom rule out of recovered numeric records', () => {
  const grid = [
    ['Measure', 'Arm A', 'Arm B', 'P'],
    ...Array.from({ length: 12 }, (_, r) => [`Score ${r}`, '3.1', '4.2', '0.05'])
  ]
  const table = {
    cropRect: [0, 0, 400, 224],
    structure: {
      objects: [
        ...[0, 100, 200, 300].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 224] })),
        { label: 'table column header', rect: [0, 0, 400, 16] },
        ...grid.map((_, r) => ({ label: 'table row', rect: [0, r * 16, 400, r * 16 + 16] }))
      ]
    }
  }
  const items = grid.flatMap((row, r) =>
    row.map((text, c) => ({
      text,
      rect: [c * 100 + 5, r * 16 + 3, c * 100 + 90, r * 16 + 13],
      height: 10,
      baseline: r * 16 + 13,
      horizontal: true
    }))
  )
  const note = {
    text: '*BFI, Brief Fatigue Inventory.',
    rect: [5, 212, 98, 222],
    height: 10,
    baseline: 222,
    horizontal: true
  }
  items.push(note)
  const rules = [
    [0, 0, 400, 0],
    [0, 16, 400, 16],
    [0, 210, 400, 210]
  ]
  const result = refineTable(table, items, [], [], rules)
  expect(result.grid).toEqual(grid)
  const page = {
    lines: items.map((i) => ({
      text: i.text,
      x: i.rect[0],
      y: i.rect[1],
      width: i.rect[2] - i.rect[0],
      height: i.height,
      fontSize: i.height
    }))
  }
  const [notes] = associateTableNotes(
    page,
    [{ rect: [0, 0, 400, result.rows.at(-1).rect[3]] }],
    rules
  )
  expect(notes.map((n: { text: string }) => n.text)).toEqual([note.text])
  expect(refineTable(table, items, [], notes, rules).unassigned).toEqual([])
  expect(refineTable(table, items, [], [], []).grid.flat()).toContain(note.text)
})

it('retains explicit count-format notes and sample sizes with spaced parentheses', () => {
  const table = [{ rect: [10, 20, 300, 100] }]
  const line = (text: string, y = 105): object => ({
    text,
    x: 10,
    y,
    width: 280,
    height: 8,
    fontSize: 8
  })
  for (const text of [
    'Values are presented as number (%).',
    'Values are presented as number (%) unless otherwise indicated. ECOG, performance status; ITT, intent-to-treat.',
    'GRACE ( baseline n = 37; post-clinic n = 37; follow-up n = 27); NS: non significant.'
  ]) {
    expect(associateTableNotes({ lines: [line(text)] }, table)[0][0]?.text).toBe(text)
    expect(associateTableNotes({ lines: [line(text, 160)] }, table)).toEqual([[]])
  }
  for (const text of [
    'Values are presented as evidence of improvement.',
    'GRACE ( baseline n = 37) improved after treatment.'
  ]) {
    expect(associateTableNotes({ lines: [line(text)] }, table)).toEqual([[]])
  }
})

it('attaches a detached raised letter to its adjacent footnote without treating prose as a marker', () => {
  const table = [{ rect: [40, 70, 285, 400] }]
  const marker = { text: 'a', x: 45.6378, y: 440.6907, width: 2.52, height: 5.25, fontSize: 5.25 }
  const text = {
    text: 'Chi-squared test.',
    x: 48.1577,
    y: 441.8157,
    width: 53.745,
    height: 7.5,
    fontSize: 7.5
  }
  const prior = {
    text: 'Abbreviations: ER, estrogen receptor; pCR, pathological complete response.',
    x: 45.6378,
    y: 407.8157,
    width: 239,
    height: 7.5,
    fontSize: 7.5
  }
  // The preceding note bridges the distance from the table to the last footnote.
  const neighboringColumn = {
    text: 'The discussion continues in the next column.',
    x: 306.8,
    y: marker.y - 0.9909,
    width: 242.8,
    height: 10,
    fontSize: 10
  }
  const page = { lines: [prior, neighboringColumn, marker, text] }
  const notes = associateTableNotes(page, table)[0]
  expect(notes.map((note: { text: string }) => note.text)).toEqual([
    prior.text,
    'a Chi-squared test.'
  ])
  expect(notes[1].rect[0]).toBe(marker.x)
  for (const changed of [
    { ...marker, x: 30 },
    { ...marker, y: text.y, height: 7.5, fontSize: 7.5 }
  ]) {
    expect(associateTableNotes({ lines: [changed, text] }, [{ rect: [40, 70, 285, 418] }])).toEqual(
      [[]]
    )
  }
})

it('requires a closing rule for short abbreviation keys and reference-location notes', () => {
  const table = [{ rect: [10, 20, 310, 100] }]
  const line = (text: string, y = 105, width = 170): object => ({
    text,
    x: 10,
    y,
    width,
    height: 8,
    fontSize: 8
  })
  const body = line('Last table record', 89)
  const border = [[10, 102, 310, 102]]
  for (const text of [
    'mBC, patients with metastatic breast cancer.',
    'ITT, intent-to-treat; SD, standard deviation. a) Difference between groups.',
    'The reference details for the trials included in the review are shown in Appendix B.'
  ]) {
    const page = { lines: [body, line(text)] }
    expect(associateTableNotes(page, table, border)[0][0]?.text).toBe(text)
    expect(associateTableNotes(page, table)).toEqual([[]])
    expect(associateTableNotes(page, table, [[10, 102, 150, 102]])).toEqual([[]])
    expect(associateTableNotes({ lines: [body, line(text, 150)] }, table, border)).toEqual([[]])
  }
  expect(
    associateTableNotes(
      { lines: [body, line('The reference details were discussed by the study authors.')] },
      table,
      border
    )
  ).toEqual([[]])
})

it('recognizes explicit annotation labels and a standalone note heading', () => {
  for (const value of [
    'Annotations: T=treatment group; C=control',
    'Note.',
    'NOTE.',
    'note.',
    'Note. Change scores were calculated as post-test minus pre-test values.'
  ]) {
    const lines = [{ text: value, x: 20, y: 106, width: 260, height: 8, fontSize: 8 }]
    expect(associateTableNotes({ lines }, [{ rect: [10, 20, 300, 100] }])[0][0]?.text).toBe(value)
  }
})

it('retains indented statistical definitions and their outdented continuation', () => {
  const lines = [
    {
      text: 'Baseline data are mean±SD; intervals are 95% CI from the fitted',
      x: 28,
      y: 106,
      width: 252,
      height: 7,
      fontSize: 7
    },
    { text: 'model.', x: 20, y: 115, width: 30, height: 7, fontSize: 7 },
    {
      text: 'The following paragraph discusses the results.',
      x: 20,
      y: 130,
      width: 260,
      height: 10,
      fontSize: 10
    }
  ]
  const table = [{ rect: [20, 20, 300, 100] }]
  expect(associateTableNotes({ lines }, table)[0].map((n: { text: string }) => n.text)).toEqual([
    'Baseline data are mean±SD; intervals are 95% CI from the fitted model.'
  ])
  expect(
    associateTableNotes(
      { lines: [{ ...lines[0], text: 'Baseline data are missing from the study.' }] },
      table
    )
  ).toEqual([[]])
})

it('recognizes wrapped indicates abbreviation lists with several independent definitions', () => {
  const lines = [
    {
      text: 'AC indicates treatment; ACE, enzyme;',
      x: 28,
      y: 106,
      width: 240,
      height: 7,
      fontSize: 7
    },
    {
      text: 'ARB, receptor blocker; ExT, exercise training; and UC, usual care.',
      x: 20,
      y: 115,
      width: 270,
      height: 7,
      fontSize: 7
    }
  ]
  const table = [{ rect: [20, 20, 300, 100] }]
  expect(associateTableNotes({ lines }, table)[0][0]?.text).toBe(lines.map((l) => l.text).join(' '))
  expect(associateTableNotes({ lines: [lines[0]] }, table)).toEqual([[]])
  expect(
    associateTableNotes(
      { lines: [{ ...lines[0], text: 'HR indicates recovery after exercise.' }] },
      table
    )
  ).toEqual([[]])
  expect(associateTableNotes({ lines: lines.map((l) => ({ ...l, y: l.y + 100 })) }, table)).toEqual(
    [[]]
  )
})

it('retains a wrapped supplementary reference but stops at a new table caption', () => {
  const line = (text: string, y: number): object => ({
    text,
    x: 20,
    y,
    width: 280,
    height: 8,
    fontSize: 8
  })
  const table = [{ rect: [10, 20, 310, 100] }]
  const prefix = 'Note: Participant characteristics are provided in Supplementary'
  const read = (first: string, last: string): string =>
    associateTableNotes(
      {
        lines: [line(first, 108), line(last, 118)]
      },
      table
    )[0][0].text
  expect(read(prefix, 'Table S2.')).toBe(prefix + ' Table S2.')
  expect(read(prefix, 'Table S2. Other outcomes')).toBe(prefix)
  expect(read('Note: Counts are percentages.', 'Table S2.')).toBe('Note: Counts are percentages.')
})

it('attaches a complete comparison note below a ruled table without swallowing subsequent prose', () => {
  const line = (text: string, y: number, x = 50): object => ({
    text,
    x,
    y,
    width: 240,
    height: 10,
    fontSize: 10
  })
  const text = 'Compared with control group, P > 0.05'
  const page = {
    lines: [
      line('Overall 59 (48.4%) 69 (53.1%)', 90),
      line(text, 112),
      line('The subsequent analysis considered adverse events.', 125)
    ]
  }
  const table = [{ rect: [45, 20, 350, 102] }]
  const rules = [
    [50, 106, 150, 106],
    [150, 106, 345, 106]
  ]
  expect(
    associateTableNotes(page, table, rules)[0].map((note: { text: string }) => note.text)
  ).toEqual([text])
  expect(associateTableNotes(page, table)).toEqual([[]])
  expect(associateTableNotes(page, table, rules.slice(0, 1))).toEqual([[]])
  expect(associateTableNotes({ lines: [page.lines[0], line(text, 160)] }, table, rules)).toEqual([
    []
  ])
  expect(
    associateTableNotes({ lines: [page.lines[0], line(text, 112, 390)] }, table, rules)
  ).toEqual([[]])
  expect(
    associateTableNotes(
      { lines: [page.lines[0], line('Compared with control group, outcomes improved.', 112)] },
      table,
      rules
    )
  ).toEqual([[]])
})

it('associates comma-delimited raised letter notes without matching ordinary lettered prose', () => {
  const table = [{ rect: [40, 50, 360, 100] }]
  const page = {
    lines: [
      { text: 'a', x: 48, y: 104, width: 3, height: 5.3, fontSize: 5.3 },
      {
        text: ', Comparison between the treatment groups;',
        x: 51,
        y: 105,
        width: 290,
        height: 8,
        fontSize: 8
      },
      {
        text: 'adjusted for the baseline measurement.',
        x: 48,
        y: 115,
        width: 250,
        height: 8,
        fontSize: 8
      }
    ]
  }
  expect(associateTableNotes(page, table)[0]).toEqual([
    expect.objectContaining({
      text: 'a , Comparison between the treatment groups; adjusted for the baseline measurement.'
    })
  ])
  const ordinary = {
    ...page,
    lines: page.lines.map((line) => ({
      ...line,
      y: line.y === 104 ? 105 : line.y,
      height: 8,
      fontSize: 8
    }))
  }
  expect(associateTableNotes(ordinary, table)).toEqual([[]])
  expect(associateTableNotes(page, [{ rect: [40, 50, 360, 120] }])).toEqual([[]])
})

it('keeps a complete equally double-spaced manuscript abbreviation note', () => {
  const line = (text: string, y: number): object => ({
    text,
    x: 85,
    y,
    width: 410,
    height: 12,
    fontSize: 12
  })
  const text = '*SD, standard deviation; BMI, body mass index; HER2, human epidermal growth'
  const page = {
    pageNumber: 2,
    lines: [
      line(text, 673),
      line('factor receptor type2. P values were calculated by rank tests or', 700),
      line('Chi-square test;', 727)
    ]
  }
  const tables = [{ rect: [80, 100, 500, 640] }]
  expect(associateTableNotes(page, tables)[0][0].text).toBe(
    text + ' factor receptor type2. P values were calculated by rank tests or Chi-square test;'
  )
  const uneven = { ...page, lines: [page.lines[0], page.lines[1], line('Chi-square test;', 737)] }
  expect(associateTableNotes(uneven, tables)[0][0].text).toBe(text)
  const complete = { ...page, lines: [line(text + '.', 673), ...page.lines.slice(1)] }
  expect(associateTableNotes(complete, tables)[0][0].text).toBe(text + '.')
})

it('retains explicit sources and paired abbreviation equations without absorbing ordinary prose', () => {
  const table = [{ rect: [10, 20, 300, 100] }]
  const line = (text: string, y = 105): object => ({
    text,
    x: 10,
    y,
    width: 280,
    height: 10,
    fontSize: 10
  })
  for (const text of [
    'Source: Developed by the authors.',
    'Sources: Trial registry and case records.',
    'OH = hydroxy, MeO = methoxy, E2 = estradiol'
  ]) {
    expect(associateTableNotes({ lines: [line(text)] }, table)[0][0]?.text).toBe(text)
    expect(associateTableNotes({ lines: [line(text, 90)] }, table)).toEqual([[]])
  }
  expect(
    associateTableNotes({ lines: [line('Source estimates improved after treatment.')] }, table)
  ).toEqual([[]])
  expect(associateTableNotes({ lines: [line('OH = hydroxy')] }, table)).toEqual([[]])
})

it('retains a Greek treatment key and a separate superscript significance explanation', () => {
  const line = (text: string, y: number, fontSize: number): object => ({
    text,
    x: 10,
    y,
    width: 280,
    height: fontSize,
    fontSize
  })
  const key = 'ω3; omega-3 group, VitD; vitamin D group, ω3+VitD; combined group.'
  const explanation = 'Different superscript letters indicate significant difference at **p < 0.01.'
  expect(
    associateTableNotes({ lines: [line(key, 105, 7.3), line(explanation, 114, 6.3)] }, [
      { rect: [10, 20, 300, 100] }
    ])[0].map((n: { text: string }) => n.text)
  ).toEqual([key, explanation])
})

it('associates raised numeric and mixed markers without accepting numbered body prose', () => {
  const table = [{ rect: [10, 20, 300, 100] }]
  for (const marker of ['1', '2', '3a', '3b']) {
    const lines = [
      { text: marker, x: 15, y: 106, width: 7, height: 5, fontSize: 5 },
      {
        text: 'Reported values use the assigned group.',
        x: 24,
        y: 108,
        width: 210,
        height: 8,
        fontSize: 8
      }
    ]
    expect(associateTableNotes({ lines }, table)[0]).toHaveLength(1)
    expect(
      associateTableNotes(
        { lines: lines.map((l) => ({ ...l, y: 108, height: 8, fontSize: 8 })) },
        table
      )[0]
    ).toHaveLength(0)
  }
})

it.each([
  'Values are mean (SD), number (proportion), or median [q1, q3].',
  'Data represented as n (%) or mean (SD).',
  'Comparisons between the two study groups were performed using the Student’s t-test.',
  'A significance level of <0.01 was chosen considering multiple testing.',
  'T0-T3 was measured between T0 and T3.',
  'MD: mean difference; 95% CI: 95% confidence interval;'
])('associates a descriptive statistics note only near its table: %s', (text) => {
  const line = { text, x: 20, y: 110, width: 300, height: 8, fontSize: 8 }
  expect(associateTableNotes({ lines: [line] }, [{ rect: [10, 20, 340, 100] }])[0][0]?.text).toBe(
    text
  )
  expect(
    associateTableNotes({ lines: [{ ...line, y: 180 }] }, [{ rect: [10, 20, 340, 100] }])
  ).toEqual([[]])
})

it('attaches a self-contained bracketed data-source credit without consuming prose', () => {
  const line = (text: string, y = 110): object => ({
    text,
    x: 20,
    y,
    width: 220,
    height: 8,
    fontSize: 8
  })
  const tables = [{ rect: [10, 20, 300, 100] }]
  const credit = 'Data taken from [38].'
  const page = { lines: [line(credit), line('The following paragraph describes results.', 120)] }
  expect(associateTableNotes(page, tables)[0].map((n: { text: string }) => n.text)).toEqual([
    credit
  ])
  expect(associateTableNotes({ lines: [line(credit, 155)] }, tables)).toEqual([[]])
  expect(
    associateTableNotes({ lines: [line('Data taken from [38] were reanalyzed.')] }, tables)
  ).toEqual([[]])
})

it('retains expansion-first abbreviation lists and their indented tails beside a figure caption', () => {
  const line = (text: string, x: number, y: number, width: number): object => ({
    text,
    x,
    y,
    width,
    fontSize: 8,
    height: 8
  })
  const first = 'Body Mass index (BMi); chemotherapy (cT); endocrine therapy (eT); Tamoxifen'
  const tail = '(Tam); Gonadothropin releasing hormone (GnrH); aromatase inhibitor (ai).'
  const second =
    'Total Menopause rating Scale (Tot MrS); Somato-Vegetative Menopause rating Scale (SV MrS); Psychological Menopause rating Scale (P MrS), Urogenital Menopause'
  const secondTail = 'rating Scale (U MrS).'
  const page = {
    lines: [
      line(first, 41.85, 620.001, 256.8704),
      line(tail, 47.85, 629.001, 237.784),
      line('Figure 1. Number of hot flashes per week', 310.7244, 620.001, 256.8816),
      line('T0, T1 and T2.', 310.7244, 629.001, 180.8959),
      line(second, 41.85, 735.001, 525.756),
      line(secondTail, 47.85, 744.001, 68.704)
    ]
  }
  const tables = [
    { rect: [35.3333, 442.751, 296, 616.6343] },
    { rect: [35.3333, 671.501, 561.3333, 730.604] }
  ]
  expect(
    associateTableNotes(page, tables).map((notes: { text: string }[]) => notes.map((n) => n.text))
  ).toEqual([[first + ' ' + tail], [second + ' ' + secondTail]])
  for (const text of [
    'Body Mass index (BMi); chemotherapy (cT).',
    'First group (12); second group (24); third group (36).',
    'Treatment (mean); control (mean); difference (mean).'
  ])
    expect(associateTableNotes({ lines: [line(text, 41.85, 620.001, 256)] }, tables)[0]).toEqual([])
})

it('attaches a wrapped P-value comparison definition and its abbreviation below the table', () => {
  const texts = [
    'P values represent comparisons of the resected biopsy scores between patients who received sevoflurane–',
    'opioid anesthesia (GA group) and propofol–paravertebral anesthesia (PPA). Data shown are median (Inter-',
    'quartile range)',
    'MOR μ-opioid receptor'
  ]
  const lines = texts.map((text, i) => ({
    text,
    x: 178.58,
    y: [673.17, 683.16, 693.16, 706][i],
    width: [365.69, 365.67, 49.74, 79.27][i],
    height: 8.5,
    fontSize: 8.5
  }))
  const table = [{ rect: [170, 550.65, 550, 663.8] }]
  const notes = associateTableNotes({ lines }, table)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toContain(texts[0])
  expect(notes[0].text).toContain('MOR μ-opioid receptor')
  expect(associateTableNotes({ lines: lines.map((l) => ({ ...l, y: l.y + 60 })) }, table)).toEqual([
    []
  ])
  expect(
    associateTableNotes(
      { lines: [{ ...lines[0], text: 'P values changed after the comparison was repeated.' }] },
      table
    )
  ).toEqual([[]])
})

it('recognizes a plus-marked standard-deviation key without treating arithmetic prose as a note', () => {
  const line = {
    text: '+ Standard deviation; * p < 0.05',
    x: 51,
    y: 612.39,
    width: 105.3,
    height: 9.35,
    fontSize: 8.5
  }
  const tables = [{ rect: [44, 72.87, 546, 602.57] }]
  expect(associateTableNotes({ lines: [line] }, tables)[0][0]?.text).toBe(line.text)
  expect(
    associateTableNotes(
      { lines: [{ ...line, text: '+ Standard treatment improved the scores.' }] },
      tables
    )
  ).toEqual([[]])
  expect(associateTableNotes({ lines: [{ ...line, y: 702 }] }, tables)).toEqual([[]])
})

it('preserves a complete list of symbol-keyed statistical definitions beneath a rotated table', () => {
  const text =
    '^Percent difference (95% confidence interval), + adjusted relative risk (95% confidence interval), # standard deviation, $ metabolic equivalents, & body mass index'
  const line = { text, x: 75.29, y: 467.95, width: 540.57, height: 9.35, fontSize: 8.5 }
  const table = [{ rect: [68.67, 104.67, 738, 459.35] }]
  expect(associateTableNotes({ lines: [line] }, table)[0][0]?.text).toBe(text)
  expect(
    associateTableNotes(
      { lines: [{ ...line, text: '^Percent change was greater after treatment.' }] },
      table
    )
  ).toEqual([[]])
  expect(
    associateTableNotes(
      { lines: [{ ...line, text: '^Percent difference, + adjusted relative risk' }] },
      table
    )
  ).toEqual([[]])
})

it('recovers a detached raised marker using the next aligned alphabetic note', () => {
  const line = (text: string, x: number, y: number, width: number, fontSize = 8.4682): object => ({
    text,
    x,
    y,
    width,
    fontSize,
    height: fontSize
  })
  const marker = line('a', 51.0236, 288.1378, 2.8389, 5.6449)
  const body = line('Time on study 58, 86, and 164 days, respectively', 58.1102, 289.0562, 207.51)
  const following = [
    line('b', 51.0236, 300.8937, 3.1755, 5.6449),
    line('Time on study 79, 109, and 110 days, respectively', 58.4504, 301.8121, 229.4)
  ]
  const table = [{ rect: [44, 70, 294.67, 268.04] }]
  const otherColumn = line(
    'An unrelated paragraph in the adjacent column.',
    306.14,
    286.846,
    238.05
  )
  const page = { lines: [otherColumn, marker, body, ...following] }
  expect(associateTableNotes(page, table)[0].map((n: { text: string }) => n.text)).toEqual([
    'a Time on study 58, 86, and 164 days, respectively',
    'b Time on study 79, 109, and 110 days, respectively'
  ])
  expect(associateTableNotes({ lines: [otherColumn, marker, body] }, table)).toEqual([[]])
  const skipped = [line('c', 51.0236, 300.8937, 3.1755, 5.6449), following[1]]
  expect(
    associateTableNotes({ lines: [otherColumn, marker, body, ...skipped] }, table)[0]
  ).not.toContainEqual(expect.objectContaining({ text: expect.stringMatching(/^a Time/) }))
})

it('retains a short unpunctuated abbreviation list below a table closing rule', () => {
  const body = { text: 'Last measurement', x: 10, y: 85, width: 120, height: 9, fontSize: 9 }
  const note = {
    text: 'CI confidence interval, NE non-evaluable',
    x: 10,
    y: 106,
    width: 145,
    height: 9,
    fontSize: 9
  }
  const table = [{ rect: [10, 0, 300, 100] }]
  const rule = [[10, 103, 300, 103]]
  expect(associateTableNotes({ lines: [body, note] }, table, rule)[0]).toContainEqual(
    expect.objectContaining({ text: note.text })
  )
  expect(associateTableNotes({ lines: [body, note] }, table)).toEqual([[]])
  expect(
    associateTableNotes({ lines: [body, { ...note, text: 'CI confidence interval' }] }, table, rule)
  ).toEqual([[]])
})

it('recognizes an unpunctuated Note prefix and its following lettered note', () => {
  const line = (text: string, y: number, fontSize = 9, x = 10, width = 240): object => ({
    text,
    y,
    x,
    width,
    fontSize,
    height: fontSize
  })
  const page = {
    lines: [
      line('Note The data refer to the assigned treatment arm.', 110),
      line('Participants could switch to the alternate arm', 121),
      line('under the study protocol.', 132),
      line('a', 146, 6, 10, 3),
      line('Two participants discontinued treatment.', 147, 9, 16),
      line('They remained in the original analysis group.', 158),
      line('A new body paragraph starts here.', 186, 11)
    ]
  }
  const table = [{ rect: [0, 0, 300, 100] }]
  expect(associateTableNotes(page, table)[0].map((n: { text: string }) => n.text)).toEqual([
    'Note The data refer to the assigned treatment arm. Participants could switch to the alternate arm under the study protocol.',
    'a Two participants discontinued treatment. They remained in the original analysis group.'
  ])
  expect(
    associateTableNotes(
      { lines: [line('Note The data refer to the assigned treatment arm.', 180)] },
      table
    )
  ).toEqual([[]])
  expect(
    associateTableNotes({ lines: [line('Notebook results were reviewed.', 110)] }, table)
  ).toEqual([[]])
})

it('attaches nearby mixed-case abbreviation pairs only when every key is cited in the table', () => {
  const line = (text: string, y: number): object => ({
    text,
    x: 20,
    y,
    width: 280,
    height: 9,
    fontSize: 9
  })
  const table = [{ rect: [20, 20, 310, 100] }]
  const note = 'nK: natural killer; treg, t regulatory.'
  const page = { lines: [line('nK treg', 45), line(note, 104)] }
  expect(associateTableNotes(page, table)[0].map((n: { text: string }) => n.text)).toEqual([note])
  expect(associateTableNotes({ lines: [line('nK', 45), line(note, 104)] }, table)).toEqual([[]])
  expect(associateTableNotes({ lines: [line('nK treg', 45), line(note, 140)] }, table)).toEqual([
    []
  ])
})
