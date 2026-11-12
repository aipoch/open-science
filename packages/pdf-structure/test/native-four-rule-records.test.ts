import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousFourRuleRecords } = await import(
  pathToFileURL(resolve('test/fixtures/native-four-rule-records.mjs')).href
)
const { nativeFramedRecordPacket, nativeFramedRecordClosure } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-cited-prose-records.mjs')).href
)
const { recoverNativeFourRuleRecordGrid: recover } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-four-rule-records.mjs')).href
)
const { recoverNativeWrappedCycleRecordGrid: old } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-wrapped-cycle-records.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

it.each(['terminal-wrapped', 'count-footer'])(
  'recovers a complete original four-rule %s table',
  async (mode) => {
    const f = await anonymousFourRuleRecords(mode)
    try {
      const source = f.items.filter(
          (t) => t.baseline > f.rules[0][1] && t.baseline < f.rules.at(-1)[1]
        ),
        packet = nativeFramedRecordPacket(f.context, source, 1)
      expect(packet).toBeDefined()
      expect(nativeFramedRecordClosure(packet, f.rules)).toBe(true)
      const plan = recover(f.table, f.items, f.captions, f.rules, f.context)
      expect(plan).toBeDefined()
      expect(plan.rows).toHaveLength(mode === 'terminal-wrapped' ? 4 : 5)
      expect(plan.columns).toHaveLength(mode === 'terminal-wrapped' ? 5 : 6)
      expect(plan.ownedTokens.size).toBe(mode === 'terminal-wrapped' ? 23 : 30)
      expect(plan.cropRect).toEqual(f.table.cropRect)
      expect(old(f.table, f.items, f.captions, f.rules, f.context)).toBeUndefined()
      const refined = refineTable(
        f.table,
        f.items,
        f.captions,
        [],
        f.rules,
        [],
        undefined,
        undefined,
        f.context
      )
      expect(refined.grid).toHaveLength(plan.rows.length)
      expect(refined.grid[0]).toHaveLength(plan.columns.length)
      expect(refined.cells.flatMap((c) => c.sourceItems ?? [])).toHaveLength(plan.ownedTokens.size)
    } finally {
      await f.cleanup()
    }
  }
)

it('does not treat paired quantitative values as a terminal prose continuation', async () => {
  const f = await anonymousFourRuleRecords('terminal-wrapped', 'numeric-tail')
  try {
    const source = f.items.filter(
        (t) => t.baseline > f.rules[0][1] && t.baseline < f.rules.at(-1)[1]
      ),
      packet = nativeFramedRecordPacket(f.context, source, 1)
    expect(packet).toBeDefined()
    expect(nativeFramedRecordClosure(packet, f.rules)).toBe(true)
    expect(recover(f.table, f.items, f.captions, f.rules, f.context)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it('does not move original glyphs across the terminal rail through token baseline metadata', async () => {
  const f = await anonymousFourRuleRecords('count-footer', 'footer-above-terminal')
  try {
    expect(recover(f.table, f.items, f.captions, f.rules, f.context)).toBeUndefined()
    const footer = f.items.filter((t) => ['Total', '6', '36'].includes(t.text))
    expect(footer).toHaveLength(3)
    expect(footer.every((t) => t.rect[3] < f.rules[2][1])).toBe(true)
    for (const token of footer) token.baseline += 45
    expect(footer.every((t) => t.baseline > f.rules[2][1])).toBe(true)
    expect(recover(f.table, f.items, f.captions, f.rules, f.context)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each([
  ['terminal-wrapped', 'baseline'],
  ['terminal-wrapped', 'height'],
  ['count-footer', 'baseline'],
  ['count-footer', 'height']
] as const)('binds every %s whole-font original %s metric', async (mode, metric) => {
  const f = await anonymousFourRuleRecords(mode)
  try {
    expect(recover(f.table, f.items, f.captions, f.rules, f.context)).toBeDefined()
    for (const token of f.items)
      if (token.baseline > f.rules[0][1] && token.baseline < f.rules.at(-1)[1])
        token[metric] += 0.05
    expect(recover(f.table, f.items, f.captions, f.rules, f.context)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each(['terminal-wrapped', 'count-footer'])(
  'refuses incomplete original frame or foreign ink in %s',
  async (mode) => {
    for (const fault of ['missing-closing', 'foreign-paint', 'foreign-glyph']) {
      const f = await anonymousFourRuleRecords(mode, fault)
      try {
        expect(recover(f.table, f.items, f.captions, f.rules, f.context)).toBeUndefined()
      } finally {
        await f.cleanup()
      }
    }
  }
)

it.each([
  'caption-missing',
  'caption-duplicate',
  'caption-literal',
  'source-width',
  'source-transform',
  'source-literal',
  'font-origin',
  'font-segment',
  'font-alias',
  'nested-carrier',
  'future',
  'cycle',
  'seed-accessor',
  'font-accessor',
  'baseline-accessor',
  'height-accessor',
  'array-accessor',
  'rotation',
  'lane-start',
  'footer-value',
  'split-final-stub',
  'unproved-crop'
])('keeps original carriers and independent row/column closure: %s', async (fault) => {
  const mode = fault === 'footer-value' ? 'count-footer' : 'terminal-wrapped',
    f = await anonymousFourRuleRecords(mode)
  try {
    let getterCalled = false
    const get = (): never => {
        getterCalled = true
        throw Error('must not execute')
      },
      token = f.items.find((t) => t.text === 'cause')
    if (fault === 'caption-missing') f.captions = []
    if (fault === 'caption-duplicate') f.captions.push({ ...f.captions[0] })
    if (fault === 'caption-literal') f.captions[0].lines = ['Table 1: Other text.']
    if (fault === 'source-width') f.context.sourceContent.items[token.sourceItem.index].width += 1
    if (fault === 'source-transform')
      f.context.sourceContent.items[token.sourceItem.index].transform[4] += 1
    if (fault === 'source-literal')
      f.context.sourceContent.items[token.sourceItem.index].str = 'Other'
    if (fault === 'font-origin') token.sourceItem = { ...token.sourceItem, index: 0 }
    if (fault === 'font-segment') token.sourceSegment = { ...token.sourceItem, start: 0, end: 1 }
    if (fault === 'font-alias') f.items.push(token)
    if (fault === 'nested-carrier') f.table.structure.future = { carrier: token.sourceItem }
    if (fault === 'future') f.table.future = { value: 'unsupported seed metadata' }
    if (fault === 'cycle') f.table.structure.future = f.table.structure
    if (fault === 'seed-accessor')
      Object.defineProperty(f.table, 'cropRect', { get, enumerable: true })
    if (fault === 'font-accessor') Object.defineProperty(token, 'text', { get, enumerable: true })
    if (fault === 'baseline-accessor')
      Object.defineProperty(token, 'baseline', { get, enumerable: true })
    if (fault === 'height-accessor')
      Object.defineProperty(token, 'height', { get, enumerable: true })
    if (fault === 'array-accessor') Object.defineProperty(f.items, '0', { get })
    if (fault === 'rotation') f.context.viewport.rotation = 90
    if (fault === 'lane-start') token.baseline += 1
    if (fault === 'footer-value') f.items.find((t) => t.text === '36').text = 'unproved'
    if (fault === 'split-final-stub') f.items.find((t) => t.text === 'Three').baseline += 15
    if (fault === 'unproved-crop') f.table.cropRect[3] -= 20
    expect(recover(f.table, f.items, f.captions, f.rules, f.context)).toBeUndefined()
    expect(getterCalled).toBe(false)
  } finally {
    await f.cleanup()
  }
})
