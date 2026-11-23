import type { PdfLayoutPage } from './layout.js'
import type { PdfTranslationSource } from './source.js'

const fusedScientific = /^[+−-]?\d+(?:\.\d+)?\s*[×·]\s*10[ \t]+[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3}$/u

type Value = { index: number; x: number; y: number; height: number; right: number; font: string }
type Unit = PdfTranslationSource['units'][number]

// A gap within a bundled value can represent lost Unicode. Prove the table through
// aligned native items and keep their owners without attempting to recover digits.
export function nativeBundledScientificOwners(
  pages: readonly PdfLayoutPage[],
  units: readonly Unit[]
): ReadonlySet<string> {
  const confirmed = new Map<number, Set<number>>()
  for (const page of pages) {
    const values = page.items
      .flatMap((item, index): Value[] => {
        const [sx, skewX, skewY, sy, x, y] = item.transform
        const height = item.height
        return item.fontName &&
          item.fontVertical !== true &&
          item.dir === 'ltr' &&
          [sx, skewX, skewY, sy, x, y, height, item.width].every(Number.isFinite) &&
          sx > 0 &&
          sy === height &&
          sy > 0 &&
          skewX === 0 &&
          skewY === 0 &&
          item.width > 0 &&
          fusedScientific.test(item.str.trim())
          ? [{ index, x, y, height, right: x + item.width, font: item.fontName }]
          : []
      })
      .sort((a, b) => b.y - a.y || a.x - b.x)
    const rows: Value[][] = []
    for (const value of values) {
      const row = rows.at(-1)
      if (!row || row[0].y - value.y >= row[0].height * 0.02) rows.push([value])
      else row.push(value)
    }
    const gridRows = rows
      .map((row) => row.sort((a, b) => a.x - b.x))
      .filter(
        (row) =>
          row.length >= 3 &&
          row.every(
            (cell, index) =>
              cell.font === row[0].font &&
              cell.height === row[0].height &&
              (!index ||
                (cell.x - row[index - 1].right >= cell.height && cell.index > row[index - 1].index))
          )
      )
    const retained = new Set<number>()
    for (const [index, middle] of gridRows.entries()) {
      const above = gridRows[index - 1],
        below = gridRows[index + 1]
      if (!above || !below) continue
      const pitch = above[0].y - middle[0].y
      const height = middle[0].height
      if (
        pitch < 1.4 * height ||
        pitch > 3 * height ||
        Math.abs(middle[0].y - below[0].y - pitch) >= height * 0.1
      )
        continue
      if (
        ![above, below].every(
          (row) =>
            row.length === middle.length &&
            row.every(
              (cell, column) =>
                cell.font === middle[column].font &&
                cell.height === height &&
                Math.abs(cell.x - middle[column].x) < height * 0.1
            )
        )
      )
        continue
      for (const cell of [...above, ...middle, ...below]) retained.add(cell.index)
    }
    if (retained.size) confirmed.set(page.page, retained)
  }
  return new Set(
    units.flatMap((unit) => {
      const [fragment] = unit.fragments
      if (
        unit.sourceOnly ||
        unit.preserve ||
        unit.figure ||
        unit.fragments.length !== 1 ||
        !fragment.items.length
      )
        return []
      const retained = confirmed.get(fragment.pageNumber)
      return retained &&
        fragment.items.every(({ index }) => retained.has(index)) &&
        unit.source === fragment.items.map(({ text }) => text.trim()).join(' ')
        ? [unit.id]
        : []
    })
  )
}
