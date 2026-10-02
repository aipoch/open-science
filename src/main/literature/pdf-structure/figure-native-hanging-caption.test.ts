import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { resolveFigureCaption } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const line = (
  text: string,
  x: number,
  y: number,
  width: number
): { text: string; x: number; y: number; width: number; height: number; fontSize: number } => ({
  text,
  x,
  y,
  width,
  height: 12,
  fontSize: 12
})
const input = (): {
  caption: { page: number; lines: string[]; rect: number[] }
  pages: {
    pageNumber: number
    width: number
    height: number
    lines: ReturnType<typeof line>[]
    graphicsBounds: { kind: string; normalizedRect: number[] }[]
  }[]
} => {
  const caption = {
    page: 1,
    lines: ['Figure S1. Native measurements are shown for selected'],
    rect: [72, 665, 530, 690]
  }
  return {
    caption,
    pages: [
      {
        pageNumber: 1,
        width: 600,
        height: 800,
        lines: [line(caption.lines[0], 72, 665, 458), line('5', 297, 710, 6)],
        graphicsBounds: [{ kind: 'path', normalizedRect: [0.2, 0.1, 0.8, 0.7] }]
      },
      {
        pageNumber: 2,
        width: 600,
        height: 800,
        lines: [
          line('coefficients (', 72, 74, 100),
          line('a', 180, 74, 8),
          line(') and intervals (', 190, 74, 200),
          line('b', 73, 100, 8),
          line(').', 88, 100, 10)
        ],
        graphicsBounds: [{ kind: 'path', normalizedRect: [0.2, 0.2, 0.8, 0.6] }]
      }
    ]
  }
}
it('preserves uniquely owned mixed native caption fragments across a page boundary', () => {
  const f = input(),
    r = resolveFigureCaption(f.caption, [f.caption], f.pages)
  expect(r.lines).toEqual([...f.caption.lines, 'coefficients ( a ) and intervals (', 'b ).'])
  expect(r.regions).toEqual([
    { page: 1, rect: f.caption.rect },
    { page: 2, rect: [72, 74, 390, 112] }
  ])
  expect(resolveFigureCaption(f.caption, [f.caption])).toBe(f.caption)
})
it.each([
  'font',
  'indent',
  'unclosed',
  'new-heading',
  'body-after-tail',
  'competing-caption',
  'finished-caption'
])('rejects an unproven hanging caption tail: %s', (variant) => {
  const f = input(),
    captions = [f.caption]
  if (variant === 'font') {
    f.pages[1].lines[1].height = 24
    f.pages[1].lines[1].fontSize = 24
  }
  if (variant === 'indent') f.pages[1].lines[0].x = 100
  if (variant === 'unclosed') f.pages[1].lines[4].text = 'b'
  if (variant === 'new-heading') f.pages[1].lines[0].text = 'Results ('
  if (variant === 'body-after-tail') {
    f.pages[1].graphicsBounds = []
    f.pages[1].lines.push(line('Independent paragraph.', 72, 300, 300))
  }
  if (variant === 'competing-caption')
    captions.push({ page: 2, lines: ['Figure S2. Other.'], rect: [72, 74, 390, 112] })
  if (variant === 'finished-caption') f.caption.lines[0] += '.'
  expect(resolveFigureCaption(f.caption, captions, f.pages)).toBe(f.caption)
})
