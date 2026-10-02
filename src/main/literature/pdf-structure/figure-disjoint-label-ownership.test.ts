import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const graphic = (rect: number[]): { kind: string; normalizedRect: number[] } => ({
  kind: 'path',
  normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
})
const line = (
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize = 10
): { text: string; x: number; y: number; width: number; fontSize: number; height: number } => ({
  text,
  x,
  y,
  width,
  fontSize,
  height: fontSize
})
const caption = (
  text: string,
  rect: number[]
): { page: number; lines: string[]; rect: number[] } => ({ page: 1, lines: [text], rect })
const page = (
  graphics: number[][],
  lines: ReturnType<typeof line>[] = []
): {
  pageNumber: number
  width: number
  height: number
  rotation: number
  renderRotation: number
  invalidGraphicsBounds: number
  lines: ReturnType<typeof line>[]
  graphicsBounds: ReturnType<typeof graphic>[]
} => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  rotation: 0,
  renderRotation: 0,
  invalidGraphicsBounds: 0,
  lines,
  graphicsBounds: graphics.map(graphic)
})
it('does not reassign outlined glyphs already enclosed by a separately captioned panel', () => {
  const p = page(
    [
      [50, 60, 300, 200],
      [320, 60, 560, 200],
      ...Array.from({ length: 6 }, (_, i) => [290, 75 + i * 15, 295, 80 + i * 15])
    ],
    [line('key', 282, 100, 15)]
  )
  const captions = [
    caption('Figure 1. First panel.', [50, 210, 300, 230]),
    caption('Figure 2. Second panel.', [320, 210, 560, 230])
  ]
  const f = associateFigures(p, captions)[1]
  expect(f.rect[0]).toBeGreaterThanOrEqual(320)
})
it('keeps repeated two-line outside keys with their distinct native panel letters', () => {
  const p = page(
    [
      [100, 60, 300, 150],
      [100, 180, 300, 270]
    ],
    [
      line('(a)', 65, 50, 15, 12),
      line('(b)', 65, 170, 15, 12),
      line('Edge', 60, 100, 28),
      line('Second key', 55, 112, 40),
      line('Edge', 60, 220, 28),
      line('Second key', 55, 232, 40)
    ]
  )
  const f = associateFigures(p, [caption('Figure 1. Two native panels.', [50, 285, 300, 310])])[0]
  expect(f.rect[0]).toBeLessThanOrEqual(55)
  expect(f.rect[1]).toBeLessThanOrEqual(50)
})
it.each(['missing-panel', 'single-key', 'paragraph', 'competing-table'])(
  'rejects an outside repeated key without complete ownership: %s',
  (variant) => {
    let lines = [
      line('(a)', 65, 50, 15, 12),
      line('(b)', 65, 170, 15, 12),
      line('Edge', 60, 100, 28),
      line('Second key', 55, 112, 40),
      line('Edge', 60, 220, 28),
      line('Second key', 55, 232, 40)
    ]
    if (variant === 'missing-panel') lines = lines.filter((l) => l.text !== '(b)')
    if (variant === 'single-key') lines = lines.filter((l) => l.text !== 'Second key')
    if (variant === 'paragraph')
      lines.push(
        line('An independent paragraph continues outside the native panels.', 55, 90, 40),
        line('A following paragraph line establishes separate text ownership.', 55, 104, 40)
      )
    const p = page(
      [
        [100, 60, 300, 150],
        [100, 180, 300, 270]
      ],
      lines
    )
    const f = associateFigures(
      p,
      [caption('Figure 1. Two native panels.', [50, 285, 300, 310])],
      variant === 'competing-table' ? [[50, 80, 90, 260]] : []
    )[0]
    expect(f.rect[0]).toBeGreaterThan(55)
  }
)
it('excludes a detached outer printed page number but retains native numeric ticks', () => {
  const p = page([[320, 60, 560, 200]], [line('1', 550, 37, 10), line('1', 335, 75, 7, 7)])
  const f = associateFigures(p, [caption('Figure 1. Source chart.', [320, 210, 560, 230])])[0]
  expect(f.rect[1]).toBeGreaterThanOrEqual(60)
})

it('rejects a split running title on the printed page-number baseline', () => {
  const p = page(
    [[105, 77, 510, 244]],
    [
      line('1', 72, 50, 10),
      line('Authors and a repeated running title across the outer page margin', 270, 53, 270, 7),
      line('(a) Native chart title', 154, 81, 130, 7)
    ]
  )
  const f = associateFigures(p, [caption('Figure 1. Source chart.', [72, 248, 540, 267])])[0]
  expect(f.rect[1]).toBeGreaterThanOrEqual(77)
})
it('does not include the short last line of a paragraph above a chart', () => {
  const p = page(
    [[305, 138, 560, 263]],
    [
      line('The preceding native paragraph occupies this separate column.', 306, 81, 251),
      line('Another ordinary paragraph line continues on its baseline.', 306, 93, 251),
      line('The next long paragraph line precedes a short ending.', 306, 105, 251),
      line('Tail.', 306, 117, 42)
    ]
  )
  const f = associateFigures(p, [caption('Figure 1. Source chart.', [306, 270, 560, 300])])[0]
  expect(f.rect[1]).toBeGreaterThanOrEqual(138)
})
