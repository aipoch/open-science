import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverCaptionedMathArrays: recover } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-captioned-math-array.mjs')).href
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture(kind: 'arrows' | 'rules' = 'arrows') {
  const items: Array<{
    text: string
    rect: number[]
    baseline: number
    height: number
    horizontal: boolean
    sourceItem: { pageNumber: number; index: number; text: string }
  }> = []
  const rules: number[][] = []
  const add = (text: string, x: number, baseline: number, width = 5, height = 10): void => {
    items.push({
      text,
      rect: [x, baseline - height, x + width, baseline],
      baseline,
      height,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: items.length, text }
    })
  }
  const block = (left: number, y: number): void => {
    rules.push([left, y, left + 100, y])
    if (kind === 'arrows') {
      for (const [text, x] of [
        ['If', left + 30],
        ['a', left + 42],
        ['=', left + 52],
        ['b', left + 63]
      ] as const)
        add(text, x, y - 30)
      for (let c = 0; c < 3; c++) {
        add('f', left + 40 + c * 25, y - 5)
        add(String(c), left + 45 + c * 25, y - 3, 3, 7)
      }
    } else {
      for (const [text, x] of [
        ['a', left + 5],
        ['=', left + 25],
        ['b', left + 50],
        ['0', left + 75]
      ] as const)
        add(text, x, y - 5)
      for (const x of [left + 30, left + 55, left + 80]) rules.push([x, y, x, y + 37])
    }
    for (let r = 0; r < 3; r++) {
      add(['x', 'y', 'z'][r], left + 10, y + 10 + r * 12)
      for (let c = 0; c < 3; c++) {
        add(c % 2 ? 'B' : 'A', left + 40 + c * 25, y + 10 + r * 12)
        if (kind === 'arrows' && c < 2) add('→', left + 50 + c * 25, y + 10 + r * 12)
      }
    }
  }
  if (kind === 'arrows') {
    block(20, 80)
    block(150, 80)
    block(85, 180)
  } else {
    block(20, 70)
    block(20, 145)
  }
  const captionY = kind === 'arrows' ? 234 : 199
  const caption = {
    page: 1,
    rect: [20, captionY, kind === 'arrows' ? 250 : 120, captionY + 10],
    lines: ['Table 1: Symbolic states.']
  }
  add(caption.lines[0], 20, captionY + 10, caption.rect[2] - 20)
  add('Independent following paragraph.', 20, captionY + 35, 250)
  const graphics = rules.map((r) => ({
    kind: 'path',
    rect:
      r[0] === r[2] ? [r[0] - 0.2, r[1], r[2] + 0.2, r[3]] : [r[0], r[1] - 0.2, r[2], r[3] + 0.2]
  }))
  const captions = [caption],
    existing: Array<{ cropRect: number[] }> = [],
    page = { width: 300, height: 350, invalidGraphicsBounds: 0 }
  const run = (): Array<{
    cropRect: number[]
    sourceItems: Array<{ index: number; text: string }>
    caption: typeof caption
  }> => recover(items, rules, captions, 1, existing, graphics, page)
  return { items, rules, caption, captions, graphics, existing, page, run }
}

it.each(['arrows', 'rules'] as const)(
  'retains complete captioned %s arrays as an image without inventing cells',
  (kind) => {
    const f = fixture(kind),
      before = JSON.stringify(f),
      result = f.run()
    expect(result).toHaveLength(1)
    expect(result[0].caption).toBe(f.caption)
    expect(result[0]).not.toHaveProperty('cells')
    expect(result[0]).not.toHaveProperty('grid')
    expect(result[0].sourceItems).toEqual(f.items.slice(0, -2).map((i) => i.sourceItem))
    expect(result[0].cropRect[3]).toBeLessThan(f.caption.rect[1])
    expect(JSON.stringify(f)).toBe(before)
  }
)

it.each([
  'caption mismatch',
  'wrong source',
  'negative source',
  'duplicate source',
  'missing row',
  'missing rule',
  'different stubs',
  'prose between',
  'paint crossing',
  'missing paint',
  'unbound separator',
  'duplicated arrow gap',
  'independent upper title',
  'competing caption',
  'existing table',
  'invalid graphics'
])('declines incomplete mathematical ownership: %s', (variant) => {
  const f = fixture()
  if (variant === 'caption mismatch') f.caption.lines = ['Table 1: Different caption.']
  if (variant === 'wrong source') f.items[0].sourceItem.text = 'Other'
  if (variant === 'negative source') f.items[0].sourceItem.index = -1
  if (variant === 'duplicate source') f.items[1].sourceItem.index = f.items[0].sourceItem.index
  if (variant === 'missing row') f.items.splice(13, 1)
  if (variant === 'missing rule') f.rules.splice(0, 1)
  if (variant === 'different stubs') {
    const t = f.items.find((i) => i.text === 'x')!
    t.text = 'w'
    t.sourceItem.text = 'w'
  }
  if (variant === 'prose between') {
    const t = f.items.at(-1)!
    t.baseline = 140
    t.rect = [20, 130, 250, 140]
  }
  if (variant === 'paint crossing') f.graphics.push({ kind: 'path', rect: [0, 210, 280, 220] })
  if (variant === 'missing paint') f.graphics.length = 0
  if (variant === 'unbound separator') f.graphics[0].rect = [20, 90, 120, 90.4]
  if (variant === 'duplicated arrow gap') {
    const arrows = f.items.filter((i) => i.text === '→')
    arrows[1].rect = [...arrows[0].rect]
  }
  if (variant === 'independent upper title')
    f.items.push({
      text: 'Case A',
      rect: [50, 25, 90, 35],
      baseline: 35,
      height: 10,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: f.items.length, text: 'Case A' }
    })
  if (variant === 'competing caption')
    f.captions.push({ page: 1, lines: ['Table 2: Other.'], rect: [20, 120, 250, 130] })
  if (variant === 'existing table') f.existing.push({ cropRect: [20, 40, 250, 220] })
  if (variant === 'invalid graphics') f.page.invalidGraphicsBounds = 1
  expect(f.run()).toEqual([])
})

it('requires each repeated matrix column to have its own complete separator', () => {
  const f = fixture('rules')
  f.rules.splice(1, 1)
  expect(f.run()).toEqual([])
})
