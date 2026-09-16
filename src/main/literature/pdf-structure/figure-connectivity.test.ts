import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { connectFigureGraphics } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-connectivity.mjs')).href
)
type Graphic = { rect: number[] }

it('matches exhaustive adjacency and source order across bins, long paths and isolated marks', () => {
  let seed = 17
  const random = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
  for (let sample = 0; sample < 20; sample++) {
    const points: Graphic[] = Array.from({ length: 300 }, () => {
      const x = Math.floor(random() * 600) - 100,
        y = Math.floor(random() * 800) - 100
      return { rect: [x, y, x + random() * 40, y + random() * 40] }
    })
    points.push({ rect: [-200, 100, 1000, 1000] })
    const first = { rect: [0, 0, sample % 2 ? 900 : 200, 200] }
    const expected = [first],
      remainder = new Set(points)
    // Exhaustive reference traversal, independent of spatial indexing.
    for (const current of expected)
      for (const item of remainder) {
        const a = current.rect,
          b = item.rect
        if (
          Math.min(a[2] + 8, b[2]) > Math.max(a[0] - 8, b[0]) &&
          Math.min(a[3] + 8, b[3]) > Math.max(a[1] - 8, b[1])
        ) {
          remainder.delete(item)
          expected.push(item)
        }
      }
    const actual = [first],
      pending = new Set(points)
    connectFigureGraphics(actual, pending)
    expect(actual).toEqual(expected)
    expect(pending).toEqual(remainder)
  }
})

it('keeps disconnected dense clusters out while following small vector chains', () => {
  const chain = Array.from({ length: 100_000 }, (_, n) => ({
    rect: [20 + (n % 500), 20 + Math.floor(n / 500), 21 + (n % 500), 21 + Math.floor(n / 500)]
  }))
  const isolated = Array.from({ length: 40_000 }, (_, n) => ({
    rect: [800 + (n % 200), 20 + Math.floor(n / 200), 801 + (n % 200), 21 + Math.floor(n / 200)]
  }))
  const connected = [{ rect: [10, 10, 20, 20] }],
    pending = new Set([...isolated, ...chain])
  connectFigureGraphics(connected, pending)
  expect(connected).toHaveLength(chain.length + 1)
  expect(pending).toEqual(new Set(isolated))
})
