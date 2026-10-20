import { expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import type { PdfLayoutTextItem } from '../../src/reader/layout.js'

function fixture(fault = 'valid'): { items: PdfLayoutTextItem[]; body: number; label: number } {
  const run = (
    str: string,
    x: number,
    y: number,
    width: number,
    font = 8,
    hasEOL = false
  ): PdfLayoutTextItem => ({
    str,
    width,
    height: font,
    fontName: 'body',
    hasEOL,
    dir: 'ltr',
    transform: [font, 0, 0, font, x, 800 - y]
  })
  const items: PdfLayoutTextItem[] = []
  let label = -1
  for (const [n, y] of [91, 100, 110, 124, 134, 144, 158, 168, 177].entries()) {
    if (n === 4) {
      label = items.length
      items.push(
        run('G', 306, 129, 5, 8),
        run('RO', 312, 129, 9.5, 6.4),
        run('U', 322, 129, 4.5, 8),
        run('P', 327, 129, 8, 6.4),
        run('.', 336, 129, 2, 8, true)
      )
    }
    items.push(run(n % 3 === 1 ? 'Time (s)' : 'Value', 344, y, 33))
    for (const [col, x] of [395, 432, 463, 490].entries())
      items.push(run(`${n + 1}.${col + 1}`, x, y, 14, 8, col === 3))
  }
  const start = items.length
  for (let n = 0; n < 9; n++) {
    const text =
      n === 4
        ? 'The neighboring paragraph continues with the'
        : 'These independent observations remain within the'
    const font = fault === 'same-size' ? 8 : 10
    items.push(
      run(
        fault === 'short-label' && n === 4
          ? 'Note'
          : text + (fault === 'finished-peers' ? '.' : ''),
        108,
        87 + n * 10.9,
        fault === 'overlap' && n === 4 ? 202 : fault === 'same-size' ? 192 : 190,
        font,
        fault !== 'no-native-lines'
      )
    )
  }
  if (fault === 'crossing-peer') {
    for (const item of items.slice(start)) item.width = 237
    items[start + 4].width = 230
    for (const item of items.slice(label, label + 5)) item.transform[4] += 40
  }
  return { items, body: start + 4, label }
}
async function extract(items: PdfLayoutTextItem[]): ReturnType<typeof extractPdfTranslationSource> {
  const document = {
    numPages: 1,
    fingerprints: ['synthetic'],
    getPage: async () => ({
      rotate: 0,
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({ items })
    })
  }
  return extractPdfTranslationSource({
    document: document as unknown as PDFDocumentProxy,
    resourceRequestKey: 'synthetic',
    signal: new AbortController().signal
  })
}
it('keeps a complete left body column out of a smaller adjacent native table', async () => {
  const { items, body, label } = fixture(),
    result = await extract(items)
  const owner = result.source.units.find((u) =>
    u.fragments.some((f) => f.items.some((i) => i.index === body))
  )!
  expect(owner.fragments.flatMap((f) => f.items.map((i) => i.index))).not.toContain(label)
  expect(owner.sourceOnly).toBeUndefined()
  const keys = result.source.units.flatMap((u) =>
    u.fragments.flatMap((f) => f.items.map((i) => i.index))
  )
  expect(keys.toSorted((a, b) => a - b)).toEqual(items.map((_, i) => i))
})

it.each(['same-size', 'short-label', 'finished-peers', 'no-native-lines', 'overlap'])(
  'does not infer an exterior body owner from %s',
  async (fault) => {
    const { items, body, label } = fixture(fault),
      result = await extract(items)
    const owner = result.source.units.find((u) =>
      u.fragments.some((f) => f.items.some((i) => i.index === body))
    )!
    expect(owner.fragments.flatMap((f) => f.items.map((i) => i.index))).toContain(label)
    const keys = result.source.units.flatMap((u) =>
      u.fragments.flatMap((f) => f.items.map((i) => i.index))
    )
    expect(keys.toSorted((a, b) => a - b)).toEqual(items.map((_, i) => i))
  }
)

it('does not use native body peers crossing the table boundary as paragraph continuation', async () => {
  const { items, body } = fixture('crossing-peer'),
    result = await extract(items)
  const owner = result.source.units.find((unit) =>
    unit.fragments.some((fragment) => fragment.items.some((item) => item.index === body))
  )!
  expect(owner.fragments.flatMap((fragment) => fragment.items.map((item) => item.index))).toEqual([
    body
  ])
  const keys = result.source.units.flatMap((unit) =>
    unit.fragments.flatMap((fragment) => fragment.items.map((item) => item.index))
  )
  expect(keys.toSorted((a, b) => a - b)).toEqual(items.map((_, index) => index))
})
