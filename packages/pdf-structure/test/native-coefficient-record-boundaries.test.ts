import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const footerContext = (
  f: ReturnType<typeof JSON.parse>,
  merged = false
): ReturnType<typeof JSON.parse> => {
  const scale = f.items[0].height / 8,
    raw = f.items.map((i: ReturnType<typeof JSON.parse>) => ({
      str: i.text,
      dir: 'ltr',
      width: (i.rect[2] - i.rect[0]) / scale,
      height: i.height / scale,
      transform: [8, 0, 0, 8, i.rect[0] / scale, 150 - i.baseline / scale],
      fontName: 'f',
      hasEOL: false,
      sourceItem: { ...i.sourceItem }
    })),
    marked: ReturnType<typeof JSON.parse>[] = [],
    fnArray: number[] = [OPS.dependency],
    argsArray: ReturnType<typeof JSON.parse>[] = [['f']],
    rows = Array.from({ length: merged ? 3 : 6 }, () =>
      Array.from({ length: 3 }, () => [] as string[])
    )
  for (const [index, item] of raw.entries()) {
    const i = f.items[index],
      y = i.rect[1] / scale,
      column = Math.floor(i.rect[0] / scale / 100),
      row = y < 29 ? 0 : y < 56 ? 1 : merged ? 2 : y < 82 ? 2 : y < 102 ? 3 : y < 132 ? 4 : 5,
      id = `p0R_mc${index}`
    rows[row]?.[column]?.push(id)
    marked.push({ type: 'beginMarkedContentProps', tag: 'P', id })
    const literal = { ...item }
    delete literal.sourceItem
    marked.push(literal, { type: 'endMarkedContent' })
    fnArray.push(
      OPS.beginMarkedContentProps,
      OPS.setFont,
      OPS.beginText,
      OPS.setTextMatrix,
      OPS.showText,
      OPS.endText,
      OPS.endMarkedContent
    )
    argsArray.push(
      ['P', index],
      ['f', 8],
      null,
      [1, 0, 0, 1, item.transform[4], item.transform[5]],
      [...[]],
      null,
      null
    )
    argsArray[argsArray.length - 3] = [
      [...item.str].map((unicode) => ({
        unicode,
        fontChar: unicode,
        originalCharCode: unicode.codePointAt(0),
        width: 375,
        isInFont: true,
        isSpace: unicode === ' ',
        accent: null
      }))
    ]
  }
  return {
    sourceContent: { items: raw, styles: { f: { vertical: false } } },
    operators: { fnArray, argsArray },
    viewport: {
      transform: [scale, 0, 0, -scale, 0, 150 * scale],
      width: 300 * scale,
      height: 150 * scale
    },
    nativeMarkedSource: {
      fonts: [
        { id: 'f', missingFile: false, isType3Font: false, vertical: false, remeasure: false }
      ],
      markedContent: { items: marked },
      structureTree: {
        role: 'Root',
        children: [
          {
            role: 'Table',
            children: [
              {
                role: 'TBody',
                children: rows.map((cells) => ({
                  role: 'TR',
                  children: cells.map((ids, column) => ({
                    role: column ? 'TD' : 'TH',
                    children: ids.map((id) => ({ type: 'content', id }))
                  }))
                }))
              }
            ]
          }
        ]
      }
    }
  }
}

const runFooter = (
  f: ReturnType<typeof JSON.parse>,
  context = footerContext(f)
): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.items, f.captions, [], f.rules, [], undefined, [], context)

it('rejects a native marker moved across actual text-show with the same marker event sequence', () => {
  const f = footerFixture(),
    context = footerContext(f),
    o = context.operators
  const events = (): ReturnType<typeof JSON.parse> =>
    o.fnArray.flatMap((code: number, n: number) =>
      [OPS.beginMarkedContentProps, OPS.endMarkedContent].includes(code)
        ? [[code, o.argsArray[n]]]
        : []
    )
  const before = JSON.stringify(events()),
    begin = o.fnArray.findIndex(
      (code: number, n: number) => code === OPS.beginMarkedContentProps && o.argsArray[n][1] === 6
    ),
    show = o.fnArray.findIndex((code: number, n: number) => n > begin && code === OPS.showText)
  const [code] = o.fnArray.splice(begin, 1),
    [args] = o.argsArray.splice(begin, 1)
  o.fnArray.splice(show, 0, code)
  o.argsArray.splice(show, 0, args)
  expect(JSON.stringify(events())).toBe(before)
  expect(runFooter(f, context).repairs).not.toContain('native-owned-footer-records-recovered')
})

it('rejects distinct full marked IDs that collide in the operator numeric namespace', () => {
  const f = footerFixture(),
    context = footerContext(f),
    oldId = 'p0R_mc7',
    nextId = 'other_mc6'
  context.nativeMarkedSource.markedContent.items.find((i: { id?: string }) => i.id === oldId).id =
    nextId
  const tree = context.nativeMarkedSource.structureTree.children[0].children[0].children
  tree[2].children[1].children[0].id = nextId
  const op = context.operators.fnArray.findIndex(
    (code: number, n: number) =>
      code === OPS.beginMarkedContentProps && context.operators.argsArray[n][1] === 7
  )
  context.operators.argsArray[op][1] = 6
  expect(runFooter(f, context).repairs).not.toContain('native-owned-footer-records-recovered')
})

it.each(['no-text-show', 'glyph-advance', 'glyph-literal', 'missing-native-font'])(
  'requires the complete native text-show binding with %s',
  (kind) => {
    const f = footerFixture(),
      context = footerContext(f),
      o = context.operators,
      show = o.fnArray.indexOf(OPS.showText)
    if (kind === 'no-text-show') {
      const keep = o.fnArray
        .map((code: number, n: number) => (code === OPS.showText ? -1 : n))
        .filter((n: number) => n >= 0)
      o.fnArray = keep.map((n: number) => o.fnArray[n])
      o.argsArray = keep.map((n: number) => o.argsArray[n])
    }
    if (kind === 'glyph-advance') o.argsArray[show][0][0].width += 1
    if (kind === 'glyph-literal') o.argsArray[show][0][0].unicode = 'X'
    if (kind === 'missing-native-font') context.nativeMarkedSource.fonts[0].missingFile = true
    expect(runFooter(f, context).repairs).not.toContain('native-owned-footer-records-recovered')
  }
)

it('retains a row-major multiline cell when the native tree assigns its lines to one TR', () => {
  const f = footerFixture(),
    stub = ['Number of', 'eligible', 'people in', 'each cohort']
  for (const i of f.items.filter((i: { rect: number[] }) => i.rect[1] >= 62)) {
    const row = [62, 82, 102, 132].indexOf(i.rect[1]),
      column = Math.floor(i.rect[0] / 100)
    if (row < 0) continue
    i.text =
      column === 0
        ? stub[row]
        : row === 0
          ? String(20 + column)
          : row === 1
            ? 'people in'
            : row === 2
              ? 'the study'
              : 'cohort'
    i.sourceItem.text = i.text
    i.rect[2] = i.rect[0] + i.text.length * 3
  }
  const result = runFooter(f, footerContext(f, true))
  expect(result.repairs).not.toContain('native-owned-footer-records-recovered')
  expect(result.grid.at(-1)[0]).toBe('Number of eligible people in each cohort')
})

it.each([
  'missing-context',
  'same-TR',
  'wrong-column',
  'duplicate-content',
  'unknown-MCID',
  'operator-MCID-drift',
  'marked-literal-drift',
  'viewport-drift',
  'tree-getter',
  'noncontiguous-TR'
])('rejects footer tagged evidence with %s', (kind) => {
  const f = footerFixture(),
    context = footerContext(f),
    rows = context.nativeMarkedSource.structureTree.children[0].children[0].children
  if (kind === 'missing-context') delete context.nativeMarkedSource
  if (kind === 'same-TR') context.nativeMarkedSource = footerContext(f, true).nativeMarkedSource
  if (kind === 'wrong-column')
    [rows[2].children[0], rows[2].children[1]] = [rows[2].children[1], rows[2].children[0]]
  if (kind === 'duplicate-content')
    rows[2].children[1].children.push({ ...rows[2].children[0].children[0] })
  if (kind === 'unknown-MCID') rows[2].children[0].children[0].id = 'p0R_mc999'
  if (kind === 'operator-MCID-drift') context.operators.argsArray[1][1] = 999
  if (kind === 'marked-literal-drift')
    context.nativeMarkedSource.markedContent.items.find(
      (i: { str?: string }) => i.str === 'Count'
    ).str = 'changed'
  if (kind === 'viewport-drift') context.viewport.transform[4] = 1
  if (kind === 'tree-getter')
    Object.defineProperty(rows[2], 'role', {
      get() {
        throw Error('must not invoke')
      },
      enumerable: true
    })
  if (kind === 'noncontiguous-TR')
    rows.splice(3, 0, { role: 'TR', children: [{ role: 'TD', children: [] }] })
  expect(runFooter(f, context).repairs).not.toContain('native-owned-footer-records-recovered')
})

const footerFixture = (): ReturnType<typeof JSON.parse> => {
  let index = 0
  const token = (text: string, column: number, y: number): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [column * 100 + 8, y, column * 100 + 8 + text.length * 3, y + 8],
    baseline: y + 8,
    height: 8,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  return {
    table: {
      cropRect: [0, 0, 300, 150],
      structure: {
        objects: [
          ...[0, 1, 2].map((c) => ({
            label: 'table column',
            score: 1,
            rect: [c * 100, 0, (c + 1) * 100, 150]
          })),
          ...[
            [5, 25],
            [30, 50],
            [57, 145]
          ].map(([a, b]) => ({ label: 'table row', score: 1, rect: [0, a, 300, b] })),
          { label: 'table column header', rect: [0, 5, 300, 25] }
        ]
      }
    },
    items: [
      ...['Metric', 'Group A', 'Group B'].map((s, c) => token(s, c, 10)),
      ...['Effect', '1.2', '2.3'].map((s, c) => token(s, c, 35)),
      ...['Count', 'Weight', 'Fixed factor', 'Cohort'].flatMap((s, r) => {
        const y = [62, 82, 102, 132][r]
        return [
          token(s, 0, y),
          ...[1, 2].flatMap((c) => [
            token(r === 0 ? String(20 + c) : 'field ' + r, c, y),
            ...(r === 2 ? [token('continued', c, y + 10)] : [])
          ])
        ]
      })
    ],
    rules: [4, 29, 56, 149].flatMap((y) =>
      [0, 1, 2].map((c) => [c * 100 + 0.5, y, (c + 1) * 100 - 0.5, y])
    ),
    captions: [{ lines: ['Table 1. Anonymous measurements.'], rect: [0, -25, 200, -10] }]
  }
}

it('splits complete native footer records while retaining each field continuation and every origin', () => {
  const f = footerFixture()
  const before = JSON.stringify(f)
  const result = runFooter(f)
  expect(result.grid.slice(-4)).toEqual([
    ['Count', '21', '22'],
    ['Weight', 'field 1', 'field 1'],
    ['Fixed factor', 'field 2 continued', 'field 2 continued'],
    ['Cohort', 'field 3', 'field 3']
  ])
  expect(
    result.cells
      .flatMap((c: { sourceItems?: { index: number }[] }) => c.sourceItems ?? [])
      .map((s: { index: number }) => s.index)
      .sort((a: number, b: number) => a - b)
  ).toEqual(f.items.map((i: { sourceItem: { index: number } }) => i.sourceItem.index))
  expect(result.unassigned).toEqual([])
  expect(result.cropRect).toEqual(f.table.cropRect)
  expect(JSON.stringify(f)).toBe(before)
})

const rejectedFooters: [string, (f: ReturnType<typeof footerFixture>) => void][] = [
  [
    'a foreign source with unknown geometry',
    (f) => {
      f.items.push({
        text: 'foreign',
        rect: [NaN, 103, 1, 111],
        height: 8,
        baseline: 111,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: 100, text: 'foreign' }
      })
    }
  ],
  [
    'column-major multiline cells',
    (f) => {
      const footer = f.items
        .filter((i: { rect: number[] }) => i.rect[1] >= 62)
        .sort(
          (a: { rect: number[] }, b: { rect: number[] }) =>
            a.rect[0] - b.rect[0] || a.rect[1] - b.rect[1]
        )
      footer.forEach((i: { sourceItem: { index: number } }, n: number) => {
        i.sourceItem.index = n + 6
      })
    }
  ],
  [
    'an independent blank-stub record',
    (f) => {
      const at = f.items.findIndex((i: { text: string }) => i.text === 'Cohort')
      f.items.splice(
        at,
        0,
        ...[1, 2].map((c) => ({
          text: 'extra',
          rect: [c * 100 + 8, 122, c * 100 + 23, 130],
          height: 8,
          baseline: 130,
          horizontal: true,
          sourceItem: { pageNumber: 1, index: 0, text: 'extra' }
        }))
      )
      f.items.forEach((i: { sourceItem: { index: number } }, n: number) => {
        i.sourceItem.index = n
      })
    }
  ],
  [
    'a multiline stub within one record',
    (f) => {
      const at = f.items.findIndex((i: { text: string }) => i.text === 'Fixed factor')
      f.items.splice(at + 1, 0, {
        text: 'continued label',
        rect: [8, 112, 53, 120],
        height: 8,
        baseline: 120,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: 0, text: 'continued label' }
      })
      f.items.forEach((i: { sourceItem: { index: number } }, n: number) => {
        i.sourceItem.index = n
      })
    }
  ],
  [
    'a sparse first line',
    (f) => {
      f.items = f.items.filter((i: { text: string }) => i.text !== '21')
    }
  ],
  [
    'an out-of-frame duplicate identity',
    (f) => {
      const i = structuredClone(f.items.find((i: { text: string }) => i.text === 'Count'))
      i.rect = [800, 500, 825, 508]
      i.baseline = 508
      f.items.push(i)
    }
  ],
  [
    'a foreign source crossing the packet edge',
    (f) => {
      f.items.push({
        text: 'foreign',
        rect: [-20, 103, 1, 111],
        height: 8,
        baseline: 111,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: 100, text: 'foreign' }
      })
    }
  ],
  [
    'a field crossing its column lane',
    (f) => {
      f.items.find((i: { text: string }) => i.text === '21').rect[0] = 98
    }
  ],
  [
    'a missing closing fence',
    (f) => {
      f.rules = f.rules.filter((r: number[]) => r[1] !== 149)
    }
  ],
  [
    'an interior native divider',
    (f) => {
      f.rules.push([150, 65, 150, 140])
    }
  ],
  [
    'a caption intersecting the packet',
    (f) => {
      f.captions.push({ lines: ['Table 2. Another table.'], rect: [0, 70, 290, 78] })
    }
  ],
  [
    'a changed native literal',
    (f) => {
      f.items.find((i: { text: string }) => i.text === 'Count').sourceItem.text = 'different'
    }
  ]
]
it.each(rejectedFooters)('keeps the existing footer ownership with %s', (_label, change) => {
  const f = footerFixture()
  change(f)
  expect(runFooter(f).repairs).not.toContain('native-owned-footer-records-recovered')
})

const sparseCaptionedFixture = (): ReturnType<typeof JSON.parse> => {
  let index = 0
  const token = (text: string, column: number, y: number): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [column * 100 + 15, y, column * 100 + 15 + text.length * 4, y + 10],
    baseline: y + 10,
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  return {
    table: {
      cropRect: [0, 0, 400, 170],
      structure: {
        objects: [
          ...[0, 1, 2, 3].map((c) => ({
            label: 'table column',
            rect: [c * 100, 35, (c + 1) * 100, 165]
          })),
          ...[
            [35, 62],
            [70, 98],
            [105, 128],
            [132, 147],
            [148, 164]
          ].map(([y, b]) => ({
            label: 'table row',
            rect: [0, y, 400, b]
          })),
          { label: 'table column header', rect: [0, 35, 400, 62] }
        ]
      }
    },
    items: [
      ...[1, 2, 3].map((c) => token('(' + c + ')', c, 10)),
      ...['Alpha', 'Beta', 'Gamma'].flatMap((name, r) => [
        token(name, 0, 37 + r * 35),
        ...[1, 2, 3]
          .filter((c) => r !== 1 || c !== 3)
          .flatMap((c) => [
            token(r + 1 + '.' + c + (r === 0 ? '**' : ''), c, 37 + r * 35),
            token('(0.' + c + ')', c, 49 + r * 35)
          ])
      ]),
      ...['Enabled', 'Count'].flatMap((name, r) => [
        token(name, 0, 134 + r * 15),
        ...[1, 2, 3].map((c) => token(r ? String(10 + c) : c === 1 ? 'No' : 'Yes', c, 134 + r * 15))
      ])
    ],
    captions: [{ lines: ['Table 1. Anonymous measurements.'], rect: [0, -25, 250, -10] }],
    rules: [8, 35, 132, 165].flatMap((y) =>
      [0, 1, 2, 3].map((c) => [c * 100 + 1, y, (c + 1) * 100 - 1, y])
    )
  }
}

it('recovers the independently ruled header above sparse paired coefficient records', () => {
  const f = sparseCaptionedFixture()
  const before = JSON.stringify(f)
  const result = refineTable(f.table, f.items, f.captions, [], f.rules)
  expect(result.grid[0]).toEqual(['', '(1)', '(2)', '(3)'])
  expect(result.unassigned).toEqual([])
  expect(JSON.stringify(f)).toBe(before)
  expect(
    result.cells
      .filter((c: { row: number }) => c.row === 0)
      .flatMap((c: { sourceItems?: { index: number }[] }) => c.sourceItems ?? [])
      .map((s: { index: number }) => s.index)
  ).toEqual([0, 1, 2])
})

const { recoverNativeRuledCoefficientHeader, recoverNativeOwnedWrappedRow } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-coefficient-record-grid.mjs')).href
)
const leadingHeader = (
  f: ReturnType<typeof sparseCaptionedFixture>
): ReturnType<typeof JSON.parse> =>
  recoverNativeRuledCoefficientHeader(f.table, f.items, f.captions, f.rules)

it.each([0.5, 2])(
  'proves independent column labels at scale %s without assuming their sequence',
  (scale) => {
    const f = sparseCaptionedFixture()
    for (const [n, label] of ['(8)', '(2)', '(7)'].entries()) {
      f.items[n].text = label
      f.items[n].sourceItem.text = label
    }
    for (const object of f.table.structure.objects)
      object.rect = object.rect.map((v: number) => v * scale)
    f.table.cropRect = f.table.cropRect.map((v: number) => v * scale)
    f.rules = f.rules.map((r: number[]) => r.map((v) => v * scale))
    for (const c of f.captions) c.rect = c.rect.map((v: number) => v * scale)
    for (const i of f.items) {
      i.rect = i.rect.map((v: number) => v * scale)
      i.height *= scale
      i.baseline *= scale
    }
    expect(leadingHeader(f)?.items).toHaveLength(3)
    expect(refineTable(f.table, f.items, f.captions, [], f.rules).grid[0]).toEqual([
      '',
      '(8)',
      '(2)',
      '(7)'
    ])
  }
)

it('owns the full leading advance even when the native opening meets its em edge', () => {
  const f = sparseCaptionedFixture()
  for (const i of f.items.slice(0, 3)) {
    i.rect[1] -= 2.00001
    i.rect[3] -= 2.00001
    i.baseline -= 2.00001
  }
  expect(leadingHeader(f)?.rect[1]).toBe(f.items[0].rect[1])
  expect(refineTable(f.table, f.items, f.captions, [], f.rules).grid[0]).toEqual([
    '',
    '(1)',
    '(2)',
    '(3)'
  ])
})

it('keeps the observed caption out of a disjoint leading packet despite baseline roundoff', () => {
  const f = sparseCaptionedFixture()
  const text = f.captions[0].lines[0]
  f.items.unshift({
    text,
    rect: [0, -25, 250, -10 + Number.EPSILON * 16],
    height: 15,
    baseline: -10 + Number.EPSILON * 16,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: 999, text }
  })
  expect(leadingHeader(f)?.items).toHaveLength(3)
  expect(refineTable(f.table, f.items, f.captions, [], f.rules).grid[0]).toEqual([
    '',
    '(1)',
    '(2)',
    '(3)'
  ])
})

it.each([
  'missing header',
  'missing error',
  'missing lane rule',
  'extra lane rule',
  'intersecting source from outside',
  'duplicate source index',
  'different source page',
  'no source identity',
  'nonfinite baseline',
  'crossing gutter',
  'staggered header',
  'competing caption',
  'unknown header text',
  'shifted model lane',
  'foreign source above opening'
])('rejects an incomplete leading coefficient packet: %s', (variant) => {
  const f = sparseCaptionedFixture()
  if (variant === 'missing header') f.items.splice(0, 1)
  if (variant === 'missing error')
    f.items.splice(
      f.items.findIndex((i: { text: string }) => i.text === '(0.2)'),
      1
    )
  if (variant === 'missing lane rule') f.rules.pop()
  if (variant === 'extra lane rule') f.rules.push([1, 30, 99, 30])
  if (
    variant === 'intersecting source from outside' ||
    variant === 'foreign source above opening'
  ) {
    const y = variant === 'foreign source above opening' ? 5 : 25
    f.items.push({
      text: 'Foreign',
      rect: [variant === 'intersecting source from outside' ? -30 : 10, y, 35, y + 10],
      height: 10,
      baseline: y + 10,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: 999, text: 'Foreign' }
    })
  }
  if (variant === 'duplicate source index')
    f.items[1].sourceItem.index = f.items[0].sourceItem.index
  if (variant === 'different source page') f.items[1].sourceItem.pageNumber = 2
  if (variant === 'no source identity') delete f.items[1].sourceItem
  if (variant === 'nonfinite baseline') f.items[1].baseline = Number.NaN
  if (variant === 'crossing gutter') f.items[1].rect[2] = 310
  if (variant === 'staggered header') {
    f.items[1].baseline += 3
    f.items[1].rect[3] += 3
  }
  if (variant === 'competing caption') f.captions.push(structuredClone(f.captions[0]))
  if (variant === 'unknown header text') {
    f.items[1].text = 'Other'
    f.items[1].sourceItem.text = 'Other'
  }
  if (variant === 'shifted model lane') f.table.structure.objects[2].rect[0] += 40
  expect(leadingHeader(f)).toBeUndefined()
})

it('leaves already covered column labels and all other rows unchanged', () => {
  const f = sparseCaptionedFixture()
  f.table.structure.objects = f.table.structure.objects.filter(
    (o: { label: string }) => o.label !== 'table column header'
  )
  f.table.structure.objects.push(
    { label: 'table row', rect: [0, 10, 400, 20] },
    { label: 'table column header', rect: [0, 10, 400, 20] }
  )
  const expected = refineTable(f.table, f.items, f.captions, [], [])
  const result = refineTable(f.table, f.items, f.captions, [], f.rules)
  expect(result.grid[0]).toEqual(expected.grid[0])
  expect(result.grid.filter((r: string[]) => r[1] === '(1)')).toHaveLength(1)
})

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

const fixture = (): ReturnType<typeof JSON.parse> => {
  let index = 0
  const token = (text: string, x: number, y: number): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [x, y, x + text.length * 5, y + 10],
    height: 10,
    baseline: y + 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  return {
    table: {
      cropRect: [0, 0, 400, 150],
      structure: {
        objects: [
          ...[0, 100, 200, 300].map((x) => ({
            label: 'table column',
            rect: [x, 0, x + 100, 150]
          })),
          ...[
            [0, 20],
            [20, 60],
            [70, 100],
            [100, 140]
          ].map(([top, bottom]) => ({
            label: 'table row',
            rect: [0, top, 400, bottom]
          })),
          { label: 'table column header', rect: [0, 0, 400, 20] }
        ]
      }
    },
    items: [
      ...[0, 1, 2, 3].map((c) => token(c ? `Estimate${c}` : 'Measure', c * 100 + 10, 5)),
      ...['Alpha', 'Beta', 'Gamma'].flatMap((name, r) => [
        token(name, 10, 35 + r * 40),
        ...[1, 2, 3].flatMap((c) => [
          token(`${r + 1}.${c}**`, c * 100 + 15, r === 1 ? 64 : 25 + r * 40),
          token(`(0.${c})`, c * 100 + 15, 45 + r * 40)
        ])
      ])
    ],
    rules: [0, 20, 140].map((y) => [0, y, 400, y])
  }
}
const run = (f: ReturnType<typeof fixture>): ReturnType<typeof refineTable> =>
  refineTable(f.table, f.items, [], [], f.rules)
const characters = (text: string): string => [...text.replace(/\s/gu, '')].sort().join('')
const repair = 'native-coefficient-record-boundary-recovered'

it('owns a complete estimate line with its standard errors between two independently complete records', () => {
  const f = fixture()
  const result = run(f)
  expect(result.grid[2]).toEqual(['Beta', '2.1** (0.1)', '2.2** (0.2)', '2.3** (0.3)'])
  expect(result.unassigned).toEqual([])
  expect(result.grid[1]).toEqual(['Alpha', '1.1** (0.1)', '1.2** (0.2)', '1.3** (0.3)'])
  expect(result.grid[3]).toEqual(['Gamma', '3.1** (0.1)', '3.2** (0.2)', '3.3** (0.3)'])
  expect(
    result.cells
      .flatMap((c: { sourceItems: { index: number }[] }) => c.sourceItems.map((i) => i.index))
      .sort((a: number, b: number) => a - b)
  ).toEqual(
    f.items
      .map((i: { sourceItem: { index: number } }) => i.sourceItem.index)
      .sort((a: number, b: number) => a - b)
  )
  expect(characters(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
    characters(f.items.map((i: { text: string }) => i.text).join(''))
  )
})

it('preserves the native record proof at a non-unit scale', () => {
  const scale = 0.5
  const f = fixture()
  f.table.cropRect = f.table.cropRect.map((n: number) => n * scale)
  for (const object of f.table.structure.objects)
    object.rect = object.rect.map((n: number) => n * scale)
  for (const item of f.items) {
    item.rect = item.rect.map((n: number) => n * scale)
    item.height *= scale
    item.baseline *= scale
  }
  f.rules = f.rules.map((r: number[]) => r.map((n) => n * scale))
  expect(run(f).grid[2]).toEqual(['Beta', '2.1** (0.1)', '2.2** (0.2)', '2.3** (0.3)'])
})

it('keeps a stub-only overline and a split literal minus while preserving every original source', () => {
  const f = fixture()
  f.rules.push([10, 73, 50, 73])
  const value = f.items.find((i: { text: string }) => i.text === '2.1**')
  value.rect[0] += 5
  f.items.push({
    ...structuredClone(value),
    text: '−',
    rect: [115, 64, 120, 74],
    sourceItem: { pageNumber: 1, index: 99, text: '−' }
  })
  const result = run(f)
  expect(result.grid[2][1]).toBe('−2.1** (0.1)')
  expect(result.unassigned).toEqual([])
})

it('does not repeat recovery for an already complete record', () => {
  const f = fixture()
  f.table.structure.objects.find(
    (o: { label: string; rect: number[] }) => o.label === 'table row' && o.rect[1] === 70
  ).rect[1] = 60
  const result = run(f)
  expect(result.repairs).not.toContain(repair)
  expect(result.grid[2]).toEqual(['Beta', '2.1** (0.1)', '2.2** (0.2)', '2.3** (0.3)'])
})

const rejected: [string, (f: ReturnType<typeof fixture>) => void][] = [
  [
    'a missing estimate leaf',
    (f) => {
      f.items = f.items.filter((i: { text: string }) => i.text !== '2.2**')
    }
  ],
  [
    'a missing error leaf',
    (f) => {
      f.items = f.items.filter(
        (i: { text: string; rect: number[] }) => !(i.text === '(0.2)' && i.rect[1] === 85)
      )
    }
  ],
  [
    'a data-lane rule separating estimate and error',
    (f) => {
      f.rules.push([100, 80, 400, 80])
    }
  ],
  [
    'a glyph crossing the numeric gutter',
    (f) => {
      f.items.find((i: { text: string }) => i.text === '2.1**').rect[2] = 205
    }
  ],
  [
    'an independent label on the estimate baseline',
    (f) => {
      f.items.push({
        text: 'Other',
        rect: [10, 64, 35, 74],
        baseline: 74,
        height: 10,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: 99, text: 'Other' }
      })
    }
  ],
  [
    'a conflicting predicted span',
    (f) => {
      f.table.structure.objects.push({ label: 'table spanning cell', rect: [100, 60, 200, 100] })
    }
  ],
  [
    'a different neighboring two-line rhythm',
    (f) => {
      for (const i of f.items.filter((i: { text: string }) => i.text.startsWith('1.'))) {
        i.rect[1] -= 4
        i.rect[3] -= 4
        i.baseline -= 4
      }
    }
  ],
  [
    'an estimate already owned by another row',
    (f) => {
      f.table.structure.objects.find(
        (o: { label: string; rect: number[] }) => o.label === 'table row' && o.rect[1] === 20
      ).rect[3] = 70
    }
  ],
  [
    'two model owners for the record stub',
    (f) => {
      f.table.structure.objects.find(
        (o: { label: string; rect: number[] }) => o.label === 'table row' && o.rect[1] === 20
      ).rect[3] = 85
    }
  ],
  [
    'no following complete record',
    (f) => {
      f.items = f.items.filter((i: { rect: number[] }) => i.rect[1] < 100)
    }
  ],
  [
    'missing original identity',
    (f) => {
      delete f.items.find((i: { text: string }) => i.text === '2.1**').sourceItem
    }
  ],
  [
    'a mismatched original literal',
    (f) => {
      f.items.find((i: { text: string }) => i.text === '2.1**').sourceItem.text = 'different'
    }
  ],
  [
    'a reduced-font script lane',
    (f) => {
      const i = f.items.find((i: { text: string }) => i.text === '2.1**')
      i.height = 7
      i.rect[1] = i.rect[3] - 7
    }
  ]
]
it.each(rejected)('refuses recovery with %s', (_name, mutate) => {
  const f = fixture()
  mutate(f)
  expect(run(f).repairs).not.toContain(repair)
})

it.each(['sourceItem', 'sourceSegment', 'sourceToken', 'nested-item', 'nested-segment'])(
  'refuses an out-of-crop %s alias of an original',
  (carrier) => {
    const f = fixture()
    const original = f.items.find((i: { text: string }) => i.text === '2.1**').sourceItem
    const alias: ReturnType<typeof JSON.parse> = {
      text: original.text,
      rect: [700, 500, 730, 510],
      height: 10,
      baseline: 510,
      horizontal: true
    }
    if (carrier === 'nested-item') alias.sourceToken = { sourceItem: original }
    else if (carrier === 'nested-segment')
      alias.sourceToken = { sourceSegment: { ...original, start: 0, end: original.text.length } }
    else alias[carrier] = { ...original }
    f.items.push(alias)
    expect(run(f).repairs).not.toContain(repair)
  }
)

it.each(['sourceSegment', 'sourceToken'])(
  'refuses a second %s carrier on the same native token',
  (carrier) => {
    const f = fixture()
    const item = f.items.find((i: { text: string }) => i.text === '2.1**')
    item[carrier] = { ...item.sourceItem }
    expect(run(f).repairs).not.toContain(repair)
  }
)

it.each(['separate', 'overlapping'])(
  'refuses %s native scalars on one estimate baseline',
  (kind) => {
    const f = fixture()
    const value = f.items.find((i: { text: string }) => i.text === '2.1**')
    value.text = '2.1'
    value.sourceItem.text = value.text
    value.rect[2] = 130
    const rect = kind === 'separate' ? [175, 64, 180, 74] : [115, 64, 120, 74]
    f.items.push({
      text: '2',
      rect,
      height: 10,
      baseline: 74,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: 99, text: '2' }
    })
    expect(run(f).repairs).not.toContain(repair)
  }
)

const ownedWrappedFixture = (column = 1): ReturnType<typeof JSON.parse> => {
  const items: ReturnType<typeof JSON.parse>[] = []
  const lines = [
    ['Name', 'Setting', 'Code'],
    ['Group A', column === 1 ? 'Alpha setting' : 'Alpha', column === 2 ? '21, 32,' : '12'],
    ['', column === 1 ? '(mode)' : '', column === 2 ? '43' : ''],
    ['Group B', 'Beta', '24']
  ]
  const edges = [
    [5, 25],
    [30, 44],
    [44, 58],
    [60, 80]
  ]
  const cells = lines.flatMap((line, row) =>
    line.map((text, col) => {
      const y = [10, 35, 47, 65][row]
      const token = text
        ? {
            text,
            rect: [col * 100 + 8, y, col * 100 + 8 + text.length * 3, y + 8],
            height: 8,
            baseline: y + 8,
            horizontal: true,
            sourceItem: { pageNumber: 1, index: items.length, text }
          }
        : undefined
      if (token) items.push(token)
      return {
        row,
        column: col,
        rowSpan: 1,
        colSpan: 1,
        rect: [col * 100, edges[row][0], (col + 1) * 100, edges[row][1]],
        text,
        sourceTokens: token ? [token] : [],
        sourceRects: token ? [token.rect] : [],
        ...(token ? { sourceItems: [token.sourceItem] } : {})
      }
    })
  )
  return {
    items,
    captions: [],
    rules: [
      [0, 4, 300, 4],
      [0, 85, 300, 85]
    ],
    result: {
      cells,
      grid: lines,
      rows: edges.map(([a, b]) => ({ rect: [0, a, 300, b] })),
      cropRect: [0, 0, 300, 90],
      issues: ['existing-review'],
      unassigned: [],
      clipped: [],
      repairs: [],
      reviewCandidate: false
    }
  }
}
const runOwnedWrapped = (
  f: ReturnType<typeof ownedWrappedFixture>,
  context = footerContext(f)
): ReturnType<typeof JSON.parse> =>
  recoverNativeOwnedWrappedRow?.(
    f.result,
    f.items,
    f.captions,
    f.rules,
    (fonts: { text: string }[]) => fonts.map((i) => i.text).join(' '),
    context
  ) ?? f.result

it.each([1, 2])('joins an already-owned native field continuation in column %s', (column) => {
  const f = ownedWrappedFixture(column),
    before = structuredClone(f)
  const result = runOwnedWrapped(f)
  expect(result.grid).toEqual([
    f.result.grid[0],
    [
      'Group A',
      column === 1 ? 'Alpha setting (mode)' : 'Alpha',
      column === 2 ? '21, 32, 43' : '12'
    ],
    f.result.grid[3]
  ])
  const origins = (r: ReturnType<typeof JSON.parse>): unknown[] =>
    r.cells
      .flatMap((c: { sourceItems?: { index: number }[] }) => c.sourceItems ?? [])
      .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
  expect(origins(result)).toEqual(origins(f.result))
  for (const field of ['cropRect', 'issues', 'unassigned', 'clipped', 'reviewCandidate'])
    expect(result[field]).toEqual(f.result[field])
  expect(result.cells.filter((c: { row: number }) => c.row === 0)).toEqual(
    f.result.cells.filter((c: { row: number }) => c.row === 0)
  )
  expect(
    result.cells
      .filter((c: { row: number }) => c.row === 2)
      .map((c: { row: number }) => ({ ...c, row: 3 }))
  ).toEqual(f.result.cells.filter((c: { row: number }) => c.row === 3))
  expect(f).toEqual(before)
})

it.each([
  'independent-TR',
  'missing-source',
  'foreign-source',
  'crossing-span',
  'foreign-caption',
  'crossing-rule'
])('retains owned rows with %s', (kind) => {
  const f = ownedWrappedFixture(),
    context = footerContext(f),
    tree = context.nativeMarkedSource.structureTree.children[0].children[0].children
  if (kind === 'independent-TR') {
    const field = tree[1].children[1],
      tail = field.children.pop()
    tree.splice(2, 0, {
      role: 'TR',
      children: [
        { role: 'TH', children: [] },
        { role: 'TD', children: [tail] },
        { role: 'TD', children: [] }
      ]
    })
  }
  if (kind === 'missing-source')
    f.result.cells.find(
      (c: { row: number; column: number }) => c.row === 2 && c.column === 1
    ).sourceItems = []
  if (kind === 'foreign-source') {
    const item = structuredClone(f.items[6])
    item.sourceItem.index = 100
    f.items.push(item)
  }
  if (kind === 'crossing-span') f.result.cells[0].rowSpan = 3
  if (kind === 'foreign-caption')
    f.captions = [{ rect: [0, 30, 300, 58], lines: ['Table 2. Foreign.'] }]
  if (kind === 'crossing-rule') f.rules.push([0, 45, 300, 45])
  expect(runOwnedWrapped(f, context)).toBe(f.result)
})
