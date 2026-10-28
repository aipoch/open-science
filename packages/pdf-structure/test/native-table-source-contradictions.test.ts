import { it as test } from 'vitest'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { accent, bar, group, stacked, lanes, cycle, formula, continuation } = await import(
  pathToFileURL(resolve('test/fixtures/open-native-table-contradictions.mjs')).href
)
const { nativeTableLayoutConflicts: conflicts } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-layout-conflicts.mjs')).href
)
const { reviewFinalNativeTableSources: review, nativeTableSourceConflicts } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href
)
const { signedScriptRows, addScriptRowPaint } = await import(
  pathToFileURL(resolve('test/fixtures/open-native-table-contradictions.mjs')).href
)
type Fixture = ReturnType<typeof JSON.parse>
const mathWitnesses = (f: Fixture, kind = 'accent'): unknown =>
  f.target.sourceItems.slice(1, kind === 'overbar' ? 2 : 3)
const specs: [string, () => Fixture, string][] = [
  ['accent', accent, 'native-overlapping-mathematical-mark'],
  ['overbar', bar, 'native-vector-mathematical-mark-omitted'],
  ['group span', group, 'native-printed-group-span-contradiction'],
  ['uncertainty records', stacked, 'native-uncertainty-records-collapsed'],
  ['independent lanes', lanes, 'native-independent-numeric-header-lanes-collapsed'],
  ['section cycle', cycle, 'native-section-label-crosses-repeated-cycle'],
  ['mathematical group', formula, 'native-mathematical-group-split-between-leaves'],
  ['terminal continuation', continuation, 'native-terminal-numbered-record-continuation-split']
]
for (const [name, make, marker] of specs)
  test('retains complete original source while rejecting ' + name, () => {
    const f = make(),
      before = structuredClone(f.table),
      reason = conflicts(f.table, f.tokens, f.rules, [], f.context)
    assert(reason.includes(marker), name + ': ' + reason)
    const out = review(f.table, f.tokens, f.rules, [], f.context)
    assert(out.issues.includes('native-table-structure-ambiguous'))
    assert.equal(out.cells, f.cells)
    assert.equal(out.grid, f.grid)
    assert.equal(out.cropRect, f.table.cropRect)
    assert.equal(out.thumbnail, f.table.thumbnail)
    assert.equal(out.notes, f.table.notes)
    if (name === 'accent' || name === 'overbar')
      assert.deepEqual(out.unreliableMathSourceItems, mathWitnesses(f, name))
    else assert.equal(out.unreliableMathSourceItems, undefined)
    assert.deepEqual(f.table, before)
  })

test('collects mathematical origins after an earlier independent crop conflict', () => {
  const f = accent()
  f.add(1, 1, [['Unrelated clipped label', 450, 80, 30]])
  assert(
    nativeTableSourceConflicts(f.table, f.tokens, true).includes(
      'assigned-source-outside-final-crop'
    )
  )
  const before = JSON.stringify(f.table),
    out = review(f.table, f.tokens, [], [], f.context)
  assert.deepEqual(out.unreliableMathSourceItems, mathWitnesses(f))
  assert.equal(JSON.stringify(f.table), before)
})

test('keeps mathematical evidence inside its own grouped table part', () => {
  const f = accent(),
    other = lanes()
  for (const font of other.tokens) font.sourceItem.index += 1000
  const input = { page: 1, cropRect: f.table.cropRect, parts: [f.table, other.table] },
    before = JSON.stringify(input)
  const out = review(input, [...f.tokens, ...other.tokens], [], [], f.context)
  assert.deepEqual(out.parts[0].unreliableMathSourceItems, mathWitnesses(f))
  assert.equal(out.parts[1].unreliableMathSourceItems, undefined)
  assert.equal(out.unreliableMathSourceItems, undefined)
  assert.equal(JSON.stringify(input), before)
})

test('does not retain stale mathematical claims without the original raised relation', () => {
  const f = accent(),
    proved = review(f.table, f.tokens, [], [], f.context)
  f.tokens[1].baseline = f.tokens[2].baseline
  f.tokens[1].rect[1] = 20
  f.tokens[1].rect[3] = 30
  const out = review(proved, f.tokens, [], [], f.context)
  assert.equal(out.unreliableMathSourceItems, undefined)
  assert.deepEqual(out.issues, proved.issues)
})
const controls: [string, () => Fixture, (f: Fixture) => void, string][] = [
  [
    'inline mark',
    accent,
    (f) => {
      f.tokens[1].baseline = f.tokens[2].baseline
      f.tokens[1].rect = [34, 20, 40, 30]
    },
    specs[0][2]
  ],
  [
    'represented combining mark',
    accent,
    (f) => {
      f.target.text = 'Min. β̂m'
    },
    specs[0][2]
  ],
  [
    'ordinary superscript',
    accent,
    (f) => {
      f.tokens[1].height = 7
    },
    specs[0][2]
  ],
  [
    'valid group span',
    group,
    (f) => {
      f.target.column = 1
      f.target.colSpan = 2
    },
    specs[2][2]
  ],
  [
    'missing native rule',
    group,
    (f) => {
      f.context.rulePaintBounds.clear()
    },
    specs[2][2]
  ],
  [
    'white group rule',
    group,
    (f) => {
      f.context.operators.argsArray[0][0] = '#ffffff'
    },
    specs[2][2]
  ],
  [
    'inline minus rule',
    bar,
    (f) => {
      f.rules[0][1] = f.rules[0][3] = 32
    },
    specs[1][2]
  ],
  [
    'unproved bar paint',
    bar,
    (f) => {
      f.context.rulePaintBounds.clear()
    },
    specs[1][2]
  ],
  [
    'only two uncertainty columns',
    stacked,
    (f) => {
      f.cells.splice(4)
    },
    specs[3][2]
  ],
  [
    'only two independent rows',
    lanes,
    (f) => {
      f.cells.pop()
    },
    specs[4][2]
  ],
  [
    'correct cycle ownership',
    cycle,
    (f) => {
      f.target.row = 3
      f.target.rowSpan = 2
    },
    specs[5][2]
  ],
  [
    'nonrepeating numeric sequence',
    cycle,
    (f) => {
      f.tokens.find((t: Fixture) => t.sourceItem.index === 0).text = '9'
    },
    specs[5][2]
  ],
  [
    'no mathematical delimiter',
    formula,
    (f) => {
      f.target.text = 'Independent'
    },
    specs[6][2]
  ],
  [
    'new terminal numbered stub',
    continuation,
    (f) => {
      f.target.text = 'P5 A new record'
      f.tokens.at(-1).text = f.tokens.at(-1).sourceItem.text = 'P5'
    },
    specs[7][2]
  ],
  [
    'different native continuation indent',
    continuation,
    (f) => {
      f.tokens.at(-1).rect[0] += 30
      f.tokens.at(-1).rect[2] += 30
    },
    specs[7][2]
  ]
]
for (const [name, make, change, marker] of controls)
  test('abstains with ' + name, () => {
    const f = make()
    change(f)
    assert(!conflicts(f.table, f.tokens, f.rules, [], f.context).includes(marker), name)
  })

for (const [name, make, marker] of specs)
  test('abstains without unique native ownership for ' + name, () => {
    const f = make()
    f.tokens.push(structuredClone(f.tokens[0]))
    assert(!conflicts(f.table, f.tokens, f.rules, [], f.context).includes(marker))
  })

for (const mode of [
  'missing renderer',
  'missing source',
  'missing font',
  'missing outline',
  'wrong literal',
  'detached source',
  'wrong source hash',
  'wrong transform',
  'different operations'
])
  test('numbered tail abstains with ' + mode, () => {
    const f = continuation(),
      c = f.context,
      p = c.nativeGlyphContext
    if (mode === 'missing renderer') delete c.nativeGlyphContext
    if (mode === 'missing source') delete c.sourceContent
    if (mode === 'missing font') delete c.sourceContent.styles.F
    if (mode === 'missing outline') p.glyphBounds[0].glyphs.pop()
    if (mode === 'wrong literal') p.content.items[0].str = 'Other'
    if (mode === 'detached source') c.sourceContent.items[0].sourceItem.index = 1000
    if (mode === 'wrong source hash') p.sourceSha256 = 'b'.repeat(64)
    if (mode === 'wrong transform') {
      c.viewport = structuredClone(c.viewport)
      c.viewport.transform[0] = 2
    }
    if (mode === 'different operations') {
      c.operators = structuredClone(c.operators)
      c.operators.argsArray[0][0] = '#ffffff'
    }
    assert(!conflicts(f.table, f.tokens, f.rules, [], f.context).includes(specs[7][2]), mode)
  })

const {
  mergedRecordPackets,
  splitWrappedRecordPackets,
  priorRecordTailPacket,
  splitValueLanePacket,
  splitHeaderLanePacket,
  ordinaryWrappedTwoLanePacket,
  wrappedWordPrefixPacket
} = await import(pathToFileURL(resolve('test/fixtures/native-record-packets.mjs')).href)
const packetSpecs: [string, () => Fixture, string][] = [
  ['merged row packets', mergedRecordPackets, 'native-independent-row-packets-merged'],
  [
    'split wrapped packet',
    splitWrappedRecordPackets,
    'native-wrapped-column-packet-split-across-rows'
  ],
  ['preceding record tail', priorRecordTailPacket, 'native-prior-record-tail-assigned-to-next-row'],
  ['split value lane', splitValueLanePacket, 'native-single-value-lane-published-as-two-leaves'],
  ['split header lane', splitHeaderLanePacket, 'native-whole-header-split-into-empty-value-lane'],
  [
    'wrapped word prefix',
    wrappedWordPrefixPacket,
    'native-wrapped-word-prefix-assigned-to-adjacent-column'
  ]
]
for (const [name, make, marker] of packetSpecs)
  test('retains original source while blocking ' + name, () => {
    const f = make(),
      before = structuredClone(f.table)
    assert(conflicts(f.table, f.tokens, [], [], f.context).includes(marker))
    const out = review(f.table, f.tokens, [], [], f.context)
    assert(out.issues.includes('native-table-structure-ambiguous'))
    for (const field of ['cells', 'grid', 'cropRect', 'thumbnail', 'notes'])
      assert.equal(out[field], f.table[field])
    assert.equal(out.unreliableMathSourceItems, undefined)
    assert.deepEqual(f.table, before)
  })

test('retains a normal wrapped cell painted after its top-aligned peer', () => {
  const f = ordinaryWrappedTwoLanePacket()
  assert.deepEqual(conflicts(f.table, f.tokens, [], [], f.context), [])
  assert.equal(review(f.table, f.tokens, [], [], f.context), f.table)
})
test('does not infer wrapped grouping from independent blank-stub records', () => {
  const f = splitWrappedRecordPackets(false)
  assert.deepEqual(conflicts(f.table, f.tokens, [], [], f.context), [])
  assert.equal(review(f.table, f.tokens, [], [], f.context), f.table)
})

test('keeps a complete hyphenated word inside its own wrapped cell', () => {
  const f = wrappedWordPrefixPacket(true)
  assert.deepEqual(conflicts(f.table, f.tokens, [], [], f.context), [])
  assert.equal(review(f.table, f.tokens, [], [], f.context), f.table)
})

const wordPrefixControls: [string, (f: Fixture) => void][] = [
  [
    'missing lane calibration after the record',
    (f) => {
      for (const c of f.cells.filter((c: Fixture) => c.row === 3 && c.column > 0)) {
        c.sourceItems = []
        c.sourceRects = []
        c.text = ''
      }
    }
  ],
  [
    'missing native font',
    (f) => {
      delete f.context.sourceContent.styles.F
    }
  ],
  [
    'different native literal',
    (f) => {
      f.wrong.sourceItems = structuredClone(f.wrong.sourceItems)
      f.wrong.sourceItems[0].text = 'different-'
    }
  ],
  [
    'incomplete native rectangle',
    (f) => {
      f.wrong.sourceRects = structuredClone(f.wrong.sourceRects)
      f.wrong.sourceRects[0][2] -= 1
    }
  ],
  [
    'declared spanning column',
    (f) => {
      f.wrong.colSpan = 2
    }
  ],
  [
    'intervening native source',
    (f) => {
      f.token('External', 270, 60)
      f.tokens.splice(f.tokens.indexOf(f.tail), 0, f.tokens.pop())
      f.tokens.forEach((t: Fixture, i: number) => {
        t.sourceItem.index = i
      })
      f.finish()
    }
  ],
  [
    'prefix printed inside the foreign column',
    (f) => {
      for (const r of [f.prefix.rect, f.prefix.nativeLabelRect]) {
        r[0] += 40
        r[2] += 40
      }
      f.finish()
    }
  ]
]
for (const [name, change] of wordPrefixControls)
  test('does not infer wrapped word ownership with ' + name, () => {
    const f = wrappedWordPrefixPacket()
    change(f)
    assert(
      !conflicts(f.table, f.tokens, [], [], f.context).includes(
        'native-wrapped-word-prefix-assigned-to-adjacent-column'
      )
    )
  })

const packetControls: [string, () => Fixture, (f: Fixture) => void, string][] = [
  [
    'missing native font',
    mergedRecordPackets,
    (f) => {
      delete f.context.sourceContent.styles.F
    },
    packetSpecs[0][2]
  ],
  [
    'column-major wrapped labels',
    mergedRecordPackets,
    (f) => {
      const order = [0, 1, 2, 3, 4, 5, 6, 9, 7, 10, 8, 11, 12, 13, 14]
      f.tokens = order.map((i) => f.tokens[i])
      f.tokens.forEach((t: Fixture, i: number) => {
        t.sourceItem.index = i
      })
      f.finish()
    },
    packetSpecs[0][2]
  ],
  [
    'declared spanning stub',
    splitWrappedRecordPackets,
    (f) => {
      f.cells.find((c: Fixture) => c.row === 2 && c.column === 0).rowSpan = 2
    },
    packetSpecs[1][2]
  ],
  [
    'inconsistent intact wrapped calibration',
    splitWrappedRecordPackets,
    (f) => {
      for (const t of f.tokens.filter((t: Fixture) => t.text.startsWith('complete third'))) {
        t.baseline += 1
        t.rect[1] += 1
        t.rect[3] += 1
        t.nativeLabelRect[1] += 1
        t.nativeLabelRect[3] += 1
      }
      f.finish()
    },
    packetSpecs[1][2]
  ],
  [
    'different original page',
    priorRecordTailPacket,
    (f) => {
      for (const t of f.tokens) t.sourceItem.pageNumber = 2
    },
    packetSpecs[2][2]
  ],
  [
    'different original literal',
    splitValueLanePacket,
    (f) => {
      const origin = f.cells.find((c: Fixture) => c.row === 1 && c.column === 3).sourceItems[0]
        .index
      for (const cell of f.cells.filter((c: Fixture) =>
        c.sourceItems?.some((s: Fixture) => s.index === origin)
      )) {
        cell.sourceItems = structuredClone(cell.sourceItems)
        cell.sourceItems.find((s: Fixture) => s.index === origin).text = 'Different'
      }
    },
    packetSpecs[3][2]
  ],
  [
    'correctly spanning parent',
    splitValueLanePacket,
    (f) => {
      const head = f.cells.find((c: Fixture) => c.row === 0 && c.column === 4)
      head.column = 3
      head.colSpan = 2
    },
    packetSpecs[3][2]
  ],
  [
    'independent coverage heading',
    splitValueLanePacket,
    (f) => {
      const head = f.cells.find((c: Fixture) => c.row === 0 && c.column === 3),
        t = f.token('Coverage', 240, 20)
      head.text = t.text
      head.sourceItems = [t.sourceItem]
      head.sourceRects = [t.rect]
      f.finish()
    },
    packetSpecs[3][2]
  ],
  [
    'incomplete native partition',
    splitValueLanePacket,
    (f) => {
      f.cells.find((c: Fixture) => c.row === 1 && c.column === 3).sourceRects[0][2] -= 1
    },
    packetSpecs[3][2]
  ],
  [
    'non-unique native header',
    splitHeaderLanePacket,
    (f) => {
      const origin = f.cells.find((c: Fixture) => c.row === 1 && c.column === 1).sourceItems[0]
        .index
      f.tokens.push(structuredClone(f.tokens[origin]))
    },
    packetSpecs[4][2]
  ],
  [
    'independent populated value lanes',
    splitHeaderLanePacket,
    (f) => {
      for (const cell of f.cells.filter((c: Fixture) => c.row > 1)) {
        if (cell.column === 1) {
          const t = f.tokens[cell.sourceItems[0].index]
          t.rect[2] = 115
          t.nativeLabelRect[2] = 115
        } else if (cell.column === 2) {
          const t = f.token('0.2', 125, 40 + cell.row * 12, 30)
          cell.text = t.text
          cell.sourceItems = [t.sourceItem]
          cell.sourceRects = [t.rect]
        }
      }
      f.finish()
    },
    packetSpecs[4][2]
  ]
]
for (const [name, make, change, marker] of packetControls)
  test('retains the proposed layout with ' + name, () => {
    const f = make()
    change(f)
    assert(!conflicts(f.table, f.tokens, [], [], f.context).includes(marker), name)
  })

const scriptMarker = 'native-signed-script-crosses-table-rows'
test('retains source and pauses a grid that splits a complete two-sided native script', () => {
  const f = signedScriptRows(),
    before = structuredClone(f.table),
    out = review(f.table, f.tokens, [], [], f.context)
  assert(conflicts(f.table, f.tokens, [], [], f.context).includes(scriptMarker))
  assert(out.issues.includes('native-table-structure-ambiguous'))
  assert.equal(out.reviewCandidate, false)
  assert.equal(out.cells, f.cells)
  assert.equal(out.grid, f.grid)
  assert.equal(out.cropRect, f.table.cropRect)
  assert.equal(out.thumbnail, f.table.thumbnail)
  assert.equal(out.unreliableMathSourceItems, undefined)
  assert.deepEqual(f.table, before)
})

const scriptControls: [string, (f: Fixture) => void][] = [
  [
    'an independent signed value aligned with its own record',
    (f) => {
      for (const t of [f.script.sign, f.script.upper]) {
        t.baseline = f.script.previous.baseline
        t.rect[1] = t.baseline - t.height
        t.rect[3] = t.baseline
      }
      f.finish()
    }
  ],
  [
    'ordinary wrapped small text in the previous lane',
    (f) => {
      const dx = 150 - f.script.sign.rect[0]
      for (const t of [f.script.sign, f.script.upper]) {
        t.rect[0] += dx
        t.rect[2] += dx
      }
      f.finish()
    }
  ],
  [
    'all script parts correctly owned by one cell',
    (f) => {
      const a = f.cells.find((c: Fixture) => c.row === 1 && c.column === 2),
        b = f.cells.find((c: Fixture) => c.row === 2 && c.column === 2)
      a.sourceItems.splice(1)
      a.sourceRects.splice(1)
      a.text = 'prior'
      b.sourceItems.splice(2, 0, f.script.sign.sourceItem, f.script.upper.sourceItem)
      b.sourceRects.splice(2, 0, f.script.sign.rect, f.script.upper.rect)
      b.text = 'ratio x − j k'
    }
  ],
  [
    'no independent following record calibration',
    (f) => {
      for (let i = f.cells.length - 1; i >= 0; i--) if (f.cells[i].row === 3) f.cells.splice(i, 1)
    }
  ],
  ['incomplete glyph fonts', (f) => (f.context.nativeGlyphContext.glyphBounds = [])],
  [
    'a different renderer source',
    (f) => (f.context.nativeGlyphContext.sourceSha256 = 'b'.repeat(64))
  ],
  ['a changed native height with the same rectangle', (f) => (f.script.sign.height += 0.01)],
  ['a changed native baseline with the same rectangle', (f) => (f.script.sign.baseline += 0.01)],
  [
    'foreign glyph ink inside the script',
    (f) => {
      f.token('ink', 215, 51, 5)
      f.finish()
    }
  ],
  ['an oversized native inventory', (f) => (f.tokens = Array(4097).fill(f.tokens[0]))],
  ...['white', 'transparent', 'thick', 'thin', 'missing-bounds'].map(
    (kind): [string, (f: Fixture) => void] => [
      kind + ' native paint',
      (f) => addScriptRowPaint(f, kind)
    ]
  )
]
for (const [name, change] of scriptControls)
  test('does not infer a split mathematical record with ' + name, () => {
    const f = signedScriptRows()
    change(f)
    assert(!conflicts(f.table, f.tokens, [], [], f.context).includes(scriptMarker))
  })

test('distinguishes a captured empty path from a nonempty path with missing bounds', () => {
  const f = addScriptRowPaint(signedScriptRows(), 'empty')
  assert(conflicts(f.table, f.tokens, [], [], f.context).includes(scriptMarker))
})

const { rightAlignedCollapsedLanes } = await import(
  pathToFileURL(resolve('test/fixtures/native-record-packets.mjs')).href
)
const printedSpecs: [string, () => Fixture, string][] = [
  [
    'two independently headed right-aligned numeric lanes',
    rightAlignedCollapsedLanes,
    'native-right-aligned-headed-numeric-lanes-collapsed'
  ]
]
for (const [name, make, marker] of printedSpecs)
  test('pauses mapping for ' + name + ' and preserves the native table', () => {
    const f = make(),
      before = structuredClone(f.table)
    assert(conflicts(f.table, f.tokens, f.rules, [], f.context).includes(marker))
    const result = review(f.table, f.tokens, f.rules, [], f.context)
    assert(result.issues.includes('native-table-structure-ambiguous'))
    assert.equal(result.cells, f.cells)
    assert.equal(result.grid, f.grid)
    assert.equal(result.cropRect, f.table.cropRect)
    assert.equal(result.thumbnail, f.table.thumbnail)
    assert.deepEqual(f.table, before)
  })

const printedControls: [string, () => Fixture, (f: Fixture) => void, string][] = [
  [
    'a complete single parent heading',
    rightAlignedCollapsedLanes,
    (f) => {
      const head = f.cells.find((c: Fixture) => c.row === 0 && c.column === 1)
      const t = f.token('Combined', 100, 20, 90)
      head.text = t.text
      head.sourceItems = [t.sourceItem]
      head.sourceRects = [t.rect]
      head.colSpan = 2
      f.finish()
    },
    printedSpecs[0][2]
  ],
  [
    'an uncalibrated right edge',
    rightAlignedCollapsedLanes,
    (f) => {
      f.tokens.at(-1).rect[2] -= 2
      f.finish()
    },
    printedSpecs[0][2]
  ],
  [
    'only two independent records',
    rightAlignedCollapsedLanes,
    (f) => {
      f.cells.splice(f.cells.findIndex((c: Fixture) => c.row === 3))
      f.table.grid.pop()
    },
    printedSpecs[0][2]
  ],
  ...['white', 'transparent'].map((kind): [string, () => Fixture, (f: Fixture) => void, string] => [
    kind + ' enclosing rule',
    rightAlignedCollapsedLanes,
    (f) => {
      const ops = f.context.operators
      for (let i = ops.fnArray.length - 1; i >= 0; i--) {
        if (kind === 'white' && ops.fnArray[i] === OPS.setStrokeRGBColor)
          ops.argsArray[i] = ['#ffffff']
        if (kind === 'transparent' && ops.fnArray[i] === OPS.constructPath) {
          ops.fnArray.splice(i, 0, OPS.setGState)
          ops.argsArray.splice(i, 0, [[['CA', 0]]])
        }
      }
    },
    printedSpecs[0][2]
  ]),
  ...printedSpecs.map(([, make, marker]): [string, () => Fixture, (f: Fixture) => void, string] => [
    'missing original font binding',
    make,
    (f) => {
      f.context.sourceContent.styles = {}
    },
    marker
  ])
]
for (const [name, make, change, marker] of printedControls)
  test('does not infer a printed-record conflict with ' + name, () => {
    const f = make()
    change(f)
    assert(!conflicts(f.table, f.tokens, f.rules, [], f.context).includes(marker))
  })

const { filledOverheadMark } = await import(
  pathToFileURL(resolve('test/fixtures/native-record-packets.mjs')).href
)
test('pauses a nonlinear overhead mathematical mark with separate complete filled-ink evidence', () => {
  const f = filledOverheadMark(),
    before = structuredClone(f.table)
  const out = review(f.table, f.tokens, f.rules, [], f.context)
  assert(out.issues.includes('native-table-structure-ambiguous'))
  assert.deepEqual(out.unreliableMathSourceItems, f.target.sourceItems.slice(0, 2))
  assert.equal(out.cells, f.cells)
  assert.equal(out.grid, f.grid)
  assert.equal(out.thumbnail, f.table.thumbnail)
  assert.deepEqual(f.table, before)
})

for (const [name, change] of [
  [
    'missing precision certificate',
    (f: Fixture) => {
      delete f.context.nativeGlyphContext.filledGlyphEvidence
    }
  ],
  [
    'different outline font',
    (f: Fixture) => {
      f.context.nativeGlyphContext.filledGlyphEvidence.glyphs[0].fontName = 'Other'
    }
  ],
  [
    'real ink reaching the coarse origin',
    (f: Fixture) => {
      f.context.nativeGlyphContext.filledGlyphEvidence.glyphs[0].filledBounds[1] = 0
    }
  ],
  [
    'no mathematical continuation',
    (f: Fixture) => {
      f.target.row = 0
    }
  ],
  [
    'transparent native paint',
    (f: Fixture) => {
      for (const ops of [f.context.operators, f.context.nativeGlyphContext.operators]) {
        ops.fnArray.splice(1, 0, OPS.setGState)
        ops.argsArray.splice(1, 0, [[['ca', 0]]])
      }
    }
  ]
] as [string, (f: Fixture) => void][])
  test('does not infer a filled mathematical mark with ' + name, () => {
    const f = filledOverheadMark()
    change(f)
    assert(
      !conflicts(f.table, f.tokens, f.rules, [], f.context).includes(
        'native-filled-overhead-mathematical-mark'
      )
    )
  })

const { collectFilledGlyphEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-filled-glyph-evidence.mjs')).href
)
const { Path2D } = await import('@napi-rs/canvas')
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
test('computes optional filled bounds without changing a cached outline or coarse bounds', () => {
  const f = filledOverheadMark(),
    n = f.context.nativeGlyphContext
  const path = new Path2D('M0 0L0 0M0 .65L.4 .65L.4 .73L0 .73Z')
  n.glyphBounds[0].glyphs.find((g: Fixture) => g.fontChar === 'z').bounds = Array.from(
    path.getBounds()
  )
  const before = path.toSVGString(),
    coarse = structuredClone(n.glyphBounds)
  const font = {
    loadedName: 'F',
    missingFile: false,
    isInvalidPDFjsFont: false,
    isType3Font: false,
    data: new Uint8Array([1]),
    fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    toFontChar: { 122: 122 },
    getPathGenerator: () => path
  }
  const run = (budget = 65536): Fixture =>
    collectFilledGlyphEvidence(
      n.content,
      n.operators,
      { get: () => font },
      n.glyphBounds,
      { sourceSha256: n.sourceSha256, pageNumber: 1 },
      budget
    )
  assert.equal(run().computedGlyphs, 1)
  assert(run().glyphs[0].filledBounds[1] > 0.6)
  assert.equal(run(1), undefined)
  assert.equal(path.toSVGString(), before)
  font.missingFile = true
  assert.equal(run(), undefined)
  font.missingFile = false
  path.rect(0, 0, 0.01, 0.01)
  assert.equal(run(), undefined)
  assert.deepEqual(n.glyphBounds, coarse)
})

const { straightPaintClear } = await import(
  pathToFileURL(resolve('resources/literature-pdf-filled-accent-conflicts.mjs')).href
)
test('keeps conservative paint bounds for a diagonal square-capped stroke', () => {
  const packet = {
    strokeMargins: new Map([[0, 10]]),
    evidence: {
      paths: new Map([
        [0, { transform: [1, 0, 0, 1, 0, 0], lineWidth: 100, solidStroke: true, lineCap: 2 }]
      ]),
      images: []
    },
    o: { argsArray: [[OPS.stroke, [[0, 0, 0, 1, 10, 10]], [0, 0, 10, 10]]] },
    v: { transform: [1, 0, 0, 1, 0, 0] },
    finite: (a: number[], n: number): boolean =>
      Array.isArray(a) && a.length === n && a.every(Number.isFinite),
    valid: (r: number[]): boolean => r[0] < r[2] && r[1] < r[3],
    box: (r: number[]): number[] => r
  }
  assert.equal(straightPaintClear(packet, [69, 9, 70, 11], 1), false)
  assert.equal(packet.strokeMargins.get(0), 10)
})

const { parallelAssignmentRows, splitWrappedHierarchy } = await import(
  pathToFileURL(resolve('test/fixtures/native-record-packets.mjs')).href
)
for (const [name, make, marker] of [
  ['parallel assignments', parallelAssignmentRows, 'native-parallel-assignment-rows-collapsed'],
  ['split wrapped hierarchy', splitWrappedHierarchy, 'native-wrapped-hierarchy-crosses-record-row']
] as [string, () => Fixture, string][])
  test('keeps original image and sources while blocking ' + name, () => {
    const f = make(),
      before = structuredClone(f.table)
    assert(conflicts(f.table, f.tokens, f.rules, [], f.context).includes(marker))
    const out = review(f.table, f.tokens, f.rules, [], f.context)
    assert(out.issues.includes('native-table-structure-ambiguous'))
    for (const field of ['cells', 'grid', 'cropRect', 'thumbnail', 'notes'])
      assert.equal(out[field], f.table[field])
    assert.deepEqual(f.table, before)
  })

for (const [name, make, marker] of [
  ['parallel assignment', parallelAssignmentRows, 'native-parallel-assignment-rows-collapsed'],
  ['wrapped hierarchy', splitWrappedHierarchy, 'native-wrapped-hierarchy-crosses-record-row']
] as [string, () => Fixture, string][])
  for (const mode of [
    'missing font',
    'literal mismatch',
    'duplicate native',
    'incomplete rectangle',
    'different page',
    'measured partition',
    'explicit span',
    'missing border'
  ])
    test('does not infer ' + name + ' contradiction with ' + mode, () => {
      const f = make(),
        target = f.cells.find(
          (c: Fixture) => c.row === (name === 'parallel assignment' ? 5 : 2) && c.column === 0
        )
      if (mode === 'missing font') delete f.context.sourceContent.styles.F
      if (mode === 'literal mismatch') {
        target.sourceItems = structuredClone(target.sourceItems)
        target.sourceItems[0].text = 'different'
      }
      if (mode === 'duplicate native')
        f.tokens.push(
          structuredClone(
            f.tokens.find((t: Fixture) => t.sourceItem.index === target.sourceItems[0].index)
          )
        )
      if (mode === 'incomplete rectangle') {
        target.sourceRects = structuredClone(target.sourceRects)
        target.sourceRects[0][2] -= 1
      }
      if (mode === 'different page') target.sourceItems[0].pageNumber = 2
      if (mode === 'measured partition')
        target.sourceSegments = [
          { ...target.sourceItems[0], start: 0, end: 1, rect: target.sourceRects[0] }
        ]
      if (mode === 'explicit span') target.rowSpan = 2
      if (mode === 'missing border') f.rules.pop()
      assert(!conflicts(f.table, f.tokens, f.rules, [], f.context).includes(marker), mode)
    })

for (const mode of [
  'one equation on a wrapped line',
  'only one parallel column',
  'repeated parameter',
  'irregular physical spacing',
  'correct seven rows'
])
  test('preserves parameter layout with ' + mode, () => {
    const f = parallelAssignmentRows(),
      target = f.cells.find((c: Fixture) => c.row === 5 && c.column === 0)
    if (mode === 'one equation on a wrapped line' || mode === 'only one parallel column') {
      const c = f.cells.find(
        (c: Fixture) => c.row === 5 && c.column === (mode === 'only one parallel column' ? 1 : 0)
      )
      c.sourceItems = c.sourceItems.slice(0, 3)
      c.sourceRects = c.sourceRects.slice(0, 3)
      c.text = c.sourceItems.map((s: Fixture) => s.text).join(' ')
    }
    if (mode === 'repeated parameter') {
      const t = f.tokens.find((t: Fixture) => t.text === 'p6')
      t.text = t.sourceItem.text = 'p5'
      target.text = target.sourceItems.map((s: Fixture) => s.text).join(' ')
      f.finish()
    }
    if (mode === 'irregular physical spacing') {
      for (const t of f.tokens.filter((t: Fixture) => t.baseline === 102)) {
        t.baseline += 4
        for (const r of [t.rect, t.nativeLabelRect]) {
          r[1] += 4
          r[3] += 4
        }
      }
      f.finish()
    }
    if (mode === 'correct seven rows') {
      f.grid.push(['', ''])
      for (const c of f.cells.filter((c: Fixture) => c.row === 5)) {
        const tail = c.sourceItems
          .slice(3)
          .map((s: Fixture) => f.tokens.find((t: Fixture) => t.sourceItem === s))
        c.sourceItems = c.sourceItems.slice(0, 3)
        c.sourceRects = c.sourceRects.slice(0, 3)
        c.text = c.sourceItems.map((s: Fixture) => s.text).join(' ')
        f.cell(6, c.column, tail)
      }
    }
    assert(
      !conflicts(f.table, f.tokens, f.rules, [], f.context).includes(
        'native-parallel-assignment-rows-collapsed'
      )
    )
  })

test('does not infer a wrapped hierarchy when complete native words fit on both upper lines', () => {
  const f = splitWrappedHierarchy(true)
  assert(
    !conflicts(f.table, f.tokens, f.rules, [], f.context).includes(
      'native-wrapped-hierarchy-crosses-record-row'
    )
  )
})
for (const mode of [
  'independent parent',
  'whole wrapped cell',
  'missing renderer',
  'missing glyph outline',
  'wrong source hash',
  'different font',
  'unproved rule',
  'white rule'
])
  test('keeps hierarchy ownership without complete contradiction evidence: ' + mode, () => {
    const f = splitWrappedHierarchy(false, mode === 'independent parent'),
      target = f.cells.find((c: Fixture) => c.row === 1 && c.column === 0)
    if (mode === 'whole wrapped cell') target.rowSpan = 2
    if (mode === 'missing renderer') delete f.context.nativeGlyphContext
    if (mode === 'missing glyph outline') f.context.nativeGlyphContext.glyphBounds[0].glyphs.pop()
    if (mode === 'wrong source hash') f.context.nativeGlyphContext.sourceSha256 = 'b'.repeat(64)
    if (mode === 'different font')
      f.context.sourceContent.items[
        f.tokens.find((t: Fixture) => t.text === 'Control').sourceItem.index
      ].fontName = 'Other'
    if (mode === 'unproved rule') f.context.rulePaintBounds.clear()
    if (mode === 'white rule')
      f.context.operators.argsArray[f.context.operators.fnArray.length - 4][0] = '#ffffff'
    assert(
      !conflicts(f.table, f.tokens, f.rules, [], f.context).includes(
        'native-wrapped-hierarchy-crosses-record-row'
      )
    )
  })
