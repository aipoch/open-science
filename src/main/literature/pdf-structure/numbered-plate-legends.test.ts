import { expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { matchFigureSequence, readFigureSequence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-sequence.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('src/main/literature/pdf-structure/fixtures/numbered-plate-legends.jsonl'))

it('links all numbered native plates to complete source legends without appending chart labels', () => {
  const f = fixture(),
    original = structuredClone(f)
  const result = matchFigureSequence(f.pages)
  expect([...result.keys()]).toEqual([33, 34, 35])
  expect([...result.values()].map((c: { page: number }) => c.page)).toEqual([32, 32, 32])
  expect([...result.values()].flatMap((c: { lines: string[] }) => c.lines)).toEqual(
    f.pages[0].lines.slice(1).map((l: { text: string }) => l.text)
  )
  expect(result.get(35).lines.at(-1)).toBe('details are available in the Supplemental File.')
  expect(result.get(35).rect[3]).toBeLessThan(520)
  expect(f).toEqual(original)
})

it.each([
  'missing-heading',
  'missing-plate',
  'duplicate-label',
  'out-of-order',
  'repeated-legend-section'
])('declines numbered plate ownership with %s', (mode) => {
  const f = fixture()
  if (mode === 'missing-heading') f.pages[0].lines.shift()
  if (mode === 'missing-plate') f.pages.splice(2, 1)
  if (mode === 'duplicate-label')
    f.pages[1].lines.push({
      ...f.pages[1].lines.find((l: { text: string }) => l.text === 'Figure 1')
    })
  if (mode === 'out-of-order')
    f.pages[2].lines.find((l: { text: string }) => l.text === 'Figure 2').text = 'Figure 4'
  if (mode === 'repeated-legend-section') f.pages[1].lines.unshift({ ...f.pages[0].lines[0] })
  expect(matchFigureSequence(f.pages).size).toBe(0)
})

it.each([true, false])(
  'uses repeated footer evidence (%s) and retains bottom-margin figure numbers',
  async (repeated) => {
    const f = fixture()
    const cleanups = f.pages.map(() => vi.fn())
    const document = {
      numPages: f.pages.length,
      getPage: async (number: number): Promise<unknown> => {
        const p = f.pages[number - 1]
        const lines = p.lines.map(
          (l: { text: string; fontSize: number; x: number; bottom: number; right: number }) => ({
            str: l.text,
            dir: 'ltr',
            height: l.fontSize,
            width: l.right - l.x,
            transform: [l.fontSize, 0, 0, l.fontSize, l.x, l.bottom]
          })
        )
        if (repeated || number === 1)
          lines.push({
            str: 'Publisher notice.',
            dir: 'ltr',
            height: 8,
            width: 100,
            transform: [8, 0, 0, 8, 40, p.height - 2]
          })
        return {
          rotate: 0,
          getViewport: (): unknown => ({
            height: p.height,
            width: 1000,
            convertToViewportPoint: (x: number, y: number): number[] => [x, y]
          }),
          getTextContent: async (): Promise<unknown> => ({ items: lines }),
          cleanup: cleanups[number - 1]
        }
      }
    }
    const result = await readFigureSequence(document)
    expect([...result.keys()]).toEqual([2, 3, 4])
    expect(result.get(4).lines.includes('Publisher notice.')).toBe(!repeated)
    for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledOnce()
  }
)
